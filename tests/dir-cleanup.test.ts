import { describe, expect, it } from 'vitest'
import {
  parentDirOf,
  planEmptyDirCleanup,
  turnStartTimeMs,
  type DirProbe,
} from '../src/core/dir-cleanup.ts'

/** A probe over a literal map: unlisted directories do not exist. */
function probeOf(tree: Record<string, { entries: readonly string[]; birthtimeMs?: number }>): DirProbe {
  return {
    async entries(path) {
      return tree[path]?.entries ?? null
    },
    async birthtimeMs(path) {
      return tree[path]?.birthtimeMs
    },
  }
}

const SPAN = 1_000_000

/** A directory entry map for the common three-level fixture. */
function nestedTree(options: { innerCreated: number; outerCreated: number }): Record<string, { entries: readonly string[]; birthtimeMs?: number }> {
  return {
    // The deleted file is already gone by the time cleanup is planned.
    'E:\\outer\\inner': { entries: [], birthtimeMs: options.innerCreated },
    'E:\\outer': { entries: ['inner'], birthtimeMs: options.outerCreated },
    'E:\\': { entries: ['outer'], birthtimeMs: 1 },
  }
}

describe('turnStartTimeMs', () => {
  it('reads the opening time of the named turn', () => {
    const events = [
      { type: 'turn/start', time: 10, data: { turn: 1 } },
      { type: 'turn/start', time: 20, data: { turn: 2 } },
    ]
    expect(turnStartTimeMs(events, 2)).toBe(20)
    expect(turnStartTimeMs(events, 9)).toBeUndefined()
  })

  it('prefers the LAST start under a duplicated turn number', () => {
    // A session damaged by an older build holds a synthetic start and the real one
    // under one number, and the real turn is the later of the two.
    const events = [
      { type: 'turn/start', time: 10, data: { turn: 2 } },
      { type: 'turn/start', time: 30, data: { turn: 2 } },
    ]
    expect(turnStartTimeMs(events, 2)).toBe(30)
  })

  it('ignores a start without a usable timestamp', () => {
    expect(turnStartTimeMs([{ type: 'turn/start', data: { turn: 1 } }], 1)).toBeUndefined()
  })
})

describe('parentDirOf', () => {
  it('walks Windows paths up to the drive root and no further', () => {
    expect(parentDirOf('E:\\a\\b\\c.txt')).toBe('E:\\a\\b')
    expect(parentDirOf('E:\\a')).toBe('E:\\')
    expect(parentDirOf('E:\\')).toBeNull()
    expect(parentDirOf('E:\\a\\')).toBe('E:\\')
  })

  it('walks POSIX paths and stops at the filesystem root', () => {
    expect(parentDirOf('/home/u/c.txt')).toBe('/home/u')
    expect(parentDirOf('/home')).toBe('/')
    expect(parentDirOf('/')).toBeNull()
    expect(parentDirOf('relative.txt')).toBeNull()
  })
})

describe('planEmptyDirCleanup', () => {
  it('removes a chain the span created, deepest first', async () => {
    // `outer` still holds `inner` when the plan is computed, but `inner` is part of
    // the plan — so `outer` must be recognised as emptied by the time removal runs.
    const planned = await planEmptyDirCleanup(
      ['E:\\outer\\inner\\f.txt'],
      SPAN,
      probeOf(nestedTree({ innerCreated: SPAN + 10, outerCreated: SPAN + 5 })),
    )
    expect(planned).toEqual(['E:\\outer\\inner', 'E:\\outer'])
  })

  it('keeps a directory that predates the span, and stops climbing past it', async () => {
    // The turn-5 case: the file is deleted, but the directory came from turn 3.
    const planned = await planEmptyDirCleanup(
      ['E:\\outer\\inner\\f.txt'],
      SPAN,
      probeOf(nestedTree({ innerCreated: SPAN - 5_000, outerCreated: SPAN - 9_000 })),
    )
    expect(planned).toEqual([])
  })

  it('keeps a directory that still holds something, and stops climbing', async () => {
    const tree = {
      'E:\\full': { entries: ['keep.txt'], birthtimeMs: SPAN + 10 },
      'E:\\': { entries: ['full'], birthtimeMs: SPAN + 1 },
    }
    expect(await planEmptyDirCleanup(['E:\\full\\f.txt'], SPAN, probeOf(tree))).toEqual([])
  })

  it('keeps a directory whose creation time is unknown', async () => {
    const tree = { 'E:\\unknown': { entries: [] } }
    expect(await planEmptyDirCleanup(['E:\\unknown\\f.txt'], SPAN, probeOf(tree))).toEqual([])
  })

  it('keeps a directory it cannot read', async () => {
    // `entries` returning null stands for "does not exist or cannot be read".
    expect(await planEmptyDirCleanup(['E:\\gone\\f.txt'], SPAN, probeOf({}))).toEqual([])
  })

  it('plans a shared parent once, and still climbs above it', async () => {
    const tree = {
      'E:\\a\\one': { entries: [], birthtimeMs: SPAN + 3 },
      'E:\\a': { entries: ['one'], birthtimeMs: SPAN + 2 },
      'E:\\': { entries: ['a'], birthtimeMs: 1 },
    }
    const planned = await planEmptyDirCleanup(['E:\\a\\one\\x.txt', 'E:\\a\\one\\y.txt'], SPAN, probeOf(tree))
    expect(planned).toEqual(['E:\\a\\one', 'E:\\a'])
  })

  it('climbs through an already-planned directory reached from another file', async () => {
    const tree = {
      'E:\\a\\deep': { entries: [], birthtimeMs: SPAN + 4 },
      'E:\\a': { entries: ['deep'], birthtimeMs: SPAN + 2 },
      'E:\\': { entries: ['a'], birthtimeMs: 1 },
    }
    const planned = await planEmptyDirCleanup(['E:\\a\\deep\\x.txt', 'E:\\a\\y.txt'], SPAN, probeOf(tree))
    expect(planned).toEqual(['E:\\a\\deep', 'E:\\a'])
  })

  it('never plans above a drive root', async () => {
    const tree = { 'E:\\': { entries: [], birthtimeMs: SPAN + 1 } }
    // A file directly under the root: the walk reaches the root and stops there.
    expect(await planEmptyDirCleanup(['E:\\f.txt'], SPAN, probeOf(tree))).toEqual(['E:\\'])
  })

  it('never removes the path it is told to protect', async () => {
    // The workspace root predates every turn, so it can only look removable if the
    // rule misfired — and removing it would not be recoverable.
    const planned = await planEmptyDirCleanup(
      ['E:\\ws\\new\\f.txt'],
      SPAN,
      probeOf({
        'E:\\ws\\new': { entries: [], birthtimeMs: SPAN + 5 },
        'E:\\ws': { entries: ['new'], birthtimeMs: SPAN + 1 },
      }),
      'E:\\ws',
    )
    expect(planned).toEqual(['E:\\ws\\new'])
  })

  it('matches the protected path case-insensitively on Windows', async () => {
    const planned = await planEmptyDirCleanup(
      ['E:\\WS\\new\\f.txt'],
      SPAN,
      probeOf({ 'E:\\WS\\new': { entries: [], birthtimeMs: SPAN + 5 }, 'E:\\WS': { entries: ['new'], birthtimeMs: SPAN + 1 } }),
      'e:\\ws',
    )
    expect(planned).toEqual(['E:\\WS\\new'])
  })
})