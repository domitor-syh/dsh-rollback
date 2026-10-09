import { describe, expect, it } from 'vitest'
import { deadTurnsOf, isReplacedSeq, replacedSurfaceRanges, type ReplayEvent } from '../src/core/log-replay.ts'

/** A rollback marker event, spelled the way DSH 0.1.5 writes it. */
function marker(seq: number, start: number, end: number) {
  return { type: 'user/message', seq, surfaceOp: { op: 'replace', startSeq: start, endSeq: end }, data: { source: { kind: 'plugin', plugin: 'rollback' } } }
}

/** The same marker spelled the way DSH <= 0.1.1 wrote it — i.e. an old log. */
function legacyMarker(seq: number, start: number, end: number) {
  return { type: 'user/message', seq, surfaceOp: { op: 'replace', start, end }, data: { source: { kind: 'plugin', plugin: 'rollback' } } }
}

/**
 * A marker in the producer-owned spelling DSH 0.2.0 requires.
 *
 * Format v4 refuses the released `{kind:'plugin'}` wrapper outright
 * (`format v4 message requires a producer-owned source kind`), so everything this
 * plugin writes now carries `{kind:'plugin:rollback'}` — while a log written
 * before that fix still holds the wrapper. A reader has to accept both or it
 * loses the ranges of exactly one generation of markers.
 */
function producerMarker(seq: number, start: number, end: number) {
  return { type: 'user/message', seq, surfaceOp: { op: 'replace', startSeq: start, endSeq: end }, data: { source: { kind: 'plugin:rollback' } } }
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

  it('reads the producer-owned spelling format v4 requires', () => {
    // The v4-native marker. A reader that only knew the released wrapper would
    // find no range here — and every rollback written on 0.2.0 uses this shape.
    expect(replacedSurfaceRanges([producerMarker(805, 140, 795)])).toEqual([{ start: 140, end: 795 }])
  })

  it('reads a log holding BOTH provenance spellings side by side', () => {
    // Exactly what a long-lived session looks like across the fix: old markers
    // carrying the wrapper, new ones carrying the producer kind.
    const events = [legacyMarker(200, 10, 160), producerMarker(400, 210, 370)]
    expect(replacedSurfaceRanges(events)).toEqual([{ start: 10, end: 160 }, { start: 210, end: 370 }])
  })

  it('does not claim a marker for a different producer', () => {
    // `plugin:compaction` and a plugin NAMED rollback are different producers; the
    // identity is the pair, not the substring.
    const other = { type: 'user/message', seq: 805, surfaceOp: { op: 'replace', startSeq: 1, endSeq: 9 }, data: { source: { kind: 'plugin:compaction' } } }
    const named = { type: 'user/message', seq: 806, surfaceOp: { op: 'replace', startSeq: 1, endSeq: 9 }, data: { source: { kind: 'user', plugin: 'rollback' } } }
    expect(replacedSurfaceRanges([other])).toEqual([])
    expect(replacedSurfaceRanges([named])).toEqual([])
  })

  it('never pairs one spelling’s start with the other’s end', () => {
    // Both spellings on one op is invalid under either build (`isReplaceOp` counts
    // the keys), and mixing them would invent a range out of two different
    // markers' numbers. The modern pair wins whole; there is no `endSeq` here, so
    // the op is unreadable rather than half-read.
    const hybrid = { type: 'user/message', seq: 805, surfaceOp: { op: 'replace', startSeq: 140, end: 795 }, data: { source: { kind: 'plugin', plugin: 'rollback' } } }
    expect(replacedSurfaceRanges([hybrid])).toEqual([])
  })

  it('ignores a range whose ends are not real seqs', () => {
    const bad = (surfaceOp: unknown) => ({ type: 'user/message', seq: 805, surfaceOp, data: { source: { kind: 'plugin', plugin: 'rollback' } } })
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
      { type: 'user/message', seq: 6, surfaceOp: { op: 'append' }, data: { source: { kind: 'plugin', plugin: 'rollback' } } },
      { type: 'user/message', seq: 7, surfaceOp: { op: 'replace', start: 1 }, data: { source: { kind: 'plugin', plugin: 'rollback' } } },
      { type: 'user/message', seq: 8, surfaceOp: { op: 'replace', startSeq: 1 }, data: { source: { kind: 'plugin', plugin: 'rollback' } } },
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
  it('kills a turn whose first surface is replaced but turn/start lies before the range', () => {
    const events: ReplayEvent[] = [
      { type: 'turn/start', seq: 10, data: { turn: 1 } },
      { type: 'system/message', seq: 11, surfaceOp: 'append' },
      { type: 'assistant/message', seq: 12, surfaceOp: 'append' },
      { type: 'turn/end', seq: 13, data: { turn: 1 } },
      marker(20, 12, 12),
    ]
    expect([...deadTurnsOf(events)]).toEqual([1])
    expect([...deadTurnsOf([...events.slice(0, -1), marker(20, 11, 11)])]).toEqual([])
  })

  it('keeps system-only turns and future turns with multiple legacy and modern markers', () => {
    const events: ReplayEvent[] = [
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'system/message', seq: 2, surfaceOp: 'append' },
      { type: 'turn/end', seq: 3, data: { turn: 1 } },
      { type: 'turn/start', seq: 10, data: { turn: 2 } },
      { type: 'user/message', seq: 12, surfaceOp: 'append' },
      { type: 'turn/end', seq: 13, data: { turn: 2 } },
      { type: 'turn/start', seq: 30, data: { turn: 3 } },
      { type: 'tool/result', seq: 32, surfaceOp: 'append' },
      { type: 'turn/end', seq: 33, data: { turn: 3 } },
      legacyMarker(40, 1, 12), marker(50, 12, 32), marker(60, 12, 12),
      { type: 'turn/start', seq: 70, data: { turn: 4 } },
      { type: 'assistant/message', seq: 72, surfaceOp: 'append' },
    ]
    expect([...deadTurnsOf([...events].reverse())]).toEqual([2, 3])
  })

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