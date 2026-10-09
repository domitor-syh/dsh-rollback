/**
 * Rollback planning: from the retained per-turn checkpoints and a target
 * "roll back to before turn N", compute the files to restore/delete and the
 * conversation surface range to truncate.
 *
 * Pure and dependency-free.
 *
 * @module @domitor-syh/dsh-rollback/core/restore-plan
 */

import type { ChangeKind, FileChange, TurnCheckpoint } from './model.ts'

/** One file the rollback must act on. */
export interface RestoredFile {
  readonly path: string
  /** `restore` restores changed content; `recover` undoes conversation deletion;
   * `delete` undoes conversation creation. Live external state does not relabel these. */
  readonly action: 'restore' | 'recover' | 'delete'
  /** Earliest recorded preimage in the rollback window, or confirmed absence. */
  readonly content: string | null
  readonly kind: ChangeKind
  readonly conflict?: boolean
}

/** A file the rollback cannot act on. */
export interface SkippedFile {
  readonly path: string
  readonly reason: 'basis-unknown' | `io-error: ${string}`
}

/** Inclusive surface seq range to truncate from derived model history. */
export interface TruncationRange {
  readonly start: number
  readonly end: number
}

/** The complete, deterministic rollback plan for one target turn. */
export interface RollbackPlan {
  readonly fromTurn: number
  readonly restored: RestoredFile[]
  readonly skipped: SkippedFile[]
  readonly truncation: TruncationRange | null
}

/**
 * Compute a rollback plan from net conversation-derived state.
 *
 * For each path, the first mutation supplies the state immediately before the
 * rollback target, while the last mutation supplies the conversation-derived
 * state at the end of the rolled-back span. Intermediate operations are ignored
 * for listing and labels. Equal endpoint states are omitted.
 */
export function planRollback(
  checkpoints: readonly TurnCheckpoint[],
  fromTurn: number,
  lastSurfaceSeq: number | null,
): RollbackPlan {
  const window = checkpoints.filter(cp => cp.turn >= fromTurn)
  window.sort((a, b) => a.turn - b.turn)

  const net = new Map<string, { first: FileChange; after: string | null; afterKnown: boolean }>()
  for (const cp of window) {
    for (const change of Object.values(cp.changes)) {
      const existing = net.get(change.path)
      if (existing === undefined) net.set(change.path, { first: change, after: change.after, afterKnown: change.afterKnown !== false })
      else { existing.after = change.after; existing.afterKnown = change.afterKnown !== false }
    }
  }

  const restored: RestoredFile[] = []
  const skipped: SkippedFile[] = []
  for (const { first, after, afterKnown } of net.values()) {
    if (!first.basisKnown || (first.before === null && first.kind !== 'created')) {
      skipped.push({ path: first.path, reason: 'basis-unknown' })
      continue
    }
    if (afterKnown && first.before === after) continue

    if (first.before === null) {
      restored.push({ path: first.path, action: 'delete', content: null, kind: 'created' })
    } else if (afterKnown ? after === null : first.kind === 'removed') {
      restored.push({ path: first.path, action: 'recover', content: first.before, kind: 'removed' })
    } else {
      restored.push({ path: first.path, action: 'restore', content: first.before, kind: 'updated' })
    }
  }

  const start = window.length > 0 ? window[0]!.startSeq : null
  const truncation = start !== null && lastSurfaceSeq !== null && lastSurfaceSeq >= start
    ? { start, end: lastSurfaceSeq }
    : null

  return { fromTurn, restored, skipped, truncation }
}
