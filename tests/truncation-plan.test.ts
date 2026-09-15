import { describe, expect, it } from 'vitest'
import {
  planTruncationMarker,
  ROLLBACK_CHECKPOINT_TEXT,
  ROLLBACK_MARKER_SOURCE,
  shadowedSurfaceFrom,
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

/** Plan a marker for one fixture, failing the test when nothing was planned. */
function planned(fixture: SessionView, fromTurn: number): NonNullable<ReturnType<typeof planTruncationMarker>> {
  const plan = planTruncationMarker(fixture, { fromTurn, messageId: 'rollback-truncation-x' })
  if (plan === null) throw new Error(`expected a plan for turn ${fromTurn}`)
  return plan
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

describe('planTruncationMarker', () => {
  it('replaces exactly the targeted range with one plugin user message', () => {
    const { entries, nodes } = threeTurns()
    const plan = planned(view(entries, nodes), 2)
    expect(plan.surfaceOp).toEqual({ op: 'replace', start: nodes[2]!, end: nodes[5]! })
    expect(plan.sourceEventSeqs).toEqual([nodes[2]!, nodes[3]!, nodes[4]!, nodes[5]!])
    expect(plan.shadowed).toEqual([nodes[2]!, nodes[3]!, nodes[4]!, nodes[5]!])
  })

  it('carries the checkpoint text on a user message the provider accepts', () => {
    const { entries, nodes } = threeTurns()
    const plan = planned(view(entries, nodes), 2)
    expect(plan.data.id).toBe('rollback-truncation-x')
    expect(plan.data.role).toBe('user')
    expect(plan.data.source).toEqual(ROLLBACK_MARKER_SOURCE)
    // Non-empty content: a strict OpenAI-compatible gateway rejects a user
    // message with no content, which is why the marker is never empty.
    expect(plan.data.content).toEqual([{ type: 'text', text: ROLLBACK_CHECKPOINT_TEXT }])
    expect(ROLLBACK_CHECKPOINT_TEXT.length).toBeGreaterThan(0)
  })

  it('never rides an assistant/message or any step-scoped shape', () => {
    // Regression guard: the marker MUST stay a `user/message` carrying a surface
    // replacement. An empty-content `assistant/message` is the model-invisible
    // form, but DSH accepts it only inside an open step — hosting it meant either
    // a synthetic turn (which duplicated turn numbers and corrupted sessions) or
    // a deferred write (which left the rollback invisible until the next turn).
    const { entries, nodes } = threeTurns()
    const plan = planned(view(entries, nodes), 1)
    expect(plan.data.role).not.toBe('assistant')
    expect(plan.data.content.length).toBeGreaterThan(0)
    expect('turn' in plan.data).toBe(false)
    expect('step' in plan.data).toBe(false)
  })

  it('replaces only the range from the targeted turn on, leaving earlier turns alone', () => {
    const { entries, nodes } = threeTurns()
    const plan = planned(view(entries, nodes), 3)
    expect(plan.surfaceOp).toEqual({ op: 'replace', start: nodes[4]!, end: nodes[5]! })
    expect(plan.shadowed).not.toContain(nodes[0])
    expect(plan.shadowed).not.toContain(nodes[2])
  })

  it('returns null when the surface holds nothing to shadow', () => {
    const { entries } = threeTurns()
    expect(planTruncationMarker(view(entries, []), { fromTurn: 2, messageId: 'id' })).toBeNull()
    expect(planTruncationMarker(view(entries, []), { fromTurn: 9, messageId: 'id' })).toBeNull()
  })
})