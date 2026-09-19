import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BoundaryRescan } from '../src/boundary-rescan.ts'
import { planRollback } from '../src/core/restore-plan.ts'
import { SessionFold } from '../src/core/session-fold.ts'
import { appendCheckpoint, loadCheckpoints, loadKnownContent } from '../src/store.ts'

/**
 * The whole point of the boundary re-scan, end to end across the modules an actual
 * rollback uses: a file the file tools created, a shell command that removes it out
 * of sight, the next user-message boundary noticing, and the rollback that boundary
 * anchors restoring the file.
 */
describe('boundary re-scan to rollback', () => {
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
      knownContent: id => loadKnownContent(id),
      record: (id, turn, mutation) => {
        // Collected rather than asserted here: the scanner swallows a failing path by
        // design, so an assertion in this callback would vanish into a warning.
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

  it('restores a file a shell command deleted, at the boundary the user spoke at', async () => {
    const sessionId = 'pipeline-delete'
    const file = join(workspace, 'report.txt')
    const { fold, scanner, recorded } = wire(sessionId)

    // Turn 1: the file tool creates the file, which is what makes it watched at all.
    fold.fold({ kind: 'turn-start', turn: 1, seq: 0 })
    fold.fold({ kind: 'surface', seq: 1 })
    await writeFile(file, 'authored content', 'utf8')
    scanner.observe(sessionId, file, 'authored content')
    fold.fold({ kind: 'fs-mutation', mutation: { path: file, operation: 'create', before: null, after: 'authored content' } })
    appendCheckpoint({ sessionId, turn: 1, path: file, operation: 'create', before: null, after: 'authored content' })
    fold.fold({ kind: 'turn-end', turn: 1, seq: 1 })

    // A shell command removes it; the plugin hears nothing.
    await unlink(file)

    // Turn 2 opens: the boundary re-check notices.
    fold.fold({ kind: 'turn-start', turn: 2, seq: 2 })
    fold.fold({ kind: 'surface', seq: 3 })
    await scanner.scan(sessionId, 2)
    fold.fold({ kind: 'turn-end', turn: 2, seq: 3 })

    expect(recorded).toEqual([{ turn: 2, path: file }])
    const turn2 = fold.snapshots().find(checkpoint => checkpoint.turn === 2)
    expect(turn2?.changes[file]).toMatchObject({ before: 'authored content', after: '' })

    // Rolling back to before turn 2 must bring the file back with its content.
    const plan = planRollback(fold.snapshots(), 2, fold.surfaceTail())
    expect(plan.restored).toEqual([
      { path: file, action: 'recover', content: 'authored content', kind: 'removed' },
    ])
    expect(plan.skipped).toEqual([])

    // Rolling back to before turn 1 still deletes what that turn created.
    const fromCreation = planRollback(fold.snapshots(), 1, fold.surfaceTail())
    expect(fromCreation.restored).toEqual([
      { path: file, action: 'delete', content: null, kind: 'created' },
    ])
  })

  it('restores the content a shell command overwrote', async () => {
    const sessionId = 'pipeline-overwrite'
    const file = join(workspace, 'notes.txt')
    const { fold, scanner } = wire(sessionId)

    fold.fold({ kind: 'turn-start', turn: 1, seq: 0 })
    fold.fold({ kind: 'surface', seq: 1 })
    await writeFile(file, 'the good version', 'utf8')
    scanner.observe(sessionId, file, 'the good version')
    appendCheckpoint({ sessionId, turn: 1, path: file, operation: 'update', before: 'older', after: 'the good version' })
    fold.fold({ kind: 'turn-end', turn: 1, seq: 1 })

    await writeFile(file, 'clobbered by a shell command', 'utf8')

    fold.fold({ kind: 'turn-start', turn: 2, seq: 2 })
    fold.fold({ kind: 'surface', seq: 3 })
    await scanner.scan(sessionId, 2)
    fold.fold({ kind: 'turn-end', turn: 2, seq: 3 })

    const plan = planRollback(fold.snapshots(), 2, fold.surfaceTail())
    expect(plan.restored).toEqual([
      { path: file, action: 'restore', content: 'the good version', kind: 'updated' },
    ])
  })

  it('keeps watching the same paths after a restart, from the durable sidecar alone', async () => {
    const sessionId = 'pipeline-restart'
    const file = join(workspace, 'survivor.txt')

    // A previous process watched this file; all that survives is the sidecar.
    appendCheckpoint({ sessionId, turn: 3, path: file, operation: 'create', before: null, after: 'written before the restart' })
    await writeFile(file, 'written before the restart', 'utf8')

    // The new process primes from the sidecar and re-checks at the next boundary.
    const { fold, scanner, recorded } = wire(sessionId)
    scanner.prime(sessionId)
    await unlink(file)
    fold.fold({ kind: 'turn-start', turn: 4, seq: 0 })
    fold.fold({ kind: 'surface', seq: 1 })
    await scanner.scan(sessionId, 4)
    fold.fold({ kind: 'turn-end', turn: 4, seq: 1 })

    // A rollback happens between turns, so the boundary's turn is closed by then —
    // which is also when its checkpoint leaves the open slot for the plan to see.
    expect(recorded).toEqual([{ turn: 4, path: file }])
    const plan = planRollback(fold.snapshots(), 4, fold.surfaceTail())
    expect(plan.restored).toEqual([
      { path: file, action: 'recover', content: 'written before the restart', kind: 'removed' },
    ])
  })

  it('catches a deletion when the turn that made it ends, with no further message', async () => {
    // The scenario a user actually performs: ask the model to delete the file, then
    // roll back — without sending anything else. The turn's own end is the boundary.
    const sessionId = 'pipeline-turn-end'
    const file = join(workspace, 'victim.txt')
    const { fold, scanner, recorded } = wire(sessionId)

    // Turn 1 creates the file through the tools.
    fold.fold({ kind: 'turn-start', turn: 1, seq: 0 })
    fold.fold({ kind: 'surface', seq: 1 })
    await writeFile(file, 'important', 'utf8')
    scanner.observe(sessionId, file, 'important')
    fold.fold({ kind: 'fs-mutation', mutation: { path: file, operation: 'create', before: null, after: 'important' } })
    appendCheckpoint({ sessionId, turn: 1, path: file, operation: 'create', before: null, after: 'important' })
    fold.fold({ kind: 'turn-end', turn: 1, seq: 1 })

    // Turn 2 deletes it with a shell command, and ends. The end triggers the scan,
    // anchored at turn 2 — the turn the deletion belongs to.
    fold.fold({ kind: 'turn-start', turn: 2, seq: 2 })
    fold.fold({ kind: 'surface', seq: 3 })
    await unlink(file)
    await scanner.scan(sessionId, 2)
    fold.fold({ kind: 'turn-end', turn: 2, seq: 3 })

    expect(recorded).toEqual([{ turn: 2, path: file }])

    // Rolling back to before turn 2 restores it: the deletion is turn 2's doing.
    const plan = planRollback(fold.snapshots(), 2, fold.surfaceTail())
    expect(plan.restored).toEqual([
      { path: file, action: 'recover', content: 'important', kind: 'removed' },
    ])

    // And rolling back past the creation still deletes what turn 1 created.
    const backToCreation = planRollback(fold.snapshots(), 1, fold.surfaceTail())
    expect(backToCreation.restored).toEqual([
      { path: file, action: 'delete', content: null, kind: 'created' },
    ])
  })

  it('never mistakes a pre-read capture for an emptied file', async () => {
    // `str_replace_editor` returns rendered text, so its capture reads the file
    // beforehand and its after-state is a placeholder. Adopting that placeholder as
    // real content would make the next boundary see a "rewrite" whose restore
    // content is an empty string — and the rollback would blank the file.
    const sessionId = 'pipeline-preread'
    const file = join(workspace, 'rendered.txt')
    const { fold, scanner, recorded } = wire(sessionId)

    fold.fold({ kind: 'turn-start', turn: 1, seq: 0 })
    fold.fold({ kind: 'surface', seq: 1 })
    await writeFile(file, 'still full of content', 'utf8')
    scanner.observe(sessionId, file, null)
    fold.fold({ kind: 'fs-mutation', mutation: { path: file, operation: 'update', before: 'older content', after: '' } })
    appendCheckpoint({ sessionId, turn: 1, path: file, operation: 'update', before: 'older content' })
    fold.fold({ kind: 'turn-end', turn: 1, seq: 1 })

    // The next turn ends: the file is untouched, so nothing may be recorded.
    fold.fold({ kind: 'turn-start', turn: 2, seq: 2 })
    fold.fold({ kind: 'surface', seq: 3 })
    await scanner.scan(sessionId, 2)
    fold.fold({ kind: 'turn-end', turn: 2, seq: 3 })

    expect(recorded).toEqual([])
    expect(fold.snapshots().find(checkpoint => checkpoint.turn === 2)?.changes[file]).toBeUndefined()

    // The content IS learned, so a later real change is caught against it.
    await writeFile(file, 'clobbered', 'utf8')
    fold.fold({ kind: 'turn-start', turn: 3, seq: 4 })
    fold.fold({ kind: 'surface', seq: 5 })
    await scanner.scan(sessionId, 3)
    fold.fold({ kind: 'turn-end', turn: 3, seq: 5 })
    expect(recorded).toEqual([{ turn: 3, path: file }])
    expect(planRollback(fold.snapshots(), 3, fold.surfaceTail()).restored).toEqual([
      { path: file, action: 'restore', content: 'still full of content', kind: 'updated' },
    ])
  })
})