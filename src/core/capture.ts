/**
 * Turn-checkpoint capture: fold an fs write/edit outcome into the current
 * turn's checkpoint. Pure and dependency-free.
 *
 * @module @domitor-syh/dsh-rollback/core/capture
 */

import type { ChangeKind, FileChange, FsMutation, TurnCheckpoint } from './model.ts'

/**
 * Apply a surface position to a checkpoint. Recorded once per turn: the first
 * surface event fixes `startSeq`, every surface event advances `endSeq`.
 * @param cp - the checkpoint to advance.
 * @param surfaceSeq - absolute seq of the surface event, or null if none.
 */
export function surfacePos(cp: TurnCheckpoint, surfaceSeq: number | null): TurnCheckpoint {
  if (surfaceSeq === null) return cp
  return {
    ...cp,
    startSeq: cp.startSeq === null ? surfaceSeq : cp.startSeq,
    endSeq: surfaceSeq,
  }
}

/**
 * Fold one fs mutation into the checkpoint. The FIRST mutation of a path
 * records its `before` (the pre-turn content); later mutations within the
 * same turn only advance `after`, so the checkpoint always restores to the
 * pre-turn state.
 */
export function recordChange(cp: TurnCheckpoint, mutation: FsMutation): TurnCheckpoint {
  const existing = cp.changes[mutation.path]
  if (existing === undefined) {
    const kind: ChangeKind = mutation.operation === 'create'
      ? 'created'
      : mutation.operation === 'remove' ? 'removed' : 'updated'
    const change: FileChange = {
      path: mutation.path,
      kind,
      before: mutation.before,
      after: mutation.after,
      basisKnown: mutation.before !== null || mutation.operation === 'create',
    }
    return { ...cp, changes: { ...cp.changes, [mutation.path]: change } }
  }
  // Keep the original `before`/`kind`/`basisKnown`; only the net `after` moves.
  const merged: FileChange = { ...existing, after: mutation.after }
  return { ...cp, changes: { ...cp.changes, [mutation.path]: merged } }
}