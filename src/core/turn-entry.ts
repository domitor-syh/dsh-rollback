/**
 * Where a turn's rollback entry can appear.
 *
 * The action normally rides DSH's assistant action strip, which the chat view builds
 * from the turn's CLOSING assistant message. A turn whose output was interrupted has
 * no such message — a frozen partial carries no messageId — so that strip contributes
 * no per-message actions at all and the button simply disappears, exactly when a user
 * who has just paused the model wants it.
 *
 * The turn footer, by contrast, exists for every turn that ENDED, interruption
 * included. So the footer entry renders ONLY when the strip cannot: one button per
 * turn, in the place the user already knows, and a second place only where the first
 * one cannot exist. Reporting that decision as a pure function keeps the rule honest
 * and testable rather than buried in a render path.
 *
 * @module @domitor-syh/dsh-rollback/core/turn-entry
 */

/** The closing assistant node a turn's footer data carries, when it has one. */
export interface ClosingAssistant {
  readonly finalNode?: { readonly messageId?: unknown }
}

/**
 * Whether the turn footer is the only place this turn's rollback entry can go.
 * @param closing - the turn's closing assistant node, or null/undefined without one.
 * @returns true when the assistant action strip cannot offer the entry.
 */
export function footerEntryNeeded(closing: ClosingAssistant | null | undefined): boolean {
  if (closing === null || closing === undefined) return true
  const messageId = closing.finalNode?.messageId
  return typeof messageId !== 'string' || messageId === ''
}

/** The seat every supported build declares the turn-footer extension under. */
export const TURN_TAIL_SLOT = 'conversation.chat.turnTail'

/**
 * Which registration spelling a build's turn-footer seat takes.
 *
 * The seat changed shape between supported builds and each one REFUSES the other
 * spelling by throwing at registration time: 0.2.0 declares it a `list` (an
 * `id`/`order` cell, rendered for every completed turn) and 0.1.5 declared it a
 * `chain` (a `select` election that picks the one turn to render).
 */
export type TurnTailShape = 'list' | 'chain'

/** The fields a turn-footer registration carries whatever the seat's spelling. */
export interface TurnTailFields {
  /** Cell key the list spelling requires; unused by the chain spelling. */
  readonly id: string
  /** Position among the entries; unused by the chain spelling. */
  readonly order: number
  /** Dictionary namespace. */
  readonly locale: string
  /** Election the chain spelling requires; unused by the list spelling. */
  readonly select: (owner: unknown) => unknown
}

/**
 * The registration options for one spelling of the turn-footer seat.
 *
 * Only the keys that spelling declares are emitted: the list form is rejected
 * without `id` and the chain form without `select`, and a chain entry's shape is
 * easy to get wrong in the other direction too — handing a list seat a `select`
 * is what left a silently empty row behind the last time.
 * @param shape - the spelling this build takes.
 * @param fields - every field the two spellings might need.
 * @returns the options object to hand `ctx.slots.register`.
 */
export function turnTailRegistration(
  shape: TurnTailShape,
  fields: TurnTailFields,
): Record<string, unknown> {
  return shape === 'list'
    ? { name: TURN_TAIL_SLOT, id: fields.id, order: fields.order, locale: fields.locale }
    : { name: TURN_TAIL_SLOT, select: fields.select, locale: fields.locale }
}

/**
 * The other spelling to retry with, after one was refused for its shape.
 * @param shape - the spelling that was refused.
 * @returns the spelling to try next.
 */
export function otherTurnTailShape(shape: TurnTailShape): TurnTailShape {
  return shape === 'list' ? 'chain' : 'list'
}

/**
 * Whether a turn-footer registration was refused because this build wants the
 * other spelling.
 *
 * The slot core names the seat and the option it is missing
 * (`list slot "conversation.chat.turnTail" requires options.id`), so the refusal is
 * recognised by both. Anything else — an undeclared seat, a duplicate cell — is a
 * real failure and must reach the caller rather than be papered over by a retry.
 * @param error - whatever `ctx.slots.register` threw.
 * @returns true when retrying with {@link otherTurnTailShape} is the right response.
 */
export function isTurnTailShapeRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  if (!message.includes(TURN_TAIL_SLOT)) return false
  return message.includes('requires options.id') || message.includes('requires options.select')
}