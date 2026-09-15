/**
 * Durable checkpoint store: persists each captured file mutation's full pre-turn
 * content so rollback can restore it ACROSS process restarts — the one piece the
 * session log itself cannot provide (the JSONL stores only 3-line diff hunks,
 * not whole files).
 *
 * Layout (v2): one JSONL file per session under
 * `$DSH_HOME/storages/dsh-rollback/checkpoints-v2/<sessionId>.jsonl`
 * (falls back to `~/.dsh`). Per-session files replace the former single global
 * `checkpoints.jsonl` so reading one session no longer scans every session's
 * history, and the version lives in the directory name.
 *
 * Retention: each load prunes records older than `KEEP_TURNS` turns back (a
 * margin above the 10-turn rollback window) and rewrites the file, so the
 * sidecar stays bounded instead of growing without limit. Corrupt or
 * malformed lines are skipped, counted, and reported, rather than being
 * silently absorbed.
 *
 * This is a plugin-owned sidecar under the DSH home, completely separate from
 * the session logs: a broken/missing sidecar can only degrade rollback to
 * "skip that file", never affect DSH session loading.
 *
 * All reads/writes are synchronous on purpose: `loadCheckpoints` must be atomic
 * with the seed replay (no async race with live events), and `append` must be
 * on-disk before the process can exit. One small line write per file mutation.
 *
 * @module @domitor-syh/dsh-rollback/store
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export interface CheckpointRecord {
  sessionId: string
  turn: number
  path: string
  operation: 'create' | 'update'
  /** File content BEFORE this turn's first touch; null only for a created file. */
  before: string | null
}

/**
 * A rollback whose file restore already ran but whose conversation truncation is
 * still pending. DSH accepts a surface replacement outside an open step only as a
 * `user/message` (compaction's checkpoint shape), and a rollback command runs
 * between turns, so the replacement is appended at the next `agent/pre-step` —
 * before that turn's request is derived. Persisted so a restart between the
 * rollback and the next prompt still truncates.
 */
export interface PendingTruncation {
  sessionId: string
  /** Turn the rollback targeted: everything from this turn onward is shadowed. */
  fromTurn: number
  /**
   * Shadowed surface range captured when the rollback ran. Absent only on records
   * written by builds before the range was captured; the applier then derives the
   * range from `fromTurn`, which is safe because it runs before the next turn's
   * prompt is appended.
   */
  shadowedFirst?: number
  /** Last shadowed surface seq captured when the rollback ran. */
  shadowedLast?: number
  restoredCount: number
  deletedCount: number
  /** Epoch ms the rollback executed (diagnostics only). */
  at: number
}

export type CheckpointMap = Map<number, Map<string, { operation: 'create' | 'update'; before: string | null }>>

/** Sidecar layout version, encoded in the storage directory name. */
const FORMAT_VERSION = 2
/**
 * Per-session retention, a superset of the 10-turn rollback window. The fold
 * only ever asks for recent turns' checkpoints, so older records are pruned on
 * load to keep the sidecar bounded.
 */
const KEEP_TURNS = 20

/** DSH home, honoring an explicit override (the `$DSH_HOME` convention). */
function dshHome(): string {
  const override = process.env.DSH_HOME?.trim()
  return override !== undefined && override !== '' ? override : join(homedir(), '.dsh')
}

function storageRoot(): string {
  return join(dshHome(), 'storages', 'dsh-rollback', `checkpoints-v${FORMAT_VERSION}`)
}

/** Per-session file, with a defensive strip of filesystem-hostile characters. */
function sessionFile(sessionId: string): string {
  const safe = sessionId.replace(/[\\/:*?"<>|]/g, '_')
  return join(storageRoot(), `${safe}.jsonl`)
}

/** Per-session pending-truncation file (one JSON object, overwritten in place). */
function pendingFile(sessionId: string): string {
  const safe = sessionId.replace(/[\\/:*?"<>|]/g, '_')
  return join(dshHome(), 'storages', 'dsh-rollback', `pending-v${FORMAT_VERSION}`, `${safe}.json`)
}

/** Structural validation for one pending truncation read back from the sidecar. */
function validPending(value: unknown, sessionId: string): value is PendingTruncation {
  if (value === null || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  const bounded = Number.isSafeInteger(r.shadowedFirst) && Number.isSafeInteger(r.shadowedLast)
    && (r.shadowedFirst as number) <= (r.shadowedLast as number)
  const unbounded = r.shadowedFirst === undefined && r.shadowedLast === undefined
  return r.sessionId === sessionId
    && Number.isSafeInteger(r.fromTurn)
    && (r.fromTurn as number) >= 1
    && (bounded || unbounded)
    && Number.isSafeInteger(r.restoredCount)
    && Number.isSafeInteger(r.deletedCount)
    && Number.isSafeInteger(r.at)
}

/**
 * Record a pending conversation truncation (best-effort durability): the
 * rollback's file changes are already on disk, so losing this record would let
 * the model see a range the user rolled back.
 */
export function savePendingTruncation(record: PendingTruncation): void {
  try {
    const file = pendingFile(record.sessionId)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(record) + '\n', 'utf8')
  } catch {
    /* memory state still carries it for this process */
  }
}

/** Load one session's pending truncation, or null when none is recorded. */
export function loadPendingTruncation(sessionId: string): PendingTruncation | null {
  const file = pendingFile(sessionId)
  if (!existsSync(file)) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (validPending(parsed, sessionId)) return parsed
    console.warn(`[dsh-rollback] pending truncation for session ${sessionId} is malformed; ignoring it`)
  } catch {
    console.warn(`[dsh-rollback] pending truncation for session ${sessionId} is unreadable; ignoring it`)
  }
  return null
}

/** Drop one session's pending truncation once the marker has been appended. */
export function clearPendingTruncation(sessionId: string): void {
  try {
    unlinkSync(pendingFile(sessionId))
  } catch {
    /* absent is the desired end state */
  }
}

/** Structural validation for one line read back from the sidecar. */
function validRecord(value: unknown, sessionId: string): value is CheckpointRecord {
  if (value === null || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  return r.sessionId === sessionId
    && Number.isSafeInteger(r.turn)
    && typeof r.path === 'string'
    && (r.operation === 'create' || r.operation === 'update')
    && (r.before === null || typeof r.before === 'string')
}

/** Append one captured mutation to the store (best-effort durability). */
export function appendCheckpoint(record: CheckpointRecord): void {
  try {
    const file = sessionFile(record.sessionId)
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, JSON.stringify(record) + '\n', 'utf8')
  } catch {
    /* a failed checkpoint write only degrades restore, never the session */
  }
}

/**
 * Load every durable checkpoint for one session. The FIRST record per
 * (turn, path) is the turn's pre-content (later touches in the same turn only
 * advance the after-state, which restore does not need). Records older than the
 * retention window are pruned and the file is rewritten; corrupt lines are
 * skipped and reported.
 */
export function loadCheckpoints(sessionId: string): CheckpointMap {
  const file = sessionFile(sessionId)
  const out: CheckpointMap = new Map()
  if (!existsSync(file)) return out

  const rows: CheckpointRecord[] = []
  let corrupt = 0
  let maxTurn = 0
  try {
    const text = readFileSync(file, 'utf8')
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      let parsed: unknown
      try { parsed = JSON.parse(line) } catch { corrupt += 1; continue }
      if (!validRecord(parsed, sessionId)) { corrupt += 1; continue }
      rows.push(parsed)
      if (parsed.turn > maxTurn) maxTurn = parsed.turn
    }
  } catch {
    /* unreadable file is treated as empty */
  }

  const cutoff = maxTurn - KEEP_TURNS + 1
  let pruned = 0
  for (const record of rows) {
    if (record.turn < cutoff) { pruned += 1; continue }
    let byPath = out.get(record.turn)
    if (byPath === undefined) { byPath = new Map(); out.set(record.turn, byPath) }
    if (!byPath.has(record.path)) byPath.set(record.path, { operation: record.operation, before: record.before })
  }

  // Compact the file in place when we dropped anything, so it stays bounded and
  // self-healing. Best-effort: a rewrite failure keeps the in-memory result.
  if (corrupt > 0 || pruned > 0) {
    try {
      const kept = rows.filter(record => record.turn >= cutoff)
      writeFileSync(file, kept.map(record => JSON.stringify(record)).join('\n') + (kept.length > 0 ? '\n' : ''), 'utf8')
    } catch {
      /* leave the file untouched; future loads will retry */
    }
  }
  if (corrupt > 0) {
    console.warn(`[dsh-rollback] checkpoints: skipped ${corrupt} corrupt line(s) for session ${sessionId}`)
  }
  if (pruned > 0) {
    console.warn(`[dsh-rollback] checkpoints: pruned ${pruned} stale record(s) for session ${sessionId}`)
  }
  return out
}