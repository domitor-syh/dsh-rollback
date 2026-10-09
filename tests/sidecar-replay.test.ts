import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { planRollback, type RollbackPlan } from '../src/core/restore-plan.ts'
import { SessionFold } from '../src/core/session-fold.ts'
import { appendCheckpoint, loadCheckpoints, loadWatched } from '../src/store.ts'

/**
 * The replay a restarted host performs, against the record shapes a REAL desktop
 * session wrote. Measured on 2026-10-01 (session-2b6d7ff7, DSH 0.2.0-rc.2):
 *
 *   turn=1  op=update  before=""          a.txt        (21 chars written)
 *   turn=2  op=update  before=<21 chars>  a.txt        (40 chars written)
 *   turn=3  op=remove  before=<40 chars>  a.txt        (a shell command deleted it)
 *   turn=3  op=create  before=null        rbk-test.txt
 *
 * Two things here are easy to get wrong and were never pinned by a test:
 *   1. a path may carry SEVERAL records in one turn (turn 3 removes one file and
 *      creates another), and the replay must fold BOTH — a rollback that only saw
 *      one of them would either resurrect a deleted file or delete a created one;
 *   2. `before: ""` is a KNOWN empty file, not unknown content: the distinction
 *      between "was empty" and "was never read" is the whole reason `null` exists.
 *      Collapsing it to null would silently skip the restore of an emptied file.
 *
 * The live path (tools/pre-execute + tools/result) is covered by the host probe;
 * this covers what a restart rebuilds from the sidecar.
 */
describe('restart replay of a real desktop session', () => {
  const sessionId = 'session-replay'
  let home: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'rbk-replay-home-'))
    process.env.DSH_HOME = home
  })

  afterEach(async () => {
    delete process.env.DSH_HOME
    await rm(home, { recursive: true, force: true })
  })

  /** Write the records above through the real store, in file order. */
  function writeRecords(): { removed: string; created: string } {
    const removed = 'C:/Users/tester/Desktop/a.txt'
    const created = 'C:/Users/tester/Desktop/rbk-test.txt'
    appendCheckpoint({ sessionId, turn: 1, path: removed, operation: 'update', before: '', after: 'line one\n' })
    appendCheckpoint({ sessionId, turn: 2, path: removed, operation: 'update', before: 'line one\n', after: 'line one\nline two\n' })
    appendCheckpoint({ sessionId, turn: 3, path: removed, operation: 'remove', before: 'line one\nline two\n', after: null })
    appendCheckpoint({ sessionId, turn: 3, path: created, operation: 'create', before: null, after: 'fresh content\n' })
    return { removed, created }
  }

  /**
   * Rebuild the retained checkpoints the way `RollbackService` replays a resumed
   * session: one fold mutation per (turn, path) from the durable map, folded in
   * turn order, then closed by `turn-end`.
   */
  function replay(): { turns: number[]; plan: RollbackPlan; removed: string; created: string } {
    const { removed, created } = writeRecords()
    const durable = loadCheckpoints(sessionId)
    const fold = new SessionFold(10)
    const turns = [...durable.keys()].sort((a, b) => a - b)
    for (const turn of turns) {
      fold.fold({ kind: 'turn-start', turn, seq: turn * 10 })
      for (const [path, stored] of durable.get(turn) ?? []) {
        fold.fold({
          kind: 'fs-mutation',
          mutation: { path, operation: stored.operation, before: stored.before, after: stored.after ?? null,
            ...(stored.after === undefined ? { afterKnown: false } : {}) },
        })
      }
      fold.fold({ kind: 'turn-end', turn, seq: turn * 10 + 1 })
    }
    return { turns, plan: planRollback(fold.snapshots(), 3, 31), removed, created }
  }

  it('folds every record of a turn that both removed and created a file', () => {
    const { turns } = replay()
    expect(turns).toEqual([1, 2, 3])
  })

  it('rolls back to before that turn by recovering the removed file and deleting the created one', () => {
    const { plan, removed, created } = replay()
    expect(plan.restored).toEqual([
      // First touch across the window wins, and a `remove` reports `recover` rather
      // than `restore` — the same bytes, but "brought back" is the true story.
      { path: removed, action: 'recover', content: 'line one\nline two\n', kind: 'removed' },
      { path: created, action: 'delete', content: null, kind: 'created' },
    ])
    expect(plan.skipped).toEqual([])
  })

  it('keeps a known-empty file restorable instead of treating it as unknown content', () => {
    // The FIRST record of the path is what the replay restores to; `before: ""`
    // must stay an empty string so this lands in `restored`, never in `skipped`.
    const { plan, removed } = replay()
    const entry = plan.restored.find(f => f.path === removed)
    expect(entry?.content).toBe('line one\nline two\n')
    expect(plan.skipped.some(s => s.path === removed)).toBe(false)
  })

  it('still knows the content the removed file had, so it can be written back', () => {
    writeRecords()
    const watched = loadWatched(sessionId)
    // The `remove` record itself must not become the watched content — it carries
    // the pre-deletion bytes, and adopting them as "what is on disk" is exactly the
    // placeholder mistake that made a rollback write an empty file over a real one.
    const entry = watched.get('C:/Users/tester/Desktop/a.txt')
    expect(entry?.content).toBe('line one\nline two\n')
  })

  it('drops records of turns a rollback already removed', () => {
    writeRecords()
    const durable = loadCheckpoints(sessionId, new Set([3]))
    expect([...durable.keys()].sort((a, b) => a - b)).toEqual([1, 2])
  })

  it('offers a shell deletion as 找回 on the turn whose boundary found it', async () => {
    // The desktop report of 2026-10-02, end to end. A file created by a SHELL command
    // (so only a boundary scan can see it), untouched by the next turn, deleted in the
    // one after that, and the user rolling back the deleting turn:
    //
    //   turn 1  create  a.txt      (recorded at turn 1's boundary scan)
    //   turn 2  (nothing touches it)
    //   turn 3  remove  a.txt      (recorded at turn 3's boundary, which found it gone)
    //
    // The old `findingTurn` rule filed that removal under turn 2 — "the turn after the
    // last confirmation" — so planning from turn 3 windowed on `turn >= 3`, dropped the
    // removal, and the dialog listed one file too few: the 找回 entry simply was not
    // there. Measured attribution in the live session after the fix: `turn=5 remove
    // a.txt` alongside `turn=5 update c.txt`, i.e. the boundary that found them.
    const shellCreated = 'C:/Users/tester/Desktop/shell-made.txt'
    appendCheckpoint({ sessionId, turn: 1, path: shellCreated, operation: 'create', before: null, after: '' })
    appendCheckpoint({ sessionId, turn: 3, path: shellCreated, operation: 'remove', before: '', after: null })

    const durable = loadCheckpoints(sessionId)
    const fold = new SessionFold(10)
    for (const turn of [...durable.keys()].sort((a, b) => a - b)) {
      fold.fold({ kind: 'turn-start', turn, seq: turn * 10 })
      for (const [path, stored] of durable.get(turn) ?? []) {
        fold.fold({
          kind: 'fs-mutation',
          mutation: { path, operation: stored.operation, before: stored.before, after: stored.after ?? null,
            ...(stored.after === undefined ? { afterKnown: false } : {}) },
        })
      }
      fold.fold({ kind: 'turn-end', turn, seq: turn * 10 + 1 })
    }

    // Rolling back the deleting turn must include it: the file is brought back.
    const rollingBackTheDeletingTurn = planRollback(fold.snapshots(), 3, 31)
    expect(rollingBackTheDeletingTurn.restored).toEqual([
      { path: shellCreated, action: 'recover', content: '', kind: 'removed' },
    ])

    // Rolling back the full create/delete span has identical absent endpoints.
    const rollingBackTheCreatingTurn = planRollback(fold.snapshots(), 1, 31)
    expect(rollingBackTheCreatingTurn.restored).toEqual([])
  })

  it('prunes records older than the retention window and compacts the file', async () => {
    const dir = join(home, 'storages', 'dsh-rollback', 'checkpoints-v2')
    await mkdir(dir, { recursive: true })
    const file = join(dir, `${sessionId}.jsonl`)
    const rows = [
      { sessionId, turn: 1, path: 'C:/old.txt', operation: 'update', before: null, after: 'x' },
      ...Array.from({ length: 25 }, (_, i) => ({
        sessionId,
        turn: i + 2,
        path: `C:/f${i}.txt`,
        operation: 'create',
        before: null,
        after: 'y',
      })),
    ]
    await writeFile(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8')
    const kept = loadCheckpoints(sessionId)
    // The newest 20 turns survive (`KEEP_TURNS`), so of turns 1..26 only 7..26 are
    // retained: cutoff = maxTurn - KEEP_TURNS + 1.
    const keys = [...kept.keys()].sort((a, b) => a - b)
    expect(keys[0]).toBe(7)
    expect(keys[keys.length - 1]).toBe(26)
    expect(keys).not.toContain(6)
  })
})