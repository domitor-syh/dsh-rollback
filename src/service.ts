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
import { turnStartTimeMs } from './core/dir-cleanup.ts'
import { BoundaryRescan } from './boundary-rescan.ts'
import { cleanupEmptyDirs } from './empty-dirs.ts'
import {
  planTruncationMarker,
  shadowedSurfaceFrom,
  type SessionView,
  type TruncationMarkerPlan,
} from './core/truncation-plan.ts'
import { appendCheckpoint, loadCheckpoints, loadKnownContent } from './store.ts'

/** Retained checkpoint window: "仅支持回退至最近 10 轮会话内" (sliding window). */
export const ROLLBACK_WINDOW = 10

/** A successful rollback outcome, the tool's canonical value. */
export interface RollbackOutcome {
  readonly fromTurn: number
  readonly executed: true
  /** Whether the model-visible range was replaced by the rollback checkpoint. */
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
export function summarize(plan: RollbackPlan, options: { removedDirs?: readonly string[] } = {}): string {
  const restored = plan.restored.filter(f => f.action === 'restore').length
  const deleted = plan.restored.filter(f => f.action === 'delete').length
  const parts: string[] = []
  if (restored > 0) parts.push(`${restored} 个文件恢复`)
  if (deleted > 0) parts.push(`${deleted} 个新建文件删除`)
  const removedDirs = options.removedDirs ?? []
  if (removedDirs.length > 0) parts.push(`${removedDirs.length} 个空目录删除`)
  if (plan.skipped.length > 0) {
    const detail = plan.skipped.map(s => `${s.path}（${s.reason}）`).join('；')
    parts.push(`${plan.skipped.length} 个文件无法恢复：${detail}`)
  }
  const filePart = parts.length > 0 ? parts.join('，') : '无文件变更'
  const truncatePart = plan.truncation === null ? '无对话可截断' : '已截断对话'
  return `已回退到第 ${plan.fromTurn} 轮发起前：${filePart}；${truncatePart}。`
}

/** A fresh id for the replacement checkpoint node. */
function markerMessageId(): string {
  return `rollback-truncation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/** The session as the pure truncation planner sees it. */
function viewOf(session: Session): SessionView {
  return session as unknown as SessionView
}

/**
 * The paths one session's sidecar holds — everything worth watching.
 *
 * The sidecar is the durable record of what the file tools touched, so it is also
 * the list a restarted process should keep re-checking.
 * @param sessionId - the session.
 * @returns distinct display paths, in no particular order.
 */
function watchablePaths(sessionId: string): string[] {
  const paths = new Set<string>()
  for (const byPath of loadCheckpoints(sessionId).values()) {
    for (const path of byPath.keys()) paths.add(path)
  }
  return [...paths]
}

/** The rollback service: capture + preview + execute, keyed by live session. */
export class RollbackService {
  private readonly folds = new WeakMap<object, SessionFold>()
  /** Copy-before-Write carrier for `str_replace_editor`, keyed by call id. */
  private readonly pendingBefore = new Map<string, { path: string; kind: 'created' | 'updated'; before: string | null }>()
  /** Watchdog for files the file tools touched, re-checked at message boundaries. */
  private readonly rescan: BoundaryRescan

  constructor(private readonly ctx: Context) {
    // The re-scan needs the session's policy to resolve a path, and the fold to
    // anchor a finding at the boundary's turn.
    this.rescan = new BoundaryRescan({
      hostPathOf: async (sessionId, path) => {
        const session = this.ctx.sessions.get(sessionId)
        if (session === undefined) return undefined
        const policy = this.ctx.sandboxPolicy.resolve({ session })
        const target = await this.ctx.fs.resolve(path, { cwd: policy.workspaceRoot })
        return this.ctx.fs.processPath(target)
      },
      watchedPaths: sessionId => watchablePaths(sessionId),
      knownContent: sessionId => loadKnownContent(sessionId),
      record: (sessionId, turn, mutation) => {
        const session = this.ctx.sessions.get(sessionId)
        if (session === undefined) return
        const fold = this.foldFor(session)
        if (!fold.mutationInto(turn, mutation)) {
          // The boundary's turn already left the retained window: recording it
          // elsewhere would restore the wrong state, so it is dropped with a word.
          console.warn(`[dsh-rollback] turn ${turn} left the retained window before its boundary scan finished; ${mutation.path} was not recorded`)
          return
        }
        appendCheckpoint({
          sessionId,
          turn,
          path: mutation.path,
          operation: mutation.operation,
          before: mutation.before,
          after: mutation.after,
        })
      },
      warn: message => console.warn(message),
    })

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
          // A user message is the boundary the re-scan anchors to: it is the interval
          // the user thinks in, and the turn it opens is the one a later rollback
          // would target. The turn is read NOW — the scan itself is asynchronous — and
          // nothing is awaited on the message path.
          if (event.type === 'user/message') {
            const turn = fold.inProgressTurn()
            const sessionId = typeof session.id === 'string' ? session.id : ''
            if (turn !== null && sessionId !== '') void this.rescan.scan(sessionId, turn)
          }
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
      // The file tools are the plugin's only window onto the workspace; every path
      // they touch becomes one the boundary re-scan watches from now on.
      if (typeof sessionObj.id === 'string' && sessionObj.id !== '') {
        this.rescan.observe(sessionObj.id, mutation.path, mutation.after)
      }

      // Persist the pre-turn content so a later restart can still restore it
      // (the log only keeps 3-line diff hunks, not whole files), and the content
      // this touch left behind so a restart can still restore a file a later shell
      // command removes.
      const turn = fold.inProgressTurn()
      if (turn !== null && typeof sessionObj.id === 'string') {
        appendCheckpoint({
          sessionId: sessionObj.id,
          turn,
          path: mutation.path,
          operation: mutation.operation,
          before: mutation.before,
          after: mutation.after,
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
    // Keep watching whatever the sidecar already knows, so a restarted process
    // still notices a shell command that removes one of those files.
    if (typeof session.id === 'string' && session.id !== '') this.rescan.prime(session.id)
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
    const shadowed = shadowedSurfaceFrom(viewOf(session), fromTurn)
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
    /** Host paths of the files this rollback deleted, for the empty-directory pass. */
    const deletedHostPaths: string[] = []
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
          const hostPath = this.ctx.fs.processPath(target)
          try {
            await unlink(hostPath)
          } catch (error) {
            if ((error as { code?: string } | null)?.code !== 'ENOENT') throw error
          }
          deletedHostPaths.push(hostPath)
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
        skipped.push({ path: file.path, reason: `io-error: ${message}` })
      }
    }

    // ATOMIC: files and conversation roll back together. If any file could not
    // be restored, abort the WHOLE rollback — no truncation, no marker — so the
    // user never ends up with a half-rolled-back state.
    if (skipped.length > 0) {
      const detail = skipped.map(s => `${s.path}（${s.reason}）`).join('；')
      throw new Error(`回退失败，请重试：${detail}`)
    }

    // 2) Remove the directories this rollback emptied.
    //
    // The files are gone, but the directories that held them were created by
    // something this plugin never recorded — a shell `New-Item`/`mkdir`, or the file
    // tool's own parent pre-creation — so they outlive the rollback and leave an
    // empty husk behind. A directory is removed only when it is now empty (counting
    // children this same pass removes) AND its creation time says the rolled-back
    // span made it: a directory that predates the rollback point is left alone, which
    // is what keeps "roll back only the turn that wrote the file" from removing the
    // directory an earlier turn created.
    const removedDirs: string[] = []
    if (deletedHostPaths.length > 0) {
      const spanStartMs = turnStartTimeMs(session.events as never, fromTurn)
      if (spanStartMs === undefined) {
        // No opening time in the log: the creation-time test cannot be made, and this
        // pass fails closed by doing nothing.
        console.warn(`[dsh-rollback] no turn/start time for turn ${fromTurn}; skipping empty-directory cleanup`)
      } else {
        const cleanup = await cleanupEmptyDirs(deletedHostPaths, spanStartMs, policy.workspaceRoot)
        removedDirs.push(...cleanup.removed)
        for (const failure of cleanup.failed) {
          console.warn(`[dsh-rollback] could not remove emptied directory ${failure.path}: ${failure.reason}`)
        }
      }
    }

    // 3) Replace the rolled-back range in the model-visible surface (same session
    // id), NOW — the replaced range leaves the model's history with only the
    // checkpoint text in its place, so the model stops remembering the rolled-back
    // turns from its very next request.
    //
    // The marker is a `user/message` carrying a positional `replace`, which is the
    // primitive the harness itself uses for compaction. That choice is what makes
    // landing it HERE legal:
    //   - `user/message` is unconstrained by the session invariant, so it may be
    //     appended between turns (no open turn, no open step). An empty-content
    //     `assistant/message` would be invisible to the model, but DSH accepts it
    //     only inside an open step — and opening one here is impossible: the
    //     sequential-step invariant requires the loop's own next number, and the
    //     loop would then fail its own `step/start`.
    //   - Inventing a synthetic TURN is worse than impossible: the plugin and the
    //     agent loop each track "the next turn number" independently, so the next
    //     real turn reused the marker's number — two `turn/start` events with one
    //     turn, which the Web client refuses to rebuild a conversation from
    //     ("… received more than one start Match").
    const markerPlan: TruncationMarkerPlan | null = planTruncationMarker(viewOf(session), {
      fromTurn,
      messageId: markerMessageId(),
    })
    const truncated = markerPlan !== null
    if (markerPlan !== null) {
      try {
        const marker = session.append('user/message', markerPlan.data as never, {
          surfaceOp: markerPlan.surfaceOp,
          sourceEventSeqs: [...markerPlan.sourceEventSeqs],
        })
        fold.setTail(marker.seq)
      } catch (error) {
        // The files are already restored, so this cannot be rolled back silently:
        // report it rather than leaving a half-applied rollback unexplained.
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`回退失败：工作区文件已恢复，但对话截断未能写入（${message}）。请重试回退。`)
      }
    }

    // 4) Drop the now-undone checkpoints and reset the in-flight state.
    fold.dropFrom(fromTurn)
    // The re-scan registry describes the PRE-rollback state of files this rollback
    // just rewrote, so it starts learning again; comparing against the old picture
    // would invent a change for every file the rollback touched.
    if (typeof session.id === 'string' && session.id !== '') this.rescan.forget(session.id)

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
        truncation: markerPlan === null ? null : { start: markerPlan.surfaceOp.start, end: markerPlan.surfaceOp.end },
      }, { removedDirs }),
    }
  }
}
