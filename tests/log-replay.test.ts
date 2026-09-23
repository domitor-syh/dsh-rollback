import { describe, expect, it } from 'vitest'
import { deadTurnsOf, isReplacedSeq, replacedSurfaceRanges, type ReplayEvent } from '../src/core/log-replay.ts'

/** A rollback marker event, spelled the way DSH 0.1.5 writes it. */
function marker(seq: number, start: number, end: number) {
  return { type: 'user/message', seq, surfaceOp: { op: 'replace', startSeq: start, endSeq: end }, data: { source: { plugin: 'rollback' } } }
}

/** The same marker spelled the way DSH <= 0.1.1 wrote it — i.e. an old log. */
function legacyMarker(seq: number, start: number, end: number) {
  return { type: 'user/message', seq, surfaceOp: { op: 'replace', start, end }, data: { source: { plugin: 'rollback' } } }
}

describe('replacedSurfaceRanges', () => {
  it('collects the ranges this plugin’s rollbacks replaced', () => {
    const events = [marker(805, 140, 795), marker(810, 7, 805)]
    expect(replacedSurfaceRanges(events)).toEqual([{ start: 140, end: 795 }, { start: 7, end: 805 }])
  })

  it('reads the range from BOTH spellings of the surface op', () => {
    // The regression guard for old logs. 0.1.5 renamed the op's range ends
    // `start`/`end` -> `startSeq`/`endSeq` and validates the key set exactly, so
    // the log holds markers of both spellings: those written before the upgrade
    // and those written after it. A reader that knows only the new names silently
    // finds NO range in an older marker — and an unread range is exactly the bug
    // this module exists to prevent (rolled-back turns return as phantoms, and a
    // "created file" recorded in one can delete a file the user recreated).
    expect(replacedSurfaceRanges([legacyMarker(805, 140, 795)])).toEqual([{ start: 140, end: 795 }])
    expect(replacedSurfaceRanges([marker(805, 140, 795)])).toEqual([{ start: 140, end: 795 }])
  })

  it('reads a log that mixes markers from before and after the upgrade', () => {
    const events = [legacyMarker(200, 10, 160), marker(400, 210, 370)]
    expect(replacedSurfaceRanges(events)).toEqual([{ start: 10, end: 160 }, { start: 210, end: 370 }])
  })

  it('never pairs one spelling’s start with the other’s end', () => {
    // Both spellings on one op is invalid under either build (`isReplaceOp` counts
    // the keys), and mixing them would invent a range out of two different
    // markers' numbers. The modern pair wins whole; there is no `endSeq` here, so
    // the op is unreadable rather than half-read.
    const hybrid = { type: 'user/message', seq: 805, surfaceOp: { op: 'replace', startSeq: 140, end: 795 }, data: { source: { plugin: 'rollback' } } }
    expect(replacedSurfaceRanges([hybrid])).toEqual([])
  })

  it('ignores a range whose ends are not real seqs', () => {
    const bad = (surfaceOp: unknown) => ({ type: 'user/message', seq: 805, surfaceOp, data: { source: { plugin: 'rollback' } } })
    expect(replacedSurfaceRanges([
      bad({ op: 'replace', startSeq: -1, endSeq: 795 }),
      bad({ op: 'replace', startSeq: 1.5, endSeq: 795 }),
      bad({ op: 'replace', startSeq: Number.NaN, endSeq: 795 }),
      bad({ op: 'replace', startSeq: '140', endSeq: 795 }),
    ])).toEqual([])
  })

  it('ignores a compaction replacement', () => {
    // A compaction also carries a surface `replace`, but it does NOT undo anything:
    // those turns' file changes still stand, so their checkpoints must survive.
    const events = [{ type: 'user/message', seq: 10, surfaceOp: { op: 'replace', startSeq: 1, endSeq: 9 }, data: { source: { kind: 'plugin', plugin: 'compaction' } } }]
    expect(replacedSurfaceRanges(events)).toEqual([])
  })

  it('ignores ordinary messages and malformed markers', () => {
    expect(replacedSurfaceRanges([
      { type: 'user/message', seq: 5, data: { content: 'hello' } },
      { type: 'user/message', seq: 6, surfaceOp: { op: 'append' }, data: { source: { plugin: 'rollback' } } },
      { type: 'user/message', seq: 7, surfaceOp: { op: 'replace', start: 1 }, data: { source: { plugin: 'rollback' } } },
      { type: 'user/message', seq: 8, surfaceOp: { op: 'replace', startSeq: 1 }, data: { source: { plugin: 'rollback' } } },
      { type: 'turn/start', seq: 9 },
    ])).toEqual([])
  })
})

describe('isReplacedSeq', () => {
  const ranges = [{ start: 140, end: 795 }]

  it('covers both ends of the range', () => {
    expect(isReplacedSeq(140, ranges)).toBe(true)
    expect(isReplacedSeq(795, ranges)).toBe(true)
    expect(isReplacedSeq(139, ranges)).toBe(false)
    expect(isReplacedSeq(796, ranges)).toBe(false)
  })

  it('is false without any range', () => {
    expect(isReplacedSeq(500, [])).toBe(false)
  })
})

describe('replaying a log that has rollback markers', () => {
  /** The turns a replay would fold, given the filter. */
  function replayedTurns(events: readonly ReplayEvent[]): number[] {
    const ranges = replacedSurfaceRanges(events)
    return events
      .filter(event => event.type === 'turn/start')
      .filter(event => !isReplacedSeq(event.seq, ranges))
      .map(event => (event.data as { turn: number }).turn)
  }

  it('drops the turns a rollback removed and keeps the rest', () => {
    // The measured shape of a real session: turns 1-5 replaced by one rollback, turns
    // 6-8 replaced by a second, turns 9-10 still standing. Replaying everything would
    // offer ten turns for a transcript showing two.
    const events: ReplayEvent[] = [
      { type: 'turn/start', seq: 10, data: { turn: 1 } },
      { type: 'turn/start', seq: 60, data: { turn: 2 } },
      { type: 'turn/start', seq: 90, data: { turn: 3 } },
      { type: 'turn/start', seq: 120, data: { turn: 4 } },
      { type: 'turn/start', seq: 150, data: { turn: 5 } },
      marker(200, 10, 160),
      { type: 'turn/start', seq: 230, data: { turn: 6 } },
      { type: 'turn/start', seq: 300, data: { turn: 7 } },
      { type: 'turn/start', seq: 360, data: { turn: 8 } },
      marker(400, 210, 370),
      { type: 'turn/start', seq: 430, data: { turn: 9 } },
      { type: 'turn/start', seq: 500, data: { turn: 10 } },
    ]
    expect(replayedTurns(events)).toEqual([9, 10])
  })

  it('keeps every turn when no rollback ever happened', () => {
    const events: ReplayEvent[] = [
      { type: 'turn/start', seq: 10, data: { turn: 1 } },
      { type: 'turn/start', seq: 50, data: { turn: 2 } },
    ]
    expect(replayedTurns(events)).toEqual([1, 2])
  })
})

describe('deadTurnsOf', () => {
  it('names the turns a rollback removed, and only those', () => {
    const events: ReplayEvent[] = [
      { type: 'turn/start', seq: 10, data: { turn: 1 } },
      { type: 'turn/start', seq: 60, data: { turn: 2 } },
      { type: 'turn/start', seq: 90, data: { turn: 3 } },
      marker(200, 10, 160),
      { type: 'turn/start', seq: 230, data: { turn: 4 } },
    ]
    expect([...deadTurnsOf(events)].sort((a, b) => a - b)).toEqual([1, 2, 3])
  })

  it('names the dead turns of an old log too, whose markers use the legacy spelling', () => {
    // The upgrade case that matters: a session written entirely before 0.1.5. Its
    // markers must still kill their turns, or the boundary re-scan resumes watching
    // files an earlier rollback correctly deleted and "finds" them missing again.
    const events: ReplayEvent[] = [
      { type: 'turn/start', seq: 10, data: { turn: 1 } },
      { type: 'turn/start', seq: 90, data: { turn: 2 } },
      legacyMarker(200, 10, 160),
      { type: 'turn/start', seq: 230, data: { turn: 3 } },
    ]
    expect([...deadTurnsOf(events)].sort((a, b) => a - b)).toEqual([1, 2])
  })

  it('is empty when nothing was ever rolled back', () => {
    // The whole point of the empty case: with no markers, every sidecar record still
    // describes real state, so nothing may be dropped and nothing may stop being
    // watched.
    expect(deadTurnsOf([{ type: 'turn/start', seq: 10, data: { turn: 1 } }]).size).toBe(0)
    expect(deadTurnsOf([]).size).toBe(0)
  })

  it('ignores a turn/start with no usable turn number', () => {
    const events: ReplayEvent[] = [
      { type: 'turn/start', seq: 20 },
      marker(200, 10, 160),
    ]
    expect(deadTurnsOf(events).size).toBe(0)
  })
})