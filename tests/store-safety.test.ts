import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendCheckpoint, loadCallCoverage, loadCheckpoints, loadObservedCalls, loadObservedReceipts, loadRollbackBaseline, loadWatched, saveRollbackBaseline } from '../src/store.ts'

let home: string
let previousHome: string | undefined
const fileOf = (id: string) => join(home, 'storages', 'dsh-rollback', 'checkpoints-v2', 'sessions', `s-${Buffer.from(id, 'utf16le').toString('hex')}.jsonl`)
const legacyOf = (id: string) => join(home, 'storages', 'dsh-rollback', 'checkpoints-v2', `${id.replace(/[\\/:*?"<>|]/g, '_')}.jsonl`)
const row = (sessionId: string, turn: number, after = 'after') => ({ sessionId, turn, path: 'p', operation: 'update' as const, before: 'before', after })
beforeEach(async () => {
  previousHome = process.env.DSH_HOME
  home = await mkdtemp(join(tmpdir(), 'rbk-store-safe-'))
  process.env.DSH_HOME = home
})
afterEach(async () => {
  vi.restoreAllMocks()
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  await rm(home, { recursive: true, force: true })
})

describe('safe checkpoint storage', () => {
  it.each(['legacy', 'primary'] as const)('preserves repeated identityless receipts in one %s file', async location => {
    appendCheckpoint(row('s', 1))
    const forward = { ...row('s', 1, 'B'), before: 'A' }
    const backward = { ...row('s', 1, 'A'), before: 'B' }
    const records = [forward, backward, forward]
    await writeFile(fileOf('s'), location === 'primary' ? records.map(value => JSON.stringify(value)).join('\n') + '\n' : '')
    if (location === 'legacy') await writeFile(legacyOf('s'), records.map(value => JSON.stringify(value)).join('\n') + '\n')
    for (let i = 0; i < 3; i++) {
      expect(loadCheckpoints('s').get(1)?.get('p')).toEqual({ operation: 'update', before: 'A', after: 'B' })
      expect(loadWatched('s').get('p')?.content).toBe('B')
    }
    if (location === 'legacy') expect((await readFile(fileOf('s'), 'utf8')).trim().split('\n')).toHaveLength(3)
  })
  it('cancels only the copied occurrence count across files and preserves later receipt order', async () => {
    const forward = { ...row('s', 1, 'B'), before: 'A' }
    const backward = { ...row('s', 1, 'A'), before: 'B' }
    appendCheckpoint(row('s', 1))
    await writeFile(legacyOf('s'), JSON.stringify(forward) + '\n')
    await writeFile(fileOf('s'), [forward, backward, forward].map(value => JSON.stringify(value)).join('\n') + '\n')
    for (let i = 0; i < 3; i++) expect(loadCheckpoints('s').get(1)?.get('p')).toEqual({ operation: 'update', before: 'A', after: 'B' })
    expect((await readFile(fileOf('s'), 'utf8')).trim().split('\n')).toHaveLength(3)
    appendCheckpoint(backward)
    expect(loadCheckpoints('s').get(1)?.get('p')?.after).toBe('A')
    appendCheckpoint(forward)
    expect(loadCheckpoints('s').get(1)?.get('p')?.after).toBe('B')
    expect((await readFile(fileOf('s'), 'utf8')).trim().split('\n')).toHaveLength(5)
  })
  it('does not collapse missing/null or call metadata migration evidence', async () => {
    appendCheckpoint(row('s', 1))
    const missing = { sessionId: 's', turn: 1, path: 'p', operation: 'update', before: 'A' }
    const observed = { ...missing, after: null }
    await writeFile(legacyOf('s'), JSON.stringify(missing) + '\n')
    await writeFile(fileOf('s'), [missing, observed].map(value => JSON.stringify(value)).join('\n') + '\n')
    expect(loadCheckpoints('s').get(1)?.get('p')).toEqual({ operation: 'update', before: 'A', after: null })
    expect((await readFile(fileOf('s'), 'utf8')).trim().split('\n')).toHaveLength(2)
    const unchanged = { ...row('s', 2, 'same'), before: 'same', unchanged: true, callId: 'no-op' }
    await writeFile(legacyOf('s'), JSON.stringify(unchanged) + '\n')
    await writeFile(fileOf('s'), [unchanged, { ...unchanged, callId: 'another-no-op' }].map(value => JSON.stringify(value)).join('\n') + '\n')
    expect(loadObservedCalls('s')).toEqual(new Set(['no-op', 'another-no-op']))
  })
  it('deduplicates explicit receipt identities without dropping separately identified repetitions', async () => {
    const forward = { ...row('s', 1, 'B'), before: 'A', _id: 'first' }
    const backward = { ...row('s', 1, 'A'), before: 'B', _id: 'second' }
    appendCheckpoint(row('s', 1))
    await writeFile(legacyOf('s'), JSON.stringify(forward) + '\n')
    await writeFile(fileOf('s'), [forward, backward, { ...forward, _id: 'third' }, backward].map(value => JSON.stringify(value)).join('\n') + '\n')
    expect(loadCheckpoints('s').get(1)?.get('p')).toEqual({ operation: 'update', before: 'A', after: 'B' })
    expect((await readFile(fileOf('s'), 'utf8')).trim().split('\n')).toHaveLength(3)
  })
  it('retains legacy baseline hash keys after repeated receipt migration and accepts UUID appends', async () => {
    appendCheckpoint(row('s', 1))
    const forward = { ...row('s', 1, 'B'), before: 'A' }
    const backward = { ...row('s', 1, 'A'), before: 'B' }
    await writeFile(fileOf('s'), '')
    await writeFile(legacyOf('s'), [forward, backward, forward].map(value => JSON.stringify(value)).join('\n') + '\n')
    saveRollbackBaseline('s', [{ path: 'p', content: 'external' }])
    const baselinePath = join(home, 'storages', 'dsh-rollback', 'baselines-v1', `s-${Buffer.from('s', 'utf16le').toString('hex')}.json`)
    const baseline = await readFile(baselinePath, 'utf8')
    loadCheckpoints('s')
    expect(loadWatched('s').get('p')).toEqual({ content: 'external', turn: null, missing: false })
    expect(await readFile(baselinePath, 'utf8')).toBe(baseline)
    appendCheckpoint(forward)
    expect(loadWatched('s').get('p')?.content).toBe('B')
  })
  it('exports only exact nonempty call identities including no-op receipts', () => {
    appendCheckpoint(row('s', 1))
    appendCheckpoint({ ...row('s', 1), callId: 'changed' })
    appendCheckpoint({ ...row('s', 1, 'same'), before: 'same', unchanged: true, callId: 'unchanged' })
    expect(loadObservedCalls('s')).toEqual(new Set(['changed', 'unchanged']))
  })
  it('exports turn/path scoped call coverage and preserves legacy multiplicity', async () => {
    appendCheckpoint({ ...row('s', 1), callId: 'call' })
    appendCheckpoint({ ...row('s', 2, 'same'), path: 'q', before: 'same', unchanged: true, callId: 'call' })
    await writeFile(legacyOf('s'), [row('s', 1), row('s', 1)].map(value => JSON.stringify(value)).join('\n') + '\n')
    expect(loadObservedReceipts('s')).toEqual([{ turn: 1, path: 'p', callId: 'call' }, { turn: 2, path: 'q', callId: 'call' }])
    expect(loadCallCoverage('s')).toEqual(new Map([
      [1, { calls: new Set(['call']), legacyPaths: new Set(['p']), paths: new Map([['p', { calls: new Set(['call']), legacyCount: 2 }]]) }],
      [2, { calls: new Set(['call']), legacyPaths: new Set(), paths: new Map([['q', { calls: new Set(['call']), legacyCount: 0 }]]) }],
    ]))
    loadCheckpoints('s')
    expect(loadCallCoverage('s').get(1)?.paths.get('p')?.legacyCount).toBe(2)
  })
  it('preserves the first before/operation and the latest observed after, including empty', () => {
    appendCheckpoint({ ...row('s', 1), before: '' })
    appendCheckpoint({ ...row('s', 1, ''), before: 'intermediate' })
    const withoutAfter = row('s', 1)
    delete (withoutAfter as { after?: string }).after
    appendCheckpoint(withoutAfter)
    expect(loadCheckpoints('s').get(1)?.get('p')).toEqual({ operation: 'update', before: '' })
    // An unknown later observation must remain unknown to avoid a phantom rewrite.
    expect(loadWatched('s').get('p')?.content).toBeNull()
  })
  it.each([undefined, ''] as const)('normalizes legacy removal postimage %s without confusing an empty preimage with absence', after => {
    appendCheckpoint({ sessionId: 's', turn: 1, path: 'p', operation: 'remove', before: '', ...(after !== undefined ? { after } : {}) })
    expect(loadCheckpoints('s').get(1)?.get('p')).toEqual({ operation: 'remove', before: '', ...(after !== undefined ? { after: null } : {}) })
  })
  it('keeps unknown final removal after a same-turn creation unknown', () => {
    appendCheckpoint({ sessionId: 's', turn: 1, path: 'p', operation: 'create', before: null, after: 'created' })
    appendCheckpoint({ sessionId: 's', turn: 1, path: 'p', operation: 'remove', before: 'created' })
    expect(loadCheckpoints('s').get(1)?.get('p')).toEqual({ operation: 'create', before: null })
  })
  it('keeps a known empty after instead of converting it to unknown', () => {
    appendCheckpoint(row('s', 1, ''))
    expect(loadWatched('s').get('p')?.content).toBe('')
  })
  it('uses collision-free case-insensitive safe filenames', async () => {
    const ids = ['a/b', 'a_b', 'A', 'a', 's-YS9i', '大小', '\ud800', '\ud801']
    for (const id of ids) appendCheckpoint(row(id, 1, id))
    const files = await readdir(join(home, 'storages', 'dsh-rollback', 'checkpoints-v2', 'sessions'))
    expect(new Set(files.map(file => file.toLowerCase())).size).toBe(ids.length)
    for (const id of ids) expect(loadCheckpoints(id).get(1)?.get('p')?.after).toBe(id)
  })
  it('migrates legacy collisions without dropping the other session or reversing record order', async () => {
    await mkdir(join(home, 'storages', 'dsh-rollback', 'checkpoints-v2'), { recursive: true })
    const legacy = [row('a/b', 1, 'old'), row('a_b', 1, 'other')].map(value => JSON.stringify(value)).join('\n') + '\n'
    await writeFile(legacyOf('a/b'), legacy)
    appendCheckpoint({ ...row('a/b', 1, 'new'), before: 'old' })
    expect(loadCheckpoints('a/b').get(1)?.get('p')).toEqual({ operation: 'update', before: 'before', after: 'new' })
    expect(await readFile(legacyOf('a/b'), 'utf8')).toBe(legacy)
    expect(loadCheckpoints('a_b').get(1)?.get('p')?.after).toBe('other')
    expect(loadCheckpoints('a/b').get(1)?.get('p')?.after).toBe('new')
  })
  it('retains original bytes after an invalid compaction input and reports corruption', async () => {
    appendCheckpoint(row('s', 1))
    const path = fileOf('s')
    const original = await readFile(path, 'utf8')
    await writeFile(path, original + 'bad json\n', 'utf8')
    const report: string[] = []
    expect(() => loadCheckpoints('s', undefined, text => report.push(text))).toThrow('corrupt line')
    expect(report[0]).toContain('corrupt')
    expect(await readFile(path, 'utf8')).toBe(original + 'bad json\n')
  })
  it('throws non-ENOENT reads and corrupt rows without inventing an empty replay', async () => {
    await mkdir(fileOf('s'), { recursive: true })
    expect(() => loadCheckpoints('s')).toThrow('unreadable durable store')
    await rm(fileOf('s'), { recursive: true })
    await writeFile(fileOf('s'), 'bad json\n')
    const report = vi.fn()
    expect(() => loadCheckpoints('s', undefined, report)).toThrow('corrupt line')
    expect(report).toHaveBeenCalled()
    expect(await readFile(fileOf('s'), 'utf8')).toBe('bad json\n')
    expect(() => loadWatched('s')).toThrow('corrupt line')
  })
  it('replays many same-path records around a restored baseline without changing stored keys', async () => {
    for (let i = 0; i < 256; i++) appendCheckpoint(row('s', 1, `old-${i}`))
    saveRollbackBaseline('s', [{ path: 'p', content: '' }])
    const baselinePath = join(home, 'storages', 'dsh-rollback', 'baselines-v1', `s-${Buffer.from('s', 'utf16le').toString('hex')}.json`)
    const bytes = await readFile(baselinePath, 'utf8')
    expect(loadWatched('s').get('p')).toEqual({ content: '', turn: null, missing: false })
    appendCheckpoint({ ...row('s', 2), operation: 'remove', before: '' })
    expect(loadWatched('s').get('p')).toEqual({ content: '', turn: 2, missing: true })
    appendCheckpoint(row('s', 3, 'new'))
    expect(loadWatched('s').get('p')).toEqual({ content: 'new', turn: 3, missing: false })
    expect(await readFile(baselinePath, 'utf8')).toBe(bytes)
  })

  it('distinguishes legacy undefined keys from empty keys and accepts duplicate keys', async () => {
    const baselinePath = join(home, 'storages', 'dsh-rollback', 'baselines-v1', `s-${Buffer.from('s', 'utf16le').toString('hex')}.json`)
    const records = [
      { ...row('s', 1, 'legacy-write'), path: 'legacy', _id: 'legacy-key' },
      { ...row('s', 1, ''), path: 'empty', _id: 'empty-key' },
      { ...row('s', 1, 'undone'), path: 'duplicate', _id: 'duplicate-key' },
      { ...row('s', 1), path: 'removed', operation: 'remove', _id: 'remove-key' },
    ]
    appendCheckpoint(row('s', 1))
    await writeFile(fileOf('s'), records.map(record => JSON.stringify(record)).join('\n') + '\n')
    saveRollbackBaseline('s', [])
    await writeFile(baselinePath, JSON.stringify([
      { path: 'legacy', content: null },
      { path: 'empty', content: null, checkpointKeys: [] },
      { path: 'duplicate', content: '', checkpointKeys: ['duplicate-key', 'duplicate-key'] },
      { path: 'removed', content: 'baseline', checkpointKeys: [] },
    ]))
    expect(loadWatched('s')).toEqual(new Map([
      ['empty', { content: '', turn: 1, missing: false }],
      ['removed', { content: 'before', turn: 1, missing: true }],
      ['legacy', { content: null, turn: null, missing: true }],
      ['duplicate', { content: '', turn: null, missing: false }],
    ]))
  })

  it('retains legacy hash-derived checkpoint keys after baseline reset', async () => {
    await mkdir(join(home, 'storages', 'dsh-rollback', 'checkpoints-v2'), { recursive: true })
    await writeFile(legacyOf('s'), JSON.stringify(row('s', 1, 'legacy')) + '\n')
    saveRollbackBaseline('s', [{ path: 'p', content: null }])
    expect(loadWatched('s').get('p')).toEqual({ content: null, turn: null, missing: true })
    appendCheckpoint(row('s', 2, ''))
    expect(loadWatched('s').get('p')).toEqual({ content: '', turn: 2, missing: false })
  })

  it('keeps explicit baselines across dead-turn filtering, compaction, and newer writes', () => {
    appendCheckpoint(row('s', 1, 'undone'))
    saveRollbackBaseline('s', [{ path: 'p', content: '' }, { path: 'absent', content: null }])
    expect(loadWatched('s', new Set([1])).get('p')).toEqual({ content: '', turn: null, missing: false })
    loadCheckpoints('s', new Set([1]))
    expect(loadWatched('s').get('p')?.content).toBe('')
    expect(loadWatched('s').get('absent')).toEqual({ content: null, turn: null, missing: true })
    appendCheckpoint(row('s', 2, 'new after'))
    expect(loadWatched('s').get('p')?.content).toBe('new after')
    saveRollbackBaseline('s', [{ path: 'p', content: 'restored again' }])
    expect(loadWatched('s').get('p')?.content).toBe('restored again')
  })
})
