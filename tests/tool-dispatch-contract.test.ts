import type {} from '../src/dsh-types.ts'
import { Context } from '@deepseek-ai/cordis'
import { Session } from '@deepseek-ai/dsh-session'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, type ToolExecutionInput, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { BoundaryRescan } from '../src/boundary-rescan.ts'
import { RollbackService } from '../src/service.ts'
import { appendCheckpoint, loadCheckpoints } from '../src/store.ts'
import { appendRecoveryGap, loadRecoveryGaps } from '../src/recovery-gap-store.ts'
import { loadTransaction } from '../src/transaction-store.ts'

const contexts: Context[] = []
const temporaryRoots: string[] = []
let previousHome: string | undefined
let changedHome = false

afterEach(async () => {
  try {
    for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  } finally {
    vi.restoreAllMocks()
    if (changedHome) {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      changedHome = false
    }
    for (const root of temporaryRoots.splice(0)) {
      // Delete only the exact temporary directory allocated by this fixture.
      if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith('rollback-tool-contract-')) {
        throw new Error('Unexpected contract-fixture cleanup path')
      }
      rmSync(root, { recursive: true, force: true })
    }
  }
})

function runtime() {
  // Actual public Cordis container and pinned services, not a hand-written bus
  // or direct invocation of listeners. No profile, loader, Agent loop, or LLM.
  const ctx = new Context()
  contexts.push(ctx)
  new SystemPrompt(ctx, {})
  new ToolRuntime(ctx)
  return ctx
}

function input(name: string, arguments_: unknown = {}, agent?: ToolExecutionInput['agent']): ToolExecutionInput {
  return {
    callId: `contract-${name}` as ToolExecutionInput['callId'],
    name,
    arguments: arguments_,
    signal: new AbortController().signal,
    ...(agent === undefined ? {} : { agent }),
  }
}

describe('pinned real Cordis tools dispatch contract', () => {
  it.each(['success', 'throw'] as const)('normalizes %s inside next() and unwinds around-dispatch before final result', async outcome => {
    const ctx = runtime()
    const order: string[] = []
    let delegated: ToolExecutionResult | undefined
    let observed: Readonly<ToolExecutionResult> | undefined
    let finalFrozen: boolean[] | undefined
    ctx.tools.register({
      name: 'contract_probe', description: 'Isolated dispatch probe',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async () => {
        order.push('body')
        if (outcome === 'throw') throw new Error('contract-body-failed')
        return { answer: 'ok' }
      },
    })
    ctx.on('tools/execute', async (exec, next) => {
      order.push('around:before')
      expect(exec.name).toBe('contract_probe')
      try {
        delegated = await next()
        order.push(`around:after:${delegated.isError ? 'error' : 'success'}`)
        // Final observers cannot already have run while the around hook unwinds.
        expect(observed).toBeUndefined()
        return delegated
      } finally {
        order.push('around:finally')
      }
    })
    ctx.on('tools/post-execute', async (_exec, result, next) => {
      order.push(`post:${result.isError ? 'error' : 'success'}`)
      return next()
    })
    ctx.on('tools/result', (exec, result) => {
      order.push(`result:${result.isError ? 'error' : 'success'}`)
      observed = result
      finalFrozen = [Object.isFrozen(exec), Object.isFrozen(result), Object.isFrozen(result.content)]
      return undefined
    })

    const result = await ctx.tools.execute(input('contract_probe'))
    order.push('caller:resolved')
    const status = outcome === 'success' ? 'success' : 'error'
    expect(order).toEqual([
      'around:before', 'body', `around:after:${status}`, 'around:finally',
      `post:${status}`, `result:${status}`, 'caller:resolved',
    ])
    expect(observed).toBe(result)
    expect(finalFrozen).toEqual([true, true, true])
    expect(delegated?.isError).toBe(outcome === 'throw')
    if (outcome === 'success') {
      expect(delegated).toMatchObject({ isError: false, value: { answer: 'ok' }, content: [{ type: 'text' }] })
      expect(result).not.toHaveProperty('error')
    } else {
      // The tool-body exception does NOT reject next(): failure is a tagged result.
      expect(delegated).toMatchObject({ isError: true, error: { message: 'contract-body-failed' }, content: [{ type: 'text' }] })
      expect(result).not.toHaveProperty('value')
    }
  })
})

function rollbackFixture(withWorkingDirectory = false) {
  const ctx = runtime()
  const root = mkdtempSync(join(tmpdir(), 'rollback-tool-contract-'))
  temporaryRoots.push(root)
  previousHome = process.env.DSH_HOME
  changedHome = true
  process.env.DSH_HOME = root

  const session = Session.create('tool-dispatch-contract-session' as Session['id'])
  const paths = [join(root, 'direct.txt'), join(root, 'unrelated.txt')]
  const files = new Map<string, { content: string; version: string }>()
  let revision = 0
  const setFile = (path: string, content: string) => {
    const version = `contract-v${++revision}`
    files.set(path, { content, version })
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
    return version
  }
  for (const path of paths) {
    setFile(path, 'previous-after')
    appendCheckpoint({ sessionId: String(session.id), turn: 1, path, operation: 'update', before: 'previous-before', after: 'previous-after' })
  }
  session.append('turn/start', { turn: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } } as never)

  // Narrow filesystem/session-service fixtures copied from service-lifecycle:
  // native disk mirrors the versioned fake so the real BoundaryRescan agrees.
  // These services do not dispatch tools; Context and ToolRuntime remain real.
  ctx.provide('sessions', { get: (id: string) => id === session.id ? session : undefined, list: () => [session], flush: async () => true })
  ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: root }) })
  let cwd = root
  const aliases = new Map<string, string>()
  const canonicalPath = (path: string) => aliases.get(path) ?? path
  const workingDirectory = { ensure: vi.fn(async (_agent?: ToolExecutionInput['agent'], _signal?: AbortSignal) => cwd) }
  if (withWorkingDirectory) ctx.provide('workingDirectory', workingDirectory)
  const fs = {
    resolve: async (path: string, options?: { cwd?: string }) => {
      const displayPath = resolve(options?.cwd ?? root, path)
      return { displayPath, targetKey: canonicalPath(displayPath) }
    },
    processPath: (target: { displayPath: string; targetKey?: string }) => target.targetKey ?? target.displayPath,
    processPathFromHostPath: (path: string) => path,
    stat: async (target: { displayPath: string; targetKey?: string }) => {
      const current = files.get(target.targetKey ?? target.displayPath)
      return current === undefined ? undefined : { type: 'file', size: current.content.length, version: current.version }
    },
    readText: async (target: { displayPath: string; targetKey?: string }) => files.get(target.targetKey ?? target.displayPath)!.content,
    lstat: async (path: string) => files.has(canonicalPath(path)) ? { type: 'file' } : undefined,
    writeText: async (target: { displayPath: string; targetKey?: string }, content: string, expected?: { kind: string; version?: string }) => {
      const path = target.targetKey ?? target.displayPath
      const current = files.get(path)
      if (expected?.kind === 'createIfAbsent' && current !== undefined) throw new Error('File already exists')
      if (expected?.kind === 'replaceIfVersion' && current?.version !== expected.version) throw new Error('Version conflict')
      return { version: setFile(path, content) }
    },
  }
  ctx.provide('fs', fs)
  const rollback = new RollbackService(ctx)
  const restart = async () => {
    await ctx.fiber.dispose()
    const resumed = runtime()
    resumed.provide('sessions', { get: (id: string) => id === session.id ? session : undefined, list: () => [session], flush: async () => true })
    resumed.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: root }) })
    resumed.provide('fs', fs)
    return new RollbackService(resumed)
  }
  const publish = (type: 'turn/start' | 'turn/end', data: unknown) => {
    const event = session.append(type, data as never)
    ctx.emit('session/event', session, event)
  }
  const agent = { id: session.id } as NonNullable<ToolExecutionInput['agent']>
  return { ctx, session, paths, setFile, rollback, publish, agent, restart, root, workingDirectory, canonicalPath,
    alias: (display: string, target: string) => { aliases.set(display, target) },
    cd: (path: string) => { cwd = resolve(root, path) } }
}

function startFileTurn(h: ReturnType<typeof rollbackFixture>, turn = 2) {
  h.publish('turn/start', { turn })
  const message = h.session.append('user/message', {
    id: `cwd-turn-user-${turn}`, role: 'user', source: { kind: 'ui' }, content: [{ type: 'text', text: 'change file' }],
  } as never, { surfaceOp: 'append' })
  h.ctx.emit('session/event', h.session, message)
}

function registerDirectoryTool(h: ReturnType<typeof rollbackFixture>, name: 'write' | 'edit', reportedPath?: string, after = 'model-change') {
  return h.ctx.tools.register({
    name, description: 'Current-directory file mutation regression',
    parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
    output: {
      schema: { type: 'object', properties: { path: { type: 'string' }, before: { type: 'string' }, after: { type: 'string' }, version: { type: 'string' } }, required: ['path', 'before', 'after', 'version'] },
      render: () => [{ type: 'text', text: 'Written' }],
    },
    execute: async (args: { file_path: string }, exec) => {
      const target = h.canonicalPath(resolve(await h.workingDirectory.ensure(exec.agent, exec.signal), args.file_path))
      const before = existsSync(target) ? readFileSync(target, 'utf8') : ''
      const version = h.setFile(target, after)
      return { path: reportedPath ?? target, before, after, version }
    },
  })
}

describe('session working-directory compatibility', () => {
  it('keeps a gap despite same-turn successful, unchanged and net-zero receipts', async () => {
    const h = rollbackFixture(true)
    const target = h.paths[0]!
    startFileTurn(h)
    const mismatched = registerDirectoryTool(h, 'write', h.paths[1]!)
    await h.ctx.tools.execute(input('write', { file_path: target }, h.agent))
    mismatched()
    const restore = registerDirectoryTool(h, 'write', undefined, 'previous-after')
    await h.ctx.tools.execute({ ...input('write', { file_path: target }, h.agent), callId: 'same-turn-restore' as ToolExecutionInput['callId'] })
    restore()
    registerDirectoryTool(h, 'write', undefined, 'previous-after')
    await h.ctx.tools.execute({ ...input('write', { file_path: target }, h.agent), callId: 'same-turn-noop' as ToolExecutionInput['callId'] })
    // Even an independent legacy roundtrip cannot establish this failed call's basis.
    appendCheckpoint({ sessionId: String(h.session.id), turn: 2, path: h.paths[1]!, operation: 'update', before: 'previous-after', after: 'middle' })
    appendCheckpoint({ sessionId: String(h.session.id), turn: 2, path: h.paths[1]!, operation: 'update', before: 'middle', after: 'previous-after' })
    h.publish('turn/end', { turn: 2, reason: { kind: 'completed' } })
    expect(loadCheckpoints(String(h.session.id)).get(2)?.has(target)).toBe(true)
    await expect(h.rollback.preview(h.session, 2)).rejects.toThrow('恢复缺口')
    const restarted = await h.restart()
    await expect(restarted.execute(h.session, 2)).rejects.toThrow('恢复缺口')
    expect(loadRecoveryGaps(String(h.session.id))).toHaveLength(1)
    expect(readFileSync(target, 'utf8')).toBe('previous-after')
  })

  it('anchors a final-result mismatch to its dispatch turn after a post-hook starts another turn', async () => {
    const h = rollbackFixture(true)
    const target = h.paths[0]!
    startFileTurn(h)
    registerDirectoryTool(h, 'write')
    h.ctx.on('tools/post-execute', async (_exec, result) => {
      h.publish('turn/end', { turn: 2, reason: { kind: 'completed' } })
      startFileTurn(h, 3)
      return { kind: 'accept', value: { ...(result.value as Record<string, string>), path: h.paths[1]! } }
    })
    expect((await h.ctx.tools.execute(input('write', { file_path: target }, h.agent))).isError).toBe(false)
    h.publish('turn/end', { turn: 3, reason: { kind: 'completed' } })
    expect(loadRecoveryGaps(String(h.session.id))).toEqual([expect.objectContaining({ turn: 2, stage: 'result' })])
    expect((await h.rollback.preview(h.session, 3)).restored).toEqual([])
    await expect(h.rollback.execute(h.session, 2)).rejects.toThrow('恢复缺口')
    const restarted = await h.restart()
    expect((await restarted.preview(h.session, 3)).restored).toEqual([])
    await expect(restarted.preview(h.session, 2)).rejects.toThrow('恢复缺口')
  })

  it('rechecks a gap added after a successful preview even without a session version change', async () => {
    const h = rollbackFixture()
    const plan = await h.rollback.preview(h.session, 1)
    appendRecoveryGap({ format: 1, sessionId: String(h.session.id), turn: 1, callId: 'late-gap', tool: 'write',
      expectedPath: h.paths[0]!, reportedPath: h.paths[1]!, stage: 'result' })
    const append = vi.spyOn(h.session, 'append')
    await expect(h.rollback.execute(h.session, 1, undefined, plan.version)).rejects.toThrow('恢复缺口')
    expect(append).not.toHaveBeenCalled()
    expect(loadTransaction(String(h.session.id))).toBeNull()
    expect(readFileSync(h.paths[0]!, 'utf8')).toBe('previous-after')
  })

  it('keeps a persisted gap when its turn ages out of checkpoint storage', async () => {
    const h = rollbackFixture()
    appendRecoveryGap({ format: 1, sessionId: String(h.session.id), turn: 1, callId: 'old-gap', tool: 'write',
      expectedPath: h.paths[0]!, reportedPath: h.paths[1]!, stage: 'dispatch' })
    appendCheckpoint({ sessionId: String(h.session.id), turn: 40, path: h.paths[0]!, operation: 'update', before: 'previous-after', after: 'future' })
    expect(loadCheckpoints(String(h.session.id)).has(1)).toBe(false)
    expect(loadRecoveryGaps(String(h.session.id))).toHaveLength(1)
    await expect(h.rollback.preview(h.session, 1)).rejects.toThrow('恢复缺口')
  })

  it('stops marker commit when a gap arrives during file restore and lets abort compensate', async () => {
    const h = rollbackFixture(true)
    const target = h.paths[0]!
    startFileTurn(h)
    registerDirectoryTool(h, 'write')
    await h.ctx.tools.execute(input('write', { file_path: target }, h.agent))
    h.publish('turn/end', { turn: 2, reason: { kind: 'completed' } })
    const surface = [...h.session.surface.nodes]
    const write = h.ctx.fs.writeText.bind(h.ctx.fs)
    const writeSpy = vi.spyOn(h.ctx.fs, 'writeText').mockImplementation(async (...args) => {
      const outcome = await write(...args)
      appendRecoveryGap({ format: 1, sessionId: String(h.session.id), turn: 2, callId: 'late-result-during-restore', tool: 'write',
        expectedPath: target, reportedPath: h.paths[1]!, stage: 'result' })
      return outcome
    })
    await expect(h.rollback.execute(h.session, 2)).rejects.toThrow('/rollback abort')
    expect(h.session.surface.nodes).toEqual(surface)
    expect(readFileSync(target, 'utf8')).toBe('previous-after')
    expect(loadTransaction(String(h.session.id))?.phase).toBe('restoring')
    writeSpy.mockRestore()
    await expect(h.rollback.recover(h.session, false)).rejects.toThrow('恢复缺口')
    await h.rollback.recover(h.session, true)
    expect(loadTransaction(String(h.session.id))).toBeNull()
    expect(readFileSync(target, 'utf8')).toBe('model-change')
    expect(h.session.surface.nodes).toEqual(surface)
    await expect(h.rollback.preview(h.session, 2)).rejects.toThrow('恢复缺口')
  })

  it('keeps partial-error recovery when the host rejects a post-hook attempt to replace its value', async () => {
    const h = rollbackFixture(true)
    const target = h.paths[0]!
    startFileTurn(h)
    h.ctx.tools.register({
      name: 'write', description: 'Partial write before error',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'null' }, render: () => [] },
      execute: async () => { h.setFile(target, 'partial'); throw new Error('partial-error') },
    })
    h.ctx.on('tools/post-execute', async () => ({
      kind: 'accept', value: { path: h.paths[1]!, before: 'wrong-basis', after: 'partial' },
    }))
    const result = await h.ctx.tools.execute(input('write', { file_path: target }, h.agent))
    expect(result).toMatchObject({ isError: true, error: { message: expect.stringContaining('cannot replace the value of a failed result') } })
    h.publish('turn/end', { turn: 2, reason: { kind: 'completed' } })
    expect(loadCheckpoints(String(h.session.id)).get(2)?.get(target)).toMatchObject({ before: 'previous-after', after: 'partial' })
    expect(loadRecoveryGaps(String(h.session.id))).toEqual([])
    await h.rollback.execute(h.session, 2)
    expect(readFileSync(target, 'utf8')).toBe('previous-after')
  })

  it('retains strict session failure when the operation gap cannot be persisted', async () => {
    const h = rollbackFixture(true)
    const gapFile = join(h.root, 'storages', 'dsh-rollback', 'recovery-gaps-v1',
      `s-${Buffer.from(String(h.session.id), 'utf16le').toString('hex')}.json`)
    mkdirSync(gapFile, { recursive: true })
    startFileTurn(h)
    registerDirectoryTool(h, 'write', h.paths[1]!)
    expect((await h.ctx.tools.execute(input('write', { file_path: h.paths[0]! }, h.agent))).isError).toBe(false)
    h.publish('turn/end', { turn: 2, reason: { kind: 'completed' } })
    startFileTurn(h, 3)
    h.publish('turn/end', { turn: 3, reason: { kind: 'completed' } })
    await expect(h.rollback.preview(h.session, 3)).rejects.toThrow('持久化')
    expect(await h.rollback.diagnose(h.session)).toMatchObject({ checkpointState: 'failed', recoveryGaps: null })
    expect(loadTransaction(String(h.session.id))).toBeNull()
  })

  it('refuses unreadable gap evidence both live and after restart', async () => {
    const h = rollbackFixture()
    appendRecoveryGap({ format: 1, sessionId: String(h.session.id), turn: 1, callId: 'corrupt-gap', tool: 'write',
      expectedPath: h.paths[0]!, reportedPath: h.paths[1]!, stage: 'dispatch' })
    const gapFile = join(h.root, 'storages', 'dsh-rollback', 'recovery-gaps-v1',
      `s-${Buffer.from(String(h.session.id), 'utf16le').toString('hex')}.json`)
    writeFileSync(gapFile, '{broken')
    await expect(h.rollback.preview(h.session, 1)).rejects.toThrow('recovery gap')
    const restarted = await h.restart()
    await expect(restarted.execute(h.session, 1)).rejects.toThrow('持久化')
    expect(readFileSync(h.paths[0]!, 'utf8')).toBe('previous-after')
    expect(loadTransaction(String(h.session.id))).toBeNull()
  })

  it('does not capture file ownership for working-directory changes', async () => {
    const h = rollbackFixture(true)
    startFileTurn(h)
    const capture = vi.spyOn(BoundaryRescan.prototype, 'captureDispatch')
    const finish = vi.spyOn(BoundaryRescan.prototype, 'finishDispatch')
    h.ctx.tools.register({
      name: 'working_directory', description: 'Directory-only operation',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'null' }, render: () => [] },
      execute: async () => { h.cd('sub'); h.setFile(h.paths[0]!, 'external-edit'); return null },
    })
    expect((await h.ctx.tools.execute(input('working_directory', {}, h.agent))).isError).toBe(false)
    h.publish('turn/end', { turn: 2, reason: { kind: 'completed' } })
    expect(capture).not.toHaveBeenCalled()
    expect(finish).not.toHaveBeenCalled()
    expect(loadCheckpoints(String(h.session.id)).has(2)).toBe(false)
    expect((await h.rollback.preview(h.session, 2)).restored).toEqual([])
    expect(readFileSync(h.paths[0]!, 'utf8')).toBe('external-edit')
  })

  it.each(['write', 'edit'] as const)('restores relative %s in the effective directory without touching its original-root twin', async name => {
    const h = rollbackFixture(true)
    const original = join(h.root, 'same.txt')
    const target = join(h.root, 'sub', 'same.txt')
    h.setFile(original, 'root-twin')
    h.setFile(target, 'sub-before')
    h.cd('sub')
    startFileTurn(h)
    registerDirectoryTool(h, name)
    expect((await h.ctx.tools.execute(input(name, { file_path: 'same.txt' }, h.agent))).isError).toBe(false)
    expect(h.workingDirectory.ensure).toHaveBeenCalledWith(h.agent, expect.any(AbortSignal))
    h.publish('turn/end', { turn: 2, reason: { kind: 'completed' } })
    expect(loadCheckpoints(String(h.session.id)).get(2)?.get(target)).toMatchObject({ before: 'sub-before', after: 'model-change' })
    expect(loadCheckpoints(String(h.session.id)).get(2)?.has(original)).not.toBe(true)
    // Restoring absolute recorded paths must not depend on the later cwd or
    // require the new service when loading checkpoints in a legacy fixture.
    h.cd('elsewhere')
    const resumed = await h.restart()
    expect((await resumed.preview(h.session, 2)).restored).toEqual([
      expect.objectContaining({ path: target, content: 'sub-before', action: 'restore' }),
    ])
    await resumed.execute(h.session, 2)
    expect(readFileSync(target, 'utf8')).toBe('sub-before')
    expect(readFileSync(original, 'utf8')).toBe('root-twin')
  })

  it('deletes only the file created in the effective directory', async () => {
    const h = rollbackFixture(true)
    const original = join(h.root, 'new.txt')
    const target = join(h.root, 'sub', 'new.txt')
    h.setFile(original, 'root-twin')
    h.cd('sub')
    startFileTurn(h)
    registerDirectoryTool(h, 'write')
    expect((await h.ctx.tools.execute(input('write', { file_path: 'new.txt' }, h.agent))).isError).toBe(false)
    h.publish('turn/end', { turn: 2, reason: { kind: 'completed' } })
    expect((await h.rollback.preview(h.session, 2)).restored).toEqual([
      expect.objectContaining({ path: target, action: 'delete' }),
    ])
    await h.rollback.execute(h.session, 2)
    expect(existsSync(target)).toBe(false)
    expect(readFileSync(original, 'utf8')).toBe('root-twin')
  })

  it('resolves relative targets at the original root when the host has no directory service', async () => {
    const h = rollbackFixture()
    const target = h.paths[0]!
    startFileTurn(h)
    registerDirectoryTool(h, 'write')
    expect((await h.ctx.tools.execute(input('write', { file_path: basename(target) }, h.agent))).isError).toBe(false)
    h.publish('turn/end', { turn: 2, reason: { kind: 'completed' } })
    expect((await h.rollback.preview(h.session, 2)).restored).toEqual([
      expect.objectContaining({ path: target, content: 'previous-after' }),
    ])
    await h.rollback.execute(h.session, 2)
    expect(readFileSync(target, 'utf8')).toBe('previous-after')
  })

  it('keeps absolute tool paths fixed after changing the effective directory', async () => {
    const h = rollbackFixture(true)
    const target = h.paths[0]!
    h.cd('sub')
    startFileTurn(h)
    registerDirectoryTool(h, 'edit')
    expect((await h.ctx.tools.execute(input('edit', { file_path: target }, h.agent))).isError).toBe(false)
    h.publish('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await h.rollback.execute(h.session, 2)
    expect(readFileSync(target, 'utf8')).toBe('previous-after')
  })

  it.each(['write', 'edit'] as const)('uses canonical process paths for %s through a provider alias', async name => {
    const h = rollbackFixture(true)
    const target = h.paths[0]!
    const alias = join(h.root, 'alias', 'same.txt')
    h.alias(alias, target)
    h.cd('alias')
    startFileTurn(h)
    registerDirectoryTool(h, name)
    expect((await h.ctx.tools.execute(input(name, { file_path: 'same.txt' }, h.agent))).isError).toBe(false)
    h.publish('turn/end', { turn: 2, reason: { kind: 'completed' } })
    expect(loadCheckpoints(String(h.session.id)).get(2)?.has(alias)).not.toBe(true)
    expect((await h.rollback.preview(h.session, 2)).restored).toEqual([
      expect.objectContaining({ path: target, content: 'previous-after' }),
    ])
    await h.rollback.execute(h.session, 2)
    expect(readFileSync(target, 'utf8')).toBe('previous-after')
  })

  it('refreshes the capture if cwd changes between pre-execute and dispatch', async () => {
    const h = rollbackFixture(true)
    const oldTarget = join(h.root, 'first', 'same.txt')
    const target = join(h.root, 'second', 'same.txt')
    h.setFile(oldTarget, 'first-before')
    h.setFile(target, 'second-before')
    h.cd('first')
    startFileTurn(h)
    h.ctx.on('tools/pre-execute', async (_exec, next) => {
      const decision = await next()
      h.cd('second')
      return decision
    }, { prepend: true })
    registerDirectoryTool(h, 'write')
    expect((await h.ctx.tools.execute(input('write', { file_path: 'same.txt' }, h.agent))).isError).toBe(false)
    h.publish('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await h.rollback.execute(h.session, 2)
    expect(readFileSync(target, 'utf8')).toBe('second-before')
    expect(readFileSync(oldTarget, 'utf8')).toBe('first-before')
  })

  it.each(['body', 'post-error', 'post-result', 'post-block', 'post-corrected'] as const)('isolates a %s mismatch and permits later-turn rollback before and after restart', async phase => {
    const h = rollbackFixture(true)
    const target = h.paths[0]!
    const unrelated = h.paths[1]!
    startFileTurn(h)
    const unregister = registerDirectoryTool(h, 'write', phase === 'post-result' ? undefined : unrelated)
    const call = input('write', { file_path: target }, h.agent)
    h.session.append('tool/call', { turn: 2, callId: call.callId, name: 'write', arguments: JSON.stringify(call.arguments) } as never)
    const post = phase === 'body' ? undefined : h.ctx.on('tools/post-execute', async (_exec, result) => {
      if (phase === 'post-error') throw new Error('late-hook-failure')
      if (phase === 'post-block') return { kind: 'block', feedback: [{ type: 'text', text: 'late-hook-block' }] }
      return { kind: 'accept', value: { ...(result.value as Record<string, string>), path: phase === 'post-corrected' ? target : unrelated } }
    })
    const result = await h.ctx.tools.execute(call)
    expect(result.isError).toBe(phase === 'post-error' || phase === 'post-block')
    if (phase === 'post-error') expect(result).toMatchObject({ error: { message: 'late-hook-failure' } })
    h.session.append('tool/result', { turn: 2, message: { source: { callId: call.callId }, isError: result.isError },
      ...(result.isError ? { error: result.error } : {}),
    } as never, { surfaceOp: 'append' })
    post?.()
    unregister()
    h.publish('turn/end', { turn: 2, reason: { kind: 'completed' } })
    expect(loadCheckpoints(String(h.session.id)).has(2)).toBe(false)
    expect(loadRecoveryGaps(String(h.session.id))).toEqual([
      { format: 1, sessionId: String(h.session.id), turn: 2, callId: call.callId, tool: 'write',
        expectedPath: target, reportedPath: unrelated, stage: phase === 'post-result' ? 'result' : 'dispatch' },
    ])
    expect(await h.rollback.diagnose(h.session)).toMatchObject({ checkpointState: 'partial', recoveryGaps: [expect.objectContaining({ turn: 2 })] })
    const originalSurface = [...h.session.surface.nodes]
    const append = vi.spyOn(h.session, 'append')
    await expect(h.rollback.preview(h.session, 2)).rejects.toThrow('第 2 轮 write')
    await expect(h.rollback.execute(h.session, 1)).rejects.toThrow('恢复缺口')
    expect(h.session.surface.nodes).toEqual(originalSurface)
    expect(append).not.toHaveBeenCalled()
    expect(loadTransaction(String(h.session.id))).toBeNull()
    expect(readFileSync(target, 'utf8')).toBe('model-change')
    expect(readFileSync(unrelated, 'utf8')).toBe('previous-after')
    append.mockRestore()

    // A later normal mutation, including the same file, has its own trusted basis.
    startFileTurn(h, 3)
    registerDirectoryTool(h, 'write', undefined, 'later-change')
    const later = { ...input('write', { file_path: target }, h.agent), callId: 'later-write' as ToolExecutionInput['callId'] }
    h.session.append('tool/call', { turn: 3, callId: later.callId, name: 'write', arguments: JSON.stringify(later.arguments) } as never)
    expect((await h.ctx.tools.execute(later)).isError).toBe(false)
    h.session.append('tool/result', { turn: 3, message: { source: { callId: later.callId } } } as never, { surfaceOp: 'append' })
    h.publish('turn/end', { turn: 3, reason: { kind: 'completed' } })
    const expected = [expect.objectContaining({ path: target, content: 'model-change', action: 'restore' })]
    expect((await h.rollback.preview(h.session, 3)).restored).toEqual(expected)
    expect(h.rollback.availableTurns(h.session)).toEqual([3])
    await expect(h.rollback.preview(h.session, 2)).rejects.toThrow('第 3 轮')
    const restarted = await h.restart()
    expect(restarted.availableTurns(h.session)).toEqual([3])
    expect((await restarted.preview(h.session, 3)).restored).toEqual(expected)
    await expect(restarted.execute(h.session, 2)).rejects.toThrow('恢复缺口')
    expect(readFileSync(target, 'utf8')).toBe('later-change')
    await restarted.execute(h.session, 3)
    expect(readFileSync(target, 'utf8')).toBe('model-change')
    expect(readFileSync(unrelated, 'utf8')).toBe('previous-after')
    expect(loadRecoveryGaps(String(h.session.id))).toHaveLength(1)
    await expect(restarted.preview(h.session, 2)).rejects.toThrow('恢复缺口')
  })
})

describe('production rollback on the real tools dispatch pipeline', () => {
  it('leaves canonical direct success to tools/result without a pre-result broad scan or unrelated ownership', async () => {
    const h = rollbackFixture()
    const [target, unrelated] = h.paths as [string, string]
    h.setFile(target, 'user-edited-basis')
    h.setFile(unrelated, 'unrelated-user-edit')
    h.publish('turn/start', { turn: 2 })
    const capture = vi.spyOn(BoundaryRescan.prototype, 'captureDispatch')
    const finish = vi.spyOn(BoundaryRescan.prototype, 'finishDispatch')
    const order: string[] = []
    // This observer is outside the production around hook; its unwind sees all
    // work the hook did after next(), but tools/result has not run yet.
    h.ctx.on('tools/execute', async (_exec, next) => {
      const result = await next()
      order.push('around:returned')
      expect(result.isError).toBe(false)
      expect(finish).not.toHaveBeenCalled()
      expect(loadCheckpoints(String(h.session.id)).has(2)).toBe(false)
      return result
    }, { prepend: true })
    h.ctx.tools.register({
      name: 'write', description: 'Canonical direct-write fixture',
      parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
      output: {
        schema: {
          type: 'object', properties: { path: { type: 'string' }, before: { type: 'string' }, after: { type: 'string' }, version: { type: 'string' } },
          required: ['path', 'before', 'after', 'version'], additionalProperties: false,
        },
        render: () => [{ type: 'text', text: 'Written' }],
      },
      execute: async () => {
        order.push('body')
        const version = h.setFile(target, 'model-direct')
        // External editing during the tool must not become direct-write ownership.
        h.setFile(unrelated, 'external-during-body')
        return { path: target, before: 'wrong-tool-basis', after: 'model-direct', version }
      },
    })
    let atResult: { isError: boolean; scans: number; checkpoint: unknown } | undefined
    h.ctx.on('tools/result', (_exec, result) => {
      order.push('result')
      atResult = {
        isError: result.isError,
        scans: finish.mock.calls.length,
        checkpoint: loadCheckpoints(String(h.session.id)).get(2)?.get(target),
      }
      return undefined
    })

    const result = await h.ctx.tools.execute(input('write', { file_path: target }, h.agent))
    expect(atResult).toMatchObject({
      isError: false, scans: 0,
      checkpoint: { before: 'user-edited-basis', after: 'model-direct' },
    })
    expect(result.isError).toBe(false)
    expect(capture).toHaveBeenCalledOnce()
    expect(finish).not.toHaveBeenCalled()
    expect(order).toEqual(['body', 'around:returned', 'result'])
    h.publish('turn/end', { turn: 2, reason: { kind: 'completed' } })
    const plan = await h.rollback.preview(h.session, 2)
    expect(plan.restored).toHaveLength(1)
    expect(plan.restored[0]).toMatchObject({ path: target, content: 'user-edited-basis' })
    expect(loadCheckpoints(String(h.session.id)).get(2)?.has(unrelated)).toBe(false)
    expect(readFileSync(unrelated, 'utf8')).toBe('external-during-body')
  })

  it.each(['write', 'str_replace_editor'] as const)('anchors successful %s to its dispatch turn when the turn closes before final result', async name => {
    const h = rollbackFixture()
    const target = h.paths[0]!
    h.setFile(target, 'dispatch-basis')
    h.publish('turn/start', { turn: 2 })
    const message = h.session.append('user/message', { id: 'closed-turn-user', role: 'user', source: { kind: 'ui' }, content: [{ type: 'text', text: 'change file' }] } as never, { surfaceOp: 'append' })
    h.ctx.emit('session/event', h.session, message)
    h.ctx.tools.register({
      name, description: 'Success with a closed original turn',
      parameters: { type: 'object', properties: {} },
      output: name === 'write' ? {
        schema: { type: 'object', properties: { path: { type: 'string' }, before: { type: 'string' }, after: { type: 'string' }, version: { type: 'string' } }, required: ['path', 'before', 'after', 'version'] },
        render: () => [{ type: 'text', text: 'Written' }],
      } : { schema: { type: 'null' }, render: () => [{ type: 'text', text: 'Edited' }] },
      execute: async () => {
        const version = h.setFile(target, 'tool-after')
        return name === 'write' ? { path: target, before: 'untrusted-before', after: 'tool-after', version } : null
      },
    })
    h.ctx.on('tools/post-execute', async (_exec, _result, next) => {
      h.publish('turn/end', { turn: 2, reason: { kind: 'completed' } })
      h.publish('turn/start', { turn: 3 })
      return next()
    })
    const args = name === 'write' ? { file_path: target } : { command: 'str_replace', path: target }
    expect((await h.ctx.tools.execute(input(name, args, h.agent))).isError).toBe(false)
    h.publish('turn/end', { turn: 3, reason: { kind: 'completed' } })
    expect(loadCheckpoints(String(h.session.id)).get(2)?.get(target)).toMatchObject({ before: 'dispatch-basis', after: 'tool-after' })
    expect(loadCheckpoints(String(h.session.id)).get(3)?.has(target)).not.toBe(true)
    const preview = await h.rollback.preview(h.session, 2)
    expect(preview.restored).toEqual([expect.objectContaining({ path: target, action: 'restore', content: 'dispatch-basis' })])
    const restarted = await h.restart()
    expect(await restarted.preview(h.session, 2)).toEqual(preview)
    await restarted.execute(h.session, 2)
    expect(readFileSync(target, 'utf8')).toBe('dispatch-basis')
  })

  it.each([false, true])('uses the fallback editor dispatch after-state instead of a post-hook external edit (tool changed: %s)', async changed => {
    const h = rollbackFixture()
    const [target, unrelated] = h.paths as [string, string]
    h.setFile(target, 'editor-basis')
    h.publish('turn/start', { turn: 2 })
    const message = h.session.append('user/message', { id: 'external-gap-user', role: 'user', source: { kind: 'ui' }, content: [{ type: 'text', text: 'edit file' }] } as never, { surfaceOp: 'append' })
    h.ctx.emit('session/event', h.session, message)
    h.ctx.tools.register({
      name: 'str_replace_editor', description: 'Fallback editor with a post-dispatch external gap',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'null' }, render: () => [{ type: 'text', text: 'Edited' }] },
      execute: async () => { if (changed) h.setFile(target, 'editor-after'); return null },
    })
    h.ctx.on('tools/post-execute', async (_exec, _result, next) => {
      h.setFile(target, 'external-after-body')
      h.setFile(unrelated, 'unrelated-external')
      return next()
    })
    expect((await h.ctx.tools.execute(input('str_replace_editor', { command: 'str_replace', path: target }, h.agent))).isError).toBe(false)
    h.publish('turn/end', { turn: 2, reason: { kind: 'completed' } })
    const preview = await h.rollback.preview(h.session, 2)
    const record = loadCheckpoints(String(h.session.id)).get(2)?.get(target)
    if (changed) {
      expect(record).toMatchObject({ before: 'editor-basis', after: 'editor-after' })
      expect(preview.restored).toEqual([expect.objectContaining({ path: target, content: 'editor-basis', conflict: true })])
    } else {
      expect(record).toBeUndefined()
      expect(preview.restored).toEqual([])
    }
    expect(loadCheckpoints(String(h.session.id)).get(2)?.has(unrelated)).not.toBe(true)
    const restarted = await h.restart()
    expect(await restarted.preview(h.session, 2)).toEqual(preview)
    await restarted.execute(h.session, 2)
    expect(readFileSync(target, 'utf8')).toBe(changed ? 'editor-basis' : 'external-after-body')
    expect(readFileSync(unrelated, 'utf8')).toBe('unrelated-external')
  })

  it('merges the original turn sidecar before a later start implicitly closes an interrupted turn', async () => {
    const h = rollbackFixture()
    const target = h.paths[0]!
    h.publish('turn/start', { turn: 2 })
    h.session.append('user/message', { id: 'interrupted-turn-user', role: 'user', source: { kind: 'ui' }, content: [{ type: 'text', text: 'write file' }] } as never, { surfaceOp: 'append' })
    h.session.append('tool/call', { turn: 2, callId: 'interrupted-write', name: 'write', arguments: JSON.stringify({ file_path: target }) } as never)
    h.setFile(target, 'interrupted-after')
    appendCheckpoint({ sessionId: String(h.session.id), turn: 2, path: target, operation: 'update', before: 'previous-after', after: 'interrupted-after', callId: 'interrupted-write' })
    // No explicit turn/end and no final tool/result: the exact durable receipt is
    // sufficient evidence, and the next start must not discard its original turn.
    h.publish('turn/start', { turn: 3 })
    h.session.append('user/message', { id: 'next-turn-user', role: 'user', source: { kind: 'ui' }, content: [{ type: 'text', text: 'next turn' }] } as never, { surfaceOp: 'append' })
    h.publish('turn/end', { turn: 3, reason: { kind: 'completed' } })
    const restarted = await h.restart()
    const preview = await restarted.preview(h.session, 2)
    expect(preview.skipped).toEqual([])
    expect(preview.restored).toEqual([expect.objectContaining({ path: target, content: 'previous-after' })])
    expect((await restarted.preview(h.session, 3)).restored).toEqual([])
    await restarted.execute(h.session, 2)
    expect(readFileSync(target, 'utf8')).toBe('previous-after')
  })

  it('refuses an interrupted direct call without a final result or exact receipt without writing or truncating', async () => {
    const h = rollbackFixture()
    const target = h.paths[0]!
    h.publish('turn/start', { turn: 2 })
    h.session.append('user/message', { id: 'missing-result-user', role: 'user', source: { kind: 'ui' }, content: [{ type: 'text', text: 'write file' }] } as never, { surfaceOp: 'append' })
    h.session.append('tool/call', { turn: 2, callId: 'missing-final-result', name: 'write', arguments: JSON.stringify({ file_path: target }) } as never)
    h.setFile(target, 'committed-without-receipt')
    h.publish('turn/start', { turn: 3 })
    h.session.append('user/message', { id: 'after-missing-result-user', role: 'user', source: { kind: 'ui' }, content: [{ type: 'text', text: 'continue' }] } as never, { surfaceOp: 'append' })
    h.publish('turn/end', { turn: 3, reason: { kind: 'completed' } })
    const restarted = await h.restart()
    expect((await restarted.preview(h.session, 2)).skipped.length).toBeGreaterThan(0)
    const surface = [...h.session.surface.nodes]
    const append = vi.spyOn(h.session, 'append')
    await expect(restarted.execute(h.session, 2)).rejects.toThrow('恢复依据不完整')
    expect(readFileSync(target, 'utf8')).toBe('committed-without-receipt')
    expect(h.session.surface.nodes).toEqual(surface)
    expect(append).not.toHaveBeenCalled()
  })

  it('does not let legacy shell net-zero receipts cover a missing direct-write receipt on the same path', async () => {
    const h = rollbackFixture()
    const target = h.paths[0]!
    h.publish('turn/start', { turn: 2 })
    h.session.append('user/message', { id: 'mixed-legacy-user', role: 'user', source: { kind: 'ui' }, content: [{ type: 'text', text: 'change file' }] } as never, { surfaceOp: 'append' })
    h.session.append('tool/call', { turn: 2, callId: 'shell-roundtrip', name: 'pwsh', arguments: '{}' } as never)
    appendCheckpoint({ sessionId: String(h.session.id), turn: 2, path: target, operation: 'update', before: 'previous-after', after: 'shell-middle' })
    appendCheckpoint({ sessionId: String(h.session.id), turn: 2, path: target, operation: 'update', before: 'shell-middle', after: 'previous-after' })
    h.session.append('tool/result', { turn: 2, message: { source: { callId: 'shell-roundtrip' } } } as never, { surfaceOp: 'append' })
    h.session.append('tool/call', { turn: 2, callId: 'uncovered-direct-write', name: 'write', arguments: JSON.stringify({ file_path: target }) } as never)
    h.setFile(target, 'uncovered-direct-after')
    h.session.append('tool/result', { turn: 2, message: { source: { callId: 'uncovered-direct-write' } } } as never, { surfaceOp: 'append' })
    h.publish('turn/end', { turn: 2, reason: { kind: 'completed' } })
    expect(loadCheckpoints(String(h.session.id)).get(2)?.get(target)).toMatchObject({ before: 'previous-after', after: 'previous-after' })
    const restarted = await h.restart()
    const preview = await restarted.preview(h.session, 2)
    expect(preview.restored).toEqual([])
    expect(preview.skipped.length).toBeGreaterThan(0)
    const surface = [...h.session.surface.nodes]
    const append = vi.spyOn(h.session, 'append')
    await expect(restarted.execute(h.session, 2)).rejects.toThrow('恢复依据不完整')
    expect(readFileSync(target, 'utf8')).toBe('uncovered-direct-after')
    expect(h.session.surface.nodes).toEqual(surface)
    expect(append).not.toHaveBeenCalled()
  })

  it('records a partially mutating direct throw at final result without a broad scan', async () => {
    const h = rollbackFixture()
    const target = h.paths[0]!
    h.setFile(target, 'user-edited-basis')
    h.publish('turn/start', { turn: 2 })
    const finish = vi.spyOn(BoundaryRescan.prototype, 'finishDispatch')
    let atResult: { isError: boolean; scans: number; checkpoint: unknown } | undefined
    h.ctx.tools.register({
      name: 'write', description: 'Partially failing direct-write fixture',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'null' }, render: () => [] },
      execute: async () => { h.setFile(target, 'partial-model-change'); throw new Error('partial-write-failed') },
    })
    h.ctx.on('tools/result', (_exec, result) => {
      atResult = {
        isError: result.isError,
        scans: finish.mock.calls.length,
        checkpoint: loadCheckpoints(String(h.session.id)).get(2)?.get(target),
      }
      return undefined
    })

    await expect(h.ctx.tools.execute(input('write', { file_path: target }, h.agent)))
      .resolves.toMatchObject({ isError: true, error: { message: 'partial-write-failed' } })
    expect(atResult).toMatchObject({
      isError: true, scans: 0,
      checkpoint: { before: 'user-edited-basis', after: 'partial-model-change' },
    })
    expect(finish).not.toHaveBeenCalled()
    h.publish('turn/end', { turn: 2, reason: { kind: 'completed' } })
    expect((await h.rollback.preview(h.session, 2)).restored[0]).toMatchObject({ path: target, content: 'user-edited-basis' })
  })

  it('does not record a no-op direct target when post-execute fails', async () => {
    const h = rollbackFixture()
    const target = h.paths[0]!
    h.setFile(target, 'external-before')
    h.publish('turn/start', { turn: 2 })
    h.ctx.tools.register({ name: 'edit', description: 'No-op fixture',
      parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
      output: { schema: { type: 'null' }, render: () => [] }, execute: async () => null })
    h.ctx.on('tools/post-execute', async () => { throw new Error('post-no-op-error') })
    await expect(h.ctx.tools.execute(input('edit', { file_path: target }, h.agent))).resolves.toMatchObject({ isError: true })
    expect(loadCheckpoints(String(h.session.id)).has(2)).toBe(false)
    h.publish('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await expect(h.rollback.preview(h.session, 2)).rejects.toThrow('范围')
    expect((await h.rollback.preview(h.session, 1)).restored[0]?.conflict).toBe(true)
  })

  it.each(['post-throw', 'post-block', 'late-cancel'] as const)('records committed direct I/O despite %s without owning unrelated edits', async mode => {
    const h = rollbackFixture()
    const [target, unrelated] = h.paths as [string, string]
    h.setFile(target, 'live-basis')
    h.publish('turn/start', { turn: 2 })
    const finish = vi.spyOn(BoundaryRescan.prototype, 'finishDispatch')
    const controller = new AbortController()
    h.ctx.tools.register({
      name: 'write', description: 'Committed direct-write fixture',
      parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
      output: { schema: { type: 'null' }, render: () => [] },
      execute: async () => { h.setFile(target, 'committed'); h.setFile(unrelated, 'external'); return null },
    })
    h.ctx.on('tools/post-execute', async (_exec, _result, next) => {
      if (mode === 'post-throw') throw new Error('post-policy-failed')
      if (mode === 'post-block') return { kind: 'block', feedback: [{ type: 'text', text: 'post-policy-blocked' }] }
      controller.abort()
      return next()
    })
    const result = await h.ctx.tools.execute({ ...input('write', { file_path: target }, h.agent), signal: controller.signal })
    expect(result.isError).toBe(true)
    expect(loadCheckpoints(String(h.session.id)).get(2)?.get(target)).toMatchObject({ operation: 'update', before: 'live-basis', after: 'committed' })
    expect(loadCheckpoints(String(h.session.id)).get(2)?.has(unrelated)).toBe(false)
    expect(finish).not.toHaveBeenCalled()
    h.publish('turn/end', { turn: 2, reason: { kind: 'completed' } })
    expect((await h.rollback.preview(h.session, 2)).restored).toEqual([expect.objectContaining({ path: target, content: 'live-basis' })])
  })
})
