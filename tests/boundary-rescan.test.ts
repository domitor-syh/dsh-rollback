import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BoundaryRescan } from '../src/boundary-rescan.ts'
import type { FsMutation } from '../src/core/model.ts'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'rbk-rescan-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/**
 * A scanner over one session, against real files: display paths ARE host paths here,
 * so resolution is the identity function.
 */
function makeScanner(options: { watched?: readonly string[]; known?: Map<string, string> } = {}) {
  const records: { turn: number; mutation: FsMutation }[] = []
  const warnings: string[] = []
  const scanner = new BoundaryRescan({
    hostPathOf: async (_sessionId, path) => path,
    watchedPaths: () => options.watched ?? [],
    knownContent: () => options.known ?? new Map(),
    record: (_sessionId, turn, mutation) => { records.push({ turn, mutation }) },
    warn: message => { warnings.push(message) },
  })
  return { scanner, records, warnings }
}

describe('BoundaryRescan', () => {
  it('records a file a shell command removed, against the boundary turn', async () => {
    const file = join(root, 'watched.txt')
    await writeFile(file, 'content', 'utf8')
    const { scanner, records } = makeScanner()
    scanner.observe('s1', file, 'content')
    await unlink(file)

    await scanner.scan('s1', 5)
    expect(records).toEqual([{ turn: 5, mutation: { path: file, operation: 'update', before: 'content', after: '' } }])
  })

  it('records a disappearance once, not at every following boundary', async () => {
    const file = join(root, 'gone.txt')
    await writeFile(file, 'content', 'utf8')
    const { scanner, records } = makeScanner()
    scanner.observe('s1', file, 'content')
    await unlink(file)

    await scanner.scan('s1', 5)
    await scanner.scan('s1', 6)
    await scanner.scan('s1', 7)
    expect(records).toHaveLength(1)
  })

  it('records a swap when a shell command rewrote the file', async () => {
    const file = join(root, 'rewritten.txt')
    await writeFile(file, 'v1', 'utf8')
    const { scanner, records } = makeScanner()
    scanner.observe('s1', file, 'v1')

    await writeFile(file, 'v2', 'utf8')
    await scanner.scan('s1', 4)
    expect(records).toEqual([{ turn: 4, mutation: { path: file, operation: 'update', before: 'v1', after: 'v2' } }])
  })

  it('records nothing while the file is untouched', async () => {
    const file = join(root, 'same.txt')
    await writeFile(file, 'same', 'utf8')
    const { scanner, records } = makeScanner()
    scanner.observe('s1', file, 'same')

    await scanner.scan('s1', 4)
    await scanner.scan('s1', 5)
    expect(records).toEqual([])
  })

  it('keeps watching paths a restart only knows from the sidecar', async () => {
    const file = join(root, 'from-sidecar.txt')
    await writeFile(file, 'durable content', 'utf8')
    const { scanner, records } = makeScanner({
      watched: [file],
      known: new Map([[file, 'durable content']]),
    })
    scanner.prime('s1')
    await unlink(file)

    await scanner.scan('s1', 9)
    expect(records).toEqual([{ turn: 9, mutation: { path: file, operation: 'update', before: 'durable content', after: '' } }])
  })

  it('learns the content of a path it has never read, then notices a later change', async () => {
    const file = join(root, 'unread.txt')
    await writeFile(file, 'first', 'utf8')
    const { scanner, records } = makeScanner({ watched: [file] })
    scanner.prime('s1')

    // First boundary: nothing to restore yet, so nothing is recorded — but the
    // content is learned.
    await scanner.scan('s1', 3)
    expect(records).toEqual([])

    await writeFile(file, 'second', 'utf8')
    await scanner.scan('s1', 4)
    expect(records).toEqual([{ turn: 4, mutation: { path: file, operation: 'update', before: 'first', after: 'second' } }])
  })

  it('reports a file that vanished before it was ever read, and records nothing', async () => {
    // Recording it would abort the whole rollback (restore counts such a path as
    // skipped), so the scan tells the user instead.
    const file = join(root, 'never-read.txt')
    await writeFile(file, 'x', 'utf8')
    const { scanner, records, warnings } = makeScanner({ watched: [file] })
    scanner.prime('s1')
    await unlink(file)

    await scanner.scan('s1', 3)
    expect(records).toEqual([])
    expect(warnings.some(w => w.includes(file))).toBe(true)

    // And it does not repeat the warning at every boundary.
    await scanner.scan('s1', 4)
    expect(warnings).toHaveLength(1)
  })

  it('keeps watching after a rollback, without inventing changes', async () => {
    const file = join(root, 'rolled-back.txt')
    await writeFile(file, 'post-rollback', 'utf8')
    const { scanner, records } = makeScanner()
    scanner.observe('s1', file, 'pre-rollback')
    scanner.forget('s1')

    // The rollback rewrote this file; the next boundary re-learns it silently.
    await scanner.scan('s1', 8)
    expect(records).toEqual([])

    // The path is still watched, so a later shell change is caught against what it
    // learned rather than against the pre-rollback picture.
    await writeFile(file, 'changed-later', 'utf8')
    await scanner.scan('s1', 9)
    expect(records).toEqual([{
      turn: 9,
      mutation: { path: file, operation: 'update', before: 'post-rollback', after: 'changed-later' },
    }])
  })

  it('notices a file that comes back after being recorded missing', async () => {
    const file = join(root, 'back.txt')
    await writeFile(file, 'content', 'utf8')
    const { scanner, records } = makeScanner()
    scanner.observe('s1', file, 'content')
    await unlink(file)
    await scanner.scan('s1', 5)
    expect(records).toHaveLength(1)

    // The file tool recreates it: the plugin knows its content again, and a later
    // shell change is measured against THAT.
    await writeFile(file, 'recreated', 'utf8')
    scanner.observe('s1', file, 'recreated')
    await writeFile(file, 'recreated+', 'utf8')
    await scanner.scan('s1', 6)
    expect(records[1]).toEqual({
      turn: 6,
      mutation: { path: file, operation: 'update', before: 'recreated', after: 'recreated+' },
    })
  })

  it('never throws when a watched path cannot be resolved', async () => {
    const scanner = new BoundaryRescan({
      hostPathOf: async () => undefined,
      watchedPaths: () => ['unresolvable'],
      knownContent: () => new Map(),
      record: () => { throw new Error('must not be called') },
      warn: () => {},
    })
    scanner.prime('s1')
    await expect(scanner.scan('s1', 1)).resolves.toBeUndefined()
  })
})