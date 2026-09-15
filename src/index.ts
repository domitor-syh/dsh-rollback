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
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { RollbackPlan } from './core/restore-plan.ts'
import { RollbackService, summarize } from './service.ts'

export const name = 'rollback'
export const inject = ['fs', 'sessions', 'tools', 'commands', 'sandboxPolicy']

const WINDOW_HINT = '(仅最近 10 轮)'

/** Format a plan's affected-file list into a human-readable text block. */
function planText(plan: RollbackPlan, header: string): string {
  const lines: string[] = [header]
  for (const file of plan.restored) {
    const tag = file.action === 'delete' ? '[删除]' : '[恢复]'
    lines.push(`  ${tag} ${file.path}`)
  }
  for (const file of plan.skipped) {
    lines.push(`  [跳过] ${file.path}（${file.reason}）`)
  }
  if (plan.restored.length === 0 && plan.skipped.length === 0) lines.push('  （无文件变更）')
  lines.push(`  对话截断：${plan.truncation === null ? '否' : '将截断（你下一次发消息时）'}`)
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

  ctx.tools.register(defineTool({
    name: 'rollback',
    description:
      'Roll back the conversation and workspace files to before a given 1-based turn number, ' +
      'removing that turn and all later turns from the model context and restoring any files they changed. ' +
      'This is IRREVERSIBLE: only call when the user has clearly asked to roll back. ' +
      'Pass preview: true to only list affected files without changing anything.',
    parameters: {
      turn: {
        type: 'number',
        required: true,
        description: 'Roll back to before this 1-based turn number (removes it and all later turns).',
      },
      preview: {
        type: 'boolean',
        description: 'When true, only compute and return the affected-file plan; do not execute.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          fromTurn: { type: 'number', required: true },
          executed: { type: 'boolean', required: true },
          truncated: { type: 'boolean', required: true },
          restored: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                action: { type: 'string', required: true, enum: ['restore', 'delete'] },
              },
            },
          },
          skipped: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                reason: { type: 'string', required: true },
              },
            },
          },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary as string }],
    },
    async execute(args, exec) {
      const session = exec.agent?.session
      if (session === undefined) throw new Error('rollback tool requires an agent session')
      const turn = Number(args.turn)
      if (!Number.isSafeInteger(turn) || turn < 1) throw new Error('turn must be a positive integer')
      const plan = service.preview(session as never, turn)
      if (args.preview === true) {
        return {
          fromTurn: turn,
          executed: false,
          truncated: plan.truncation !== null,
          restored: plan.restored.map(f => ({ path: f.path, action: f.action })),
          skipped: plan.skipped,
          summary: summarize(plan),
        }
      }
      const outcome = await service.execute(session as never, turn, exec.signal)
      return {
        fromTurn: outcome.fromTurn,
        executed: true,
        truncated: outcome.truncated,
        restored: outcome.restored.map(f => ({ path: f.path, action: f.action })),
        skipped: outcome.skipped,
        summary: outcome.summary,
      }
    },
  }))

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
          const plan = service.preview(session as never, turn)
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