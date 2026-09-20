import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanupEmptyDirs } from '../src/empty-dirs.ts'

/** Wait long enough for a creation-time comparison to be unambiguous. */
async function tick(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 25))
}

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'rbk-dirclean-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('cleanupEmptyDirs', () => {
  it('removes the directories the span created once the deleted file leaves them empty', async () => {
    // Everything below `root` is created AFTER the span starts — which is what a
    // rollback of the turn that created it sees. (`root` itself comes from
    // `mkdtemp` before the span, so the walk stops there.)
    await tick()
    const spanStart = Date.now()
    await tick()
    const nested = join(root, 'outer', 'inner')
    await mkdir(nested, { recursive: true })
    const file = join(nested, 'f.txt')
    await writeFile(file, 'x', 'utf8')
    await rm(file)

    const report = await cleanupEmptyDirs([file], spanStart)
    expect(report.failed).toEqual([])
    // `root` predates the span, so the walk stops there. (`relative` keeps the
    // expectation separator-agnostic — CI runs this on Linux too.)
    expect(report.removed.map(p => relative(root, p))).toEqual([join('outer', 'inner'), 'outer'])
    expect(await readdir(root)).toEqual([])
  })

  it('keeps a directory that existed before the span even when it is empty', async () => {
    // The "rollback only the later turn" case: the directory came from an earlier
    // turn, so emptying it is all this rollback may do.
    const directory = join(root, 'older')
    await mkdir(directory, { recursive: true })
    const file = join(directory, 'f.txt')
    await writeFile(file, 'x', 'utf8')
    await tick()
    const spanStart = Date.now()
    await rm(file)

    const report = await cleanupEmptyDirs([file], spanStart)
    expect(report.removed).toEqual([])
    expect(await readdir(root)).toEqual(['older'])
  })

  it('keeps a directory that still holds something, and stops climbing there', async () => {
    const outer = join(root, 'outer')
    const inner = join(outer, 'inner')
    await tick()
    const spanStart = Date.now()
    await tick()
    await mkdir(inner, { recursive: true })
    const deleted = join(inner, 'f.txt')
    await writeFile(deleted, 'x', 'utf8')
    // A sibling keeps `inner` non-empty, and `outer` above it must then be kept too.
    await writeFile(join(inner, 'keep.txt'), 'x', 'utf8')
    await rm(deleted)

    const report = await cleanupEmptyDirs([deleted], spanStart)
    expect(report.removed).toEqual([])
    expect(await readdir(inner)).toEqual(['keep.txt'])
  })

  it('reports nothing to do when no files were deleted', async () => {
    expect(await cleanupEmptyDirs([], Date.now())).toEqual({ removed: [], failed: [] })
  })

  it('leaves the filesystem alone when the creation time is unavailable', async () => {
    const directory = join(root, 'later')
    await tick()
    const spanStart = Date.now()
    await tick()
    await mkdir(directory, { recursive: true })
    const file = join(directory, 'f.txt')
    await writeFile(file, 'x', 'utf8')
    await rm(file)

    // A span that starts in the future puts every real creation time before it,
    // which is how an unknown/absent creation time is treated: keep.
    const report = await cleanupEmptyDirs([file], Date.now() + 60_000)
    expect(report.removed).toEqual([])
    expect(await stat(directory)).toBeDefined()
  })
})