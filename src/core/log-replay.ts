/**
 * Pure replay helpers for rollback markers and dead turns.
 * @module @domitor-syh/dsh-rollback/core/log-replay
 */
import { isRollbackMarkerSource } from './truncation-plan.ts'

export interface ReplayEvent {
  readonly type: string
  readonly seq: number
  readonly surfaceOp?: unknown
  readonly data?: unknown
}

export interface ReplacedRange {
  readonly start: number
  readonly end: number
}

function replacedRangeOf(op: unknown): ReplacedRange | null {
  if (op === null || typeof op !== 'object') return null
  const candidate = op as { op?: unknown; startSeq?: unknown; endSeq?: unknown; start?: unknown; end?: unknown }
  if (candidate.op !== 'replace') return null
  const [start, end] = 'startSeq' in candidate
    ? [candidate.startSeq, candidate.endSeq]
    : [candidate.start, candidate.end]
  if (typeof start !== 'number' || typeof end !== 'number' || end < start) return null
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < 0) return null
  return { start, end }
}

export function replacedSurfaceRanges(events: readonly ReplayEvent[]): ReplacedRange[] {
  const ranges: ReplacedRange[] = []
  for (const event of events) {
    if (event.type !== 'user/message') continue
    const source = (event.data as { source?: unknown } | undefined)?.source
    if (!isRollbackMarkerSource(source)) continue
    const range = replacedRangeOf(event.surfaceOp)
    if (range !== null) ranges.push(range)
  }
  return ranges
}

export function isReplacedSeq(seq: number, ranges: readonly ReplacedRange[]): boolean {
  return ranges.some(range => seq >= range.start && seq <= range.end)
}

const SURFACE_TYPES = new Set(['system/message', 'user/message', 'assistant/message', 'tool/result'])
interface TurnSpan { turn: number; start: number; end: number | null; surfaceSeqs: number[]; sawSurface: boolean }

function isAppendSurface(event: ReplayEvent): boolean {
  return SURFACE_TYPES.has(event.type) && !isReplaceSurfaceOp(event.surfaceOp)
}

function isReplaceSurfaceOp(op: unknown): boolean {
  return op === 'replace' || (op !== null && typeof op === 'object' && (op as { op?: unknown }).op === 'replace')
}

function turnSpans(events: readonly ReplayEvent[]): TurnSpan[] {
  const ordered = [...events].sort((a, b) => a.seq - b.seq)
  const spans: TurnSpan[] = []
  for (const event of ordered) {
    if (event.type !== 'turn/start') continue
    const turn = (event.data as { turn?: unknown } | undefined)?.turn
    if (typeof turn !== 'number' || !Number.isSafeInteger(turn)) continue
    spans.push({ turn, start: event.seq, end: null, surfaceSeqs: [], sawSurface: false })
  }
  for (const span of spans) {
    const closing = ordered.find(event => event.type === 'turn/end'
      && (event.data as { turn?: unknown } | undefined)?.turn === span.turn
      && event.seq >= span.start)
    const next = spans.find(other => other.start > span.start)
    span.end = closing?.seq ?? (next === undefined ? null : next.start - 1)
  }
  for (const event of ordered) {
    if (!isAppendSurface(event)) continue
    let owner: TurnSpan | undefined
    for (const span of spans) {
      if (span.start <= event.seq && (owner === undefined || span.start > owner.start)) owner = span
    }
    if (owner === undefined || (owner.end !== null && event.seq > owner.end)) continue
    owner.sawSurface = true
    // The system prompt is protected and cannot alone make a turn dead.
    if (event.type !== 'system/message') owner.surfaceSeqs.push(event.seq)
  }
  return spans
}

/** Turns whose actual model-visible surface span intersects a replaced range. */
export function deadTurnsOf(events: readonly ReplayEvent[]): Set<number> {
  const ranges = replacedSurfaceRanges(events)
  const dead = new Set<number>()
  if (ranges.length === 0) return dead
  for (const span of turnSpans(events)) {
    if (span.surfaceSeqs.length > 0) {
      if (span.surfaceSeqs.some(seq => isReplacedSeq(seq, ranges))) dead.add(span.turn)
    } else if (!span.sawSurface && isReplacedSeq(span.start, ranges)) {
      // Sparse legacy logs have no surface positions; preserve the old fallback.
      dead.add(span.turn)
    }
  }
  return dead
}
