import { describe, expect, it, vi } from 'vitest'
import {
  planTruncationMarker,
  replaceSurfaceOpCandidates,
  ROLLBACK_CHECKPOINT_TEXT,
  ROLLBACK_MARKER_SOURCE,
  shadowedSurfaceFrom,
  systemPromptNodeSeq,
  turnStartSeqFor,
  withReplaceSurfaceOpFallback,
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

/**
 * The real 0.1.5 shape of a first turn, where the SYSTEM PROMPT is surface node 0.
 *
 * The loop opens the turn and its step FIRST and commits the system prompt from
 * inside that step (`dsh-agent-loop/lib/index.js:1023`, after `turn/start`), so
 * the prompt's seq already lies inside turn 1's range while its node sits at
 * surface index 0 — exactly the position 0.1.5 protects
 * (`dsh-session/lib/index.js:379-381`). Turn 2 appends a second system node at
 * seq 9: later system nodes carry no protection and a range may shadow them.
 */
function systemPromptFirstTurn(): { entries: { type: string; data?: unknown }[]; nodes: number[] } {
  const entries: { type: string; data?: unknown }[] = [
    { type: 'turn/start', data: { turn: 1 } },                                                            // 0
    { type: 'step/start', data: { turn: 1, step: 1 } },                                                   // 1
    { type: 'system/message', data: { turn: 1, step: 1 } },                                               // 2 ← surface node 0
    { type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text: 't1' }] } } }, // 3
    { type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'a1' }] } } }, // 4
    { type: 'step/end', data: { turn: 1, step: 1 } },                                                     // 5
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },                               // 6
    { type: 'turn/start', data: { turn: 2 } },                                                            // 7
    { type: 'step/start', data: { turn: 2, step: 1 } },                                                   // 8
    { type: 'system/message', data: { turn: 2, step: 1 } },                                               // 9 (unprotected)
    { type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text: 't2' }] } } }, // 10
    { type: 'assistant/message', data: { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'a2' }] } } }, // 11
    { type: 'step/end', data: { turn: 2, step: 1 } },                                                     // 12
    { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },                               // 13
  ]
  return { entries, nodes: [2, 3, 4, 9, 10, 11] }
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
    expect(plan.range).toEqual({ start: nodes[2]!, end: nodes[5]! })
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

  it('keeps the checkpoint notice inside its token budget', () => {
    // The marker replaces history the model no longer sees, and it STAYS in the
    // model's context for the rest of the session: a later rollback replaces it,
    // nothing else removes it. So its length is paid on every subsequent request,
    // which is why it was tightened from 331 characters. This budget is the guard
    // against it quietly growing back — the four facts it must carry are (1) it is
    // machine-generated, (2) earlier messages were removed, (3) files were reverted
    // with them, and (4) continue from what remains without mentioning it.
    expect(ROLLBACK_CHECKPOINT_TEXT.length).toBeLessThanOrEqual(150)
    expect(ROLLBACK_CHECKPOINT_TEXT).toContain('Automated checkpoint')
    expect(ROLLBACK_CHECKPOINT_TEXT).toContain('removed')
    expect(ROLLBACK_CHECKPOINT_TEXT).toMatch(/files restored/i)
    expect(ROLLBACK_CHECKPOINT_TEXT).toMatch(/don't mention/i)
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
    expect(plan.range).toEqual({ start: nodes[4]!, end: nodes[5]! })
    expect(plan.shadowed).not.toContain(nodes[0])
    expect(plan.shadowed).not.toContain(nodes[2])
  })

  it('returns null when the surface holds nothing to shadow', () => {
    const { entries } = threeTurns()
    expect(planTruncationMarker(view(entries, []), { fromTurn: 2, messageId: 'id' })).toBeNull()
    expect(planTruncationMarker(view(entries, []), { fromTurn: 9, messageId: 'id' })).toBeNull()
  })
})

describe('the protected system-prompt node (0.1.5 node 0)', () => {
  const degenerate = (): SessionView =>
    // A first turn whose ONLY surface node is the system prompt: the turn opened,
    // committed the prompt, and produced nothing else the surface holds.
    view(
      [
        { type: 'turn/start', data: { turn: 1 } },                              // 0
        { type: 'step/start', data: { turn: 1, step: 1 } },                     // 1
        { type: 'system/message', data: { turn: 1, step: 1 } },                 // 2 ← surface node 0
        { type: 'step/end', data: { turn: 1, step: 1 } },                       // 3
        { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }, // 4
      ],
      [2],
    )

  it('identifies the system-prompt node by TYPE at surface index 0, and only there', () => {
    const { entries, nodes } = systemPromptFirstTurn()
    expect(systemPromptNodeSeq(view(entries, nodes))).toBe(2)
    expect(systemPromptNodeSeq(degenerate())).toBe(2)
    // A build that keeps the prompt out of history has no protected node — and a
    // node whose event the log does not carry is not one either: the framework
    // makes the same lookup and likewise declines to protect it.
    const { entries: plain, nodes: plainNodes } = threeTurns()
    expect(systemPromptNodeSeq(view(plain, plainNodes))).toBeNull()
    expect(systemPromptNodeSeq(view(plain, []))).toBeNull()
    expect(systemPromptNodeSeq(view(plain, [999]))).toBeNull()
  })

  it('excludes the system-prompt node from a first-turn rollback range', () => {
    const { entries, nodes } = systemPromptFirstTurn()
    const fixture = view(entries, nodes)
    // The premise of the bug: the prompt's node is inside turn 1's range, at the
    // very index 0.1.5 refuses to let a `user/message` shadow.
    expect(turnStartSeqFor(fixture, 1)).toBe(0)
    expect(systemPromptNodeSeq(fixture)).toBe(nodes[0])
    expect(shadowedSurfaceFrom(fixture, 1)).toEqual([3, 4, 9, 10, 11])

    const plan = planned(fixture, 1)
    expect(plan.range).toEqual({ start: 3, end: 11 })
    expect(plan.shadowed).toEqual([3, 4, 9, 10, 11])
    expect(plan.shadowed).not.toContain(2)
    expect(plan.sourceEventSeqs).not.toContain(2)
    // The system prompt is skippable BY POSITION, not by type: the later system
    // node at seq 9 is inside the range and stays there.
    expect(plan.shadowed).toContain(9)
    // The client hides `[surfaceOp.startSeq, markerSeq)`, so the op must declare
    // the CLAMPED start — seq 2 stays outside it, and the prompt stays visible.
    expect(replaceSurfaceOpCandidates(plan.range!)).toEqual([
      { op: 'replace', startSeq: 3, endSeq: 11 },
      { op: 'replace', start: 3, end: 11 },
    ])
  })

  it('leaves a non-first-turn rollback exactly as it was', () => {
    const { entries, nodes } = systemPromptFirstTurn()
    const fixture = view(entries, nodes)
    expect(shadowedSurfaceFrom(fixture, 2)).toEqual([9, 10, 11])
    const plan = planned(fixture, 2)
    expect(plan.range).toEqual({ start: 9, end: 11 })
    expect(plan.shadowed).toEqual([9, 10, 11])
    expect(plan.sourceEventSeqs).toEqual([9, 10, 11])
  })

  it('does not clamp a range that starts on a node which is not the system prompt', () => {
    // `systemPrompt` not kept in history: node 0 is the user's own first message.
    // Clamping it away would leave a rolled-back turn in the model's context, so
    // the protection must be conditional on what node 0 actually holds.
    const { entries, nodes } = threeTurns()
    expect(systemPromptNodeSeq(view(entries, nodes))).toBeNull()
    expect(shadowedSurfaceFrom(view(entries, nodes), 1)).toEqual(nodes)
    const plan = planned(view(entries, nodes), 1)
    expect(plan.range).toEqual({ start: nodes[0]!, end: nodes[nodes.length - 1]! })
    expect(plan.shadowed).toEqual(nodes)
  })

  it('plans a marker WITHOUT a replace op when the clamp leaves nothing to replace', () => {
    const fixture = degenerate()
    expect(shadowedSurfaceFrom(fixture, 1)).toEqual([])
    const plan = planTruncationMarker(fixture, { fromTurn: 1, messageId: 'rollback-truncation-x' })
    // Not null: the files really were restored, so the model must still be told —
    // and an empty `replace` cannot be spelled at all (`replacementRange` demands
    // both ends be current surface nodes), while a surface-eligible event with no
    // `surfaceOp` is refused outright (`dsh-session/lib/index.js:276`). The
    // marker is therefore appended with no replacement.
    expect(plan).not.toBeNull()
    expect(plan!.range).toBeNull()
    expect(plan!.shadowed).toEqual([])
    expect(plan!.sourceEventSeqs).toEqual([])
    // …and it is still the marker both halves of the plugin recognize.
    expect(plan!.data.id).toBe('rollback-truncation-x')
    expect(plan!.data.role).toBe('user')
    expect(plan!.data.source).toEqual(ROLLBACK_MARKER_SOURCE)
    expect(plan!.data.content).toEqual([{ type: 'text', text: ROLLBACK_CHECKPOINT_TEXT }])
  })

  it('still writes no marker at all when the surface holds nothing from the turn', () => {
    // The other empty outcome, and NOT the degenerate one: there was never a range
    // to clamp, so nothing is appended (the summary reports 无对话可截断).
    const { entries, nodes } = threeTurns()
    const silent = view(
      [...entries, { type: 'turn/start', data: { turn: 4 } }, { type: 'turn/end', data: { turn: 4 } }],
      nodes,
    )
    expect(planTruncationMarker(silent, { fromTurn: 4, messageId: 'id' })).toBeNull()
    expect(planTruncationMarker(view(entries, []), { fromTurn: 1, messageId: 'id' })).toBeNull()
  })
})

describe('replaceSurfaceOpCandidates', () => {
  it('offers the 0.1.5 spelling first, then the legacy one', () => {
    expect(replaceSurfaceOpCandidates({ start: 140, end: 795 })).toEqual([
      { op: 'replace', startSeq: 140, endSeq: 795 },
      { op: 'replace', start: 140, end: 795 },
    ])
  })

  it('carries exactly the three keys the validator demands', () => {
    // 0.1.5's `isReplaceOp` checks the KEY COUNT as well as the names
    // (`dsh-session/lib/index.js:262-264`), so a helpful extra field — or both
    // spellings on one op — is rejected just as hard as a missing one. This pins
    // the exact shape; a merged op would pass `toEqual` on the pairs alone.
    const [preferred, legacy] = replaceSurfaceOpCandidates({ start: 1, end: 2 })
    expect(Object.keys(preferred!).sort()).toEqual(['endSeq', 'op', 'startSeq'])
    expect(Object.keys(legacy!).sort()).toEqual(['end', 'op', 'start'])
  })
})

describe('withReplaceSurfaceOpFallback', () => {
  /** The refusal 0.1.5 raises for a replace op whose keys it does not recognize. */
  const shapeRefusal = () => new Error('session event "user/message" carries an invalid replace surfaceOp')

  it('writes the 0.1.5 spelling and never tries the legacy one', () => {
    const attempt = vi.fn(() => 'logged')
    expect(withReplaceSurfaceOpFallback({ start: 140, end: 795 }, attempt)).toBe('logged')
    expect(attempt).toHaveBeenCalledTimes(1)
    expect(attempt).toHaveBeenCalledWith({ op: 'replace', startSeq: 140, endSeq: 795 })
  })

  it('retries once with the legacy spelling when the shape is refused', () => {
    // An older host: the modern keys are the invalid ones there. The retry is safe
    // because a refused append persists nothing — Session.append validates before
    // `this.log.push` and before the observers persistence buffers from.
    const attempt = vi.fn((op: unknown) => {
      if ('startSeq' in (op as object)) throw shapeRefusal()
      return 'logged'
    })
    expect(withReplaceSurfaceOpFallback({ start: 140, end: 795 }, attempt)).toBe('logged')
    expect(attempt).toHaveBeenCalledTimes(2)
    expect(attempt).toHaveBeenLastCalledWith({ op: 'replace', start: 140, end: 795 })
  })

  it('does not retry a real failure, and reports it unchanged', () => {
    // A shadowed node missing from the surface fails identically under both
    // spellings, so a retry would only bury this diagnostic under a second one.
    const real = new Error('surface replace: start seq 140 not found in surface')
    const attempt = vi.fn(() => { throw real })
    expect(() => withReplaceSurfaceOpFallback({ start: 140, end: 795 }, attempt)).toThrow(real)
    expect(attempt).toHaveBeenCalledTimes(1)
  })

  it('reports the second failure when neither spelling is accepted', () => {
    const legacyFailure = new Error('sourceEventSeqs must include every shadowed surface node; missing 795')
    const attempt = vi.fn((op: unknown) => {
      if ('startSeq' in (op as object)) throw shapeRefusal()
      throw legacyFailure
    })
    expect(() => withReplaceSurfaceOpFallback({ start: 140, end: 795 }, attempt)).toThrow(legacyFailure)
    expect(attempt).toHaveBeenCalledTimes(2)
  })
})