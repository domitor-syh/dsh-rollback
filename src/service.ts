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
import { deadTurnsOf, isReplacedSeq, replacedSurfaceRanges } from './core/log-replay.ts'
import { rollbackRefusal, windowRefusal } from './core/rollback-guard.ts'
import { BoundaryRescan } from './boundary-rescan.ts'
import { cleanupEmptyDirs } from './empty-dirs.ts'
import {
  planTruncationMarker,
  shadowedSurfaceFrom,
  withReplaceSurfaceOpFallback,
  type SessionView,
  type TruncationMarkerPlan,
} from './core/truncation-plan.ts'
import { appendCheckpoint, loadCheckpoints, loadWatched } from './store.ts'

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
  const recovered = plan.restored.filter(f => f.action === 'recover').length
  const deleted = plan.restored.filter(f => f.action === 'delete').length
  const parts: string[] = []
  if (restored > 0) parts.push(`${restored} 个文件恢复`)
  if (recovered > 0) parts.push(`${recovered} 个文件找回`)
  if (deleted > 0) parts.push(`${deleted} 个新建文件删除`)
  const removedDirs = options.removedDirs ?? []
  if (removedDirs.length > 0) parts.push(`${removedDirs.length} 个空目录删除`)
  if (plan.skipped.length > 0) {
    const detail = plan.skipped.map(s => `${s.path}（${s.reason}）`).join('；')
    parts.push(`${plan.skipped.length} 个文件无法恢复，已保持现状（记录保留，下次回退会再试）：${detail}`)
  }
  const filePart = parts.length > 0 ? parts.join('，') : '无文件变更'
  const truncatePart = plan.truncation === null ? '无对话可截断' : '已截断对话'
  return `已回退到第 ${plan.fromTurn} 轮发起前：${filePart}；${truncatePart}。`
}

/** A fresh id for the replacement checkpoint node. */
function markerMessageId(): string {
  return `rollback-truncation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * The session as the pure truncation planner sees it.
 *
 * The bare cast is NOT enough, and this is the same defect class as the one
 * {@link eventsOf} fixes: `SessionView.events` has no counterpart on a 0.1.5
 * session (its log is private), so handing the pure planner the session itself
 * gives it `undefined` and `turnStartSeqFor`'s `for (const event of view.events)`
 * throws `TypeError: view.events is not iterable` — on the plugin's OWN
 * `/rollback preview` and `/rollback` paths. The view is therefore built rather
 * than asserted: events through the accessor the installed build ships, surface
 * read live.
 * @param session - the session to view.
 * @returns the structural view the pure planner consumes.
 */
function viewOf(session: Session): SessionView {
  return { events: eventsOf(session), surface: (session as unknown as SessionView).surface }
}

/**
 * Append the rollback marker, spelling its surface op the way the INSTALLED
 * framework accepts.
 *
 * 0.1.5 renamed the op's range ends to `startSeq`/`endSeq` and validates the key
 * set exactly, so the older `start`/`end` spelling the plugin used to write is
 * refused with `carries an invalid replace surfaceOp` — the marker never landed,
 * and with it the whole point of a rollback. `withReplaceSurfaceOpFallback` tries
 * the modern spelling and retries with the legacy one only on that refusal, which
 * persists nothing (see its doc for the `log.push`-comes-after-validation
 * evidence). This is the one place the union is narrowed to the framework's own
 * `SurfaceOp`; the shape itself is decided and tested in the core.
 *
 * A plan with NO range (`plan.range === null`) is the degenerate outcome of the
 * system-prompt clamp: the rollback's only shadowed node was the protected system
 * prompt, so there is nothing to replace. It is appended as a plain surface
 * append — `'append'` is a `SurfaceOp` on every supported build, and the two
 * remaining spellings are both impossible: a `replace` over node 0 is what the
 * framework refuses, and omitting the marker entirely is refused too
 * (`session event "user/message" is surface-eligible and requires a surfaceOp
 * marker`, `dsh-session/lib/index.js:276`). No `sourceEventSeqs` rides this
 * append: the framework demands a non-empty list when the key is present
 * (`:289`), and an append shadows nothing to cite.
 * @param session - the session to append to.
 * @param plan - the planned marker.
 * @returns the logged marker event, for the surface tail to follow.
 * @throws whatever the append threw, when neither spelling is accepted.
 */
function appendRollbackMarker(session: Session, plan: TruncationMarkerPlan): { readonly seq: number } {
  const range = plan.range
  if (range === null) {
    return session.append('user/message', plan.data as never, { surfaceOp: 'append' as never })
  }
  return withReplaceSurfaceOpFallback(range, surfaceOp =>
    session.append('user/message', plan.data as never, {
      surfaceOp: surfaceOp as never,
      sourceEventSeqs: [...plan.sourceEventSeqs],
    }))
}

/**
 * The paths one session's sidecar holds — everything worth watching.
 *
 * The sidecar is the durable record of what the file tools touched, so it is also
 * the list a restarted process should keep re-checking.
 * @param sessionId - the session.
 * @returns distinct display paths, in no particular order.
 */
/**
 * The session's event log, through the accessor this framework build ships.
 *
 * 0.1.5 made the log private and exposes `snapshotEvents()`; <=0.1.1 handed the
 * array out as `session.events`. This is not cosmetic: reading a missing
 * accessor throws, and this code runs inside the `session/created` observer, so
 * the throw made the HOST's own session resume fail — every affected session
 * rendered an empty transcript ("resume failed for session … TypeError: events is
 * not iterable"), which is a far worse outcome than any bug in this plugin's own
 * features. Hence a total function: an unreadable log degrades to "no events".
 * @param session - the session whose log to read.
 * @returns the events, oldest first; empty when they cannot be read.
 */
function eventsOf(session: any): readonly any[] {
  try {
    if (typeof session?.snapshotEvents === 'function') {
      const events = session.snapshotEvents()
      return Array.isArray(events) ? events : []
    }
    if (Array.isArray(session?.events)) return session.events
  } catch {
    /* an unreadable log is treated as empty; the caller records nothing */
  }
  return []
}

function watchablePaths(sessionId: string, skipTurns?: ReadonlySet<number>): string[] {
  const paths = new Set<string>()
  for (const byPath of loadCheckpoints(sessionId, skipTurns).values()) {
    for (const [path, record] of byPath) {
      // Only a create/update record proves a file is real state worth watching. A
      // `remove` record is a FINDING, and a finding about a path whose only real
      // records belong to turns a rollback already removed is itself the zombie: the
      // file is missing because that rollback correctly deleted it, so watching it
      // would keep producing the very findings this filter exists to stop.
      if (record.operation !== 'remove') paths.add(path)
    }
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
  /**
   * Turns the log proves a rollback already removed, per session.
   *
   * Their sidecar records describe state that no longer exists — their file changes
   * were undone — so both the watch list and the known-content map must ignore them.
   * Without this, files an earlier rollback correctly deleted come back as "missing"
   * findings on the CURRENT turn and a later rollback resurrects them.
   */
  private readonly deadTurns = new Map<string, ReadonlySet<number>>()

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
      watchedPaths: sessionId => watchablePaths(sessionId, this.deadTurns.get(sessionId)),
      knownContent: sessionId => loadWatched(sessionId, this.deadTurns.get(sessionId)),
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

    // Plugin failures are CONTAINED here, never propagated: this observer runs
    // inside the host's own session lifecycle, where a throw from the plugin is not
    // a plugin outage but a host one. Both shapes of failure are covered — the
    // synchronous throw by the catch below, and the fire-and-forget re-scan (whose
    // rejection would surface as an unhandled rejection and take the whole process
    // with it) by each call's own `.catch`. Loud, never fatal.
    ctx.on('session/event', (_session, event) => {
      try {
        const session = _session as Session
        const fold = this.foldFor(session)
        switch (event.type) {
          case 'turn/start':
            fold.fold({ kind: 'turn-start', turn: event.data.turn, seq: event.seq })
            break
          case 'turn/end': {
            // The turn's own end is the boundary that matters most: a shell command
            // that ran during this turn must be noticed BEFORE the user rolls back.
            // Waiting for their next message would catch the deletion a turn too late,
            // and not at all if they rolled back first. The turn number is read before
            // the fold closes the turn.
            const endedSessionId = typeof session.id === 'string' ? session.id : ''
            if (endedSessionId !== '') {
              this.rescan.scan(endedSessionId, event.data.turn).catch(error => {
                console.warn('[dsh-rollback] boundary re-scan failed; the host keeps working:', error)
              })
            }
            fold.fold({ kind: 'turn-end', turn: event.data.turn, seq: event.seq })
            break
          }
          case 'user/message':
          case 'assistant/message':
          case 'tool/result':
            // Only append-origin surface events advance a live turn's span.
            if (event.surfaceOp === 'append') fold.fold({ kind: 'surface', seq: event.seq })
            // A user message is also a boundary, catching anything that changed between
            // the last turn's end and this message (a shell command the user ran
            // themselves, for instance). The turn is read NOW — the scan itself is
            // asynchronous — and nothing is awaited on the message path.
            if (event.type === 'user/message') {
              const openedTurn = fold.inProgressTurn()
              const sessionId = typeof session.id === 'string' ? session.id : ''
              if (openedTurn !== null && sessionId !== '') {
                this.rescan.scan(sessionId, openedTurn).catch(error => {
                  console.warn('[dsh-rollback] boundary re-scan failed; the host keeps working:', error)
                })
              }
            }
            break
          default:
            break
        }
      } catch (error) {
        console.warn('[dsh-rollback] session/event observer failed; the host keeps working:', error)
      }
    })

    // Copy-before-Write for `str_replace_editor`: its canonical value is a
    // rendered string, not {path, before, after}, so read the target BEFORE the
    // tool runs. `write`/`edit` are captured from their result value instead.
    //
    // Only the plugin's own read is contained; `next()` is deliberately OUTSIDE the
    // try. `next()` is the host's continuation — catching it would swallow a real
    // tool failure and hand the host an apparent success, which is a semantics
    // change, not a defensive one.
    ctx.on('tools/pre-execute', async (exec, next) => {
      if ((exec as { name?: string }).name !== 'str_replace_editor') return next()
      try {
        await this.captureBefore(exec as Parameters<RollbackService['captureBefore']>[0])
      } catch (error) {
        // Still never blocks or fails the tool — but no longer silently: a capture
        // read that stopped working is exactly the kind of thing this must say out
        // loud, or rollback coverage would decay unobserved.
        console.warn('[dsh-rollback] tools/pre-execute observer failed; the host keeps working:', error)
      }
      return next()
    })

    // Containment, not a behaviour change: this runs inside the host's tool-result
    // notification path, so a plugin throw here would surface as a host failure.
    ctx.on('tools/result', (exec, result) => {
      try {
        const callId = (exec as { callId?: string }).callId ?? ''
        const pending = this.pendingBefore.get(callId)
        this.pendingBefore.delete(callId)
        if (result.isError as boolean) return
        const session = (exec as { agent?: { session?: object } }).agent?.session
        if (session === undefined) return
        const sessionObj = session as Session

        // A tool that reports its own outcome carries the content it left behind; the
        // pre-read fallback (`str_replace_editor`, whose result value is rendered
        // text) knows only the BEFORE state, so its `after` is a placeholder, not an
        // observation.
        const reported = mutationOf(
          exec as unknown as MutationActor,
          (result as { value?: unknown }).value,
        )
        const mutation = reported ?? (pending === undefined
          ? null
          : {
              path: pending.path,
              operation: pending.kind === 'created' ? 'create' : 'update',
              before: pending.before,
              after: '',
            })
        if (mutation === null) return

        const fold = this.foldFor(sessionObj)
        fold.fold({ kind: 'fs-mutation', mutation })
        // The file tools are the plugin's only window onto the workspace; every path
        // they touch becomes one the boundary re-scan watches from now on. A path
        // whose content the tool never reported is watched with an unknown content, so
        // the next check reads it and records nothing rather than treating the
        // placeholder as an emptied file.
        const sessionId = typeof sessionObj.id === 'string' ? sessionObj.id : ''
        if (sessionId !== '') {
          this.rescan.observe(sessionId, mutation.path, reported === null ? null : reported.after)
        }

        // Persist the pre-turn content so a later restart can still restore it
        // (the log only keeps 3-line diff hunks, not whole files), and the content
        // this touch left behind so a restart can still restore a file a later shell
        // command removes. The after-state is written only when the tool reported it:
        // a placeholder would prime the restarted watch list with a content the plugin
        // never saw.
        const turn = fold.inProgressTurn()
        if (turn !== null && sessionId !== '') {
          appendCheckpoint({
            sessionId,
            turn,
            path: mutation.path,
            operation: mutation.operation,
            before: mutation.before,
            ...(reported === null ? {} : { after: reported.after }),
          })
        }
      } catch (error) {
        console.warn('[dsh-rollback] tools/result observer failed; the host keeps working:', error)
      }
    })

    // Restored sessions never republish their seeded log on `session/event`,
    // so rebuild each pickup's fold by replaying the stored log.
    //
    // This one is the reason the guard exists at all: it runs while the HOST is
    // resuming a session, so an unguarded throw from the plugin made the resume
    // itself fail and every affected conversation render an empty transcript.
    ctx.on('session/created', (session) => {
      try {
        this.seedFromLog(session as Session)
      } catch (error) {
        console.warn('[dsh-rollback] session/created observer failed; the host keeps working:', error)
      }
    })
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
    // The log is append-only: it still holds every turn a rollback replaced. Replaying
    // those would put undone turns back into the window — offering turns the
    // transcript no longer shows, naming files from them, and (worst) letting a
    // "created file" recorded there delete a file the user has since recreated. The
    // markers in the log say exactly which ranges are gone.
    const replaced = replacedSurfaceRanges(eventsOf(session) as never)
    // ...and those same turns decide which durable records no longer describe
    // anything real. They must be dropped BEFORE the watch list is primed from the
    // sidecar: a path whose only records belong to removed turns is a file an earlier
    // rollback already deleted, and watching it would turn "it is missing" into a
    // finding on the CURRENT turn — resurrecting it on the next rollback.
    const sessionKey = typeof session.id === 'string' ? session.id : ''
    if (sessionKey !== '') this.deadTurns.set(sessionKey, deadTurnsOf(eventsOf(session) as never))
    // Keep watching whatever the sidecar still knows — minus those removed turns — so
    // a restarted process notices a shell command that removes one of those files.
    if (sessionKey !== '') this.rescan.prime(sessionKey)
    const durable = loadCheckpoints(String(session.id), this.deadTurns.get(sessionKey))
    const calls = new Map<string, { name: string; argsRaw: string }>()
    for (const event of eventsOf(session)) {
      if (isReplacedSeq(event.seq, replaced)) continue
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

  /**
   * Compute a read-only rollback plan (does not mutate anything).
   *
   * Waits for a boundary re-scan already running, for the same reason `execute`
   * does: a plan computed a moment after a turn ends must include what that turn's
   * scan found, or the preview would under-report what the rollback will do.
   * @param session - the session to plan against.
   * @param fromTurn - restore the state before this turn.
   * @returns the plan.
   */
  async preview(session: Session, fromTurn: number): Promise<RollbackPlan> {
    const fold = this.foldFor(session)
    const sessionId = typeof session.id === 'string' ? session.id : ''
    if (sessionId !== '') await this.rescan.settled(sessionId)
    // The same range check `execute` makes: a preview that quietly reported the oldest
    // retained records as if they were this target's state would be worse than no
    // preview at all.
    const outOfRange = windowRefusal(fromTurn, fold.snapshots().map(checkpoint => checkpoint.turn))
    if (outOfRange !== null) throw new Error(outOfRange)
    const plan = planRollback(fold.snapshots(), fromTurn, fold.surfaceTail())
    // The fold's in-memory surface tail can lag behind the durable session
    // surface (e.g. restored/image turns). The authoritative truncation — and
    // exactly what `execute` shadows — is the session surface itself, so report
    // THAT for the "对话截断" hint instead of the fold's stale tail. Read through
    // the same clamp `execute` plans with, so the preview cannot promise a range
    // the marker will not be allowed to replace (the system-prompt node is never
    // in it; see `planTruncationMarker`).
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
   * @throws when any turn is still open (a mid-run rollback is unsafe).
   */
  async execute(session: Session, fromTurn: number, signal?: AbortSignal): Promise<RollbackOutcome> {
    const fold = this.foldFor(session)
    // NO rollback while a turn is running, whatever the target: see rollbackRefusal.
    const refusal = rollbackRefusal(fold.inProgressTurn())
    if (refusal !== null) throw new Error(refusal)
    // A target older than the retained window cannot be reconstructed: planning
    // anyway would silently restore from the oldest retained records instead.
    const outOfRange = windowRefusal(fromTurn, fold.snapshots().map(checkpoint => checkpoint.turn))
    if (outOfRange !== null) throw new Error(outOfRange)
    // A scan triggered by the turn's own end may still be reading files; planning
    // without waiting would miss exactly the change this rollback is meant to undo.
    const settlingId = typeof session.id === 'string' ? session.id : ''
    if (settlingId !== '') await this.rescan.settled(settlingId)

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

    // SKIP AND CONTINUE, not all-or-nothing. A file this rollback cannot put back —
// its pre-turn content was never recorded, or the filesystem refused the write —
// must not be able to strand the user: nothing would be truncated, the files that
// DID succeed would already be changed, and the blocking cause (a file lock, a
// permission, a sandbox fence) is often permanent, so every retry would fail the
// same way. The rollback therefore does what it can, truncates the conversation as
// asked, and reports exactly what it left alone. The preview already listed the
// unrestorable paths as 跳过 before the user confirmed, so this is a known cost
// rather than a surprise.

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
      const spanStartMs = turnStartTimeMs(eventsOf(session) as never, fromTurn)
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
    // A degenerate plan (no range) still lands a marker — the checkpoint text
    // reaches the model — but replaces nothing, so only a plan WITH a range is a
    // truncation.
    const truncated = markerPlan !== null && markerPlan.range !== null
    if (markerPlan !== null) {
      try {
        const marker = appendRollbackMarker(session, markerPlan)
        fold.setTail(marker.seq)
      } catch (error) {
        // The files are already restored, so this cannot be rolled back silently:
        // report it rather than leaving a half-applied rollback unexplained.
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`回退失败：工作区文件已恢复，但对话截断未能写入（${message}）。请重试回退。`)
      }
    }

    // 4) Drop the now-undone checkpoints and reset the in-flight state — except the
    // entries for paths this rollback could not undo, which stay so a later rollback
    // can try them again once the cause (a lock, a permission) is gone.
    fold.dropFromExcept(fromTurn, new Set(skipped.map(entry => entry.path)))
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
        truncation: markerPlan?.range ?? null,
      }, { removedDirs }),
    }
  }
}
