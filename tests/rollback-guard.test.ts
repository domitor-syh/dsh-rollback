import { describe, expect, it } from 'vitest'
import { oldestTurnOf, rollbackRefusal, windowRefusal } from '../src/core/rollback-guard.ts'

describe('rollbackRefusal', () => {
  it('allows a rollback between turns', () => {
    expect(rollbackRefusal(null)).toBeNull()
  })

  it('refuses while any turn is open, whatever the target turn is', () => {
    // The rule is about the RUN, not about which turn the user picked: a command
    // does not interrupt the run, so this refusal is what stops the two from
    // interleaving — and it must name the running turn and say what to do.
    const refusal = rollbackRefusal(7)
    expect(refusal).toContain('第 7 轮')
    expect(refusal).toContain('暂停')
  })
})

describe('windowRefusal', () => {
  const retained = [51, 52, 53, 54, 55, 56, 57, 58, 59, 60]

  it('allows a target inside the retained window', () => {
    expect(windowRefusal(51, retained)).toBeNull()
    expect(windowRefusal(60, retained)).toBeNull()
  })

  it('allows a target that kept no checkpoint of its own', () => {
    // A turn with no output and no file changes is not retained, but rolling back to
    // before it is still exact: the retained turns after it are what describe it.
    expect(windowRefusal(53, [51, 52, 54, 55])).toBeNull()
  })

  it('refuses a target older than everything retained, naming the range', () => {
    // Planning anyway would silently restore from the OLDEST retained records — a
    // different state than the one asked for, with nothing said about it.
    const refusal = windowRefusal(30, retained)
    expect(refusal).toContain('51')
    expect(refusal).toContain('60')
  })

  it('refuses every target when nothing is retained', () => {
    expect(windowRefusal(1, [])).toContain('没有可回退')
  })
})

describe('oldestTurnOf', () => {
  it('reads the range out of the host list output', () => {
    expect(oldestTurnOf('可回退到的轮次：51, 52, 53 (仅最近 10 轮)')).toBe(51)
    expect(oldestTurnOf('可回退到的轮次：51 (仅最近 10 轮)')).toBe(51)
  })

  it('reports "nothing is rollback-able" when the list names no turn', () => {
    // Infinity, not null: null would mean "unknown" and leave every entry enabled,
    // while a known-empty range greys them all out.
    expect(oldestTurnOf('可回退到的轮次： (仅最近 10 轮)')).toBe(Number.POSITIVE_INFINITY)
    expect(oldestTurnOf('可回退到的轮次：')).toBe(Number.POSITIVE_INFINITY)
  })

  it('reports nothing usable for text it does not recognize', () => {
    // "Unknown" must not mean "nothing is rollback-able": an unrecognized line would
    // otherwise disable every entry. The host refuses out-of-range targets itself.
    expect(oldestTurnOf('当前会话没有可回退的轮次。(仅最近 10 轮)')).toBeNull()
    expect(oldestTurnOf('')).toBeNull()
    expect(oldestTurnOf(undefined)).toBeNull()
    expect(oldestTurnOf(null)).toBeNull()
  })

  it('ignores numbers that are not the turn list', () => {
    // The window hint carries a number of its own ("10"); only what follows the
    // colon is the list, so the parse must not fold the hint into the range.
    expect(oldestTurnOf('可回退到的轮次：51, 52 (仅最近 10 轮)')).toBe(51)
  })
})