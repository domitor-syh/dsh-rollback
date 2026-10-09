/** Synchronous checkpoint storage with fsynced file appends and atomic compaction; no directory-fsync barrier is claimed. */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export interface CheckpointRecord {
  sessionId: string
  turn: number
  path: string
  operation: 'create' | 'update' | 'remove'
  before: string | null
  after?: string | null
  /** Proven no-op receipt, excluded from checkpoints and watched after-states. */
  unchanged?: true
  callId?: string
}
interface StoredRecord extends CheckpointRecord { _id?: string }
export type CheckpointMap = Map<number, Map<string, {
  operation: 'create' | 'update' | 'remove'
  before: string | null
  after?: string | null
}>>
export interface WatchedContent {
  content: string | null
  turn: number | null
  missing?: boolean
}
export interface RollbackBaseline { path: string; content: string | null }
interface StoredBaseline extends RollbackBaseline {
  /** Records already present at reset: pruning them must not invalidate this baseline. */
  checkpointKeys?: string[]
}
const KEEP_TURNS = 20
const MAX_PATH_BYTES = 16 * 1024
const MAX_CONTENT_BYTES = 8 * 1024 * 1024
const MAX_RECORD_BYTES = 16 * 1024 * 1024
const MAX_ROWS = 100_000
const MAX_BASELINE_ROWS = 512
const MAX_BASELINE_TOTAL = 64 * 1024 * 1024
function dshHome(): string { return process.env.DSH_HOME?.trim() || join(homedir(), '.dsh') }
function storageRoot(): string { return join(dshHome(), 'storages', 'dsh-rollback', 'checkpoints-v2') }
// UTF-16LE hex is injective for JS strings, lower-case on case-insensitive filesystems,
// and in a separate directory from legacy sanitized names (which may start with s-).
function encodedId(sessionId: string): string { return Buffer.from(sessionId, 'utf16le').toString('hex') }
function sessionFile(sessionId: string): string { return join(storageRoot(), 'sessions', `s-${encodedId(sessionId)}.jsonl`) }
function legacySessionFile(sessionId: string): string { return join(storageRoot(), `${sessionId.replace(/[\\/:*?"<>|]/g, '_')}.jsonl`) }
function baselineFile(sessionId: string): string { return join(dshHome(), 'storages', 'dsh-rollback', 'baselines-v1', `s-${encodedId(sessionId)}.json`) }
function isENOENT(error: unknown): boolean { return error !== null && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT' }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function readText(file: string): string | undefined {
  try { return readFileSync(file, 'utf8') } catch (error) {
    if (isENOENT(error)) return undefined
    throw new Error(`[dsh-rollback] unreadable durable store ${file}: ${errorMessage(error)}`)
  }
}
function validRecord(value: unknown, sessionId: string): value is StoredRecord {
  if (value === null || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  return r.sessionId === sessionId && Number.isSafeInteger(r.turn) && typeof r.path === 'string'
    && Buffer.byteLength(r.path, 'utf8') <= MAX_PATH_BYTES
    && (r.operation === 'create' || r.operation === 'update' || r.operation === 'remove')
    && (r.before === null || typeof r.before === 'string')
    && (r.after === undefined || r.after === null || typeof r.after === 'string')
    && (r.before === null || Buffer.byteLength(r.before, 'utf8') <= MAX_CONTENT_BYTES)
    && (r.after === undefined || r.after === null || Buffer.byteLength(r.after, 'utf8') <= MAX_CONTENT_BYTES)
    && (r._id === undefined || typeof r._id === 'string')
    && (r.unchanged === undefined || (r.unchanged === true && typeof r.callId === 'string'
      && r.callId.length > 0 && r.callId.length <= 1024 && r.operation === 'update' && r.before === r.after))
}
function recordKey(record: StoredRecord): string {
  return record._id ?? createHash('sha256').update(JSON.stringify([
    record.sessionId, record.turn, record.path, record.operation, record.before, record.after ?? null,
  ])).digest('hex')
}
function readRowsFrom(file: string, sessionId: string): { rows: StoredRecord[]; corrupt: number } {
  const text = readText(file)
  const rows: StoredRecord[] = []
  let corrupt = 0
  if (text === undefined) return { rows, corrupt }
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    if (Buffer.byteLength(line, 'utf8') > MAX_RECORD_BYTES || rows.length >= MAX_ROWS) { corrupt += 1; continue }
    let parsed: unknown
    try { parsed = JSON.parse(line) } catch { corrupt += 1; continue }
    // Legacy sanitized filenames can contain a different session: preserve but never replay it.
    if (parsed !== null && typeof parsed === 'object' && typeof (parsed as Record<string, unknown>).sessionId === 'string'
        && (parsed as Record<string, unknown>).sessionId !== sessionId) continue
    if (validRecord(parsed, sessionId)) rows.push(parsed)
    else corrupt += 1
  }
  return { rows, corrupt }
}
function readSession(sessionId: string, report?: (message: string) => void): { rows: StoredRecord[]; hasLegacy: boolean } {
  const legacy = readRowsFrom(legacySessionFile(sessionId), sessionId)
  const primary = readRowsFrom(sessionFile(sessionId), sessionId)
  const corrupt = legacy.corrupt + primary.corrupt
  if (corrupt > 0) {
    const message = `[dsh-rollback] checkpoints: ${corrupt} corrupt line(s) for session ${sessionId}; rollback replay refused and original sidecars retained`
    report?.(message)
    throw new Error(message)
  }
  const rows: StoredRecord[] = []
  const seenIds = new Set<string>()
  const legacyCopies = new Map<string, number>()
  // The compatibility hash used by baseline checkpointKeys is NOT a receipt
  // identity: A→B, B→A, A→B can legitimately repeat within one raw file.
  // Preserve each identityless occurrence. Only cancel matching occurrences
  // across legacy and primary files, where compaction copied legacy receipts.
  // Unlike recordKey, this fingerprint distinguishes missing after from null
  // and includes call/no-op metadata; existing baseline keys remain unchanged.
  const migrationKey = (record: StoredRecord): string => JSON.stringify([
    record.sessionId, record.turn, record.path, record.operation, record.before,
    record.after !== undefined, record.after ?? null, record.unchanged ?? false, record.callId ?? null,
  ])
  const push = (record: StoredRecord): void => {
    if (record._id !== undefined) {
      if (seenIds.has(record._id)) return
      seenIds.add(record._id)
    }
    rows.push(record)
  }
  // Legacy rows predate primary appends. Reversing this order loses the first before-state.
  for (const record of legacy.rows) {
    push(record)
    if (record._id === undefined) {
      const key = migrationKey(record)
      legacyCopies.set(key, (legacyCopies.get(key) ?? 0) + 1)
    }
  }
  for (const record of primary.rows) {
    if (record._id === undefined) {
      const key = migrationKey(record)
      const copies = legacyCopies.get(key) ?? 0
      if (copies > 0) { legacyCopies.set(key, copies - 1); continue }
    }
    push(record)
  }
  return { rows, hasLegacy: legacy.rows.length > 0 }
}
/** Flush file bytes before rename. No parent-directory fsync barrier is claimed on Windows. */
function writeAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${randomUUID()}.tmp`
  let fd: number | undefined
  try {
    fd = openSync(temp, 'wx')
    writeFileSync(fd, text, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temp, file)
  } finally {
    if (fd !== undefined) closeSync(fd)
    try { unlinkSync(temp) } catch { /* successfully renamed, or not created */ }
  }
}
/** Throw every write/flush failure so the Host can poison unsafe rollback readiness. */
export function appendCheckpoint(record: CheckpointRecord): void {
  const file = sessionFile(record.sessionId)
  mkdirSync(dirname(file), { recursive: true })
  const fd = openSync(file, 'a')
  try {
    writeFileSync(fd, JSON.stringify({ ...record, _id: randomUUID() }) + '\n', 'utf8')
    fsyncSync(fd)
  } finally { closeSync(fd) }
}
export function loadUnchangedCalls(sessionId: string): ReadonlySet<string> {
  return new Set(readSession(sessionId).rows.filter(row => row.unchanged).map(row => row.callId!))
}
export interface ObservedCheckpointReceipt {
  turn: number
  callId: string
  path: string
}
export function loadObservedReceipts(sessionId: string): readonly ObservedCheckpointReceipt[] {
  return readSession(sessionId).rows.flatMap(row => row.callId === undefined ? [] : [{ turn: row.turn, callId: row.callId, path: row.path }])
}
export interface CallCoverage {
  calls: ReadonlySet<string>
  legacyPaths: ReadonlySet<string>
  paths: ReadonlyMap<string, { calls: ReadonlySet<string>; legacyCount: number }>
}
export function loadCallCoverage(sessionId: string): Map<number, CallCoverage> {
  const coverage = new Map<number, { calls: Set<string>; legacyPaths: Set<string>; paths: Map<string, { calls: Set<string>; legacyCount: number }> }>()
  for (const row of readSession(sessionId).rows) {
    let turn = coverage.get(row.turn)
    if (turn === undefined) {
      turn = { calls: new Set(), legacyPaths: new Set(), paths: new Map() }
      coverage.set(row.turn, turn)
    }
    let path = turn.paths.get(row.path)
    if (path === undefined) { path = { calls: new Set(), legacyCount: 0 }; turn.paths.set(row.path, path) }
    if (row.callId !== undefined) { turn.calls.add(row.callId); path.calls.add(row.callId) }
    else if (!row.unchanged) { turn.legacyPaths.add(row.path); path.legacyCount += 1 }
  }
  return coverage
}
/** Exact direct-call receipts, including proven no-ops; never inferred from a turn/path match. */
export function loadObservedCalls(sessionId: string): ReadonlySet<string> {
  return new Set(readSession(sessionId).rows.map(row => row.callId).filter((id): id is string => typeof id === 'string' && id !== ''))
}

export function loadCheckpoints(sessionId: string, skipTurns?: ReadonlySet<number>, report?: (message: string) => void): CheckpointMap {
  const { rows, hasLegacy } = readSession(sessionId, report)
  const out: CheckpointMap = new Map()
  let maxTurn = 0
  for (const row of rows) maxTurn = Math.max(maxTurn, row.turn)
  const cutoff = maxTurn - KEEP_TURNS + 1
  const dropped = (row: CheckpointRecord): boolean => row.turn < cutoff || skipTurns?.has(row.turn) === true
  let pruned = 0
  for (const row of rows) {
    if (dropped(row)) { pruned += 1; continue }
    if (row.unchanged) continue
    let byPath = out.get(row.turn)
    if (byPath === undefined) { byPath = new Map(); out.set(row.turn, byPath) }
    // Legacy removals with an explicit empty placeholder represent absence.
    // Missing after remains unknown regardless of operation; normalize each raw
    // receipt before folding, since retained operation belongs to first touch.
    const after = row.operation === 'remove' && row.after !== undefined ? null : row.after
    const previous = byPath.get(row.path)
    if (previous === undefined) byPath.set(row.path, {
      operation: row.operation, before: row.before, ...(after !== undefined ? { after } : {}),
    })
    else {
      // The LAST receipt owns post-state knowledge. Missing legacy after-state
      // must not inherit an earlier known postimage and falsely prove net zero.
      const { after: _previousAfter, ...baseline } = previous
      byPath.set(row.path, { ...baseline, ...(after !== undefined ? { after } : {}) })
    }
  }
  if (pruned > 0 || hasLegacy) {
    const kept = rows.filter(row => !dropped(row))
    try { writeAtomic(sessionFile(sessionId), kept.map(row => JSON.stringify(row)).join('\n') + (kept.length > 0 ? '\n' : '')) }
    catch (error) {
      report?.(`[dsh-rollback] checkpoints: atomic compaction failed for session ${sessionId}; original sidecar retained (${errorMessage(error)})`)
      throw error
    }
  }
  if (pruned > 0) report?.(`[dsh-rollback] checkpoints: dropped ${pruned} record(s) (stale or from rolled-back turns) for session ${sessionId}`)
  return out
}
function readBaseline(sessionId: string): Map<string, StoredBaseline> {
  const result = new Map<string, StoredBaseline>()
  const text = readText(baselineFile(sessionId))
  if (text === undefined) return result
  const parsed: unknown = JSON.parse(text)
  if (!Array.isArray(parsed) || parsed.length > MAX_BASELINE_ROWS) throw new Error(`[dsh-rollback] corrupt rollback baseline for ${sessionId}`)
  let totalBytes = 0
  for (const value of parsed) {
    if (value === null || typeof value !== 'object') throw new Error(`[dsh-rollback] corrupt rollback baseline for ${sessionId}`)
    const row = value as Record<string, unknown>
    if (typeof row.path !== 'string' || Buffer.byteLength(row.path, 'utf8') > MAX_PATH_BYTES || (row.content !== null && typeof row.content !== 'string')
        || (typeof row.content === 'string' && (Buffer.byteLength(row.content, 'utf8') > MAX_CONTENT_BYTES || (totalBytes += Buffer.byteLength(row.content, 'utf8')) > MAX_BASELINE_TOTAL))
        || (row.checkpointKeys !== undefined && (!Array.isArray(row.checkpointKeys) || row.checkpointKeys.length > MAX_ROWS || row.checkpointKeys.some(key => typeof key !== 'string')))) {
      throw new Error(`[dsh-rollback] corrupt rollback baseline for ${sessionId}`)
    }
    result.set(row.path, { path: row.path, content: row.content as string | null, checkpointKeys: row.checkpointKeys as string[] | undefined })
  }
  return result
}
export function loadRollbackBaseline(sessionId: string): Map<string, RollbackBaseline> {
  return new Map([...readBaseline(sessionId)].map(([path, row]) => [path, { path, content: row.content }]))
}
/** Persist exact restored state separately from checkpoints and dead-turn filtering. */
export function saveRollbackBaseline(sessionId: string, outcomes: readonly RollbackBaseline[]): void {
  const merged = readBaseline(sessionId)
  const rows = readSession(sessionId).rows
  for (const outcome of outcomes) merged.set(outcome.path, {
    path: outcome.path, content: outcome.content,
    checkpointKeys: rows.filter(row => row.path === outcome.path).map(recordKey),
  })
  writeAtomic(baselineFile(sessionId), JSON.stringify([...merged.values()]) + '\n')
}
export function loadWatched(sessionId: string, skipTurns?: ReadonlySet<number>): Map<string, WatchedContent> {
  const watched = new Map<string, WatchedContent>()
  const rows = readSession(sessionId).rows
  const baselines = readBaseline(sessionId)
  const baselineKeys = new Map<string, Set<string> | undefined>()
  for (const baseline of baselines.values()) {
    baselineKeys.set(baseline.path, baseline.checkpointKeys === undefined ? undefined : new Set(baseline.checkpointKeys))
  }
  for (const row of rows) {
    if (row.unchanged || skipTurns?.has(row.turn) === true) continue
    const baseline = baselines.get(row.path)
    const keys = baselineKeys.get(row.path)
    // Old checkpoint generations cannot override restored state, even after compaction.
    if (baseline !== undefined && (keys === undefined || keys.has(recordKey(row)))) continue
    const previous = watched.get(row.path)
    if (previous !== undefined && previous.turn !== null && previous.turn > row.turn) continue
    if (row.operation === 'remove') {
      watched.set(row.path, { content: previous?.content ?? row.before, turn: row.turn, missing: true })
    } else {
      watched.set(row.path, { content: row.after !== undefined ? row.after : null, turn: row.turn, missing: false })
    }
  }
  for (const baseline of baselines.values()) if (!watched.has(baseline.path)) {
    watched.set(baseline.path, { content: baseline.content, turn: null, missing: baseline.content === null })
  }
  return watched
}
