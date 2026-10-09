import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BoundaryRescan } from '../src/boundary-rescan.ts'
import { planRollback } from '../src/core/restore-plan.ts'
import { SessionFold } from '../src/core/session-fold.ts'
import { appendCheckpoint, loadCheckpoints, loadWatched } from '../src/store.ts'

/**
 * End to end across the modules rollback uses: watched files are captured before a
 * mutating dispatch and checked after it. Only changes inside that dispatch belong
 * to its turn; external changes between turns remain conflicts on older records.
 */
describe('dispatch re-scan to rollback', () => {
  let home: string
  let workspace: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'rbk-pipeline-home-'))
    workspace = await mkdtemp(join(tmpdir(), 'rbk-pipeline-ws-'))
    process.env.DSH_HOME = home
  })

  afterEach(async () => {
    delete process.env.DSH_HOME
    await rm(home, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  })

  /** The same wiring the service uses, minus the Cordis plumbing. */
  function wire(sessionId: string) {
    const fold = new SessionFold(10)
    const warnings: string[] = []
    const recorded: { turn: number; path: string }[] = []
    const scanner = new BoundaryRescan({
      hostPathOf: async (_sessionId, path) => path,
      watchedPaths: id => {
        const paths = new Set<string>()
        for (const byPath of loadCheckpoints(id).values()) for (const path of byPath.keys()) paths.add(path)
        return [...paths]
      },
      knownContent: id => loadWatched(id),
      record: (id, turn, mutation) => {
        // Assert outside this callback so scanner failure handling cannot hide an
        // assertion; warnings and the recorded results are checked by each test.
        recorded.push({ turn, path: mutation.path })
        fold.mutationInto(turn, mutation)
        appendCheckpoint({
          sessionId: id,
          turn,
          path: mutation.path,
          operation: mutation.operation,
          before: mutation.before,
          after: mutation.after,
        })
      },
      warn: message => { warnings.push(message) },
    })
    return { fold, scanner, warnings, recorded, sessionId }
  }

  it('restores a shell deletion to its dispatch turn even if that turn closes before finish', async () => {
    const sessionId = 'pipeline-delete'
    const file = join(workspace, 'report.txt')
    const { fold, scanner, recorded, warnings } = wire(sessionId)

    // Turn 1: the file tool creates the file, making it watched.
    fold.fold({ kind: 'turn-start', turn: 1, seq: 0 })
    fold.fold({ kind: 'surface', seq: 1 })
    await writeFile(file, 'authored content', 'utf8')
    scanner.observe(sessionId, file, 'authored content')
    fold.fold({ kind: 'fs-mutation', mutation: { path: file, operation: 'create', before: null, after: 'authored content' } })
    appendCheckpoint({ sessionId, turn: 1, path: file, operation: 'create', before: null, after: 'authored content' })
    fold.fold({ kind: 'turn-end', turn: 1, seq: 1 })

    fold.fold({ kind: 'turn-start', turn: 2, seq: 2 })
    fold.fold({ kind: 'surface', seq: 3 })
    const snapshot = await scanner.captureDispatch(sessionId)
    await unlink(file) // Actual filesystem mutation during the shell dispatch.
    fold.fold({ kind: 'turn-end', turn: 2, seq: 3 })
    await scanner.finishDispatch(sessionId, 2, snapshot)

    expect(warnings).toEqual([])
    expect(recorded).toEqual([{ turn: 2, path: file }])
    expect(fold.snapshots().find(checkpoint => checkpoint.turn === 2)?.changes[file]).toMatchObject({ before: 'authored content', after: null })
    expect(loadCheckpoints(sessionId).get(2)?.get(file)).toEqual({ operation: 'remove', before: 'authored content', after: null })

    const plan = planRollback(fold.snapshots(), 2, fold.surfaceTail())
    expect(plan.restored).toEqual([
      { path: file, action: 'recover', content: 'authored content', kind: 'removed' },
    ])
    expect(plan.skipped).toEqual([])

    // The earliest baseline still wins when rolling back past the creation.
    // Absent before creation and absent after conversation deletion: net zero.
    expect(planRollback(fold.snapshots(), 1, fold.surfaceTail()).restored).toEqual([])
  })

  it('restores a shell overwrite to the live dispatch basis, not the older checkpoint after-state', async () => {
    const sessionId = 'pipeline-overwrite'
    const file = join(workspace, 'notes.txt')
    const { fold, scanner, recorded, warnings } = wire(sessionId)

    fold.fold({ kind: 'turn-start', turn: 1, seq: 0 })
    fold.fold({ kind: 'surface', seq: 1 })
    await writeFile(file, 'the good version', 'utf8')
    scanner.observe(sessionId, file, 'the good version')
    fold.fold({ kind: 'fs-mutation', mutation: { path: file, operation: 'update', before: 'older', after: 'the good version' } })
    appendCheckpoint({ sessionId, turn: 1, path: file, operation: 'update', before: 'older', after: 'the good version' })
    fold.fold({ kind: 'turn-end', turn: 1, seq: 1 })

    // The user edits between turns; the tool must restore to these bytes.
    await writeFile(file, 'user-edited version', 'utf8')
    fold.fold({ kind: 'turn-start', turn: 2, seq: 2 })
    fold.fold({ kind: 'surface', seq: 3 })
    const snapshot = await scanner.captureDispatch(sessionId)
    await writeFile(file, 'clobbered by a shell command', 'utf8')
    await scanner.finishDispatch(sessionId, 2, snapshot)
    fold.fold({ kind: 'turn-end', turn: 2, seq: 3 })

    expect(warnings).toEqual([])
    expect(recorded).toEqual([{ turn: 2, path: file }])
    expect(loadCheckpoints(sessionId).get(2)?.get(file)).toEqual({ operation: 'update', before: 'user-edited version', after: 'clobbered by a shell command' })
    expect(planRollback(fold.snapshots(), 2, fold.surfaceTail()).restored).toEqual([
      { path: file, action: 'restore', content: 'user-edited version', kind: 'updated' },
    ])
    expect(planRollback(fold.snapshots(), 1, fold.surfaceTail()).restored).toEqual([
      { path: file, action: 'restore', content: 'older', kind: 'updated' },
    ])
  })

  it.each(['edit', 'deletion'] as const)('does not assign an external between-turn %s to a newer no-op dispatch', async external => {
    const sessionId = `pipeline-external-${external}`
    const file = join(workspace, 'external.txt')
    const { fold, scanner, recorded, warnings } = wire(sessionId)

    fold.fold({ kind: 'turn-start', turn: 1, seq: 0 })
    fold.fold({ kind: 'surface', seq: 1 })
    await writeFile(file, 'model-written', 'utf8')
    scanner.observe(sessionId, file, 'model-written')
    fold.fold({ kind: 'fs-mutation', mutation: { path: file, operation: 'update', before: 'original', after: 'model-written' } })
    appendCheckpoint({ sessionId, turn: 1, path: file, operation: 'update', before: 'original', after: 'model-written' })
    fold.fold({ kind: 'turn-end', turn: 1, seq: 1 })

    if (external === 'edit') await writeFile(file, 'external content', 'utf8')
    else await unlink(file)

    fold.fold({ kind: 'turn-start', turn: 2, seq: 2 })
    fold.fold({ kind: 'surface', seq: 3 })
    const snapshot = await scanner.captureDispatch(sessionId)
    expect(snapshot.get(file)).toMatchObject(external === 'edit'
      ? { lastKnown: 'external content', missing: false }
      : { lastKnown: null, missing: true })
    // No-op shell dispatch: nothing changes between capture and finish.
    await scanner.finishDispatch(sessionId, 2, snapshot)
    fold.fold({ kind: 'turn-end', turn: 2, seq: 3 })

    expect(warnings).toEqual([])
    expect(recorded).toEqual([])
    expect(fold.snapshots().find(checkpoint => checkpoint.turn === 2)?.changes).toEqual({})
    expect(planRollback(fold.snapshots(), 2, fold.surfaceTail()).restored).toEqual([])
    expect(loadCheckpoints(sessionId).has(2)).toBe(false)
    expect(planRollback(fold.snapshots(), 1, fold.surfaceTail()).restored).toEqual([
      { path: file, action: 'restore', content: 'original', kind: 'updated' },
    ])

    // Conflict annotation belongs to the service, not the pure rollback planner.
    // Its older recorded post-state must remain intact and disagree with live disk,
    // even after a no-op dispatch and sidecar replay in a fresh scanner.
    const older = loadCheckpoints(sessionId).get(1)?.get(file)
    expect(older).toEqual({ operation: 'update', before: 'original', after: 'model-written' })
    if (external === 'edit') expect(await readFile(file, 'utf8')).not.toBe(older?.after)
    else await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(loadWatched(sessionId).get(file)).toMatchObject({ content: 'model-written', turn: 1 })
    const restarted = wire(sessionId)
    restarted.scanner.prime(sessionId)
    const replaySnapshot = await restarted.scanner.captureDispatch(sessionId)
    await restarted.scanner.finishDispatch(sessionId, 3, replaySnapshot)
    expect(restarted.recorded).toEqual([])
    expect(restarted.warnings).toEqual([])
    expect(loadCheckpoints(sessionId).get(1)?.get(file)).toEqual(older)
    expect(loadCheckpoints(sessionId).has(3)).toBe(false)
  })

  it('records tool recreation after external deletion as create from null, so rollback deletes it', async () => {
    const sessionId = 'pipeline-recreate'
    const file = join(workspace, 'recreated.txt')
    const { fold, scanner, recorded, warnings } = wire(sessionId)

    fold.fold({ kind: 'turn-start', turn: 1, seq: 0 })
    fold.fold({ kind: 'surface', seq: 1 })
    await writeFile(file, 'old authored content', 'utf8')
    scanner.observe(sessionId, file, 'old authored content')
    fold.fold({ kind: 'fs-mutation', mutation: { path: file, operation: 'update', before: 'original', after: 'old authored content' } })
    appendCheckpoint({ sessionId, turn: 1, path: file, operation: 'update', before: 'original', after: 'old authored content' })
    fold.fold({ kind: 'turn-end', turn: 1, seq: 1 })
    await unlink(file) // External deletion is not turn 2's work.

    fold.fold({ kind: 'turn-start', turn: 2, seq: 2 })
    fold.fold({ kind: 'surface', seq: 3 })
    const snapshot = await scanner.captureDispatch(sessionId)
    expect(snapshot.get(file)).toMatchObject({ lastKnown: null, missing: true })
    await writeFile(file, 'tool-recreated content', 'utf8')
    await scanner.finishDispatch(sessionId, 2, snapshot)
    fold.fold({ kind: 'turn-end', turn: 2, seq: 3 })

    expect(warnings).toEqual([])
    expect(recorded).toEqual([{ turn: 2, path: file }])
    expect(fold.snapshots().find(checkpoint => checkpoint.turn === 2)?.changes[file]).toMatchObject({ kind: 'created', before: null, after: 'tool-recreated content' })
    expect(loadCheckpoints(sessionId).get(2)?.get(file)).toEqual({ operation: 'create', before: null, after: 'tool-recreated content' })
    expect(planRollback(fold.snapshots(), 2, fold.surfaceTail()).restored).toEqual([
      { path: file, action: 'delete', content: null, kind: 'created' },
    ])
    expect(planRollback(fold.snapshots(), 1, fold.surfaceTail()).restored).toEqual([
      { path: file, action: 'restore', content: 'original', kind: 'updated' },
    ])
  })

  it('keeps watching the same paths after a restart, from the durable sidecar alone', async () => {
    const sessionId = 'pipeline-restart'
    const file = join(workspace, 'survivor.txt')

    // A previous process watched this file; all that survives is the sidecar.
    appendCheckpoint({ sessionId, turn: 3, path: file, operation: 'create', before: null, after: 'written before the restart' })
    await writeFile(file, 'written before the restart', 'utf8')

    const { fold, scanner, recorded, warnings } = wire(sessionId)
    scanner.prime(sessionId)
    fold.fold({ kind: 'turn-start', turn: 4, seq: 0 })
    fold.fold({ kind: 'surface', seq: 1 })
    const snapshot = await scanner.captureDispatch(sessionId)
    await unlink(file)
    await scanner.finishDispatch(sessionId, 4, snapshot)
    fold.fold({ kind: 'turn-end', turn: 4, seq: 1 })

    expect(warnings).toEqual([])
    expect(recorded).toEqual([{ turn: 4, path: file }])
    expect(planRollback(fold.snapshots(), 4, fold.surfaceTail()).restored).toEqual([
      { path: file, action: 'recover', content: 'written before the restart', kind: 'removed' },
    ])
  })

  it('catches a deletion at dispatch finish without another message or an end scan', async () => {
    const sessionId = 'pipeline-dispatch-end'
    const file = join(workspace, 'victim.txt')
    const { fold, scanner, recorded, warnings } = wire(sessionId)

    fold.fold({ kind: 'turn-start', turn: 1, seq: 0 })
    fold.fold({ kind: 'surface', seq: 1 })
    await writeFile(file, 'important', 'utf8')
    scanner.observe(sessionId, file, 'important')
    fold.fold({ kind: 'fs-mutation', mutation: { path: file, operation: 'create', before: null, after: 'important' } })
    appendCheckpoint({ sessionId, turn: 1, path: file, operation: 'create', before: null, after: 'important' })
    fold.fold({ kind: 'turn-end', turn: 1, seq: 1 })

    fold.fold({ kind: 'turn-start', turn: 2, seq: 2 })
    fold.fold({ kind: 'surface', seq: 3 })
    const snapshot = await scanner.captureDispatch(sessionId)
    await unlink(file)
    await scanner.finishDispatch(sessionId, 2, snapshot)
    // The dispatch has already persisted the mutation while turn 2 is still open.
    expect(recorded).toEqual([{ turn: 2, path: file }])
    expect(loadCheckpoints(sessionId).get(2)?.get(file)).toEqual({ operation: 'remove', before: 'important', after: null })
    fold.fold({ kind: 'turn-end', turn: 2, seq: 3 })

    expect(warnings).toEqual([])
    expect(planRollback(fold.snapshots(), 2, fold.surfaceTail()).restored).toEqual([
      { path: file, action: 'recover', content: 'important', kind: 'removed' },
    ])
    // Absent before creation and absent after conversation deletion: net zero.
    expect(planRollback(fold.snapshots(), 1, fold.surfaceTail()).restored).toEqual([])
  })

  it('never mistakes a pre-read capture for an emptied file', async () => {
    // Rendered tool output is a placeholder, not the file's actual after-state.
    const sessionId = 'pipeline-preread'
    const file = join(workspace, 'rendered.txt')
    const { fold, scanner, recorded, warnings } = wire(sessionId)

    fold.fold({ kind: 'turn-start', turn: 1, seq: 0 })
    fold.fold({ kind: 'surface', seq: 1 })
    await writeFile(file, 'still full of content', 'utf8')
    scanner.observe(sessionId, file, null)
    fold.fold({ kind: 'fs-mutation', mutation: { path: file, operation: 'update', before: 'older content', after: '' } })
    appendCheckpoint({ sessionId, turn: 1, path: file, operation: 'update', before: 'older content' })
    fold.fold({ kind: 'turn-end', turn: 1, seq: 1 })

    fold.fold({ kind: 'turn-start', turn: 2, seq: 2 })
    fold.fold({ kind: 'surface', seq: 3 })
    const noopSnapshot = await scanner.captureDispatch(sessionId)
    await scanner.finishDispatch(sessionId, 2, noopSnapshot)
    fold.fold({ kind: 'turn-end', turn: 2, seq: 3 })

    expect(recorded).toEqual([])
    expect(fold.snapshots().find(checkpoint => checkpoint.turn === 2)?.changes).toEqual({})

    // A later real dispatch captures the actual bytes before overwriting them.
    fold.fold({ kind: 'turn-start', turn: 3, seq: 4 })
    fold.fold({ kind: 'surface', seq: 5 })
    const mutationSnapshot = await scanner.captureDispatch(sessionId)
    await writeFile(file, 'clobbered', 'utf8')
    await scanner.finishDispatch(sessionId, 3, mutationSnapshot)
    fold.fold({ kind: 'turn-end', turn: 3, seq: 5 })

    expect(warnings).toEqual([])
    expect(recorded).toEqual([{ turn: 3, path: file }])
    expect(planRollback(fold.snapshots(), 3, fold.surfaceTail()).restored).toEqual([
      { path: file, action: 'restore', content: 'still full of content', kind: 'updated' },
    ])
  })
})
