/**
 * Truncation planning: locate the surface range a rollback must shadow and build
 * the intent of the marker event that replaces it.
 *
 * The marker is an EMPTY-content `assistant/message` carrying a positional
 * `replace` surface op. `deriveMessages` projects an empty assistant message to
 * null, so the rolled-back range leaves the model's history with nothing in its
 * place — no note, no empty user turn; the model simply stops remembering the
 * rolled-back turns, and nothing extra is ever sent to the provider.
 *
 * DSH only accepts that event inside an OPEN step, so the host opens a
 * plugin-owned step for it at the `agent/pre-step` boundary, before the next
 * request is derived (see `RollbackService.applyPendingTruncation`). It does not
 * invent a TURN: the plugin and the agent loop each track "the next turn number"
 * independently, so the next real turn would reuse the marker's number — two
 * `turn/start` events with one number, which the Web client refuses to rebuild a
 * conversation from ("… received more than one start Match").
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

/** The shadowed surface range plus the marker intent that replaces it. */
export interface TruncationMarkerPlan {
  /** Surface nodes the marker replaces, in surface order. */
  readonly shadowed: readonly number[]
  /**
   * Data for the replacement `assistant/message`: an **empty-content** assistant
   * message, which `deriveMessages` projects to null, so the rolled-back range
   * leaves the model's history with NOTHING in its place — no note, no empty
   * user turn, nothing that ever reaches the provider.
   *
   * DSH accepts such a message only inside an OPEN step, so the host opens a
   * plugin-owned step for it right before the next request is derived (the same
   * shape DSH itself writes for a usage-only max-tokens step). It does NOT invent
   * a turn: the plugin and the agent loop each track "the next turn number"
   * independently, so a synthetic turn makes them collide — two `turn/start`
   * events with one number, which the Web client refuses to rebuild a
   * conversation from ("… received more than one start Match").
   */
  readonly data: {
    readonly turn: number
    readonly step: number
    readonly message: Record<string, unknown>
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
 */
export function shadowedSurfaceFrom(view: SessionView, fromTurn: number): number[] {
  const boundary = turnStartSeqFor(view, fromTurn)
  if (boundary === null) return []
  const nodes = view.surface.nodes
  const startIdx = nodes.findIndex(seq => seq >= boundary)
  if (startIdx === -1) return []
  return [...nodes.slice(startIdx)]
}

/**
 * Whether the surface holds ANY node before `fromSeq` that still derives real
 * content — i.e. something other than a rollback marker. An emptying rollback is
 * one where everything before the truncation point is markers (or nothing), so
 * the model conversation becomes empty even though prior markers remain as
 * surface nodes.
 */
export function hasRealSurfaceBefore(view: SessionView, fromSeq: number): boolean {
  for (const seq of view.surface.nodes) {
    if (seq >= fromSeq) break
    const event = view.events[seq]
    if (event === undefined) continue
    if (event.type === 'assistant/message') {
      const message = (event.data as { message?: { content?: readonly unknown[] } } | undefined)?.message
      if (message?.content?.length === 0) continue // empty legacy marker — derives nothing
    }
    if (event.type === 'user/message' && isRollbackMarkerMessage(event.data)) continue // current marker
    return true
  }
  return false
}

/** Whether one message payload carries this plugin's rollback marker facts. */
function isRollbackMarkerMessage(data: unknown): boolean {
  if (data === null || typeof data !== 'object') return false
  const message = data as { rollback?: unknown; source?: { kind?: unknown; plugin?: unknown } }
  return message.rollback !== undefined
    || (message.source?.kind === 'plugin' && message.source.plugin === 'rollback')
}

/** Everything the marker needs beyond the session itself. */
export interface TruncationMarkerInput {
  /** Turn the rollback targeted: everything from it onward is shadowed. */
  readonly fromTurn: number
  /**
   * The shadowed range captured when the rollback ran. The marker is appended
   * later (at the next `agent/pre-step`), and everything the session appends in
   * between — context injections and the user's own next prompt — must stay OUT
   * of the range, so the range is bounded by these two seqs. Omitted only for
   * records written before the range was captured; the range is then derived
   * from `fromTurn`.
   */
  readonly shadowedFirst?: number
  /** Last shadowed surface seq captured when the rollback ran. */
  readonly shadowedLast?: number
  /**
   * Epoch ms the rollback ran. Used only by the fallback range for records
   * written before the range was captured.
   */
  readonly capturedAt?: number
  /** Turn of the plugin-owned step that hosts the marker. */
  readonly turn: number
  /** Step number of that plugin-owned step (never a step the agent loop opens). */
  readonly step: number
  /** Fresh message id for the marker node. */
  readonly messageId: string
  readonly restoredCount: number
  readonly deletedCount: number
  readonly skippedCount?: number
}

/**
 * Surface nodes inside `[first, last]`, in surface order.
 *
 * This is the live form of a captured shadowed range: nodes a later compaction
 * (or an earlier rollback) already removed simply drop out, and the range's ends
 * shrink to the surviving nodes so the replacement stays legal.
 */
export function surfaceNodesWithin(view: SessionView, first: number, last: number): number[] {
  return view.surface.nodes.filter(seq => seq >= first && seq <= last)
}

/**
 * Fallback range for a pending record written before the range was captured: the
 * surface nodes from `fromTurn`'s opening boundary that already existed when the
 * rollback ran (`capturedAt`), so turns the user started AFTER the rollback stay
 * out of the truncation. Without a timestamp the whole range from `fromTurn` is
 * returned, which is only correct when nothing was appended in between.
 */
export function capturedRangeFromTurn(view: SessionView, fromTurn: number, capturedAt?: number): number[] {
  const nodes = shadowedSurfaceFrom(view, fromTurn)
  if (capturedAt === undefined) return nodes
  return nodes.filter((seq) => {
    const time = view.events[seq]?.time
    // An event without a timestamp cannot be ordered; keep it in the range, which
    // is the truncating (feature-preserving) side of the choice.
    return typeof time !== 'number' || time <= capturedAt
  })
}

/**
 * Build the marker intent for one rollback, or null when the surface no longer
 * holds anything to shadow (an earlier marker already covers the range).
 */
export function planTruncationMarker(
  view: SessionView,
  input: TruncationMarkerInput,
): TruncationMarkerPlan | null {
  const shadowed = input.shadowedFirst !== undefined && input.shadowedLast !== undefined
    ? surfaceNodesWithin(view, input.shadowedFirst, input.shadowedLast)
    : capturedRangeFromTurn(view, input.fromTurn, input.capturedAt)
  if (shadowed.length === 0) return null
  const first = shadowed[0]!
  const last = shadowed[shadowed.length - 1]!
  return {
    shadowed,
    data: {
      turn: input.turn,
      step: input.step,
      message: {
        id: input.messageId,
        role: 'assistant',
        // Plugin provenance: this node exists only to carry the rollback facts
        // for the client's hide pass, and it derives to null for the model.
        source: { kind: 'plugin', plugin: 'rollback' },
        content: [],
        rollback: {
          fromTurn: input.fromTurn,
          truncatedFromSeq: first,
          restoredCount: input.restoredCount,
          deletedCount: input.deletedCount,
          skippedCount: input.skippedCount ?? 0,
          // Emptying the whole surface (not "turn 1") drives the client's
          // load-more suppression, since turn numbers never reset.
          emptied: !hasRealSurfaceBefore(view, first),
        },
      },
    },
    surfaceOp: { op: 'replace', start: first, end: last },
    sourceEventSeqs: [...shadowed],
  }
}

/**
 * Whether the log already holds a rollback marker for `fromTurn`.
 *
 * A pending truncation is dropped once its marker is appended, but the process
 * can die in between (or the pending sidecar can survive a failed cleanup).
 * Re-appending it would shadow the turns that legitimately followed the marker,
 * so the host checks this first. Both marker generations are recognized: the
 * current `user/message` replacement and the empty-`assistant/message` marker
 * written by plugin builds up to 0.1.0.
 */
export function hasRollbackMarker(events: readonly TruncationEvent[], fromTurn: number): boolean {
  for (const event of events) {
    if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
    const rollback = (event.data as { message?: { rollback?: { fromTurn?: unknown } } } | undefined)
      ?.message?.rollback ?? (event.data as { rollback?: { fromTurn?: unknown } } | undefined)?.rollback
    if (rollback?.fromTurn === fromTurn) return true
  }
  return false
}