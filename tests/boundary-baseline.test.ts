import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BoundaryRescan } from '../src/boundary-rescan.ts'
import type { FsMutation } from '../src/core/model.ts'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'rbk-baseline-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
function setup() {
  const records: FsMutation[] = []
  const saveBaseline = vi.fn()
  const scanner = new BoundaryRescan({
    hostPathOf: async (_s, path) => path, watchedPaths: () => [], knownContent: () => new Map(),
    saveBaseline, record: (_s, _t, mutation) => records.push(mutation), warn: () => {},
  })
  return { scanner, records, saveBaseline }
}
describe('explicit post-rollback baselines', () => {
  it('catches a deletion before the first rescan, including restored empty files', async () => {
    const { scanner, records, saveBaseline } = setup()
    for (const content of ['restored', '']) {
      const path = join(root, content === '' ? 'empty' : 'text')
      await writeFile(path, content)
      scanner.resetAfterRollback('s', [{ path, content }])
      await unlink(path)
      await scanner.scan('s', 4)
      expect(records.at(-1)).toEqual({ path, operation: 'remove', before: content, after: null })
    }
    expect(saveBaseline).toHaveBeenCalledTimes(2)
  })
  it('does not invent deletion when a rollback confirmed a path absent', async () => {
    const { scanner, records } = setup()
    const path = join(root, 'absent')
    scanner.resetAfterRollback('s', [{ path, content: null }])
    await scanner.scan('s', 4)
    await scanner.scan('s', 5)
    expect(records).toEqual([])
  })
  it('primes a baseline-only restored path and sees deletion after restart', async () => {
    const path = join(root, 'baseline-only')
    const records: FsMutation[] = []
    const scanner = new BoundaryRescan({
      hostPathOf: async (_s, p) => p, watchedPaths: () => [],
      knownContent: () => new Map([[path, { content: '', turn: null, missing: false }]]),
      record: (_s, _t, mutation) => records.push(mutation), warn: () => {},
    })
    scanner.prime('s')
    await scanner.scan('s', 9)
    expect(records).toEqual([{ path, operation: 'remove', before: '', after: null }])
  })
  it('preserves previous baseline for non-regular paths and latches the failed probe', async () => {
    const { scanner, records } = setup()
    const path = join(root, 'directory')
    scanner.observe('s', path, 'old')
    await mkdir(path)
    await expect(scanner.scan('s', 2)).rejects.toThrow('not a regular file')
    await expect(scanner.settled('s')).rejects.toThrow('not a regular file')
    expect(records).toEqual([])
    await rm(path, { recursive: true })
    await scanner.scan('s', 3)
    expect(records).toEqual([{ path, operation: 'remove', before: 'old', after: null }])
    // A later pass succeeding cannot undo the coverage gap without an explicit reset.
    await expect(scanner.settled('s')).rejects.toThrow('not a regular file')
    scanner.resetAfterRollback('s', [{ path, content: null }])
    await expect(scanner.settled('s')).resolves.toBeUndefined()
  })
  it('never clears persistence failure during a successful transient reset', async () => {
    const path = join(root, 'disk-full')
    const scanner = new BoundaryRescan({
      hostPathOf: async (_s, p) => p, watchedPaths: () => [], knownContent: () => new Map(),
      saveBaseline: () => {}, record: () => { throw new Error('disk full') }, warn: () => {},
    })
    scanner.observe('s', path, 'old')
    await expect(scanner.scan('s', 2)).rejects.toThrow('disk full')
    scanner.resetAfterRollback('s', [{ path, content: null }])
    scanner.clearTransientFailure('s')
    await expect(scanner.settled('s')).rejects.toThrow('disk full')
  })
  it('rejects failed baseline persistence before changing the in-memory baseline', async () => {
    const path = join(root, 'fail-reset')
    const scanner = new BoundaryRescan({
      hostPathOf: async (_s, p) => p, watchedPaths: () => [], knownContent: () => new Map(),
      saveBaseline: () => { throw new Error('baseline write failed') }, record: () => {}, warn: () => {},
    })
    expect(() => scanner.resetAfterRollback('s', [{ path, content: '' }])).toThrow('baseline write failed')
    await expect(scanner.settled('s')).rejects.toThrow('baseline write failed')
  })
})
