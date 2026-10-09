import { describe, expect, it } from 'vitest'
import {
  boundaryLine,
  createRollbackState,
  stateLine,
  parseStateLine,
  opStartSeq,
  parseBoundaryLine,
  rollbackBoundaryTurn,
  type BoundaryEvent,
} from '../src/core/rollback-boundary.ts'

/**
 * A log with `turns` turns, each opened by `turn/start` and holding one user message, plus
 * optional rollback markers. Seqs are array indices, as everywhere in this suite.
 */
function log(turns: number, markers: readonly { at: number; start: number | string; kind?: string }[] = []): BoundaryEvent[] {
  const events: BoundaryEvent[] = []
  for (let turn = 1; turn <= turns; turn++) {
    events.push({ type: 'turn/start', seq: events.length, data: { turn } })
    events.push({ type: 'user/message', seq: events.length, data: { turn } })
  }
  for (const marker of markers) {
    while (events.length < marker.at) events.push({ type: 'user/message', seq: events.length, data: {} })
    events.push({
      type: 'user/message',
      seq: events.length,
      data: { source: { kind: marker.kind ?? 'plugin:rollback' } },
      surfaceOp: typeof marker.start === 'number'
        ? { op: 'replace', startSeq: marker.start, endSeq: marker.start }
        : { op: 'replace', start: marker.start, end: marker.start },
    })
  }
  return events
}

/** Every seq in a log, standing — the surface the tests start from. */
function allLive(events: readonly BoundaryEvent[]): Set<number> {
  return new Set(events.map((event, index) => (typeof event.seq === 'number' ? event.seq : index)))
}

describe('opStartSeq', () => {
  it('reads both spellings and refuses everything else', () => {
    expect(opStartSeq({ op: 'replace', startSeq: 7, endSeq: 9 })).toBe(7)
    expect(opStartSeq({ op: 'replace', start: 7, end: 9 })).toBe(7)
    expect(opStartSeq({ op: 'append' })).toBeNull()
    expect(opStartSeq(undefined)).toBeNull()
    expect(opStartSeq('replace')).toBeNull()
    expect(opStartSeq({ op: 'replace', startSeq: -1 })).toBeNull()
    expect(opStartSeq({ op: 'replace', startSeq: 1.5 })).toBeNull()
  })
})

describe('rollbackBoundaryTurn', () => {
  it('places the boundary at the turn that holds the shadowed range', () => {
    // Turn 1 = seqs 0-1, turn 2 = seqs 2-3, turn 3 = seqs 4-5; the marker sits at seq 6
    // and its range starts inside turn 2 (seq 2).
    const events = log(3, [{ at: 6, start: 2 }])
    expect(rollbackBoundaryTurn(events, allLive(events))).toBe(2)
  })

  it('takes the EARLIEST standing rollback, not the latest', () => {
    // Roll back turn 3, then turn 1: everything from turn 1 on is gone.
    const events = log(3, [{ at: 6, start: 4 }, { at: 7, start: 0 }])
    expect(rollbackBoundaryTurn(events, allLive(events))).toBe(1)
  })

  it('ignores a marker a later marker replaced', () => {
    // The classic degenerate sequence: each marker replaces the one before it, so only
    // the last still stands — and it is the later rollback that defines the boundary.
    const events = log(3, [{ at: 6, start: 0 }, { at: 7, start: 4 }])
    const live = new Set([0, 1, 2, 3, 7])
    expect(rollbackBoundaryTurn(events, live)).toBe(3)
  })

  it('says nothing when no rollback stands', () => {
    const events = log(3)
    expect(rollbackBoundaryTurn(events, allLive(events))).toBeNull()
    // A marker whose seq is not a surface node is not standing either.
    const withMarker = log(3, [{ at: 6, start: 0 }])
    expect(rollbackBoundaryTurn(withMarker, new Set([0, 1, 2, 3, 4, 5]))).toBeNull()
  })

  it('ignores another producer, an append, and a range with no turn before it', () => {
    const foreign = log(3, [{ at: 6, start: 2, kind: 'plugin:something-else' }])
    expect(rollbackBoundaryTurn(foreign, allLive(foreign))).toBeNull()

    const append: BoundaryEvent[] = log(3)
    append.push({ type: 'user/message', seq: append.length, data: { source: { kind: 'plugin:rollback' } }, surfaceOp: 'append' })
    expect(rollbackBoundaryTurn(append, allLive(append))).toBeNull()

    // A range starting before the first turn cannot name a turn: the honest answer is
    // "unknown", and a client that guessed would hide a transcript it cannot justify.
    const early = log(2)
    early.unshift({ type: 'user/message', seq: 0, data: { source: { kind: 'plugin:rollback' } } })
    for (const [index, event] of early.entries()) (event as { seq: number }).seq = index
    early[0] = { ...early[0]!, surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 } }
    expect(rollbackBoundaryTurn(early, allLive(early))).toBeNull()
  })

  it('reads a legacy spelling of the op', () => {
    const events = log(3, [{ at: 6, start: 4 }])
    const legacy = events.map(event => event.type === 'user/message' && event.seq === 6
      ? { ...event, surfaceOp: { op: 'replace', start: 4, end: 4 } }
      : event)
    expect(rollbackBoundaryTurn(legacy, allLive(legacy))).toBe(3)
  })
})

describe('the boundary line', () => {
  it('round-trips a turn and an explicit none', () => {
    expect(boundaryLine(3)).toBe('边界 3')
    expect(parseBoundaryLine('边界 3')).toBe(3)
    expect(parseBoundaryLine('边界 无')).toBeNull()
    expect(parseBoundaryLine('可回退到的轮次：1, 2\n边界 2')).toBe(2)
  })

  it('separates "no rollback" from "cannot say"', () => {
    // Not a boundary line at all: the caller must treat this as unknown and hide nothing.
    expect(parseBoundaryLine('可回退到的轮次：1, 2')).toBeUndefined()
    expect(parseBoundaryLine('')).toBeUndefined()
    expect(parseBoundaryLine(undefined)).toBeUndefined()
    expect(parseBoundaryLine('边界 ')).toBeUndefined()
    expect(parseBoundaryLine('边界 0')).toBeUndefined()
    expect(parseBoundaryLine('边界 abc')).toBeUndefined()
  })

  it('reads only the first token after the marker', () => {
    // A number further along the line is a different fact (a window size, a count).
    expect(parseBoundaryLine('边界 无 （仅最近 10 轮）')).toBeNull()
    expect(parseBoundaryLine('边界 4 个文件')).toBe(4)
  })
})

describe('bounded rollback state protocol', () => {
  it('revokes only exact turns inside an inclusive range, leaving future turns visible', () => {
    const events = log(4)
    events.push({ type: 'user/message', seq: 8, data: { source: { kind: 'plugin:rollback' } },
      surfaceOp: { op: 'replace', startSeq: 2, endSeq: 5 } })
    events.push({ type: 'turn/start', seq: 9, data: { turn: 5 } })
    expect(createRollbackState('s', 12, events)).toEqual({
      sessionId: 's', version: 12, turns: [2, 3], ranges: [{ start: 2, end: 5 }],
    })
  })

  it('unions successive finite revocations without extending to a later turn', () => {
    const events = log(4)
    events.push({ type: 'user/message', seq: 8, data: { source: { kind: 'plugin:rollback' } }, surfaceOp: { op: 'replace', start: 4, end: 7 } })
    events.push({ type: 'turn/start', seq: 9, data: { turn: 5 } })
    events.push({ type: 'user/message', seq: 10, data: { source: { kind: 'plugin:rollback' } }, surfaceOp: { op: 'replace', startSeq: 0, endSeq: 3 } })
    const state = createRollbackState('s', 10, events)
    expect(state.turns).toEqual([1, 2, 3, 4])
    expect(state.ranges).toEqual([{ start: 4, end: 7 }, { start: 0, end: 3 }])
  })

  it('round trips explicit empty state and ignores the legacy numeric boundary', () => {
    const state = createRollbackState('s', 0, log(2))
    expect(parseStateLine('边界 1\n' + stateLine(state))).toEqual(state)
    expect(parseStateLine('边界 1')).toBeUndefined()
  })

  it.each([
    { sessionId: '', version: 0, turns: [], ranges: [] },
    { sessionId: 's', version: -1, turns: [], ranges: [] },
    { sessionId: 's', version: 1.5, turns: [], ranges: [] },
    { sessionId: 's', version: 0, turns: [0], ranges: [] },
    { sessionId: 's', version: 0, turns: [2, 2], ranges: [] },
    { sessionId: 's', version: 0, turns: ['2'], ranges: [] },
    { sessionId: 's', version: 0, turns: [], ranges: [{ start: 4, end: 3 }] },
    { sessionId: 's', version: 0, turns: [], ranges: [{ start: -1, end: 3 }] },
    { sessionId: 's', version: 0, turns: [], ranges: [{ start: 1, end: Number.MAX_SAFE_INTEGER + 1 }] },
  ])('rejects malformed state %j', state => {
    expect(parseStateLine('状态 ' + JSON.stringify(state))).toBeUndefined()
  })

  it('rejects nonfinite numbers, malformed JSON and an unanchored protocol label', () => {
    expect(parseStateLine('状态 {"sessionId":"s","version":1e999,"turns":[],"ranges":[]}')).toBeUndefined()
    expect(parseStateLine('状态 {')).toBeUndefined()
    expect(parseStateLine('result: 状态 {"sessionId":"s","version":0,"turns":[],"ranges":[]}')).toBeUndefined()
  })
})
