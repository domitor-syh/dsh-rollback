/**
 * Truncation planning: locate the surface range a rollback must shadow and build
 * the replacement `user/message` that takes its place.
 *
 * The harness rewrites model-visible history exactly this way for its own
 * compaction: append a `user/message` carrying a positional `replace` surface op
 * (`compaction-basic`'s `commitCompactionBody`). A rollback reuses that
 * primitive — only the replacement text differs — and that choice is what lets
 * the marker land IMMEDIATELY, from the `/rollback` command itself:
 *
 * - `user/message` is the one message-producing event the session invariant
 *   leaves unconstrained, so it may be appended BETWEEN turns, when no turn and
 *   no step is open. An empty-content `assistant/message` — which would be
 *   invisible to the model — is accepted only INSIDE an open step, so it cannot
 *   be written until the next turn opens, leaving the rollback visually absent
 *   (and undone by a page refresh) until then.
 * - It needs no step, so the compaction token meter stays satisfied without the
 *   plugin inventing a step number (which the sequential-step invariant rejects).
 *
 * The cost is that the model DOES see the replacement text. It is framed the way
 * the harness frames its own compaction checkpoint — explicit about what it is,
 * and instructing the model not to acknowledge it.
 *
 * `deriveEventMessage` projects a `user/message` VERBATIM, so nothing beyond
 * `content` may ride the message: everything the client needs is derived from
 * the event instead (the shadowed range from `surfaceOp`, and an emptied surface
 * from the nodes that surround the marker), and never becomes model input.
 *
 * Pure and DSH-free: callers pass a structural view of the session.
 *
 * @module @domitor-syh/dsh-rollback/core/truncation-plan
 */

/** Minimal structural view of one session event. */
export interface TruncationEvent {
  readonly type: string
  readonly seq: number
  readonly time?: number
  readonly data?: unknown
}

/** Minimal structural view of a session: its log and its model-visible surface. */
export interface SessionView {
  readonly events: readonly TruncationEvent[]
  readonly surface: { readonly nodes: readonly number[] }
}

/**
 * The model-facing text of the replacement checkpoint.
 *
 * Framed like the harness's own compaction checkpoint (`frameSummary`): it says
 * what it is and tells the model to continue from the messages that follow
 * without acknowledging it, so the model neither has to guess why an
 * unexplained user turn appeared nor act on it. The file sentence is the one
 * fact a rollback adds beyond compaction — the workspace was reverted too, so
 * the model must not keep reasoning about content its own edits had produced.
 *
 * Everything here is load-bearing, and nothing else is: the four facts are (1)
 * this is machine-generated, not something the user said, (2) the messages after
 * this point are gone, so stop reasoning about them, (3) the workspace files were
 * reverted with them, so their later edits are not on disk, and (4) continue from
 * what remains and do not mention the checkpoint. The marker stays in the model's
 * context for the REST OF THE SESSION — a later rollback replaces it, nothing else
 * removes it — so every word is paid on every subsequent request. That is why the
 * wording is this terse: it is roughly a third of the prose it replaced, with the
 * same four facts and no new ambiguity. `tests/truncation-plan.test.ts` pins a
 * character budget so it cannot quietly grow back.
 */
export const ROLLBACK_CHECKPOINT_TEXT =
  'Automated checkpoint: earlier messages removed, files restored to that point. Continue from what remains; don\'t mention this checkpoint.'

/**
 * Provenance stamped on the marker, so the client recognizes its own node.
 *
 * `kind: 'plugin'` is what the session validates (a `source.kind` must be a
 * non-empty string) and what the client's chat-node definition matches on.
 */
export const ROLLBACK_MARKER_SOURCE = { kind: 'plugin', plugin: 'rollback' } as const

/** The shadowed surface range plus the marker intent that replaces it. */
export interface TruncationMarkerPlan {
  /** Surface nodes the marker replaces, in surface order. */
  readonly shadowed: readonly number[]
  /**
   * Data for the replacement `user/message`. This IS the model-visible message,
   * projected verbatim — hence nothing else may be added to it.
   */
  readonly data: {
    readonly id: string
    readonly role: 'user'
    readonly source: typeof ROLLBACK_MARKER_SOURCE
    readonly content: readonly { readonly type: 'text'; readonly text: string }[]
  }
  /** Positional replacement covering exactly {@link shadowed}. */
  readonly surfaceOp: { readonly op: 'replace'; readonly start: number; readonly end: number }
  /** Provenance the session records beside this node. */
  readonly sourceEventSeqs: readonly number[]
}

/**
 * The seq of the `turn/start` that opens `turn`, or null when the log has none.
 *
 * The LAST match wins: a session damaged by an older plugin build can hold a
 * synthetic marker turn and the real turn under the same number, and the real
 * turn is the later of the two.
 */
export function turnStartSeqFor(view: SessionView, turn: number): number | null {
  let found: number | null = null
  for (const event of view.events) {
    if (event.type !== 'turn/start') continue
    const data = event.data as { turn?: unknown } | undefined
    if (data?.turn === turn) found = event.seq
  }
  return found
}

/**
 * Surface nodes at or after `fromTurn`'s opening boundary — the range a rollback
 * to before `fromTurn` must shadow. Empty when the turn never opened or the
 * surface holds nothing from it.
 *
 * The marker is appended in the same breath as this computation, so the live
 * surface IS the range: nothing can have been appended in between, which is why
 * no captured-range bookkeeping is needed.
 */
export function shadowedSurfaceFrom(view: SessionView, fromTurn: number): number[] {
  const boundary = turnStartSeqFor(view, fromTurn)
  if (boundary === null) return []
  const nodes = view.surface.nodes
  const startIdx = nodes.findIndex(seq => seq >= boundary)
  if (startIdx === -1) return []
  return [...nodes.slice(startIdx)]
}

/** Everything the marker needs beyond the session itself. */
export interface TruncationMarkerInput {
  /** Turn the rollback targeted: everything from it onward is shadowed. */
  readonly fromTurn: number
  /** Fresh message id for the marker node. */
  readonly messageId: string
}

/**
 * Build the replacement checkpoint for one rollback, or null when the surface
 * holds nothing to shadow (an earlier marker already covers the range).
 */
export function planTruncationMarker(
  view: SessionView,
  input: TruncationMarkerInput,
): TruncationMarkerPlan | null {
  const shadowed = shadowedSurfaceFrom(view, input.fromTurn)
  if (shadowed.length === 0) return null
  return {
    shadowed,
    data: {
      id: input.messageId,
      role: 'user',
      source: ROLLBACK_MARKER_SOURCE,
      content: [{ type: 'text', text: ROLLBACK_CHECKPOINT_TEXT }],
    },
    surfaceOp: { op: 'replace', start: shadowed[0]!, end: shadowed[shadowed.length - 1]! },
    sourceEventSeqs: [...shadowed],
  }
}