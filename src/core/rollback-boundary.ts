/**
 * Session-bound bounded rollback protocol shared by Host and Client.
 * Revoked turns and inclusive ranges come from durable replay; future turns remain visible.
 * Historical numeric-boundary APIs remain for compatibility, not Client hide decisions.
 */

import { isRollbackMarkerSource } from './truncation-plan.ts'
import { deadTurnsOf, replacedSurfaceRanges } from './log-replay.ts'

/** One log event, narrowed to the fields this module reads. */
export interface BoundaryEvent {
  readonly type?: unknown
  readonly seq?: unknown
  readonly data?: unknown
  readonly surfaceOp?: unknown
}

/**
 * The seq a `replace` op starts at, under either spelling this plugin has met.
 *
 * The installed framework renamed the op's ends to `startSeq`/`endSeq`; logs written by
 * older builds carry `start`/`end`. Reading both is what keeps an old session's rollback
 * recognizable instead of silently unbounded.
 * @param op - the event's `surfaceOp`.
 * @returns the start seq, or null when this is not a replace op this build understands.
 */
export function opStartSeq(op: unknown): number | null {
  if (op === null || typeof op !== 'object') return null
  const record = op as Record<string, unknown>
  if (record['op'] !== 'replace') return null
  for (const key of ['startSeq', 'start']) {
    const value = record[key]
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  }
  return null
}

/**
 * The turn whose span holds one seq: the last `turn/start` at or before it.
 *
 * The LAST match wins, for the same reason `turnStartSeqFor` takes the last one — a
 * session damaged by an older build can hold a synthetic marker turn and the real turn
 * under one number, and the real turn is the later of the two.
 * @param events - the log, oldest first.
 * @param seq - the seq to place.
 * @returns the turn number, or null when no `turn/start` precedes that seq.
 */
function turnAtSeq(events: readonly BoundaryEvent[], seq: number): number | null {
  let turn: number | null = null
  let at: number | null = null
  for (const event of events) {
    if (event?.type !== 'turn/start') continue
    const eventSeq = event.seq
    const value = (event.data as { turn?: unknown } | undefined)?.turn
    if (typeof eventSeq !== 'number' || !Number.isSafeInteger(eventSeq)) continue
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) continue
    if (eventSeq <= seq && (at === null || eventSeq >= at)) {
      at = eventSeq
      turn = value
    }
  }
  return turn
}

/**
 * The earliest turn a STANDING rollback took out, or null when none stands.
 *
 * Standing is decided by the surface, not by the log: a marker a later marker replaced is
 * gone from the model-visible surface, and its window with it (that is the whole of the
 * degenerate-rollback defect — `[60,60]`, `[75,75]`, `[93,93]`), so only markers still
 * present as surface nodes count. The boundary is the MINIMUM of their turns: rolling back
 * turn 5 and then turn 2 takes out everything from turn 2 on, and hiding from turn 5 would
 * leave turn 2's rows standing.
 * @param events - the session log, oldest first.
 * @param live - the seqs of the current model-visible surface.
 * @returns the earliest rolled-back turn, or null when no rollback stands.
 */
export function rollbackBoundaryTurn(events: readonly BoundaryEvent[], live: ReadonlySet<number>): number | null {
  let boundary: number | null = null
  for (const event of events) {
    if (!isRollbackMarkerSource((event?.data as { source?: unknown } | undefined)?.source)) continue
    const seq = event.seq
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || !live.has(seq)) continue
    const start = opStartSeq(event.surfaceOp)
    if (start === null) continue
    const turn = turnAtSeq(events, start)
    if (turn === null) continue
    if (boundary === null || turn < boundary) boundary = turn
  }
  return boundary
}

/** The token that opens the machine-readable boundary line. */
const BOUNDARY_TOKEN = '边界'

/**
 * The boundary as one command line's worth of text.
 *
 * `无` is spelled explicitly rather than left out: "no rollback stands" and "this build
 * cannot say" are different answers, and a client that confused them would either hide
 * nothing forever or hide on a guess. The client reads the difference through
 * {@link parseBoundaryLine}, exactly as the turn list already does.
 * @param turn - the boundary turn, or null when no rollback stands.
 * @returns the line.
 */
export function boundaryLine(turn: number | null): string {
  return turn === null ? `${BOUNDARY_TOKEN} 无` : `${BOUNDARY_TOKEN} ${turn}`
}

/**
 * Read a boundary line, three ways.
 *
 * Only the FIRST token after {@link BOUNDARY_TOKEN} counts: the line may travel with other
 * text (a usage hint, a wrapper), and a number further along would be a different fact.
 * @param text - the command's output, as the client received it.
 * @returns the boundary turn; null for an explicit "none"; undefined when the text is not
 * a boundary line at all — which is "unknown", not "nothing was rolled back".
 */
export function parseBoundaryLine(text: string | undefined | null): number | null | undefined {
  if (typeof text !== 'string') return undefined
  const at = text.indexOf(BOUNDARY_TOKEN)
  if (at === -1) return undefined
  const rest = text.slice(at + BOUNDARY_TOKEN.length).trim()
  if (rest.startsWith('无')) return null
  const match = /^(\d+)/.exec(rest)
  if (match === null) return undefined
  const turn = Number(match[1])
  return Number.isSafeInteger(turn) && turn >= 1 ? turn : undefined
}

/** Finite revoked identity data bound to one session and host state version. */
export interface RollbackState {
  readonly sessionId: string
  readonly version: number
  readonly turns: readonly number[]
  readonly ranges: readonly { start: number; end: number }[]
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** Compute exactly the turns and inclusive seq ranges declared revoked in the log. */
export function createRollbackState(sessionId: string, version: number, events: readonly BoundaryEvent[]): RollbackState {
  const replay = events.map(event => ({
    type: typeof event.type === 'string' ? event.type : '',
    seq: nonnegativeInteger(event.seq) ? event.seq : -1,
    data: event.data,
    surfaceOp: event.surfaceOp,
  }))
  return {
    sessionId,
    version,
    turns: [...deadTurnsOf(replay)].filter(turn => nonnegativeInteger(turn) && turn >= 1).sort((a, b) => a - b),
    ranges: replacedSurfaceRanges(replay).filter(range => range.start <= range.end).map(range => ({ ...range })),
  }
}

/** Serialize the session-bound machine-readable protocol. */
export function stateLine(state: RollbackState): string {
  return '状态 ' + JSON.stringify(state)
}

/** Invalid or legacy boundary-only responses are unknown, never permission to hide. */
export function parseStateLine(text: string | undefined | null): RollbackState | undefined {
  if (typeof text !== 'string') return undefined
  const line = text.split(/\r?\n/).find(line => /^\s*状态\s+/.test(line))
  if (line === undefined) return undefined
  let value: unknown
  try { value = JSON.parse(line.replace(/^\s*状态\s+/, '')) } catch { return undefined }
  if (value === null || typeof value !== 'object') return undefined
  const state = value as Record<string, unknown>
  if (typeof state.sessionId !== 'string' || state.sessionId === '' || !nonnegativeInteger(state.version)) return undefined
  if (!Array.isArray(state.turns) || !Array.isArray(state.ranges)) return undefined
  if (!state.turns.every(turn => nonnegativeInteger(turn) && turn >= 1)) return undefined
  if (new Set(state.turns).size !== state.turns.length) return undefined
  const ranges: { start: number; end: number }[] = []
  for (const item of state.ranges) {
    if (item === null || typeof item !== 'object') return undefined
    const range = item as Record<string, unknown>
    if (!nonnegativeInteger(range.start) || !nonnegativeInteger(range.end) || range.start > range.end) return undefined
    ranges.push({ start: range.start, end: range.end })
  }
  return { sessionId: state.sessionId, version: state.version, turns: state.turns, ranges }
}
