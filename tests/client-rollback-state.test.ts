import { describe, expect, it } from 'vitest'
import { stateLine, type RollbackState } from '../src/core/rollback-boundary.ts'
import type { ReadableElement } from '../src/core/turn-rail.ts'
import { isRevokedSeat, seatIdentity, stateForSession, RequestGeneration, previewVersionOf, rollbackRefreshSignature, isInternalReadOnlyRollbackCommand } from '../src/client/rollback-state.ts'

const state: RollbackState = { sessionId: 's', version: 10, turns: [2, 3], ranges: [{ start: 4, end: 8 }] }
const el = (attrs: Record<string, string>, child?: ReadableElement): ReadableElement => ({
  getAttribute: name => attrs[name] ?? null,
  querySelector: () => child ?? null,
})

describe('bounded seat revocation', () => {
  it('uses stable node identity, never a JSON flow key', () => {
    const row = el({ 'data-chat-node-key': 'node', 'data-chat-flow-key': '["node","part"]' })
    const requested: string[] = []
    expect(seatIdentity(row)).toEqual({ kind: 'node', key: 'node' })
    expect(isRevokedSeat(row, state, key => { requested.push(key); return 4 })).toBe(true)
    expect(requested).toEqual(['node'])
  })

  it('hides both inclusive endpoints but not newly appended nodes', () => {
    const row = el({ 'data-chat-node-key': 'node' })
    for (const seq of [4, 5, 8]) expect(isRevokedSeat(row, state, () => seq)).toBe(true)
    for (const seq of [3, 9, 100, undefined, NaN, 4.5, -1]) expect(isRevokedSeat(row, state, () => seq)).toBe(false)
  })

  it('keeps missing/unknown/flow-only identities visible', () => {
    expect(isRevokedSeat(el({ 'data-chat-flow-key': 'not-in-store', 'data-chat-turn': '2' }), state, () => 4)).toBe(false)
    expect(isRevokedSeat(el({ 'data-chat-node-key': 'missing' }), state, () => undefined)).toBe(false)
    expect(seatIdentity(el({ 'data-chat-node-key': '' }))).toBeNull()
  })

  it('reads ordinary and turn-level node official turns without a snapshot node', () => {
    expect(isRevokedSeat(el({ 'data-chat-node-key': 'user', 'data-chat-turn': '2' }), state, () => undefined)).toBe(true)
    expect(isRevokedSeat(el({ 'data-chat-node-key': 'new', 'data-chat-turn': '4' }), state, () => 20)).toBe(false)
  })

  it('hides groups only by their own official revoked turn', () => {
    const child = el({ 'data-turn-tail': '2' })
    const seqOf = (): never => { throw new Error('group must not resolve a node seq') }
    expect(isRevokedSeat(el({ 'data-chat-group-key': 'g', 'data-chat-turn': '2' }, child), state, seqOf)).toBe(true)
    expect(isRevokedSeat(el({ 'data-chat-group-key': 'g', 'data-chat-turn': '4' }, child), state, seqOf)).toBe(false)
    expect(isRevokedSeat(el({ 'data-chat-group-key': 'g' }, child), state, seqOf)).toBe(false)
    expect(isRevokedSeat(el({ 'data-chat-group-key': 'g', 'data-chat-turn': 'junk' }, child), state, seqOf)).toBe(false)
  })
})

describe('state response freshness and generations', () => {
  it('discards another session and malformed/legacy responses', () => {
    expect(stateForSession(stateLine(state), 'other', state)).toBeNull()
    expect(stateForSession('边界 2', 's', state)).toBeNull()
    expect(stateForSession('状态 {}', 's', state)).toBeNull()
  })

  it('retains newer same-session state but accepts later empty state', () => {
    expect(stateForSession(stateLine({ ...state, version: 9 }), 's', state)).toBe(state)
    expect(stateForSession(stateLine({ ...state, version: 11, turns: [], ranges: [] }), 's', state))
      .toEqual({ ...state, version: 11, turns: [], ranges: [] })
  })

  it('invalidates previous previews and closed/switched requests', () => {
    const requests = new RequestGeneration()
    const first = requests.next()
    const second = requests.next()
    expect(requests.current(first)).toBe(false)
    expect(requests.current(second)).toBe(true)
    requests.invalidate()
    expect(requests.current(second)).toBe(false)
  })

  it.each([['版本 0', 0], ['files\n版本 12\n', 12], ['版本 -1', null], ['版本 1.5', null],
    ['版本 9007199254740992', null], ['result: 版本 3', null], ['旧Host', null], [undefined, null]])
    ('parses semantic preview version %s', (text, version) => { expect(previewVersionOf(text as string | undefined)).toBe(version) })
})

describe('manual synchronization without RPC feedback loops', () => {
  it('hides only explicit internal read receipts, never user read commands', () => {
    for (const args of ['--internal list', '--internal state', '--internal preview 2']) {
      expect(isInternalReadOnlyRollbackCommand({ kind: 'command', data: { name: 'rollback', args } })).toBe(true)
    }
    for (const args of ['list', 'state', 'preview 2', '--apply 2 4']) {
      expect(isInternalReadOnlyRollbackCommand({ kind: 'command', data: { name: 'rollback', args } })).toBe(false)
    }
  })

  const chat = (nodes: any[]) => ({ order: nodes.map(node => node.key), nodes: { get: (key: string) => nodes.find(node => node.key === key) } })
  const user = { key: 'u', kind: 'user', anchorSeq: 1 }
  it('excludes only exact internal read-command fields, so its own refresh does not trigger itself', () => {
    const base = rollbackRefreshSignature(chat([user]))
    for (const args of ['--internal state', '--internal list', '--internal preview 2']) {
      const read = { key: 'rpc', kind: 'command', data: { name: 'rollback', args, outcome: { kind: 'success', text: 'state' } } }
      expect(rollbackRefreshSignature(chat([user, read]))).toBe(base)
    }
  })

  it('includes manual apply/retry/abort and their settlement', () => {
    const base = rollbackRefreshSignature(chat([user]))
    for (const args of ['--apply 2', '2', 'retry', 'abort']) {
      const run = { key: 'manual', kind: 'command', data: { name: 'rollback', args, outcome: null } }
      const done = { ...run, data: { ...run.data, outcome: { kind: 'success' } } }
      expect(rollbackRefreshSignature(chat([user, run]))).not.toBe(base)
      expect(rollbackRefreshSignature(chat([user, done]))).not.toBe(rollbackRefreshSignature(chat([user, run])))
    }
  })

  it('does not guess when command identity is missing, and notices non-command history changes', () => {
    expect(rollbackRefreshSignature(chat([user, { key: 'unknown', kind: 'command', data: { args: 'state' } }])))
      .not.toBe(rollbackRefreshSignature(chat([user])))
    expect(rollbackRefreshSignature(chat([{ ...user, anchorSeq: 2 }]))).not.toBe(rollbackRefreshSignature(chat([user])))
    expect(rollbackRefreshSignature(undefined)).toBe('unknown')
  })
})
