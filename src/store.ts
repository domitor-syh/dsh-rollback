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

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export interface CheckpointRecord {
  sessionId: string
  turn: number
  path: string
  operation: 'create' | 'update' | 'remove'
  /** File content BEFORE this turn's first touch; null only for a created file. */
  before: string | null
  /**
   * Content the touch left behind, when the plugin observed it.
   *
   * The boundary re-scan needs it: a file this plugin watched can be deleted or
   * rewritten by a shell command it never sees, and restoring that change requires
   * the last content the plugin ACTUALLY knew — which `before` cannot supply for a
   * file that was created here (`before` is null). Records written by earlier builds
   * omit it, which is why it is optional.
   */
  after?: string
}

export type CheckpointMap = Map<number, Map<string, { operation: 'create' | 'update' | 'remove'; before: string | null }>>

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

/** Structural validation for one line read back from the sidecar. */
function validRecord(value: unknown, sessionId: string): value is CheckpointRecord {
  if (value === null || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  return r.sessionId === sessionId
    && Number.isSafeInteger(r.turn)
    && typeof r.path === 'string'
    && (r.operation === 'create' || r.operation === 'update' || r.operation === 'remove')
    && (r.before === null || typeof r.before === 'string')
    && (r.after === undefined || typeof r.after === 'string')
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
 * Every structurally valid record in one session's sidecar, in file order.
 * @param sessionId - the session whose sidecar to read.
 * @returns the records, oldest first.
 */
function readRecords(sessionId: string): CheckpointRecord[] {
  const file = sessionFile(sessionId)
  if (!existsSync(file)) return []
  const rows: CheckpointRecord[] = []
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (line.trim() === '') continue
      try {
        const parsed: unknown = JSON.parse(line)
        if (validRecord(parsed, sessionId)) rows.push(parsed)
      } catch {
        /* corrupt lines are reported by the loader that compacts the file */
      }
    }
  } catch {
    /* unreadable file means nothing is known */
  }
  return rows
}

/**
 * Load every durable checkpoint for one session. The FIRST record per
 * (turn, path) is the turn's pre-content (later touches in the same turn only
 * advance the after-state, which restore does not need). Records older than the
 * retention window are pruned and the file is rewritten; corrupt lines are
 * skipped and reported.
 */
export function loadCheckpoints(sessionId: string, skipTurns?: ReadonlySet<number>): CheckpointMap {
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
  // A record of a turn a rollback already removed is dropped for the same reason and
  // at the same time: those turns' file changes were undone, so their paths must not
  // stay in the watch list (see `deadTurnsOf`).
  const dropped = (record: CheckpointRecord): boolean =>
    record.turn < cutoff || skipTurns?.has(record.turn) === true
  let pruned = 0
  for (const record of rows) {
    if (dropped(record)) { pruned += 1; continue }
    let byPath = out.get(record.turn)
    if (byPath === undefined) { byPath = new Map(); out.set(record.turn, byPath) }
    if (!byPath.has(record.path)) byPath.set(record.path, { operation: record.operation, before: record.before })
  }

  // Compact the file in place when we dropped anything, so it stays bounded and
  // self-healing. Best-effort: a rewrite failure keeps the in-memory result.
  if (corrupt > 0 || pruned > 0) {
    try {
      const kept = rows.filter(record => !dropped(record))
      writeFileSync(file, kept.map(record => JSON.stringify(record)).join('\n') + (kept.length > 0 ? '\n' : ''), 'utf8')
    } catch {
      /* leave the file untouched; future loads will retry */
    }
  }
  if (corrupt > 0) {
    console.warn(`[dsh-rollback] checkpoints: skipped ${corrupt} corrupt line(s) for session ${sessionId}`)
  }
  if (pruned > 0) {
    console.warn(`[dsh-rollback] checkpoints: dropped ${pruned} record(s) (stale or from rolled-back turns) for session ${sessionId}`)
  }
  return out
}
export function loadWatched(
  sessionId: string,
  skipTurns?: ReadonlySet<number>,
): Map<string, { content: string | null; turn: number | null }> {
  const watched = new Map<string, { content: string | null; turn: number | null }>()
  for (const row of readRecords(sessionId)) {
    if (skipTurns?.has(row.turn) === true) continue
    if (row.operation === 'remove') continue
    const previous = watched.get(row.path)
    if (previous !== undefined && previous.turn !== null && previous.turn > row.turn) continue
    const content = typeof row.after === 'string' && row.after !== '' ? row.after : null
    watched.set(row.path, { content, turn: row.turn })
  }
  return watched
}