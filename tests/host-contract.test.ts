import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { KNOWN_SESSION_EVENT_TYPES, Session, deriveEventMessage } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'

// Resolve public exports through the pinned Session package, without new deps.
const resolver = createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-session'))
const { releasedV4SessionFormatCodec: codec, restoreReleasedV4Artifact: restore } = await import(
  pathToFileURL(resolver.resolve('@deepseek-ai/dsh-session-format-v3-to-v4')).href
)
const { TokenMeter } = await import(pathToFileURL(resolver.resolve('@deepseek-ai/dsh-token-meter')).href)

type FixtureEvent = { seq: number; time: number; type: string; data: any; surfaceOp?: any; sourceEventSeqs?: number[] }
const header = { version: 4, id: 'host-contract-fixture', createdAt: 0, isSeeded: false, delegationDepth: 0 }
const message = (id: string, role: string, text?: string, kind = 'plugin:fixture') => ({
  id, role, source: { kind }, content: text === undefined ? [] : [{ type: 'text', text }],
})
const event = (seq: number, type: string, data: any, options: Partial<FixtureEvent> = {}): FixtureEvent => ({
  seq, time: 0, type, data, ...options,
})
// A completed prior turn, NOT a synthetic rollback turn. Candidates are idle.
const seed = () => [
  event(0, 'user/message', message('original', 'user', 'original content '.repeat(40), 'user'), { surfaceOp: 'append' }),
  event(1, 'turn/start', { turn: 1 }),
  event(2, 'step/start', { turn: 1, step: 1 }),
  event(3, 'step/end', { turn: 1, step: 1 }),
  event(4, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
]
const replaceOptions = { surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 }, sourceEventSeqs: [0] }
const userMarker = (seq = 5) => event(seq, 'user/message', message('marker', 'user', 'rollback'), replaceOptions)
const idleDeveloper = () => event(5, 'developer/message', {
  turn: 1, step: 1, message: message('silent', 'developer'),
}, replaceOptions)
const artifact = (events: FixtureEvent[]) => ({ header, inheritedEventCount: 0, events })
function append(session: Session, e: FixtureEvent) {
  session.append(e.type as any, e.data, {
    ...(e.surfaceOp === undefined ? {} : { surfaceOp: e.surfaceOp }),
    ...(e.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: e.sourceEventSeqs }),
  } as any)
}
function detached() {
  const session = Session.create('host-contract-fixture' as any)
  for (const e of seed()) append(session, e)
  return session
}
function meterFixture() {
  // An isolated in-memory Cordis context. Capture real public registration;
  // never import private folds or touch the desktop profile.
  const ctx = new Context()
  const definitions = new Map<string, any>()
  ctx.provide('sessionProjections', { register: (definition: any) => { definitions.set(definition.key, definition) } })
  return { meter: new TokenMeter(ctx), definitions }
}
const prune = (tokens: number) => event(5, 'compaction/prune', {
  shadowedRange: { start: 0, end: 0 }, shadowedSeqs: [0], shadowedTokenCount: tokens,
})

describe('pinned real host v4 idle rollback contracts', () => {
  it('encodes both carriers but rejects idle developer at whole-artifact restore', () => {
    for (const candidate of [idleDeveloper(), userMarker()]) {
      expect(() => codec.encodeHeader(header, 0)).not.toThrow()
      for (const e of [...seed(), candidate]) expect(() => codec.encodeEvent(e)).not.toThrow()
    }
    expect(() => restore(artifact([...seed(), idleDeveloper()]), KNOWN_SESSION_EVENT_TYPES))
      .toThrow(/developer\/message does not match an open turn and step/)
    expect(() => restore(artifact([...seed(), userMarker()]), KNOWN_SESSION_EVENT_TYPES)).not.toThrow()
  })

  it('shows detached append plus silent derivation is not live or restore safety', () => {
    const session = detached()
    append(session, idleDeveloper())
    expect(deriveEventMessage(session.snapshotEvents().at(-1)!)).toBeNull()
    expect(() => restore(artifact(session.snapshotEvents() as any), KNOWN_SESSION_EVENT_TYPES))
      .toThrow(/does not match an open turn and step/)
  })

  it('does not treat empty user content as a silent carrier', () => {
    expect(deriveEventMessage(event(5, 'user/message', message('empty-user', 'user'), replaceOptions) as any))
      .not.toBeNull()
  })

  it('restores idle prune plus user replacement without compaction/start or turn/step', () => {
    const { meter } = meterFixture()
    const tokens = meter.measure(detached()).nodes[0].heuristicTokens
    const events = [...seed(), prune(tokens), userMarker(6)]
    for (const e of events) expect(() => codec.encodeEvent(e)).not.toThrow()
    expect(() => restore(artifact(events), KNOWN_SESSION_EVENT_TYPES)).not.toThrow()
    expect(events[5].data).toEqual({
      shadowedRange: { start: 0, end: 0 }, shadowedSeqs: [0], shadowedTokenCount: tokens,
    })
  })

  it('measurement shrinks either way but projected pressure needs adjacent heuristic pricing', () => {
    const { meter, definitions } = meterFixture()
    const unpriced = detached()
    const priced = detached()
    const shadowed = meter.measure(unpriced).nodes[0].heuristicTokens
    const markerTokens = meter.estimateMessage(userMarker().data)
    expect(shadowed).toBeGreaterThan(markerTokens)
    const pressure = definitions.get('contextPressure')
    // A valid provider-anchored checkpoint; no invented assistant usage stream.
    const anchor = pressure.stateSchema.parse({ surfaceTokens: shadowed, pressureTokens: 1000, sampledSurfaceTokens: shadowed })
    const unpricedState = pressure.apply(anchor, userMarker())
    const pricedState = pressure.apply(pressure.apply(anchor, prune(shadowed)), userMarker(6))
    append(unpriced, userMarker())
    append(priced, prune(shadowed))
    append(priced, userMarker(6))
    expect(meter.measure(unpriced).surfaceTokens).toBe(markerTokens)
    expect(meter.measure(priced).surfaceTokens).toBe(markerTokens)
    expect(meter.measure(priced).nodes.map((node: any) => node.seq)).toEqual([6])
    expect(pressure.wire.view(unpricedState).projectedTokens).toBe(1000)
    expect(pressure.wire.view(pricedState).projectedTokens).toBe(1000 + markerTokens - shadowed)
    const breakdown = definitions.get('contextBreakdown')
    const before = seed().reduce((state, e) => breakdown.apply(state, e), breakdown.init())
    expect(breakdown.wire.view(breakdown.apply(before, userMarker())))
      .toEqual(breakdown.wire.view(breakdown.apply(breakdown.apply(before, prune(shadowed)), userMarker(6))))
  })

  it('uses exact first/last surface identities even when endpoints are numerically inverted', () => {
    const second = event(5, 'user/message', message('second', 'user', 'second original'), { surfaceOp: 'append' })
    const firstReplacement = userMarker(6)
    const events = [...seed(), second, firstReplacement]
    const session = detached()
    append(session, second)
    append(session, firstReplacement)
    const { meter } = meterFixture()
    const nodes = meter.measure(session).nodes
    expect(nodes.map((node: any) => node.seq)).toEqual([6, 5])
    const claim = event(7, 'compaction/prune', {
      shadowedRange: { start: 6, end: 5 }, shadowedSeqs: [6, 5],
      shadowedTokenCount: nodes.reduce((sum: number, node: any) => sum + node.heuristicTokens, 0),
    })
    const replacement = event(8, 'user/message', message('final', 'user', 'rollback'), {
      surfaceOp: { op: 'replace', startSeq: 6, endSeq: 5 }, sourceEventSeqs: [6, 5],
    })
    expect(() => restore(artifact([...events, claim, replacement]), KNOWN_SESSION_EVENT_TYPES)).not.toThrow()
    expect(() => restore(artifact([...events, { ...claim, data: { ...claim.data, shadowedSeqs: [5, 6] } }, replacement]), KNOWN_SESSION_EVENT_TYPES))
      .toThrow(/exact current surface span/)
  })

  it('expires claims across unrelated events and rejects mismatched replacement spans', () => {
    const { definitions } = meterFixture()
    const pressure = definitions.get('contextPressure')
    const anchor = pressure.stateSchema.parse({ surfaceTokens: 100, pressureTokens: 1000, sampledSurfaceTokens: 100 })
    const armed = pressure.apply(anchor, prune(100))
    const expired = pressure.apply(armed, event(6, 'session/title', {}))
    expect(pressure.wire.view(pressure.apply(expired, userMarker(7))).projectedTokens).toBe(1000)
    expect(() => pressure.apply(armed, {
      ...userMarker(6), surfaceOp: { op: 'replace', startSeq: 0, endSeq: 1 },
    })).toThrow()
  })
})
