import { describe, expect, it } from 'vitest'
import {
  footerEntryNeeded,
  isTurnTailShapeRejection,
  otherTurnTailShape,
  TURN_TAIL_SLOT,
  turnTailRegistration,
  type TurnTailFields,
} from '../src/core/turn-entry.ts'

describe('footerEntryNeeded', () => {
  it('is needed when the turn has no closing assistant message', () => {
    // The interrupted case: the assistant action strip is built from that message, so
    // without one it offers no actions and the footer is the only place left.
    expect(footerEntryNeeded(null)).toBe(true)
    expect(footerEntryNeeded(undefined)).toBe(true)
  })

  it('is needed when the closing message addresses no durable message', () => {
    // A frozen partial can exist without a messageId, and the strip skips per-message
    // actions for exactly that case — the chat view says so in its own comment.
    expect(footerEntryNeeded({ finalNode: {} })).toBe(true)
    expect(footerEntryNeeded({ finalNode: { messageId: undefined } })).toBe(true)
    expect(footerEntryNeeded({ finalNode: { messageId: '' } })).toBe(true)
  })

  it('is not needed when the strip can show the button itself', () => {
    // One button per turn, in the place the user already knows.
    expect(footerEntryNeeded({ finalNode: { messageId: 'm-1' } })).toBe(false)
  })
})

/** Every field the two spellings might need, so each test varies one at a time. */
const FIELDS: TurnTailFields = {
  id: 'rollback',
  order: 20,
  locale: 'rollback',
  select: () => null,
}

describe('turnTailRegistration', () => {
  it('spells the LIST form for 0.2.0 and drops the chain-only select', () => {
    // 0.2.0's slot core: `list slot "…" requires options.id`, and an entry that
    // also carried `select` is the shape that silently produced an empty row.
    expect(turnTailRegistration('list', FIELDS)).toEqual({
      name: TURN_TAIL_SLOT,
      id: 'rollback',
      order: 20,
      locale: 'rollback',
    })
  })

  it('spells the CHAIN form for 0.1.5 and drops the list-only id and order', () => {
    // 0.1.5's slot core: `chain slot "…" requires options.select`.
    expect(turnTailRegistration('chain', FIELDS)).toEqual({
      name: TURN_TAIL_SLOT,
      select: FIELDS.select,
      locale: 'rollback',
    })
  })

  it('names the seat both builds declare', () => {
    expect(turnTailRegistration('list', FIELDS).name).toBe('conversation.chat.turnTail')
    expect(turnTailRegistration('chain', FIELDS).name).toBe('conversation.chat.turnTail')
  })
})

describe('otherTurnTailShape', () => {
  it('flips between exactly the two spellings the retry may use', () => {
    expect(otherTurnTailShape('list')).toBe('chain')
    expect(otherTurnTailShape('chain')).toBe('list')
    expect(otherTurnTailShape(otherTurnTailShape('list'))).toBe('list')
  })
})

describe('isTurnTailShapeRejection', () => {
  it('recognises each build naming the option its own spelling requires', () => {
    // The exact refusals from dsh-client-ui-slots/lib/index.js:182 and :188.
    expect(isTurnTailShapeRejection(
      new Error(`list slot "${TURN_TAIL_SLOT}" requires options.id`),
    )).toBe(true)
    expect(isTurnTailShapeRejection(
      new Error(`chain slot "${TURN_TAIL_SLOT}" requires options.select`),
    )).toBe(true)
  })

  it('does not claim a refusal about another seat', () => {
    expect(isTurnTailShapeRejection(
      new Error('list slot "conversation.input.dock" requires options.id'),
    )).toBe(false)
  })

  it('does not claim a real failure of this seat', () => {
    // Both of these must reach the caller: retrying would either fail again or,
    // worse, look like success while the seat stays empty.
    expect(isTurnTailShapeRejection(
      new Error(`slot "${TURN_TAIL_SLOT}" is not declared (a parent entry's children table must declare it)`),
    )).toBe(false)
    expect(isTurnTailShapeRejection(
      new Error(`list slot "${TURN_TAIL_SLOT}" already has an entry with id "rollback"`),
    )).toBe(false)
  })

  it('survives a non-Error throw', () => {
    expect(isTurnTailShapeRejection(`list slot "${TURN_TAIL_SLOT}" requires options.id`)).toBe(true)
    expect(isTurnTailShapeRejection(null)).toBe(false)
    expect(isTurnTailShapeRejection(undefined)).toBe(false)
  })
})