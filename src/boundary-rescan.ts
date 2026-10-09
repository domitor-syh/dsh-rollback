/**
 * Host-side watched-file registry and filesystem probes. Scans are serialized per
 * session. Probe failures preserve the previous baseline; persistence failures reject
 * scan/settled so rollback cannot silently proceed with incomplete checkpoints.
 */
import { readFile, lstat } from 'node:fs/promises'
import { findingTurn, planBoundaryAction, type FileProbe, type ObservedFile, type TrackedFile } from './core/boundary-scan.ts'
import type { FsMutation } from './core/model.ts'

export interface BaselineOutcome {
  path: string
  /** Exact restored content; null means confirmed absent, never unknown. */
  content: string | null
}

export interface BoundaryRescanDeps {
  hostPathOf(sessionId: string, path: string): Promise<string | undefined>
  watchedPaths(sessionId: string): readonly string[]
  knownContent(sessionId: string): Map<string, { content: string | null; turn: number | null; missing?: boolean }>
  /** Persist baselines independently of dead-turn filtering; failures must throw. */
  saveBaseline?(sessionId: string, outcomes: readonly BaselineOutcome[]): void
  record(sessionId: string, turn: number, mutation: FsMutation): void
  warn(message: string): void
}

const MAX_WATCHED_BYTES = 8 * 1024 * 1024
const MAX_PATHS = 512
const MAX_PATH_BYTES = 16 * 1024
const MAX_AGGREGATE_BYTES = 64 * 1024 * 1024
const MAX_PENDING_SCANS = 4

export class BoundaryRescan {
  private readonly watched = new Map<string, Map<string, TrackedFile>>()
  private readonly inFlight = new Map<string, Promise<void>>()
  private readonly failures = new Map<string, LatchedFailure>()
  private readonly pending = new Map<string, number>()
  private readonly pendingCounts = new Map<string, number>()
  private readonly warned = new Set<string>()
  private readonly dispatches = new WeakMap<Map<string, TrackedFile>, { sessionId: string; original: Map<string, TrackedFile>; registry: Map<string, TrackedFile> }>()
  constructor(private readonly deps: BoundaryRescanDeps) {}

  /** null is unknown tool output, not an empty or confirmed absent file. */
  observe(sessionId: string, path: string, content: string | null, turn: number | null = null): void {
    const registry = this.registryFor(sessionId)
    if (Buffer.byteLength(path, 'utf8') > MAX_PATH_BYTES || (!registry.has(path) && registry.size >= MAX_PATHS)) {
      this.failures.set(sessionId, { kind: 'scan', error: new Error('边界观察路径数量或路径长度超过上限，回退依据已锁定。') })
      return
    }
    if (content !== null && Buffer.byteLength(content, 'utf8') > MAX_WATCHED_BYTES) {
      this.failures.set(sessionId, { kind: 'scan', error: new Error(`边界观察文件超过恢复上限：${path}`) })
      return
    }
    const aggregate = [...registry.values()].reduce((sum, item) => sum + (item.lastKnown === null ? 0 : Buffer.byteLength(item.lastKnown, 'utf8')), 0)
    if (!registry.has(path) && content !== null && aggregate + Buffer.byteLength(content, 'utf8') > MAX_AGGREGATE_BYTES) {
      this.failures.set(sessionId, { kind: 'scan', error: new Error('边界观察累计内容超过上限，回退依据已锁定。') })
      return
    }
    registry.set(path, { lastKnown: content, size: null, mtimeMs: null, missing: false, lastSeenTurn: turn })
  }

  /** Clear a transient scan failure after all supplied rollback outcomes are durable. */
  clearTransientFailure(sessionId: string): void {
    const failure = this.failures.get(sessionId)
    if (failure?.kind === 'scan') this.failures.delete(sessionId)
  }

  /**
   * Install the exact state after successful rollback I/O. Persistence runs before the
   * in-memory registry is changed; a persistence error remains latched and cannot be
   * cleared by recovery.
   * only successful paths belong here. Untouched/failed paths retain their baselines.
   * saveBaseline must be wired to durable storage for restart coverage.
   */
  resetAfterRollback(sessionId: string, outcomes: readonly BaselineOutcome[]): void {
    try {
      this.deps.saveBaseline?.(sessionId, outcomes)
    } catch (error) {
      this.failures.set(sessionId, { kind: 'persistence', error })
      throw error
    }
    const registry = this.registryFor(sessionId)
    for (const outcome of outcomes) {
      registry.set(outcome.path, {
        lastKnown: outcome.content, size: null, mtimeMs: null,
        missing: outcome.content === null, lastSeenTurn: null,
      })
    }
    // A successful durable baseline establishes a new safe generation. It may clear a
    // transient probe/resolve latch, but never a persistence failure.
    this.clearTransientFailure(sessionId)
  }

  /** Independent pre-dispatch observations: never mutate shared or durable state.
   * Separate snapshots prevent overlapping tools from replacing each other's basis.
   */
  async captureDispatch(sessionId: string): Promise<Map<string, TrackedFile>> {
    const registry = this.registryFor(sessionId)
    const original = new Map(registry)
    const snapshot = new Map(original)
    try { await this.runOnce(sessionId, null, snapshot) } catch (error) {
      if (this.failures.get(sessionId)?.kind !== 'persistence') this.failures.set(sessionId, { kind: 'scan', error })
      throw error
    }
    this.dispatches.set(snapshot, { sessionId, original, registry })
    return snapshot
  }

  async finishDispatch(sessionId: string, turn: number, snapshot: Map<string, TrackedFile>): Promise<void> {
    try {
      const dispatch = this.dispatches.get(snapshot)
      if (dispatch?.sessionId !== sessionId) throw new Error('工具派发观察不属于此会话或已完成。')
      this.dispatches.delete(snapshot)
      // Do not let an old dispatch record over a newer canonical tool or rollback.
      for (const path of snapshot.keys()) {
        if (this.registryFor(sessionId) !== dispatch.registry || dispatch.registry.get(path) !== dispatch.original.get(path)) snapshot.delete(path)
      }
      await this.runOnce(sessionId, turn, snapshot, path => this.registryFor(sessionId) === dispatch.registry && dispatch.registry.get(path) === dispatch.original.get(path))
    } catch (error) {
      if (this.failures.get(sessionId)?.kind !== 'persistence') this.failures.set(sessionId, { kind: 'scan', error })
      throw error
    }
  }

  /** Queue scans serially; retain only the newest pending boundary anchor. */
  scan(sessionId: string, turn: number): Promise<void> {
    const previous = this.inFlight.get(sessionId)
    if (previous !== undefined) {
      const count = this.pendingCounts.get(sessionId) ?? 0
      if (count >= MAX_PENDING_SCANS) {
        const error = new Error('边界扫描队列超过上限，回退依据已锁定。')
        this.failures.set(sessionId, { kind: 'scan', error })
        return Promise.reject(error)
      }
      this.pendingCounts.set(sessionId, count + 1)
      this.pending.set(sessionId, turn)
      return previous
    }
    const task = this.runOnce(sessionId, turn).then(async () => {
      const next = this.pending.get(sessionId)
      this.pending.delete(sessionId)
      this.pendingCounts.delete(sessionId)
      if (next !== undefined) {
        if (this.inFlight.get(sessionId) === task) this.inFlight.delete(sessionId)
        await this.scan(sessionId, next)
      }
    })
    this.inFlight.set(sessionId, task)
    void task.then(
      () => { if (this.inFlight.get(sessionId) === task) this.inFlight.delete(sessionId) },
      error => {
        if (this.failures.get(sessionId)?.kind !== 'persistence') this.failures.set(sessionId, { kind: 'scan', error })
        if (this.inFlight.get(sessionId) === task) this.inFlight.delete(sessionId)
      },
    )
    return task
  }

  /** Drain all work queued while waiting, then reject any latched recording failure. */
  async settled(sessionId: string): Promise<void> {
    let task: Promise<void> | undefined
    while ((task = this.inFlight.get(sessionId)) !== undefined) await task
    const failure = this.failures.get(sessionId)
    if (failure !== undefined) throw failure.error
  }

  private async runOnce(sessionId: string, turn: number | null, registry = this.registryFor(sessionId), current: (path: string) => boolean = () => true): Promise<void> {
    let failure: unknown
    let failed = false
    for (const [path, state] of [...registry]) {
      try {
        await this.checkOne(sessionId, turn, path, state, registry, current)
        const aggregate = [...registry.values()].reduce((sum, item) => sum + (item.lastKnown === null ? 0 : Buffer.byteLength(item.lastKnown, 'utf8')), 0)
        if (aggregate > MAX_AGGREGATE_BYTES) throw new Error('工具派发观察累计内容超过上限；回退依据已锁定。')
      } catch (error) {
        failure = error
        this.warnOnce(`scan:${sessionId}:${path}`, `[dsh-rollback] boundary re-check failed for ${path}: ${errorMessage(error)}`)
        break
      }
    }
    if (failure !== undefined) throw failure
  }

  /** Load sidecar paths plus independent rollback baselines. */
  prime(sessionId: string): void {
    try {
      const known = this.deps.knownContent(sessionId)
      const primed = new Map<string, TrackedFile>()
      for (const path of new Set([...this.deps.watchedPaths(sessionId), ...known.keys()])) {
        const entry = known.get(path)
        primed.set(path, { lastKnown: entry?.content ?? null, size: null, mtimeMs: null, missing: entry?.missing === true, lastSeenTurn: entry?.turn ?? null })
      }
      if (primed.size > MAX_PATHS) throw new Error(`边界观察路径数量超过上限 ${MAX_PATHS}；回退依据已锁定。`)
      let aggregate = 0
      for (const [path, state] of primed) {
        if (Buffer.byteLength(path, 'utf8') > MAX_PATH_BYTES) throw new Error(`边界观察路径过长：${path}`)
        if (state.lastKnown !== null) {
          const bytes = Buffer.byteLength(state.lastKnown, 'utf8')
          if (bytes > MAX_WATCHED_BYTES || (aggregate += bytes) > MAX_AGGREGATE_BYTES) throw new Error('边界观察累计内容超过上限；回退依据已锁定。')
        }
      }
      this.watched.set(sessionId, primed)
    } catch (error) {
      this.failures.set(sessionId, { kind: 'scan', error })
      throw error
    }
  }

  /** @deprecated Use resetAfterRollback with exact successful outcomes instead. */
  forget(sessionId: string): void {
    const registry = this.watched.get(sessionId)
    if (registry === undefined) return
    for (const [path, previous] of registry) {
      registry.set(path, {
        lastKnown: null, size: null, mtimeMs: null,
        missing: false, lastSeenTurn: previous.lastSeenTurn ?? null,
      })
    }
  }

  private registryFor(sessionId: string): Map<string, TrackedFile> {
    const existing = this.watched.get(sessionId)
    if (existing !== undefined) return existing
    const created = new Map<string, TrackedFile>()
    this.watched.set(sessionId, created)
    return created
  }

  private async checkOne(
    sessionId: string, turn: number | null, path: string, state: TrackedFile,
    registry: Map<string, TrackedFile>, current: (path: string) => boolean,
  ): Promise<void> {
    const hostPath = await this.deps.hostPathOf(sessionId, path)
    // An observation that raced a newer tool observation or rollback must not overwrite it.
    if (registry.get(path) !== state || !current(path)) return
    if (hostPath === undefined) {
      throw new Error(`Cannot resolve watched path ${path}; rollback coverage is unknown`)
    }
    const fingerprint = await statFingerprint(hostPath)
    if (registry.get(path) !== state || !current(path)) return
    if (fingerprint.kind === 'unknown') {
      throw new Error(`Could not observe ${path}; preserving rollback baseline (${fingerprint.reason})`)
    }
    if (fingerprint.kind === 'observed' && fingerprint.value.size > MAX_WATCHED_BYTES) {
      throw new Error(`Could not read ${path}: ${fingerprint.value.size} bytes exceeds the ${MAX_WATCHED_BYTES}-byte limit; preserving rollback baseline`)
    }
    const probe = fingerprint.kind === 'missing' ? fingerprint : await readObserved(hostPath)
    if (registry.get(path) !== state || !current(path)) return
    if (probe.kind === 'unknown') {
      throw new Error(`Could not read ${path}; preserving rollback baseline (${probe.reason})`)
    }
    if (probe.kind === 'observed' && fingerprint.kind === 'observed'
      && (probe.value.size !== fingerprint.value.size || probe.value.mtimeMs !== fingerprint.value.mtimeMs)) {
      throw new Error(`File changed while reading ${path}; rollback coverage is unknown`)
    }
    const observed = probe.kind === 'missing' ? null : probe.value
    if (turn === null) {
      registry.set(path, observed === null
        ? { ...state, lastKnown: null, size: null, mtimeMs: null, missing: true }
        : { ...state, lastKnown: observed.content, size: observed.size, mtimeMs: observed.mtimeMs, missing: false })
      return
    }
    const action = planBoundaryAction(state, observed)
    switch (action.kind) {
      case 'none':
        if (observed !== null) registry.set(path, {
          ...state, size: observed.size, mtimeMs: observed.mtimeMs,
          missing: false, lastSeenTurn: turn,
        })
        return
      case 'adopt':
        registry.set(path, {
          lastKnown: action.observed.content, size: action.observed.size,
          mtimeMs: action.observed.mtimeMs, missing: false, lastSeenTurn: turn,
        })
        return
      case 'created':
        this.record(sessionId, findingTurn(state.lastSeenTurn, turn), {
          path, operation: 'create', before: null, after: action.observed.content,
        })
        registry.set(path, {
          lastKnown: action.observed.content, size: action.observed.size,
          mtimeMs: action.observed.mtimeMs, missing: false, lastSeenTurn: turn,
        })
        return
      case 'changed':
        this.record(sessionId, findingTurn(state.lastSeenTurn, turn), {
          path, operation: 'update', before: action.before, after: action.after,
        })
        registry.set(path, {
          lastKnown: action.after, size: action.observed.size,
          mtimeMs: action.observed.mtimeMs, missing: false, lastSeenTurn: turn,
        })
        return
      case 'missing':
        this.record(sessionId, findingTurn(state.lastSeenTurn, turn), {
          path, operation: 'remove', before: action.before, after: null,
        })
        registry.set(path, { ...state, lastKnown: action.before, size: null, mtimeMs: null, missing: true })
        return
      case 'unrestorable':
        throw new Error(`${path} disappeared before the plugin read it; rollback cannot restore it`)
      case 'unknown':
        throw new Error(action.reason)
    }
  }

  private record(sessionId: string, turn: number, mutation: FsMutation): void {
    try { this.deps.record(sessionId, turn, mutation) } catch (error) {
      this.failures.set(sessionId, { kind: 'persistence', error })
      throw error
    }
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return
    this.warned.add(key)
    this.deps.warn(message)
  }
}

type Probe<T> = FileProbe<T>
type FailureKind = 'scan' | 'persistence'
interface LatchedFailure {
  kind: FailureKind
  error: unknown
}

/** Only ENOENT confirms absence; directories and every other errno remain unknown. */
async function statFingerprint(hostPath: string): Promise<Probe<{ size: number; mtimeMs: number }>> {
  try {
    const info = await lstat(hostPath)
    if (!info.isFile()) return { kind: 'unknown', reason: 'path is not a regular file' }
    return { kind: 'observed', value: { size: info.size, mtimeMs: info.mtimeMs } }
  } catch (error) {
    return failedProbe(error)
  }
}

async function readObserved(hostPath: string): Promise<Probe<ObservedFile>> {
  try {
    const before = await lstat(hostPath)
    if (!before.isFile()) return { kind: 'unknown', reason: 'path is not a regular file' }
    if (before.size > MAX_WATCHED_BYTES) return { kind: 'unknown', reason: 'file grew beyond the watched size limit' }
    const bytes = await readFile(hostPath)
    if (bytes.length > MAX_WATCHED_BYTES) return { kind: 'unknown', reason: 'file grew beyond the watched size limit' }
    // Node's utf8 decoder replaces malformed bytes. A rollback must never save
    // that lossy string as a complete preimage; BOM bytes must also be preserved.
    const content = bytes.toString('utf8')
    if (bytes.includes(0) || !Buffer.from(content, 'utf8').equals(bytes)) {
      return { kind: 'unknown', reason: 'file is binary or not lossless UTF-8 text' }
    }
    const after = await lstat(hostPath)
    if (!after.isFile()) return { kind: 'unknown', reason: 'path ceased to be a regular file while reading' }
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs || before.dev !== after.dev || before.ino !== after.ino
      || bytes.length !== after.size) {
      return { kind: 'unknown', reason: 'file changed while reading' }
    }
    return { kind: 'observed', value: { content, size: after.size, mtimeMs: after.mtimeMs } }
  } catch (error) {
    return failedProbe(error)
  }
}

function failedProbe(error: unknown): { kind: 'missing' } | { kind: 'unknown'; reason: string } {
  if (error !== null && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT') return { kind: 'missing' }
  return { kind: 'unknown', reason: errorMessage(error) }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
