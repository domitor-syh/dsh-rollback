import { describe, expect, it } from 'vitest'
import {
  hasRealSurfaceBefore,
  hasRollbackMarker,
  planTruncationMarker,
  shadowedSurfaceFrom,
  surfaceNodesWithin,
  turnStartSeqFor,
  type SessionView,
} from '../src/core/truncation-plan.ts'

/**
 * Build a log/surface fixture. `seq` is the array index, exactly as in a real
 * session (the surface and the log are both addressed by event seq).
 */
function view(entries: readonly { type: string; data?: unknown }[], surfaceNodes: readonly number[]): SessionView {
  return {
    events: entries.map((entry, seq) => ({ type: entry.type, seq, data: entry.data })),
    surface: { nodes: surfaceNodes },
  }
}

/** A log with turns 1-3, each opened by turn/start and holding one user message. */
function threeTurns(): { entries: { type: string; data?: unknown }[]; nodes: number[] } {
  const entries: { type: string; data?: unknown }[] = []
  const nodes: number[] = []
  for (let turn = 1; turn <= 3; turn++) {
    entries.push({ type: 'turn/start', data: { turn } })
    entries.push({ type: 'step/start', data: { turn, step: 1 } })
    entries.push({ type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text: `t${turn}` }] } } })
    nodes.push(entries.length - 1)
    entries.push({ type: 'assistant/message', data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: `a${turn}` }], source: { provider: 'p', model: 'm' } } } })
    nodes.push(entries.length - 1)
    entries.push({ type: 'step/end', data: { turn, step: 1 } })
    entries.push({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
  }
  return { entries, nodes }
}

describe('turnStartSeqFor', () => {
  it('finds the boundary that opens a turn', () => {
    const { entries, nodes } = threeTurns()
    expect(turnStartSeqFor(view(entries, nodes), 2)).toBe(6)
  })

  it('returns null for a turn the log never opened', () => {
    const { entries, nodes } = threeTurns()
    expect(turnStartSeqFor(view(entries, nodes), 9)).toBeNull()
  })

  it('prefers the LAST boundary when a turn number is duplicated', () => {
    // A session damaged by an older plugin build: a synthetic marker turn 2
    // (seq 3) followed by the real turn 2 (seq 6) under the same number. A
    // rollback to turn 2 must target the REAL turn, i.e. the later boundary.
    const entries: { type: string; data?: unknown }[] = [
      { type: 'turn/start', data: { turn: 1 } },                                    // 0
      { type: 'user/message', data: { message: { role: 'user', content: [] } } },    // 1
      { type: 'turn/end', data: { turn: 1 } },                                      // 2
      { type: 'turn/start', data: { turn: 2 } },                                    // 3 synthetic marker turn
      { type: 'assistant/message', data: { turn: 2, step: 1, message: { role: 'assistant', content: [] } } }, // 4
      { type: 'turn/end', data: { turn: 2 } },                                      // 5
      { type: 'turn/start', data: { turn: 2 } },                                    // 6 the real turn 2
      { type: 'user/message', data: { message: { role: 'user', content: [] } } },    // 7
      { type: 'turn/end', data: { turn: 2 } },                                      // 8
    ]
    const fixture = view(entries, [1, 4, 7])
    expect(turnStartSeqFor(fixture, 2)).toBe(6)
    // ... and the shadowed range starts at that real boundary.
    expect(shadowedSurfaceFrom(fixture, 2)).toEqual([7])
  })
})

describe('shadowedSurfaceFrom', () => {
  it('returns every surface node from the targeted turn onward', () => {
    const { entries, nodes } = threeTurns()
    const fixture = view(entries, nodes)
    expect(shadowedSurfaceFrom(fixture, 2)).toEqual([nodes[2]!, nodes[3]!, nodes[4]!, nodes[5]!])
    expect(shadowedSurfaceFrom(fixture, 1)).toEqual(nodes)
  })

  it('is empty for an unknown turn or a turn with no surface output', () => {
    const { entries, nodes } = threeTurns()
    expect(shadowedSurfaceFrom(view(entries, nodes), 9)).toEqual([])
    expect(shadowedSurfaceFrom(view(entries, nodes), 3).length).toBeGreaterThan(0)
    const silent = view([...entries, { type: 'turn/start', data: { turn: 4 } }, { type: 'turn/end', data: { turn: 4 } }], nodes)
    expect(shadowedSurfaceFrom(silent, 4)).toEqual([])
  })
})

describe('hasRealSurfaceBefore', () => {
  it('is true when real content precedes the truncation point', () => {
    const { entries, nodes } = threeTurns()
    expect(hasRealSurfaceBefore(view(entries, nodes), nodes[2]!)).toBe(true)
  })

  it('ignores rollback markers and legacy empty markers, and reports nothing-real', () => {
    const legacy = { type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [], rollback: { fromTurn: 1 } } } }
    const current = { type: 'user/message', data: { id: 'm', role: 'user', content: [{ type: 'text', text: 'rolled back' }], source: { kind: 'plugin', plugin: 'rollback' }, rollback: { fromTurn: 1 } } }
    const legacyOnly = view([{ type: 'turn/start', data: { turn: 1 } }, legacy], [1])
    expect(hasRealSurfaceBefore(legacyOnly, 1)).toBe(false)
    const both = view([{ type: 'turn/start', data: { turn: 1 } }, legacy, current], [1, 2])
    expect(hasRealSurfaceBefore(both, 2)).toBe(false)
  })
})

describe('planTruncationMarker', () => {
  it('replaces exactly the captured range with one empty assistant message', () => {
    const { entries, nodes } = threeTurns()
    const fixture = view(entries, nodes)
    const plan = planTruncationMarker(fixture, {
      fromTurn: 2,
      shadowedFirst: nodes[2]!,
      shadowedLast: nodes[5]!,
      turn: 9,
      step: 10_000,
      messageId: 'rollback-truncation-x',
      restoredCount: 2,
      deletedCount: 1,
    })
    expect(plan).not.toBeNull()
    expect(plan!.surfaceOp).toEqual({ op: 'replace', start: nodes[2]!, end: nodes[5]! })
    expect(plan!.sourceEventSeqs).toEqual([nodes[2]!, nodes[3]!, nodes[4]!, nodes[5]!])
    // An EMPTY assistant message: deriveMessages projects it to null, so nothing
    // takes the rolled-back range's place in the model's history.
    expect(plan!.data).toMatchObject({
      turn: 9,
      step: 10_000,
      message: {
        id: 'rollback-truncation-x',
        role: 'assistant',
        source: { kind: 'plugin', plugin: 'rollback' },
        content: [],
        rollback: {
          fromTurn: 2,
          truncatedFromSeq: nodes[2]!,
          restoredCount: 2,
          deletedCount: 1,
          skippedCount: 0,
          emptied: false,
        },
      },
    })
  })

  it('never swallows nodes appended after the captured range', () => {
    // The user's next prompt lands between the rollback and the marker: it must
    // stay outside the replacement.
    const { entries, nodes } = threeTurns()
    const promptSeq = entries.length + 1
    const withPrompt = view([
      ...entries,
      { type: 'turn/start', data: { turn: 4 } },
      { type: 'user/message', data: { id: 'p4', role: 'user', content: [{ type: 'text', text: 'p4' }], source: { kind: 'user' } } },
    ], [...nodes, promptSeq])
    const plan = planTruncationMarker(withPrompt, {
      fromTurn: 2,
      shadowedFirst: nodes[2]!,
      shadowedLast: nodes[5]!,
      turn: 9,
      step: 10000,
      messageId: 'id',
      restoredCount: 0,
      deletedCount: 0,
    })
    expect(plan!.shadowed).toEqual([nodes[2]!, nodes[3]!, nodes[4]!, nodes[5]!])
    expect(plan!.shadowed).not.toContain(promptSeq)
    expect(plan!.surfaceOp).toEqual({ op: 'replace', start: nodes[2]!, end: nodes[5]! })
  })

  it('falls back to the turn boundary when no range was captured', () => {
    const { entries, nodes } = threeTurns()
    const plan = planTruncationMarker(view(entries, nodes), {
      fromTurn: 2, turn: 9, step: 10000, messageId: 'id', restoredCount: 0, deletedCount: 0,
    })
    expect(plan!.shadowed).toEqual([nodes[2]!, nodes[3]!, nodes[4]!, nodes[5]!])
  })

  it('fallback keeps turns started after the rollback out of the range', () => {
    // A pending record written before ranges were captured carries only the
    // rollback time; everything appended later must survive.
    const entries = [
      { type: 'turn/start', data: { turn: 1 }, time: 100 },
      { type: 'user/message', data: { id: 'm1', role: 'user', content: [{ type: 'text', text: 'old' }], source: { kind: 'user' } }, time: 101 },
      { type: 'turn/start', data: { turn: 2 }, time: 200 },
      { type: 'user/message', data: { id: 'm2', role: 'user', content: [{ type: 'text', text: 'rolled back' }], source: { kind: 'user' } }, time: 201 },
      { type: 'turn/start', data: { turn: 3 }, time: 500 },
      { type: 'user/message', data: { id: 'm3', role: 'user', content: [{ type: 'text', text: 'after the rollback' }], source: { kind: 'user' } }, time: 501 },
    ].map((entry, seq) => ({ ...entry, seq }))
    const fixture: SessionView = { events: entries, surface: { nodes: [1, 3, 5] } }
    const plan = planTruncationMarker(fixture, {
      fromTurn: 2, capturedAt: 300, turn: 9, step: 10000, messageId: 'id', restoredCount: 0, deletedCount: 0,
    })
    expect(plan!.shadowed).toEqual([3])
    expect(plan!.surfaceOp).toEqual({ op: 'replace', start: 3, end: 3 })
  })

  it('marks an emptying rollback that leaves no real content before the cut', () => {
    const first = { type: 'user/message', data: { id: 'm', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } }
    const fixture = view([
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'step/start', data: { turn: 1, step: 1 } },
      first,
      { type: 'turn/end', data: { turn: 1 } },
    ], [2])
    const plan = planTruncationMarker(fixture, {
      fromTurn: 1, shadowedFirst: 2, shadowedLast: 2, turn: 9, step: 10000, messageId: 'id',
      restoredCount: 0, deletedCount: 0,
    })
    expect(plan!.surfaceOp).toEqual({ op: 'replace', start: 2, end: 2 })
    expect((plan!.data.message.rollback as { emptied: boolean }).emptied).toBe(true)
  })

  it('returns null when the surface holds nothing left to shadow', () => {
    const { entries } = threeTurns()
    const plan = planTruncationMarker(view(entries, []), {
      fromTurn: 2, shadowedFirst: 1, shadowedLast: 9, turn: 9, step: 10000, messageId: 'id',
      restoredCount: 0, deletedCount: 0,
    })
    expect(plan).toBeNull()
  })
})

describe('surfaceNodesWithin', () => {
  it('keeps only the live surface nodes inside the captured range', () => {
    const { entries, nodes } = threeTurns()
    // A node that a later compaction already removed simply drops out.
    const fixture = view(entries, nodes.filter(seq => seq !== nodes[3]))
    expect(surfaceNodesWithin(fixture, nodes[2]!, nodes[5]!)).toEqual([nodes[2]!, nodes[4]!, nodes[5]!])
    expect(surfaceNodesWithin(fixture, 0, 1)).toEqual([])
  })
})

describe('hasRollbackMarker', () => {
  it('detects both marker generations for the same rollback', () => {
    const current = { type: 'user/message', data: { id: 'm', role: 'user', content: [], source: { kind: 'plugin', plugin: 'rollback' }, rollback: { fromTurn: 2 } } }
    const legacy = { type: 'assistant/message', data: { turn: 4, step: 1, message: { role: 'assistant', content: [], rollback: { fromTurn: 5 } } } }
    const fixture = view([{ type: 'turn/start', data: { turn: 1 } }, current, legacy], [1, 2])
    expect(hasRollbackMarker(fixture.events, 2)).toBe(true)
    expect(hasRollbackMarker(fixture.events, 5)).toBe(true)
    expect(hasRollbackMarker(fixture.events, 3)).toBe(false)
  })

  it('is false for a log without rollback markers', () => {
    const { entries } = threeTurns()
    expect(hasRollbackMarker(view(entries, []).events, 1)).toBe(false)
  })
})
