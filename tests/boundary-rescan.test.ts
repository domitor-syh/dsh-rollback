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
function makeScanner(options: { watched?: readonly string[]; known?: Map<string, { content: string | null; turn: number | null }> } = {}) {
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
  it.each([
    ['invalid-utf8', Buffer.from([0x61, 0xff, 0x62])],
    ['binary-nul', Buffer.from([0x61, 0, 0x62])],
  ])('rejects %s rather than persisting a lossy preimage', async (_label, bytes) => {
    const file = join(root, 'unsafe.txt')
    await writeFile(file, bytes)
    const { scanner, records } = makeScanner()
    scanner.observe('s1', file, 'old-text', 1)
    await expect(scanner.captureDispatch('s1')).rejects.toThrow('lossless UTF-8')
    await expect(scanner.settled('s1')).rejects.toThrow('lossless UTF-8')
    expect(records).toEqual([])
  })

  it('preserves UTF-8 BOM and Unicode in a deletion preimage', async () => {
    const file = join(root, 'bom.txt')
    const original = '\uFEFF中文\r\nlast line'
    await writeFile(file, original, 'utf8')
    const { scanner, records } = makeScanner()
    scanner.observe('s1', file, 'old-text', 1)
    const snapshot = await scanner.captureDispatch('s1')
    await unlink(file)
    await scanner.finishDispatch('s1', 2, snapshot)
    expect(records).toEqual([{ turn: 2, mutation: { path: file, operation: 'remove', before: original, after: null } }])
  })

  it('takes external live content as a dispatch basis without recording or replacing history', async () => {
    const file = join(root, 'external.txt')
    await writeFile(file, 'user-edited')
    const { scanner, records } = makeScanner()
    scanner.observe('s1', file, 'old-model-after', 1)
    const snapshot = await scanner.captureDispatch('s1')
    expect(records).toEqual([])
    expect(snapshot.get(file)?.lastKnown).toBe('user-edited')
    await scanner.finishDispatch('s1', 2, snapshot)
    expect(records).toEqual([])
    const next = await scanner.captureDispatch('s1')
    await writeFile(file, 'new-model-after')
    await scanner.finishDispatch('s1', 3, next)
    expect(records).toEqual([{ turn: 3, mutation: { path: file, operation: 'update', before: 'user-edited', after: 'new-model-after' } }])
  })

  it('keeps overlapping dispatch observations independent', async () => {
    const file = join(root, 'overlap.txt')
    await writeFile(file, 'user-edited')
    const { scanner, records } = makeScanner()
    scanner.observe('s1', file, 'old-model-after', 1)
    const first = await scanner.captureDispatch('s1')
    await writeFile(file, 'first-tool-after')
    const second = await scanner.captureDispatch('s1')
    await scanner.finishDispatch('s1', 2, first)
    expect(records[0]?.mutation.before).toBe('user-edited')
    await scanner.finishDispatch('s1', 2, second)
    expect(records).toHaveLength(1)
    expect(second.get(file)?.lastKnown).toBe('first-tool-after')
  })

  it('does not replace a newer authoritative observation with an old dispatch snapshot', async () => {
    const file = join(root, 'newer.txt')
    await writeFile(file, 'before')
    const { scanner } = makeScanner()
    scanner.observe('s1', file, 'before', 1)
    const old = await scanner.captureDispatch('s1')
    await writeFile(file, 'after')
    scanner.observe('s1', file, 'after', 3)
    await scanner.finishDispatch('s1', 2, old)
    const fresh = await scanner.captureDispatch('s1')
    expect(fresh.get(file)?.lastSeenTurn).toBe(3)
  })

  it('binds a dispatch snapshot to one session and one finish', async () => {
    const file = join(root, 'single-use.txt')
    await writeFile(file, 'before')
    const { scanner, records } = makeScanner()
    scanner.observe('s1', file, 'before', 1)
    const snapshot = await scanner.captureDispatch('s1')
    await writeFile(file, 'after')
    await scanner.finishDispatch('s1', 2, snapshot)
    await expect(scanner.finishDispatch('s1', 3, snapshot)).rejects.toThrow('已完成')
    expect(records).toHaveLength(1)
    await expect(scanner.settled('s1')).rejects.toThrow('已完成')
    const fresh = await scanner.captureDispatch('s1')
    await scanner.finishDispatch('s1', 4, fresh)
    await expect(scanner.settled('s1')).rejects.toThrow('已完成')
  })

  it('records a file a shell command removed, against the boundary turn', async () => {
    const file = join(root, 'watched.txt')
    await writeFile(file, 'content', 'utf8')
    const { scanner, records } = makeScanner()
    scanner.observe('s1', file, 'content')
    await unlink(file)

    await scanner.scan('s1', 5)
    expect(records).toEqual([{ turn: 5, mutation: { path: file, operation: 'remove', before: 'content', after: null } }])
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
      known: new Map([[file, { content: 'durable content', turn: 5 }]]),
    })
    scanner.prime('s1')
    await unlink(file)

    await scanner.scan('s1', 9)
    // The finding belongs to the boundary that produced it. Recording it under turn 6
    // (the old `lastSeenTurn + 1` rule) claimed a turn whose own boundary had already
    // seen the file intact had deleted it, and — measured on the desktop 2026-10-02 —
    // it filed a deletion under the turn BEFORE the one that caused it, so rolling back
    // the causing turn planned a window that excluded the removal and the `找回` entry
    // disappeared from the dialog.
    //
    // The tradeoff is stated rather than hidden: if a file was really deleted long
    // before a late prime, this now offers it as a finding of the first scanned turn.
    // That costs a restore entry that restores nothing (the file is already gone and its
    // pre-deletion content is what goes back), while the old rule cost a MISSING entry
    // on the very turn that did the deleting — one is cosmetic, the other loses the
    // user's file from the preview.
    expect(records).toEqual([{ turn: 9, mutation: { path: file, operation: 'remove', before: 'durable content', after: null } }])
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

  it('treats a tool that never reported its content as unknown, not as empty', async () => {
    // The `str_replace_editor` shape: the plugin watched the path but only knows the
    // before-state. Learning "empty" here would record a phantom rewrite whose
    // restore content is an empty string.
    const file = join(root, 'rendered.txt')
    await writeFile(file, 'real content', 'utf8')
    const { scanner, records } = makeScanner()
    scanner.observe('s1', file, null)

    await scanner.scan('s1', 3)
    expect(records).toEqual([])

    await writeFile(file, 'changed later', 'utf8')
    await scanner.scan('s1', 4)
    expect(records).toEqual([{
      turn: 4,
      mutation: { path: file, operation: 'update', before: 'real content', after: 'changed later' },
    }])
  })

  it('reports a file that vanished before it was ever read, and records nothing', async () => {
    // Recording it would abort the whole rollback (restore counts such a path as
    // skipped), so the scan tells the user instead.
    const file = join(root, 'never-read.txt')
    await writeFile(file, 'x', 'utf8')
    const { scanner, records, warnings } = makeScanner({ watched: [file] })
    scanner.prime('s1')
    await unlink(file)

    await expect(scanner.scan('s1', 3)).rejects.toThrow('disappeared before')
    expect(records).toEqual([])
    expect(warnings.some(w => w.includes(file))).toBe(true)

    // And it does not repeat the warning at every boundary.
    await expect(scanner.scan('s1', 4)).rejects.toThrow('disappeared before')
    await expect(scanner.settled('s1')).rejects.toThrow('disappeared before')
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

  it('records a confirmed missing path as a create when it reappears', async () => {
    const file = join(root, 'recreated.txt')
    const { scanner, records } = makeScanner({ known: new Map([[file, { content: null, turn: 1, missing: true }]]) })
    scanner.prime('s1')
    await writeFile(file, 'new', 'utf8')
    await scanner.scan('s1', 2)
    expect(records).toEqual([{ turn: 2, mutation: { path: file, operation: 'create', before: null, after: 'new' } }])
  })
  it('rejects when a watched path cannot be resolved', async () => {
    const scanner = new BoundaryRescan({
      hostPathOf: async () => undefined,
      watchedPaths: () => ['unresolvable'],
      knownContent: () => new Map(),
      record: () => { throw new Error('must not be called') },
      warn: () => {},
    })
    scanner.prime('s1')
    await expect(scanner.scan('s1', 1)).rejects.toThrow('Cannot resolve')
    await expect(scanner.settled('s1')).rejects.toThrow('Cannot resolve')
  })

  it('settles only after a running scan has recorded what it found', async () => {
    // A rollback can be asked for the instant a turn ends, while the scan that turn
    // triggered is still reading. Planning before it settles would miss the change.
    const file = join(root, 'slow.txt')
    await writeFile(file, 'content', 'utf8')
    let release = (): void => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    const records: { turn: number; mutation: FsMutation }[] = []
    const scanner = new BoundaryRescan({
      hostPathOf: async (_sessionId, path) => { await gate; return path },
      watchedPaths: () => [],
      knownContent: () => new Map(),
      record: (_sessionId, turn, mutation) => { records.push({ turn, mutation }) },
      warn: () => {},
    })
    scanner.observe('s1', file, 'content')
    await unlink(file)

    void scanner.scan('s1', 3)
    let settled = false
    const waiting = scanner.settled('s1').then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    release()
    await waiting
    expect(settled).toBe(true)
    expect(records).toHaveLength(1)
  })

  it('runs an anchor requested while a scan was already in flight', async () => {
    // The newer anchor must still be scanned: a finding must never be attributed to
    // a turn the user has already left behind.
    const file = join(root, 'queued.txt')
    await writeFile(file, 'content', 'utf8')
    let release = (): void => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    let lookups = 0
    const scanner = new BoundaryRescan({
      hostPathOf: async (_sessionId, path) => { lookups += 1; await gate; return path },
      watchedPaths: () => [],
      knownContent: () => new Map(),
      record: () => {},
      warn: () => {},
    })
    scanner.observe('s1', file, 'content')

    void scanner.scan('s1', 3)
    void scanner.scan('s1', 4)
    release()
    await scanner.settled('s1')
    expect(lookups).toBe(2)
  })
})