/**
 * Boundary re-scan decisions: what to record when the plugin re-checks a file it
 * has already watched.
 *
 * Capture only ever sees the file tools. A shell command that rewrites or removes
 * one of their files is invisible at the moment it happens, so the plugin re-checks
 * the paths it knows about at every user-message boundary — the interval the user
 * actually thinks in — and records whatever changed, anchored at that boundary.
 * Rolling back to before the boundary then restores the file to the state it had
 * when the user last spoke.
 *
 * The last known content is what makes that possible, and its absence is why one
 * case is deliberately left alone: a file that vanished before the plugin ever read
 * it cannot be put back, and recording it anyway would be worse than useless —
 * restore reports such a path as skipped, and any skipped file aborts the whole
 * rollback. So the decision is "notice it, say so, record nothing".
 *
 * Pure and DSH-free.
 *
 * @module @domitor-syh/dsh-rollback/core/boundary-scan
 */

/** What the plugin knows about one watched file. */
export interface TrackedFile {
  /** Content the plugin last observed, or null when it never has. */
  readonly lastKnown: string | null
  /** Size at the last observation, when known. */
  readonly size: number | null
  /** Modification time at the last observation in epoch ms, when known. */
  readonly mtimeMs: number | null
  /** Whether the previous check already found the file absent. */
  readonly missing: boolean
}

/** One file's observed state, or null when it does not exist. */
export interface ObservedFile {
  readonly content: string
  readonly size: number
  readonly mtimeMs: number
}

/** What a re-check found the file's state to be. */
export type BoundaryAction =
  /** Nothing to record. */
  | { readonly kind: 'none' }
  /** First time the plugin has content for this file: learn it, record nothing. */
  | { readonly kind: 'adopt'; readonly observed: ObservedFile }
  /** The file vanished: record the content to put back. */
  | { readonly kind: 'missing'; readonly before: string }
  /** The file's content is not what the plugin last saw: record the swap. */
  | { readonly kind: 'changed'; readonly before: string; readonly after: string; readonly observed: ObservedFile }
  /** The file vanished, but its content was never observed: nothing can be restored. */
  | { readonly kind: 'unrestorable' }

/**
 * Whether a stat fingerprint alone proves the file is untouched since the last look.
 *
 * The fast path that keeps this scan cheap: a boundary re-checks every watched file,
 * and almost all of them are unchanged, so only a changed size or mtime earns a read.
 * @param tracked - what the plugin recorded at the last look.
 * @param size - current size in bytes.
 * @param mtimeMs - current modification time in epoch ms.
 * @returns whether the file can be skipped without reading it.
 */
export function unchangedByStat(tracked: TrackedFile, size: number, mtimeMs: number): boolean {
  return !tracked.missing && tracked.size === size && tracked.mtimeMs === mtimeMs
}

/**
 * Decide what a re-check found.
 * @param tracked - what the plugin recorded at the last look.
 * @param observed - the file's current state, or null when it is absent.
 * @returns the action to take.
 */
export function planBoundaryAction(tracked: TrackedFile, observed: ObservedFile | null): BoundaryAction {
  if (observed === null) {
    // Already recorded at an earlier boundary: re-recording it every turn would add
    // a record per turn for a state that has not changed.
    if (tracked.missing) return { kind: 'none' }
    if (tracked.lastKnown === null) return { kind: 'unrestorable' }
    return { kind: 'missing', before: tracked.lastKnown }
  }
  if (tracked.missing || tracked.lastKnown === null) return { kind: 'adopt', observed }
  if (observed.content === tracked.lastKnown) return { kind: 'none' }
  return { kind: 'changed', before: tracked.lastKnown, after: observed.content, observed }
}