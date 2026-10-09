/**
 * What a row publishes about its own turn, read from the DOM.
 *
 * This module used to also read the TURN LADDER on the right and hide the marks of
 * rolled-back turns. That is gone, by the user's decision (2026-10-04), and the reason is
 * worth keeping: the rail is a fixed-pitch list of absolutely positioned marks
 * (`TURN_SPACING_PX = 10`, `RAIL_INSET_PX = 6`, `dsh-client-ui-chat/lib/client.js`), so
 * hiding a mark leaves its SLOT empty — and a rollback of the last turns followed by a new
 * message leaves those empty slots standing between the surviving marks and the new one.
 * Closing them means re-positioning the component's own layout from outside, which the
 * component undoes on every re-render. The user was offered exactly that trade and chose
 * the honest one: the ladder is left alone, and the plugin's hiding stops at the
 * transcript, where rows are in normal flow and a hidden row moves its neighbours up
 * instead of leaving a hole.
 *
 * What remains is the reader a TRANSCRIPT pass needs: the turn a row belongs to. Everything
 * here is pure — element-shaped objects in, answers out — so the fragile half (which
 * attribute) is unit-tested in Node instead of only on a desktop.
 */

/**
 * What these readers need from an element.
 *
 * Deliberately structural, and deliberately not `HTMLElement`: a real element satisfies
 * it, and so does a two-line fake in a test.
 */
export interface ReadableElement {
  readonly className?: unknown
  getAttribute(name: string): string | null
  querySelector(selector: string): ReadableElement | null
}


/** The attribute a turn tail publishes its turn on (`TurnTailNodeView`). */
const TURN_TAIL_ATTR = 'data-turn-tail'

/** The attribute the process row's button publishes its turn on (`TurnProcessNodeView`). */
const TURN_PROCESS_ATTR = 'data-turn-process'

/**
 * A turn number carried in an attribute, or null when the attribute is absent or junk.
 *
 * `Number('')` is 0 and `Number('7px')` is NaN, so both ends are checked: an empty or
 * unreadable attribute must answer "no turn", never turn 0.
 * @param raw - the attribute value, as read.
 * @returns the turn, or null when there is no usable number.
 */
export function turnFromAttribute(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || !/^(0|[1-9]\d*)$/.test(raw.trim())) return null
  const turn = Number(raw.trim())
  return Number.isSafeInteger(turn) && turn >= 0 ? turn : null
}

/**
 * Read a seat's own official data-chat-turn first; a group never borrows a child turn.
 * Legacy tail/process attributes remain a fallback only for a node seat without the
 * official attribute. A malformed official attribute is unknown, not a fallback hint.
 */
export function turnOfTurnLevelSeat(el: ReadableElement): number | null {
  const official = el.getAttribute('data-chat-turn')
  if (official !== null) return turnFromAttribute(official)
  // A wrapper contains many nodes: a first descendant cannot establish its turn.
  if (el.getAttribute('data-chat-group-key') !== null) return null
  const own = el.getAttribute(TURN_TAIL_ATTR) ?? el.getAttribute(TURN_PROCESS_ATTR)
  if (own !== null) return turnFromAttribute(own)
  const nested = el.querySelector(`[${TURN_TAIL_ATTR}]`)?.getAttribute(TURN_TAIL_ATTR)
    ?? el.querySelector(`[${TURN_PROCESS_ATTR}]`)?.getAttribute(TURN_PROCESS_ATTR)
  return turnFromAttribute(nested)
}