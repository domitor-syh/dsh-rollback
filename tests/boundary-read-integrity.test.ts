import { beforeEach, describe, expect, it, vi } from 'vitest'
import { lstat, readFile } from 'node:fs/promises'
import { BoundaryRescan } from '../src/boundary-rescan.ts'

vi.mock('node:fs/promises', () => ({ lstat: vi.fn(), readFile: vi.fn() }))

const base = { size: 4, mtimeMs: 10, ctimeMs: 10, dev: 1, ino: 2, isFile: () => true }
beforeEach(() => { vi.resetAllMocks() })

function scanner() {
  const record = vi.fn()
  const instance = new BoundaryRescan({
    hostPathOf: async (_sessionId, path) => path,
    watchedPaths: () => [], knownContent: () => new Map(), record, warn: () => {},
  })
  instance.observe('s', 'file.txt', 'old', 1)
  return { instance, record }
}

// Execute actual scanner probes with deterministically raced stat/read results.
describe('BoundaryRescan read integrity', () => {
  it.each([
    ['replacement inode', { ino: 3 }],
    ['replacement device', { dev: 2 }],
    ['same-size same-mtime write', { ctimeMs: 11 }],
    ['changed size', { size: 5 }],
  ])('rejects %s between pre-read and post-read stat', async (_name, changed) => {
    vi.mocked(lstat).mockResolvedValueOnce(base as never)
      .mockResolvedValueOnce(base as never).mockResolvedValueOnce({ ...base, ...changed } as never)
    vi.mocked(readFile).mockResolvedValue(Buffer.from('text') as never)
    const { instance, record } = scanner()
    await expect(instance.captureDispatch('s')).rejects.toThrow('changed while reading')
    await expect(instance.settled('s')).rejects.toThrow('changed while reading')
    expect(record).not.toHaveBeenCalled()
  })

  it('rejects a short read even if the path stats agree', async () => {
    vi.mocked(lstat).mockResolvedValue(base as never)
    vi.mocked(readFile).mockResolvedValue(Buffer.from('txt') as never)
    const { instance, record } = scanner()
    await expect(instance.captureDispatch('s')).rejects.toThrow('changed while reading')
    expect(record).not.toHaveBeenCalled()
  })

  it('does not follow a symlink as a regular watched file', async () => {
    vi.mocked(lstat).mockResolvedValue({ ...base, isFile: () => false } as never)
    const { instance, record } = scanner()
    await expect(instance.captureDispatch('s')).rejects.toThrow('not a regular file')
    expect(readFile).not.toHaveBeenCalled()
    expect(record).not.toHaveBeenCalled()
  })
})
