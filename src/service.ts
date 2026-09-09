/**
 * Rollback execution service. Owns the per-session checkpoint folds and runs
 * the two operations the tutorial describes:
 *   1. restore affected files (write prior content / delete created files)
 *   2. truncate the model-visible conversation in place, keeping the session id
 *
 * Pure planning lives in ../core; this service is the session-aware Host layer.
 *
 * @module @domitor-syh/dsh-rollback
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session/types'
import { unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { FsMutation } from './core/model.ts'
import { fsMutationFrom, SessionFold } from './core/session-fold.ts'
import { planRollback, type RestoredFile, type RollbackPlan, type SkippedFile } from './core/restore-plan.ts'
import { appendCheckpoint, loadCheckpoints } from './store.ts'

/** Retained checkpoint window: "仅支持回退至最近 10 轮会话内" (sliding window). */
export const ROLLBACK_WINDOW = 10

/** A successful rollback outcome, the tool's canonical value. */
export interface RollbackOutcome {
  readonly fromTurn: number
  readonly executed: true
  readonly truncated: boolean
  readonly restored: readonly RestoredFile[]
  readonly skipped: readonly SkippedFile[]
  readonly summary: string
}

/** The `tools/result` observer payload we key the fold on. */
interface MutationActor {
  readonly name?: string
  readonly agent?: { readonly session?: object }
}

/** Minimal split of the tools/result event and its session attribution. */
function mutationOf(exec: MutationActor, value: unknown): FsMutation | null {
  const session = (exec as { agent?: { session?: object } }).agent?.session
  if (session === undefined) return null
  return fsMutationFrom(exec.name ?? '', value)
}

/** Human/machine one-line summary of a rollback plan. */
export function summarize(plan: RollbackPlan): string {
  const restored = plan.restored.filter(f => f.action === 'restore').length
  const deleted = plan.restored.filter(f => f.action === 'delete').length
  const parts: string[] = []
  if (restored > 0) parts.push(`${restored} 个文件恢复`)
  if (deleted > 0) parts.push(`${deleted} 个新建文件删除`)
  if (plan.skipped.length > 0) {
    const detail = plan.skipped.map(s => `${s.path}（${s.reason}）`).join('；')
    parts.push(`${plan.skipped.length} 个文件无法恢复：${detail}`)
  }
  const filePart = parts.length > 0 ? parts.join('，') : '无文件变更'
  const truncatePart = plan.truncation !== null ? '已截断对话' : '无对话可截断'
  return `已回退到第 ${plan.fromTurn} 轮发起前：${filePart}；${truncatePart}。`
}

/**
 * Coordinates and route identity for the invisible truncation node. The
 * empty-content `assistant/message` derives to null, so the model's next
 * request contains NOTHING from the rolled-back range — pure truncation, no
 * marker. The node still needs a persistence-valid envelope (non-empty id and
 * model source), which comes from the session's latest route or last reply.
 */
function truncationEnvelope(session: Session): {
  turn: number
  step: number
  provider: string
  model: string
} {
  let turn = 1
  let step = 1
  let provider = ''
  let model = ''
  for (const event of session.events) {
    const data = event.data as { turn?: unknown; step?: unknown }
    if (event.type === 'turn/end' && typeof data.turn === 'number') turn = data.turn
    if (event.type === 'step/end' && typeof data.turn === 'number' && typeof data.step === 'number') {
      turn = data.turn
      step = data.step
    }
    if (event.type === 'assistant/message') {
      const source = (event.data as { message?: { source?: { provider?: unknown; model?: unknown } } }).message?.source
      if (source !== undefined && typeof source.provider === 'string' && typeof source.model === 'string') {
        provider = source.provider
        model = source.model
      }
    }
  }
  const route = session.requestContext()
  if (route !== undefined) {
    provider = route.provider
    model = route.model
  }
  return {
    turn,
    step,
    provider: provider === '' ? 'rollback' : provider,
    model: model === '' ? 'rollback' : model,
  }
}

/**
 * The surface node seqs of `session.surface.nodes` that belong to `fromTurn`
 * and later turns. The model-visible surface is the sole truncation authority.
 */
function shadowedSurfaceFrom(session: Session, fromTurn: number): number[] {
  const turnStart = session.events.find(e => e.type === 'turn/start' && e.data.turn === fromTurn)
  if (turnStart === undefined) return []
  const nodes = session.surface.nodes
  const startIdx = nodes.findIndex(seq => seq >= turnStart.seq)
  if (startIdx === -1) return []
  return [...nodes.slice(startIdx)]
}

/**
 * Whether the surface holds ANY node before `fromSeq` that still derives real
 * content — i.e. not an empty rollback marker (empty assistant/message). An
 * emptying rollback is one where everything before the truncation point is
 * empty markers (or nothing), so the model conversation becomes empty even
 * though prior markers remain as surface nodes.
 */
function hasRealSurfaceBefore(session: Session, fromSeq: number): boolean {
  for (const seq of session.surface.nodes) {
    if (seq >= fromSeq) break
    const event = session.events[seq]
    if (event === undefined) continue
    if (event.type === 'assistant/message'
      && (event.data as { message?: { content?: readonly unknown[] } }).message?.content?.length === 0) {
      continue // empty rollback marker — derives nothing
    }
    return true
  }
  return false
}

/** The rollback service: capture + preview + execute, keyed by live session. */
export class RollbackService {
  private readonly folds = new WeakMap<object, SessionFold>()
  /** Copy-before-Write carrier for `str_replace_editor`, keyed by call id. */
  private readonly pendingBefore = new Map<string, { path: string; kind: 'created' | 'updated'; before: string | null }>()

  constructor(private readonly ctx: Context) {
    ctx.on('session/event', (_session, event) => {
      const session = _session as Session
      const fold = this.foldFor(session)
      switch (event.type) {
        case 'turn/start':
          fold.fold({ kind: 'turn-start', turn: event.data.turn, seq: event.seq })
          break
        case 'turn/end':
          fold.fold({ kind: 'turn-end', turn: event.data.turn, seq: event.seq })
          break
        case 'user/message':
        case 'assistant/message':
        case 'tool/result':
          // Only append-origin surface events advance a live turn's span.
          if (event.surfaceOp === 'append') fold.fold({ kind: 'surface', seq: event.seq })
          break
        default:
          break
      }
    })

    // Copy-before-Write for `str_replace_editor`: its canonical value is a
    // rendered string, not {path, before, after}, so read the target BEFORE the
    // tool runs. `write`/`edit` are captured from their result value instead.
    ctx.on('tools/pre-execute', async (exec, next) => {
      if ((exec as { name?: string }).name !== 'str_replace_editor') return next()
      try {
        await this.captureBefore(exec as Parameters<RollbackService['captureBefore']>[0])
      } catch {
        /* a capture read must never block or fail the tool */
      }
      return next()
    })

    ctx.on('tools/result', (exec, result) => {
      const callId = (exec as { callId?: string }).callId ?? ''
      const pending = this.pendingBefore.get(callId)
      this.pendingBefore.delete(callId)
      if (result.isError as boolean) return
      const session = (exec as { agent?: { session?: object } }).agent?.session
      if (session === undefined) return
      const sessionObj = session as Session

      let mutation = mutationOf(
        exec as unknown as MutationActor,
        (result as { value?: unknown }).value,
      )
      if (mutation === null && pending !== undefined) {
        mutation = {
          path: pending.path,
          operation: pending.kind === 'created' ? 'create' : 'update',
          before: pending.before,
          after: '',
        }
      }
      if (mutation === null) return

      const fold = this.foldFor(sessionObj)
      fold.fold({ kind: 'fs-mutation', mutation })

      // Persist the pre-turn content so a later restart can still restore it
      // (the log only keeps 3-line diff hunks, not whole files).
      const turn = fold.inProgressTurn()
      if (turn !== null && typeof sessionObj.id === 'string') {
        appendCheckpoint({
          sessionId: sessionObj.id,
          turn,
          path: mutation.path,
          operation: mutation.operation,
          before: mutation.before,
        })
      }
    })

    // Restored sessions never republish their seeded log on `session/event`,
    // so rebuild each pickup's fold by replaying the stored log.
    ctx.on('session/created', (session) => { this.seedFromLog(session as Session) })
    for (const session of this.ctx.sessions.list()) this.seedFromLog(session as Session)
  }

  /**
   * Rebuild one session's fold from its stored log (resume/restart support).
   *
   * Turn boundaries and surface positions replay exactly. File mutations are
   * reconstructed from the `write`/`edit` tool calls' logged arguments: a
   * `write` whose result says "Created file" restores as a delete (no prior
   * content needed); everything else records an unknown pre-turn basis, so it
   * previews honestly and is skipped by restore rather than mis-restored.
   */
  private seedFromLog(session: Session): void {
    if (this.folds.has(session)) return
    const fold = this.foldFor(session)
    const durable = loadCheckpoints(String(session.id))
    const calls = new Map<string, { name: string; argsRaw: string }>()
    for (const event of session.events) {
      switch (event.type) {
        case 'tool/call': {
          calls.set(event.data.callId, { name: event.data.name, argsRaw: event.data.arguments })
          break
        }
        case 'tool/result': {
          if (event.surfaceOp === 'append') fold.fold({ kind: 'surface', seq: event.seq })
          const call = calls.get((event.data as { message?: { source?: { callId?: string } } }).message?.source?.callId ?? '')
          if (call === undefined || (call.name !== 'write' && call.name !== 'edit')) break
          let args: { file_path?: unknown } | undefined
          try { args = JSON.parse(call.argsRaw) as { file_path?: unknown } } catch { args = undefined }
          if (typeof args?.file_path !== 'string') break
          // Reproduce the local backend's absolute displayPath so the durable
          // store (keyed by that path) matches the live capture.
          const path = resolve(session.header?.cwd ?? process.cwd(), args.file_path)
          const resultText = (() => {
            const block = (event.data as { message?: { content?: readonly { type?: string; text?: string }[] } }).message?.content?.[0]
            return block?.type === 'text' && typeof block.text === 'string' ? block.text : ''
          })()
          const created = call.name === 'write' && resultText.includes('Created file')
          // Prefer the durable sidecar's full pre-turn content; fall back to the
          // log-only reconstruction (before unknown) for anything not stored.
          const stored = durable.get(event.data.turn)?.get(path)
          const operation = stored?.operation ?? (created ? 'create' : 'update')
          const before = stored !== undefined ? stored.before : null
          fold.fold({
            kind: 'fs-mutation',
            mutation: { path, operation, before, after: '' },
          })
          break
        }
        case 'user/message':
        case 'assistant/message':
          if (event.surfaceOp === 'append') fold.fold({ kind: 'surface', seq: event.seq })
          break
        case 'turn/start':
          fold.fold({ kind: 'turn-start', turn: event.data.turn, seq: event.seq })
          break
        case 'turn/end':
          fold.fold({ kind: 'turn-end', turn: event.data.turn, seq: event.seq })
          break
        default:
          break
      }
    }
  }

  /** The per-session fold, created on first observation. */
  foldFor(session: Session): SessionFold {
    let fold = this.folds.get(session)
    if (fold === undefined) {
      fold = new SessionFold(ROLLBACK_WINDOW)
      this.folds.set(session, fold)
    }
    return fold
  }

  /**
   * Read the `str_replace_editor` target before its `create`/`str_replace`/
   * `insert` command mutates it, so the checkpoint can restore the pre-turn
   * content even though the tool's own result value is only a rendered string.
   */
  private async captureBefore(exec: {
    name?: string
    callId?: string
    arguments?: unknown
    agent?: { session?: { header?: { cwd?: string } } }
  }): Promise<void> {
    const args = (exec.arguments ?? {}) as { command?: unknown; path?: unknown }
    if (args.command !== 'create' && args.command !== 'str_replace' && args.command !== 'insert') return
    const path = args.path
    if (typeof path !== 'string' || path === '') return
    const session = exec.agent?.session
    if (session === undefined) return
    const cwd = session.header?.cwd
    const target = await this.ctx.fs.resolve(path, cwd === undefined ? {} : { cwd })
    const info = await this.ctx.fs.stat(target)
    if (info === undefined) {
      this.pendingBefore.set(exec.callId ?? '', { path: target.displayPath, kind: 'created', before: null })
      return
    }
    const before = await this.ctx.fs.readText(target)
    this.pendingBefore.set(exec.callId ?? '', { path: target.displayPath, kind: 'updated', before })
  }

  /** Compute a read-only rollback plan (does not mutate anything). */
  preview(session: Session, fromTurn: number): RollbackPlan {
    const fold = this.foldFor(session)
    const plan = planRollback(fold.snapshots(), fromTurn, fold.surfaceTail())
    // The fold's in-memory surface tail can lag behind the durable session
    // surface (e.g. restored/image turns). The authoritative truncation — and
    // exactly what `execute` shadows — is the session surface itself, so report
    // THAT for the "对话截断" hint instead of the fold's stale tail.
    const shadowed = shadowedSurfaceFrom(session, fromTurn)
    return {
      ...plan,
      truncation: shadowed.length > 0 ? { start: shadowed[0]!, end: shadowed[shadowed.length - 1]! } : null,
    }
  }

  /**
   * Execute a rollback: restore/delete affected files, then truncate the
   * conversation surface in place.
   *
   * @throws when `fromTurn` is the in-progress turn (mid-turn rollback is unsafe).
   */
  async execute(session: Session, fromTurn: number, signal?: AbortSignal): Promise<RollbackOutcome> {
    const fold = this.foldFor(session)
    const inProgress = fold.inProgressTurn()
    if (inProgress !== null && fromTurn >= inProgress) {
      throw new Error(`cannot roll back to before turn ${fromTurn}: turn ${inProgress} is still in progress`)
    }

    const plan = planRollback(fold.snapshots(), fromTurn, fold.surfaceTail())

    // 1) Restore files. The sandbox fence (`fs-sandbox`) denies a write when no
    // per-session policy is supplied, so resolve the calling session's policy
    // (mode + workspace root) exactly like the write/edit tools do, and pass it
    // to writeText.
    const restored: RestoredFile[] = []
    const skipped: SkippedFile[] = [...plan.skipped]
    const policy = this.ctx.sandboxPolicy.resolve({ session })
    for (const file of plan.restored) {
      try {
        const resolveOpts = { cwd: policy.workspaceRoot }
        const target = await this.ctx.fs.resolve(file.path, resolveOpts)
        const observationActor = { agent: { session } }
        if (file.action === 'delete') {
          // Deleting a file the checkpoint recorded as "created inside the
          // rolled-back span". If it is already absent (ENOENT), the rollback's
          // goal — file absent — is already met: the model may have removed it
          // through an untracked side channel (e.g. bash `rm`) or an earlier
          // rollback. Treat that as success instead of aborting the whole
          // rollback; only real failures (EACCES, EBUSY, …) propagate.
          try {
            await unlink(this.ctx.fs.processPath(target))
          } catch (error) {
            if ((error as { code?: string } | null)?.code !== 'ENOENT') throw error
          }
          // Refresh the observation-policy cache so the model's NEXT write to
          // this path sees "absent" (createIfAbsent) instead of a stale
          // "present + old version" that would fail with FS_STALE_VERSION.
          this.ctx.emit('fs/observed', target, { kind: 'absent' }, observationActor)
        } else {
          const outcome = await this.ctx.fs.writeText(target, file.content ?? '', undefined, signal, policy)
          this.ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, observationActor)
        }
        restored.push(file)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        skipped.push({ path: file.path, reason: 'io-error: ' + message })
      }
    }

    // ATOMIC: files and conversation roll back together. If any file could not
    // be restored, abort the WHOLE rollback — no truncation, no marker — so the
    // user never ends up with a half-rolled-back state.
    if (skipped.length > 0) {
      const detail = skipped.map(s => `${s.path}（${s.reason}）`).join('；')
      throw new Error(`回退失败，请重试：${detail}`)
    }

    // 2) Truncate the model-visible surface in place (same session id).
    const shadowed = shadowedSurfaceFrom(session, fromTurn)
    const truncated = shadowed.length > 0
    // Empty when nothing BEFORE the truncation point derives real content —
    // prior empty rollback markers alone don't count.
    const emptied = truncated && !hasRealSurfaceBefore(session, shadowed[0]!)
    const restoredCount = restored.filter(f => f.action === 'restore').length
    const deletedCount = restored.filter(f => f.action === 'delete').length
    const truncatedFromSeq = truncated ? shadowed[0]! : null
    if (truncated) {
      // Pure truncation: the replacement node is an EMPTY-content
      // assistant/message, which derives to null — the model's next request
      // contains nothing from the shadowed range, not even a marker. The
      // rollback facts ride an inert `message.rollback` field (only the
      // client's marker/hide reads it; core and the model only see the empty
      // content), because an out-of-repo plugin event type is not loadable.
      const envelope = truncationEnvelope(session)
      const markerEvent = session.append('assistant/message', {
        turn: envelope.turn,
        step: envelope.step,
        message: {
          id: `rollback-truncation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          role: 'assistant',
          source: { kind: 'model', provider: envelope.provider, model: envelope.model },
          content: [],
          rollback: {
            fromTurn,
            truncatedFromSeq: shadowed[0]!,
            restoredCount,
            deletedCount,
            skippedCount: skipped.length,
            // Emptying the whole surface (not "turn 1") drives the client's
            // full-reset welcome, since turn numbers never reset.
            emptied,
          },
        },
      }, {
        surfaceOp: {
          op: 'replace',
          start: shadowed[0]!,
          end: shadowed[shadowed.length - 1]!,
        },
        sourceEventSeqs: [...shadowed],
      })
      fold.setTail(markerEvent.seq)
    }

    // 3) Drop the now-undone checkpoints and reset the in-flight state.
    fold.dropFrom(fromTurn)

    return {
      fromTurn,
      executed: true,
      truncated,
      restored,
      skipped,
      // Report the REAL truncation outcome, not the plan's fold-derived hint.
      summary: summarize({
        fromTurn,
        restored,
        skipped,
        truncation: truncated ? { start: shadowed[0]!, end: shadowed[shadowed.length - 1]! } : null,
      }),
    }
  }
}