/**
 * Durable checkpoint store: persists each captured file mutation's full pre-turn
 * content so rollback can restore it ACROSS process restarts — the one piece the
 * session log itself cannot provide (the JSONL stores only 3-line diff hunks,
 * not whole files).
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

import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs'
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

function checkpointPath(): string {
  return join(homedir(), '.dsh', 'storages', 'dsh-rollback', 'checkpoints.jsonl')
}

/** Append one captured mutation to the sidecar (best-effort durability). */
export function appendCheckpoint(record: CheckpointRecord): void {
  try {
    const file = checkpointPath()
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, JSON.stringify(record) + '\n', 'utf8')
  } catch {
    /* a failed checkpoint write only degrades restore, never the session */
  }
}

/** Whether the durable store has already recorded this exact (turn, path). */
export function hasCheckpoint(sessionId: string, turn: number, path: string): boolean {
  if (!existsSync(checkpointPath())) return false
  try {
    const text = readFileSync(checkpointPath(), 'utf8')
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      let r: CheckpointRecord
      try { r = JSON.parse(line) } catch { continue }
      if (r.sessionId === sessionId && r.turn === turn && r.path === path) return true
    }
  } catch { /* treated as absent */ }
  return false
}

/**
 * Load every durable checkpoint for one session. The FIRST record per
 * (turn, path) is the turn's pre-content (later touches in the same turn only
 * advance the after-state, which restore does not need).
 */
export function loadCheckpoints(
  sessionId: string,
): Map<number, Map<string, { operation: 'create' | 'update'; before: string | null }>> {
  const out = new Map<number, Map<string, { operation: 'create' | 'update'; before: string | null }>>()
  if (!existsSync(checkpointPath())) return out
  try {
    const text = readFileSync(checkpointPath(), 'utf8')
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      let r: CheckpointRecord
      try { r = JSON.parse(line) } catch { continue }
      if (r.sessionId !== sessionId) continue
      let byPath = out.get(r.turn)
      if (byPath === undefined) { byPath = new Map(); out.set(r.turn, byPath) }
      if (!byPath.has(r.path)) byPath.set(r.path, { operation: r.operation, before: r.before })
    }
  } catch { /* treated as empty */ }
  return out
}