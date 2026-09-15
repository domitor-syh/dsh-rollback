/**
 * Rollback planning: from the retained per-turn checkpoints and a target
 * "roll back to before turn N", compute the files to restore/delete and the
 * conversation surface range to truncate.
 *
 * Pure and dependency-free.
 *
 * @module @domitor-syh/dsh-rollback/core/restore-plan
 */

import type { FileChange, TurnCheckpoint } from './model.ts'

/** One file the rollback must act on. */
export interface RestoredFile {
  readonly path: string
  /** `restore` rewrites the pre-turn content; `delete` removes a new file. */
  readonly action: 'restore' | 'delete'
  /** Pre-turn content when `action === 'restore'`, else null. */
  readonly content: string | null
  readonly kind: 'created' | 'updated'
}

/** A file the rollback cannot act on. */
export interface SkippedFile {
  readonly path: string
  /**
   * Why the rollback skipped it: `basis-unknown` when no pre-turn content was
   * recorded for the path (the plan is honest about it rather than restoring a
   * guess), or `io-error: <message>` when the filesystem refused the write.
   */
  readonly reason: 'basis-unknown' | `io-error: ${string}`
}

/** Inclusive surface seq range to truncate from derived model history. */
export interface TruncationRange {
  readonly start: number
  readonly end: number
}

/** The complete, deterministic rollback plan for one target turn. */
export interface RollbackPlan {
  /** Roll back every turn with `turn >= fromTurn`. */
  readonly fromTurn: number
  /** Files to restore/delete, in first-touch (ascending turn) order. */
  readonly restored: RestoredFile[]
  /** Files with a mutation but no trustworthy pre-turn basis. */
  readonly skipped: SkippedFile[]
  /** Surface range to truncate, or null when nothing to truncate. */
  readonly truncation: TruncationRange | null
}

/**
 * Compute a rollback plan.
 *
 * The "before" of a file touched across several turns is its content before
 * the FIRST touch in the window: restoring to any target turn only ever needs
 * that earliest original content, and a file created inside the window is
 * deleted outright.
 *
 * @param checkpoints - retained per-turn checkpoints, ascending by turn.
 * @param fromTurn - restore the state before this turn (removes it and later).
 * @param lastSurfaceSeq - current tail seq of the model-visible surface, or
 *   null when the surface is empty.
 */
export function planRollback(
  checkpoints: readonly TurnCheckpoint[],
  fromTurn: number,
  lastSurfaceSeq: number | null,
): RollbackPlan {
  const window = checkpoints.filter(cp => cp.turn >= fromTurn)
  window.sort((a, b) => a.turn - b.turn)

  // First touch across the window wins: its `before` is the restore content.
  const firstTouch = new Map<string, FileChange>()
  for (const cp of window) {
    for (const change of Object.values(cp.changes)) {
      if (!firstTouch.has(change.path)) firstTouch.set(change.path, change)
    }
  }

  const restored: RestoredFile[] = []
  const skipped: SkippedFile[] = []
  for (const change of firstTouch.values()) {
    if (change.kind === 'created') {
      restored.push({ path: change.path, action: 'delete', content: null, kind: 'created' })
    } else if (change.basisKnown && change.before !== null) {
      restored.push({ path: change.path, action: 'restore', content: change.before, kind: 'updated' })
    } else {
      skipped.push({ path: change.path, reason: 'basis-unknown' })
    }
  }

  const start = window.length > 0 ? window[0]!.startSeq : null
  const truncation = start !== null && lastSurfaceSeq !== null && lastSurfaceSeq >= start
    ? { start, end: lastSurfaceSeq }
    : null

  return { fromTurn, restored, skipped, truncation }
}