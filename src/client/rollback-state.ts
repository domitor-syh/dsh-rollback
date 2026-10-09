import { parseStateLine, type RollbackState } from '../core/rollback-boundary.ts'
import { turnFromAttribute, turnOfTurnLevelSeat, type ReadableElement } from '../core/turn-rail.ts'

/** A response may update only its own session and may not move state backwards. */
export function stateForSession(text: string, sessionId: string, current: RollbackState | null): RollbackState | null {
  const next = parseStateLine(text)
  if (next === undefined || next.sessionId !== sessionId) return null
  if (current?.sessionId === sessionId && next.version < current.version) return current
  return next
}

/** The stable identity contract; a flow key is a render key, not a node identity. */
export function seatIdentity(el: ReadableElement): { kind: 'node' | 'group'; key: string } | null {
  const node = el.getAttribute('data-chat-node-key')
  if (node !== null && node !== '') return { kind: 'node', key: node }
  const group = el.getAttribute('data-chat-group-key')
  return group !== null && group !== '' ? { kind: 'group', key: group } : null
}

/** Unknown seats remain visible; neither missing snapshot membership nor flow keys revoke them. */
export function isRevokedSeat(el: ReadableElement, state: RollbackState, seqOf: (key: string) => unknown): boolean {
  const identity = seatIdentity(el)
  if (identity === null) return false
  // A group owns many nodes: only its own official turn can revoke the wrapper.
  const turn = identity.kind === 'group'
    ? turnFromAttribute(el.getAttribute('data-chat-turn'))
    : turnOfTurnLevelSeat(el)
  if (turn !== null && state.turns.includes(turn)) return true
  if (identity.kind === 'group') return false
  const seq = seqOf(identity.key)
  return typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0
    && state.ranges.some(range => seq >= range.start && seq <= range.end)
}

/** Request identity is scoped to one mounted session and invalidated on close/switch. */
export class RequestGeneration {
  private value = 0
  next(): number { return ++this.value }
  current(request: number): boolean { return request === this.value }
  invalidate(): void { this.value += 1 }
}

/** Whether command arguments are one of the plugin's internal, read-only UI queries. */
export function isInternalReadOnlyRollbackArgs(args: unknown): boolean {
  return typeof args === 'string' && /^--internal\s+(?:state|list|diagnose|rescues|preview\s+[1-9]\d*)$/.test(args.trim())
}

/** Whether a command node is an internal, read-only rollback receipt. */
export function isInternalReadOnlyRollbackCommand(node: any): boolean {
  if (node?.kind !== 'command' || node.data?.name !== 'rollback') return false
  return isInternalReadOnlyRollbackArgs(node.data?.args)
}

export function isRollbackCommand(node: any): boolean {
  return node?.kind === 'command' && node.data?.name === 'rollback'
}

/** Whether command arguments are a supported read-only query, including user syntax. */
export function isReadOnlyRollbackArgs(args: unknown): boolean {
  return typeof args === 'string' && /^(?:state|list|diagnose|rescues|preview\s+[1-9]\d*)$/.test(args.trim())
}

/** Whether a command node is any read-only rollback query. */
export function isReadOnlyRollbackCommand(node: any): boolean {
  if (node?.kind !== 'command' || node.data?.name !== 'rollback') return false
  return isReadOnlyRollbackArgs(node.data?.args)
}

/** Signature of visible/manual history, excluding only exact internal read receipts. */
export function rollbackRefreshSignature(chat: {
  order?: readonly string[]
  nodes?: { get(key: string): any }
} | undefined): string {
  if (!Array.isArray(chat?.order) || typeof chat?.nodes?.get !== 'function') return 'unknown'
  const store = chat.nodes
  return JSON.stringify(chat.order.flatMap(key => {
    const node = store.get(key)
    if (node?.kind !== 'command') return [[key, node?.kind, node?.anchorSeq]]
    if (isInternalReadOnlyRollbackCommand(node)) return []
    const command = node.data
    const args = typeof command?.args === 'string' ? command.args.trim() : null
    return [[key, 'command', command?.name, args, command?.outcome?.kind, command?.outcome?.text]]
  }))
}

export function previewVersionOf(text: string | undefined): number | null {
  const match = typeof text === 'string' ? /^版本 (\d+)\s*$/m.exec(text) : null
  if (match === null) return null
  const version = Number(match[1])
  return Number.isSafeInteger(version) && version >= 0 ? version : null
}
