/**
 * Rollback plugin body (Host half).
 *
 * Wires the {@link RollbackService} capture observers and registers the human
 * `/rollback` command — the plugin's only trigger surface, since a model-invoked
 * rollback cannot exist: it would always land inside a running turn, and a running
 * turn refuses every rollback. The browser half (rollback button, affected-file
 * dialog, turn picker) ships via `./client` and reaches this host through the
 * already-shipped `commands` Remote — `/rollback list` and `/rollback preview
 * <turn>` for reading, and the internal `/rollback --apply <turn>` that only the
 * confirmation dialog issues.
 *
 * @module @domitor-syh/dsh-rollback
 */

import type { Context } from '@deepseek-ai/cordis'
import type { RollbackPlan } from './core/restore-plan.ts'
import { installRootWriteFallback } from './root-write-fallback.ts'
import { RollbackService, summarize } from './service.ts'

export const name = 'rollback'
/**
 * Required services. `tools` is deliberately absent: this plugin listens to
 * `tools/pre-execute` and `tools/result`, which are EVENTS and need no service, and
 * the model tool that once needed the service was removed in 0.2.0 — so naming it
 * here bought nothing while carrying the one failure this list can cause. A name no
 * build provides parks the whole host half in "pending" forever: no apply, no
 * command, no observers, and no error anywhere. One fewer name is one fewer way for
 * a future core to silently kill the plugin.
 */
export const inject = ['fs', 'sessions', 'commands', 'sandboxPolicy']

const WINDOW_HINT = '(仅最近 10 轮)'

/**
 * Runtime context the model reads every request.
 *
 * A file changed only through a shell command is invisible to this plugin, so it
 * cannot be rolled back — steering content changes to the file tools is what keeps
 * them inside the captured path. Phrased as the consequence rather than as a rule,
 * so it stays true whatever the model decides.
 */
const FILE_TOOL_HINT =
  'Only files touched by the write/edit tools are tracked for rollback; change file contents with those tools rather than a shell command.'

/** Format a plan's affected-file list into a human-readable text block. */
function planText(plan: RollbackPlan, header: string): string {
  const lines: string[] = [header]
  for (const file of plan.restored) {
    // 恢复 = the file is still there and its old content goes back; 找回 = the file
    // was deleted and is brought back; 删除 = a file this span created goes away.
    const tag = file.action === 'delete' ? '[删除]' : file.action === 'recover' ? '[找回]' : '[恢复]'
    lines.push(`  ${tag} ${file.path}`)
  }
  for (const file of plan.skipped) {
    lines.push(`  [跳过] ${file.path}（${file.reason}）`)
  }
  // No "no file changes" line: the plugin cannot see everything (a file written by
  // a shell command it never watched is invisible), so claiming this span changed
  // no files would be a claim it cannot back up — and it would read as a promise
  // that the workspace is untouched.
  lines.push(`  对话截断：${plan.truncation === null ? '否' : '将截断'}`)
  return lines.join('\n')
}

/** List the turns the sliding window can still roll back to. */
function listText(service: RollbackService, session: { id: string }): string {
  const fold = service.foldFor(session as never)
  const turns = fold.snapshots().map(cp => cp.turn)
  if (turns.length === 0) return `当前会话没有可回退的轮次。${WINDOW_HINT}`
  return `可回退到的轮次：${turns.join(', ')} ${WINDOW_HINT}`
}

export function apply(ctx: Context): void {
  const service = new RollbackService(ctx)

  // Let `write` reach a file directly under a drive root instead of failing with
  // the provider's mkdir EPERM and pushing the model onto the shell.
  installRootWriteFallback(ctx)

  // Tell the model what the capture can and cannot see, so it does not route a
  // content change through a channel this plugin cannot roll back.
  ctx.inject(['systemPrompt'], (scope) => {
    scope.systemPrompt.context({
      name: 'rollback:file-tools',
      order: 199,
      text: () => FILE_TOOL_HINT,
    })
  })

  ctx.commands.register({
    name: 'rollback',
    // Both languages in one string, because a host command's description CANNOT follow
    // the interface: the menu row shows the catalog copy verbatim, the client's only
    // interface to a host row (`decorate`) carries behaviour and no text, and the
    // documented locale preference is host-side only when the user explicitly picked
    // one — "absence delegates to the browser". Carrying both readings is what keeps
    // one row legible in either interface.
    description: '回退到某轮对话发起前 / Roll back to before a turn',
    // No usage example: picking the row — or typing the bare command — opens the
    // client's turn picker instead, so a spelling to copy would be noise. The
    // descriptor itself has to stay, because that is what keeps the argument route
    // alive: a host command without `input` refuses a line like `/rollback 12` at
    // the composer (`matchEnter` returns void for a non-bare token), and an
    // unmatched slash line is submitted to the model as an ordinary prompt. An empty
    // hint is refused by the registry (`normalizeDefinition`: "input hint must not
    // be empty"), so the placeholder states the affordance instead of listing the
    // syntax.
    input: { hint: '（从弹窗选择轮次）' },
    async handler(invocation) {
      const session = invocation.agent.session
      const raw = invocation.rawInput.trim()

      try {
        if (raw === '' || raw === 'list') {
          return { kind: 'success', text: listText(service, session) }
        }
        if (raw.startsWith('preview')) {
          const turn = Number(raw.slice('preview'.length).trim())
          if (!Number.isSafeInteger(turn) || turn < 1) {
            return { kind: 'error', text: '用法：/rollback preview <turn>  （turn 为正整数轮次）' }
          }
          const plan = await service.preview(session as never, turn)
          return { kind: 'success', text: planText(plan, `回退到第 ${turn} 轮发起前，受影响文件：`) }
        }
        // Two spellings reach the same execute. `--apply` is what the confirmation
        // dialog issues, so the picker and the button both commit through a dialog.
        // A bare number is what a person types, and it is honoured — but it does NOT
        // raise that dialog, because the framework gives the client no way to
        // intercept an argument-bearing line: contributions and decorations are
        // consulted only for a BARE token, and a host command that declares `input`
        // hands the arguments straight to this handler. Documented in both READMEs so
        // the difference is a stated property rather than a surprise.
        const turn = raw.startsWith('--apply') ? Number(raw.slice('--apply'.length).trim()) : Number(raw)
        if (!Number.isSafeInteger(turn) || turn < 1) {
          return {
            kind: 'error',
            text: '用法：/rollback（弹出轮次选择）｜ /rollback <轮次号>（直接回退，无确认弹窗）｜ 辅助：/rollback list、/rollback preview <turn>',
          }
        }
        const outcome = await service.execute(session as never, turn, invocation.signal)
        return { kind: 'success', text: outcome.summary }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { kind: 'error', text: `回退失败：${message}` }
      }
    },
  })
}