import { describe, expect, it } from 'vitest'
import { emptyCheckpoint, type FsMutation } from '../src/core/model.ts'
import { recordChange, surfacePos } from '../src/core/capture.ts'
import { planRollback } from '../src/core/restore-plan.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendCheckpoint, loadCheckpoints } from '../src/store.ts'
import { SessionFold } from '../src/core/session-fold.ts'

const path = '/net-state.txt'
const states: Array<string | null> = [null, '', 'A', 'B']
const mutation = (before: string | null, after: string | null, afterKnown?: boolean): FsMutation => ({
  path, before, after, operation: before === null ? 'create' : after === null ? 'remove' : 'update',
  ...(afterKnown === undefined ? {} : { afterKnown }),
})
const cases = states.flatMap(before => states.flatMap(middle => states.map(after => ({ before, middle, after }))))

describe('net-state endpoint matrix', () => {
  for (const layout of ['same-turn', 'cross-turn'] as const) {
    it.each(cases)(`${layout}: $before -> $middle -> $after`, ({ before, middle, after }) => {
      const first = recordChange(surfacePos(emptyCheckpoint(1), 10), mutation(before, middle))
      const checkpoints = layout === 'same-turn'
        ? [recordChange(first, mutation(middle, after))]
        : [first, surfacePos(emptyCheckpoint(2), 20), recordChange(surfacePos(emptyCheckpoint(3), 30), mutation(middle, after))]
      const plan = planRollback(checkpoints, 1, 31)
      expect(plan.skipped).toEqual([])
      expect(plan.restored).toEqual(before === after ? [] : [{
        path, content: before,
        action: before === null ? 'delete' : after === null ? 'recover' : 'restore',
        kind: before === null ? 'created' : after === null ? 'removed' : 'updated',
      }])
      expect(plan.truncation).toEqual({ start: 10, end: 31 })
      if (layout === 'cross-turn') {
        expect(planRollback(checkpoints, 3, 31).restored).toEqual(middle === after ? [] : [{
          path, content: middle,
          action: middle === null ? 'delete' : after === null ? 'recover' : 'restore',
          kind: middle === null ? 'created' : after === null ? 'removed' : 'updated',
        }])
      }
    })
  }

  it.each([null, '', 'A'])('retains unknown-basis skip regardless of endpoint %s', after => {
    const checkpoint = recordChange(surfacePos(emptyCheckpoint(1), 10), { path, operation: 'update', before: null, after })
    expect(planRollback([checkpoint], 1, 11)).toMatchObject({ restored: [], skipped: [{ path, reason: 'basis-unknown' }] })
  })

  for (const layout of ['same-turn', 'cross-turn'] as const) {
    it(`${layout}: unknown final after never proves an equal or null net endpoint`, () => {
      const first = recordChange(surfacePos(emptyCheckpoint(1), 10), mutation('original', 'model', true))
      const unknown = mutation('model', 'original', false)
      const checkpoints = layout === 'same-turn'
        ? [recordChange(first, unknown)]
        : [first, recordChange(surfacePos(emptyCheckpoint(2), 20), unknown)]
      const plan = planRollback(checkpoints, 1, 21)
      expect(plan.restored).toEqual([{ path, action: 'restore', content: 'original', kind: 'updated' }])
      expect(plan.skipped).toEqual([])
    })

    it(`${layout}: unknown final after on a created file safely keeps delete`, () => {
      const first = recordChange(surfacePos(emptyCheckpoint(1), 10), mutation(null, 'created', true))
      const unknown = mutation('created', 'created', false)
      const checkpoints = layout === 'same-turn'
        ? [recordChange(first, unknown)]
        : [first, recordChange(surfacePos(emptyCheckpoint(2), 20), unknown)]
      const plan = planRollback(checkpoints, 1, 21)
      expect(plan.restored).toEqual([{ path, action: 'delete', content: null, kind: 'created' }])
      expect(plan.skipped).toEqual([])
    })

    it(`${layout}: known basis plus unknown final after uses legacy first kind`, () => {
      const first = recordChange(surfacePos(emptyCheckpoint(1), 10), mutation('original', 'changed', true))
      const unknown = mutation('changed', null, false)
      const checkpoints = layout === 'same-turn'
        ? [recordChange(first, unknown)]
        : [first, recordChange(surfacePos(emptyCheckpoint(2), 20), unknown)]
      const plan = planRollback(checkpoints, 1, 21)
      expect(plan.restored).toEqual([{ path, action: 'restore', content: 'original', kind: 'updated' }])
    })

    it(`${layout}: a later known mutation clears unknown after and restores net endpoint`, () => {
      const first = recordChange(surfacePos(emptyCheckpoint(1), 10), mutation('original', 'changed', true))
      const unknown = recordChange(first, mutation('changed', 'unobserved', false))
      const final = mutation('unobserved', 'final', true)
      const checkpoints = layout === 'same-turn'
        ? [recordChange(unknown, final)]
        : [unknown, recordChange(surfacePos(emptyCheckpoint(2), 20), final)]
      const plan = planRollback(checkpoints, 1, 21)
      expect(plan.restored).toEqual([{ path, action: 'restore', content: 'original', kind: 'updated' }])
    })
  }
})

describe('historical postimage normalization', () => {
  let home: string
  let previous: string | undefined
  const sessionId = 'legacy-net-state'
  const removed = '/legacy-removed.txt'
  const unknown = '/legacy-unknown.txt'

  it('normalizes legacy remove placeholder after to null before same-turn aggregation', () => {
    previous = process.env.DSH_HOME
    home = mkdtempSync(join(tmpdir(), 'rollback-net-state-'))
    process.env.DSH_HOME = home
    try {
      appendCheckpoint({ sessionId, turn: 1, path: removed, operation: 'update', before: 'old', after: 'changed' })
      appendCheckpoint({ sessionId, turn: 1, path: removed, operation: 'remove', before: 'changed', after: '' })
      const loaded = loadCheckpoints(sessionId)
      expect(loaded.get(1)?.get(removed)).toEqual({ operation: 'update', before: 'old', after: null })
      const fold = new SessionFold(10)
      fold.fold({ kind: 'turn-start', turn: 1, seq: 10 })
      fold.fold({ kind: 'fs-mutation', mutation: { path: removed, operation: 'update', before: 'old', after: null, afterKnown: true } })
      fold.fold({ kind: 'turn-end', turn: 1, seq: 11 })
      expect(planRollback(fold.snapshots(), 1, 11).restored).toEqual([{ path: removed, action: 'recover', content: 'old', kind: 'removed' }])
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('keeps missing non-remove after unknown, never inheriting an earlier postimage', () => {
    previous = process.env.DSH_HOME
    home = mkdtempSync(join(tmpdir(), 'rollback-net-state-'))
    process.env.DSH_HOME = home
    try {
      appendCheckpoint({ sessionId, turn: 1, path: unknown, operation: 'update', before: 'old', after: 'known' })
      appendCheckpoint({ sessionId, turn: 1, path: unknown, operation: 'update', before: 'known' })
      const loaded = loadCheckpoints(sessionId)
      expect(loaded.get(1)?.get(unknown)).toEqual({ operation: 'update', before: 'old' })
      const fold = new SessionFold(10)
      fold.fold({ kind: 'turn-start', turn: 1, seq: 10 })
      fold.fold({ kind: 'fs-mutation', mutation: { path: unknown, operation: 'update', before: 'old', after: null, afterKnown: false } })
      fold.fold({ kind: 'turn-end', turn: 1, seq: 11 })
      expect(planRollback(fold.snapshots(), 1, 11).restored).toEqual([{ path: unknown, action: 'restore', content: 'old', kind: 'updated' }])
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
      rmSync(home, { recursive: true, force: true })
    }
  })
})
