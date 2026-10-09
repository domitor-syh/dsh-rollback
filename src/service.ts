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
import type { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session/types'
import type { FsMutation } from './core/model.ts'
import { priceRollbackPrune } from './core/prune-pricing.ts'
import { fsMutationFrom, SessionFold } from './core/session-fold.ts'
import { planRollback, type RestoredFile, type RollbackPlan, type SkippedFile } from './core/restore-plan.ts'
import { deadTurnsOf, isReplacedSeq, replacedSurfaceRanges } from './core/log-replay.ts'
import { rollbackRefusal, windowRefusal } from './core/rollback-guard.ts'
import { BoundaryRescan } from './boundary-rescan.ts'
import { authorizeLocalDelete, deleteLocalFile } from './local-delete.ts'
import { diagnose } from './log.ts'
import { createRollbackState, stateLine } from './core/rollback-boundary.ts'
import { clearTransaction, loadTransaction, saveTransaction, type RollbackTransaction } from './transaction-store.ts'
import {
  planTruncationMarker,
  rolledBackAlready,
  shadowedSurfaceFrom,
  withReplaceSurfaceOpFallback,
  type SessionView,
  type TruncationMarkerPlan,
} from './core/truncation-plan.ts'
import { appendCheckpoint, loadCallCoverage, loadCheckpoints, loadWatched, saveRollbackBaseline } from './store.ts'
import { discardRescue, loadRescues, saveRescue, validateRescuePoint } from './rescue-store.ts'

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

/** Resolve the session through the Agent's public, branded session identity. */
function sessionOf(ctx: Context, exec: { agent?: { id?: unknown } }): Session | undefined {
  const id = exec.agent?.id
  return typeof id === 'string' ? ctx.sessions.get(id as SessionId) : undefined
}

function isReadOnlyFileDispatch(name: string | undefined, input: unknown): boolean {
  if (['read', 'read_image', 'glob', 'grep', 'web_search', 'web_fetch', 'load_workspace_dependencies',
    'cordis_inspect_list', 'cordis_inspect_query', 'job_list', 'job_output', 'get_goal',
    'list_agents', 'ask_user_question', 'present', 'skill', 'todo_write'].includes(name ?? '')) return true
  if (name !== 'str_replace_editor' && name !== 'plugin_manager') return false
  try {
    const args = (typeof input === 'string' ? JSON.parse(input) : input) as { command?: unknown; action?: unknown } | null
    return name === 'str_replace_editor' ? args?.command === 'view'
      : ['list_plugins', 'list_bundles', 'list_version_exemptions'].includes(String(args?.action))
  } catch { return false }
}

function isDirectFileDispatch(name: string | undefined): boolean {
  return ['write', 'edit', 'str_replace_editor'].includes(name ?? '')
}

function rescueCommittedAt(transactionId: string): string {
  const match = /^rollback-truncation-(\d+)-/.exec(transactionId)
  const timestamp = match === null ? 0 : Number(match[1])
  return Number.isSafeInteger(timestamp) && timestamp > 0 ? new Date(timestamp).toISOString() : transactionId
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
    parts.push(`${plan.skipped.length} 个文件恢复依据不完整：${detail}`)
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
 * The rollback boundary of one session, as the client reads it.
 *
 * Computed HERE, on the host, because the host is the party that can always read the
 * durable log: measured 2026-10-04, a session whose slice held 177 nodes and 46 flow rows
 * reported no rollback marker at all while its log carried three, so every window the
 * client derived from those markers was empty and nothing was ever hidden — not the
 * transcript, not the turn ladder. The boundary needs neither the marker node nor a
 * readable slice, only the log and the current surface, both available here.
 *
 * Standing is decided by the SURFACE: a marker a later marker replaced is gone from the
 * model-visible surface, and its range went with it.
 * @param session - the session to read.
 * @returns the machine-readable boundary line (see `boundaryLine`).
 */
export function boundaryTextOf(session: Session): string {
  const events = eventsOf(session)
  return stateLine(createRollbackState(String(session.id), semanticVersion(events), events))
}

/** Command receipts are not conversational changes and must not invalidate their own preview. */
function semanticVersion(events: readonly any[]): number {
  let version = 0
  for (const event of events) if (event.type !== 'command/run' && event.type !== 'command/done') version = Math.max(version, event.seq ?? 0)
  return version
}

/** A refused model attempt consumes inbox entries but never reaches the surface.
 * Permit only complete blocked-turn envelopes; queued input or any real activity
 * still invalidates a transaction. The preview version remains strictly monotonic.
 */
function transactionFresh(session: Session, version: number, pendingMarker?: TruncationMarkerPlan): boolean {
  const tail = eventsOf(session).filter(event => event.seq > version && event.type !== 'command/run' && event.type !== 'command/done')
  // A split append may leave one or more non-surface prices, interleaved with
  // blocked attempts. Validate every claim; preserve all other freshness checks.
  if (pendingMarker !== undefined && pendingMarker.range !== null) {
    for (let index = tail.length - 1; index >= 0; index--) {
      const event = tail[index]!
      if (event.type !== 'compaction/prune') continue
      const price = event.data
      if (event.surfaceOp !== undefined
        || price?.shadowedRange?.start !== pendingMarker.range.start || price?.shadowedRange?.end !== pendingMarker.range.end
        || !Array.isArray(price.shadowedSeqs) || price.shadowedSeqs.length !== pendingMarker.shadowed.length
        || !price.shadowedSeqs.every((seq: number, offset: number) => seq === pendingMarker.shadowed[offset])
        || !Number.isSafeInteger(price.shadowedTokenCount) || price.shadowedTokenCount < 0) return false
      tail.splice(index, 1)
    }
  }
  if (tail.length === 0) return true
  let turn: number | undefined
  let blocked = 0
  let inboxDelta = 0
  for (const event of tail) {
    if (event.type === 'agent/inbox/spliced') {
      const data = event.data
      const removed = data?.removedCount === undefined ? 0 : data.removedCount
      if (data?.target !== 'next-turn' || !Array.isArray(data.inserted) || !Number.isSafeInteger(removed) || removed < 0) return false
      inboxDelta += data.inserted.length - removed
      if (inboxDelta < 0) return false
      continue
    }
    if (event.type === 'turn/start' && turn === undefined) { turn = event.data?.turn; continue }
    if (event.type === 'turn/end' && turn !== undefined && event.data?.turn === turn && event.data?.reason?.kind === 'blocked') {
      turn = undefined; blocked++; continue
    }
    return false
  }
  return blocked > 0 && turn === undefined && inboxDelta === 0 && tail.at(-1)?.type === 'turn/end'
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
      // `src/core` is deliberately dependency-free and never imports a DSH type, so
      // the plan carries plain numbers. They ARE the session's own event seqs, so the
      // brand is restored here — at the one place those two worlds meet. Without the
      // cast the compiler is right to complain, and this line used to be invisible
      // because the whole file was checked with the unresolved-package fallout silenced.
      sourceEventSeqs: [...plan.sourceEventSeqs] as unknown as SessionSeq[],
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
 * features. An unreadable log now disables rollback for that session while lifecycle
 * listeners contain the failure, rather than presenting an invented empty history.
 * @param session - the session whose log to read.
 * @returns the events, oldest first; throws when they cannot be read.
 */
function eventsOf(session: any): readonly any[] {
  if (typeof session?.snapshotEvents === 'function') {
    const events = session.snapshotEvents()
    if (Array.isArray(events)) return events
  } else if (Array.isArray(session?.events)) return session.events
  throw new Error('会话日志不可读，已禁止回退。')
}

function watchablePaths(sessionId: string, skipTurns?: ReadonlySet<number>, report?: (message: string) => void): string[] {
  const paths = new Set<string>()
  for (const byPath of loadCheckpoints(sessionId, skipTurns, report).values()) {
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
const lockKey = Symbol.for('@domitor-syh/dsh-rollback/active-v1')
const shared = globalThis as typeof globalThis & { [lockKey]?: Set<string> }
const GLOBAL_ACTIVE = shared[lockKey] ??= new Set<string>()

export class RollbackService {
  private readonly folds = new WeakMap<object, SessionFold>()
  /** Copy-before-Write carrier for `str_replace_editor`, keyed by call id. */
  private readonly pendingBefore = new Map<string, { path: string; kind: 'created' | 'updated'; before: string | null }>()
  /** Target-only evidence captured before post-execute can reject committed I/O. */
  private readonly directEffects = new Map<string, { session: Session; turn: number; mutation: FsMutation }>()
  /** Watchdog for registered files, compared only within mutating dispatch windows. */
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
  private readonly active = GLOBAL_ACTIVE
  private readonly lifetime = new AbortController()
  private readonly sessionLifetimes = new WeakMap<Session, AbortController>()

  private operationSignal(session: Session, signal?: AbortSignal): AbortSignal {
    let controller = this.sessionLifetimes.get(session)
    if (controller === undefined) { controller = new AbortController(); this.sessionLifetimes.set(session, controller) }
    return AbortSignal.any([this.lifetime.signal, controller.signal, ...(signal === undefined ? [] : [signal])])
  }
  private readonly durabilityFailures = new Map<string, string>()
  private readonly observations = new Map<string, Promise<void>>()
  /** Last authoritative file-tool version; content comparison remains the restart fallback. */
  private readonly toolVersions = new Map<string, Map<string, string>>()

  private async observed(sessionId: string): Promise<void> {
    await this.observations.get(sessionId)
  }

  /**
   * Queue a finite, fail-closed scan of paths already registered by file-tool
   * observations or durable baselines. This is deliberately not a shell parser
   * or a workspace watcher: detached jobs, user terminals, and unregistered new
   * paths remain outside the evidence boundary.
   */
  private queuePostDispatchScan(session: Session, turn: number | null, snapshot: Awaited<ReturnType<BoundaryRescan['captureDispatch']>>): Promise<void> {
    const sessionId = String(session.id)
    if (turn === null || this.pending(sessionId)) return Promise.resolve()
    const previous = this.observations.get(sessionId) ?? Promise.resolve()
    const task = previous.then(() => this.pending(sessionId) ? undefined : this.rescan.finishDispatch(sessionId, turn, snapshot)).then(
      () => undefined,
      error => { diagnose(this.ctx, 'warn', '[dsh-rollback] post-dispatch boundary scan failed; rollback coverage is unknown:', error) },
    ).finally(() => {
      if (this.observations.get(sessionId) === task) this.observations.delete(sessionId)
    })
    this.observations.set(sessionId, task)
    return task
  }

  versionOf(session: Session): number { return semanticVersion(eventsOf(session)) }

  private persist(record: Parameters<typeof appendCheckpoint>[0]): void {
    try { appendCheckpoint(record) } catch (error) {
      this.durabilityFailures.set(record.sessionId, String(error))
      throw error
    }
  }

  private assertReady(session: Session, version?: number): void {
    this.lifetime.signal.throwIfAborted()
    if (this.ctx.sessions.get(session.id) !== session) throw new Error('目标会话已关闭或替换，已停止回退并保留恢复日志。')
    const failed = this.durabilityFailures.get(String(session.id))
    if (failed !== undefined) throw new Error(`检查点持久化失败，已禁止回退以免丢失恢复依据：${failed}`)
    const refusal = rollbackRefusal(this.foldFor(session).inProgressTurn())
    if (refusal !== null) throw new Error(refusal)
    if (version !== undefined && this.versionOf(session) !== version) throw new Error('会话在预览或回退期间发生变化，请重新预览；未完成恢复请使用 /rollback retry 或 /rollback abort。')
  }

  rescueList(session: Session): readonly { id: string; fromTurn: number; committedAt: string; files: readonly string[] }[] {
    return loadRescues(String(session.id)).map(point => ({
      id: point.id,
      fromTurn: point.fromTurn,
      committedAt: point.committedAt,
      files: point.files.map(file => file.path),
    }))
  }

  async doctor(session: Session) { return this.diagnose(session) }

  /** Read-only, content-free diagnostics. Presence is not proof of backend semantics. */
  async diagnose(session: Session) {
    const id = String(session.id)
    let observationState: 'settled' | 'failed' = 'settled'
    try { await this.observed(id); await this.rescan.settled(id) } catch { observationState = 'failed' }
    let liveSession: boolean | 'unknown' = 'unknown'
    try { liveSession = this.ctx.sessions.get(session.id) === session } catch { /* keep unknown without leaking errors */ }
    let journal: 'none' | 'unreadable' | RollbackTransaction['phase'] = 'none'
    try { journal = loadTransaction(id)?.phase ?? 'none' } catch { journal = 'unreadable' }
    let checkpoints: number[] | null = null
    let openTurn: number | null | 'unknown' = 'unknown'
    try {
      const fold = this.foldFor(session)
      checkpoints = fold.snapshots().map(cp => cp.turn)
      openTurn = fold.inProgressTurn()
    } catch { /* Unreadable state is not an empty list. */ }
    let rescuePoints: number | 'unknown' = 'unknown'
    try { rescuePoints = loadRescues(id).length } catch { /* Keep unreadable durable rescue state unknown. */ }
    let policyMode = 'unknown'
    try { policyMode = this.ctx.sandboxPolicy.resolve({ session }).mode } catch { /* Read-only diagnosis must contain unavailable services. */ }
    const capabilities: Record<string, boolean | 'unknown'> = {}
    for (const method of ['resolve', 'stat', 'readText', 'writeText', 'processPathFromHostPath'] as const) {
      try { capabilities[method] = typeof this.ctx.fs[method] === 'function' } catch { capabilities[method] = 'unknown' }
    }
    let pressurePricing: 'available' | 'unavailable' | 'unknown' = 'unknown'
    try {
      const meter = this.ctx.get?.('tokenMeter')
      pressurePricing = typeof meter?.measure === 'function' ? 'available' : 'unavailable'
    } catch { /* Presence only, no meter measurement or event append. */ }
    return {
      sessionId: id, liveSession, observationState,
      disposed: this.lifetime.signal.aborted, active: this.active.has(id), journal,
      checkpointState: this.durabilityFailures.has(id) || observationState === 'failed' ? 'failed' : checkpoints === null ? 'unknown' : 'observed',
      checkpoints, openTurn, policyMode, fsMethods: capabilities,
      rescuePoints,
      conditionalDelete: 'unsupported', pressurePricing,
      capabilityEvidence: 'method-presence-only; backend guards and local mapping are not probed',
      coverage: 'observed registered paths only; bounded post-dispatch scans; known write/edit tool names; agentless or unregistered workspace changes are not attributed',
      durability: process.platform === 'win32' ? 'process-crash recovery only; no power-loss guarantee' : 'file/directory sync; no multi-file atomicity',
      recovery: journal === 'none' ? 'none pending' : 'use /rollback retry or /rollback abort; unreadable journals require inspection',
    }
  }

  private pending(sessionId: string): boolean {
    return this.active.has(sessionId) || loadTransaction(sessionId) !== null
  }

  constructor(private readonly ctx: Context) {
    ctx.effect(() => () => this.lifetime.abort(new Error('插件已卸载，回退已取消；恢复日志将保留。')))
    ctx.on('session/disposed', session => this.sessionLifetimes.get(session)?.abort(new Error('目标会话已关闭，恢复日志将保留。')))
    // The re-scan needs the session's policy to resolve a path, and the fold to
    // anchor a finding at the boundary's turn.
    this.rescan = new BoundaryRescan({
      hostPathOf: async (sessionId, path) => {
        // Same boundary as above: the id arrives as a plain string from this plugin's
        // own dependency-free layers, and `SessionId` is branded.
        const session = this.ctx.sessions.get(sessionId as unknown as SessionId)
        if (session === undefined) return undefined
        const policy = this.ctx.sandboxPolicy.resolve({ session })
        const target = await this.ctx.fs.resolve(path, { cwd: policy.workspaceRoot })
        const hostPath = this.ctx.fs.processPath(target)
        if (typeof this.ctx.fs.processPathFromHostPath !== 'function' || this.ctx.fs.processPathFromHostPath(hostPath) !== hostPath) return undefined
        return hostPath
      },
      watchedPaths: sessionId => watchablePaths(sessionId, this.deadTurns.get(sessionId), message => diagnose(this.ctx, 'warn', message)),
      knownContent: sessionId => loadWatched(sessionId, this.deadTurns.get(sessionId)),
      record: (sessionId, turn, mutation) => {
        // Same boundary as above: the id arrives as a plain string from this plugin's
        // own dependency-free layers, and `SessionId` is branded.
        const session = this.ctx.sessions.get(sessionId as unknown as SessionId)
        if (session === undefined) return
        const fold = this.foldFor(session)
        if (!fold.mutationInto(turn, mutation)) {
          // The boundary's turn already left the retained window: recording it
          // elsewhere would restore the wrong state, so it is dropped with a word.
          throw new Error(`turn ${turn} left the retained window before its boundary scan finished; ${mutation.path} could not be recorded safely`)
        }
        this.persist({
          sessionId,
          turn,
          path: mutation.path,
          operation: mutation.operation,
          before: mutation.before,
          after: mutation.after,
        })
        this.toolVersions.get(sessionId)?.delete(mutation.path)
      },
      saveBaseline: saveRollbackBaseline,
      warn: message => diagnose(this.ctx, 'warn', message),
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
          case 'turn/end':
            fold.fold({ kind: 'turn-end', turn: event.data.turn, seq: event.seq })
            break
          case 'user/message':
          case 'assistant/message':
          case 'tool/result':
            // Surface boundaries carry no evidence of a filesystem mutation.
            // External edits remain conflicts on the last actual file-changing turn.
            if (event.surfaceOp === 'append') fold.fold({ kind: 'surface', seq: event.seq })
            break
          default:
            break
        }
      } catch (error) {
        diagnose(this.ctx, 'warn', '[dsh-rollback] session/event observer failed; the host keeps working:', error)
      }
    })

    // Capture at both gates: legacy pre-execute coverage remains, but an approval
    // listener can short-circuit that waterfall. The allowed dispatch below reads
    // again after approval, immediately before delegating to the tool body.
    // Never catch next(): plugin containment must not swallow host/tool failures.
    // A pending journal is a recovery boundary, including after process restart.
    ctx.on('agent/pre-step', async (payload, next) => {
      await this.observed(String(payload.agent.id))
      try {
        if (this.pending(String(payload.agent.id))) {
          diagnose(this.ctx, 'warn', '[dsh-rollback] pending rollback blocks model execution; use /rollback retry or /rollback abort')
          return { kind: 'reject' as const }
        }
      } catch (error) {
        diagnose(this.ctx, 'warn', '[dsh-rollback] unreadable recovery journal blocks model execution', error)
        return { kind: 'reject' as const }
      }
      return next()
    })

    ctx.on('tools/pre-execute', async (exec, next) => {
      if (exec.agent !== undefined) await this.observed(String(exec.agent.id))
      try {
        if (exec.agent !== undefined && this.pending(String(exec.agent.id))) return { kind: 'deny' as const, reason: '回退恢复尚未完成，工具执行已阻止；请使用 /rollback retry 或 /rollback abort。' }
      } catch (error) {
        return { kind: 'deny' as const, reason: `恢复日志不可读，工具执行已阻止：${String(error)}` }
      }
      if (!['str_replace_editor', 'write', 'edit'].includes((exec as { name?: string }).name ?? '')) return next()
      try {
        await this.captureBefore(exec as Parameters<RollbackService['captureBefore']>[0])
      } catch (error) {
        // Still never blocks or fails the tool — but no longer silently: a capture
        // read that stopped working is exactly the kind of thing this must say out
        // loud, or rollback coverage would decay unobserved.
        if (exec.agent !== undefined) this.durabilityFailures.set(String(exec.agent.id), String(error))
        diagnose(this.ctx, 'warn', '[dsh-rollback] tools/pre-execute observer failed; the host keeps working:', error)
      }
      return next()
    })

    // An ask/allow listener before us may bypass pre-execute entirely. The
    // dispatch waterfall is reached after approval; recheck the journal here too.
    ctx.on('tools/execute', async (exec, next) => {
      if (exec.agent !== undefined) await this.observed(String(exec.agent.id))
      if (exec.agent !== undefined && this.pending(String(exec.agent.id))) {
        throw new Error('回退恢复尚未完成，工具执行已阻止；请使用 /rollback retry 或 /rollback abort。')
      }
      const dispatchSession = exec.agent === undefined ? undefined : sessionOf(this.ctx, exec)
      const dispatchTurn = dispatchSession === undefined ? null : this.foldFor(dispatchSession).inProgressTurn()
      const observesChanges = !isReadOnlyFileDispatch(exec.name, exec.arguments)
      let dispatchSnapshot: Awaited<ReturnType<BoundaryRescan['captureDispatch']>> | undefined
      if (dispatchSession !== undefined && dispatchTurn !== null && observesChanges) {
        try { dispatchSnapshot = await this.rescan.captureDispatch(String(dispatchSession.id)) } catch (error) {
          this.durabilityFailures.set(String(dispatchSession.id), String(error))
          diagnose(this.ctx, 'warn', '[dsh-rollback] pre-dispatch observation failed; rollback disabled:', error)
        }
      }
      // Do not use a pre-approval snapshot: a human may edit the file while the
      // approval dialog is open. A failed refresh must also discard that snapshot.
      this.pendingBefore.delete(exec.callId ?? '')
      try {
        await this.captureBefore(exec)
      } catch (error) {
        if (exec.agent !== undefined) this.durabilityFailures.set(String(exec.agent.id), String(error))
        diagnose(this.ctx, 'warn', '[dsh-rollback] tools/execute capture failed; rollback disabled:', error)
      }
      const directFile = isDirectFileDispatch(exec.name)
      const callId = exec.callId ?? ''
      this.directEffects.delete(callId)
      let failed = true
      try {
        const result = await next()
        failed = result.isError === true
        return result
      } finally {
        // Observe only the declared direct target, including new/unregistered paths.
        // Keep success evidence until tools/result: post-execute may still turn a
        // committed write into a final error. Never scan unrelated direct-tool paths.
        if (directFile && observesChanges && dispatchSession !== undefined && dispatchTurn !== null) {
          try {
            const before = this.pendingBefore.get(callId)
            if (before === undefined) throw new Error('文件工具派发缺少可信目标前镜像。')
            const after = await this.readState(dispatchSession, before.path)
            const mutation: FsMutation = { path: before.path, before: before.before, after,
              operation: before.kind === 'created' ? 'create' : after === null ? 'remove' : 'update' }
            if (failed) {
              if (after !== before.before) this.recordDirectEffect(dispatchSession, dispatchTurn, mutation, callId)
            } else {
              // Keep even a no-op: a later post-execute/external write must not
              // become this tool's postimage. Preserve the original dispatch turn.
              this.directEffects.set(callId, { session: dispatchSession, turn: dispatchTurn, mutation })
            }
          } catch (error) {
            this.durabilityFailures.set(String(dispatchSession.id), String(error))
            diagnose(this.ctx, 'warn', '[dsh-rollback] direct target observation failed; rollback disabled:', error)
          }
        } else if (!directFile && dispatchSession !== undefined && dispatchSnapshot !== undefined && observesChanges) {
          await this.queuePostDispatchScan(dispatchSession, dispatchTurn, dispatchSnapshot)
        }
      }
    })

    // Containment, not a behaviour change: this runs inside the host's tool-result
    ctx.on('tools/result', (exec, result) => {
      try {
        const callId = (exec as { callId?: string }).callId ?? ''
        const pending = this.pendingBefore.get(callId)
        this.pendingBefore.delete(callId)
        const effect = this.directEffects.get(callId)
        this.directEffects.delete(callId)
        if (result.isError as boolean) {
          if (effect !== undefined && effect.mutation.after !== effect.mutation.before) this.recordDirectEffect(effect.session, effect.turn, effect.mutation, callId)
          return
        }
        const sessionObj = sessionOf(this.ctx, exec)
        if (effect !== undefined && sessionObj !== effect.session) throw new Error('文件工具结果到达时会话已关闭或替换。')
        if (sessionObj === undefined) return
        const args = (typeof exec.arguments === 'string' ? JSON.parse(exec.arguments) : exec.arguments ?? {}) as { command?: unknown }
        const needsBefore = exec.name === 'write' || exec.name === 'edit'
          || (exec.name === 'str_replace_editor' && ['create', 'str_replace', 'insert'].includes(String(args.command)))
        if (needsBefore && pending === undefined) {
          throw new Error('成功文件工具缺少可信前镜像；不采用工具自报空内容作为恢复依据。')
        }

        // A tool that reports its own outcome carries the content it left behind; the
        // pre-read fallback (`str_replace_editor`, whose result value is rendered
        // text) knows only the BEFORE state, so its `after` is a placeholder, not an
        // observation.
        const reported = fsMutationFrom(exec.name ?? '', (result as { value?: unknown }).value)
        if (reported === null && effect !== undefined) {
          const { mutation, turn, session } = effect
          if (mutation.before === mutation.after) {
            if (callId !== '' && mutation.before !== null) this.persist({ sessionId: String(session.id), turn,
              path: mutation.path, operation: 'update', before: mutation.before, after: mutation.after, unchanged: true, callId })
          } else this.recordDirectEffect(session, turn, mutation, callId)
          return
        }
        // A `remove` is the tool's own news and is kept. Everything else defers to our
        // own observation of whether the target EXISTED before the tool ran, because
        // the tool cannot express that distinction here: measured on 0.2.0-rc.2, a file
        // created by `write` is reported with `before: ""` and no `create` marker, so it
        // was recorded as an update — and rolling that turn back RESTORED the file
        // instead of deleting it, while a turn that only created files looked like it
        // had changed nothing at all. `mutationOf` still supplies the bytes.
        const operation = reported !== null && reported.operation === 'remove'
          ? 'remove'
          : pending?.kind === 'created'
            ? 'create'
            : reported?.operation ?? 'update'
        const mutation = reported !== null
          ? { ...reported, path: pending?.path ?? reported.path, before: pending?.before ?? (pending?.kind === 'created' ? null : reported.before), operation }
          : pending === undefined
            ? null
            : {
                path: pending.path,
                operation,
                before: pending.before,
                after: '',
              }
        if (mutation === null) return
        // An idempotent write/edit is not a new file-changing turn. Keep historical
        // post-state/version evidence unchanged so pre-existing external edits warn.
        if (reported !== null && mutation.operation === 'update' && mutation.before === mutation.after) {
          const turn = effect?.turn ?? this.foldFor(sessionObj).inProgressTurn()
          if (turn !== null && callId !== '') this.persist({ sessionId: String(sessionObj.id), turn, path: mutation.path,
            operation: 'update', before: mutation.before, after: mutation.after, unchanged: true, callId })
          return
        }

        const fold = this.foldFor(sessionObj)
        const sessionId = typeof sessionObj.id === 'string' ? sessionObj.id : ''
        const turn = effect?.turn ?? fold.inProgressTurn()
        if (reported === null && turn !== null && sessionId !== '') {
          const previous = this.observations.get(sessionId) ?? Promise.resolve()
          const task = previous.then(async () => {
            const content = await this.readState(sessionObj, mutation.path)
            if (content === null) throw new Error(`编辑器成功后目标缺失，无法确认后态：${mutation.path}`)
            if (mutation.operation === 'update' && content === mutation.before) {
              if (callId !== '') this.persist({ sessionId, turn, path: mutation.path, operation: 'update', before: content, after: content, unchanged: true, callId })
              return
            }
            const confirmed = { ...mutation, after: content }
            if (!fold.mutationInto(turn, confirmed)) throw new Error('编辑器后态确认时原轮次已离开保留窗口。')
            this.persist({ sessionId, turn, path: mutation.path, operation: mutation.operation, before: mutation.before, after: content,
              ...(callId !== '' ? { callId } : {}) })
            this.toolVersions.get(sessionId)?.delete(mutation.path)
            this.rescan.observe(sessionId, mutation.path, content, turn)
          }).catch(error => {
            this.durabilityFailures.set(sessionId, String(error))
            diagnose(this.ctx, 'warn', '[dsh-rollback] post-tool observation failed; rollback disabled', error)
          }).finally(() => { if (this.observations.get(sessionId) === task) this.observations.delete(sessionId) })
          this.observations.set(sessionId, task)
          return
        }
        if (turn !== null && !fold.mutationInto(turn, mutation)) throw new Error('文件工具结果到达时原轮次已离开保留窗口。')
        // The file tools are the plugin's only window onto the workspace; every path
        // they touch becomes one the boundary re-scan watches from now on. A path
        // whose content the tool never reported is watched with an unknown content, so
        // the next check reads it and records nothing rather than treating the
        // placeholder as an emptied file.
        if (sessionId !== '') {
          const reportedVersion = (result as { value?: { version?: unknown } }).value?.version
          const versions = this.toolVersions.get(sessionId) ?? new Map<string, string>()
          if (typeof reportedVersion === 'string') versions.set(mutation.path, reportedVersion)
          else versions.delete(mutation.path)
          this.toolVersions.set(sessionId, versions)
          this.rescan.observe(sessionId, mutation.path, reported === null ? null : reported.after, turn)
        }

        // Persist the pre-turn content so a later restart can still restore it
        // (the log only keeps 3-line diff hunks, not whole files), and the content
        // this touch left behind so a restart can still restore a file a later shell
        // command removes. The after-state is written only when the tool reported it:
        // a placeholder would prime the restarted watch list with a content the plugin
        // never saw.
        if (turn !== null && sessionId !== '') {
          this.persist({
            sessionId,
            turn,
            path: mutation.path,
            operation: mutation.operation,
            before: mutation.before,
            ...(reported === null ? {} : { after: reported.after }),
            ...(callId !== '' ? { callId } : {}),
          })
        }
      } catch (error) {
        if (exec.agent !== undefined) this.durabilityFailures.set(String(exec.agent.id), String(error))
        diagnose(this.ctx, 'warn', '[dsh-rollback] tools/result observer failed; the host keeps working:', error)
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
        this.durabilityFailures.set(String(session.id), String(error))
        diagnose(this.ctx, 'warn', '[dsh-rollback] session/created observer failed; the host keeps working:', error)
      }
    })
    for (const session of this.ctx.sessions.list()) {
      try { this.seedFromLog(session as Session) } catch (error) {
        this.durabilityFailures.set(String(session.id), String(error))
        diagnose(this.ctx, 'warn', '[dsh-rollback] replay failed; rollback disabled for this session', error)
      }
    }
  }

  /**
   * Rebuild one session's fold from its stored log (resume/restart support).
   *
   * Turn boundaries and surface positions replay exactly. File preimages and
   * final postimages come from durable Host checkpoints. Legacy missing
   * postimages cannot prove net zero; logs without checkpoints cannot prove a
   * restore basis and remain explicit unknown-basis refusals.
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
    const durable = loadCheckpoints(String(session.id), this.deadTurns.get(sessionKey), message => diagnose(this.ctx, 'warn', message))
    const coverage = loadCallCoverage(String(session.id))
    const calls = new Map<string, { name: string; argsRaw: string }>()
    const replayEvents = eventsOf(session).filter(event => !isReplacedSeq(event.seq, replaced)
      && !this.deadTurns.get(sessionKey)?.has(event.data?.turn))
    const legacyPath = (call: { name: string; argsRaw: string }): string | undefined => {
      try {
        const args = JSON.parse(call.argsRaw) as { path?: unknown; file_path?: unknown; command?: unknown }
        if (call.name === 'str_replace_editor' && !['create', 'str_replace', 'insert'].includes(String(args.command))) return undefined
        const path = call.name === 'str_replace_editor' ? args.path : args.file_path
        return typeof path === 'string' && path !== '' ? path : undefined
      } catch { return undefined }
    }
    // Legacy receipts lack call identities. At minimum require the exact Host
    // recorded path and enough distinct raw receipts for ALL uncovered successes;
    // another path (or just one of several calls) can never cover this call.
    const ambiguousLegacyTurns = new Set(replayEvents.filter(event => event.type === 'tool/call'
      && !isDirectFileDispatch(event.data.name) && !isReadOnlyFileDispatch(event.data.name, event.data.arguments))
      .map(event => event.data.turn))
    const legacyDemand = new Map<number, Map<string, number>>()
    const historicalCalls = new Map<string, { name: string; argsRaw: string }>()
    for (const event of replayEvents) {
      if (event.type === 'tool/call') historicalCalls.set(event.data.callId, { name: event.data.name, argsRaw: event.data.arguments })
      if (event.type !== 'tool/result' || event.data.error !== undefined) continue
      const callId = event.data.message?.source?.callId ?? ''
      const call = historicalCalls.get(callId)
      if (call === undefined || !isDirectFileDispatch(call.name) || isReadOnlyFileDispatch(call.name, call.argsRaw)
        || coverage.get(event.data.turn)?.calls.has(callId)) continue
      const path = legacyPath(call)
      if (path === undefined) continue
      const demand = legacyDemand.get(event.data.turn) ?? new Map<string, number>()
      demand.set(path, (demand.get(path) ?? 0) + 1)
      legacyDemand.set(event.data.turn, demand)
    }
    const replayResultIds = new Set(replayEvents.filter(event => event.type === 'tool/result')
      .map(event => (event.data as { message?: { source?: { callId?: string } } }).message?.source?.callId ?? '')
      .filter(callId => callId !== ''))
    const recordReplayMutation = (turn: number, mutation: FsMutation): void => {
      if (!fold.mutationInto(turn, mutation)) throw new Error(`历史文件证据无法归入保留轮次：${turn}`)
    }
    const merged = new Set<number>()
    const mergeDurable = (turn: number) => {
      if (merged.has(turn)) return
      for (const [path, record] of durable.get(turn) ?? []) {
        recordReplayMutation(turn, { path, ...record, after: record.after ?? null,
          ...(record.after === undefined ? { afterKnown: false } : {}) })
      }
      merged.add(turn)
    }
    for (const event of eventsOf(session)) {
      if (isReplacedSeq(event.seq, replaced)) continue
      if (sessionKey !== '' && this.deadTurns.get(sessionKey)?.has(event.data?.turn)) continue
      switch (event.type) {
        case 'tool/call': {
          calls.set(event.data.callId, { name: event.data.name, argsRaw: event.data.arguments })
          if (isDirectFileDispatch(event.data.name) && !isReadOnlyFileDispatch(event.data.name, event.data.arguments)
            && !replayResultIds.has(event.data.callId) && !coverage.get(event.data.turn)?.calls.has(event.data.callId)) {
            recordReplayMutation(event.data.turn, { path: `unknown:${event.data.name}:${event.seq}`, operation: 'update', before: null, after: '' })
          }
          break
        }
        case 'tool/result': {
          if (event.surfaceOp === 'append') fold.fold({ kind: 'surface', seq: event.seq })
          const callId = (event.data as { message?: { source?: { callId?: string } } }).message?.source?.callId ?? ''
          const call = calls.get(callId)
          if (coverage.get(event.data.turn)?.calls.has(callId)) break
          if (call === undefined || !['write', 'edit', 'str_replace_editor'].includes(call.name)) break
          if (isReadOnlyFileDispatch(call.name, call.argsRaw)) break
          if (event.data.error !== undefined) break
          // Display paths and full pre-images come only from Host capture, never Node cwd guesses.
          // Historical logs without a sidecar cannot prove a safe restore basis.
          const path = legacyPath(call)
          const legacyCount = path === undefined ? 0 : coverage.get(event.data.turn)?.paths.get(path)?.legacyCount ?? 0
          const required = path === undefined ? 0 : legacyDemand.get(event.data.turn)?.get(path) ?? 0
          if (ambiguousLegacyTurns.has(event.data.turn) || path === undefined || !durable.get(event.data.turn)?.has(path) || required === 0 || legacyCount < required) {
            recordReplayMutation(event.data.turn, { path: `unknown:${call.name}:${event.seq}`, operation: 'update', before: null, after: '' })
          }
          break
        }
        case 'user/message':
        case 'assistant/message':
          if (event.surfaceOp === 'append') fold.fold({ kind: 'surface', seq: event.seq })
          break
        case 'turn/start': {
          const previousTurn = fold.inProgressTurn()
          if (previousTurn !== null) mergeDurable(previousTurn)
          fold.fold({ kind: 'turn-start', turn: event.data.turn, seq: event.seq })
          break
        }
        case 'turn/end':
          mergeDurable(event.data.turn)
          fold.fold({ kind: 'turn-end', turn: event.data.turn, seq: event.seq })
          break
        default:
          break
      }
    }
    const tailTurn = fold.inProgressTurn()
    if (tailTurn !== null) mergeDurable(tailTurn)
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
    agent?: { id?: unknown }
  }): Promise<void> {
    const args = (typeof exec.arguments === 'string' ? JSON.parse(exec.arguments) : exec.arguments ?? {}) as { command?: unknown; path?: unknown; file_path?: unknown }
    const name = exec.name ?? ''
    if (name === 'str_replace_editor') {
      if (args.command !== 'create' && args.command !== 'str_replace' && args.command !== 'insert') return
    } else if (name !== 'write' && name !== 'edit') return
    const path = name === 'str_replace_editor' ? args.path : args.file_path
    if (typeof path !== 'string' || path === '') return
    const session = sessionOf(this.ctx, exec)
    if (session === undefined) return
    const policy = this.ctx.sandboxPolicy.resolve({ session: session as Session })
    const target = await this.ctx.fs.resolve(path, { cwd: policy.workspaceRoot })
    const info = await this.ctx.fs.stat(target)
    if (info === undefined) {
      this.pendingBefore.set(exec.callId ?? '', { path: target.displayPath, kind: 'created', before: null })
      return
    }
    if (info.type !== 'file') throw new Error('目标不是普通文件；未捕获恢复依据。')
    const before = await this.ctx.fs.readText(target)
    const confirmed = await this.ctx.fs.stat(target)
    if (confirmed === undefined || confirmed.version !== info.version) throw new Error('捕获期间目标已变化；未捕获恢复依据。')
    this.pendingBefore.set(exec.callId ?? '', { path: target.displayPath, kind: 'updated', before })
  }

  /**
   * Compute a read-only rollback plan (does not mutate anything).
   *
   * Waits for in-flight dispatch observation and scans to settle, so a preview
   * includes the completed tool dispatch effects even when turn/end arrives first.
   * @param session - the session to plan against.
   * @param fromTurn - restore the state before this turn.
   * @returns the plan.
   */
  async preview(session: Session, fromTurn: number): Promise<RollbackPlan & { version: number }> {
    this.assertReady(session)
    if (loadTransaction(String(session.id)) !== null) throw new Error('存在未完成恢复，请使用 /rollback retry 或 /rollback abort。')
    const version = this.versionOf(session)
    const fold = this.foldFor(session)
    const sessionId = typeof session.id === 'string' ? session.id : ''
    if (sessionId !== '') { await this.observed(sessionId); await this.rescan.settled(sessionId) }
    this.assertReady(session, version)
    // The same range check `execute` makes: a preview that quietly reported the oldest
    // retained records as if they were this target's state would be worse than no
    // preview at all.
    const outOfRange = windowRefusal(fromTurn, fold.snapshots().map(checkpoint => checkpoint.turn))
    if (outOfRange !== null) throw new Error(outOfRange)
    // A turn whose output is already gone from the model-visible surface cannot be
    // rolled back again, and pretending otherwise is what the desktop report of
    // 2026-10-03 caught: the marker written for it replaced the PREVIOUS marker, which
    // un-hid the turn the earlier rollback had hidden. Refused in the preview too, so
    // the confirmation dialog says why instead of promising a truncation that will not
    // happen.
    const alreadyGone = rolledBackAlready(viewOf(session), fromTurn)
    if (alreadyGone !== null) throw new Error(alreadyGone)
    const plan = planRollback(fold.snapshots(), fromTurn, fold.surfaceTail())
    const expected = new Map<string, string | null>()
    for (const checkpoint of fold.snapshots().slice().sort((a, b) => a.turn - b.turn)) {
      for (const change of Object.values(checkpoint.changes)) expected.set(change.path, change.after)
    }
    const policy = this.ctx.sandboxPolicy.resolve({ session })
    for (let index = 0; index < plan.restored.length; index += 1) {
      const file = plan.restored[index]!
      const rawInfo = await this.ctx.fs.lstat(file.path, { cwd: policy.workspaceRoot })
      if (rawInfo !== undefined && rawInfo.type !== 'file') throw new Error(`目标不是普通文件：${file.path}`)
      const target = await this.ctx.fs.resolve(file.path, { cwd: policy.workspaceRoot })
      const info = await this.ctx.fs.stat(target)
      if (info !== undefined && info.type !== 'file') throw new Error(`目标不是普通文件：${file.path}`)
      const content = info === undefined ? null : await this.ctx.fs.readText(target)
      const confirmed = await this.ctx.fs.stat(target)
      if ((info === undefined) !== (confirmed === undefined) || info?.version !== confirmed?.version) {
        throw new Error(`预览期间目标发生变化，请重试：${file.path}`)
      }
      const lastVersion = this.toolVersions.get(sessionId)?.get(file.path)
      if ((expected.has(file.path) && content !== expected.get(file.path))
        || (lastVersion !== undefined && info?.version !== lastVersion)) {
        plan.restored[index] = { ...file, conflict: true }
      }
    }
    this.assertReady(session, version)
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
      version,
      truncation: shadowed.length > 0 ? { start: shadowed[0]!, end: shadowed[shadowed.length - 1]! } : null,
    }
  }

  /**
   * Execute a rollback: restore/delete affected files, then truncate the
   * conversation surface in place.
   *
   * @throws when any turn is still open (a mid-run rollback is unsafe).
   */
  async execute(session: Session, fromTurn: number, signal?: AbortSignal, expectedVersion?: number): Promise<RollbackOutcome> {
    signal = this.operationSignal(session, signal)
    signal.throwIfAborted()
    const id = String(session.id)
    if (this.active.has(id)) throw new Error('本会话已有回退正在执行。')
    this.active.add(id)
    try {
      if (loadTransaction(id) !== null) throw new Error('存在未完成恢复，请使用 /rollback retry 或 /rollback abort。')
      this.assertReady(session, expectedVersion)
      const version = this.versionOf(session)
      await this.rescan.settled(id)
      this.assertReady(session, version)
      const plan = await this.preview(session, fromTurn)
      this.assertReady(session, version)
      if (plan.skipped.length > 0) throw new Error(`恢复依据不完整，未改动文件或对话：${plan.skipped.map(f => f.path).join('；')}`)
      if (typeof this.ctx.sessions.flush !== 'function' || !await this.ctx.sessions.flush(session)) throw new Error('宿主没有可等待的会话持久化参与者，已禁止执行回退。')
      const files: RollbackTransaction['files'] = []
      for (const file of plan.restored) {
        signal?.throwIfAborted()
        this.assertReady(session, version)
        const after = file.action === 'delete' ? null : file.content ?? ''
        const before = await this.readState(session, file.path)
        if (after === null || before === null) await this.authorizeDelete(session, file.path)
        files.push({ path: file.path, before, after, action: file.action })
      }
      signal?.throwIfAborted()
      this.assertReady(session, version)
      const transactionId = markerMessageId()
      const transaction: RollbackTransaction = {
        format: 1, id: transactionId, sessionId: id, fromTurn, version,
        phase: 'restoring', marker: planTruncationMarker(viewOf(session), { fromTurn, messageId: transactionId }), files,
      }
      saveTransaction(transaction)
      return await this.finishTransaction(session, transaction, false, signal)
    } finally { this.active.delete(id) }
  }

  /** Recovery does not rely on a target still being offered in the checkpoint window. */
  async recover(session: Session, abort: boolean, signal?: AbortSignal): Promise<RollbackOutcome> {
    signal = this.operationSignal(session, signal)
    signal.throwIfAborted()
    const id = String(session.id)
    if (this.active.has(id)) throw new Error('本会话已有回退正在执行。')
    this.active.add(id)
    try {
      const transaction = loadTransaction(id)
      if (transaction === null) throw new Error('本会话没有待恢复的回退事务。')
      const open = rollbackRefusal(this.foldFor(session).inProgressTurn())
      if (open !== null) throw new Error(open)
      await this.observed(id)
      return await this.finishTransaction(session, transaction, abort || transaction.phase === 'aborting', signal)
    } finally { this.active.delete(id) }
  }

  /** Direct dispatch evidence also covers non-canonical editor and error results. */
  private recordDirectEffect(session: Session, turn: number, mutation: FsMutation, callId = ''): void {
    const sessionId = String(session.id)
    if (this.ctx.sessions.get(session.id) !== session) throw new Error('文件工具后态确认时会话已关闭或替换。')
    if (!this.foldFor(session).mutationInto(turn, mutation)) throw new Error('文件工具后态确认时原轮次已离开保留窗口。')
    this.persist({ sessionId, turn, ...mutation, ...(callId !== '' ? { callId } : {}) })
    this.toolVersions.get(sessionId)?.delete(mutation.path)
    if (mutation.after === null) this.rescan.resetAfterRollback(sessionId, [{ path: mutation.path, content: null }])
    else this.rescan.observe(sessionId, mutation.path, mutation.after, turn)
  }

  private async readState(session: Session, path: string): Promise<string | null> {
    const policy = this.ctx.sandboxPolicy.resolve({ session })
    const rawInfo = await this.ctx.fs.lstat(path, { cwd: policy.workspaceRoot })
    if (rawInfo !== undefined && rawInfo.type !== 'file') throw new Error(`不是普通文件，拒绝恢复：${path}`)
    const target = await this.ctx.fs.resolve(path, { cwd: policy.workspaceRoot })
    const stat = await this.ctx.fs.stat(target)
    if (stat === undefined) return null
    if (stat.type !== 'file') throw new Error(`不是普通文件，拒绝恢复：${path}`)
    if (stat.size !== undefined && stat.size > 8 * 1024 * 1024) throw new Error(`文件超过恢复上限：${path}`)
    const content = await this.ctx.fs.readText(target)
    const confirmed = await this.ctx.fs.stat(target)
    if (confirmed === undefined || confirmed.version !== stat.version) throw new Error(`读取期间文件已变化，拒绝恢复：${path}`)
    return content
  }

  /** User-authorized local deletion; not a conditional-delete primitive. */
  private async authorizeDelete(session: Session, path: string): Promise<string> {
    return authorizeLocalDelete(this.ctx, session, path)
  }

  private async applyState(session: Session, path: string, content: string | null, signal?: AbortSignal, expectedContent?: string | null): Promise<void> {
    signal?.throwIfAborted()
    const policy = this.ctx.sandboxPolicy.resolve({ session })
    const rawInfo = await this.ctx.fs.lstat(path, { cwd: policy.workspaceRoot }, signal)
    if (rawInfo !== undefined && rawInfo.type !== 'file') throw new Error(`目标不是普通文件，拒绝操作：${path}`)
    const target = await this.ctx.fs.resolve(path, { cwd: policy.workspaceRoot })
    const actor = { agent: { id: session.id } }
    const stat = await this.ctx.fs.stat(target)
    if (stat !== undefined && stat.type !== 'file') throw new Error(`目标不是普通文件，拒绝操作：${path}`)
    // Content conflicts were disclosed in preview; the selected target is authorized.
    // A supported version guard still protects the read-to-write interval.
    void expectedContent
    signal?.throwIfAborted()
    if (this.ctx.sessions.get(session.id) !== session) throw new Error('目标会话已关闭或替换，恢复日志已保留。')
    if (content === null) {
      await deleteLocalFile(this.ctx, session, path, signal)
      signal?.throwIfAborted()
      this.ctx.emit('fs/observed', target, { kind: 'absent' }, actor)
    } else {
      const expected = stat === undefined ? { kind: 'createIfAbsent' as const } : { kind: 'replaceIfVersion' as const, version: stat.version }
      const outcome = await this.ctx.fs.writeText(target, content, expected, signal, policy)
      signal?.throwIfAborted()
      this.ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, actor)
    }
  }

  private appendPricedMarker(session: Session, marker: TruncationMarkerPlan): void {
    // This optional face is inspected on rc.2. It is not a required injection:
    // earlier hosts may lack it. Its fixed heuristic (not image route pricing)
    // is the unit compaction/prune expects. Decline malformed/misaligned data.
    let price: ReturnType<typeof priceRollbackPrune> = null
    try {
      const meter = this.ctx.get?.('tokenMeter')
      if (meter !== undefined && typeof meter.measure === 'function') {
        price = priceRollbackPrune(marker, meter.measure(session).nodes)
      }
    } catch (error) {
      diagnose(this.ctx, 'warn', '[dsh-rollback] optional context pressure pricing unavailable:', error)
    }
    // No await between price and replacement: unrelated events expire the meter's
    // pending price. Append errors are NOT swallowed; WAL remains for recovery.
    if (price !== null) session.append('compaction/prune', price as never)
    appendRollbackMarker(session, marker)
  }

  private async finishTransaction(session: Session, transaction: RollbackTransaction, abort: boolean, signal?: AbortSignal): Promise<RollbackOutcome> {
    const id = String(session.id)
    if (this.ctx.sessions.get(session.id) !== session) throw new Error('目标会话已关闭或替换，恢复日志已保留。')
    const marker = transaction.marker
    const already = () => marker !== null && eventsOf(session).some(event => event.type === 'user/message' && event.data?.id === marker.data.id)
    if (abort && (already() || transaction.phase === 'committed')) throw new Error('对话标记已经写入，不能取消；请 /rollback retry 完成持久化。')
    if (transaction.phase !== 'committed' && !already() && !abort && !transactionFresh(session, transaction.version, transaction.phase === 'marker' && marker !== null ? marker : undefined)) throw new Error('会话已发生变化，拒绝陈旧截断；请 /rollback abort 补偿文件后重新预览。')
    if (abort) { transaction.phase = 'aborting'; saveTransaction(transaction) }
    const rescue = {
      format: 1 as const,
      id: transaction.id,
      sessionId: id,
      fromTurn: transaction.fromTurn,
      versionBefore: transaction.version,
      markerId: marker?.data.id ?? null,
      committedAt: rescueCommittedAt(transaction.id),
      files: transaction.files,
    }
    if (transaction.phase !== 'committed') validateRescuePoint(rescue)
    const reportFile = (file: RollbackTransaction['files'][number], desired: string | null): RestoredFile => {
      const action = !abort && file.action !== undefined ? file.action
        : desired === null ? 'delete' : file.before === null ? 'recover' : 'restore'
      return { path: file.path, action, content: desired,
        kind: action === 'delete' ? 'created' : action === 'recover' ? 'removed' : 'updated' }
    }
    const restored: RestoredFile[] = transaction.phase === 'committed'
      ? transaction.files.map(file => reportFile(file, file.after))
      : []
    for (const file of transaction.phase === 'committed' ? [] : transaction.files) {
      signal?.throwIfAborted()
      const desired = abort ? file.before : file.after
      const current = await this.readState(session, file.path)
      signal?.throwIfAborted()
      if (this.ctx.sessions.get(session.id) !== session) throw new Error('目标会话已关闭或替换，恢复日志已保留。')
      // Explicit rollback/retry/abort selects the desired state even after content changes.
      if (current !== desired) await this.applyState(session, file.path, desired, signal, current)
      this.rescan.resetAfterRollback(id, [{ path: file.path, content: desired }])
      this.toolVersions.get(id)?.delete(file.path)
      restored.push(reportFile(file, desired))
    }
    if (abort) {
      try { discardRescue(rescue) } catch (error) { throw new Error(`取消回退的救援点清理失败，恢复日志将保留：${error instanceof Error ? error.message : String(error)}`) }
      clearTransaction(id)
      return { fromTurn: transaction.fromTurn, executed: true, truncated: false, restored, skipped: [], summary: '已取消回退并补偿文件；对话未截断。' }
    }
    signal?.throwIfAborted()
    if (transaction.phase !== 'committed' && !already()) {
      this.assertReady(session)
      if (!transactionFresh(session, transaction.version, transaction.phase === 'marker' && marker !== null ? marker : undefined)) throw new Error('会话已发生变化，拒绝陈旧截断；恢复日志已保留。')
      transaction.phase = 'marker'
      saveTransaction(transaction)
      if (marker !== null) this.appendPricedMarker(session, marker)
    }
    // Post-commit observers are fire-and-forget, not a durability barrier.
    if (typeof this.ctx.sessions.flush !== 'function' || !await this.ctx.sessions.flush(session)) throw new Error('标记未获持久化确认，恢复日志已保留；请 /rollback retry。')
    this.assertReady(session)
    signal?.throwIfAborted()
    // Rescue persistence is the commit barrier: the marker is durable, then the
    // files-only recovery point is durable, and only then may the WAL become committed.
    // If this fails, the journal stays in `marker` and /rollback retry is safe.
    try {
      saveRescue(rescue)
    } catch (error) {
      throw new Error(`文件与对话回退尚未完成提交，文件救援点未持久化；请 /rollback retry：${error instanceof Error ? error.message : String(error)}`)
    }
    transaction.phase = 'committed'
    saveTransaction(transaction)
    const fold = this.foldFor(session)
    fold.dropFromExcept(transaction.fromTurn, new Set())
    this.deadTurns.set(id, deadTurnsOf(eventsOf(session) as never))
    if (marker !== null) {
      const event = eventsOf(session).find(event => event.type === 'user/message' && event.data?.id === marker.data.id)
      if (event !== undefined) fold.setTail(event.seq)
    }
    clearTransaction(id)
    return {
      fromTurn: transaction.fromTurn, executed: true, truncated: marker?.range != null,
      restored, skipped: [], summary: summarize({ fromTurn: transaction.fromTurn, restored, skipped: [], truncation: marker?.range ?? null }),
    }
  }
}
