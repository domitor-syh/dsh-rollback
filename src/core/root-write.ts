/**
 * Root-directory write fallback: the pure decision surface.
 *
 * On Windows the `write` tool cannot create a file directly under a DRIVE ROOT.
 * `fs-local`'s `writeFileAtomic` pre-creates the parent directory before writing;
 * `dirname('E:\\file.txt')` is `'E:\\'` — WITH the trailing separator — and
 * Windows answers a `mkdir` on a volume root with EPERM. The root itself is
 * perfectly writable (`mkdir('E:')` succeeds, and an `open`+`rename` there works),
 * so the failure is the preflight alone.
 *
 * The plugin answers that one failure by landing the bytes without the preflight
 * (see `src/root-write-fallback.ts`). This module holds the parts that must be
 * provably right and therefore carry unit tests: which failure qualifies, whether
 * the sandbox policy would have permitted the write at all, and the sibling temp
 * name used for the atomic replace.
 *
 * Pure and DSH-free.
 *
 * @module @domitor-syh/dsh-rollback/core/root-write
 */

/** The fields Node attaches to a failed filesystem call. */
export interface NodeErrorShape {
  readonly code?: unknown
  readonly syscall?: unknown
  readonly path?: unknown
  readonly message?: unknown
}

/** A Windows drive root WITH its trailing separator: `E:\` or `E:/`. */
const DRIVE_ROOT = /^[A-Za-z]:[\\/]$/

/** A `mkdir '<drive root>'` mention, for errors that arrive without the fields. */
const DRIVE_ROOT_MKDIR = /mkdir\s+['"]?[A-Za-z]:[\\/]['"]?/

/**
 * Whether an error is exactly the drive-root mkdir failure this fallback exists
 * for — and nothing else.
 *
 * The check is deliberately narrow: a broader match would let an unrelated EPERM
 * (a real permission denial, a locked file) take the fallback path, which is the
 * one outcome this design must never produce.
 * @param error - the value thrown by the wrapped `writeText`.
 * @returns true only for `EPERM` from a `mkdir` of a drive root.
 */
export function isRootMkdirEperm(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  const shape = error as NodeErrorShape
  if (shape.code !== 'EPERM') return false
  if (typeof shape.path === 'string') {
    if (!DRIVE_ROOT.test(shape.path)) return false
    return shape.syscall === undefined || shape.syscall === 'mkdir'
  }
  return typeof shape.message === 'string' && DRIVE_ROOT_MKDIR.test(shape.message)
}

/**
 * Whether the sandbox policy would have allowed this write.
 *
 * The fallback only ever runs after the provider already threw the drive-root
 * mkdir EPERM, and in the current implementation that means the sandbox's
 * containment check PASSED first: `SandboxedFileSystem.writeText` awaits
 * `checkedTarget(target, sandboxPolicy)` before delegating to the writer that
 * performs the mkdir. So on its own, observing the failure proves permission.
 *
 * This check keeps that conclusion true even if the order ever changes: it
 * re-derives permission from the policy the TOOL stamped on the call, and fails
 * CLOSED whenever a confined target cannot be proven to sit inside the workspace
 * root. It is not a reimplementation of the sandbox's path identity rules — a
 * drive-root target can only be inside a workspace whose root IS that volume, so
 * lexical containment answers exactly the question asked here.
 * @param mode - the effective sandbox mode, or undefined when nothing confines.
 * @param workspaceRoot - the writable root the policy carries, when it has one.
 * @param targetPath - the host path the write is aimed at.
 * @returns whether taking the fallback stays within what the policy allows.
 */
export function rootWriteAllowed(
  mode: string | undefined,
  workspaceRoot: string | undefined,
  targetPath: string,
): boolean {
  // No confining backend mounted: there is no fence to bypass.
  if (mode === undefined || mode === 'danger-full-access') return true
  if (mode === 'read-only') return false
  if (typeof workspaceRoot !== 'string' || workspaceRoot === '') return false
  return isWithin(targetPath, workspaceRoot)
}

/**
 * Lexical containment for the Windows paths this fallback can see, erring toward
 * refusal: separators are unified, the comparison is case-insensitive (Windows
 * drive letters and names are), and a trailing separator never changes the answer.
 * @param path - candidate host path.
 * @param root - the writable root to test against.
 * @returns whether `path` is `root` itself or sits beneath it.
 */
export function isWithin(path: string, root: string): boolean {
  const candidate = normalizeRootPath(path)
  const boundary = normalizeRootPath(root)
  if (candidate === boundary) return true
  return candidate.startsWith(`${boundary}/`)
}

/** Unify separators, drop a trailing separator, and case-fold for comparison. */
function normalizeRootPath(path: string): string {
  let out = path.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  if (out.length > 1 && out.endsWith('/')) out = out.replace(/\/+$/, '')
  return out.toLowerCase()
}

/**
 * A sibling temp path for the atomic replace: same directory (so `rename` stays
 * within one volume and therefore atomic), dot-prefixed, and impossible to
 * confuse with the destination.
 * @param targetPath - host path of the intended destination.
 * @param unique - caller-supplied uniquifier (pid + time + randomness).
 * @returns the host path to stage the bytes at before renaming.
 */
export function rootWriteTempPath(targetPath: string, unique: string): string {
  const separator = Math.max(targetPath.lastIndexOf('/'), targetPath.lastIndexOf('\\'))
  const directory = separator === -1 ? '' : targetPath.slice(0, separator + 1)
  const base = separator === -1 ? targetPath : targetPath.slice(separator + 1)
  return `${directory}.${base}.${unique}.rbk-tmp`
}