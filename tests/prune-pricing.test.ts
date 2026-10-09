import { describe, expect, it } from 'vitest'
import { priceRollbackPrune } from '../src/core/prune-pricing.ts'
import type { TruncationMarkerPlan } from '../src/core/truncation-plan.ts'

const marker = (shadowed: number[]): TruncationMarkerPlan => ({
  shadowed, range: { start: shadowed[0]!, end: shadowed.at(-1)! }, sourceEventSeqs: [...shadowed].reverse(),
  data: { id: 'priced', role: 'user', source: { kind: 'plugin:rollback' }, content: [] },
})
describe('rollback fixed heuristic positional pricing', () => {
  it('uses surface order, not numerical seq order or route token costs', () => {
    expect(priceRollbackPrune(marker([9, 3, 7]), [
      { seq: 1, heuristicTokens: 100 }, { seq: 9, heuristicTokens: 5 },
      { seq: 3, heuristicTokens: 0 }, { seq: 7, heuristicTokens: 12 },
    ])).toEqual({ shadowedRange: { start: 9, end: 7 }, shadowedSeqs: [9, 3, 7], shadowedTokenCount: 17 })
  })
  it('declines incomplete, noncontiguous or misordered measurements', () => {
    const plan = marker([3, 7])
    expect(priceRollbackPrune(plan, [{ seq: 3, heuristicTokens: 1 }])).toBeNull()
    expect(priceRollbackPrune(plan, [{ seq: 3, heuristicTokens: 1 }, { seq: 4, heuristicTokens: 1 }, { seq: 7, heuristicTokens: 1 }])).toBeNull()
    expect(priceRollbackPrune(plan, [{ seq: 7, heuristicTokens: 1 }, { seq: 3, heuristicTokens: 1 }])).toBeNull()
  })
  it('declines invalid, overflowing, duplicated and append-only prices', () => {
    for (const heuristicTokens of [-1, NaN, Infinity, 1.5]) {
      expect(priceRollbackPrune(marker([3]), [{ seq: 3, heuristicTokens }])).toBeNull()
    }
    expect(priceRollbackPrune(marker([3, 7]), [{ seq: 3, heuristicTokens: Number.MAX_SAFE_INTEGER }, { seq: 7, heuristicTokens: 1 }])).toBeNull()
    expect(priceRollbackPrune(marker([3, 3]), [{ seq: 3, heuristicTokens: 1 }, { seq: 3, heuristicTokens: 1 }])).toBeNull()
    expect(priceRollbackPrune({ ...marker([3]), range: null }, [{ seq: 3, heuristicTokens: 1 }])).toBeNull()
  })
})
