/**
 * Empty-directory cleanup planning for a rollback.
 *
 * A rollback already deletes the files it created, which leaves their directories
 * behind: the directory itself was made by something this plugin does not record
 * (a shell `New-Item`/`mkdir`, or the file tool's own parent pre-creation), so it
 * has no checkpoint of its own. What the plugin CAN see is that a directory is now
 * empty and that the rolled-back span is the only thing that could have created it.
 *
 * That last part is what the creation time answers, and it is why this is a
 * timestamp question rather than a bookkeeping one. Consider a directory created in
 * turn 3 and a file created inside it in turn 5: rolling back to before turn 5 must
 * delete the file and KEEP the directory, while rolling back to before turn 3 must
 * remove both. "The directory is now empty" cannot tell those apart; "the directory
 * is newer than the rollback point" can.
 *
 * Fail-closed by construction: a directory is removed only when it is empty AND its
 * creation time is known AND that time is at or after the rollback point. Anything
 * uncertain — no creation time on this filesystem, an unreadable directory, an
 * ancestor that still holds something — keeps the directory.
 *
 * Pure and DSH-free: the filesystem arrives as an injected probe.
 *
 * @module @domitor-syh/dsh-rollback/core/dir-cleanup
 */

/** One session event, structurally. */
export interface TimedEvent {
  readonly type: string
  readonly time?: number
  readonly data?: unknown
}

/** What the planner needs to know about the filesystem. */
export interface DirProbe {
  /**
   * The directory's entry names, or null when it does not exist or cannot be read.
   *
   * Names are needed rather than a bare "is it empty?" answer: the plan is computed
   * BEFORE anything is removed, so a directory holding only children this plan
   * already removes will be empty by the time the removal runs, and must be treated
   * as such.
   * @param path - absolute directory path.
   * @returns entry names, or null when unavailable.
   */
  entries(path: string): Promise<readonly string[] | null>
  /**
   * The directory's creation time in epoch ms, or undefined when this platform or
   * filesystem does not report one.
   * @param path - absolute directory path.
   * @returns the creation time, or undefined when unknown.
   */
  birthtimeMs(path: string): Promise<number | undefined>
}

/**
 * The epoch ms at which `turn` opened, or undefined when the log does not say.
 *
 * The LAST matching `turn/start` wins, matching how the turn boundary itself is
 * resolved (`turnStartSeqFor`): a session damaged by an older plugin build can hold
 * two starts under one number, and the real turn is the later one.
 * @param events - the session log, structurally.
 * @param turn - the 1-based turn number.
 * @returns the opening time in epoch ms, or undefined.
 */
export function turnStartTimeMs(events: readonly TimedEvent[], turn: number): number | undefined {
  let found: number | undefined
  for (const event of events) {
    if (event.type !== 'turn/start') continue
    const data = event.data as { turn?: unknown } | undefined
    if (data?.turn !== turn) continue
    if (typeof event.time === 'number' && Number.isFinite(event.time)) found = event.time
  }
  return found
}

/**
 * The parent directory of a path, or null at a filesystem root.
 *
 * A Windows drive root is returned WITH its separator (`E:\`), so the walk can
 * reach it and then stop: nothing above it belongs to the workspace.
 * @param path - absolute path, file or directory.
 * @returns the parent directory, or null when there is none.
 */
export function parentDirOf(path: string): string | null {
  const trimmed = path.replace(/[\\/]+$/, '')
  const separator = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  if (separator < 0) return null
  const parent = trimmed.slice(0, separator)
  // `''` is the root itself on POSIX; on Windows a path with no drive letter has
  // no parent to climb to.
  if (parent === '') return trimmed.startsWith('/') ? '/' : null
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}\\`
  return parent
}

/** How deeply nested a path is, for removal ordering. */
function depthOf(path: string): number {
  return path.split(/[\\/]/).length
}

/**
 * The comparison key for a path: Windows-style paths are case-insensitive, POSIX
 * paths are not.
 * @param path - absolute path.
 * @returns the key used to dedupe planned directories.
 */
function keyOf(path: string): string {
  return path.includes('\\') ? path.toLowerCase() : path
}

/** One entry's absolute path, using the separator style of its directory. */
function joinEntry(directory: string, name: string): string {
  const separator = directory.endsWith('\\') || directory.endsWith('/')
    ? directory.slice(-1)
    : directory.includes('\\') ? '\\' : '/'
  return `${directory}${separator}${name}`
}

/**
 * The directories a rollback may remove, deepest first.
 *
 * Starts from each deleted file's parent and climbs while a directory was created at
 * or after the rollback point and holds nothing that will still be there once this
 * plan runs. The first directory that fails either test ends that chain, because it
 * — and therefore everything above it — either predates the span or keeps content.
 * @param deletedPaths - host paths of the files this rollback deleted.
 * @param spanStartMs - epoch ms at which the rolled-back turn opened.
 * @param probe - the filesystem probe.
 * @param neverRemove - a path this pass must leave alone even if it looks removable
 *   (the session workspace root: it predates every turn, so removing it would mean
 *   the rule misfired, and the consequences would not be recoverable).
 * @returns absolute directory paths, deepest first, without duplicates.
 */
export async function planEmptyDirCleanup(
  deletedPaths: readonly string[],
  spanStartMs: number,
  probe: DirProbe,
  neverRemove?: string,
): Promise<string[]> {
  const protectedKey = neverRemove === undefined ? undefined : keyOf(neverRemove)
  const planned = new Map<string, string>()
  const everPlanned = new Set<string>()
  for (const file of deletedPaths) {
    let directory = parentDirOf(file)
    while (directory !== null) {
      const key = keyOf(directory)
      if (key === protectedKey) break
      if (everPlanned.has(key)) {
        // Already visited through another file: keep climbing, its ancestors may
        // be removable too.
        directory = parentDirOf(directory)
        continue
      }
      everPlanned.add(key)
      // Bind the narrowed value: a closure cannot rely on the loop variable staying
      // non-null.
      const current = directory
      const created = await probe.birthtimeMs(current)
      // Unknown creation time, or one before the span: not this rollback's to remove.
      if (created === undefined || created < spanStartMs) break
      const entries = await probe.entries(current)
      if (entries === null) break
      const survives = entries.some(name => !planned.has(keyOf(joinEntry(current, name))))
      if (survives) break
      planned.set(key, current)
      directory = parentDirOf(current)
    }
  }
  return [...planned.values()].sort((a, b) => depthOf(b) - depthOf(a) || (a < b ? -1 : a > b ? 1 : 0))
}