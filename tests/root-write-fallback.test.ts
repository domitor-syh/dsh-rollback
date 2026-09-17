import { mkdir, mkdtemp, readdir, readFile, rm, stat as nodeStat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installRootWriteFallback } from '../src/root-write-fallback.ts'

/** The context shape the installer accepts, derived from its own signature. */
type InstallContext = Parameters<typeof installRootWriteFallback>[0]

/**
 * The drive-root mkdir failure Node reports on Windows, which the provider's
 * preflight produces and the fallback exists to compensate for.
 */
function rootMkdirEperm(): NodeJS.ErrnoException {
  const error = new Error("EPERM: operation not permitted, mkdir 'E:\\'") as NodeJS.ErrnoException
  error.code = 'EPERM'
  error.syscall = 'mkdir'
  error.path = 'E:\\'
  return error
}

/** A resolved target as the provider hands it along. */
interface Target {
  readonly hostPath: string
  readonly displayPath: string
}

/** The fs service face, backed by real files, with the provider's failure simulated. */
function fakeFs(fail: () => unknown | undefined) {
  return {
    async writeText(target: Target, content: string) {
      const error = fail()
      if (error !== undefined) throw error
      await writeFile(target.hostPath, content, 'utf8')
      const info = await nodeStat(target.hostPath)
      return { operation: 'update', version: `v:${info.size}`, before: null, after: content }
    },
    async editText(target: Target) {
      // The provider's edit path fails the same way, on the same preflight.
      const error = fail()
      if (error !== undefined) throw error
      return { version: 'v:edited', before: '', after: '' }
    },
    async stat(target: Target) {
      try {
        const info = await nodeStat(target.hostPath)
        return { version: `v:${info.size}`, type: info.isFile() ? 'file' : 'other' }
      } catch {
        return undefined
      }
    },
    async readText(target: Target) {
      return await readFile(target.hostPath, 'utf8')
    },
    processPath(target: Target) {
      return target.hostPath
    },
  }
}

/** A context exposing the fake service, a silent logger, and an optional policy. */
function fakeContext(fs: unknown, policy?: unknown): InstallContext {
  return {
    fs,
    logger: { info: () => {} },
    get: (name: string) => (name === 'sandboxPolicy' ? policy : undefined),
  }
}

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'rbk-rootwrite-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

/** A target inside the temp directory, whose parent is never pre-created. */
function targetFor(name: string): Target {
  const hostPath = join(directory, name)
  return { hostPath, displayPath: hostPath }
}

/** Call the wrapped write the way the write tool does: the policy stamped last. */
function writeVia(
  fs: unknown,
  target: Target,
  content: string,
  expected?: unknown,
  policy?: unknown,
): Promise<{ operation?: string; version?: unknown; before?: string | null; after?: string }> {
  const write = (fs as { writeText: (...args: unknown[]) => Promise<never> }).writeText
  return write(target, content, expected, undefined, policy) as Promise<{
    operation?: string
    version?: unknown
    before?: string | null
    after?: string
  }>
}

describe('installRootWriteFallback', () => {
  it('installs once, and leaves the original path untouched when it succeeds', async () => {
    const fs = fakeFs(() => undefined)
    const ctx = fakeContext(fs)
    installRootWriteFallback(ctx)
    const installed = fs.writeText
    installRootWriteFallback(ctx)
    expect(fs.writeText).toBe(installed)

    const target = targetFor('plain.txt')
    const outcome = await writeVia(fs, target, 'hello')
    expect(outcome.after).toBe('hello')
    expect(await readFile(target.hostPath, 'utf8')).toBe('hello')
  })

  it('writes the file when the provider fails with the drive-root mkdir EPERM', async () => {
    const fs = fakeFs(() => rootMkdirEperm())
    installRootWriteFallback(fakeContext(fs))

    const target = targetFor('created.txt')
    const outcome = await writeVia(fs, target, 'from the fallback\n', undefined, { mode: 'danger-full-access' })

    expect(outcome.operation).toBe('create')
    expect(outcome.before).toBeNull()
    expect(outcome.after).toBe('from the fallback\n')
    expect(outcome.version).toBeDefined()
    expect(await readFile(target.hostPath, 'utf8')).toBe('from the fallback\n')
    // The staging file must not survive the atomic replace.
    expect((await readdir(directory)).filter(name => name.includes('rbk-tmp'))).toEqual([])
  })

  it('overwrites an existing file and reports the prior content as the diff basis', async () => {
    const target = targetFor('existing.txt')
    await writeFile(target.hostPath, 'old\r\nbody', 'utf8')

    const fs = fakeFs(() => rootMkdirEperm())
    installRootWriteFallback(fakeContext(fs))

    const outcome = await writeVia(fs, target, 'new\nbody', undefined, { mode: 'danger-full-access' })

    expect(outcome.operation).toBe('update')
    // LF-normalized exactly as the provider normalizes its diff basis.
    expect(outcome.before).toBe('old\nbody')
    expect(outcome.after).toBe('new\nbody')
    expect(await readFile(target.hostPath, 'utf8')).toBe('new\nbody')
  })

  it('rethrows any other failure untouched', async () => {
    const other = Object.assign(new Error('EPERM: operation not permitted, mkdir \'E:\\project\\sub\''), {
      code: 'EPERM',
      syscall: 'mkdir',
      path: 'E:\\project\\sub',
    })
    const fs = fakeFs(() => other)
    installRootWriteFallback(fakeContext(fs))

    const target = targetFor('untouched.txt')
    await expect(writeVia(fs, target, 'x', undefined, { mode: 'danger-full-access' })).rejects.toBe(other)
    expect(await readdir(directory)).toEqual([])
  })

  it('refuses a target the policy would not have permitted, and writes nothing', async () => {
    const fs = fakeFs(() => rootMkdirEperm())
    // workspace-write with a workspace that does NOT contain the target: the
    // sandbox would have denied this write, so the fallback must not perform it.
    installRootWriteFallback(fakeContext(fs))

    const target = targetFor('outside.txt')
    await expect(writeVia(fs, target, 'nope', undefined, {
      mode: 'workspace-write',
      workspaceRoot: join(directory, 'workspace'),
    })).rejects.toMatchObject({ code: 'EPERM' })
    expect(await readdir(directory)).toEqual([])
  })

  it('performs the write when the workspace root does contain the target', async () => {
    const fs = fakeFs(() => rootMkdirEperm())
    installRootWriteFallback(fakeContext(fs))

    const target = targetFor('inside.txt')
    await writeVia(fs, target, 'allowed', undefined, { mode: 'workspace-write', workspaceRoot: directory })
    expect(await readFile(target.hostPath, 'utf8')).toBe('allowed')
  })

  it('reads the deployment policy when the call carries none', async () => {
    const denying = fakeFs(() => rootMkdirEperm())
    installRootWriteFallback(fakeContext(denying, { resolve: () => ({ mode: 'read-only' }) }))
    await expect(writeVia(denying, targetFor('a.txt'), 'x')).rejects.toMatchObject({ code: 'EPERM' })

    const allowing = fakeFs(() => rootMkdirEperm())
    installRootWriteFallback(fakeContext(allowing, { resolve: () => ({ mode: 'danger-full-access' }) }))
    await writeVia(allowing, targetFor('b.txt'), 'x')
    expect(await readFile(join(directory, 'b.txt'), 'utf8')).toBe('x')
  })

  it('refuses when a confining policy service cannot be read', async () => {
    const fs = fakeFs(() => rootMkdirEperm())
    installRootWriteFallback(fakeContext(fs, { resolve: () => ({}) }))
    await expect(writeVia(fs, targetFor('c.txt'), 'x')).rejects.toMatchObject({ code: 'EPERM' })
    expect(await readdir(directory)).toEqual([])
  })

  it('honours the guarded-mutation preconditions the provider enforces', async () => {
    const fs = fakeFs(() => rootMkdirEperm())
    installRootWriteFallback(fakeContext(fs))
    const policy = { mode: 'danger-full-access' }

    const target = targetFor('guarded.txt')
    // replaceIfVersion against a missing file.
    await expect(writeVia(fs, target, 'x', { kind: 'replaceIfVersion', version: 'v:1' }, policy))
      .rejects.toMatchObject({ code: 'FS_STALE_VERSION' })

    await writeFile(target.hostPath, 'present', 'utf8')
    // createIfAbsent onto an existing file.
    await expect(writeVia(fs, target, 'x', { kind: 'createIfAbsent' }, policy))
      .rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
    // replaceIfVersion with a stale version.
    await expect(writeVia(fs, target, 'x', { kind: 'replaceIfVersion', version: 'v:999' }, policy))
      .rejects.toMatchObject({ code: 'FS_STALE_VERSION' })

    expect(await readFile(target.hostPath, 'utf8')).toBe('present')
    expect((await readdir(directory)).filter(name => name.includes('rbk-tmp'))).toEqual([])
  })
})

/** Call the wrapped edit the way the edit tool does: the policy stamped last. */
function editVia(
  fs: unknown,
  target: Target,
  edit: unknown,
  expected?: unknown,
  policy?: unknown,
): Promise<{ version?: unknown; before?: string; after?: string }> {
  const editText = (fs as { editText: (...args: unknown[]) => Promise<never> }).editText
  return editText(target, edit, expected, undefined, policy) as Promise<{
    version?: unknown
    before?: string
    after?: string
  }>
}

describe('the edit fallback', () => {
  const policy = { mode: 'danger-full-access' }

  it('edits a file at the drive root and keeps its line-ending style on disk', async () => {
    const target = targetFor('crlf.txt')
    await writeFile(target.hostPath, 'a\r\nb\r\nc\r\n', 'utf8')

    const fs = fakeFs(() => rootMkdirEperm())
    installRootWriteFallback(fakeContext(fs))

    const outcome = await editVia(fs, target, { oldString: 'b', newString: 'B', replaceAll: false }, undefined, policy)

    // The outcome reports the LF-normalized diff basis the provider reports...
    expect(outcome.before).toBe('a\nb\nc\n')
    expect(outcome.after).toBe('a\nB\nc\n')
    // ...while the file on disk keeps CRLF.
    expect(await readFile(target.hostPath, 'utf8')).toBe('a\r\nB\r\nc\r\n')
    expect((await readdir(directory)).filter(name => name.includes('rbk-tmp'))).toEqual([])
  })

  it('replaces every match when the request asks for it', async () => {
    const target = targetFor('all.txt')
    await writeFile(target.hostPath, 'x x x\n', 'utf8')
    const fs = fakeFs(() => rootMkdirEperm())
    installRootWriteFallback(fakeContext(fs))

    await editVia(fs, target, { oldString: 'x', newString: 'y', replaceAll: true }, undefined, policy)
    expect(await readFile(target.hostPath, 'utf8')).toBe('y y y\n')
  })

  it('reports the provider codes for its guarded preconditions', async () => {
    const fs = fakeFs(() => rootMkdirEperm())
    installRootWriteFallback(fakeContext(fs))

    // A missing target reports the stale code, exactly as the provider does.
    await expect(editVia(fs, targetFor('missing.txt'), { oldString: 'a', newString: 'b' }, undefined, policy))
      .rejects.toMatchObject({ code: 'FS_STALE_VERSION' })

    // A directory is not a regular file.
    const asDirectory = targetFor('adir')
    await mkdir(asDirectory.hostPath, { recursive: true })
    await expect(editVia(fs, asDirectory, { oldString: 'a', newString: 'b' }, undefined, policy))
      .rejects.toMatchObject({ code: 'FS_NOT_REGULAR_FILE' })

    // A stale version guard refuses before touching the file.
    const guarded = targetFor('guarded-edit.txt')
    await writeFile(guarded.hostPath, 'keep\n', 'utf8')
    await expect(editVia(fs, guarded, { oldString: 'keep', newString: 'gone' }, { version: 'v:999' }, policy))
      .rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
    expect(await readFile(guarded.hostPath, 'utf8')).toBe('keep\n')
  })

  it('refuses an ambiguous match without writing anything', async () => {
    const target = targetFor('ambiguous.txt')
    await writeFile(target.hostPath, 'dup\ndup\n', 'utf8')
    const fs = fakeFs(() => rootMkdirEperm())
    installRootWriteFallback(fakeContext(fs))

    await expect(editVia(fs, target, { oldString: 'dup', newString: 'one', replaceAll: false }, undefined, policy))
      .rejects.toMatchObject({ code: 'FS_AMBIGUOUS_EDIT' })
    expect(await readFile(target.hostPath, 'utf8')).toBe('dup\ndup\n')
    expect((await readdir(directory)).filter(name => name.includes('rbk-tmp'))).toEqual([])
  })

  it('refuses a binary file', async () => {
    const target = targetFor('binary.bin')
    await writeFile(target.hostPath, Buffer.from([0x61, 0x00, 0x62]))
    const fs = fakeFs(() => rootMkdirEperm())
    installRootWriteFallback(fakeContext(fs))

    await expect(editVia(fs, target, { oldString: 'a', newString: 'b' }, undefined, policy))
      .rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
  })

  it('refuses a target the policy would not have permitted', async () => {
    const target = targetFor('outside-edit.txt')
    await writeFile(target.hostPath, 'unchanged\n', 'utf8')
    const fs = fakeFs(() => rootMkdirEperm())
    installRootWriteFallback(fakeContext(fs))

    await expect(editVia(fs, target, { oldString: 'unchanged', newString: 'changed' }, undefined, {
      mode: 'workspace-write',
      workspaceRoot: join(directory, 'elsewhere'),
    })).rejects.toMatchObject({ code: 'EPERM' })
    expect(await readFile(target.hostPath, 'utf8')).toBe('unchanged\n')
  })
})