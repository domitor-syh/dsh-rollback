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