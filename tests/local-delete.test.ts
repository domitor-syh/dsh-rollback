import { lstat, stat, realpath, mkdtemp, writeFile, mkdir, symlink, unlink, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, relative, isAbsolute } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import { authorizeLocalDelete, deleteLocalFile, type LocalDeleteContext } from '../src/local-delete.ts'

let directory: string
const files: string[] = []
const directories: string[] = []
const session = { header: {} } as Session

beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'rollback-delete-')) })
afterEach(async () => {
  // Only exact test-created paths are removed; no recursive cleanup.
  for (const path of files.splice(0).reverse()) await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error })
  for (const path of directories.splice(0).reverse()) await rmdir(path)
  await rmdir(directory)
})

async function file(name = 'created.txt') {
  const path = join(directory, name)
  files.push(path)
  await writeFile(path, 'rollback-created content')
  return path
}

function context(mode = 'danger-full-access', workspaceRoot = directory) {
  const paths = new Map<string, string>()
  const metadata = async (path: string, follow: boolean) => {
    try {
      const value = await (follow ? stat(path) : lstat(path))
      return { type: value.isSymbolicLink() ? 'symlink' : value.isFile() ? 'file' : value.isDirectory() ? 'directory' : 'other', version: `v:${value.dev}:${value.ino}:${value.mtimeMs}` }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }
  const fs = {
    async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }) {
      opts?.signal?.throwIfAborted()
      let canonical = resolve(opts?.cwd ?? directory, path)
      try { canonical = await realpath(canonical) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        canonical = join(await realpath(dirname(canonical)), canonical.slice(dirname(canonical).length + 1))
      }
      const targetKey = `local:${canonical}`
      paths.set(targetKey, canonical)
      return { targetKey, displayPath: canonical }
    },
    processPath(target: { targetKey: string }) { return paths.get(target.targetKey)! },
    processPathFromHostPath(path: string): string | undefined { return path },
    async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal) {
      signal?.throwIfAborted()
      return metadata(resolve(opts?.cwd ?? directory, path), false)
    },
    async stat(target: { targetKey: string }, signal?: AbortSignal) {
      signal?.throwIfAborted()
      return metadata(paths.get(target.targetKey)!, true)
    },
    contains(parent: { targetKey: string }, child: { targetKey: string }) {
      const rel = relative(paths.get(parent.targetKey)!, paths.get(child.targetKey)!)
      return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
    },
  }
  return { fs, sandboxPolicy: { resolve: () => ({ mode, workspaceRoot }) } }
}
const asContext = (ctx: ReturnType<typeof context>) => ctx as unknown as LocalDeleteContext

describe('local deletion', () => {
  it('authorizes the canonical exact file and deletes only it', async () => {
    const path = await file()
    const neighbor = await file('neighbor.txt')
    const ctx = asContext(context())
    expect(await authorizeLocalDelete(ctx, session, path)).toBe(await realpath(path))
    await deleteLocalFile(ctx, session, path)
    await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await lstat(neighbor)).isFile()).toBe(true)
    expect((await lstat(directory)).isDirectory()).toBe(true)
  })
  it('is idempotent for an absent target', async () => {
    const path = await file()
    const ctx = asContext(context())
    await deleteLocalFile(ctx, session, path)
    await deleteLocalFile(ctx, session, path)
  })
  it.each(['read-only', 'unknown'])('rejects policy %s', async mode => {
    const path = await file()
    await expect(deleteLocalFile(asContext(context(mode)), session, path)).rejects.toThrow('writable sandbox')
    expect((await lstat(path)).isFile()).toBe(true)
  })
  it('allows workspace-write inside the official containment boundary', async () => {
    const path = await file()
    await deleteLocalFile(asContext(context('workspace-write')), session, path)
    await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('rejects workspace-write outside the boundary', async () => {
    const root = join(directory, 'workspace')
    await mkdir(root); directories.push(root)
    const path = await file()
    await expect(deleteLocalFile(asContext(context('workspace-write', root)), session, path)).rejects.toThrow('outside the workspace')
    expect((await lstat(path)).isFile()).toBe(true)
  })
  it.each(['unmapped', 'different'])('rejects %s host mapping', async kind => {
    const path = await file()
    const ctx = context()
    ctx.fs.processPathFromHostPath = value => kind === 'unmapped' ? undefined : join(directory, 'wrong.txt')
    await expect(deleteLocalFile(asContext(ctx), session, path)).rejects.toThrow('host-local mapping')
    expect((await lstat(path)).isFile()).toBe(true)
  })
  it('rejects directory targets', async () => {
    await expect(deleteLocalFile(asContext(context()), session, directory)).rejects.toThrow('regular file')
  })
  it('rejects final-component symlinks', async () => {
    const path = await file()
    const link = join(directory, 'link.txt')
    await symlink(path, link); files.push(link)
    await expect(deleteLocalFile(asContext(context()), session, link)).rejects.toThrow('symlinks forbidden')
    expect((await lstat(path)).isFile()).toBe(true)
  })
  it('rejects changed provider identity', async () => {
    const path = await file()
    const ctx = context()
    const original = ctx.fs.resolve.bind(ctx.fs)
    let calls = 0
    ctx.fs.resolve = async (...args) => {
      const value = await original(...args)
      return ++calls === 2 ? { ...value, targetKey: `${value.targetKey}:changed` } : value
    }
    await expect(deleteLocalFile(asContext(ctx), session, path)).rejects.toThrow('identity')
    expect((await lstat(path)).isFile()).toBe(true)
  })
  it('rejects native symlinks even when provider metadata claims a regular file', async () => {
    const path = await file()
    const link = join(directory, 'native-link.txt')
    await symlink(path, link); files.push(link)
    const ctx = context()
    ctx.fs.lstat = async () => ({ type: 'file', version: 'v:fake' })
    ctx.fs.stat = async () => ({ type: 'file', version: 'v:fake' })
    // A provider must not be able to make unlink follow an unchecked alias.
    ctx.fs.processPath = () => link
    ctx.fs.resolve = async () => ({ targetKey: `local:${link}`, displayPath: link })
    await expect(deleteLocalFile(asContext(ctx), session, link)).rejects.toThrow('native target')
    expect((await lstat(path)).isFile()).toBe(true)
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
  })
  it('rejects nonabsolute process paths', async () => {
    const path = await file()
    const ctx = context()
    ctx.fs.processPath = () => 'relative.txt'
    await expect(deleteLocalFile(asContext(ctx), session, path)).rejects.toThrow('absolute host path')
    expect((await lstat(path)).isFile()).toBe(true)
  })
  it('honors a pre-aborted signal without mutation', async () => {
    const path = await file()
    const controller = new AbortController(); controller.abort()
    await expect(deleteLocalFile(asContext(context()), session, path, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect((await lstat(path)).isFile()).toBe(true)
  })
  it('honors cancellation during provider validation', async () => {
    const path = await file()
    const controller = new AbortController()
    const ctx = context()
    const original = ctx.fs.stat.bind(ctx.fs)
    ctx.fs.stat = async (...args) => { const info = await original(...args); controller.abort(); return info }
    await expect(deleteLocalFile(asContext(ctx), session, path, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect((await lstat(path)).isFile()).toBe(true)
  })
})
