/**
 * Filesystem side of the empty-directory cleanup.
 *
 * See `src/core/dir-cleanup.ts` for WHY creation time decides this; this module is
 * only the probe and the removal. It uses `node:fs` directly, exactly as the
 * rollback's file deletion does, so it works for the same set of backends (the
 * local one) and needs no delete primitive from the filesystem service.
 *
 * @module @domitor-syh/dsh-rollback/empty-dirs
 */

import { readdir, rmdir, stat } from 'node:fs/promises'
import { planEmptyDirCleanup } from './core/dir-cleanup.ts'

/** What a cleanup attempt did. */
export interface DirCleanupReport {
  /** Directories removed, deepest first. */
  readonly removed: readonly string[]
  /** Directories that were planned but could not be removed, with the reason. */
  readonly failed: readonly { readonly path: string; readonly reason: string }[]
}

/**
 * Remove the directories a rollback emptied and the rolled-back span created.
 *
 * Never throws: a directory that cannot be removed is reported, because failing the
 * whole rollback over a leftover empty directory would be worse than leaving it.
 * @param deletedHostPaths - host paths of the files the rollback deleted.
 * @param spanStartMs - epoch ms at which the rolled-back turn opened.
 * @param neverRemove - a path the cleanup must never remove (see the planner).
 * @returns the directories removed and those that resisted.
 */
export async function cleanupEmptyDirs(
  deletedHostPaths: readonly string[],
  spanStartMs: number,
  neverRemove?: string,
): Promise<DirCleanupReport> {
  const planned = await planEmptyDirCleanup(deletedHostPaths, spanStartMs, {
    async entries(path) {
      try {
        return await readdir(path)
      } catch {
        // Unreadable is not empty: keep it.
        return null
      }
    },
    async birthtimeMs(path) {
      try {
        const info = await stat(path)
        // A filesystem that does not track creation time reports a zero birthtime
        // (or one mirroring mtime on some mounts); treat non-positive as unknown so
        // the directory is kept.
        return info.birthtimeMs > 0 ? info.birthtimeMs : undefined
      } catch {
        return undefined
      }
    },
  }, neverRemove)

  const removed: string[] = []
  const failed: { path: string; reason: string }[] = []
  for (const directory of planned) {
    try {
      await rmdir(directory)
      removed.push(directory)
    } catch (error) {
      failed.push({ path: directory, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return { removed, failed }
}