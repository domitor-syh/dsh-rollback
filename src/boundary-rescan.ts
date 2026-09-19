/**
 * Host side of the boundary re-scan: the watched-file registry and the filesystem
 * probe. See `src/core/boundary-scan.ts` for the decisions themselves.
 *
 * Watched files are the ones the file tools touched — the plugin's whole window onto
 * the workspace. A shell command can rewrite or delete any of them without the
 * plugin hearing about it, so every user-message boundary re-checks them and records
 * what changed, anchored at that boundary. The scan runs off the message path and
 * never throws: a failure here costs coverage, never the user's message.
 *
 * @module @domitor-syh/dsh-rollback/boundary-rescan
 */

import { readFile, stat } from 'node:fs/promises'
import { planBoundaryAction, unchangedByStat, type ObservedFile, type TrackedFile } from './core/boundary-scan.ts'
import type { FsMutation } from './core/model.ts'

/** What the scanner needs from the plugin. */
export interface BoundaryRescanDeps {
  /**
   * Resolve one watched path to its host path.
   * @param sessionId - the session the path belongs to.
   * @param path - the display path a tool reported.
   * @returns the host path, or undefined when it cannot be resolved.
   */
  hostPathOf(sessionId: string, path: string): Promise<string | undefined>
  /** Paths the durable sidecar already holds for one session. */
  watchedPaths(sessionId: string): readonly string[]
  /** The last content the durable sidecar knows for each of those paths. */
  knownContent(sessionId: string): Map<string, string>
  /**
   * Record one finding against the turn its boundary opened.
   * @param sessionId - the session.
   * @param turn - the turn the boundary anchors to.
   * @param mutation - the change to record.
   */
  record(sessionId: string, turn: number, mutation: FsMutation): void
  /**
   * Report something the user should know about coverage.
   * @param message - the warning text.
   */
  warn(message: string): void
}

/**
 * The largest file the scan will keep a restorable copy of. Beyond it the plugin
 * stops watching the path rather than pretending it could restore it.
 */
const MAX_WATCHED_BYTES = 8 * 1024 * 1024

/** Re-checks watched files at each user-message boundary. */
export class BoundaryRescan {
  /** Per session: display path to what the plugin last observed. */
  private readonly watched = new Map<string, Map<string, TrackedFile>>()
  /** Sessions with a scan already running; one at a time, newest wins. */
  private readonly running = new Set<string>()
  /** Warnings that should appear once per path, not once per boundary. */
  private readonly warned = new Set<string>()

  constructor(private readonly deps: BoundaryRescanDeps) {}

  /**
   * Note content a file tool just left behind, so the next boundary compares
   * against it instead of against the previous generation.
   * @param sessionId - the session.
   * @param path - the display path the tool reported.
   * @param content - the content the tool wrote.
   */
  observe(sessionId: string, path: string, content: string): void {
    const tracked = this.registryFor(sessionId)
    tracked.set(path, { lastKnown: content, size: null, mtimeMs: null, missing: false })
  }

  /**
   * Re-check every watched file of one session, anchored at `turn`.
   *
   * Fire-and-forget by design: the caller invokes it from the message path and
   * ignores the promise, and the scan swallows its own failures.
   * @param sessionId - the session to scan.
   * @param turn - the turn the boundary opened.
   */
  async scan(sessionId: string, turn: number): Promise<void> {
    if (this.running.has(sessionId)) return
    this.running.add(sessionId)
    try {
      const tracked = this.registryFor(sessionId)
      for (const [path, state] of [...tracked]) {
        try {
          await this.checkOne(sessionId, turn, path, state, tracked)
        } catch (error) {
          this.deps.warn(`[dsh-rollback] boundary re-check failed for ${path}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    } catch (error) {
      this.deps.warn(`[dsh-rollback] boundary re-scan failed for session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.running.delete(sessionId)
    }
  }

  /**
   * Load the paths the durable sidecar already holds, so a restarted process keeps
   * watching them. Called once per session; a later rollback deliberately does NOT
   * re-prime, because the sidecar still describes the state the rollback undid and
   * comparing against it would invent changes.
   * @param sessionId - the session.
   */
  prime(sessionId: string): void {
    const known = this.deps.knownContent(sessionId)
    const primed = new Map<string, TrackedFile>()
    for (const path of this.deps.watchedPaths(sessionId)) {
      // A path the sidecar records without content (records written before that
      // field existed) is still worth watching: the first check adopts its content.
      primed.set(path, { lastKnown: known.get(path) ?? null, size: null, mtimeMs: null, missing: false })
    }
    this.watched.set(sessionId, primed)
  }

  /**
   * Forget what the plugin knows about a session's watched files, keeping the paths
   * themselves watched.
   *
   * Used after a rollback, which rewrote the very files the registry describes: the
   * next scan adopts whatever is on disk now and records nothing, where comparing
   * against the pre-rollback picture would have invented a change for every file the
   * rollback touched. Dropping the paths instead would quietly end their coverage.
   * @param sessionId - the session.
   */
  forget(sessionId: string): void {
    const tracked = this.watched.get(sessionId)
    if (tracked === undefined) return
    for (const path of [...tracked.keys()]) {
      tracked.set(path, { lastKnown: null, size: null, mtimeMs: null, missing: false })
    }
  }

  /** This session's registry, empty until primed or observed. */
  private registryFor(sessionId: string): Map<string, TrackedFile> {
    const existing = this.watched.get(sessionId)
    if (existing !== undefined) return existing
    const created = new Map<string, TrackedFile>()
    this.watched.set(sessionId, created)
    return created
  }

  /** Probe one path and act on what the decision says. */
  private async checkOne(
    sessionId: string,
    turn: number,
    path: string,
    state: TrackedFile,
    registry: Map<string, TrackedFile>,
  ): Promise<void> {
    const hostPath = await this.deps.hostPathOf(sessionId, path)
    if (hostPath === undefined) return
    const fingerprint = await statFingerprint(hostPath)
    if (fingerprint !== null && unchangedByStat(state, fingerprint.size, fingerprint.mtimeMs)) return
    if (fingerprint !== null && fingerprint.size > MAX_WATCHED_BYTES) {
      // Too large to keep a restorable copy of: stop watching rather than claim
      // coverage the plugin cannot deliver.
      this.warnOnce(`oversize:${sessionId}:${path}`, `[dsh-rollback] no longer watching ${path}: ${fingerprint.size} bytes exceeds the ${MAX_WATCHED_BYTES}-byte limit`)
      registry.delete(path)
      return
    }

    const observed = fingerprint === null ? null : await readObserved(hostPath)
    const action = planBoundaryAction(state, observed)
    switch (action.kind) {
      case 'none': {
        // Identical content (a touched mtime) still refreshes the fingerprint so the
        // next boundary can take the stat-only fast path.
        if (fingerprint !== null) registry.set(path, { ...state, size: fingerprint.size, mtimeMs: fingerprint.mtimeMs, missing: false })
        return
      }
      case 'adopt': {
        registry.set(path, { lastKnown: action.observed.content, size: action.observed.size, mtimeMs: action.observed.mtimeMs, missing: false })
        return
      }
      case 'changed': {
        this.deps.record(sessionId, turn, { path, operation: 'update', before: action.before, after: action.after })
        registry.set(path, { lastKnown: action.after, size: action.observed.size, mtimeMs: action.observed.mtimeMs, missing: false })
        return
      }
      case 'missing': {
        this.deps.record(sessionId, turn, { path, operation: 'update', before: action.before, after: '' })
        registry.set(path, { ...state, lastKnown: action.before, size: null, mtimeMs: null, missing: true })
        return
      }
      case 'unrestorable': {
        this.warnOnce(`unread:${sessionId}:${path}`, `[dsh-rollback] ${path} disappeared before the plugin ever read it; a rollback cannot restore it`)
        registry.set(path, { ...state, size: null, mtimeMs: null, missing: true })
      }
    }
  }

  /** Report one condition once per key. */
  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return
    this.warned.add(key)
    this.deps.warn(message)
  }
}

/** Current size and mtime of a regular file, or null when it is absent or not one. */
async function statFingerprint(hostPath: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const info = await stat(hostPath)
    if (!info.isFile()) return null
    return { size: info.size, mtimeMs: info.mtimeMs }
  } catch {
    return null
  }
}

/** Read a file for the re-scan. A read failure leaves it unobserved, which the
 * decision treats as absent — and an absent file with no known content is reported
 * rather than recorded, so a transient read error cannot sabotage a rollback. */
async function readObserved(hostPath: string): Promise<ObservedFile | null> {
  try {
    const info = await stat(hostPath)
    const content = await readFile(hostPath, 'utf8')
    return { content, size: info.size, mtimeMs: info.mtimeMs }
  } catch {
    return null
  }
}