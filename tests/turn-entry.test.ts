import { describe, expect, it } from 'vitest'
import { footerEntryNeeded } from '../src/core/turn-entry.ts'

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