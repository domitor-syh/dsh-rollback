import { describe, expect, it } from 'vitest'
import {
  findingTurn,
  planBoundaryAction,
  unchangedByStat,
  type ObservedFile,
  type TrackedFile,
} from '../src/core/boundary-scan.ts'

/** What the plugin knows after observing `content`. */
function tracked(lastKnown: string | null, extra: Partial<TrackedFile> = {}): TrackedFile {
  return { lastKnown, size: null, mtimeMs: null, missing: false, ...extra }
}

/** A file as the probe reported it. */
function observed(content: string): ObservedFile {
  return { content, size: content.length, mtimeMs: 1_000 }
}

describe('unchangedByStat', () => {
  it('proves an untouched file from its fingerprint alone', () => {
    const state = tracked('abc', { size: 3, mtimeMs: 1_000 })
    expect(unchangedByStat(state, 3, 1_000)).toBe(true)
    expect(unchangedByStat(state, 3, 1_001)).toBe(false)
    expect(unchangedByStat(state, 4, 1_000)).toBe(false)
  })

  it('never skips a file the previous check found missing', () => {
    // It may have come back; the fingerprint of a missing file is meaningless.
    const state = tracked('abc', { size: 3, mtimeMs: 1_000, missing: true })
    expect(unchangedByStat(state, 3, 1_000)).toBe(false)
  })

  it('never skips a file whose fingerprint was never taken', () => {
    expect(unchangedByStat(tracked('abc'), 3, 1_000)).toBe(false)
  })
})

describe('planBoundaryAction', () => {
  it('preserves a known baseline on a typed failed probe', () => {
    for (const reason of ['EACCES', 'EPERM', 'EBUSY', 'ELOOP', 'read failed', 'non-regular']) {
      expect(planBoundaryAction(tracked('content'), { kind: 'unknown', reason })).toEqual({ kind: 'unknown', reason })
    }
    expect(planBoundaryAction(tracked(''), { kind: 'missing' })).toEqual({ kind: 'missing', before: '' })
    expect(planBoundaryAction(tracked(null, { missing: true }), { kind: 'missing' })).toEqual({ kind: 'none' })
  })

  it('adopts the content of a file it has never read', () => {
    const action = planBoundaryAction(tracked(null), observed('first'))
    expect(action).toEqual({ kind: 'adopt', observed: observed('first') })
  })

  it('reports nothing while the content matches what it knows', () => {
    expect(planBoundaryAction(tracked('same'), observed('same'))).toEqual({ kind: 'none' })
  })

  it('records a swap when the content changed underneath it', () => {
    // The shell rewrite case: what the plugin knew is the state to restore.
    expect(planBoundaryAction(tracked('before'), observed('after'))).toEqual({
      kind: 'changed',
      before: 'before',
      after: 'after',
      observed: observed('after'),
    })
  })

  it('records the content to put back when the file vanished', () => {
    expect(planBoundaryAction(tracked('content'), null)).toEqual({ kind: 'missing', before: 'content' })
  })

  it('records a disappearance only once', () => {
    // Otherwise every following boundary would add a record for an unchanged state.
    const alreadyGone = tracked('content', { missing: true })
    expect(planBoundaryAction(alreadyGone, null)).toEqual({ kind: 'none' })
  })

  it('re-adopts a file that came back after it was recorded missing', () => {
    const cameBack = tracked('content', { missing: true })
    expect(planBoundaryAction(cameBack, observed('fresh'))).toEqual({ kind: 'created', observed: observed('fresh') })
  })

  it('refuses to record a disappearance it could not undo', () => {
    // Recording it would be worse than useless: restore reports such a path as
    // skipped, and a skipped file aborts the whole rollback.
    expect(planBoundaryAction(tracked(null), null)).toEqual({ kind: 'unrestorable' })
  })
})

describe('findingTurn', () => {
  it('stays on the scanned turn when that turn also confirmed the file', () => {
    expect(findingTurn(9, 9)).toBe(9)
  })

  it('stays on the scanned turn however stale the last confirmation was', () => {
    // The earlier rule advanced to `lastSeenTurn + 1`, which is a claim that the change
    // happened in a turn whose boundary had ALREADY seen the file intact — impossible,
    // and harmful: it filed a deletion under the previous turn, so rolling back the turn
    // that actually deleted the file planned a window that excluded the removal.
    // Measured on the desktop (2026-10-02): a file created in turn 6, untouched in turn 7
    // and deleted in turn 8 was recorded as turn 7, and the 找回 entry went missing.
    expect(findingTurn(5, 9)).toBe(9)
    expect(findingTurn(1, 2)).toBe(2)
    expect(findingTurn(6, 7)).toBe(7)
    expect(findingTurn(6, 8)).toBe(8)
  })

  it('falls back to the scanned turn when nothing was ever confirmed', () => {
    expect(findingTurn(null, 7)).toBe(7)
    expect(findingTurn(undefined, 7)).toBe(7)
  })
})