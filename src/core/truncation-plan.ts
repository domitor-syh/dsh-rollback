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
 * The marker's range leaves this module as plain seqs and is SPELLED at the
 * framework boundary: 0.1.5 renamed that op's two ends to `startSeq`/`endSeq` and
 * validates the key set exactly, so a plan carrying the old names cannot be
 * appended at all. {@link withReplaceSurfaceOpFallback} owns the choice.
 *
 * One further rule shapes WHERE the range may start: 0.1.5 protects SURFACE NODE 0.
 * A `replace` whose shadowed range begins at that node is refused — "surface
 * replace: node 0 holds the system prompt and may be rewritten only by a
 * system/message over exactly that node" (`dsh-session/lib/index.js:379-383`) —
 * and the harness appends the system prompt INSIDE the first turn's own step
 * (`dsh-agent-loop/lib/index.js:1023`, after `turn/start`), so the system-prompt
 * node is surface node 0 while its seq sits inside turn 1's range. A rollback of
 * turn 1 therefore used to hand the framework a range starting at node 0 and be
 * rejected wholesale — with every file already restored. The range never includes
 * that node: {@link systemPromptNodeSeq} identifies it and
 * {@link shadowedSurfaceFrom} starts one node later, which keeps the system prompt
 * in the model's history (it is the one node the session must never lose).
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
 * unexplained user turn appeared nor act on it. Only tracked restorable file
 * contents are reverted; unobserved workspace changes and file metadata are not.
 * The model must not keep reasoning about edits removed from that tracked set.
 *
 * Keep the notice short: it remains model-visible until another replacement
 * shadows it, and every word is paid on subsequent requests. The test pins both
 * the character budget and the tracked-content qualification.
 */
export const ROLLBACK_CHECKPOINT_TEXT =
  'Automated checkpoint: later messages removed; tracked file contents restored. Continue from what remains; don\'t mention this checkpoint.'

/**
 * Provenance stamped on the marker, so the framework and the client both
 * recognize this plugin's own node.
 *
 * The kind must be **producer-owned**. DSH 0.2.0's session format v4 refuses the
 * retired `kind: 'plugin'` wrapper outright — `format v4 message requires a
 * producer-owned source kind` (`dsh-session-format-v3-to-v4/lib/index.js:126`) —
 * and the refusal lands on the marker's own event, which makes every later turn
 * in that session fail. Writing the accepted spelling is also exactly what the
 * framework's own v3→v4 migration lifts a released wrapper INTO
 * (`plugin:<plugin>`, `:87-106`), so a marker written here and a marker carried
 * over from an older log end up identical.
 *
 * The legacy wrapper stays RECOGNIZED on read (see
 * {@link isRollbackMarkerSource}): sessions written before this fix hold it, and
 * the framework itself rewrites it to this shape when it migrates them.
 */
export const ROLLBACK_MARKER_SOURCE = { kind: 'plugin:rollback' } as const

/** This plugin's name, as the marker's provenance records it. */
export const ROLLBACK_PLUGIN = 'rollback'

/** The producer-owned source kind format v4 admits. */
export const ROLLBACK_MARKER_KIND = `plugin:${ROLLBACK_PLUGIN}`

/**
 * Whether a message source is a rollback marker, in either spelling.
 *
 * Two spellings exist because the framework changed the rule: `<= 0.1.5` stored
 * the released `{ kind: 'plugin', plugin: 'rollback' }` wrapper, and v4 requires
 * `{ kind: 'plugin:rollback' }`. A session can hold both — an old log migrated
 * forward holds the new one, and one written by a pre-fix build holds the old —
 * so recognition must accept either, while WRITING only ever emits the new one.
 * @param source - the message source to identify.
 * @returns true when this plugin produced the message.
 */
export function isRollbackMarkerSource(source: unknown): boolean {
  if (source === null || typeof source !== 'object') return false
  const candidate = source as { kind?: unknown; plugin?: unknown }
  if (candidate.kind === ROLLBACK_MARKER_KIND) return true
  return candidate.kind === 'plugin' && candidate.plugin === ROLLBACK_PLUGIN
}

/** An inclusive surface seq range, as plain numbers — no framework field names. */
export interface MarkerRange {
  readonly start: number
  readonly end: number
}

/**
 * One spelling of the positional `replace` surface op a rollback marker carries.
 *
 * The two arms are the two builds' spellings, deliberately NOT collapsed: the
 * framework validates the op by its EXACT key set, so an op carrying both pairs
 * is as invalid as one carrying neither.
 */
export type ReplaceSurfaceOp =
  | { readonly op: 'replace'; readonly startSeq: number; readonly endSeq: number }
  | { readonly op: 'replace'; readonly start: number; readonly end: number }

/**
 * Both accepted spellings of one positional `replace`, newest framework first.
 *
 * DSH 0.1.5 renamed the range's two ends — `{ start, end }` (<=0.1.1) became
 * `{ startSeq, endSeq }` — and `isReplaceOp` requires EXACTLY the three keys
 * `op`/`startSeq`/`endSeq` (`dsh-session/lib/index.js:262-264`), so the older
 * spelling is now rejected outright with `carries an invalid replace surfaceOp`
 * (`:279`). The modern spelling is therefore offered first: on 0.1.5 — the build
 * this plugin must work on — the first attempt is the one that lands, and no
 * error is raised at all. The legacy spelling stays as the fallback for an older
 * host, which is why the plugin does not simply rename the fields.
 * @param range - the inclusive surface range the marker replaces.
 * @returns the modern spelling, then the legacy one.
 */
export function replaceSurfaceOpCandidates(range: MarkerRange): readonly ReplaceSurfaceOp[] {
  return [
    { op: 'replace', startSeq: range.start, endSeq: range.end },
    { op: 'replace', start: range.start, end: range.end },
  ]
}

/**
 * Whether a failed append is the framework rejecting the SHAPE of a replace
 * surface op, rather than a real defect in the replacement itself.
 *
 * This is the gate on the one retry {@link withReplaceSurfaceOpFallback} makes,
 * so it must match a shape complaint about the op and nothing else. Every
 * message the installed build raises about the op's shape names the field
 * (`… carries an invalid replace surfaceOp`, `… carries an invalid surfaceOp`),
 * while the failures that must NOT trigger a retry never pair "invalid" with
 * "surfaceOp" — `surface replace: start seq 5 not found in surface`,
 * `sourceEventSeqs must include every shadowed surface node; missing 5`, and
 * `… is surface-eligible and requires a surfaceOp marker` all fail this test.
 * Matching on those two words rather than on one build's exact sentence keeps
 * the fallback working on a host whose wording drifted.
 * @param error - the value an append threw.
 * @returns true when the op's field spelling is what was refused.
 */
function isReplaceOpShapeRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /invalid[\s\S]*surfaceOp/i.test(message)
}

/**
 * Run one marker append, writing the surface-op spelling the installed build accepts.
 *
 * The preferred (0.1.5) spelling is attempted first and, ONLY when the framework
 * rejects that op's shape, the legacy spelling is attempted once. The retry is
 * safe because a rejected append persists nothing: `Session.append` validates
 * synchronously through `SurfaceManager.validateNext` BEFORE `this.log.push(event)`
 * (`dsh-session/lib/index.js:1190` then `:1200`), and the `session/event`
 * observers persistence buffers from fire only after that push (`:1202`, e.g.
 * `dsh-session-persistence-jsonl/lib/index.js:407`). A failed attempt therefore
 * leaves the log — and the durable file — untouched, so exactly one of the two
 * attempts can ever commit. The retry is also deliberately NOT offered on any
 * other failure: a genuine problem (a shadowed node missing from the surface, an
 * incomplete `sourceEventSeqs`) fails the same way in both spellings, and
 * retrying would only replace a precise diagnostic with a second, vaguer one.
 *
 * The field-name union is narrowed with a single cast at the framework boundary
 * in `service.ts`; this function stays pure, so the strategy itself is testable.
 * @param range - the inclusive surface range the marker replaces.
 * @param attempt - performs the append with one candidate spelling.
 * @returns whatever `attempt` returned for the spelling that landed.
 * @throws the first attempt's error when it was not a shape rejection, otherwise
 *   the second attempt's error — the real one, since the shape is then accepted.
 */
export function withReplaceSurfaceOpFallback<T>(
  range: MarkerRange,
  attempt: (surfaceOp: ReplaceSurfaceOp) => T,
): T {
  const [preferred, legacy] = replaceSurfaceOpCandidates(range) as readonly [ReplaceSurfaceOp, ReplaceSurfaceOp]
  try {
    return attempt(preferred)
  } catch (error) {
    if (!isReplaceOpShapeRejection(error)) throw error
    return attempt(legacy)
  }
}

/** The shadowed surface range plus the marker intent that replaces it. */
export interface TruncationMarkerPlan {
  /** Surface nodes the marker replaces, in surface order; empty when nothing is replaced. */
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
  /**
   * The inclusive surface range covering exactly {@link shadowed}, or null when the
   * marker must be appended WITHOUT a replacement.
   *
   * Kept as plain seqs rather than as a ready-made `surfaceOp`: the object's
   * field names are the INSTALLED build's business (see
   * {@link replaceSurfaceOpCandidates}), and a plan that baked in one build's
   * spelling is what broke on 0.1.5.
   *
   * Null is the degenerate outcome of the system-prompt clamp: the range held
   * nothing but the protected node, so there is no `replace` to spell — an empty
   * one has no meaning at the framework (`replacementRange` demands both ends be
   * current surface nodes, `dsh-session/lib/index.js:316-327`) and a
   * surface-eligible event with no `surfaceOp` at all is refused outright
   * (`:276`). The caller appends the marker as a plain surface append instead: the
   * checkpoint text still reaches the model, nothing is hidden, and the system
   * prompt — being outside the range — stays visible, which is correct.
   */
  readonly range: MarkerRange | null
  /** Provenance the session records beside this node; empty when nothing is replaced. */
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

/** The type of the event stored at one seq, or null when the view's log lacks it. */
function eventTypeAtSeq(view: SessionView, seq: number): string | null {
  for (const event of view.events) if (event.seq === seq) return event.type
  return null
}

/**
 * Whether one seq sits inside `turn`'s own span: at or after its `turn/start`, and
 * before the next turn's.
 *
 * This is the test that separates "a node of the turn being rolled back" from "a node
 * that merely comes later in the surface", and the difference is not cosmetic — it is
 * the whole of the 2026-10-03 defect. See {@link alreadyShadowed}.
 */
function seqInsideTurn(view: SessionView, turn: number, seq: number): boolean {
  const start = turnStartSeqFor(view, turn)
  if (start === null) return false
  if (seq < start) return false
  // The turn's OWN closing event bounds it, and this bound is what makes the test
  // correct rather than merely plausible: the checkpoint a previous rollback appended
  // lands AFTER the rolled-back turn's `turn/end`, so a span that ran to the next
  // turn's start would call that marker a node of the turn — which is exactly the
  // reading that produced `{ startSeq: 60, endSeq: 60 }` on the desktop. The last
  // `turn/end` wins, for the same reason the last `turn/start` does.
  let closing: number | null = null
  for (const event of view.events) {
    if (event.type !== 'turn/end') continue
    if ((event.data as { turn?: unknown } | undefined)?.turn !== turn) continue
    closing = event.seq
  }
  if (closing !== null) return seq <= closing
  // A turn that never closed (interrupted before it could) is bounded by the next one.
  for (const event of view.events) {
    if (event.type !== 'turn/start') continue
    if (event.seq > start && event.seq <= seq) return false
  }
  return true
}

/**
 * Whether the target turn's model-visible output is ALREADY shadowed — that is, the
 * turn was rolled back before.
 *
 * Measured on the desktop (2026-10-03), this is what four rollbacks of one turn did:
 * the first shadowed the turn correctly; the three after it each found the turn gone
 * from the SURFACE but still present in the LOG, so the range search below started at
 * the first surface node at or after the turn's boundary — which was the PREVIOUS
 * MARKER. The framework replaces what a range covers, so each of those rollbacks
 * destroyed the marker before it, and with it the window that was hiding the turn:
 * rolling back again REVEALED what the last rollback had hidden, wrote a marker whose
 * range was a single seq (`[60,60]`, `[75,75]`, `[93,93]` in the log), and reported
 * "已回退…已截断对话" while changing nothing the user could see.
 *
 * The turn's own boundary is read from the log, which still holds it, so presence in
 * the log is not evidence of presence in the surface: what decides is whether the
 * surface node the range would START at belongs to this turn. When it does not, there
 * is nothing of this turn left to shadow.
 * @param view - the session view.
 * @param fromTurn - the turn the rollback targeted.
 * @returns whether the turn's output is already gone from the model-visible surface.
 */
export function alreadyShadowed(view: SessionView, fromTurn: number): boolean {
  const boundary = turnStartSeqFor(view, fromTurn)
  if (boundary === null) return false
  const head = view.surface.nodes.find(seq => seq >= boundary)
  if (head === undefined) return false
  return !seqInsideTurn(view, fromTurn, head)
}

/**
 * The user-facing refusal for a rollback whose target turn is already shadowed, or null
 * when the rollback may proceed.
 *
 * Colocated with {@link alreadyShadowed} rather than with the other refusals because it
 * is the only one that has to read the session view; the wording stays in the style of
 * `rollback-guard.ts`: what is wrong, and what the user can do instead. Nothing is
 * offered as a remedy here on purpose — "roll back an earlier turn" is what the picker
 * already offers, and an already-shadowed turn is simply not a target.
 * @param view - the session view.
 * @param fromTurn - the turn the rollback targeted.
 * @returns the refusal text, or null when the rollback may proceed.
 */
export function rolledBackAlready(view: SessionView, fromTurn: number): string | null {
  if (!alreadyShadowed(view, fromTurn)) return null
  return `第 ${fromTurn} 轮已经在回退点之前（该轮已被回退过），再回退一次不会改变任何东西，因此没有执行。`
}

/**
 * The surface seq of the system-prompt node a rollback must never shadow, or null
 * when node 0 holds something else.
 *
 * 0.1.5's rule is positional: it protects surface NODE 0 and only when the event
 * recorded there is a `system/message` (`dsh-session/lib/index.js:379-381` — the
 * same check the browser replays through `dsh-client-connection/lib/client.js:1952-1955`).
 * Later `system/message` nodes carry no protection at all ("later system nodes
 * carry no protection and a compaction range may shadow them"), so this answers
 * for index 0 and nothing else, and it answers by type — not by a hard-coded seq
 * — because the harness appends the system prompt from inside the first turn's own
 * step (`dsh-agent-loop/lib/index.js:1023`), each build and each resumed session
 * giving it whatever seq that step reached.
 *
 * A node whose event cannot be read is NOT reported as the system prompt: the
 * framework makes the same lookup against the same log and also declines to
 * protect it, so the two agree on what may be replaced.
 * @param view - the session view, whose surface and log are addressed by seq.
 * @returns the protected node's seq, or null when there is none.
 */
export function systemPromptNodeSeq(view: SessionView): number | null {
  const head = view.surface.nodes[0]
  if (head === undefined) return null
  return eventTypeAtSeq(view, head) === 'system/message' ? head : null
}

/**
 * Surface nodes at or after `fromTurn`'s opening boundary, BEFORE the
 * system-prompt protection is applied — the range an unprotected build would take.
 */
function boundarySurfaceFrom(view: SessionView, fromTurn: number): number[] {
  const boundary = turnStartSeqFor(view, fromTurn)
  if (boundary === null) return []
  const nodes = view.surface.nodes
  const startIdx = nodes.findIndex(seq => seq >= boundary)
  if (startIdx === -1) return []
  // The node this range would start at must belong to the TARGET TURN. When the turn
  // has already been rolled back, its own nodes are gone from the surface and the first
  // node at or after its boundary is the PREVIOUS MARKER — and a range starting there
  // replaces that marker, which destroys the window hiding the rolled-back turn. That is
  // the degenerate `[60,60]` / `[75,75]` / `[93,93]` measured on the desktop
  // (2026-10-03): three rollbacks of one already-rolled-back turn, each of which
  // un-hid what the one before it had hidden. Nothing is the honest answer here, and
  // `service.execute` refuses the rollback outright rather than writing that marker.
  if (!seqInsideTurn(view, fromTurn, nodes[startIdx]!)) return []
  return [...nodes.slice(startIdx)]
}

/**
 * Drop the protected system-prompt node from a range that would start on it.
 *
 * The clamp is one node deep and CONDITIONAL, both by the framework's own rule: a
 * range that starts later than node 0 is untouched, and a node 0 that is not the
 * system prompt (a build that keeps the prompt out of history ships a session
 * whose first surface node is the user's own message) is replaceable as before.
 * Clamping unconditionally would be a real defect — it would leave that first
 * rolled-back user message in the model's context.
 * @param view - the session view.
 * @param shadowed - the pre-clamp range, in surface order.
 * @returns the range a marker may actually replace; empty when the clamp consumed it.
 */
function withoutSystemPromptHead(view: SessionView, shadowed: readonly number[]): number[] {
  const head = view.surface.nodes[0]
  if (shadowed.length === 0 || head === undefined || shadowed[0] !== head) return [...shadowed]
  if (systemPromptNodeSeq(view) !== head) return [...shadowed]
  return shadowed.slice(1)
}

/**
 * Surface nodes a rollback to before `fromTurn` may replace: the nodes at or after
 * that turn's opening boundary, minus the system-prompt node. Empty when the turn
 * never opened, when the surface holds nothing from it, or when the ONLY node the
 * clamp left in range was the system prompt itself.
 *
 * The marker is appended in the same breath as this computation, so the live
 * surface IS the range: nothing can have been appended in between, which is why
 * no captured-range bookkeeping is needed.
 */
export function shadowedSurfaceFrom(view: SessionView, fromTurn: number): number[] {
  return withoutSystemPromptHead(view, boundarySurfaceFrom(view, fromTurn))
}

/**
 * The shadowed seqs, ordered so the session store keeps them VERBATIM.
 *
 * The JSONL store has a lossless range encoding for this one field: a STRICTLY
 * INCREASING list containing a run of three or more consecutive seqs is written as a
 * single `[start, end]` pair (`encodeSeqRanges`, `dsh-session/lib/index.js:982`). On
 * 2026-10-03 a marker written that way left a session that could never be opened again:
 * the runtime consumer of the field demands every entry be a non-negative safe integer
 * (`:320`), so the pair — a valid STORAGE form — was not a valid RUNTIME value. The
 * transcript stood at "载入历史…" from then on, and every later rollback in that session
 * had nothing left to hide. Replaying the session's real 108-event log through the
 * framework's own append path, this marker was the ONLY event it refused.
 *
 * The runtime has no ordering requirement of its own: entries must be unique and must
 * name earlier events (`:321-325`), nothing more. So leading with the LAST seq keeps the
 * list exactly as legal, keeps every element, and leaves `isStrictlyIncreasing` false —
 * which is the encoder's entire precondition (`:983`). Nothing about the range changes;
 * only its spelling, and only so the spelling survives the store intact.
 *
 * Fewer than three seqs cannot contain a run of three, so short lists are left in their
 * natural order.
 * @param shadowed - the surface seqs the marker replaces, ascending.
 * @returns the same seqs, spelled so the store will not compress them.
 */
function seqsForStorage(shadowed: readonly number[]): number[] {
  if (shadowed.length < 3) return [...shadowed]
  return [shadowed[shadowed.length - 1]!, ...shadowed.slice(0, -1)]
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
 *
 * Two outcomes carry a marker. Normally the range is the clamped surface tail from
 * the targeted turn, and the marker replaces it. When the clamp leaves NOTHING to
 * replace — the only node in range was the system prompt — the marker still
 * carries the checkpoint text but no replacement ({@link TruncationMarkerPlan.range}
 * is null), because a `replace` over that node is exactly what the framework
 * refuses and a `replace` over nothing cannot be spelled. The distinction is drawn
 * from the PRE-clamp range: a rollback that found no surface output at all writes
 * nothing, exactly as before.
 */
export function planTruncationMarker(
  view: SessionView,
  input: TruncationMarkerInput,
): TruncationMarkerPlan | null {
  const boundary = boundarySurfaceFrom(view, input.fromTurn)
  if (boundary.length === 0) return null
  const shadowed = withoutSystemPromptHead(view, boundary)
  const data = {
    id: input.messageId,
    role: 'user' as const,
    source: ROLLBACK_MARKER_SOURCE,
    content: [{ type: 'text' as const, text: ROLLBACK_CHECKPOINT_TEXT }],
  }
  if (shadowed.length === 0) return { shadowed, data, range: null, sourceEventSeqs: [] }
  return {
    shadowed,
    data,
    range: { start: shadowed[0]!, end: shadowed[shadowed.length - 1]! },
    sourceEventSeqs: seqsForStorage(shadowed),
  }
}