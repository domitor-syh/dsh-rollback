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
import {
  hasRollbackMarker,
  planTruncationMarker,
  shadowedSurfaceFrom,
  type SessionView,
  type TruncationMarkerPlan,
} from './core/truncation-plan.ts'
import {
  appendCheckpoint,
  clearPendingTruncation,
  loadCheckpoints,
  loadPendingTruncation,
  savePendingTruncation,
  type PendingTruncation,
} from './store.ts'

/** Retained checkpoint window: "仅支持回退至最近 10 轮会话内" (sliding window). */
export const ROLLBACK_WINDOW = 10

/** A successful rollback outcome, the tool's canonical value. */
export interface RollbackOutcome {
  readonly fromTurn: number
  readonly executed: true
  /** Whether a conversation range is now scheduled for truncation. */
  readonly truncated: boolean
  /**
   * True when the truncation marker is deferred to the next turn's first step:
   * DSH only accepts a surface-replacing `assistant/message` inside an OPEN step,
   * and a rollback command runs between turns.
   */
  readonly deferred: boolean
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
export function summarize(plan: RollbackPlan, options: { deferred?: boolean } = {}): string {
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
  const truncatePart = plan.truncation === null
    ? '无对话可截断'
    : options.deferred === true
      ? '对话将在你下一次发消息时截断'
      : options.deferred === false
        ? '已截断对话'
        : '将截断对话'
  return `已回退到第 ${plan.fromTurn} 轮发起前：${filePart}；${truncatePart}。`
}

/**
 * The text the model sees where the rolled-back range used to be: nothing.
 *
 * An empty-content `assistant/message` derives to null (`deriveMessages` skips
 * it), so the marker never reaches the provider — it exists in the log only to
 * carry the surface replacement and the facts the client's hide pass reads.
 */
function markerMessageId(): string {
  return `rollback-truncation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/** The session as the pure truncation planner sees it. */
function viewOf(session: Session): SessionView {
  return session as unknown as SessionView
}

/**
 * Step number the plugin uses for its own marker step.
 *
 * The marker must sit inside an open step, and the agent loop's own steps are
 * numbered sequentially from 1 — so the plugin owns one clearly synthetic number
 * instead of racing the loop's counter.
 */
export const MARKER_STEP = 10_000

/** One rollback's captured shadowed range plus the facts its marker reports. */
interface TruncationRange {
  readonly fromTurn: number
  readonly shadowedFirst?: number
  readonly shadowedLast?: number
  /** Epoch ms the rollback ran; used to order legacy records without a range. */
  readonly at?: number
  readonly restoredCount: number
  readonly deletedCount: number
}

/** The rollback service: capture + preview + execute, keyed by live session. */
export class RollbackService {
  private readonly folds = new WeakMap<object, SessionFold>()
  /** Copy-before-Write carrier for `str_replace_editor`, keyed by call id. */
  private readonly pendingBefore = new Map<string, { path: string; kind: 'created' | 'updated'; before: string | null }>()
  /** Rollbacks awaiting the next request boundary to append their marker. */
  private readonly pendingTruncations = new Map<string, PendingTruncation>()
  /** Sessions whose deferred marker already failed once (warn once, keep retrying). */
  private readonly warnedPending = new Set<string>()

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

    // The truncation marker is appended at the request boundary, not from
    // `session/event`: DSH rejects an append made while another append is being
    // published ("session append cannot reenter while another append is being
    // published"), and every `session/event` observer runs inside that boundary.
    // `agent/pre-step` runs before the turn's request is derived, so the rolled-
    // back range is already gone from the model's very next call.
    ctx.on('agent/pre-step', ({ agent, turn }, next) => {
      if (agent !== undefined) this.applyPendingTruncation(agent.session as Session, turn)
      return next()
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
    // so rebuild each pickup's fold by replaying the stored log. A pending
    // truncation recorded before the restart is picked up the same way, and is
    // appended at this session's next open step.
    ctx.on('session/created', (session) => {
      const created = session as Session
      this.seedFromLog(created)
      this.hydratePending(created)
    })
    for (const session of this.ctx.sessions.list()) {
      const live = session as Session
      this.seedFromLog(live)
      this.hydratePending(live)
    }
  }

  /** Recover a durable pending truncation for one session (restart support). */
  private hydratePending(session: Session): void {
    const sessionId = typeof session.id === 'string' ? session.id : ''
    if (sessionId === '' || this.pendingTruncations.has(sessionId)) return
    const stored = loadPendingTruncation(sessionId)
    if (stored !== null) this.pendingTruncations.set(sessionId, stored)
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

    // 2) Schedule the in-place truncation of the model-visible surface (same
    // session id). The replacement is an EMPTY-content `assistant/message`, which
    // derives to null: the model stops remembering the rolled-back turns and
    // NOTHING takes their place (no note, no empty turn ever reaches the
    // provider). DSH accepts such a message only inside an open step, and this
    // command runs between turns, so it is appended at the next `agent/pre-step`
    // — before that turn's request is derived (see applyPendingTruncation).
    //
    // Inventing a synthetic TURN here is what broke sessions: the plugin's turn
    // number and the agent loop's own counter (`phase.turn + 1`) both advance
    // independently, so the next real turn reused the marker's number — two
    // `turn/start` events with the same turn, which the Web client refuses to
    // rebuild a conversation from ("… received more than one start Match").
    const shadowed = shadowedSurfaceFrom(viewOf(session), fromTurn)
    const truncated = shadowed.length > 0
    const restoredCount = restored.filter(f => f.action === 'restore').length
    const deletedCount = restored.filter(f => f.action === 'delete').length
    if (truncated && typeof session.id === 'string' && session.id !== '') {
      this.setPending({
        sessionId: session.id,
        fromTurn,
        // Capture the range NOW: anything the session appends before the marker
        // (context injections, the user's next prompt) must stay visible.
        shadowedFirst: shadowed[0]!,
        shadowedLast: shadowed[shadowed.length - 1]!,
        restoredCount,
        deletedCount,
        at: Date.now(),
      })
    }

    // 3) Drop the now-undone checkpoints and reset the in-flight state.
    fold.dropFrom(fromTurn)

    return {
      fromTurn,
      executed: true,
      truncated,
      deferred: truncated,
      restored,
      skipped,
      // Report the REAL truncation outcome, not the plan's fold-derived hint.
      summary: summarize({
        fromTurn,
        restored,
        skipped,
        truncation: truncated ? { start: shadowed[0]!, end: shadowed[shadowed.length - 1]! } : null,
      }, { deferred: truncated }),
    }
  }

  /**
   * Append the truncation marker, hosting it in a plugin-owned step.
   *
   * Returns false when the append was refused (the caller keeps the rollback
   * pending and retries at the next request boundary).
   */
  private appendTruncationMarker(session: Session, range: TruncationRange, turn: number): boolean {
    const plan: TruncationMarkerPlan | null = planTruncationMarker(viewOf(session), {
      fromTurn: range.fromTurn,
      ...range.shadowedFirst === undefined || range.shadowedLast === undefined
        ? { capturedAt: range.at }
        : { shadowedFirst: range.shadowedFirst, shadowedLast: range.shadowedLast },
      turn,
      step: MARKER_STEP,
      messageId: markerMessageId(),
      restoredCount: range.restoredCount,
      deletedCount: range.deletedCount,
    })
    if (plan === null) return true // nothing left to shadow: the rollback stands

    try {
      // The empty assistant message must sit inside an open step; the plugin opens
      // and closes its own (numbering the agent loop never uses) rather than
      // borrowing the loop's, which it is about to open itself.
      session.append('step/start', { turn, step: MARKER_STEP })
      const marker = session.append('assistant/message', plan.data as never, {
        surfaceOp: plan.surfaceOp,
        sourceEventSeqs: [...plan.sourceEventSeqs],
      })
      session.append('step/end', { turn, step: MARKER_STEP })
      this.foldFor(session).setTail(marker.seq)
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[dsh-rollback] could not append the truncation marker for session ${String(session.id)}: ${message}`)
      return false
    }
  }

  /**
   * Apply a pending truncation at the request boundary (`agent/pre-step`).
   *
   * Runs for the turn the loop is about to open, before its request is derived,
   * so the rolled-back range is already gone from that model call. Also closes a
   * plugin-owned step left open if a previous attempt failed midway.
   */
  private applyPendingTruncation(session: Session, turn: number): void {
    const sessionId = typeof session.id === 'string' ? session.id : ''
    if (sessionId === '') return
    const pending = this.pendingTruncations.get(sessionId)
    if (pending === undefined) return

    // A marker for this very rollback may already be in the log (the process can
    // die between appending it and dropping the pending record). Applying it a
    // second time would shadow the turns that legitimately followed it.
    if (hasRollbackMarker(session.events, pending.fromTurn)) {
      this.clearPending(sessionId)
      return
    }

    if (!this.appendTruncationMarker(session, pending, turn)) {
      if (!this.warnedPending.has(sessionId)) {
        this.warnedPending.add(sessionId)
        console.warn(`[dsh-rollback] truncation for session ${sessionId} could not be applied; it will retry at the next request`)
      }
      return
    }
    this.clearPending(sessionId)
  }

  /** Remember a pending truncation in memory and on disk. */
  private setPending(pending: PendingTruncation): void {
    this.pendingTruncations.set(pending.sessionId, pending)
    savePendingTruncation(pending)
  }

  /** Forget one session's pending truncation once its marker is in the log. */
  private clearPending(sessionId: string): void {
    if (!this.pendingTruncations.delete(sessionId)) return
    this.warnedPending.delete(sessionId)
    clearPendingTruncation(sessionId)
  }
}
