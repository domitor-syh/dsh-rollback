/**
 * Pure checkpoint model for TRAE-style rollback. This module is deliberately
 * dependency-free (no `@deepseek-ai/*` imports) so the capture/planning logic
 * unit-tests without a DSH installation and stays browser-safe.
 *
 * @module @domitor-syh/dsh-rollback/core/model
 */

/** How a file entered the current turn's working set. */
export type ChangeKind = 'created' | 'updated' | 'removed'

/**
 * One file's net effect within a single turn.
 *
 * `before`/`after` mirror the filesystem seam's `FsWriteOutcome` /
 * `FsEditOutcome`: `before` is the content before the turn's FIRST mutation of
 * this path (null means the file did not exist), `after` is the content after
 * the turn's LAST mutation.
 */
export interface FileChange {
  /** Filesystem-seam display path. */
  readonly path: string
  /**
   * created = absent at turn start; updated = present and modified; removed =
   * the file the plugin was watching was GONE when it looked. The third case
   * cannot come from a file tool (none of them deletes), only from the boundary
   * re-scan noticing a shell command's work — and it is what separates
   * "put the old content back" from "bring the file back at all".
   */
  readonly kind: ChangeKind
  /** Content before the turn. `null` only for a `created` file. */
  readonly before: string | null
  /** Content after the turn's last mutation of this path. */
  readonly after: string
  /**
   * Whether the pre-turn content is known well enough to restore. A backend
   * that declines a contextual basis for an `updated` file (`before === null`
   * even though the file existed) drops this to false.
   */
  readonly basisKnown: boolean
}

/**
 * One turn's checkpoint. Established at `turn/start` (the tutorial's
 * "检查点建立在每轮对话发起前") and closed at `turn/end`.
 */
export interface TurnCheckpoint {
  /** 1-based turn number. */
  readonly turn: number
  /** First model-visible surface event seq of the turn, or null if none. */
  readonly startSeq: number | null
  /** Last model-visible surface event seq of the turn, or null if none. */
  readonly endSeq: number | null
  /** Net file changes, keyed by path. */
  readonly changes: Readonly<Record<string, FileChange>>
}

/** A turn checkpoint with no file changes and no surface events yet. */
export function emptyCheckpoint(turn: number): TurnCheckpoint {
  return { turn, startSeq: null, endSeq: null, changes: {} }
}

/** One fs write/edit outcome — or one boundary re-scan finding — feeding {@link recordChange}. */
export interface FsMutation {
  /** Filesystem-seam display path. */
  readonly path: string
  /**
   * `create`/`update` are the write tool's own operations (edits are `update`).
   * `remove` is not a tool operation at all: the boundary re-scan records it when
   * a file the plugin was watching is found GONE, which is the only way a
   * disappearance is ever observed.
   */
  readonly operation: 'create' | 'update' | 'remove'
  /** Pre-mutation content, or null when the file did not exist / no basis. */
  readonly before: string | null
  /** Post-mutation content. */
  readonly after: string
}