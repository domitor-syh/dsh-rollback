import type {} from '../src/dsh-types.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { RollbackService } from '../src/service.ts'
import { appendCheckpoint, loadCheckpoints } from '../src/store.ts'
import { loadTransaction, saveTransaction, type RollbackTransaction } from '../src/transaction-store.ts'
import { planTruncationMarker } from '../src/core/truncation-plan.ts'

type Event = { type: string; seq: number; data: any; surfaceOp?: any; sourceEventSeqs?: number[] }
type Target = { displayPath: string }
type Handler = (...args: any[]) => any

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(fulfill => { resolve = fulfill })
  return { promise, resolve }
}

let root: string
let previousHome: string | undefined
const disposers: (() => void)[] = []
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rollback-lifecycle-'))
  previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = root
})
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  // Only remove the exact temporary directory this test created.
  if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith('rollback-lifecycle-')) throw new Error('Unexpected test cleanup path')
  rmSync(root, { recursive: true, force: true })
})

/** Real checkpoint/journal/baseline stores, with a version-enforcing filesystem fake.
 * Disk contents mirror the fake so the production native boundary scanner agrees.
 */
function harness(count = 1) {
  const id = 'lifecycle-session'
  const events: Event[] = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'system/message', seq: 1, data: {}, surfaceOp: 'append' },
    { type: 'user/message', seq: 2, data: { id: 'original-user' }, surfaceOp: 'append' },
    { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const listeners = new Map<string, Set<Handler>>()
  const broadcast = (name: string, ...args: any[]) => {
    for (const handler of [...listeners.get(name) ?? []]) handler(...args)
  }
  const session = {
    id, header: { cwd: root }, surface: { nodes: [1, 2] },
    snapshotEvents: () => [...events],
    append: vi.fn((type: string, data: any, options?: { surfaceOp?: any; sourceEventSeqs?: number[] }) => {
      const event: Event = { type, data, seq: events.length, ...options }
      events.push(event)
      if (options?.surfaceOp === 'append') session.surface.nodes.push(event.seq)
      else if (options?.surfaceOp?.op === 'replace') {
        const start = options.surfaceOp.startSeq ?? options.surfaceOp.start
        const end = options.surfaceOp.endSeq ?? options.surfaceOp.end
        session.surface.nodes = [...session.surface.nodes.filter(seq => seq < start || seq > end), event.seq]
      }
      broadcast('session/event', session, event)
      return event
    }),
  }
  let live: typeof session | undefined = session
  let revision = 0
  const paths = Array.from({ length: count }, (_, index) => join(root, `file-${index}.txt`))
  const files = new Map<string, { content: string; version: string }>()
  const setFile = (path: string, content: string) => {
    const version = `v-${++revision}`
    files.set(path, { content, version })
    writeFileSync(path, content)
    return { version }
  }
  for (const path of paths) {
    setFile(path, 'new')
    appendCheckpoint({ sessionId: id, turn: 1, path, operation: 'update', before: 'old', after: 'new' })
  }
  const commit = (target: Target, content: string, expected?: any) => {
    const current = files.get(target.displayPath)
    if (expected?.kind === 'createIfAbsent' && current !== undefined) throw new Error('File already exists')
    if (expected?.kind === 'replaceIfVersion' && current?.version !== expected.version) throw new Error('Version conflict')
    return setFile(target.displayPath, content)
  }
  const fs = {
    resolve: vi.fn(async (path: string) => ({ displayPath: path })),
    lstat: vi.fn(async (path: string) => files.has(path) ? { type: 'file' } : undefined),
    processPath: (target: Target) => target.displayPath,
    processPathFromHostPath: (path: string) => path,
    stat: vi.fn(async (target: Target) => {
      const current = files.get(target.displayPath)
      return current === undefined ? undefined : { type: 'file', size: current.content.length, version: current.version }
    }),
    readText: vi.fn(async (target: Target) => files.get(target.displayPath)!.content),
    writeText: vi.fn(async (target: Target, content: string, expected?: any, _signal?: AbortSignal, _policy?: any) => commit(target, content, expected)),
  }
  const mount = (Service = RollbackService) => {
    const cleanups: (() => void)[] = []
    const handlers = new Map<string, Handler>()
    let disposed = false
    const dispose = () => {
      if (disposed) return
      disposed = true
      for (const cleanup of [...cleanups].reverse()) cleanup()
    }
    disposers.push(dispose)
    const ctx = {
      effect: (execute: () => () => void) => { cleanups.push(execute()) },
      on: (name: string, handler: Handler) => {
        handlers.set(name, handler)
        const subscribers = listeners.get(name) ?? new Set<Handler>()
        listeners.set(name, subscribers)
        subscribers.add(handler)
        const stop = () => { subscribers.delete(handler) }
        cleanups.push(stop)
        return stop
      },
      emit: vi.fn(), logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
      sessions: { list: () => live === undefined ? [] : [live], get: () => live, flush: vi.fn(async () => true) },
      sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: root }) }, fs,
    }
    return { service: new Service(ctx as never), ctx, handlers, dispose }
  }
  const host = mount()
  return {
    id, events, session, paths, files, fs, commit, setFile, broadcast, mount, ...host,
    setLive: (next: typeof session | undefined) => { live = next },
  }
}

async function partialFailure(h: ReturnType<typeof harness>) {
  let fail = true
  h.fs.writeText.mockImplementation(async (target, content, expected) => {
    if (target.displayPath === h.paths[1] && fail) { fail = false; throw new Error('second-file-busy') }
    return h.commit(target, content, expected)
  })
  await expect(h.service.execute(h.session as never, 1)).rejects.toThrow('second-file-busy')
  expect(loadTransaction(h.id)?.phase).toBe('restoring')
}

function queueInput(h: ReturnType<typeof harness>, messageId = 'blocked-input') {
  h.session.append('agent/inbox/spliced', {
    target: 'next-turn', start: 0,
    inserted: [{ id: messageId, role: 'user', source: { kind: 'ui' }, content: [{ type: 'text', text: 'try while recovering' }] }],
  })
}

async function blockedAttempt(h: ReturnType<typeof harness>, turn = 2) {
  queueInput(h)
  h.session.append('turn/start', { turn })
  h.session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
  const next = vi.fn(async () => ({ kind: 'continue' }))
  const decision = await h.handlers.get('agent/pre-step')!({ agent: { id: h.id } }, next)
  expect(decision).toEqual({ kind: 'reject' })
  expect(next).not.toHaveBeenCalled()
  h.session.append('turn/end', { turn, reason: { kind: 'blocked' } })
}

describe('production rollback lifecycle and recovery boundaries', () => {
  function openTurn(h: ReturnType<typeof harness>, turn: number) {
    h.session.append('turn/start', { turn })
    h.session.append('user/message', { id: `user-${turn}` }, { surfaceOp: 'append' })
  }
  function closeTurn(h: ReturnType<typeof harness>, turn: number) {
    h.session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  async function dispatch(h: ReturnType<typeof harness>, name: string, body: () => void, args: unknown = {}) {
    const exec = { name, callId: `call-${h.events.length}`, agent: { id: h.id }, arguments: args }
    const result = await h.handlers.get('tools/execute')!(exec, async () => { body(); return { isError: false } })
    h.handlers.get('tools/result')!(exec, result)
  }

  async function writeTarget(h: ReturnType<typeof harness>, path: string, content: string) {
    const exec = { name: 'write', callId: `write-${h.events.length}-${content}`, agent: { id: h.id }, arguments: { file_path: path } }
    const result = await h.handlers.get('tools/execute')!(exec, async () => {
      const before = h.files.get(path)?.content ?? null
      const { version } = h.setFile(path, content)
      return { isError: false, value: { path, before, after: content, version } }
    })
    h.handlers.get('tools/result')!(exec, result)
  }

  it.each(['same-turn', 'cross-turn'] as const)('omits create-delete net-zero paths and never touches external recreation (%s)', async layout => {
    const h = harness(0)
    const path = join(root, 'net-created.txt')
    openTurn(h, 2)
    await writeTarget(h, path, 'model-created')
    if (layout === 'cross-turn') { closeTurn(h, 2); openTurn(h, 3) }
    await dispatch(h, 'pwsh', () => { rmSync(path); h.files.delete(path) })
    closeTurn(h, layout === 'cross-turn' ? 3 : 2)
    h.setFile(path, 'external-recreation')
    const before = await h.service.preview(h.session as never, 2)
    expect(before).toMatchObject({ restored: [], skipped: [] })
    h.dispose()
    const restarted = h.mount()
    expect(await restarted.service.preview(h.session as never, 2)).toEqual(before)
    h.fs.writeText.mockClear()
    const result = await restarted.service.execute(h.session as never, 2)
    expect(result.restored).toEqual([])
    expect(result.skipped).toEqual([])
    expect(h.fs.writeText).not.toHaveBeenCalled()
    expect(h.files.get(path)?.content).toBe('external-recreation')
    expect(readFileSync(path, 'utf8')).toBe('external-recreation')
  })

  it.each(['same-turn', 'cross-turn'] as const)('omits update-revert net-zero paths and never touches subsequent external edits (%s)', async layout => {
    const h = harness()
    const path = h.paths[0]!
    openTurn(h, 2)
    await writeTarget(h, path, 'model-update')
    if (layout === 'cross-turn') { closeTurn(h, 2); openTurn(h, 3) }
    await writeTarget(h, path, 'new')
    closeTurn(h, layout === 'cross-turn' ? 3 : 2)
    h.setFile(path, 'external-after-revert')
    const before = await h.service.preview(h.session as never, 2)
    expect(before).toMatchObject({ restored: [], skipped: [] })
    h.dispose()
    const restarted = h.mount()
    expect(await restarted.service.preview(h.session as never, 2)).toEqual(before)
    h.fs.writeText.mockClear()
    const result = await restarted.service.execute(h.session as never, 2)
    expect(result.restored).toEqual([])
    expect(h.fs.writeText).not.toHaveBeenCalled()
    expect(h.files.get(path)?.content).toBe('external-after-revert')
    expect(readFileSync(path, 'utf8')).toBe('external-after-revert')
  })

  it.each(['same-turn', 'cross-turn'] as const)('labels delete-recreate with different content as restore and restores the first basis (%s)', async layout => {
    const h = harness()
    const path = h.paths[0]!
    openTurn(h, 2)
    await dispatch(h, 'pwsh', () => { rmSync(path); h.files.delete(path) })
    if (layout === 'cross-turn') { closeTurn(h, 2); openTurn(h, 3) }
    await writeTarget(h, path, 'recreated-different')
    closeTurn(h, layout === 'cross-turn' ? 3 : 2)
    const before = await h.service.preview(h.session as never, 2)
    expect(before.restored).toEqual([{ path, action: 'restore', kind: 'updated', content: 'new' }])
    h.dispose()
    const restarted = h.mount()
    expect(await restarted.service.preview(h.session as never, 2)).toEqual(before)
    const result = await restarted.service.execute(h.session as never, 2)
    expect(result.restored).toEqual([{ path, action: 'restore', kind: 'updated', content: 'new' }])
    expect(result.summary).toContain('1 个文件恢复')
    expect(h.files.get(path)?.content).toBe('new')
    expect(readFileSync(path, 'utf8')).toBe('new')
  })

  it.each(['same-turn', 'cross-turn'] as const)('labels update-delete as recover and recovers the first basis (%s)', async layout => {
    const h = harness()
    const path = h.paths[0]!
    openTurn(h, 2)
    await writeTarget(h, path, 'intermediate-update')
    if (layout === 'cross-turn') { closeTurn(h, 2); openTurn(h, 3) }
    await dispatch(h, 'pwsh', () => { rmSync(path); h.files.delete(path) })
    closeTurn(h, layout === 'cross-turn' ? 3 : 2)
    const before = await h.service.preview(h.session as never, 2)
    expect(before.restored).toEqual([{ path, action: 'recover', kind: 'removed', content: 'new' }])
    h.dispose()
    const restarted = h.mount()
    expect(await restarted.service.preview(h.session as never, 2)).toEqual(before)
    const result = await restarted.service.execute(h.session as never, 2)
    expect(result.restored).toEqual([{ path, action: 'recover', kind: 'removed', content: 'new' }])
    expect(result.summary).toContain('1 个文件找回')
    expect(h.files.get(path)?.content).toBe('new')
    expect(readFileSync(path, 'utf8')).toBe('new')
  })

  it('keeps external deletion a conflicted restore rather than changing preview or result labels to recover', async () => {
    const h = harness()
    const path = h.paths[0]!
    rmSync(path); h.files.delete(path)
    openTurn(h, 2); closeTurn(h, 2)
    expect((await h.service.preview(h.session as never, 2)).restored).toEqual([])
    const before = await h.service.preview(h.session as never, 1)
    expect(before.restored).toEqual([{ path, action: 'restore', kind: 'updated', content: 'old', conflict: true }])
    h.dispose()
    const restarted = h.mount()
    expect(await restarted.service.preview(h.session as never, 1)).toEqual(before)
    const result = await restarted.service.execute(h.session as never, 1)
    expect(result.restored).toEqual([{ path, action: 'restore', kind: 'updated', content: 'old' }])
    expect(result.summary).toContain('1 个文件恢复')
    expect(result.summary).not.toContain('文件找回')
    expect(h.files.get(path)?.content).toBe('old')
    expect(readFileSync(path, 'utf8')).toBe('old')
  })

  it('keeps external edits on the previous file-changing turn across text-only turns and restart', async () => {
    const h = harness()
    h.setFile(h.paths[0]!, 'user-edited')
    openTurn(h, 2); closeTurn(h, 2)
    expect((await h.service.preview(h.session as never, 2)).restored).toEqual([])
    expect(loadCheckpoints(h.id).has(2)).toBe(false)
    h.dispose()
    const restarted = h.mount()
    expect((await restarted.service.preview(h.session as never, 2)).restored).toEqual([])
    expect((await restarted.service.preview(h.session as never, 1)).restored[0]).toMatchObject({ content: 'old', conflict: true })
    await restarted.service.execute(h.session as never, 2)
    expect(h.files.get(h.paths[0]!)?.content).toBe('user-edited')
    expect((await restarted.service.preview(h.session as never, 1)).restored[0]?.conflict).toBe(true)
  })

  it.each(['read', 'read_image', 'glob', 'grep', 'str_replace_editor'])('does not assign external edits during a %s-only turn', async name => {
    const h = harness()
    h.setFile(h.paths[0]!, 'user-edited')
    openTurn(h, 2)
    await dispatch(h, name, () => { h.setFile(h.paths[0]!, 'another-user-edit') }, { command: 'view' })
    closeTurn(h, 2)
    expect((await h.service.preview(h.session as never, 2)).restored).toEqual([])
    expect(loadCheckpoints(h.id).has(2)).toBe(false)
    expect((await h.service.preview(h.session as never, 1)).restored[0]?.conflict).toBe(true)
  })

  it('does not turn a shell no-op after an external edit into a model file change', async () => {
    const h = harness()
    h.setFile(h.paths[0]!, 'user-edited')
    openTurn(h, 2)
    await dispatch(h, 'pwsh', () => {})
    closeTurn(h, 2)
    expect((await h.service.preview(h.session as never, 2)).restored).toEqual([])
    expect((await h.service.preview(h.session as never, 1)).restored[0]?.conflict).toBe(true)
  })

  it('restores shell changes to the user-edited dispatch basis, not the old checkpoint after', async () => {
    const h = harness()
    h.setFile(h.paths[0]!, 'user-edited')
    openTurn(h, 2)
    await dispatch(h, 'pwsh', () => { h.setFile(h.paths[0]!, 'model-shell-edited') })
    closeTurn(h, 2)
    expect((await h.service.preview(h.session as never, 2)).restored[0]).toMatchObject({ content: 'user-edited' })
    await h.service.execute(h.session as never, 2)
    expect(h.files.get(h.paths[0]!)?.content).toBe('user-edited')
    expect((await h.service.preview(h.session as never, 1)).restored[0]?.conflict).toBe(true)
  })

  it.each(['other-path', 'same-path'] as const)('refuses incomplete legacy replay coverage (%s) without changing any file or conversation', async layout => {
    const h = harness()
    const path = h.paths[0]!
    const missing = layout === 'other-path' ? join(root, 'unrecorded.txt') : path
    openTurn(h, 2)
    h.setFile(path, 'partial-checkpoint-after')
    appendCheckpoint({ sessionId: h.id, turn: 2, path, operation: 'update', before: 'new', after: 'partial-checkpoint-after' })
    const loggedCall = (callId: string, target: string) => {
      h.session.append('tool/call', { turn: 2, callId, name: 'write', arguments: JSON.stringify({ file_path: target }) })
      h.session.append('tool/result', { turn: 2, message: { source: { callId } } }, { surfaceOp: 'append' })
    }
    loggedCall('covered', path)
    h.setFile(missing, 'last-unrecorded-content')
    loggedCall('missing', missing)
    closeTurn(h, 2)
    h.dispose()
    const restarted = h.mount()
    const plan = await restarted.service.preview(h.session as never, 2)
    expect(plan.skipped.length).toBeGreaterThan(0)
    const surface = [...h.session.surface.nodes]
    h.fs.writeText.mockClear()
    await expect(restarted.service.execute(h.session as never, 2)).rejects.toThrow('恢复依据不完整')
    expect(h.fs.writeText).not.toHaveBeenCalled()
    expect(readFileSync(missing, 'utf8')).toBe('last-unrecorded-content')
    expect(h.session.surface.nodes).toEqual(surface)
  })

  it('replays exact identified write receipts and restores actual bytes after restart', async () => {
    const h = harness()
    const path = h.paths[0]!
    openTurn(h, 2)
    h.session.append('tool/call', { turn: 2, callId: 'logged-write', name: 'write', arguments: JSON.stringify({ file_path: path }) })
    const exec = { name: 'write', callId: 'logged-write', agent: { id: h.id }, arguments: { file_path: path } }
    const result = await h.handlers.get('tools/execute')!(exec, async () => {
      const { version } = h.setFile(path, 'identified-after')
      return { isError: false, value: { path, before: '', after: 'identified-after', version } }
    })
    h.handlers.get('tools/result')!(exec, result)
    h.session.append('tool/result', { turn: 2, message: { source: { callId: 'logged-write' } } }, { surfaceOp: 'append' })
    closeTurn(h, 2)
    const before = await h.service.preview(h.session as never, 2)
    h.dispose()
    const restarted = h.mount()
    expect(await restarted.service.preview(h.session as never, 2)).toEqual(before)
    await restarted.service.execute(h.session as never, 2)
    expect(readFileSync(path, 'utf8')).toBe('new')
  })

  it.each(['write', 'edit', 'str_replace_editor'])('does not record a same-content %s after an external edit', async name => {
    const h = harness()
    h.setFile(h.paths[0]!, 'user-edited')
    openTurn(h, 2)
    const exec = { name, callId: 'no-op', agent: { id: h.id }, arguments: { file_path: h.paths[0], path: h.paths[0], command: 'str_replace' } }
    const result = await h.handlers.get('tools/execute')!(exec, async () => ({ isError: false, value: name === 'str_replace_editor' ? undefined : { path: h.paths[0], before: '', after: 'user-edited', version: 'newer-version' } }))
    h.handlers.get('tools/result')!(exec, result)
    h.session.append('tool/call', { turn: 2, callId: 'no-op', name, arguments: JSON.stringify(exec.arguments) })
    h.session.append('tool/result', { turn: 2, message: { source: { callId: 'no-op' } } }, { surfaceOp: 'append' })
    closeTurn(h, 2)
    expect((await h.service.preview(h.session as never, 2)).restored).toEqual([])
    expect(loadCheckpoints(h.id).has(2)).toBe(false)
    expect((await h.service.preview(h.session as never, 1)).restored[0]?.conflict).toBe(true)
    h.dispose()
    const restarted = h.mount()
    expect((await restarted.service.preview(h.session as never, 2)).restored).toEqual([])
    expect((await restarted.service.preview(h.session as never, 1)).restored[0]?.conflict).toBe(true)
  })

  it('captures partial changes of a throwing shell before the next no-op dispatch', async () => {
    const h = harness()
    h.setFile(h.paths[0]!, 'user-edited')
    openTurn(h, 2)
    await expect(h.handlers.get('tools/execute')!({ name: 'pwsh', callId: 'failed', agent: { id: h.id } }, async () => {
      h.setFile(h.paths[0]!, 'partially-written')
      throw new Error('cancelled')
    })).rejects.toThrow('cancelled')
    await dispatch(h, 'pwsh', () => {})
    closeTurn(h, 2)
    expect((await h.service.preview(h.session as never, 2)).restored[0]?.content).toBe('user-edited')
  })

  it.each(['created', 'unregistered'] as const)('records only the %s direct target after a partial failure', async kind => {
    const h = harness()
    const target = join(root, 'not-watched.txt')
    if (kind === 'unregistered') h.setFile(target, 'unregistered-basis')
    openTurn(h, 2)
    const exec = { name: 'write', callId: 'partial-new-path', agent: { id: h.id }, arguments: { file_path: target } }
    await expect(h.handlers.get('tools/execute')!(exec, async () => {
      h.setFile(target, 'partial-output')
      h.setFile(h.paths[0]!, 'unrelated-external')
      throw new Error('partial-failure')
    })).rejects.toThrow('partial-failure')
    h.handlers.get('tools/result')!(exec, { isError: true })
    closeTurn(h, 2)
    expect(loadCheckpoints(h.id).get(2)?.get(target)).toMatchObject({ operation: kind === 'created' ? 'create' : 'update',
      before: kind === 'created' ? null : 'unregistered-basis', after: 'partial-output' })
    expect(loadCheckpoints(h.id).get(2)?.has(h.paths[0]!)).toBe(false)
    expect((await h.service.preview(h.session as never, 2)).restored).toEqual([expect.objectContaining({ path: target,
      action: kind === 'created' ? 'delete' : 'restore', content: kind === 'created' ? null : 'unregistered-basis' })])
    h.dispose()
    expect((await h.mount().service.preview(h.session as never, 2)).restored).toHaveLength(1)
  })

  it('latches unsafe rollback when a failed direct target cannot be read completely', async () => {
    const h = harness()
    openTurn(h, 2)
    const exec = { name: 'edit', callId: 'unreadable-poststate', agent: { id: h.id }, arguments: { file_path: h.paths[0] } }
    await expect(h.handlers.get('tools/execute')!(exec, async () => {
      h.setFile(h.paths[0]!, 'partial')
      h.fs.readText.mockRejectedValue(new Error('binary-or-unreadable'))
      throw new Error('original-tool-error')
    })).rejects.toThrow('original-tool-error')
    h.handlers.get('tools/result')!(exec, { isError: true })
    closeTurn(h, 2)
    await expect(h.service.preview(h.session as never, 2)).rejects.toThrow('binary-or-unreadable')
  })

  it('restores complete Unicode and CRLF bytes after a tracked shell deletion', async () => {
    const h = harness()
    const content = '完整恢复：你好，🌍\r\n第二行\r\n'
    h.setFile(h.paths[0]!, content)
    openTurn(h, 2)
    await dispatch(h, 'pwsh', () => { rmSync(h.paths[0]!); h.files.delete(h.paths[0]!) })
    closeTurn(h, 2)
    expect((await h.service.preview(h.session as never, 2)).restored).toEqual([expect.objectContaining({ path: h.paths[0], action: 'recover', content })])
    await h.service.execute(h.session as never, 2)
    expect(h.fs.writeText).toHaveBeenCalledWith(expect.anything(), content, { kind: 'createIfAbsent' }, expect.any(AbortSignal), expect.objectContaining({ mode: 'danger-full-access' }))
    expect(readFileSync(h.paths[0]!)).toEqual(Buffer.from(content, 'utf8'))
    expect(h.ctx.emit).toHaveBeenCalledWith('fs/observed', expect.anything(), expect.objectContaining({ kind: 'present' }), expect.objectContaining({ agent: { id: h.id } }))
  })

  it('does not assign an external deletion or recreation to a later chat turn', async () => {
    const h = harness()
    rmSync(h.paths[0]!)
    h.files.delete(h.paths[0]!)
    openTurn(h, 2); closeTurn(h, 2)
    expect((await h.service.preview(h.session as never, 2)).restored).toEqual([])
    expect((await h.service.preview(h.session as never, 1)).restored[0]?.conflict).toBe(true)
    h.setFile(h.paths[0]!, 'user-recreated')
    openTurn(h, 3); closeTurn(h, 3)
    expect((await h.service.preview(h.session as never, 3)).restored).toEqual([])
  })

  it('rolls back the earlier file-changing turn after later file-free turns', async () => {
    const h = harness()
    h.setFile(h.paths[0]!, 'user-edited')
    openTurn(h, 2); closeTurn(h, 2)
    openTurn(h, 3); closeTurn(h, 3)
    const plan = await h.service.preview(h.session as never, 1)
    expect(plan.restored[0]).toMatchObject({ content: 'old', conflict: true })
    await h.service.execute(h.session as never, 1)
    expect(h.files.get(h.paths[0]!)?.content).toBe('old')
  })

  it('keeps direct write ownership and excludes unrelated external edits', async () => {
    const h = harness(2)
    h.setFile(h.paths[0]!, 'user-edited')
    h.setFile(h.paths[1]!, 'unrelated-user-edit')
    openTurn(h, 2)
    const exec = { name: 'write', callId: 'direct', agent: { id: h.id }, arguments: { file_path: h.paths[0] } }
    const result = await h.handlers.get('tools/execute')!(exec, async () => {
      const { version } = h.setFile(h.paths[0]!, 'model-direct')
      return { isError: false, value: { path: h.paths[0], before: 'wrong-tool-basis', after: 'model-direct', version } }
    })
    h.handlers.get('tools/result')!(exec, result)
    closeTurn(h, 2)
    const preview = await h.service.preview(h.session as never, 2)
    expect(preview.restored).toHaveLength(1)
    expect(preview.restored[0]).toMatchObject({ path: h.paths[0], content: 'user-edited' })
    await h.service.execute(h.session as never, 2)
    expect(h.files.get(h.paths[0]!)?.content).toBe('user-edited')
    expect(h.files.get(h.paths[1]!)?.content).toBe('unrelated-user-edit')
  })
  it('shares the HMR lock and cancels before a marker after an uncooperative write settles', async () => {
    const h = harness()
    const entered = deferred<void>()
    const release = deferred<void>()
    let operationSignal: AbortSignal | undefined
    h.fs.writeText.mockImplementation(async (target, content, expected, signal) => {
      operationSignal = signal
      entered.resolve()
      await release.promise
      // Intentionally ignore cancellation to model a filesystem operation already in flight.
      return h.commit(target, content, expected)
    })
    const result = h.service.execute(h.session as never, 1).catch(error => error as Error)
    await entered.promise
    expect(loadTransaction(h.id)?.phase).toBe('restoring')
    h.dispose()
    expect(operationSignal?.aborted).toBe(true)
    vi.resetModules()
    const { RollbackService: ReloadedService } = await import('../src/service.ts')
    const replacement = h.mount(ReloadedService)
    try {
      await expect(replacement.service.recover(h.session as never, false)).rejects.toThrow('本会话已有回退')
    } finally { release.resolve() }
    expect(await result).toBeInstanceOf(Error)
    expect(h.files.get(h.paths[0]!)?.content).toBe('old')
    expect(h.session.append).not.toHaveBeenCalled()
    expect(loadTransaction(h.id)?.phase).toBe('restoring')
    await expect(replacement.service.recover(h.session as never, false)).resolves.toMatchObject({ truncated: true })
    expect(loadTransaction(h.id)).toBeNull()
    expect(h.session.append).toHaveBeenCalledTimes(1)
  })

  it('cancels at the pre-I/O durability wait without creating a journal or touching files', async () => {
    const h = harness()
    const entered = deferred<void>()
    const release = deferred<boolean>()
    h.ctx.sessions.flush.mockImplementationOnce(() => { entered.resolve(); return release.promise })
    const result = h.service.execute(h.session as never, 1).catch(error => error as Error)
    await entered.promise
    h.dispose()
    release.resolve(true)
    expect(await result).toBeInstanceOf(Error)
    expect(h.fs.writeText).not.toHaveBeenCalled()
    expect(h.session.append).not.toHaveBeenCalled()
    expect(loadTransaction(h.id)).toBeNull()
  })

  it('refuses a detached Session before starting rollback I/O', async () => {
    const h = harness()
    h.setLive({ ...h.session })
    await expect(h.service.execute(h.session as never, 1)).rejects.toThrow('关闭或替换')
    expect(h.fs.writeText).not.toHaveBeenCalled()
    expect(h.session.append).not.toHaveBeenCalled()
    expect(loadTransaction(h.id)).toBeNull()
  })

  it('does not append a marker when the exact Session is replaced during an awaited write', async () => {
    const h = harness()
    const entered = deferred<void>()
    const release = deferred<void>()
    h.fs.writeText.mockImplementation(async (target, content, expected) => {
      entered.resolve()
      await release.promise
      return h.commit(target, content, expected)
    })
    const result = h.service.execute(h.session as never, 1).catch(error => error as Error)
    await entered.promise
    h.setLive({ ...h.session })
    release.resolve()
    expect(await result).toBeInstanceOf(Error)
    expect(h.session.append).not.toHaveBeenCalled()
    expect(loadTransaction(h.id)?.phase).toBe('restoring')
  })

  it('retains the marker journal when the exact Session is replaced during the final flush', async () => {
    const h = harness()
    const fold = h.service.foldFor(h.session as never)
    const finalize = vi.spyOn(fold, 'dropFromExcept')
    const entered = deferred<void>()
    const release = deferred<boolean>()
    h.ctx.sessions.flush.mockResolvedValueOnce(true).mockImplementationOnce(() => { entered.resolve(); return release.promise })
    const result = h.service.execute(h.session as never, 1).catch(error => error as Error)
    await entered.promise
    expect(loadTransaction(h.id)?.phase).toBe('marker')
    const replacement = { ...h.session }
    h.setLive(replacement)
    release.resolve(true)
    expect(await result).toBeInstanceOf(Error)
    expect(finalize).not.toHaveBeenCalled()
    expect(loadTransaction(h.id)?.phase).toBe('marker')
    const writes = h.fs.writeText.mock.calls.length
    await expect(h.service.recover(replacement as never, false)).resolves.toMatchObject({ truncated: true })
    expect(h.fs.writeText).toHaveBeenCalledTimes(writes)
    expect(h.session.append).toHaveBeenCalledTimes(1)
    expect(loadTransaction(h.id)).toBeNull()
  })

  it('propagates session/disposed cancellation to an in-flight write and preserves its journal', async () => {
    const h = harness()
    const entered = deferred<void>()
    const release = deferred<void>()
    let signal: AbortSignal | undefined
    h.fs.writeText.mockImplementation(async (target, content, expected, operationSignal) => {
      signal = operationSignal
      entered.resolve()
      await release.promise
      return h.commit(target, content, expected)
    })
    const result = h.service.execute(h.session as never, 1).catch(error => error as Error)
    await entered.promise
    h.setLive(undefined)
    h.broadcast('session/disposed', h.session)
    expect(signal?.aborted).toBe(true)
    release.resolve()
    expect(await result).toBeInstanceOf(Error)
    expect(h.session.append).not.toHaveBeenCalled()
    expect(h.ctx.emit).not.toHaveBeenCalled()
    expect(loadTransaction(h.id)?.phase).toBe('restoring')
  })

  it('retries after the real inbox/start/claim/blocked-end sequence without weakening the preview version', async () => {
    const h = harness(2)
    await partialFailure(h)
    const originalVersion = loadTransaction(h.id)!.version
    await blockedAttempt(h)
    h.session.append('command/run', { command: 'rollback', args: 'retry' })
    h.session.append('command/done', { command: 'rollback', args: 'retry' })
    expect(h.service.versionOf(h.session as never)).toBeGreaterThan(originalVersion)
    expect(loadTransaction(h.id)!.version).toBe(originalVersion)
    await expect(h.service.recover(h.session as never, false)).resolves.toMatchObject({ truncated: true })
    expect(h.paths.map(path => h.files.get(path)?.content)).toEqual(['old', 'old'])
    expect(loadTransaction(h.id)).toBeNull()
    expect(h.events.filter(event => event.type === 'user/message' && event.data.source?.kind === 'plugin:rollback')).toHaveLength(1)
  })

  it('does not poison future previews by rescanning a blocked turn during pending recovery', async () => {
    const h = harness()
    const marker = planTruncationMarker({ events: h.events, surface: h.session.surface } as never, { fromTurn: 1, messageId: 'crash-before-baseline' })!
    saveTransaction({
      format: 1, id: 'write-before-baseline', sessionId: h.id, fromTurn: 1, version: h.service.versionOf(h.session as never),
      phase: 'restoring', marker, files: [{ path: h.paths[0]!, before: 'new', after: 'old' }],
    })
    // Crash point: file publication succeeded, but resetAfterRollback never ran.
    h.setFile(h.paths[0]!, 'old')
    await blockedAttempt(h)
    // Let the production native scanner finish if the lifecycle hook queued one.
    // A contained scan rejection is recorded for the later preview assertion.
    const scanner = (h.service as unknown as { rescan: { settled(id: string): Promise<void> } }).rescan
    await scanner.settled(h.id).catch(() => undefined)
    await expect(h.service.recover(h.session as never, true)).resolves.toMatchObject({ truncated: false })
    expect(h.files.get(h.paths[0]!)?.content).toBe('new')
    expect(loadTransaction(h.id)).toBeNull()
    await expect(h.service.preview(h.session as never, 1)).resolves.toMatchObject({
      restored: [expect.objectContaining({ path: h.paths[0], content: 'old' })],
    })
  })

  it('still refuses stale recovery when new input is queued after a blocked turn', async () => {
    const h = harness(2)
    await partialFailure(h)
    await blockedAttempt(h)
    queueInput(h, 'still-pending')
    const writes = h.fs.writeText.mock.calls.length
    await expect(h.service.recover(h.session as never, false)).rejects.toThrow('会话已发生变化')
    expect(h.fs.writeText).toHaveBeenCalledTimes(writes)
    expect(loadTransaction(h.id)?.phase).toBe('restoring')
  })

  it('does not treat an actual step inside a blocked-ended turn as a harmless rejected attempt', async () => {
    const h = harness(2)
    await partialFailure(h)
    queueInput(h)
    h.session.append('turn/start', { turn: 2 })
    h.session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
    h.session.append('step/start', { turn: 2, step: 1 })
    h.session.append('step/end', { turn: 2, step: 1 })
    h.session.append('turn/end', { turn: 2, reason: { kind: 'blocked' } })
    await expect(h.service.recover(h.session as never, false)).rejects.toThrow('会话已发生变化')
    expect(loadTransaction(h.id)?.phase).toBe('restoring')
  })

  it('rejects a blocked envelope that leaves input queued instead of consuming it', async () => {
    const h = harness(2)
    await partialFailure(h)
    queueInput(h)
    h.session.append('turn/start', { turn: 2 })
    h.session.append('turn/end', { turn: 2, reason: { kind: 'blocked' } })
    await expect(h.service.recover(h.session as never, false)).rejects.toThrow('会话已发生变化')
    expect(loadTransaction(h.id)?.phase).toBe('restoring')
  })

  it('clears a committed file-only journal even after later substantive log changes', async () => {
    const h = harness()
    h.dispose()
    // This earlier turn changed files without appending any surface nodes.
    h.events.splice(0, h.events.length,
      { type: 'turn/start', seq: 0, data: { turn: 1 } },
      { type: 'turn/end', seq: 1, data: { turn: 1, reason: { kind: 'completed' } } },
    )
    h.session.surface.nodes = []
    const transaction: RollbackTransaction = {
      format: 1, id: 'file-only-committed', sessionId: h.id, fromTurn: 1, version: 1,
      phase: 'committed', marker: null, files: [{ path: h.paths[0]!, before: 'new', after: 'old' }],
    }
    h.setFile(h.paths[0]!, 'external edit after file-only commit')
    saveTransaction(transaction)
    h.session.append('user/message', { id: 'later-input', role: 'user', content: [] }, { surfaceOp: 'append' })
    const restarted = h.mount()
    h.fs.stat.mockClear()
    h.fs.readText.mockClear()
    h.fs.writeText.mockClear()
    await expect(restarted.service.recover(h.session as never, false)).resolves.toMatchObject({ truncated: false })
    expect(h.files.get(h.paths[0]!)?.content).toBe('external edit after file-only commit')
    expect(h.fs.stat).not.toHaveBeenCalled()
    expect(h.fs.readText).not.toHaveBeenCalled()
    expect(h.fs.writeText).not.toHaveBeenCalled()
    expect(h.session.append).toHaveBeenCalledTimes(1)
    expect(loadTransaction(h.id)).toBeNull()
  })

  it.each([false, true])('finalizes a committed journal without re-reading or overwriting a subsequent external edit (saved action: %s)', async savedAction => {
    const h = harness()
    const marker = planTruncationMarker({ events: h.events, surface: h.session.surface } as never, { fromTurn: 1, messageId: 'committed-marker' })!
    const transaction: RollbackTransaction = {
      format: 1, id: 'committed-transaction', sessionId: h.id, fromTurn: 1, version: h.service.versionOf(h.session as never),
      phase: 'committed', marker, files: [{ path: h.paths[0]!, before: savedAction ? null : 'new', after: 'old', ...(savedAction ? { action: 'restore' as const } : {}) }],
    }
    h.setFile(h.paths[0]!, 'old')
    h.session.append('user/message', marker.data, { surfaceOp: { op: 'replace', startSeq: marker.range!.start, endSeq: marker.range!.end }, sourceEventSeqs: [...marker.sourceEventSeqs] })
    expect(await h.ctx.sessions.flush()).toBe(true)
    saveTransaction(transaction)
    h.dispose()
    h.setFile(h.paths[0]!, 'external edit after commit')
    const restarted = h.mount()
    h.fs.stat.mockClear()
    h.fs.readText.mockClear()
    h.fs.writeText.mockClear()
    await expect(restarted.service.recover(h.session as never, true)).rejects.toThrow('不能取消')
    await expect(restarted.service.recover(h.session as never, false)).resolves.toMatchObject({ truncated: true,
      restored: [{ path: h.paths[0], action: 'restore', kind: 'updated', content: 'old' }] })
    expect(h.files.get(h.paths[0]!)?.content).toBe('external edit after commit')
    expect(h.fs.stat).not.toHaveBeenCalled()
    expect(h.fs.readText).not.toHaveBeenCalled()
    expect(h.fs.writeText).not.toHaveBeenCalled()
    expect(loadTransaction(h.id)).toBeNull()
  })
})
