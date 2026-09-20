/**
 * Rollback plugin, browser half — a per-message "回退" action on the
 * finalized assistant message's IconActions strip.
 *
 * The button rides DSH's official `conversation.chat.assistant-actions` slot
 * (the same surface the Like/Dislike feedback uses), so the placement and
 * life-cycle are framework-managed — no DOM injection, no MutationObserver
 * button correlation. Clicking opens the affected-files dialog (host RPC
 * through the shipped `commands` Remote) with an irreversible confirm.
 *
 * The remaining DOM-touching helpers (`syncHides`, `syncHiddenRpcRows`) are not
 * button placement: they hide chat seats DSH renders but this plugin rolls
 * back, and suppress the receipt cards of button-dispatched command calls —
 * both are durable-log side effects with no official slot.
 *
 * @module @domitor-syh/dsh-rollback/client
 */

import * as React from 'react'
import { createPortal } from 'react-dom'
import { FishLogo, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { footerEntryNeeded } from '../core/turn-entry.ts'
import { oldestTurnOf } from '../core/rollback-guard.ts'

/** Required services: slots, the `commands` Remote, the conversation node registry, and locale. */
export const inject = ['slots', 'remote', 'remote.commands', 'conversationEvents', 'locale', 'workspaces']

/** Console diagnostics; set to true to debug the client logic. */
const DEBUG = false
/** Bundle revision — always reported once at apply, so a stale cached bundle is
 * identifiable in the console instead of looking like "the fix did nothing". */
const BUNDLE_REV = 15
function log(...parts: unknown[]): void {
  if (DEBUG) console.info('[rollback]', ...parts)
}
/**
 * Warn once per key about a condition that makes the UI silently wrong.
 *
 * Deliberately NOT gated by {@link DEBUG}: every call site fires only when the
 * plugin malfunctions (a thrown hide pass, a marker whose state cannot be read),
 * and those failures look exactly like "the plugin did nothing at all" — the
 * most expensive way to learn about a bug. Routine tracing stays behind the flag.
 * @param key - the once-per-key identity of this warning.
 * @param parts - the message and any values worth printing.
 */
function warnOnce(key: string, ...parts: unknown[]): void {
  const seen = warnOnce as unknown as Record<string, boolean>
  if (seen[key] === true) return
  seen[key] = true
  console.warn('[rollback]', ...parts)
}

/** Extract a message from an unknown error. */
function msg(e: unknown): string {
  if (e !== null && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string') {
    return (e as { message: string }).message
  }
  return String(e)
}

/** Dictionary namespace owned by this plugin. */
const NS = 'rollback'

const zh = {
  'action.label': '回退到本轮对话发起前',
  'action.running': '本轮还在进行中：暂停或等它结束后才能回退',
  'dialog.title': '回退到本轮对话发起前',
  'dialog.aria': '回退确认',
  'dialog.warning': '此操作不可撤销，将恢复本轮及之后受影响的工作区文件并截断模型上下文。',
  'dialog.analyzing': '正在分析受影响文件…',
  'dialog.openInEditor': '在编辑器中打开',
  'dialog.cancel': '取消',
  'dialog.confirm': '确认回退',
  'dialog.busy': '回退中…',
  'tag.restore': '恢复',
  'tag.recover': '找回',
  'tag.delete': '删除',
  'tag.skip': '跳过',
  'hero.title': '已回退到对话发起前',
  'hero.sub': '对话与文件已恢复 · 在下方输入框继续',
} satisfies Record<string, string>

const en: Record<keyof typeof zh, string> = {
  'action.label': 'Roll back to before this turn',
  'action.running': 'This turn is still running: pause it or wait for it to finish',
  'dialog.title': 'Roll back to before this turn',
  'dialog.aria': 'Rollback confirmation',
  'dialog.warning': 'This action is irreversible. It will restore workspace files affected by this turn and later, and truncate the model context.',
  'dialog.analyzing': 'Analyzing affected files…',
  'dialog.openInEditor': 'Open in editor',
  'dialog.cancel': 'Cancel',
  'dialog.confirm': 'Roll back',
  'dialog.busy': 'Rolling back…',
  'tag.restore': 'restore',
  'tag.recover': 'recover',
  'tag.delete': 'delete',
  'tag.skip': 'skip',
  'hero.title': 'Rolled back to the start',
  'hero.sub': 'Conversation and files restored · continue below',
}

type RollbackKey = keyof typeof zh

/** One affected file in the preview dialog, normalized to an internal action. */
interface PreviewFile {
  path: string
  action: 'restore' | 'recover' | 'delete' | 'skip'
}

/** Parse the host `/rollback preview <n>` tagged-line text into entries. */
function parsePreview(text: string | undefined): PreviewFile[] {
  if (text === undefined || text === null) return []
  const out: PreviewFile[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*\[(恢复|找回|删除|跳过|restore|recover|delete|skip)\]\s+(.+)$/ui.exec(line)
    if (m === null) continue
    const raw = m[1]!.toLowerCase()
    const action = raw === 'restore' || raw === '恢复' ? 'restore' as const
      : raw === 'recover' || raw === '找回' ? 'recover' as const
        : raw === 'delete' || raw === '删除' ? 'delete' as const
          : 'skip' as const
    out.push({ action, path: m[2]!.trim() })
  }
  return out
}

/**
 * Command executions this client itself dispatched (the Web button's preview
 * and execute RPCs). Their durable receipt cards are hidden by
 * {@link syncHiddenRpcRows}: a canceled preview must leave no trace, and a
 * confirmed rollback is already narrated by the rollback divider. Manual
 * `/rollback` invocations never enter this set, so their output stays visible.
 */
const RPC_HIDE_KEY = 'dsh-rollback.hidden-command-ids'
/** `conversationContextKey(kind, id)` = `${kind.length}:${kind}${id}`; "command" is 7 chars. */
const COMMAND_KIND = 'command'
const COMMAND_KEY_PREFIX = COMMAND_KIND.length + ':' + COMMAND_KIND
const hiddenRpcIds: Set<string> = (() => {
  try { return new Set<string>(JSON.parse(localStorage.getItem(RPC_HIDE_KEY) ?? '[]') as string[]) }
  catch { return new Set<string>() }
})()

/** Command seats present at the last button dispatch (see `markPendingCommandDispatch`). */
let pendingCommandSeen: Set<string> | null = null

/** Track one command execution dispatched by this client (best-effort persistence). */
function trackRpcId(commandId: unknown): void {
  if (typeof commandId !== 'string' || commandId === '' || hiddenRpcIds.has(commandId)) return
  hiddenRpcIds.add(commandId)
  try { localStorage.setItem(RPC_HIDE_KEY, JSON.stringify([...hiddenRpcIds])) } catch { /* session-only */ }
  pendingCommandSeen = null
  syncHiddenRpcRows()
  requestAnimationFrame(() => { syncHiddenRpcRows() })
}


/** display:none the seats of button-dispatched command executions (removes the flex gap entirely). */
function syncHiddenRpcRows(): void {
  const ids = [...hiddenRpcIds]
  for (const el of document.querySelectorAll<HTMLElement>('[data-chat-flow-key]')) {
    const key = el.getAttribute('data-chat-flow-key') ?? ''
    if (key === '') continue
    // Hard guard, learned the expensive way: a text-based matcher once hid assistant
    // MESSAGES (their prose mentions rollback, list and preview), and the mutation
    // observer then hid another one on every re-render. Conversation content is long;
    // a command receipt is not. Nothing above this size is ever touched.
    const text = el.textContent ?? ''
    if (text.length > MAX_RECEIPT_CHARS) continue
    // Identity, not content: only receipts THIS client dispatched are hidden, so a
    // rollback the user typed stays readable, and no message can ever match.
    for (const id of ids) {
      if (id !== '' && key.endsWith(id)) { el.style.display = 'none'; break }
    }
  }
}

/**
 * In-flight receipt capture: the button's preview/execute RPCs mint durable
 * command nodes. Those used to mount visibly and then be hidden after the RPC
 * resolved — a grow-then-shrink that made the transcript "shake" on every
 * click. Snapshot the command seats present at dispatch, then hide any that
 * appear afterwards (synchronously in the MutationObserver, before paint).
 */
function markPendingCommandDispatch(): void {
  const seen = new Set<string>()
  for (const el of document.querySelectorAll<HTMLElement>('[data-chat-flow-kind="command"][data-chat-flow-key]')) {
    const key = el.getAttribute('data-chat-flow-key') ?? ''
    if (key.startsWith(COMMAND_KEY_PREFIX)) seen.add(key.slice(COMMAND_KEY_PREFIX.length))
  }
  pendingCommandSeen = seen
}

/** Hide command receipts that appeared since {@link markPendingCommandDispatch}. */
function syncPendingRpcRow(): void {
  if (pendingCommandSeen === null) return
  let caught = false
  for (const el of document.querySelectorAll<HTMLElement>('[data-chat-flow-kind="command"][data-chat-flow-key]')) {
    const key = el.getAttribute('data-chat-flow-key') ?? ''
    if (!key.startsWith(COMMAND_KEY_PREFIX)) continue
    const id = key.slice(COMMAND_KEY_PREFIX.length)
    if (pendingCommandSeen.has(id)) continue
    if (!hiddenRpcIds.has(id)) { hiddenRpcIds.add(id); caught = true }
    el.style.display = 'none'
  }
  if (caught) {
    pendingCommandSeen = null
    try { localStorage.setItem(RPC_HIDE_KEY, JSON.stringify([...hiddenRpcIds])) } catch { /* session-only */ }
  }
}

/** A `/rollback` command through the shipped Remote, unwrapping its envelope. */
function extCommand(ctx: any, sessionId: string, line: string): Promise<{ text?: string }> {
  return ctx.remote.commands.execute(sessionId, line, []).then((r: any) => {
    if (!r || r.ok === false) throw new Error(r?.error?.message ?? 'command failed')
    const exec = r.value
    if (exec === undefined || exec === null) throw new Error(`cannot resolve command: ${line}`)
    trackRpcId(exec.commandId)
    const result = exec.result
    if (result.kind === 'error') throw new Error(result.text ?? 'command failed')
    return { text: result.text }
  })
}

const CSS =
  '.rbk-act{position:relative;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:5px;border:none;border-radius:28px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;}' +
  '.rbk-act:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);}' +
  '.rbk-act:disabled{cursor:default;opacity:.4;}' +
  '.rbk-overlay{position:fixed;inset:0;z-index:1300;display:flex;align-items:center;justify-content:center;background:rgb(0 0 0/.4);backdrop-filter:blur(2px);}' +
  '.rbk-panel{width:min(460px,calc(100vw - 32px));max-height:70vh;display:flex;flex-direction:column;border-radius:12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);box-shadow:0 16px 48px rgb(0 0 0/.35);color:var(--dsw-alias-label-primary);}' +
  '.rbk-head{padding:14px 16px 8px;font-size:14px;font-weight:700;}' +
  '.rbk-warn{padding:0 16px 8px;font-size:12px;color:var(--dsw-alias-label-secondary);}' +
  '.rbk-list{overflow-y:auto;padding:2px 8px;flex:1;}' +
  '.rbk-row{display:flex;align-items:center;gap:8px;width:100%;text-align:left;padding:6px 8px;border-radius:7px;border:none;background:transparent;color:var(--dsw-alias-label-primary);font-size:12.5px;cursor:pointer;}' +
  '.rbk-row:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 10%,transparent);}' +
  '.rbk-tag{flex:none;font-size:11px;padding:1px 6px;border-radius:5px;}' +
  '.rbk-tag-restore{background:color-mix(in srgb,var(--dsw-alias-state-success-primary, #3fb27f) 22%,transparent);color:var(--dsw-alias-state-success-primary, #3fb27f);}' +
  '.rbk-tag-recover{background:color-mix(in srgb,var(--dsw-static-blue-500, #3b82f6) 22%,transparent);color:var(--dsw-static-blue-500, #3b82f6);}' +
  '.rbk-tag-delete{background:color-mix(in srgb,var(--dsw-alias-state-error-primary, #e5484d) 22%,transparent);color:var(--dsw-alias-state-error-primary, #e5484d);}' +
  '.rbk-tag-skip{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 18%,transparent);color:var(--dsw-alias-label-secondary);}' +
  '.rbk-path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
  '.rbk-empty{padding:16px;font-size:12.5px;opacity:.65;text-align:center;}' +
  '.rbk-err{padding:8px 16px;font-size:12px;color:var(--dsw-alias-state-error-primary, #e5484d);}' +
  '.rbk-foot{display:flex;justify-content:flex-end;gap:8px;padding:12px 16px;border-top:1px solid var(--dsw-alias-border-l2);}' +
  '.rbk-cancel{padding:5px 12px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font-size:12.5px;cursor:pointer;}' +
  '.rbk-cancel:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);}' +
  '.rbk-confirm{padding:5px 12px;border-radius:7px;border:none;background:var(--dsw-alias-state-error-primary, #e5484d);color:#fff;font-size:12.5px;cursor:pointer;}' +
  '.rbk-confirm:hover:not(:disabled){filter:brightness(1.12);}' +
  '.rbk-confirm:disabled{opacity:.6;cursor:wait;}' +
  // The welcome hero, shown when a rollback emptied the whole surface (rolled
  // back to before the first message). An ordinary rollback renders no divider,
  // so these rules only ever apply to the hero.
  '.rbk-hero{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;min-height:40vh;padding:40px 24px;text-align:center;}' +
  '.rbk-hero-brand{color:var(--dsw-alias-label-secondary);opacity:.85;}' +
  '.rbk-hero-brand svg{width:44px;height:auto;}' +
  '.rbk-hero-title{font-size:16px;font-weight:600;color:var(--dsw-alias-label-primary);}' +
  '.rbk-hero-sub{font-size:13px;color:var(--dsw-alias-label-tertiary);}'

/** The curved reply/return arrow (↩), as a React element this time. */
function ReplyIcon(): React.ReactElement {
  return React.createElement('svg', { width: 18, height: 18, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
    React.createElement('path', { d: 'M6.6 3.4 3 7l3.6 3.6', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }),
    React.createElement('path', { d: 'M3 7h6.4c2.3 0 4 1.7 4 3.9V13', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
  )
}

/** The turn NUMBER from a node's location (object form or bare number). */
function turnNoOf(loc: any): number | undefined {
  const t = loc?.turn
  const n = (t !== null && typeof t === 'object') ? t.turn : t
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 1 ? n : undefined
}

/** Plain text of the turn-opening user prompt for one turn. */
function findUserPrompt(snapshot: any, turn: number): string {
  const order = snapshot?.chat?.order
  const store = snapshot?.chat?.nodes
  if (!Array.isArray(order) || typeof store?.get !== 'function') return ''
  for (const key of order) {
    const node = store.get(key)
    if (node?.kind !== 'user' || turnNoOf(node.location) !== turn) continue
    const content = node?.data?.content
    if (!Array.isArray(content)) return ''
    return content
      .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text)
      .join('')
  }
  return ''
}

/** Image blocks of a turn-opening user prompt, for re-attaching to the composer. */
function findUserImages(snapshot: any, turn: number): { name: string; mediaType: string; attachment: any }[] {
  const order = snapshot?.chat?.order
  const store = snapshot?.chat?.nodes
  if (!Array.isArray(order) || typeof store?.get !== 'function') return []
  for (const key of order) {
    const node = store.get(key)
    if (node?.kind !== 'user' || turnNoOf(node.location) !== turn) continue
    const content = node?.data?.content
    if (!Array.isArray(content)) return []
    return content
      .filter((b: any) => b?.type === 'image' && b?.attachment)
      .map((b: any) => ({ name: b.attachment.name ?? 'image', mediaType: b.attachment.mediaType ?? 'image/png', attachment: b.attachment }))
  }
  return []
}

/**
 * The turn a finalized assistant `messageId` belongs to, resolved from the chat
 * snapshot. `assistant-actions` fires once per settled turn with its closing
 * message, so this maps the end-of-turn anchor back to its 1-based turn.
 */
function turnForMessageId(snapshot: any, messageId: string): number | undefined {
  const order = snapshot?.chat?.order
  const store = snapshot?.chat?.nodes
  if (!Array.isArray(order) || typeof store?.get !== 'function') return undefined
  for (const key of order) {
    const node = store.get(key)
    if (node?.kind !== 'assistant-step') continue
    const finalNode = node?.data?.finalNode
    if (finalNode !== null && finalNode !== undefined && finalNode.messageId === messageId) {
      const turn = node?.data?.turn
      return typeof turn === 'number' && Number.isSafeInteger(turn) ? turn : turnNoOf(node?.location)
    }
  }
  return undefined
}

/**
 * The conversation scrollport, mirroring ChatView.scrollerOf. Used only to
 * reset bottom-follow after a rollback collapses the transcript.
 */
function scrollportOf(column: HTMLElement | null): HTMLElement | null {
  if (column === null) return null
  return column.closest<HTMLElement>('[data-conversation-scroll]') ?? column.parentElement
}

/** DSH's floating "back to bottom" chip, across the shipped locales. */
const TO_BOTTOM_LABELS = new Set(['回到底部', 'Back to bottom'])

/** The rendered back-to-bottom button(s) inside one scrollport, if shown. */
function toBottomButtons(scrollport: HTMLElement | null): HTMLElement[] {
  if (scrollport === null) return []
  const out: HTMLElement[] = []
  for (const btn of scrollport.querySelectorAll<HTMLElement>('button[aria-label]')) {
    if (TO_BOTTOM_LABELS.has(btn.getAttribute('aria-label') ?? '')) out.push(btn)
  }
  return out
}

/**
 * The surface cut a rollback-marker node records, or undefined when unreadable.
 *
 * This is the ONE place that knows the marker state's shape, which `start()`
 * writes as a FLAT `{ seq, truncatedFromSeq }` (the event's own seq plus the
 * `surfaceOp.start` it replaced from). Reading it through a stale path is how a
 * working rollback once became a silent no-op: the host truncated the
 * conversation, the client collected zero markers, and nothing was hidden. A
 * marker without a readable cut is therefore reported rather than skipped.
 * @param node - a chat node of kind `rollback-marker`.
 * @returns the cut seq, or undefined when the node carries no readable one.
 */
function markerCutOf(node: any): number | undefined {
  const from = node?.data?.truncatedFromSeq
  if (typeof from === 'number') return from
  warnOnce('marker-shape', 'rollback marker node carries no readable cut seq', node?.data)
  return undefined
}

/**
 * Chat node kinds that are infrastructure rather than conversation content.
 *
 * A visible one of these must not hold the welcome hero back once every real
 * message is hidden: `turn-tail` is a per-turn action affordance, and `command`
 * is a slash-command receipt (this plugin hides its own receipts separately).
 * Anything NOT listed counts as content, so an unrecognized kind errs toward
 * keeping the hero away rather than showing it over a message.
 */
const INFRASTRUCTURE_KINDS = new Set<string>(['turn-tail', 'command'])

/**
 * Whether the transcript is currently emptied by a rollback, as {@link syncHides}
 * last determined.
 *
 * The driver reads this and renders the welcome hero into a host element IT
 * injects into the transcript. The hero used to be revealed by un-hiding the
 * marker node's own seat — which silently produced nothing whenever that seat was
 * missing, or nested inside a container the hide pass had collapsed. Hosting it
 * ourselves removes that dependency entirely.
 */
const heroWanted = { visible: false }

/**
 * Visually hide every chat seat inside a rollback's shadowed range, and reset
 * bottom-follow over a short armed window after a NEW marker lands. Durable-log
 * side effect: hidden seats need no slot because DSH renders them from events
 * this plugin declared non-surface.
 */
function syncHides(snapshot: any): void {
  const chat = snapshot?.chat
  const order = chat?.order
  const store = chat?.nodes
  if (!Array.isArray(order) || typeof store?.get !== 'function') return

  const seatByKey = new Map<string, HTMLElement>()
  for (const el of document.querySelectorAll<HTMLElement>('[data-chat-flow-key]')) {
    const k = el.getAttribute('data-chat-flow-key')
    if (k !== null) seatByKey.set(k, el)
  }

  const markers: { from: number; seq: number }[] = []
  for (const key of order) {
    const node = store.get(key)
    if (node?.kind !== 'rollback-marker') continue
    const from = markerCutOf(node)
    const seq = typeof node?.data?.seq === 'number' ? node.data.seq : node?.anchorSeq
    if (from === undefined) continue
    markers.push({ from, seq })
  }
  // A session with no rollback marker must CLEAR the flag, not skip past it:
// `heroWanted` is module state that outlives the session it was set in, so
// returning early here left the welcome page standing at the end of every
// conversation opened afterwards — until a page reload reset the module.
  if (markers.length === 0) {
    heroWanted.visible = false
    return
  }

  const latest = markers[markers.length - 1]!
  const latestSeq = latest.seq

  let hasContentAfter = false
  for (const key of order) {
    const node = store.get(key)
    const seq = node?.anchorSeq
    if (typeof seq === 'number' && seq > latestSeq && node?.kind !== 'rollback-marker') { hasContentAfter = true; break }
  }

  // Pass 1 — emptiness, decided from the chat NODES and never from the seats the
// DOM happens to hold. A message reaches the log before React renders its seat,
// so counting seats made a brand-new message invisible to this test for several
// frames — long enough to flash the hero between the old conversation and the new
// message. Every non-marker node either is covered by a rollback's range (hidden)
// or is still standing content, and the transcript is empty when nothing is left
// standing.
  let contentLeft = 0
  for (const key of order) {
    const node = store.get(key)
    const seq = node?.anchorSeq
    if (typeof seq !== 'number') continue
    if (node?.kind === 'rollback-marker') continue
    if (INFRASTRUCTURE_KINDS.has(node?.kind)) continue
    if (markers.some(m => seq >= m.from && seq < m.seq)) continue
    contentLeft += 1
  }
  const emptied = contentLeft === 0

  // Pass 2 — marker seats render nothing at all: no divider, and no hero either
  // (the welcome page is hosted by the driver, see `heroWanted`). A marker whose
  // seat never appeared is reported, since it still explains an empty page.
  let hidden = 0
  let markerSeats = 0
  for (const key of order) {
    const node = store.get(key)
    if (node?.kind !== 'rollback-marker') continue
    const el = seatByKey.get(key)
    if (el === undefined) {
      warnOnce('marker-seat', 'rollback marker node has no DOM seat', { key, seq: node?.anchorSeq })
      continue
    }
    markerSeats += 1
    el.style.display = 'none'
    hidden += 1
  }

  // Pass 3 — hide every seat a rollback covered, and — while the hero is up —
  // every seat that is still visible. An emptied transcript has no content left
  // by definition (Pass 1 proved it), so what remains are log-only rows that sit
  // BEFORE the rollback point and were never in the model's context: permission
  // switches (the host `/permission` command's receipt) and turn tails. Leaving
  // one above the welcome page reads as a broken screen, and hiding it cannot
  // desync the model, because the model never saw it. Those rows return with the
  // transcript's content, since a rollback only removes the range it targeted.
  for (const key of order) {
    const el = seatByKey.get(key)
    if (el === undefined) continue
    const node = store.get(key)
    const seq = node?.anchorSeq
    if (typeof seq !== 'number' || node?.kind === 'rollback-marker') continue
    const hide = emptied || markers.some(m => seq >= m.from && seq < m.seq)
    el.style.display = hide ? 'none' : ''
    if (hide) hidden += 1
  }

  // The hero stands in for an emptied transcript, and only for one a ROLLBACK
  // emptied — `markers` is non-empty here, since this pass returns early without
  // one, and a session that never had content therefore never reaches it.
  heroWanted.visible = emptied

  const column = document.querySelector<HTMLElement>('[data-chat-flow=""]')

  // An emptied transcript also stops offering "load more": there is no earlier
  // range left to reach for.
  if (emptied) {
    const loadMoreBtn = column === null ? null : column.querySelector<HTMLElement>(':scope > div:not([data-chat-flow-key]) button')
    if (loadMoreBtn !== null) loadMoreBtn.style.display = 'none'
  }

  const sig = (emptied ? 'f' : 'p') + ':' + latestSeq + ':' + (hasContentAfter ? 'restart' : 'clean') + ':' + hidden
  if (sig !== (syncHides as unknown as { sig?: string }).sig) {
    ;(syncHides as unknown as { sig?: string }).sig = sig
    log('syncHides ' + (emptied ? 'FULL-RESET' : 'PARTIAL') + ' marker@' + latestSeq + ' hidden=' + hidden + (hasContentAfter ? ' (content resumed)' : ''))
    // One unconditional line, emitted only when the transcript state CHANGES. It
    // answers the question a "the rollback worked but nothing showed" report
    // always raises — how many markers were found, whether they got DOM seats,
    // how much content stayed visible — without another debugging round trip.
    console.info('[rollback] hides:', {
      markers: markers.length,
      latestMarker: latestSeq,
      markerSeats,
      seatsInDom: seatByKey.size,
      contentLeft,
      hiddenSeats: hidden,
      hero: heroWanted.visible ? 'wanted' : 'no',
    })
  }

  // A rollback collapses the transcript: seats vanish, DSH's own bottom-follow
  // concludes the viewport left the bottom, and its "back to bottom" chip pops
  // out of the collapse itself. Arm a short window per collapse — keyed on the
  // marker, so the FIRST rollback in a session also arms — then pin the viewport
  // to the bottom and re-engage follow by pressing the chip.
  const scrollMeta = syncHides as unknown as { collapseKey?: number; clearUntil?: number }
  if (scrollMeta.collapseKey !== latestSeq) {
    scrollMeta.collapseKey = latestSeq
    scrollMeta.clearUntil = Date.now() + 800
  }
  const armed = scrollMeta.clearUntil !== undefined && Date.now() < scrollMeta.clearUntil
  if (armed && !hasContentAfter) {
    const scrollport = scrollportOf(column)
    if (scrollport !== null) scrollport.scrollTop = scrollport.scrollHeight
    for (const btn of toBottomButtons(scrollport)) {
      try { btn.click() } catch { /* next pass retries */ }
    }
  }
}

/**
 * Keep the hero's host element in step with the emptiness `syncHides` reported.
 *
 * The host is a plain element this plugin owns, appended to the transcript, and
 * the driver portals the hero into it. Owning the location is what makes the hero
 * reliable: revealing the marker node's own seat depended on that seat existing
 * and on nothing above it having been collapsed, and a rollback that hid the
 * whole transcript could therefore show nothing at all.
 * @param ref - the driver's host slot.
 * @param setOn - React state setter; React bails out when the value is unchanged.
 */
function syncHeroHost(ref: { current: HTMLElement | null }, setOn: (on: boolean) => void): void {
  let host = ref.current
  if (host !== null && !document.body.contains(host)) {
    ref.current = null
    host = null
  }
  if (!heroWanted.visible) {
    if (host !== null) {
      host.remove()
      ref.current = null
    }
    setOn(false)
    return
  }
  const column = document.querySelector<HTMLElement>('[data-chat-flow=""]')
  if (column === null) {
    setOn(false)
    return
  }
  if (host === null || !column.contains(host)) {
    host?.remove()
    host = document.createElement('div')
    host.setAttribute('data-rbk-hero-host', 'true')
    column.appendChild(host)
    ref.current = host
  } else if (column.lastElementChild !== host) {
    // Keep the hero LAST. React appends the seats it renders after whatever it
    // finds at the end of the column, so a message sent after a rollback would
    // otherwise render below the hero — stranding the welcome page in the middle
    // of the transcript, between the old conversation and the new message.
    column.appendChild(host)
  }
  setOn(true)
}

/** Module-level bridge: the assistant action opens the single dock-hosted dialog. */
let openRollbackDialog: ((turn: number) => void) | null = null

/** The rollback action rendered on each finalized assistant message's action strip. */
function RollbackAction({ messageId, useSession, t }: any): React.ReactElement | null {
  if (typeof useSession !== 'function') {
    // Never silent: a missing button must always be traceable to a reason.
    warnOnce('action-session', 'assistant action lacks useSession')
    return null
  }
  const snapshot = useSession((s: any) => s)
  const oldest = useRollbackOldest()
  const open = snapshot?.running === true
  const turn = React.useMemo(() => turnForMessageId(snapshot, messageId), [snapshot, messageId])
  const blocked = turn !== undefined && oldest !== null && turn < oldest
  const disabled = open || turn === undefined || blocked
  const label = open ? t('action.running') : t('action.label')
  const button = React.createElement('button', {
    type: 'button',
    className: 'rbk-act',
    'aria-label': label,
    disabled,
    onClick: () => { if (!disabled && turn !== undefined && openRollbackDialog !== null) openRollbackDialog(turn) },
  }, React.createElement(ReplyIcon))
  return React.createElement(Tooltip, { label, side: 'bottom' }, button)
}

/**
 * Routing selector for the turn-footer entry, and the reason this entry is a CHAIN
 * contribution: a chain entry MUST supply `select` (the framework throws without it),
 * and its non-null result becomes the component's `matched` prop.
 *
 * Returning null whenever the assistant action strip can offer the button keeps the
 * familiar placement and guarantees one button per turn — the footer shows up only
 * where that strip cannot exist (an interrupted turn, which has no closing message).
 * The tail data is read through the location's own reader rather than from the node,
 * because the selector only ever receives the owner props.
 */
function selectFooterAction(owner: any): { turn: number } | null {
  const location = owner?.turn
  const turnNo = turnNoOf(location)
  if (turnNo === undefined) return null
  let closing: unknown
  try {
    closing = location?.data?.get?.('turn-tail')?.closing
  } catch (e) {
    // Fail open: a missing button is worse than one the host may decline.
    warnOnce('footer-tail-data', 'turn footer could not read its tail data', e)
    return { turn: turnNo }
  }
  if (!footerEntryNeeded(closing as never)) return null
  return { turn: turnNo }
}

/**
 * The oldest turn the host can still roll back to, published by the driver.
 *
 * `null` means "not known yet" and blocks nothing: guessing a range (say, "the newest
 * turn minus ten") would grey out turns that are perfectly rollback-able, a silent
 * loss of function — the failure mode this plugin keeps having to design against.
 * `Infinity` means the host reported no rollback-able turn at all.
 */
let rollbackOldest: number | null = null
const rollbackRangeListeners = new Set<() => void>()

/** Publish the rollback range to the action components. */
function publishRollbackOldest(oldest: number | null): void {
  rollbackOldest = oldest
  for (const listener of [...rollbackRangeListeners]) {
    try {
      listener()
    } catch (e) {
      warnOnce('range-listener', 'a rollback-range listener threw', e)
    }
  }
}

/** Read the published rollback range, re-rendering whenever the driver publishes. */
function useRollbackOldest(): number | null {
  const [, bump] = React.useState(0)
  React.useEffect(() => {
    const listener = (): void => { bump(n => n + 1) }
    rollbackRangeListeners.add(listener)
    return () => { rollbackRangeListeners.delete(listener) }
  }, [])
  return rollbackOldest
}

/**
 * The same rollback action, rendered in the turn FOOTER for turns the assistant
 * action strip cannot serve.
 *
 * There is no in-progress state to handle here: the footer node only exists once its
 * turn ENDED (`tailData` requires a `turn/end` match), so a running turn simply has no
 * footer to render into. The host refuses a rollback while any turn is open, which is
 * the rule that actually has to hold — the button's absence during a run is a
 * consequence of that, not a second mechanism.
 */
function RollbackTurnAction({ turn: location, matched, useSession, t }: any): React.ReactElement | null {
  if (typeof useSession !== 'function') {
    warnOnce('footer-action-session', 'turn footer action lacks useSession')
    return null
  }
  const turnNo = matched?.turn ?? turnNoOf(location)
  const oldest = useRollbackOldest()
  if (turnNo === undefined) {
    warnOnce('footer-action-turn', 'turn footer action could not resolve its turn', location)
    return null
  }
  const blocked = oldest !== null && turnNo < oldest
  log('turn-footer action rendered', { turn: turnNo, blocked })
  // Disabled says it: the greyed style is the whole message. A tooltip here would not
  // render anyway (a disabled button takes no hover) and a second wording to keep in
  // sync is exactly the kind of redundant surface this codebase keeps pruning.
  const button = React.createElement('button', {
    type: 'button',
    className: 'rbk-act',
    'aria-label': t('action.label'),
    disabled: blocked,
    onClick: () => { if (!blocked && openRollbackDialog !== null) openRollbackDialog(turnNo) },
  }, React.createElement(ReplyIcon))
  return React.createElement(Tooltip, { label: t('action.label'), side: 'bottom' }, button)
}

interface DriverProps {
  preview: (turn: number) => Promise<PreviewFile[]>
  execute: (turn: number) => Promise<void>
  /** Raw `/rollback list` output, for the range the action entries may offer. */
  list: () => Promise<string>
  openFile: (path: string) => Promise<void>
  useSession: <T>(selector: (snapshot: any) => T) => T
  t: (key: RollbackKey) => string
  inputActions?: { setDraft(text: string): void; addImages?(ids: readonly string[]): boolean; pruneImages?(ids: readonly string[]): void }
  restoreImages?: (images: { name: string; mediaType: string; attachment: any }[]) => Promise<string[]>
}

/**
 * Invisible per-session driver: runs the durable-log side-effect passes (hide
 * rolled-back seats, suppress button command receipts) and hosts the single
 * confirmation dialog, opened from the assistant action through the module
 * bridge. Renders nothing into its own dock seat.
 */
function RollbackDriver({ preview, execute, list, openFile, useSession, inputActions, restoreImages, t }: DriverProps): React.ReactElement | null {
  if (typeof useSession !== 'function') {
    warnOnce('useSession', 'props lack useSession', Object.keys({ useSession }))
    return null
  }
  const snapshotRef = React.useRef<any>(null)
  const ensureRef = React.useRef<() => void>(() => {})
  const snapshot = useSession((s: any) => s)

  const [dialogTurn, setDialogTurn] = React.useState<number | null>(null)
  const [files, setFiles] = React.useState<PreviewFile[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [heroOn, setHeroOn] = React.useState(false)
  const heroHostRef = React.useRef<HTMLElement | null>(null)

  const openDialog = React.useCallback((turn: number) => {
    setDialogTurn(turn)
    setFiles(null)
    setError(null)
    markPendingCommandDispatch()
    preview(turn).then(setFiles, (e: unknown) => setError(msg(e)))
  }, [preview])

  // Expose the opener to the assistant action; heartbeat + side-effect passes.
  React.useEffect(() => {
    openRollbackDialog = openDialog
    snapshotRef.current = snapshot
    // Learn which turns the host can still roll back to, so entries for turns whose
    // checkpoints were evicted grey out instead of opening a dialog that would plan
    // from the wrong (oldest retained) records. Published once per session; a
    // rollback reloads the page, which re-runs this.
    list().then(
      text => { publishRollbackOldest(oldestTurnOf(text)) },
      (e: unknown) => { warnOnce('rollback-list', 'could not read the rollback range', e) },
    )
    let raf = 0
    const ensure = () => {
      try { syncHides(snapshotRef.current) } catch (e) { warnOnce('sync-hides', 'syncHides threw', e) }
      try { syncHiddenRpcRows() } catch (e) { warnOnce('sync-rpc-rows', 'syncHiddenRpcRows threw', e) }
      try { syncHeroHost(heroHostRef, setHeroOn) } catch (e) { warnOnce('sync-hero', 'syncHeroHost threw', e) }
    }
    ensureRef.current = () => {
      if (raf) cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => { raf = 0; ensure() })
    }
    ensure()
    const obs = new MutationObserver(() => { syncPendingRpcRow(); ensureRef.current() })
    obs.observe(document.body, { childList: true, subtree: true })
    return () => {
      obs.disconnect()
      if (raf) cancelAnimationFrame(raf)
      openRollbackDialog = null
      // Leave no hero behind for the next session: the flag is module state, and
      // this driver is unmounted when the user switches conversations.
      heroWanted.visible = false
      heroHostRef.current?.remove()
      heroHostRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  React.useEffect(() => {
    snapshotRef.current = snapshot
    ensureRef.current()
  })

  const confirm = () => {
    if (dialogTurn === null) return
    const turn = dialogTurn
    setBusy(true)
    setError(null)
    markPendingCommandDispatch()
    execute(turn).then(
      () => {
        setBusy(false)
        setDialogTurn(null)
        // The host restores the files and replaces the model-visible range in the
        // same call, so the durable marker is already in the log: refresh now and
        // the hide rule below applies it.
        ensureRef.current()
        const prompt = findUserPrompt(snapshotRef.current, turn)
        const images = findUserImages(snapshotRef.current, turn)
        if (inputActions !== undefined) {
          inputActions.setDraft(prompt)
          if (inputActions.pruneImages !== undefined) inputActions.pruneImages([])
        }
        if (images.length > 0 && restoreImages !== undefined && inputActions?.addImages !== undefined) {
          restoreImages(images).then(ids => {
            if (ids.length > 0) inputActions.addImages!(ids)
          }).catch(() => {})
        }
      },
      (e: unknown) => { setBusy(false); setError(msg(e)) },
    )
  }

  const hero = heroOn && heroHostRef.current !== null
    ? createPortal(React.createElement(RollbackHero, { t }), heroHostRef.current)
    : null
  const dialog = dialogTurn === null
    ? null
    : createPortal(
    React.createElement('div', {
      className: 'rbk-overlay',
      onMouseDown: (ev: React.MouseEvent) => { if (ev.target === ev.currentTarget) setDialogTurn(null) },
    },
      React.createElement('div', { className: 'rbk-panel', role: 'dialog', 'aria-label': t('dialog.aria') },
        React.createElement('div', { className: 'rbk-head' }, t('dialog.title')),
        React.createElement('div', { className: 'rbk-warn' }, t('dialog.warning')),
        React.createElement('div', { className: 'rbk-list' },
          files === null && error === null
            ? React.createElement('div', { className: 'rbk-empty' }, t('dialog.analyzing'))
            : null,
          // No "no file changes" placeholder: the plugin cannot see everything (a
          // file a shell command wrote outside the tools' reach is invisible to it),
          // so an empty list must not read as a promise that the workspace is
          // untouched. The dialogue says only what it knows.
          files !== null && files.length > 0
            ? files.map(f => React.createElement('button', {
                key: f.path, type: 'button', className: 'rbk-row', title: t('dialog.openInEditor'),
                onClick: () => { void openFile(f.path).catch(() => {}) },
              },
                React.createElement('span', { className: 'rbk-tag rbk-tag-' + f.action }, t(('tag.' + f.action) as RollbackKey)),
                React.createElement('span', { className: 'rbk-path' }, f.path),
              ))
            : null,
          error !== null
            ? React.createElement('div', { className: 'rbk-err' }, error)
            : null,
        ),
        React.createElement('div', { className: 'rbk-foot' },
          React.createElement('button', { type: 'button', className: 'rbk-cancel', disabled: busy, onClick: () => setDialogTurn(null) }, t('dialog.cancel')),
          React.createElement('button', { type: 'button', className: 'rbk-confirm', disabled: busy || files === null || error !== null, onClick: confirm }, busy ? t('dialog.busy') : t('dialog.confirm')),
        ),
      ),
    ),
    document.body,
  )
  if (hero === null && dialog === null) return null
  return React.createElement(React.Fragment, null, hero, dialog)
}

/** The durable rollback checkpoint node, recognized from the event itself. */
const markerDefinition = {
  kind: 'rollback-marker',
  target: 'chat',
  match: (event: any) => {
    const op = event?.surfaceOp
    if (op === undefined || op === 'append' || op?.op !== 'replace') return null
    // Current builds: a `user/message` stamped with this plugin's provenance.
    // Its content is the model-facing checkpoint text, so the client reads the
    // rolled-back range from the EVENT (`surfaceOp.start`) instead.
    if (event?.type === 'user/message') {
      const source = event?.data?.source
      if (source?.kind !== 'plugin' || source?.plugin !== 'rollback') return null
      return { id: String(event.seq), role: 'start' }
    }
    // Legacy builds (<= 852c656): an empty-content `assistant/message` whose
    // message carried the rollback facts. Still recognized so an old session's
    // markers keep hiding their range.
    if (event?.type === 'assistant/message' && event?.data?.message?.rollback !== undefined) {
      return { id: String(event.seq), role: 'start' }
    }
    return null
  },
  start: (_context: any, match: any) => {
    const from = match?.event?.surfaceOp?.start
    return typeof from === 'number' ? { seq: match.event.seq, truncatedFromSeq: from } : undefined
  },
  update: (context: any) => context.state,
  buildViewNode: (context: any) => {
    if (context.state === undefined) return null
    const loc = context.start?.location ?? context.matches?.[0]?.location ?? { kind: 'unresolved' }
    return {
      key: context.key,
      kind: 'rollback-marker',
      id: context.id,
      target: 'chat',
      anchorSeq: context.state.seq,
      location: loc,
      visibility: 'visible',
      data: context.state,
    }
  },
}

/** The marker node's view: nothing at all.
 *
 * It exists as the durable anchor `syncHides` reads the truncated range from, and
 * a rollback must leave no trace in the transcript — no divider, no notice. The
 * welcome hero is NOT rendered here, because a node's seat can be missing or sit
 * inside a container the hide pass collapsed, which would swallow the hero
 * silently; the driver hosts it instead (see {@link RollbackHero}). */
function RollbackMarkerView(): null {
  return null
}

/** The welcome page a rollback shows once the transcript is empty.
 *
 * Rendered by {@link RollbackDriver} into a host element it injects into the
 * transcript, so its visibility never depends on any node's seat. */
function RollbackHero({ t }: any): any {
  return React.createElement('div', { className: 'rbk-hero', role: 'status', 'data-rbk-hero': 'true' },
    React.createElement('div', { className: 'rbk-hero-brand' }, React.createElement(FishLogo, { size: 44 })),
    React.createElement('div', { className: 'rbk-hero-title' }, t('hero.title')),
    React.createElement('div', { className: 'rbk-hero-sub' }, t('hero.sub')),
  )
}

/** Client plugin body: stylesheet, dictionaries, the assistant action, and the driver. */
export function apply(ctx: any): void {
  // Always reported, once per page load: the first question when a rollback looks
  // like it did nothing is whether the browser is even running the new bundle.
  // One line is a fair price for answering it without a debugging round trip.
  console.info('[rollback] client bundle rev', BUNDLE_REV)
  log('client apply')
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = 'rollback'
    style.textContent = CSS
    document.head.appendChild(style)
    return () => style.remove()
  })

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'rollback: dictionaries')

  // The marker node is the durable anchor `syncHides` reads the truncated range
  // from, and it renders the welcome hero when its rollback emptied the surface
  // (see RollbackMarkerView) — an ordinary rollback renders no divider.
  ctx.conversationEvents.register(markerDefinition)

  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'rollback-marker', locale: NS },
    RollbackMarkerView,
  ))

  ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register(
    { name: 'conversation.chat.assistant-actions', id: 'rollback', order: 20, locale: NS },
    RollbackAction,
  ))

  // The turn footer covers what the action strip cannot: an interrupted turn has no
  // closing assistant message, so the strip contributes no actions and the button
  // would be missing exactly when it is wanted. `selectFooterAction` returns null for
  // every other turn, so this never duplicates the strip's button.
  //
  // The registration is guarded because a chain entry's shape is easy to get wrong
  // (it needs `select`, not the `id`/`order` a list entry takes) and the framework's
  // rejection left a silently empty row behind the last time. A failure here is
  // reported loudly and leaves the strip's button as the only — still working — entry.
  ctx.slots.inject('conversation.chat.turnTail', () => {
    try {
      const dispose = ctx.slots.register({
        name: 'conversation.chat.turnTail',
        select: selectFooterAction,
        locale: NS,
      }, RollbackTurnAction)
      console.info('[rollback] turn-footer action registered (rev ' + BUNDLE_REV + ')')
      return dispose
    } catch (error) {
      console.error('[rollback] turn-footer action registration FAILED — interrupted turns will have no rollback button', error)
      return () => {}
    }
  })

  ctx.slots.inject('conversation.input.dock', () => {
    log('dock entry registering')
    const dispose = ctx.slots.register({
      name: 'conversation.input.dock',
      id: 'rollback-driver',
      locale: NS,
      inject: (sessionId: string) => ({
        preview: async (turn: number) => {
          const r = await extCommand(ctx, sessionId, '/rollback preview ' + turn)
          return parsePreview(r.text)
        },
        execute: async (turn: number) => {
          await extCommand(ctx, sessionId, '/rollback ' + turn)
        },
        list: async () => (await extCommand(ctx, sessionId, '/rollback list')).text ?? '',
        openFile: (path: string) => ctx.workspaces.openPath(path),
        restoreImages: async (images: { name: string; mediaType: string; attachment: any }[]): Promise<string[]> => {
          const conversation = ctx.get?.('conversation')
          if (conversation === undefined || conversation.resolveImage === undefined || conversation.createDraftImages === undefined) return []
          const ids: string[] = []
          for (const img of images) {
            try {
              const url: string = await conversation.resolveImage(sessionId, img.attachment)
              const resp = await fetch(url)
              const blob = await resp.blob()
              const file = new File([blob], img.name || 'image', { type: img.mediaType || 'image/png' })
              const drafts = conversation.createDraftImages([file])
              if (drafts !== null && drafts[0] !== undefined && drafts[0].id !== undefined) ids.push(drafts[0].id)
            } catch { /* skip a failed image */ }
          }
          return ids
        },
      }),
    }, RollbackDriver)
    return () => dispose()
  })
}