import { describe, expect, it } from 'vitest'
import { emptyCheckpoint, type FsMutation } from '../src/core/model.ts'
import { recordChange, surfacePos } from '../src/core/capture.ts'
import { planRollback } from '../src/core/restore-plan.ts'
import { fsMutationFrom, SessionFold } from '../src/core/session-fold.ts'
import { SlidingWindow } from '../src/core/sliding-window.ts'

describe('sliding window', () => {
  it('evicts the oldest item past capacity', () => {
    const w = new SlidingWindow<number>(3)
    w.push(1); w.push(2); w.push(3); w.push(4)
    expect(w.snapshot()).toEqual([2, 3, 4])
    expect(w.size()).toBe(3)
  })

  it('returns a fresh, mutable-safe snapshot', () => {
    const w = new SlidingWindow<number>(2)
    w.push(1); w.push(2)
    const snap = w.snapshot()
    ;(snap as number[]).push(99)
    expect(w.snapshot()).toEqual([1, 2])
  })

  it('rejects a non-positive capacity', () => {
    expect(() => new SlidingWindow(0)).toThrow(RangeError)
  })
})

describe('capture.recordChange', () => {
  const mk = (path: string, operation: 'create' | 'update' | 'remove', before: string | null, after: string): FsMutation =>
    ({ path, operation, before, after })

  it('first touch records before/kind/basis', () => {
    const cp = recordChange(emptyCheckpoint(1), mk('/a.ts', 'update', 'old', 'new'))
    expect(cp.changes['/a.ts']).toEqual({
      path: '/a.ts', kind: 'updated', before: 'old', after: 'new', basisKnown: true,
    })
  })

  it('a later mutation in the turn keeps the original before and advances after', () => {
    let cp = emptyCheckpoint(1)
    cp = recordChange(cp, mk('/a.ts', 'update', 'v0', 'v1'))
    cp = recordChange(cp, mk('/a.ts', 'update', 'v1', 'v2'))
    expect(cp.changes['/a.ts']).toMatchObject({ before: 'v0', after: 'v2', kind: 'updated' })
  })

  it('create marks created with basis known regardless of null before', () => {
    const cp = recordChange(emptyCheckpoint(1), mk('/new.ts', 'create', null, 'body'))
    expect(cp.changes['/new.ts']).toEqual({
      path: '/new.ts', kind: 'created', before: null, after: 'body', basisKnown: true,
    })
  })

  it('an update with no contextual basis is not restorable', () => {
    const cp = recordChange(emptyCheckpoint(1), mk('/bin.dat', 'update', null, 'x'))
    expect(cp.changes['/bin.dat']).toMatchObject({ kind: 'updated', basisKnown: false })
  })

  it('a removal is its own kind, with the last known content as the basis', () => {
    // Only the boundary re-scan can produce this: a file the plugin was watching was
    // found gone. It must stay distinguishable from a rewrite, because the rollback
    // brings the file BACK rather than putting old content into a file that exists.
    const cp = recordChange(emptyCheckpoint(1), mk('/gone.txt', 'remove', 'last known', ''))
    expect(cp.changes['/gone.txt']).toEqual({
      path: '/gone.txt', kind: 'removed', before: 'last known', after: '', basisKnown: true,
    })
  })

  it('a removal with no known content is not restorable', () => {
    const cp = recordChange(emptyCheckpoint(1), mk('/gone.txt', 'remove', null, ''))
    expect(cp.changes['/gone.txt']).toMatchObject({ kind: 'removed', basisKnown: false })
  })
})

describe('capture.surfacePos', () => {
  it('records first and last surface seq', () => {
    let cp = emptyCheckpoint(1)
    cp = surfacePos(cp, 10)
    cp = surfacePos(cp, 12)
    expect(cp.startSeq).toBe(10)
    expect(cp.endSeq).toBe(12)
  })

  it('ignores null seqs', () => {
    const cp = emptyCheckpoint(1)
    expect(surfacePos(cp, null)).toBe(cp)
  })
})

describe('SessionFold', () => {
  it('folds turns into per-turn checkpoints and tracks the surface tail', () => {
    const f = new SessionFold(10)
    f.fold({ kind: 'turn-start', turn: 1, seq: 0 })
    f.fold({ kind: 'surface', seq: 1 })
    f.fold({ kind: 'fs-mutation', mutation: { path: '/a', operation: 'update', before: 'A0', after: 'A1' } })
    f.fold({ kind: 'surface', seq: 2 })
    f.fold({ kind: 'turn-end', turn: 1, seq: 2 })

    f.fold({ kind: 'turn-start', turn: 2, seq: 3 })
    f.fold({ kind: 'surface', seq: 4 })
    // /a touched again in turn 2: first-touch before stays A0.
    f.fold({ kind: 'fs-mutation', mutation: { path: '/a', operation: 'update', before: 'A1', after: 'A2' } })
    f.fold({ kind: 'surface', seq: 5 })
    f.fold({ kind: 'turn-end', turn: 2, seq: 5 })

    const snaps = f.snapshots()
    expect(snaps.map(c => c.turn)).toEqual([1, 2])
    expect(snaps[0]).toMatchObject({ startSeq: 1, endSeq: 2 })
    expect(snaps[0]!.changes['/a']).toMatchObject({ before: 'A0', after: 'A1' })
    expect(snaps[1]!.changes['/a']).toMatchObject({ before: 'A1', after: 'A2' })
    expect(f.surfaceTail()).toBe(5)
  })

  it('skips empty turns', () => {
    const f = new SessionFold(10)
    f.fold({ kind: 'turn-start', turn: 1, seq: 0 })
    f.fold({ kind: 'turn-end', turn: 1, seq: 0 })
    expect(f.snapshots()).toEqual([])
  })

  it('drops checkpoints beyond the window', () => {
    const f = new SessionFold(3)
    for (let t = 1; t <= 5; t++) {
      f.fold({ kind: 'turn-start', turn: t, seq: t * 2 })
      f.fold({ kind: 'surface', seq: t * 2 })
      f.fold({ kind: 'turn-end', turn: t, seq: t * 2 })
    }
    expect(f.snapshots().map(c => c.turn)).toEqual([3, 4, 5])
  })

  it('dropFrom keeps earlier turns and clears later ones plus the tail', () => {
    const f = new SessionFold(10)
    for (let t = 1; t <= 4; t++) {
      f.fold({ kind: 'turn-start', turn: t, seq: t })
      f.fold({ kind: 'surface', seq: t })
      f.fold({ kind: 'turn-end', turn: t, seq: t })
    }
    f.dropFrom(3)
    expect(f.snapshots().map(c => c.turn)).toEqual([1, 2])
    f.setTail(100)
    expect(f.surfaceTail()).toBe(100)
  })

  describe('dropFromExcept', () => {
    /** A fold holding one change per turn: `/a` in turn 2, `/b` in turn 3. */
    function seeded(): SessionFold {
      const f = new SessionFold(10)
      f.fold({ kind: 'turn-start', turn: 2, seq: 1 })
      f.fold({ kind: 'surface', seq: 1 })
      f.fold({ kind: 'fs-mutation', mutation: { path: '/a', operation: 'update', before: 'a0', after: 'a1' } })
      f.fold({ kind: 'turn-end', turn: 2, seq: 1 })
      f.fold({ kind: 'turn-start', turn: 3, seq: 2 })
      f.fold({ kind: 'surface', seq: 2 })
      f.fold({ kind: 'fs-mutation', mutation: { path: '/b', operation: 'create', before: null, after: 'b' } })
      f.fold({ kind: 'turn-end', turn: 3, seq: 2 })
      return f
    }

    it('keeps only the skipped paths from the undone turns', () => {
      // A rollback that skipped `/a` (say the file was locked) must leave its record
      // behind, or that file leaves rollback coverage for good — while `/b`, which the
      // rollback DID undo, must not be re-applied by a later rollback.
      const f = seeded()
      f.dropFromExcept(2, new Set(['/a']))
      expect(f.snapshots().map(c => c.turn)).toEqual([2])
      expect(Object.keys(f.snapshots()[0]!.changes)).toEqual(['/a'])
    })

    it('behaves exactly like dropFrom when nothing was skipped', () => {
      const f = seeded()
      f.dropFromExcept(2, new Set())
      expect(f.snapshots()).toEqual([])
    })

    it('leaves earlier turns untouched', () => {
      const f = seeded()
      f.dropFromExcept(3, new Set(['/b']))
      expect(f.snapshots().map(c => c.turn)).toEqual([2, 3])
      expect(Object.keys(f.snapshots()[0]!.changes)).toEqual(['/a'])
      expect(Object.keys(f.snapshots()[1]!.changes)).toEqual(['/b'])
    })
  })

  describe('mutationInto', () => {
    const change = (path: string, before: string, after: string): FsMutation =>
      ({ path, operation: 'update', before, after })

    it('records against the open turn', () => {
      const f = new SessionFold(10)
      f.fold({ kind: 'turn-start', turn: 7, seq: 0 })
      expect(f.mutationInto(7, change('a.txt', 'old', 'new'))).toBe(true)
      f.fold({ kind: 'turn-end', turn: 7, seq: 0 })
      expect(f.snapshots()[0]!.changes['a.txt']).toMatchObject({ before: 'old', after: 'new' })
    })

    it('records against a turn that already closed', () => {
      // The boundary re-scan reads the filesystem asynchronously, so the turn it
      // anchors to can close while it waits; dropping the mutation then would lose
      // exactly the change the re-scan exists to catch.
      const f = new SessionFold(10)
      f.fold({ kind: 'turn-start', turn: 3, seq: 0 })
      f.fold({ kind: 'surface', seq: 1 })
      f.fold({ kind: 'turn-end', turn: 3, seq: 1 })
      expect(f.mutationInto(3, change('gone.txt', 'content', ''))).toBe(true)
      expect(f.snapshots()[0]!.changes['gone.txt']).toMatchObject({ before: 'content', after: '' })
    })

    it('keeps the first before-state when a later mutation joins the same turn', () => {
      const f = new SessionFold(10)
      f.fold({ kind: 'turn-start', turn: 2, seq: 0 })
      f.fold({ kind: 'surface', seq: 1 })
      f.fold({ kind: 'turn-end', turn: 2, seq: 1 })
      f.mutationInto(2, change('x.txt', 'first', 'second'))
      f.mutationInto(2, change('x.txt', 'second', 'third'))
      expect(f.snapshots()[0]!.changes['x.txt']).toMatchObject({ before: 'first', after: 'third' })
    })

    it('refuses a turn that left the retained window', () => {
      const f = new SessionFold(2)
      for (let t = 1; t <= 5; t++) {
        f.fold({ kind: 'turn-start', turn: t, seq: t })
        f.fold({ kind: 'surface', seq: t })
        f.fold({ kind: 'turn-end', turn: t, seq: t })
      }
      expect(f.mutationInto(1, change('old.txt', 'a', 'b'))).toBe(false)
      expect(f.mutationInto(5, change('new.txt', 'a', 'b'))).toBe(true)
    })
  })
})

describe('fsMutationFrom', () => {
  it('maps write outcomes', () => {
    expect(fsMutationFrom('write', { path: '/a', operation: 'create', before: null, after: 'x' }))
      .toEqual({ path: '/a', operation: 'create', before: null, after: 'x' })
  })

  it('maps edit outcomes with implicit update', () => {
    expect(fsMutationFrom('edit', { path: '/a', before: 'o', after: 'n' }))
      .toEqual({ path: '/a', operation: 'update', before: 'o', after: 'n' })
  })

  it('rejects other tools and malformed values', () => {
    expect(fsMutationFrom('read', { path: '/a' })).toBeNull()
    expect(fsMutationFrom('write', null)).toBeNull()
    expect(fsMutationFrom('write', { path: '/a', before: 'o' })).toBeNull()
  })
})

describe('planRollback', () => {
  const cp = (turn: number, startSeq: number | null, changes: Record<string, Parameters<typeof recordChange>[1]>) => {
    let c = surfacePos(emptyCheckpoint(turn), startSeq)
    c = surfacePos(c, startSeq !== null ? startSeq : null)
    for (const m of Object.values(changes)) c = recordChange(c, m)
    return c
  }

  it('restores updated files to their first-touch before across multiple turns', () => {
    const a1 = cp(1, 1, { '/a': { path: '/a', operation: 'update', before: 'A0', after: 'A1' } })
    const a2 = cp(2, 4, { '/a': { path: '/a', operation: 'update', before: 'A1', after: 'A2' } })
    const plan = planRollback([a1, a2], 1, 6)
    expect(plan.restored).toEqual([{ path: '/a', action: 'restore', content: 'A0', kind: 'updated' }])
    expect(plan.skipped).toEqual([])
    expect(plan.truncation).toEqual({ start: 1, end: 6 })
  })

  it('deletes files created inside the window', () => {
    const a1 = cp(2, 3, { '/new': { path: '/new', operation: 'create', before: null, after: 'x' } })
    const plan = planRollback([a1], 2, 5)
    expect(plan.restored).toEqual([{ path: '/new', action: 'delete', content: null, kind: 'created' }])
  })

  it('recovers a file that was deleted, distinctly from restoring one that was rewritten', () => {
    // Same bytes written, different story: 恢复 puts old content into a file that is
    // still there, 找回 brings a file back. Only the recorded kind can tell them
    // apart, so the plan has to carry it through.
    const gone = cp(3, 5, { '/gone': { path: '/gone', operation: 'remove', before: 'was here', after: '' } })
    const edited = cp(3, 5, { '/edited': { path: '/edited', operation: 'update', before: 'old', after: 'new' } })
    const plan = planRollback([gone, edited], 3, 6)
    expect(plan.restored).toEqual([
      { path: '/gone', action: 'recover', content: 'was here', kind: 'removed' },
      { path: '/edited', action: 'restore', content: 'old', kind: 'updated' },
    ])
  })

  it('skips a removal whose content was never known', () => {
    const gone = cp(3, 5, { '/gone': { path: '/gone', operation: 'remove', before: null, after: '' } })
    const plan = planRollback([gone], 3, 6)
    expect(plan.restored).toEqual([])
    expect(plan.skipped).toEqual([{ path: '/gone', reason: 'basis-unknown' }])
  })

  it('rolls back to an earlier turn without touching earlier work', () => {
    const a1 = cp(1, 1, { '/keep': { path: '/keep', operation: 'update', before: 'K0', after: 'K1' } })
    const a2 = cp(2, 4, { '/bad': { path: '/bad', operation: 'update', before: 'B0', after: 'B1' } })
    const plan = planRollback([a1, a2], 2, 6)
    // Rolling back to before turn 2 only touches /bad; /keep is turn 1 work.
    expect(plan.restored.map(f => f.path)).toEqual(['/bad'])
    expect(plan.truncation).toEqual({ start: 4, end: 6 })
  })

  it('skips files with no trustworthy basis and yields null truncation on an empty surface', () => {
    const a1 = cp(1, 1, { '/bin': { path: '/bin', operation: 'update', before: null, after: 'y' } })
    const plan = planRollback([a1], 1, null)
    expect(plan.restored).toEqual([])
    expect(plan.skipped).toEqual([{ path: '/bin', reason: 'basis-unknown' }])
    expect(plan.truncation).toBeNull()
  })
})

describe('additional edge cases', () => {
  it('SlidingWindow.clear empties the window', () => {
    const w = new SlidingWindow<number>(3)
    w.push(1); w.push(2)
    w.clear()
    expect(w.snapshot()).toEqual([])
    expect(w.size()).toBe(0)
  })

  it('SessionFold.clear resets snapshots and the surface tail', () => {
    const f = new SessionFold(10)
    f.fold({ kind: 'turn-start', turn: 1, seq: 0 })
    f.fold({ kind: 'surface', seq: 1 })
    f.fold({ kind: 'turn-end', turn: 1, seq: 1 })
    f.clear()
    expect(f.snapshots()).toEqual([])
    expect(f.surfaceTail()).toBeNull()
  })

  it('planRollback with an empty window yields no files and null truncation', () => {
    const plan = planRollback([], 3, 10)
    expect(plan.restored).toEqual([])
    expect(plan.skipped).toEqual([])
    expect(plan.truncation).toBeNull()
  })

  it('planRollback restores in ascending-turn order even when checkpoints are unsorted', () => {
    const mk = (turn: number, startSeq: number, m: FsMutation) => {
      let c = surfacePos(emptyCheckpoint(turn), startSeq)
      c = surfacePos(c, startSeq + 1)
      c = recordChange(c, m)
      return c
    }
    const turn3 = mk(3, 5, { path: '/new', operation: 'create', before: null, after: 'body' })
    const turn1 = mk(1, 1, { path: '/a', operation: 'update', before: 'A0', after: 'A1' })
    const plan = planRollback([turn3, turn1], 1, 9)
    expect(plan.restored.map(f => f.path)).toEqual(['/a', '/new'])
    expect(plan.restored[0]!.action).toBe('restore')
    expect(plan.restored[1]!.action).toBe('delete')
  })
})