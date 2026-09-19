/**
 * Session fold: consume ordered lifecycle descriptors (turn boundaries +
 * surface positions + fs mutations) and maintain per-turn checkpoints in a
 * sliding window plus the current surface tail.
 *
 * Pure and dependency-free — the host plugin feeds it translated session
 * events, but the folding logic unit-tests in isolation.
 *
 * @module @domitor-syh/dsh-rollback/core/session-fold
 */

import { emptyCheckpoint, type FileChange, type FsMutation, type TurnCheckpoint } from './model.ts'
import { recordChange, surfacePos } from './capture.ts'
import { SlidingWindow } from './sliding-window.ts'

/** Ordered descriptor the fold consumes. */
export type FoldEvent =
  | { readonly kind: 'turn-start'; readonly turn: number; readonly seq: number }
  | { readonly kind: 'turn-end'; readonly turn: number; readonly seq: number }
  | { readonly kind: 'surface'; readonly seq: number }
  | { readonly kind: 'fs-mutation'; readonly mutation: FsMutation }

/**
 * Extract an {@link FsMutation} from a `write`/`edit` tool's canonical value,
 * or return null when the name/value pair is not a tracked mutation.
 *
 * `write` returns `{ path, operation, before, after }`; `edit` returns
 * `{ path, before, after }` (operation is implicitly `update`).
 */
export function fsMutationFrom(toolName: string, value: unknown): FsMutation | null {
  if (!['write', 'edit'].includes(toolName)) return null
  if (value === null || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v['path'] !== 'string') return null
  if (typeof v['after'] !== 'string') return null
  const before = v['before']
  if (before !== null && typeof before !== 'string') return null
  const operation = v['operation'] === 'create' ? 'create' : 'update'
  return { path: v['path'], operation, before, after: v['after'] }
}

/**
 * Maintains the retained per-turn checkpoints for one session.
 *
 * Checkpoints are pushed on `turn-end` (the tutorial's per-turn checkpoint
 * boundary) into a sliding window; the current in-flight turn is a pending
 * checkpoint the fold mutates as surface events and fs mutations arrive.
 */
export class SessionFold {
  private readonly checkpoints: SlidingWindow<TurnCheckpoint>
  private current: TurnCheckpoint | null = null
  private tail: number | null = null

  constructor(readonly capacity = 10) {
    this.checkpoints = new SlidingWindow<TurnCheckpoint>(capacity)
  }

  /** Feed one ordered descriptor. */
  fold(event: FoldEvent): void {
    switch (event.kind) {
      case 'turn-start': {
        this.closeCurrent()
        this.current = emptyCheckpoint(event.turn)
        break
      }
      case 'turn-end': {
        this.closeCurrent()
        break
      }
      case 'surface': {
        this.tail = event.seq
        if (this.current !== null) this.current = surfacePos(this.current, event.seq)
        break
      }
      case 'fs-mutation': {
        if (this.current !== null) this.current = recordChange(this.current, event.mutation)
        break
      }
    }
  }

  private closeCurrent(): void {
    const done = this.current
    this.current = null
    if (done === null) return
    // Skip turns with neither surface output nor file changes (empty/rejected).
    if (done.startSeq === null && Object.keys(done.changes).length === 0) return
    this.checkpoints.push(done)
  }

  /** The currently-open turn number, or null between turns. */
  inProgressTurn(): number | null {
    return this.current === null ? null : this.current.turn
  }

  /**
   * Record one fs mutation against a SPECIFIC turn, open or already closed.
   *
   * The boundary re-scan reads the filesystem asynchronously, so the turn it anchors
   * to can close while it waits — and folding then would drop the mutation, losing
   * exactly the change the re-scan exists to catch. A turn that already left the
   * retained window cannot take the change; the caller is told so.
   * @param turn - the turn the mutation belongs to.
   * @param mutation - the change to record.
   * @returns whether the mutation found a home.
   */
  mutationInto(turn: number, mutation: FsMutation): boolean {
    if (this.current !== null && this.current.turn === turn) {
      this.current = recordChange(this.current, mutation)
      return true
    }
    const retained = this.checkpoints.snapshot()
    const index = retained.findIndex(checkpoint => checkpoint.turn === turn)
    if (index === -1) return false
    const merged = recordChange(retained[index]!, mutation)
    const rebuilt = [...retained.slice(0, index), merged, ...retained.slice(index + 1)]
    this.checkpoints.clear()
    for (const checkpoint of rebuilt) this.checkpoints.push(checkpoint)
    return true
  }

  /** Retained checkpoints, oldest first (ascending turn). */
  snapshots(): readonly TurnCheckpoint[] {
    return this.checkpoints.snapshot()
  }

  /** Current tail seq of the model-visible surface, or null when empty. */
  surfaceTail(): number | null {
    return this.tail
  }

  /**
   * After a successful rollback to before `fromTurn`, drop every retained
   * checkpoint with `turn >= fromTurn` (their file changes have been undone)
   * while keeping earlier checkpoints intact.
   */
  dropFrom(fromTurn: number): void {
    this.replaceWindow(fromTurn, null)
  }

  /**
   * Drop the undone checkpoints EXCEPT the entries for paths that could not be undone.
   *
   * A rollback that had to skip a file — its pre-turn content was never recorded, or
   * the filesystem refused the write — still truncates the conversation and reports
   * the skip. If the records describing that file were dropped with everything else,
   * the file would leave rollback coverage for good. Keeping just those entries lets a
   * later rollback try again, which is the difference between "a file lock cost you
   * one restore" and "a file lock cost you the file".
   * @param fromTurn - the turn the rollback targeted.
   * @param keepPaths - paths whose changes were NOT undone.
   */
  dropFromExcept(fromTurn: number, keepPaths: ReadonlySet<string>): void {
    this.replaceWindow(fromTurn, keepPaths)
  }

  /** Rebuild the retained window, optionally keeping only the named paths' changes. */
  private replaceWindow(fromTurn: number, keepPaths: ReadonlySet<string> | null): void {
    const kept: TurnCheckpoint[] = []
    for (const checkpoint of this.checkpoints.snapshot()) {
      if (checkpoint.turn < fromTurn) {
        kept.push(checkpoint)
        continue
      }
      if (keepPaths === null) continue
      const changes: Record<string, FileChange> = {}
      for (const [path, change] of Object.entries(checkpoint.changes)) {
        if (keepPaths.has(path)) changes[path] = change
      }
      if (Object.keys(changes).length > 0) kept.push({ ...checkpoint, changes })
    }
    this.checkpoints.clear()
    for (const checkpoint of kept) this.checkpoints.push(checkpoint)
    this.current = null
  }

  /** Repoint the surface tail (the truncation replace rewrites the tail). */
  setTail(seq: number | null): void {
    this.tail = seq
  }

  /** Drop retained state (HMR / session disposal safety). */
  clear(): void {
    this.current = null
    this.tail = null
    this.checkpoints.clear()
  }
}