import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { isInternalReadOnlyRollbackCommand, isReadOnlyRollbackArgs, isRevokedSeat, isRollbackCommand, seatIdentity } from '../src/client/rollback-state.ts'
import type { RollbackState } from '../src/core/rollback-boundary.ts'

// Like client-attachment-restore.test.ts, execute the actual browser implementation
// without loading UI packages or adding a DOM dependency. The DOM below implements
// only the standard tree/style/selector operations exercised by these two passes.
const source = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')
const start = source.indexOf('function isUiOnlyNode(')
const end = source.indexOf('/** Module-level bridge:', start)
if (start < 0 || end < 0) throw new Error('Client hero implementation extraction boundaries changed')
const compiled = ts.transpileModule(source.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText

class FakeStyle {
  private values = new Map<string, { value: string; priority: string }>()
  get display(): string { return this.getPropertyValue('display') }
  set display(value: string) { this.setProperty('display', value) }
  getPropertyValue(name: string): string { return this.values.get(name)?.value ?? '' }
  getPropertyPriority(name: string): string { return this.values.get(name)?.priority ?? '' }
  setProperty(name: string, value: string, priority = ''): void { this.values.set(name, { value, priority }) }
  removeProperty(name: string): string {
    const previous = this.getPropertyValue(name)
    this.values.delete(name)
    return previous
  }
}

class FakeElement {
  readonly style = new FakeStyle()
  readonly children: FakeElement[] = []
  readonly attributes = new Map<string, string>()
  parentElement: FakeElement | null = null
  className = ''
  constructor(attributes: Record<string, string> = {}) {
    for (const [name, value] of Object.entries(attributes)) this.setAttribute(name, value)
  }
  get parentNode(): FakeElement | null { return this.parentElement }
  get lastElementChild(): FakeElement | null { return this.children.at(-1) ?? null }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null }
  hasAttribute(name: string): boolean { return this.attributes.has(name) }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value) }
  removeAttribute(name: string): void { this.attributes.delete(name) }
  appendChild(child: FakeElement): FakeElement {
    child.remove()
    child.parentElement = this
    this.children.push(child)
    return child
  }
  remove(): void {
    if (this.parentElement === null) return
    const index = this.parentElement.children.indexOf(this)
    if (index >= 0) this.parentElement.children.splice(index, 1)
    this.parentElement = null
  }
  contains(other: FakeElement): boolean { return this === other || this.children.some(child => child.contains(other)) }
  matches(selector: string): boolean {
    return selector.split(',').some(part => {
      const match = /^\s*\[([\w-]+)(?:="([^"]*)")?\]\s*$/.exec(part)
      if (match === null) throw new Error(`Unsupported fake-DOM selector: ${selector}`)
      return this.hasAttribute(match[1]!) && (match[2] === undefined || this.getAttribute(match[1]!) === match[2])
    })
  }
  closest(selector: string): FakeElement | null {
    let element: FakeElement | null = this
    while (element !== null) {
      if (element.matches(selector)) return element
      element = element.parentElement
    }
    return null
  }
  querySelectorAll(selector: string): FakeElement[] {
    return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)])
  }
  querySelector(selector: string): FakeElement | null { return this.querySelectorAll(selector)[0] ?? null }
}

class FakeDocument {
  readonly body = new FakeElement()
  flowCandidates: FakeElement[] | undefined
  createElement(_tag: string): FakeElement { return new FakeElement() }
  querySelectorAll(selector: string): FakeElement[] {
    if (selector === '[data-chat-flow=""]' && this.flowCandidates !== undefined) return this.flowCandidates
    return this.body.querySelectorAll(selector)
  }
  querySelector(selector: string): FakeElement | null { return this.querySelectorAll(selector)[0] ?? null }
}

type NodeFixture = { kind: string; anchorSeq?: number; visibility?: 'visible' | 'hidden'; data?: Record<string, unknown> }
const state: RollbackState = { sessionId: 'hero-session', version: 40, turns: [1], ranges: [{ start: 1, end: 10 }] }
const user = (anchorSeq: number): NodeFixture => ({ kind: 'user', anchorSeq, visibility: 'visible', data: {} })
const receipt = (args: unknown, anchorSeq = 20): NodeFixture => ({
  kind: 'command', anchorSeq, visibility: 'visible',
  data: { kind: 'command', name: 'rollback', args, commandId: `command-${anchorSeq}`, outcome: { kind: 'success', text: 'ok' } },
})

function harness(entries: Array<[string, NodeFixture]> = [], withColumn = true) {
  const document = new FakeDocument()
  const column = withColumn ? document.body.appendChild(new FakeElement({ 'data-chat-flow': '' })) : null
  const functions = new Function('document', 'console', 'isInternalReadOnlyRollbackCommand', 'isReadOnlyRollbackArgs', 'isRevokedSeat', 'isRollbackCommand', 'seatIdentity',
    `${compiled}; return { syncHides, syncHeroHost, heroWanted };`)(document, { info: vi.fn() }, isInternalReadOnlyRollbackCommand, isReadOnlyRollbackArgs, isRevokedSeat, isRollbackCommand, seatIdentity) as {
      syncHides(chat: unknown, state: RollbackState | null): void
      syncHeroHost(ref: { current: FakeElement | null }, setOn: (value: boolean) => void): void
      heroWanted: { visible: boolean }
    }
  const chat = { order: entries.map(([key]) => key), nodes: new Map(entries) }
  const seat = (key: string, attrs: Record<string, string> = {}) => (column ?? document.body).appendChild(new FakeElement({ 'data-chat-node-key': key, ...attrs }))
  return { ...functions, document, column, chat, seat }
}

describe('actual client hero emptiness and host placement', () => {
  it('shows the full-rollback hero despite intentionally hidden internal and mutation receipts outside the revoked range', () => {
    const h = harness([
      ['old-user', user(2)], ['marker', { kind: 'rollback-marker', anchorSeq: 11, visibility: 'visible' }],
      ['internal-state', receipt('--internal state', 20)], ['internal-preview', receipt('--internal preview 1', 21)],
      ['internal-file', receipt('--internal file 1 historical-file', 22)], ['apply', receipt('--apply 1 30', 23)],
    ])
    const old = h.seat('old-user')
    const receipts = ['internal-state', 'internal-preview', 'internal-file', 'apply'].map(key => h.seat(key))
    h.syncHides(h.chat, state)
    expect(old.style.display).toBe('none')
    for (const el of receipts) expect(el.style.display).toBe('none')
    expect(h.heroWanted.visible).toBe(true)
    const ref = { current: null as FakeElement | null }
    const setOn = vi.fn()
    h.syncHeroHost(ref, setOn)
    expect(ref.current?.parentElement).toBe(h.column)
    expect(setOn).toHaveBeenLastCalledWith(true)
  })

  it('shows Hero with an empty marker DOM wrapper left by the official node router', () => {
    const h = harness([['old', user(2)], ['marker', { kind: 'rollback-marker', anchorSeq: 11, visibility: 'visible' }]])
    h.seat('old')
    const marker = h.seat('marker')
    h.syncHides(h.chat, state)
    expect(marker.style.display).toBe('')
    expect(h.heroWanted.visible).toBe(true)
  })

  it('ignores official non-rendering permission, system and ordinary context before the rollback cut', () => {
    const h = harness([
      ['permission', { kind: 'command', anchorSeq: 0, visibility: 'visible', data: { name: 'permission', args: 'danger-full-access' } }],
      ['context', { kind: 'context', anchorSeq: 0, visibility: 'visible', data: { content: [{ type: 'text', text: 'runtime facts' }] } }],
      ['system', { kind: 'system-prompt', anchorSeq: 0, visibility: 'visible' }],
      ['old', user(2)],
    ])
    h.seat('old')
    h.syncHides(h.chat, state)
    expect(h.heroWanted.visible).toBe(true)
  })

  it.each(['tool-addition', 'tool-removal'])('keeps visible context %s notices as standing content', type => {
    const h = harness([['old', user(2)], ['notice', { kind: 'context', anchorSeq: 12, visibility: 'visible', data: { content: [{ type }] } }]])
    h.seat('old')
    h.seat('notice')
    h.syncHides(h.chat, state)
    expect(h.heroWanted.visible).toBe(false)
  })

  it('does not infer a malformed context projection to be non-rendering', () => {
    const h = harness([['old', user(2)], ['unknown-context', { kind: 'context', anchorSeq: 12, visibility: 'visible', data: {} }]])
    h.seat('old')
    h.syncHides(h.chat, state)
    expect(h.heroWanted.visible).toBe(false)
  })

  it('ignores a known host-hidden projection without hiding a new DOM seat itself', () => {
    const h = harness([['old', user(2)], ['host-hidden', { kind: 'context', anchorSeq: 21, visibility: 'hidden', data: {} }]])
    h.seat('old')
    // The pinned renderer does not mount a visible seat for visibility:hidden.
    h.syncHides(h.chat, state)
    expect(h.heroWanted.visible).toBe(true)
  })

  it.each([['older retained user', 0], ['later new user', 12]] as const)('does not show hero over an %s', (_label, seq) => {
    const h = harness([['revoked', user(2)], ['standing', user(seq)]])
    h.seat('revoked')
    const standing = h.seat('standing')
    h.syncHides(h.chat, state)
    expect(standing.style.display).toBe('')
    expect(h.heroWanted.visible).toBe(false)
  })

  it('keeps a user-visible manual read-only rollback receipt as standing content', () => {
    const h = harness([['revoked', user(2)], ['manual-list', receipt('list')]])
    h.seat('revoked')
    const manual = h.seat('manual-list')
    h.syncHides(h.chat, state)
    expect(manual.style.display).toBe('')
    expect(h.heroWanted.visible).toBe(false)
  })

  it.each(['unknown-renderer', 'missing-node'] as const)('does not infer empty content from %s', kind => {
    const h = harness([['revoked', user(2)]])
    h.seat('revoked')
    h.chat.order.push('unknown')
    if (kind === 'unknown-renderer') h.chat.nodes.set('unknown', { kind: 'future-renderer', visibility: 'visible' })
    h.syncHides(h.chat, state)
    expect(h.heroWanted.visible).toBe(false)
  })

  it('accepts an empty readable order with valid nonempty rollback ranges', () => {
    const h = harness()
    h.syncHides(h.chat, state)
    expect(h.heroWanted.visible).toBe(true)
  })

  it('does not use an empty order as evidence when rollback state or ranges are absent', () => {
    const h = harness()
    h.syncHides(h.chat, null)
    expect(h.heroWanted.visible).toBe(false)
    h.syncHides(h.chat, { ...state, ranges: [], turns: [] })
    expect(h.heroWanted.visible).toBe(false)
  })

  it('does not cover an unknown standing DOM seat even if the readable order is empty', () => {
    const h = harness()
    const seat = h.seat('not-in-store')
    h.syncHides(h.chat, state)
    expect(seat.style.display).toBe('')
    expect(h.heroWanted.visible).toBe(false)
  })

  it('selects the outermost chat flow, never the nested flow inside a hidden process group', () => {
    const h = harness()
    const group = h.column!.appendChild(new FakeElement({ 'data-chat-group-key': 'process-1', 'data-chat-turn': '1', 'data-step-process': '' }))
    group.setAttribute('data-rbk-hidden', '')
    group.style.display = 'none'
    const nested = group.appendChild(new FakeElement({ 'data-chat-flow': '', 'data-step-process-content': '' }))
    // Adversarial enumeration: make ancestor-selection necessary independently of
    // querySelector's usual root-before-descendant document order.
    h.document.flowCandidates = [nested, h.column!]
    h.heroWanted.visible = true
    const ref = { current: null as FakeElement | null }
    const setOn = vi.fn()
    h.syncHeroHost(ref, setOn)
    expect(ref.current?.parentElement).toBe(h.column)
    expect(nested.children).toHaveLength(0)
    expect(setOn).toHaveBeenLastCalledWith(true)
  })

  it('disables safely without creating a host if no chat column is mounted', () => {
    const h = harness([], false)
    h.heroWanted.visible = true
    const ref = { current: null as FakeElement | null }
    const setOn = vi.fn()
    expect(() => h.syncHeroHost(ref, setOn)).not.toThrow()
    expect(ref.current).toBeNull()
    expect(h.document.body.children).toEqual([])
    expect(setOn).toHaveBeenLastCalledWith(false)
  })

  it('removes its owned host as soon as hero turns off, leaving existing seats intact', () => {
    const h = harness()
    const existing = h.seat('existing')
    const ref = { current: null as FakeElement | null }
    const setOn = vi.fn()
    h.heroWanted.visible = true
    h.syncHeroHost(ref, setOn)
    const host = ref.current!
    expect(host.getAttribute('data-rbk-hero-host')).toBe('true')
    h.heroWanted.visible = false
    h.syncHeroHost(ref, setOn)
    expect(ref.current).toBeNull()
    expect(h.document.body.contains(host)).toBe(false)
    expect(h.column!.children).toEqual([existing])
    expect(setOn).toHaveBeenLastCalledWith(false)
  })

  it('reuses the owned host and keeps it last when React appends another child', () => {
    const h = harness()
    const ref = { current: null as FakeElement | null }
    h.heroWanted.visible = true
    h.syncHeroHost(ref, () => {})
    const host = ref.current!
    const later = h.column!.appendChild(new FakeElement())
    h.syncHeroHost(ref, () => {})
    expect(ref.current).toBe(host)
    expect(h.column!.children).toEqual([later, host])
  })
})
