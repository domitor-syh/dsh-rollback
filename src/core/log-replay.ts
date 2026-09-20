/**
 * What a log replay must ignore.
 *
 * The session log is append-only, so a rollback does not remove the turns it undid:
 * it appends a `user/message` carrying a surface `replace` over their range. Replaying
 * the raw log therefore walks straight through history the user already rolled back —
 * every one of those turns re-enters the checkpoint window, `/rollback list` offers
 * turns the transcript no longer shows, plans name files from rolled-back turns, and a
 * "created file" recorded there can make a later rollback DELETE a file the user has
 * since recreated. Measured on a real session: 25 turns in the log, 19 rollback
 * markers, and 18 of those turns sitting inside a replaced range.
 *
 * So a replay first collects the ranges some rollback replaced and then skips every
 * event inside them. Pure and DSH-free, because the rule deserves a test.
 *
 * @module @domitor-syh/dsh-rollback/core/log-replay
 */

/** One session event, structurally (only the fields this rule needs). */
export interface ReplayEvent {
  readonly type: string
  readonly seq: number
  readonly surfaceOp?: unknown
  readonly data?: unknown
}

/** An inclusive surface seq range some rollback replaced. */
export interface ReplacedRange {
  readonly start: number
  readonly end: number
}

/** This plugin's name in a marker's `source.plugin`. */
const ROLLBACK_PLUGIN = 'rollback'

/**
 * The surface ranges rollbacks replaced, from the log's own markers.
 *
 * Overlapping and nested markers are expected — rolling back twice over the same span
 * re-replaces it — so the ranges are returned as-is and membership is tested against
 * all of them.
 * @param events - the session log, in any order.
 * @returns the replaced ranges.
 */
export function replacedSurfaceRanges(events: readonly ReplayEvent[]): ReplacedRange[] {
  const ranges: ReplacedRange[] = []
  for (const event of events) {
    if (event.type !== 'user/message') continue
    const source = (event.data as { source?: { plugin?: unknown } } | undefined)?.source
    if (source?.plugin !== ROLLBACK_PLUGIN) continue
    const op = event.surfaceOp as { op?: unknown; start?: unknown; end?: unknown } | null | undefined
    if (op === null || op === undefined || op.op !== 'replace') continue
    if (typeof op.start !== 'number' || typeof op.end !== 'number') continue
    ranges.push({ start: op.start, end: op.end })
  }
  return ranges
}

/**
 * Whether an event's seq belongs to history a rollback already replaced.
 * @param seq - the event's seq.
 * @param ranges - the replaced ranges.
 * @returns true when the event must not be replayed.
 */
export function isReplacedSeq(seq: number, ranges: readonly ReplacedRange[]): boolean {
  return ranges.some(range => seq >= range.start && seq <= range.end)
}

/**
 * The turn numbers a rollback already removed.
 *
 * A turn whose `turn/start` sits inside a replaced range is gone: its history is not in
 * the model's context and, more importantly, its FILE changes were undone. Nothing
 * about it may be resurrected — not its checkpoints, and not its paths.
 *
 * That last part is why this exists. The boundary re-scan keeps re-checking the paths
 * the file tools once touched, and it learned about them from the durable sidecar,
 * which still holds records for turns a rollback removed. Watching those paths means
 * noticing that their files are missing — because the rollback correctly deleted them —
 * and recording that as a change of the CURRENT turn, so the next rollback "brings
 * back" files an earlier rollback had already removed. Measured on a real session: six
 * Desktop files deleted at turn 26 and again at turn 28 for exactly this reason, and
 * then restored by a later rollback.
 * @param events - the session log, in any order.
 * @returns the turn numbers that no longer exist.
 */
export function deadTurnsOf(events: readonly ReplayEvent[]): Set<number> {
  const ranges = replacedSurfaceRanges(events)
  const dead = new Set<number>()
  if (ranges.length === 0) return dead
  for (const event of events) {
    if (event.type !== 'turn/start') continue
    if (!isReplacedSeq(event.seq, ranges)) continue
    const turn = (event.data as { turn?: unknown } | undefined)?.turn
    if (typeof turn === 'number' && Number.isSafeInteger(turn)) dead.add(turn)
  }
  return dead
}