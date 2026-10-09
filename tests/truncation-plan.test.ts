import { describe, expect, it, vi } from 'vitest'
import {
  alreadyShadowed,
  isRollbackMarkerSource,
  planTruncationMarker,
  replaceSurfaceOpCandidates,
  ROLLBACK_CHECKPOINT_TEXT,
  ROLLBACK_MARKER_KIND,
  ROLLBACK_MARKER_SOURCE,
  ROLLBACK_PLUGIN,
  rolledBackAlready,
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
    // Same seqs, not the same ORDER: the citation is deliberately spelled so the session
    // store will not compress it into range pairs, which is what made a session
    // unopenable (see "the shadowed seqs a marker cites"). `shadowed` keeps surface order.
    expect([...plan.sourceEventSeqs].sort((a, b) => a - b)).toEqual([nodes[2]!, nodes[3]!, nodes[4]!, nodes[5]!])
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

  it('keeps the checkpoint notice bounded and limits its file claim to tracked contents', () => {
    // Replacement text is model-visible on subsequent requests, so keep it
    // short without implying a complete workspace or metadata restoration.
    expect(ROLLBACK_CHECKPOINT_TEXT.length).toBeLessThanOrEqual(150)
    expect(ROLLBACK_CHECKPOINT_TEXT).toContain('Automated checkpoint')
    expect(ROLLBACK_CHECKPOINT_TEXT).toContain('later messages removed')
    expect(ROLLBACK_CHECKPOINT_TEXT).toMatch(/tracked file contents restored/i)
    expect(ROLLBACK_CHECKPOINT_TEXT).not.toContain('files restored to that point')
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
    // A run of three IS the compressible shape, so this citation is reordered on purpose
    // while still citing every shadowed seq exactly once (see "the shadowed seqs a marker
    // cites" for what the store would otherwise do to it).
    expect([...plan.sourceEventSeqs].sort((a, b) => a - b)).toEqual([9, 10, 11])
    expect(new Set(plan.sourceEventSeqs).size).toBe(3)
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

describe('the marker source format v4 accepts', () => {
  it('is the producer-owned kind, never the released `plugin` wrapper', () => {
    // THE regression this test exists for. The wrapper is what the plugin wrote
    // through 0.3.1, and DSH 0.2.0's format v4 refuses it by name:
    // `format v4 message requires a producer-owned source kind`
    // (dsh-session-format-v3-to-v4/lib/index.js:126). The refusal lands on the
    // marker's own event, so every later turn in that session failed — a rollback
    // that appeared to succeed made the conversation unusable.
    expect(ROLLBACK_MARKER_SOURCE.kind).toBe('plugin:rollback')
    expect(ROLLBACK_MARKER_SOURCE.kind).not.toBe('plugin')
    expect('plugin' in ROLLBACK_MARKER_SOURCE).toBe(false)
  })

  it('is the shape the framework\u2019s own v3\u2192v4 migration lifts a wrapper INTO', () => {
    // `rewritePluginSource` maps `{kind:'plugin',plugin:'rollback'}` to
    // `producerKind('rollback')` = `plugin:rollback` (there is no rename for this
    // plugin). Writing that shape directly means a marker authored here and one
    // carried over from an older log are byte-identical.
    expect(ROLLBACK_MARKER_KIND).toBe(`plugin:${ROLLBACK_PLUGIN}`)
  })

  it('rides the marker data the planner builds', () => {
    const { entries, nodes } = threeTurns()
    const plan = planned(view(entries, nodes), 2)
    expect(plan.data.source).toBe(ROLLBACK_MARKER_SOURCE)
    expect(plan.data.role).toBe('user')
  })
})

describe('isRollbackMarkerSource', () => {
  it('recognizes both provenance spellings', () => {
    // Old logs and new logs both exist, and the reader serves them equally.
    expect(isRollbackMarkerSource({ kind: 'plugin:rollback' })).toBe(true)
    expect(isRollbackMarkerSource({ kind: 'plugin', plugin: 'rollback' })).toBe(true)
  })

  it('refuses every other producer', () => {
    expect(isRollbackMarkerSource({ kind: 'plugin:compaction' })).toBe(false)
    expect(isRollbackMarkerSource({ kind: 'plugin', plugin: 'compaction' })).toBe(false)
    expect(isRollbackMarkerSource({ kind: 'user' })).toBe(false)
    expect(isRollbackMarkerSource({ kind: 'model', provider: 'p', model: 'm' })).toBe(false)
    // The pair is the identity: a `plugin` field alone, or under another kind,
    // does not make this plugin the producer.
    expect(isRollbackMarkerSource({ plugin: 'rollback' })).toBe(false)
    expect(isRollbackMarkerSource({ kind: 'user', plugin: 'rollback' })).toBe(false)
  })

  it('survives a missing or malformed source', () => {
    expect(isRollbackMarkerSource(undefined)).toBe(false)
    expect(isRollbackMarkerSource(null)).toBe(false)
    expect(isRollbackMarkerSource('plugin:rollback')).toBe(false)
    expect(isRollbackMarkerSource({})).toBe(false)
  })
})

/**
 * The desktop defect of 2026-10-03, in miniature.
 *
 * One session, four rollbacks of the same turn. The first shadowed turn 3 correctly
 * (`{ startSeq: 53, endSeq: 54 }`). The three after it each found turn 3 gone from the
 * SURFACE but still present in the LOG, so the range search started at the first surface
 * node at or after the turn's boundary — the PREVIOUS MARKER — and wrote a range of one
 * seq (`{60,60}`, `{75,75}`, `{93,93}` in the log). Because the framework REPLACES what
 * a range covers, every one of those rollbacks destroyed the marker before it, and with
 * it the window that was hiding turn 3: rolling back again un-hid what the last rollback
 * had hidden, while reporting "已回退…已截断对话" and changing nothing the user could see.
 */
describe('a turn that was already rolled back', () => {
  /** Turns 1-3, one user and one assistant message each; seqs are array indices. */
  function threeTurnsWithClosings(): { entries: { type: string; data?: unknown }[]; nodes: number[] } {
    const entries: { type: string; data?: unknown }[] = []
    const nodes: number[] = []
    for (let turn = 1; turn <= 3; turn++) {
      entries.push({ type: 'turn/start', data: { turn } })
      entries.push({ type: 'step/start', data: { turn, step: 1 } })
      entries.push({ type: 'user/message', data: { turn } })
      nodes.push(entries.length - 1)
      entries.push({ type: 'assistant/message', data: { turn, step: 1 } })
      nodes.push(entries.length - 1)
      entries.push({ type: 'step/end', data: { turn, step: 1 } })
      entries.push({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
    }
    return { entries, nodes }
  }

  /**
   * Turn 3 rolled back once: its two messages (seqs 14 and 15) are gone from the surface
   * and the checkpoint the rollback appended (seq 18) stands where they were.
   */
  function afterRollingBackTurn3(): SessionView {
    const { entries, nodes } = threeTurnsWithClosings()
    entries.push({ type: 'user/message', data: { source: { kind: 'plugin:rollback' } } })
    return view(entries, [...nodes.slice(0, 4), 18])
  }

  /** The same log with turn 3 still standing — the state the FIRST rollback ran against. */
  function beforeAnyRollback(): SessionView {
    const { entries, nodes } = threeTurnsWithClosings()
    return view(entries, nodes)
  }

  it('is recognized as already shadowed', () => {
    expect(alreadyShadowed(afterRollingBackTurn3(), 3)).toBe(true)
    // The turn before it is untouched, and a turn the log never had is not our call.
    expect(alreadyShadowed(afterRollingBackTurn3(), 2)).toBe(false)
    expect(alreadyShadowed(afterRollingBackTurn3(), 9)).toBe(false)
  })

  it('is NOT mistaken for already shadowed while its own output still stands', () => {
    expect(alreadyShadowed(beforeAnyRollback(), 3)).toBe(false)
    expect(alreadyShadowed(beforeAnyRollback(), 2)).toBe(false)
    expect(alreadyShadowed(beforeAnyRollback(), 1)).toBe(false)
  })

  it('plans nothing, so no degenerate range can replace the previous marker', () => {
    // The regression itself: the old planner returned `{ start: 18, end: 18 }` here.
    expect(planTruncationMarker(afterRollingBackTurn3(), { fromTurn: 3, messageId: 'm' })).toBeNull()
    expect(shadowedSurfaceFrom(afterRollingBackTurn3(), 3)).toEqual([])
  })

  it('refuses with an explanation, and stays quiet for a rollback that can proceed', () => {
    expect(rolledBackAlready(afterRollingBackTurn3(), 3)).toContain('第 3 轮')
    expect(rolledBackAlready(afterRollingBackTurn3(), 2)).toBeNull()
    expect(rolledBackAlready(beforeAnyRollback(), 3)).toBeNull()
  })

  it('still plans the turn before it, and still plans the first rollback', () => {
    expect(shadowedSurfaceFrom(afterRollingBackTurn3(), 2)).toEqual([8, 9, 18])
    expect(shadowedSurfaceFrom(beforeAnyRollback(), 3)).toEqual([14, 15])
    const plan = planTruncationMarker(beforeAnyRollback(), { fromTurn: 3, messageId: 'm' })
    expect(plan?.range).toEqual({ start: 14, end: 15 })
    expect(plan?.sourceEventSeqs).toEqual([14, 15])
  })
})

/**
 * The spelling of `sourceEventSeqs`, for a session that must stay OPENABLE.
 *
 * The JSONL store compresses a strictly increasing list with a run of three or more
 * consecutive seqs into a `[start, end]` pair (`encodeSeqRanges`,
 * `dsh-session/lib/index.js:982`), while the runtime consumer of the same field demands
 * every entry be a safe integer (`:320`). Measured 2026-10-03, a marker whose list was
 * compressed left the session unopenable: the transcript stood at "载入历史…", nothing
 * was hidden, and every later rollback had no slice to work with. The fix is the list's
 * ORDER — legal by every rule the runtime states (unique, earlier than the marker,
 * `:321-325`), while failing the encoder's precondition. These tests pin the property
 * that matters (the store must not find it compressible) and the one that must not be
 * lost with it (every shadowed seq still cited, exactly once).
 */
describe('the shadowed seqs a marker cites', () => {
  /** Turns 1-3, one user and one assistant message each. */
  function threeTurns(): SessionView {
    const entries: { type: string; data?: unknown }[] = []
    const nodes: number[] = []
    for (let turn = 1; turn <= 3; turn++) {
      entries.push({ type: 'turn/start', data: { turn } })
      entries.push({ type: 'step/start', data: { turn, step: 1 } })
      entries.push({ type: 'user/message', data: { turn } })
      nodes.push(entries.length - 1)
      entries.push({ type: 'assistant/message', data: { turn, step: 1 } })
      nodes.push(entries.length - 1)
      entries.push({ type: 'step/end', data: { turn, step: 1 } })
      entries.push({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
    }
    return view(entries, nodes)
  }

  /**
   * A turn whose surface holds a RUN of consecutive seqs — the shape that made the store
   * compress, and the shape a turn with several tool results produces on its own.
   */
  function turnWithConsecutiveNodes(): SessionView {
    const entries: { type: string; data?: unknown }[] = []
    const nodes: number[] = []
    entries.push({ type: 'turn/start', data: { turn: 1 } })
    entries.push({ type: 'step/start', data: { turn: 1, step: 1 } })
    entries.push({ type: 'user/message', data: { turn: 1 } })
    nodes.push(entries.length - 1)
    for (let index = 0; index < 4; index += 1) {
      entries.push({ type: 'tool/result', data: { turn: 1 } })
      nodes.push(entries.length - 1)
    }
    entries.push({ type: 'step/end', data: { turn: 1, step: 1 } })
    entries.push({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    return view(entries, nodes)
  }

  /** The store's compression precondition, restated so the test states it independently. */
  const compressible = (seqs: readonly number[]): boolean =>
    seqs.every((seq, index) => index === 0 || seq > seqs[index - 1]!)

  it('cites every shadowed seq exactly once, and never in a compressible order', () => {
    const fixture = turnWithConsecutiveNodes()
    const shadowed = shadowedSurfaceFrom(fixture, 1)
    expect(shadowed).toEqual([2, 3, 4, 5, 6])
    const plan = planTruncationMarker(fixture, { fromTurn: 1, messageId: 'm' })
    const cited = [...(plan?.sourceEventSeqs ?? [])]
    // Same set, same size: the reordering may not lose or duplicate anything, because the
    // runtime refuses a duplicate and refuses a missing shadowed node.
    expect([...cited].sort((a, b) => a - b)).toEqual(shadowed)
    expect(new Set(cited).size).toBe(cited.length)
    expect(compressible(cited)).toBe(false)
    // The range itself is untouched: only the citation's spelling changed.
    expect(plan?.range).toEqual({ start: 2, end: 6 })
  })

  it('leaves a list too short to compress in its natural order', () => {
    const plan = planTruncationMarker(threeTurns(), { fromTurn: 3, messageId: 'm' })
    expect(plan?.sourceEventSeqs).toEqual([14, 15])
  })
})