import type {} from '../src/dsh-types.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RollbackService } from '../src/service.ts'
import { appendCheckpoint } from '../src/store.ts'
import { loadTransaction } from '../src/transaction-store.ts'

type Event = { type: string; seq: number; data: any; surfaceOp?: any }
let root: string
let previous: string | undefined
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'rollback-service-')); previous = process.env.DSH_HOME; process.env.DSH_HOME = root })
afterEach(() => { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; rmSync(root, { recursive: true, force: true }) })

function harness(paths = [join(root, 'file.txt')], operation: 'update' | 'create' = 'update') {
  const events: Event[] = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'system/message', seq: 1, data: {}, surfaceOp: 'append' },
    { type: 'user/message', seq: 2, data: { id: 'user' }, surfaceOp: 'append' },
    { type: 'turn/end', seq: 3, data: { turn: 1 } },
  ]
  const handlers = new Map<string, (...args: any[]) => any>()
  const files = new Map(paths.map(path => [path, 'new']))
  for (const path of paths) {
    writeFileSync(path, 'new')
    appendCheckpoint({ sessionId: 'session', turn: 1, path, operation, before: operation === 'create' ? null : 'old', after: 'new' })
  }
  const session = {
    id: 'session', header: { cwd: root }, surface: { nodes: [1, 2] },
    snapshotEvents: () => [...events],
    append: vi.fn((type: string, data: any, options: any) => {
      const event = { type, data, seq: events.length, ...options }
      events.push(event)
      if (options?.surfaceOp !== undefined) {
        session.surface.nodes = options.surfaceOp === 'append' ? [...session.surface.nodes, event.seq] : [1, event.seq]
      }
      handlers.get('session/event')?.(session, event)
      return event
    }),
  }
  let mode = 'danger-full-access'
  const fs = {
    resolve: vi.fn(async (path: string) => ({ displayPath: path, targetKey: path })),
    lstat: vi.fn(async (path: string) => existsSync(path) ? { type: 'file' } : undefined),
    contains: (parent: { displayPath: string }, target: { displayPath: string }) => target.displayPath.startsWith(parent.displayPath + '\\'),
    processPath: (target: { displayPath: string }) => target.displayPath,
    processPathFromHostPath: (path: string) => path,
    stat: vi.fn(async (target: { displayPath: string }) => files.has(target.displayPath) ? { type: 'file', size: files.get(target.displayPath)!.length } : undefined),
    readText: vi.fn(async (target: { displayPath: string }) => files.get(target.displayPath)!),
    writeText: vi.fn(async (target: { displayPath: string }, content: string, _expected?: unknown, _signal?: AbortSignal, _policy?: unknown) => { files.set(target.displayPath, content); return { version: 'new-version' } }),
  }
  const cleanups: (() => unknown)[] = []
  const ctx = {
    effect: (execute: () => () => unknown) => { cleanups.push(execute()) },
    on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
    emit: vi.fn(), logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    sessions: { list: () => [session], get: () => session, flush: vi.fn(async () => true) },
    sandboxPolicy: { resolve: () => ({ mode, workspaceRoot: root }) }, fs,
  }
  const service = new RollbackService(ctx as never)
  return { service, session, ctx, files, paths, handlers, events, dispose: () => { for (const cleanup of cleanups) cleanup() }, mode: (value: string) => { mode = value } }
}

describe('production RollbackService transaction', () => {
  it('flags live content conflicts but allows restoring the selected target', async () => {
    const h = harness()
    h.files.set(h.paths[0]!, 'external edit')
    const preview = await h.service.preview(h.session as never, 1)
    expect(preview.restored[0]?.conflict).toBe(true)
    await h.service.execute(h.session as never, 1, undefined, preview.version)
    expect(h.files.get(h.paths[0]!)).toBe('old')
  })
  it('refuses a symlink target before journal or file mutations', async () => {
    const h = harness()
    h.ctx.fs.lstat.mockResolvedValue({ type: 'symlink' })
    await expect(h.service.preview(h.session as never, 1)).rejects.toThrow('普通文件')
    await expect(h.service.execute(h.session as never, 1)).rejects.toThrow('普通文件')
    expect(h.ctx.fs.writeText).not.toHaveBeenCalled()
    expect(loadTransaction('session')).toBeNull()
  })
  it('does not flag unchanged recorded content as external modification', async () => {
    const h = harness()
    expect((await h.service.preview(h.session as never, 1)).restored[0]?.conflict).toBeUndefined()
  })
  it('replays standalone durable mutations without a matching file-tool event', async () => {
    const h = harness()
    expect((await h.service.preview(h.session as never, 1)).restored[0]).toMatchObject({ content: 'old', path: h.paths[0] })
  })

  it('refuses future turns without any filesystem mutation', async () => {
    const h = harness()
    await expect(h.service.execute(h.session as never, 2)).rejects.toThrow('范围')
    expect(h.ctx.fs.writeText).not.toHaveBeenCalled()
    expect(h.session.append).not.toHaveBeenCalled()
  })

  it('waits for durability both before I/O and after the marker', async () => {
    const h = harness()
    const outcome = await h.service.execute(h.session as never, 1)
    expect(outcome.truncated).toBe(true)
    expect(h.files.get(h.paths[0]!)).toBe('old')
    expect(h.ctx.sessions.flush).toHaveBeenCalledTimes(2)
    expect(loadTransaction('session')).toBeNull()
  })

  it('does not touch files when no durability participant exists', async () => {
    const h = harness()
    h.ctx.sessions.flush.mockResolvedValue(false)
    await expect(h.service.execute(h.session as never, 1)).rejects.toThrow('持久化')
    expect(h.ctx.fs.writeText).not.toHaveBeenCalled()
  })

  it('retains a recovery journal and never truncates after a partial write failure', async () => {
    const h = harness([join(root, 'a'), join(root, 'b')])
    h.ctx.fs.writeText.mockImplementation(async (target, content) => {
      if (target.displayPath === h.paths[1]) throw new Error('EBUSY')
      h.files.set(target.displayPath, content); return { version: '1' }
    })
    await expect(h.service.execute(h.session as never, 1)).rejects.toThrow('EBUSY')
    expect(h.files.get(h.paths[0]!)).toBe('old')
    expect(h.session.append).not.toHaveBeenCalled()
    expect(loadTransaction('session')?.phase).toBe('restoring')
    h.ctx.fs.writeText.mockImplementation(async (target, content) => { h.files.set(target.displayPath, content); return { version: '2' } })
    expect((await h.service.recover(h.session as never, false)).truncated).toBe(true)
    expect(loadTransaction('session')).toBeNull()
  })

  it('compensates already-written files on abort', async () => {
    const h = harness([join(root, 'a'), join(root, 'b')])
    h.ctx.fs.writeText.mockImplementation(async (target, content) => {
      if (target.displayPath === h.paths[1]) throw new Error('locked')
      h.files.set(target.displayPath, content); return { version: '1' }
    })
    await expect(h.service.execute(h.session as never, 1)).rejects.toThrow('locked')
    await h.service.recover(h.session as never, true)
    expect(h.files.get(h.paths[0]!)).toBe('new')
    expect(h.session.append).not.toHaveBeenCalled()
    expect(loadTransaction('session')).toBeNull()
  })

  it('does not append a duplicate marker when retrying a flush failure', async () => {
    const h = harness()
    h.ctx.sessions.flush.mockResolvedValueOnce(true).mockRejectedValueOnce(new Error('disk-full'))
    await expect(h.service.execute(h.session as never, 1)).rejects.toThrow('disk-full')
    expect(h.session.append).toHaveBeenCalledTimes(1)
    await expect(h.service.recover(h.session as never, true)).rejects.toThrow('不能取消')
    await h.service.recover(h.session as never, false)
    expect(h.session.append).toHaveBeenCalledTimes(1)
  })

  it('rejects a concurrent same-session execution before its first await', async () => {
    const h = harness()
    let release!: () => void
    h.ctx.sessions.flush.mockImplementationOnce(() => new Promise<boolean>(resolve => { release = () => resolve(true) }))
    const first = h.service.execute(h.session as never, 1)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    await expect(h.service.execute(h.session as never, 1)).rejects.toThrow('正在执行')
    release(); await first
  })

  it('rejects stale preview versions while ignoring command receipts', async () => {
    const h = harness()
    const version = h.service.versionOf(h.session as never)
    h.events.push({ type: 'command/run', seq: 4, data: {} }, { type: 'command/done', seq: 5, data: {} })
    expect(h.service.versionOf(h.session as never)).toBe(version)
    h.events.push({ type: 'user/message', seq: 6, data: {} })
    await expect(h.service.execute(h.session as never, 1, undefined, version)).rejects.toThrow('变化')
    expect(h.ctx.fs.writeText).not.toHaveBeenCalled()
  })

  it('refuses native deletion under read-only policy', async () => {
    const h = harness(undefined, 'create')
    h.mode('read-only')
    await expect(h.service.execute(h.session as never, 1)).rejects.toThrow('policy')
    expect(readFileSync(h.paths[0]!, 'utf8')).toBe('new')
    expect(h.session.append).not.toHaveBeenCalled()
  })

  it('refuses deletion when backend Host mapping is unproven', async () => {
    const h = harness(undefined, 'create')
    h.ctx.fs.processPathFromHostPath = () => 'remote-world'
    await expect(h.service.execute(h.session as never, 1)).rejects.toThrow('mapping')
    expect(existsSync(h.paths[0]!)).toBe(true)
  })

  it('deletes an authorized created local file without claiming conditional deletion', async () => {
    const h = harness(undefined, 'create')
    await expect(h.service.execute(h.session as never, 1)).resolves.toMatchObject({ executed: true })
    expect(existsSync(h.paths[0]!)).toBe(false)
    expect(h.ctx.fs.writeText).not.toHaveBeenCalled()
    expect(h.session.append).toHaveBeenCalledTimes(1)
    expect(loadTransaction('session')).toBeNull()
  })

  it('restores a missing file after validating compensation deletion capability', async () => {
    const h = harness([join(root, 'a'), join(root, 'b')])
    h.files.delete(h.paths[1]!)
    await expect(h.service.execute(h.session as never, 1)).resolves.toMatchObject({ executed: true })
    expect(h.files.get(h.paths[0]!)).toBe('old')
    expect(h.files.get(h.paths[1]!)).toBe('old')
    expect(loadTransaction('session')).toBeNull()
  })

  it('blocks model steps and tools while recovery is pending', async () => {
    const h = harness()
    h.ctx.fs.writeText.mockRejectedValue(new Error('locked'))
    await expect(h.service.execute(h.session as never, 1)).rejects.toThrow('locked')
    const next = vi.fn()
    expect(await h.handlers.get('agent/pre-step')!({ agent: { id: 'session' } }, next)).toEqual({ kind: 'reject' })
    expect(await h.handlers.get('tools/pre-execute')!({ agent: { id: 'session' } }, next)).toMatchObject({ kind: 'deny', reason: expect.stringContaining('尚未完成') })
    expect(next).not.toHaveBeenCalled()
  })

  it('uses guarded FS writes rather than unconditional overwrites', async () => {
    const h = harness()
    await h.service.execute(h.session as never, 1)
    expect(h.ctx.fs.writeText.mock.calls[0]?.[2]).toMatchObject({ kind: 'replaceIfVersion' })
  })

  it('recovers a durable transaction after service restart', async () => {
    const h = harness()
    h.ctx.fs.writeText.mockRejectedValueOnce(new Error('locked'))
    await expect(h.service.execute(h.session as never, 1)).rejects.toThrow('locked')
    const restarted = new RollbackService(h.ctx as never)
    await restarted.recover(h.session as never, false)
    expect(loadTransaction('session')).toBeNull()
    expect(h.session.append).toHaveBeenCalledTimes(1)
  })

  it('captures authoritative empty before-content using only Agent.id', async () => {
    const h = harness()
    h.files.set(h.paths[0]!, '')
    h.handlers.get('session/event')!(h.session, { type: 'turn/start', seq: 4, data: { turn: 2 } })
    const exec = { name: 'write', callId: 'call', agent: { id: 'session' }, arguments: JSON.stringify({ file_path: h.paths[0] }) }
    await h.handlers.get('tools/pre-execute')!(exec, async () => ({ kind: 'allow' }))
    h.files.set(h.paths[0]!, 'tool-after')
    h.handlers.get('tools/result')!(exec, { status: 'success', value: { path: h.paths[0], operation: 'update', before: 'non-authoritative', after: 'tool-after' } })
    h.handlers.get('session/event')!(h.session, { type: 'turn/end', seq: 5, data: { turn: 2 } })
    expect(h.service.foldFor(h.session as never).snapshots().find(cp => cp.turn === 2)?.changes[h.paths[0]!]?.before).toBe('')
  })

  it('captures creation after an approval listener skipped pre-execute', async () => {
    const h = harness()
    const path = join(root, 'created-after-approval.txt')
    h.handlers.get('session/event')!(h.session, { type: 'turn/start', seq: 4, data: { turn: 2 } })
    const exec = { name: 'write', callId: 'approved-create', agent: { id: 'session' }, arguments: { file_path: path } }
    const result = { status: 'success', value: { path, operation: 'update', before: '', after: 'created' } }
    const next = vi.fn(async () => { h.files.set(path, 'created'); return result })
    expect(await h.handlers.get('tools/execute')!(exec, next)).toBe(result)
    h.handlers.get('tools/result')!(exec, result)
    h.handlers.get('session/event')!(h.session, { type: 'turn/end', seq: 5, data: { turn: 2 } })
    const change = h.service.foldFor(h.session as never).snapshots().find(cp => cp.turn === 2)?.changes[path]
    expect(change).toMatchObject({ kind: 'created', before: null })
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('refreshes a stale pre-approval snapshot at allowed dispatch', async () => {
    const h = harness()
    const path = h.paths[0]!
    h.handlers.get('session/event')!(h.session, { type: 'turn/start', seq: 4, data: { turn: 2 } })
    const exec = { name: 'write', callId: 'approved-edit', agent: { id: 'session' }, arguments: { file_path: path } }
    await h.handlers.get('tools/pre-execute')!(exec, async () => ({ kind: 'ask' }))
    h.files.set(path, 'changed-during-approval')
    const result = { status: 'success', value: { path, operation: 'update', before: '', after: 'tool-after' } }
    await h.handlers.get('tools/execute')!(exec, async () => { h.files.set(path, 'tool-after'); return result })
    h.handlers.get('tools/result')!(exec, result)
    h.handlers.get('session/event')!(h.session, { type: 'turn/end', seq: 5, data: { turn: 2 } })
    expect(h.service.foldFor(h.session as never).snapshots().find(cp => cp.turn === 2)?.changes[path]?.before).toBe('changed-during-approval')
  })

  it('does not treat uncaptured successful writes as authoritative rollback evidence', async () => {
    const h = harness()
    const path = h.paths[0]!
    h.handlers.get('tools/result')!({ name: 'write', callId: 'bypassed', agent: { id: 'session' }, arguments: { file_path: path } }, {
      status: 'success', value: { path, operation: 'update', before: '', after: 'new' },
    })
    await expect(h.service.preview(h.session as never, 1)).rejects.toThrow('前镜像')
    expect(h.session.append).not.toHaveBeenCalled()
  })

  it('blocks approved dispatch while a journal is pending, bypassing pre-execute', async () => {
    const h = harness()
    h.ctx.fs.writeText.mockRejectedValue(new Error('locked'))
    await expect(h.service.execute(h.session as never, 1)).rejects.toThrow('locked')
    const next = vi.fn(async () => ({}))
    await expect(h.handlers.get('tools/execute')!({ name: 'read', callId: 'approved', agent: { id: 'session' } }, next)).rejects.toThrow('工具执行已阻止')
    expect(next).not.toHaveBeenCalled()
    expect(loadTransaction('session')?.phase).toBe('restoring')
  })

  it('does not swallow downstream dispatch failures', async () => {
    const h = harness()
    await expect(h.handlers.get('tools/execute')!({ name: 'read', callId: 'read', agent: { id: 'session' } }, async () => { throw new Error('tool-body-failed') })).rejects.toThrow('tool-body-failed')
  })

  it('reports pending recovery and method-only capability evidence without writing', async () => {
    const h = harness()
    const initial = await h.service.doctor(h.session as never)
    expect(initial).toMatchObject({ liveSession: true, journal: 'none', conditionalDelete: 'unsupported', pressurePricing: 'unavailable' })
    expect(initial.capabilityEvidence).toContain('method-presence-only')
    expect(JSON.stringify(initial)).not.toContain('file_path')
    expect(h.ctx.fs.writeText).not.toHaveBeenCalled()
    expect(h.session.append).not.toHaveBeenCalled()
    h.ctx.fs.writeText.mockRejectedValue(new Error('busy'))
    await expect(h.service.execute(h.session as never, 1)).rejects.toThrow('busy')
    h.session.append.mockClear()
    h.ctx.fs.writeText.mockClear()
    expect(await h.service.doctor(h.session as never)).toMatchObject({ journal: 'restoring' })
    expect(h.ctx.fs.writeText).not.toHaveBeenCalled()
    expect(h.session.append).not.toHaveBeenCalled()
    expect(loadTransaction('session')?.phase).toBe('restoring')
  })

  it('keeps doctor useful without leaking or clearing a latched scan failure', async () => {
    const h = harness()
    const scan = (h.service as unknown as { rescan: { settled: (id: string) => Promise<void> } }).rescan
    const settled = vi.spyOn(scan, 'settled').mockRejectedValue(new Error('secret-file-body-and-path'))
    h.ctx.sessions.get = () => { throw new Error('secret-session-error') }
    const diagnostic = await h.service.doctor(h.session as never)
    expect(diagnostic).toMatchObject({ observationState: 'failed', checkpointState: 'failed', liveSession: 'unknown', journal: 'none' })
    expect(JSON.stringify(diagnostic)).not.toContain('secret')
    expect(settled).toHaveBeenCalledTimes(1)
    expect(h.ctx.fs.writeText).not.toHaveBeenCalled()
    expect(h.session.append).not.toHaveBeenCalled()
  })

  it('appends optional fixed-heuristic pricing adjacent to marker and never duplicates after flush retry', async () => {
    const h = harness()
    Object.assign(h.ctx, { get: () => ({ measure: () => ({ nodes: [{ seq: 1, heuristicTokens: 100 }, { seq: 2, heuristicTokens: 23 }] }) }) })
    h.ctx.sessions.flush.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    await expect(h.service.execute(h.session as never, 1)).rejects.toThrow('持久化确认')
    expect(h.session.append.mock.calls.map(call => call[0])).toEqual(['compaction/prune', 'user/message'])
    expect(h.session.append.mock.calls[0]?.[1]).toEqual({ shadowedRange: { start: 2, end: 2 }, shadowedSeqs: [2], shadowedTokenCount: 23 })
    await h.service.recover(h.session as never, false)
    expect(h.session.append).toHaveBeenCalledTimes(2)
    expect(loadTransaction('session')).toBeNull()
  })

  it('retries a split prune/marker append without accepting unrelated surface changes', async () => {
    const h = harness()
    Object.assign(h.ctx, { get: () => ({ measure: () => ({ nodes: [{ seq: 1, heuristicTokens: 100 }, { seq: 2, heuristicTokens: 23 }] }) }) })
    const append = h.session.append.getMockImplementation()!
    h.session.append.mockImplementation((type, data, options) => {
      if (type === 'user/message') throw new Error('marker-append-failure')
      return append(type, data, options)
    })
    await expect(h.service.execute(h.session as never, 1)).rejects.toThrow('marker-append-failure')
    expect(loadTransaction('session')?.phase).toBe('marker')
    expect(h.session.surface.nodes).toEqual([1, 2])
    h.session.append('turn/start', { turn: 2 }, undefined)
    h.session.append('turn/end', { turn: 2, reason: { kind: 'blocked' } }, undefined)
    await expect(h.service.recover(h.session as never, false)).rejects.toThrow('marker-append-failure')
    h.session.append.mockImplementation(append)
    await expect(h.service.recover(h.session as never, false)).resolves.toMatchObject({ truncated: true })
    expect(h.session.append.mock.calls.map(call => call[0])).toEqual(['compaction/prune', 'user/message', 'turn/start', 'turn/end', 'compaction/prune', 'user/message', 'compaction/prune', 'user/message'])
    expect(loadTransaction('session')).toBeNull()
  })

  it.each(['surface', 'range', 'seqs', 'count', 'activity'] as const)('rejects %s activity after a split pricing append', async kind => {
    const h = harness()
    Object.assign(h.ctx, { get: () => ({ measure: () => ({ nodes: [{ seq: 1, heuristicTokens: 100 }, { seq: 2, heuristicTokens: 23 }] }) }) })
    const append = h.session.append.getMockImplementation()!
    h.session.append.mockImplementation((type, data, options) => {
      if (type === 'user/message') throw new Error('marker-append-failure')
      return append(type, data, options)
    })
    await expect(h.service.execute(h.session as never, 1)).rejects.toThrow('marker-append-failure')
    const price = h.events.at(-1)!
    if (kind === 'surface') price.surfaceOp = 'append'
    if (kind === 'range') price.data.shadowedRange.end = 1
    if (kind === 'seqs') price.data.shadowedSeqs = [1]
    if (kind === 'count') price.data.shadowedTokenCount = -1
    if (kind === 'activity') append('assistant/message', { content: [] }, { surfaceOp: 'append' })
    h.session.append.mockImplementation(append)
    h.session.append.mockClear()
    await expect(h.service.recover(h.session as never, false)).rejects.toThrow('陈旧截断')
    expect(h.session.append).not.toHaveBeenCalled()
    expect(loadTransaction('session')?.phase).toBe('marker')
  })

  it('compensates split-pricing files on abort without truncating', async () => {
    const h = harness()
    Object.assign(h.ctx, { get: () => ({ measure: () => ({ nodes: [{ seq: 1, heuristicTokens: 100 }, { seq: 2, heuristicTokens: 23 }] }) }) })
    const append = h.session.append.getMockImplementation()!
    h.session.append.mockImplementation((type, data, options) => {
      if (type === 'user/message') throw new Error('marker-append-failure')
      return append(type, data, options)
    })
    await expect(h.service.execute(h.session as never, 1)).rejects.toThrow('marker-append-failure')
    expect(h.files.get(h.paths[0]!)).toBe('old')
    h.session.append.mockImplementation(append)
    await expect(h.service.recover(h.session as never, true)).resolves.toMatchObject({ truncated: false })
    expect(h.files.get(h.paths[0]!)).toBe('new')
    expect(h.session.surface.nodes).toEqual([1, 2])
    expect(h.session.append.mock.calls.map(call => call[0])).toEqual(['compaction/prune', 'user/message'])
    expect(loadTransaction('session')).toBeNull()
  })

  it('keeps rollback usable if optional meter throws', async () => {
    const h = harness()
    Object.assign(h.ctx, { get: () => ({ measure: () => { throw new Error('optional-meter-offline') } }) })
    await h.service.execute(h.session as never, 1)
    expect(h.session.append.mock.calls.map(call => call[0])).toEqual(['user/message'])
  })

  it('refuses a rollback if its log accessor fails without breaking service startup', async () => {
    const h = harness()
    h.session.snapshotEvents = () => { throw new Error('unreadable') }
    const restarted = new RollbackService(h.ctx as never)
    await expect(restarted.execute(h.session as never, 1)).rejects.toThrow('unreadable')
    expect(h.ctx.fs.writeText).not.toHaveBeenCalled()
  })

  it('honors explicit retry despite external content edits', async () => {
    const h = harness()
    h.ctx.fs.writeText.mockRejectedValueOnce(new Error('locked'))
    await expect(h.service.execute(h.session as never, 1)).rejects.toThrow('locked')
    h.files.set(h.paths[0]!, 'external edit')
    await expect(h.service.recover(h.session as never, false)).resolves.toMatchObject({ executed: true })
    expect(h.files.get(h.paths[0]!)).toBe('old')
    expect(loadTransaction('session')).toBeNull()
  })
})
