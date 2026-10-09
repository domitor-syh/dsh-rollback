import { lstat, realpath, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, normalize } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from './dsh-types.ts'

export type LocalDeleteContext = Pick<Context, 'fs' | 'sandboxPolicy'>

function checkAbort(signal?: AbortSignal): void {
  signal?.throwIfAborted()
}

function samePath(left: string, right: string): boolean {
  return isAbsolute(left) && isAbsolute(right) && normalize(left) === normalize(right)
}

function fail(message: string): never {
  throw new Error(`Local deletion refused: ${message}`)
}

function isAbsent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}

async function nativeInfo(path: string) {
  try {
    return await lstat(path)
  } catch (error) {
    if (isAbsent(error)) return undefined
    throw error
  }
}

function checkPolicy(ctx: LocalDeleteContext, session: Session): string {
  const policy = ctx.sandboxPolicy.resolve({ session })
  if (policy.mode !== 'danger-full-access' && policy.mode !== 'workspace-write') fail('writable sandbox policy is required')
  return policy.workspaceRoot
}

async function checkBoundary(ctx: LocalDeleteContext, session: Session, hostPath: string, signal?: AbortSignal): Promise<void> {
  const policy = ctx.sandboxPolicy.resolve({ session })
  checkPolicy(ctx, session)
  if (policy.mode === 'workspace-write') {
    const root = await ctx.fs.resolve(policy.workspaceRoot, { signal })
    const target = await ctx.fs.resolve(hostPath, { signal })
    checkAbort(signal)
    if (!ctx.fs.contains(root, target)) fail('target is outside the workspace')
    const current = ctx.sandboxPolicy.resolve({ session })
    if (current.mode !== policy.mode || current.workspaceRoot !== policy.workspaceRoot) fail('sandbox policy changed')
  }
}

/**
 * Validate one regular local file for rollback deletion and return its exact
 * canonical absolute host path. This grants no lasting capability: deleteLocalFile
 * repeats authorization. Absent files are allowed for idempotent recovery.
 * Remote/shared providers must explicitly map this host path to the same process
 * path; opaque targetKey values are compared, never parsed as host paths.
 */
export async function authorizeLocalDelete(
  ctx: LocalDeleteContext,
  session: Session,
  path: string,
  signal?: AbortSignal,
): Promise<string> {
  checkAbort(signal)
  const cwd = checkPolicy(ctx, session)
  if (typeof path !== 'string' || !path.trim() || path.includes('\0')) fail('invalid path')
  const options = { cwd, signal }
  const pathInfo = await ctx.fs.lstat(path, { cwd }, signal)
  checkAbort(signal)
  if (pathInfo && pathInfo.type !== 'file') fail('path is not a regular file (symlinks forbidden)')
  const target = await ctx.fs.resolve(path, options)
  checkAbort(signal)
  const hostPath = ctx.fs.processPath(target)
  if (!isAbsolute(hostPath) || hostPath.includes('\0')) fail('target is not an absolute host path')
  const mapped = ctx.fs.processPathFromHostPath(hostPath)
  if (mapped === undefined || !samePath(mapped, hostPath)) fail('filesystem has no identical host-local mapping')
  const info = await ctx.fs.stat(target, signal)
  checkAbort(signal)
  if (info && info.type !== 'file') fail('target is not a regular file')
  const again = await ctx.fs.resolve(path, options)
  checkAbort(signal)
  if (again.targetKey !== target.targetKey || !samePath(ctx.fs.processPath(again), hostPath)) {
    fail('target identity or canonical path changed')
  }
  const hostTarget = await ctx.fs.resolve(hostPath, options)
  checkAbort(signal)
  if (hostTarget.targetKey !== target.targetKey || !samePath(ctx.fs.processPath(hostTarget), hostPath)) {
    fail('host mapping identifies a different target')
  }
  await checkBoundary(ctx, session, hostPath, signal)
  return hostPath
}

/**
 * Unlink exactly one verified local regular file. Never removes directories,
 * parents, symlinks, or recursive trees; ENOENT is idempotent success.
 *
 * IMPORTANT: native unlink is not conditional deletion. These checks narrow but
 * cannot close the race between validation and unlink (including ancestor swaps
 * or externally replaced content). No expected-version/content guarantee is
 * offered. The rollback caller must have explicit authorization for that residual
 * external-content risk and validate rollback intent before calling this helper.
 */
export async function deleteLocalFile(
  ctx: LocalDeleteContext,
  session: Session,
  path: string,
  signal?: AbortSignal,
): Promise<void> {
  const hostPath = await authorizeLocalDelete(ctx, session, path, signal)
  checkAbort(signal)
  const before = await nativeInfo(hostPath)
  checkAbort(signal)
  if (!before) return
  if (!before.isFile() || before.isSymbolicLink()) fail('native target is not a regular file')
  const canonical = await realpath(hostPath)
  const parent = await realpath(dirname(hostPath))
  checkAbort(signal)
  if (!samePath(canonical, hostPath) || !samePath(parent, dirname(hostPath))) {
    fail('native canonical path or parent differs from verified target')
  }
  const verifiedAgain = await authorizeLocalDelete(ctx, session, path, signal)
  if (!samePath(verifiedAgain, hostPath)) fail('authorized target changed before unlink')
  const finalParent = await realpath(dirname(hostPath))
  checkAbort(signal)
  if (!samePath(finalParent, parent)) fail('canonical parent changed before unlink')
  await checkBoundary(ctx, session, hostPath, signal)
  const finalInfo = await nativeInfo(hostPath)
  checkAbort(signal)
  if (!finalInfo) return
  if (!finalInfo.isFile() || finalInfo.isSymbolicLink()) fail('native target changed type before unlink')
  if (finalInfo.dev !== before.dev || finalInfo.ino !== before.ino) fail('native target identity changed before unlink')
  checkPolicy(ctx, session)
  checkAbort(signal)
  try {
    // hostPath is the exact absolute target validated above, not a derived path.
    await unlink(hostPath)
  } catch (error) {
    if (!isAbsent(error)) throw error
  }
}
