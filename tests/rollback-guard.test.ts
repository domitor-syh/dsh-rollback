import { describe, expect, it } from 'vitest'
import { rollbackRefusal } from '../src/core/rollback-guard.ts'

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