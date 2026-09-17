/**
 * Root-directory write fallback for the `write` tool.
 *
 * On Windows, `write` fails for any file directly under a drive root: the provider
 * pre-creates the parent directory, `dirname('E:\\file.txt')` is `'E:\\'` with its
 * trailing separator, and Windows answers a `mkdir` on a volume root with EPERM.
 * The model then abandons `write` and reaches for the shell — where this plugin
 * cannot see the change and therefore cannot roll it back.
 *
 * `ctx.fs.writeText` is wrapped so the ORIGINAL implementation always runs first
 * and, on exactly that failure, the bytes are staged and renamed in place WITHOUT
 * the mkdir preflight. Every other outcome is untouched, which is what keeps this
 * safe to ship:
 *
 * - normal writes take the original path and behave identically;
 * - any other error propagates unchanged (see `isRootMkdirEperm`);
 * - a target the policy would not have permitted is refused (see
 *   `rootWriteAllowed`);
 * - if the provider ever stops pre-creating the directory, the original succeeds
 *   and this code becomes unreachable — it retires itself.
 *
 * Only the byte landing changes: the write tool still builds its own result from
 * the outcome returned here, so the plugin's existing capture (which reads
 * `before`/`after` off the tool result) keeps working unchanged. The plugin's own
 * rollback restore calls the same wrapped method, so restoring a file at a drive
 * root is fixed by the same code.
 *
 * @module @domitor-syh/dsh-rollback/root-write-fallback
 */

import { open, readFile, rename, stat as nodeStat, unlink } from 'node:fs/promises'
import {
  applyLiteralEdit,
  detectLineEndings,
  normalizeLineEndings,
  restoreLineEndings,
  type LineEndings,
} from './core/literal-edit.ts'
import { isRootMkdirEperm, rootWriteAllowed, rootWriteTempPath } from './core/root-write.ts'

/**
 * The slice of the hosting context this module uses, declared structurally.
 *
 * Kept local so the module carries no `@deepseek-ai/*` type coupling: the repo's
 * own `tsc` run covers `tests/`, which imports this module, and the harness
 * packages are not installed here.
 */
export interface InstallContext {
  /** The filesystem service to wrap. */
  readonly fs: unknown
  /** Harness logger, when the context carries one. */
  readonly logger?: { info?: (message: string) => void }
  /** Optional service accessor (used for the sandbox policy). */
  readonly get?: (name: string) => unknown
}

/**
 * Prior content read for the outcome's diff basis is capped: a drive-root file is
 * unlikely to be enormous, and the provider itself refuses to read an unbounded
 * file for a diff (returning `before: null`, which this plugin reports honestly as
 * unrestorable rather than restoring a guess).
 */
const BEFORE_LIMIT_BYTES = 8 * 1024 * 1024

/** The fs service face this module uses, kept structural to avoid runtime coupling. */
interface FsLike {
  writeText(
    target: unknown,
    content: string,
    expected?: unknown,
    signal?: AbortSignal,
    sandboxPolicy?: unknown,
  ): Promise<unknown>
  editText(
    target: unknown,
    edit: unknown,
    expected?: unknown,
    signal?: AbortSignal,
    sandboxPolicy?: unknown,
  ): Promise<unknown>
  stat(target: unknown, signal?: AbortSignal): Promise<{ version?: unknown; type?: string } | undefined>
  readText(target: unknown, signal?: AbortSignal): Promise<string>
  processPath(target: unknown): string
  /** Idempotence marker: the plugin's wrapper is installed at most once. */
  __rollbackWriteWrapped?: true
}

/** The literal replacement an `edit` tool call requests. */
interface EditRequestLike {
  readonly oldString?: string
  readonly newString?: string
  readonly replaceAll?: boolean
}

/** The provider's `FsEditOutcome`, reproduced field for field. */
interface EditOutcomeLike {
  readonly version: unknown
  readonly before: string
  readonly after: string
}

/** The per-call sandbox policy the tool stamps onto the mutation. */
interface PolicyLike {
  readonly mode?: string
  readonly workspaceRoot?: string
}

/** The write intent the tool passes through. */
interface WriteExpectation {
  readonly kind?: string
  readonly version?: unknown
}

/** The provider's `FsWriteOutcome`, reproduced field for field. */
interface WriteOutcomeLike {
  readonly operation: 'create' | 'update'
  readonly version: unknown
  readonly before: string | null
  readonly after: string
}

/**
 * Install the fallback on this deployment's fs service.
 *
 * Both mutations are wrapped, because both reach the same preflight: `write`
 * creates a file directly under a drive root and `edit` changes one that is
 * already there, and either one sends the model to the shell instead.
 *
 * Safe to call more than once: the service carries the marker.
 * @param ctx - context carrying `fs` (and `sandboxPolicy` under a confined backend).
 */
export function installRootWriteFallback(ctx: InstallContext): void {
  const fs = ctx.fs as unknown as FsLike
  if (fs.__rollbackWriteWrapped === true) return

  // Each mutation is wrapped only when the mounted backend implements it: a
  // deployment may mount a filesystem that offers writes without edits, and the
  // fallback must not be the reason its plugin fails to load.
  if (typeof fs.writeText === 'function') {
    const originalWrite = fs.writeText.bind(fs)
    fs.writeText = async (target, content, expected, signal, sandboxPolicy) => {
      try {
        return await originalWrite(target, content, expected, signal, sandboxPolicy)
      } catch (error) {
        // The one failure this exists for — see the module note.
        if (!isRootMkdirEperm(error)) throw error
        if (!permitted(ctx, sandboxPolicy, fs, target)) throw error
        return await writeAtDriveRoot(ctx, fs, target, content, expected, signal, error)
      }
    }
  }

  if (typeof fs.editText === 'function') {
    const originalEdit = fs.editText.bind(fs)
    fs.editText = async (target, edit, expected, signal, sandboxPolicy) => {
      try {
        return await originalEdit(target, edit, expected, signal, sandboxPolicy)
      } catch (error) {
        if (!isRootMkdirEperm(error)) throw error
        if (!permitted(ctx, sandboxPolicy, fs, target)) throw error
        return await editAtDriveRoot(ctx, fs, target, edit, expected, signal, error)
      }
    }
  }

  fs.__rollbackWriteWrapped = true
}

/**
 * Whether the policy that governed this call allows the fallback to proceed.
 *
 * The per-call policy is the tool's own; without one (a caller that let the
 * provider resolve its default) the deployment default is resolved here, which is
 * exactly what the sandbox's own containment check does in that case. A deployment
 * with no confining backend at all has no sandbox policy service, and nothing to
 * bypass.
 * @param ctx - context for the optional `sandboxPolicy` service.
 * @param sandboxPolicy - the per-call policy, when the caller supplied one.
 * @param fs - the fs service (for the target's host path).
 * @param target - the resolved target being written.
 * @returns whether the write is within what the policy permits.
 */
function permitted(ctx: InstallContext, sandboxPolicy: unknown, fs: FsLike, target: unknown): boolean {
  const hostPath = fs.processPath(target)
  const perCall = sandboxPolicy as PolicyLike | undefined
  if (perCall?.mode !== undefined) return rootWriteAllowed(perCall.mode, perCall.workspaceRoot, hostPath)
  const service = ctx.get?.('sandboxPolicy') as { resolve?: () => PolicyLike } | undefined
  // No sandbox policy service at all: nothing confines this deployment.
  if (service === undefined) return true
  const resolved = service.resolve?.()
  // A confining deployment whose policy cannot be read is refused rather than
  // trusted: the fallback must never be the reason a fence was crossed.
  if (resolved?.mode === undefined) return false
  return rootWriteAllowed(resolved.mode, resolved.workspaceRoot, hostPath)
}

/**
 * Land the bytes without the parent-directory preflight.
 *
 * Staging in the destination's own directory keeps the replace on one volume and
 * therefore atomic, and the two guarded-mutation preconditions the provider
 * enforces are reproduced here so the fallback cannot write something the original
 * would have refused.
 * @param ctx - context for logging.
 * @param fs - the fs service.
 * @param target - the resolved target.
 * @param content - the text to write.
 * @param expected - the tool's write intent, when it stamped one.
 * @param signal - caller cancellation.
 * @param cause - the drive-root mkdir failure being compensated for.
 * @returns the outcome the caller would have received from the original path.
 */
async function writeAtDriveRoot(
  ctx: InstallContext,
  fs: FsLike,
  target: unknown,
  content: string,
  expected: unknown,
  signal: AbortSignal | undefined,
  cause: unknown,
): Promise<WriteOutcomeLike> {
  const hostPath = fs.processPath(target)
  const display = displayPathOf(target, hostPath)
  signal?.throwIfAborted()

  const existing = await fs.stat(target, signal)
  if (existing !== undefined && existing.type !== undefined && existing.type !== 'file') {
    throw failure('FS_NOT_REGULAR_FILE', `cannot write "${display}": not a regular file`, cause, 'write to a regular file instead')
  }
  const intent = expected as WriteExpectation | undefined
  if (intent?.kind === 'replaceIfVersion') {
    if (existing === undefined) {
      throw failure('FS_STALE_VERSION', `cannot write "${display}": file no longer exists`, cause, 're-read the file, then retry')
    }
    if (existing.version !== intent.version) {
      throw failure('FS_STALE_VERSION', `cannot write "${display}": file changed since it was read`, cause, 're-read the file, then retry')
    }
  } else if (intent?.kind === 'createIfAbsent' && existing !== undefined) {
    throw failure('FS_NOT_OBSERVED', `cannot overwrite existing "${display}" without reading it first`, cause, 'read the file, then retry')
  }

  const before = await readPriorText(fs, target, content, signal)
  await landBytes(hostPath, content, existing !== undefined, signal)

  const after = await fs.stat(target, signal)
  // Worth one line: while this never appears, the provider is still failing this
  // way and the fallback is still earning its place.
  ctx.logger?.info?.(`[rollback] wrote "${display}" past the drive-root mkdir failure`)
  return {
    operation: existing === undefined ? 'create' : 'update',
    version: after?.version ?? `missing:${hostPath}`,
    before,
    after: normalizeLineEndings(content),
  }
}

/**
 * Land an edit's bytes the way the provider would have.
 *
 * The literal match, the line endings and the failure codes are the provider's own
 * (see `src/core/literal-edit.ts`); only the publication differs, by staging beside
 * the destination instead of pre-creating its parent directory.
 * @param ctx - context for logging.
 * @param fs - the fs service.
 * @param target - the resolved target.
 * @param edit - the literal search/replace request.
 * @param expected - the version guard, when the tool stamped one.
 * @param signal - caller cancellation.
 * @param cause - the drive-root mkdir failure being compensated for.
 * @returns the outcome the caller would have received from the original path.
 */
async function editAtDriveRoot(
  ctx: InstallContext,
  fs: FsLike,
  target: unknown,
  edit: unknown,
  expected: unknown,
  signal: AbortSignal | undefined,
  cause: unknown,
): Promise<EditOutcomeLike> {
  const hostPath = fs.processPath(target)
  const display = displayPathOf(target, hostPath)
  signal?.throwIfAborted()

  const existing = await fs.stat(target, signal)
  // A missing target reports the stale code, exactly as the provider does.
  if (existing === undefined) {
    throw failure('FS_STALE_VERSION', `cannot edit "${display}": file changed since it was read`, cause, 're-read the file, then retry')
  }
  if (existing.type !== undefined && existing.type !== 'file') {
    throw failure('FS_NOT_REGULAR_FILE', `cannot edit "${display}": not a regular file`, cause)
  }
  const guard = expected as { version?: unknown } | undefined
  if (guard?.version !== undefined && existing.version !== guard.version) {
    throw failure('FS_STALE_VERSION', `cannot edit "${display}": file changed since it was read`, cause, 're-read the file, then retry')
  }

  const original = await readForEditAt(hostPath, display, signal)
  const request = (edit ?? {}) as EditRequestLike
  const applied = applyLiteralEdit(
    original.content,
    typeof request.oldString === 'string' ? request.oldString : '',
    typeof request.newString === 'string' ? request.newString : '',
    request.replaceAll === true,
    display,
  )
  if (!applied.ok) throw failure(applied.code, applied.message, cause)

  // The file keeps its line-ending style; the outcome reports the normalized text
  // the provider reports, so the diff basis stays comparable.
  await landBytes(hostPath, restoreLineEndings(applied.content, original.lineEndings), true, signal)

  const after = await fs.stat(target, signal)
  ctx.logger?.info?.(`[rollback] edited "${display}" past the drive-root mkdir failure`)
  return {
    version: after?.version ?? `missing:${hostPath}`,
    before: original.content,
    after: applied.content,
  }
}

/**
 * Stage `content` beside the destination and rename it into place — the same
 * atomic replace the provider performs, minus the parent-directory preflight.
 *
 * On Windows this cannot carry a destination's explicitly modified ACL the way the
 * provider's Win32 copy does; an inherited ACL (the ordinary case, since the staged
 * file is created in the same directory) is identical either way. The POSIX mode is
 * preserved explicitly.
 * @param hostPath - destination host path.
 * @param content - text to publish.
 * @param replacing - whether a file already exists there.
 * @param signal - caller cancellation.
 */
async function landBytes(
  hostPath: string,
  content: string,
  replacing: boolean,
  signal: AbortSignal | undefined,
): Promise<void> {
  const tempPath = rootWriteTempPath(hostPath, `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(tempPath, 'wx')
    await handle.writeFile(content, 'utf8')
    if (replacing) {
      const mode = await nodeStat(hostPath).then(info => info.mode & 0o7777).catch(() => undefined)
      if (mode !== undefined) await handle.chmod(mode)
    }
    await handle.sync()
    await handle.close()
    handle = undefined
    signal?.throwIfAborted()
    await rename(tempPath, hostPath)
  } catch (error) {
    try { await handle?.close() } catch { /* the handle is already unusable */ }
    try { await unlink(tempPath) } catch { /* the rename may have consumed it */ }
    throw error
  }
}

/**
 * Read a file for editing the way the provider does: reject binaries and invalid
 * UTF-8, and return normalized content plus the style to restore on write-back.
 * @param hostPath - file to read.
 * @param display - caller-facing path used in failures.
 * @param signal - caller cancellation.
 * @returns normalized content and the detected line-ending style.
 */
async function readForEditAt(
  hostPath: string,
  display: string,
  signal: AbortSignal | undefined,
): Promise<{ content: string; lineEndings: LineEndings }> {
  const buffer = await readFile(hostPath, signal === undefined ? {} : { signal })
  signal?.throwIfAborted()
  if (buffer.includes(0)) throw failure('FS_NOT_TEXT', `cannot edit "${display}": binary file`, undefined)
  let raw: string
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    throw failure('FS_NOT_TEXT', `cannot edit "${display}": invalid UTF-8 text`, undefined)
  }
  return { content: normalizeLineEndings(raw), lineEndings: detectLineEndings(raw) }
}

/**
 * The prior text for the outcome's diff basis, or null when it is not worth (or
 * not safe) to carry. Line endings are normalized exactly as the provider does, so
 * the fallback's outcome is indistinguishable from the original path's.
 * @param fs - the fs service.
 * @param target - the resolved target.
 * @param content - the text about to be written.
 * @param signal - caller cancellation.
 * @returns the normalized prior text, or null.
 */
async function readPriorText(
  fs: FsLike,
  target: unknown,
  content: string,
  signal: AbortSignal | undefined,
): Promise<string | null> {
  if (Buffer.byteLength(content, 'utf8') >= BEFORE_LIMIT_BYTES) return null
  try {
    const prior = await fs.readText(target, signal)
    return Buffer.byteLength(prior, 'utf8') >= BEFORE_LIMIT_BYTES ? null : normalizeLineEndings(prior)
  } catch {
    // A read failure is not an absence: the guards above already decided whether
    // the target exists, and the diff basis is best-effort.
    return null
  }
}

/** The display path the provider would name in a message. */
function displayPathOf(target: unknown, fallback: string): string {
  const display = (target as { displayPath?: unknown } | null)?.displayPath
  return typeof display === 'string' && display !== '' ? display : fallback
}

/**
 * A guarded-mutation failure in the provider's shape.
 *
 * The code is preserved because retry and permission layers route on it; the
 * recovery instruction is baked into the message because the tool layer only
 * appends one to its own `FsError` instances, which this plugin cannot construct
 * without taking a runtime dependency on the harness. Only the codes that layer
 * treats as remediable carry one, matching its behaviour exactly.
 * @param code - the provider's error code.
 * @param message - the provider's condition message.
 * @param cause - the drive-root mkdir failure being compensated for, when there is one.
 * @param remedy - the recovery instruction the tool layer would have appended.
 * @returns the error to throw.
 */
function failure(code: string, message: string, cause: unknown, remedy?: string): Error {
  const error = new Error(remedy === undefined ? message : `${message} — ${remedy}`, { cause })
  ;(error as { code?: string }).code = code
  return error
}