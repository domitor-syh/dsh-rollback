/**
 * Rollback plugin body (Host half).
 *
 * Wires the {@link RollbackService} capture observers and registers the two
 * trigger surfaces: the model-facing `rollback` tool and the human `/rollback`
 * command. The browser half (rollback button + affected-file dialog) ships via
 * `./client` and reaches this host through the already-shipped `commands`
 * Remote (`/rollback preview|list|<turn>`).
 *
 * @module @domitor-syh/dsh-rollback
 */

import type { Context } from '@deepseek-ai/cordis'
import type { RollbackPlan } from './core/restore-plan.ts'
import { installRootWriteFallback } from './root-write-fallback.ts'
import { RollbackService, summarize } from './service.ts'

export const name = 'rollback'
export const inject = ['fs', 'sessions', 'tools', 'commands', 'sandboxPolicy']

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
    description: '回退到某一轮对话发起前（恢复文件并截断对话，同一会话）',
    input: { hint: '[list | preview <turn> | <turn>]' },
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
        const turn = Number(raw)
        if (!Number.isSafeInteger(turn) || turn < 1) {
          return { kind: 'error', text: '用法：/rollback [list | preview <turn> | <turn>]' }
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