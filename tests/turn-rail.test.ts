import { describe, expect, it } from 'vitest'
import {
  turnFromAttribute,
  turnOfTurnLevelSeat,
  type ReadableElement,
} from '../src/core/turn-rail.ts'

/**
 * A two-line element stand-in. These readers only ever ask an element for its class,
 * one attribute, or a descendant, so a real DOM is not needed to test them — which is
 * the point: the fragile half of the transcript pass (which attribute a row publishes its
 * turn on) gets regression coverage in Node instead of only on a desktop.
 */
function el(
  attrs: Record<string, string>,
  options: { className?: string; descendants?: Record<string, ReadableElement> } = {},
): ReadableElement {
  return {
    className: options.className ?? '',
    getAttribute: (name: string) => attrs[name] ?? null,
    querySelector: (selector: string) => options.descendants?.[selector] ?? null,
  }
}

describe('turnFromAttribute', () => {
  it('reads a turn off a numeric attribute', () => {
    expect(turnFromAttribute('7')).toBe(7)
    expect(turnFromAttribute('0')).toBe(0)
  })

  it('treats an absent, empty or unreadable attribute as no turn', () => {
    // `Number('')` is 0, so an absent attribute must not become turn 0 — that would
    // silently anchor the boundary at the first turn of the session.
    expect(turnFromAttribute(null)).toBeNull()
    expect(turnFromAttribute(undefined)).toBeNull()
    expect(turnFromAttribute('')).toBeNull()
    expect(turnFromAttribute('   ')).toBeNull()
    expect(turnFromAttribute('7px')).toBeNull()
    expect(turnFromAttribute('turn 7')).toBeNull()
  })

  it('refuses values that are not a whole, non-negative turn', () => {
    expect(turnFromAttribute('-1')).toBeNull()
    expect(turnFromAttribute('2.5')).toBeNull()
    expect(turnFromAttribute('1e999')).toBeNull()
    for (const raw of ['1e2', '0x10', '+3', '03', '9007199254740992']) expect(turnFromAttribute(raw)).toBeNull()
  })
})

describe('turnOfTurnLevelSeat', () => {
  it('reads the turn off a tail element that carries it itself', () => {
    expect(turnOfTurnLevelSeat(el({ 'data-turn-tail': '4' }))).toBe(4)
  })

  it('reads the turn off a process row that carries it itself', () => {
    expect(turnOfTurnLevelSeat(el({ 'data-turn-process': '6' }))).toBe(6)
  })

  it('finds the turn inside the row, which is where the official views put it', () => {
    // `TurnProcessNodeView` renders the button INSIDE the flow row, and the flow row is
    // what this plugin hides — so the descendant lookup is the normal path, not the
    // fallback.
    expect(turnOfTurnLevelSeat(el({}, {
      descendants: { '[data-turn-process]': el({ 'data-turn-process': '9' }) },
    }))).toBe(9)
    expect(turnOfTurnLevelSeat(el({}, {
      descendants: { '[data-turn-tail]': el({ 'data-turn-tail': '11' }) },
    }))).toBe(11)
  })

  it('prefers the row own attribute, and answers null when nothing names a turn', () => {
    expect(turnOfTurnLevelSeat(el({ 'data-turn-tail': '3' }, {
      descendants: { '[data-turn-tail]': el({ 'data-turn-tail': '99' }) },
    }))).toBe(3)
    expect(turnOfTurnLevelSeat(el({ 'data-chat-flow-key': 'k' }))).toBeNull()
  })
})

describe('official row and group turn identity', () => {
  it.each(['user', 'assistant-step', 'turn-process', 'turn-tail'])('reads a %s row own official turn', kind => {
    expect(turnOfTurnLevelSeat(el({ 'data-chat-node-key': kind + '-6', 'data-chat-turn': '6',
      'data-chat-flow-key': JSON.stringify([kind + '-6', 'part']) }))).toBe(6)
  })

  it('prefers own official turn to legacy and descendant attributes', () => {
    expect(turnOfTurnLevelSeat(el({ 'data-chat-turn': '7', 'data-turn-tail': '3' }, {
      descendants: { '[data-turn-process]': el({ 'data-turn-process': '99' }) },
    }))).toBe(7)
    expect(turnOfTurnLevelSeat(el({ 'data-chat-turn': 'broken', 'data-turn-tail': '3' }))).toBeNull()
  })

  it('never assigns a group the first descendant turn', () => {
    const descendants = { '[data-turn-tail]': el({ 'data-turn-tail': '3' }) }
    expect(turnOfTurnLevelSeat(el({ 'data-chat-group-key': 'g' }, { descendants }))).toBeNull()
    expect(turnOfTurnLevelSeat(el({ 'data-chat-group-key': 'g', 'data-chat-turn': '8' }, { descendants }))).toBe(8)
  })
})
