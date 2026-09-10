/**
 * Rollback plugin, browser half — a per-message "回退" action beside the user
 * bubble's Copy button.
 *
 * ui-conversation exposes no per-user-message action slot (the user bubble's
 * `MessageIconActions` receives no `extraActions`), so the button is injected
 * at the DOM level: a driver entry mounted in the always-present
 * `conversation.input.dock` seat renders nothing itself but correlates each
 * user-style bubble row with its turn (snapshot render order ↔ DOM order) and
 * inserts a 28×28 reply-arrow button right after the row's Copy button —
 * matching that button's chrome exactly. Clicking opens the affected-files
 * dialog (host RPC through the shipped `commands` Remote) with an irreversible
 * confirm.
 *
 * Dependency-light at the boundary (like dsh-ui-skin-switcher): framework
 * seams arrive through props/`any`; primitives stay baseline-external.
 *
 * @module @domitor-syh/dsh-rollback/client
 */

import * as React from 'react'
import { createPortal } from 'react-dom'
import { BrandWordmark, FishLogo } from '@deepseek-ai/dsh-client-ui-primitives'

/** Required services: slot registry, the shipped `remote.commands` Remote, and the conversation node registry. */
export const inject = ['slots', 'remote', 'remote.commands', 'conversationEvents']

/** Console diagnostics; set to true to debug the injected UI/hidden-state logic. */
const DEBUG = false
/** Bundle revision, logged at apply so a stale cached bundle is identifiable. */
const BUNDLE_REV = 4
function log(...parts: unknown[]): void {
  if (DEBUG) console.info('[rollback]', ...parts)
}
function warnOnce(key: string, ...parts: unknown[]): void {
  if (!DEBUG) return
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

/** One affected file in the preview dialog. */
interface PreviewFile {
  path: string
  action: '恢复' | '删除' | '跳过'
}

/** Parse the host `/rollback preview <n>` tagged-line text into entries. */
function parsePreview(text: string | undefined): PreviewFile[] {
  if (text === undefined || text === null) return []
  const out: PreviewFile[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*\[(恢复|删除|跳过)\]\s+(.+)$/u.exec(line)
    if (m === null) continue
    out.push({ action: m[1] as PreviewFile['action'], path: m[2]!.trim() })
  }
  return out
}

/**
 * Command executions this client itself dispatched (the Web button's preview
 * and execute RPCs). Their durable receipt cards are hidden by
 * {@link syncHiddenRpcRows}: a canceled preview must leave no trace, and a
 * confirmed rollback is already narrated by the rollback divider. Manual
 * `/rollback` invocations never enter this set, so their output stays visible.
 * The set persists in localStorage so hiding survives page reloads (the
 * command nodes themselves are durable log records).
 */
const RPC_HIDE_KEY = 'dsh-rollback.hidden-command-ids'
/**
 * `conversationContextKey(kind, id)` = `${kind.length}:${kind}${id}`; the
 * command node's kind is the 7-char string "command", so its keys start with
 * "7:command". Derive it so the prefix can never drift from the kind length.
 */
const COMMAND_KIND = 'command'
const COMMAND_KEY_PREFIX = COMMAND_KIND.length + ':' + COMMAND_KIND
const hiddenRpcIds: Set<string> = (() => {
  try { return new Set<string>(JSON.parse(localStorage.getItem(RPC_HIDE_KEY) ?? '[]') as string[]) }
  catch { return new Set<string>() }
})()

/** Track one command execution dispatched by this client (best-effort persistence). */
function trackRpcId(commandId: unknown): void {
  if (typeof commandId !== 'string' || commandId === '' || hiddenRpcIds.has(commandId)) return
  hiddenRpcIds.add(commandId)
  try { localStorage.setItem(RPC_HIDE_KEY, JSON.stringify([...hiddenRpcIds])) } catch { /* quota/private mode: session-only hiding */ }
  // The receipt card is usually ALREADY mounted here: the host appends
  // command/run–done before this RPC resolves, so the observer's pass ran
  // too early. Hide synchronously now, and once more after paint for a
  // commit still in flight — never rely on a later unrelated mutation.
  syncHiddenRpcRows()
  requestAnimationFrame(() => { syncHiddenRpcRows() })
}

/**
 * display:none the flow seats of button-dispatched command executions. A
 * display:none flex item is removed from layout entirely — merely rendering
 * null would leave a zero-height seat that still consumes the chat column's
 * 16px gaps and pushes the transcript apart.
 */
function syncHiddenRpcRows(): void {
  if (hiddenRpcIds.size === 0) return
  for (const el of document.querySelectorAll<HTMLElement>('[data-chat-flow-kind="command"][data-chat-flow-key]')) {
    const key = el.getAttribute('data-chat-flow-key') ?? ''
    if (!key.startsWith(COMMAND_KEY_PREFIX)) continue
    if (hiddenRpcIds.has(key.slice(COMMAND_KEY_PREFIX.length))) el.style.display = 'none'
  }
}

/** A `/rollback` command through the shipped Remote, unwrapping its envelope. */
function extCommand(ctx: any, sessionId: string, line: string): Promise<{ text?: string }> {
  // commands.execute is (agent, line, images, signal?) — the gateway requires
  // all three business args, so the no-attachments case is an empty array.
  return ctx.remote.commands.execute(sessionId, line, []).then((r: any) => {
    if (!r || r.ok === false) throw new Error(r?.error?.message ?? '命令执行失败')
    const exec = r.value
    if (exec === undefined || exec === null) throw new Error(`无法解析命令：${line}`)
    trackRpcId(exec.commandId)
    const result = exec.result
    if (result.kind === 'error') throw new Error(result.text ?? '命令执行失败')
    return { text: result.text }
  })
}

const CSS =
  // Same 28×28 chrome as the shared message action (copy) button.
  '.rbk-act{position:relative;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:6px;border:none;border-radius:28px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;}' +
  '.rbk-act:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);}' +
  '.rbk-act:disabled{cursor:default;opacity:.4;}' +
  '.rbk-act[data-tip]:hover::after{content:attr(data-tip);position:absolute;top:calc(100% + 6px);left:50%;transform:translateX(-50%);width:max-content;max-width:50vw;padding:3px 7px;border-radius:8px;background:var(--dsw-alias-tooltip-bg);color:var(--dsw-static-neutral-bluish-00);font-size:12px;line-height:18px;white-space:nowrap;pointer-events:none;z-index:1200;}' +
  '.rbk-overlay{position:fixed;inset:0;z-index:1300;display:flex;align-items:center;justify-content:center;background:rgb(0 0 0/.4);backdrop-filter:blur(2px);}' +
  '.rbk-panel{width:min(460px,calc(100vw - 32px));max-height:70vh;display:flex;flex-direction:column;border-radius:12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);box-shadow:0 16px 48px rgb(0 0 0/.35);color:var(--dsw-alias-label-primary);}' +
  '.rbk-head{padding:14px 16px 8px;font-size:14px;font-weight:700;}' +
  '.rbk-warn{padding:0 16px 8px;font-size:12px;color:var(--dsw-alias-label-secondary);}' +
  '.rbk-list{overflow-y:auto;padding:2px 8px;flex:1;}' +
  '.rbk-row{display:flex;align-items:center;gap:8px;width:100%;text-align:left;padding:6px 8px;border-radius:7px;border:none;background:transparent;color:var(--dsw-alias-label-primary);font-size:12.5px;cursor:pointer;}' +
  '.rbk-row:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 10%,transparent);}' +
  '.rbk-tag{flex:none;font-size:11px;padding:1px 6px;border-radius:5px;}' +
  '.rbk-tag-restore{background:color-mix(in srgb,var(--dsw-alias-state-success-primary, #3fb27f) 22%,transparent);color:var(--dsw-alias-state-success-primary, #3fb27f);}' +
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
  // Visible divider rendered from the durable `rollback/truncate` marker event.
  '.rbk-marker{display:flex;align-items:center;gap:10px;margin:12px 0;color:var(--dsw-alias-label-tertiary);font-size:12px;white-space:nowrap;}' +
  '.rbk-marker::before,.rbk-marker::after{content:"";flex:1;height:1px;background:var(--dsw-alias-border-l2);}' +
  '.rbk-num-add{color:var(--dsw-alias-state-success-primary, #3fb27f);}' +
  '.rbk-num-del{color:var(--dsw-alias-state-error-primary, #e5484d);}' +
  // Full-reset welcome: the only content left after an emptying rollback.
  '.rbk-hero{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;min-height:40vh;padding:40px 24px;text-align:center;}' +
  '.rbk-hero-icon{font-size:26px;line-height:1;color:var(--dsw-alias-label-tertiary);}' +
  '.rbk-hero-brand{color:var(--dsw-alias-label-secondary);opacity:.85;}' +
  '.rbk-hero-brand svg{width:44px;height:auto;}' +
  '.rbk-hero-title{font-size:16px;font-weight:600;color:var(--dsw-alias-label-primary);}' +
  '.rbk-hero-sub{font-size:13px;color:var(--dsw-alias-label-tertiary);}'

/**
 * The curved reply/return arrow (↩), stroke-drawn to match the built-in
 * outline icons' weight; injected as markup because the button lives at the
 * DOM level, outside React.
 */
const REPLY_SVG =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
  '<path d="M6.6 3.4 3 7l3.6 3.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<path d="M3 7h6.4c2.3 0 4 1.7 4 3.9V13" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>' +
  '</svg>'

/** Selector for one user-style bubble row (its own action row included). */
const USER_ROW = '[data-time-hover-root]:not([data-turn-tail]):not([data-pending-steering])'

/**
 * The turn NUMBER from a node's location. `ConversationLocation.turn` carries
 * the whole `TurnLocation` object whose own `.turn` is the number; a bare
 * number is tolerated defensively.
 */
function turnNoOf(loc: any): number | undefined {
  const t = loc?.turn
  const n = (t !== null && typeof t === 'object') ? t.turn : t
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 1 ? n : undefined
}

/**
 * The user/steering bubble turns in snapshot render order. Steering rows are
 * kept for index alignment but receive no button (their turn is in progress).
 */
function turnListOf(snapshot: any): { turn: number | undefined; steering: boolean }[] {
  const order = snapshot?.chat?.order
  const store = snapshot?.chat?.nodes
  if (!Array.isArray(order) || typeof store?.get !== 'function') {
    warnOnce('shape', 'unexpected snapshot shape',
      { hasSnapshot: snapshot !== undefined, hasChat: snapshot?.chat !== undefined, orderIsArray: Array.isArray(order), getOrderType: typeof store?.get })
    return []
  }
  const list: { turn: number | undefined; steering: boolean }[] = []
  for (const key of order) {
    const node = store.get(key)
    if (!node || (node.kind !== 'user' && node.kind !== 'steering')) continue
    list.push({ turn: turnNoOf(node.location), steering: node.kind === 'steering' })
  }
  return list
}

/**
 * One DOM sync pass: correlate user-style rows (document order) with the
 * snapshot's user/steering nodes (render order) and keep one button after each
 * row's Copy button.
 */
function syncButtons(snapshot: any, openRef: { current: (turn: number) => void }): void {
  // Disable every rollback button while a turn is running (model answering,
  // tools executing): a rollback mid-turn is unsafe (the turn's files are
  // still in flight). `running` stays true from prompt acceptance to turn/end,
  // so pausing (the Stop control) or finishing re-enables the buttons.
  const generating = snapshot?.running === true
  const infos = turnListOf(snapshot)
  const rows = document.querySelectorAll<HTMLElement>(USER_ROW)
  rows.forEach((row, i) => {
    const info = infos[i]
    const actionsRow = row.lastElementChild
    const copyBtn = actionsRow?.querySelector<HTMLElement>(':scope > button')
    if (!actionsRow || !copyBtn) {
      warnOnce('row', 'user row without a direct-child copy button', { hasActionsRow: actionsRow !== null, rowHtml: row.lastElementChild?.tagName })
      return
    }

    const usable = info !== undefined && !info.steering && info.turn !== undefined
    let btn = actionsRow.querySelector<HTMLElement>(':scope > [data-rbk-btn]')
    if (!usable) {
      btn?.remove()
      return
    }
    const turn = info.turn as number
    if (btn === null) {
      btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'rbk-act'
      btn.setAttribute('data-rbk-btn', 'true')
      btn.innerHTML = REPLY_SVG
      btn.addEventListener('click', () => {
        const t = Number(btn!.getAttribute('data-rbk-turn'))
        if (Number.isSafeInteger(t) && t >= 1) openRef.current(t)
      })
      copyBtn.after(btn)
    }
    btn.setAttribute('data-rbk-turn', String(turn))
    const label = '回退到本轮对话发起前'
    btn.setAttribute('data-tip', label)
    btn.setAttribute('aria-label', label)
    btn.disabled = generating
  })
  // Sweep buttons whose row left the DOM.
  document.querySelectorAll<HTMLElement>('[data-rbk-btn]').forEach(btn => {
    if (btn.closest(USER_ROW) === null) btn.remove()
  })
  const injected = document.querySelectorAll('[data-rbk-btn]').length
  const sig = rows.length + '/' + infos.length + '/' + injected
  if (sig !== (syncButtons as unknown as { sig?: string }).sig) {
    ;(syncButtons as unknown as { sig?: string }).sig = sig
    log('sync rows=' + rows.length + ' infos=' + infos.length + ' buttons=' + injected)
  }
}

interface DriverProps {
  preview: (turn: number) => Promise<PreviewFile[]>
  execute: (turn: number) => Promise<void>
  useSession: <T>(selector: (snapshot: any) => T) => T
  inputActions?: { setDraft(text: string): void; addImages?(ids: readonly string[]): boolean; pruneImages?(ids: readonly string[]): void }
  restoreImages?: (images: { name: string; mediaType: string; attachment: any }[]) => Promise<string[]>
}

/** The plain text of the turn-opening user prompt for one turn, from the snapshot. */
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

/** The image blocks of a turn-opening user prompt, for re-attaching to the composer. */
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
 * The conversation scrollport for one column, mirroring ChatView.scrollerOf:
 * the active host `[data-conversation-scroll]` when present, else the
 * view-local scroller (the column's parent). Used only to reset bottom-follow.
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
 * Visually delete every chat seat inside a rollback's shadowed range
 * (`[truncatedFromSeq, markerSeq)`): DSH keeps the durable log append-only,
 * but the user-facing transcript hides the rolled-back span outright. The
 * markers are durable, so the hiding re-applies after reloads/restarts.
 * After a FULL reset (`emptied`), everything before the hero marker is hidden
 * too — old dividers included — leaving only the welcome hero.
 */
function syncHides(snapshot: any): void {
  const chat = snapshot?.chat
  const order = chat?.order
  const store = chat?.nodes
  if (!Array.isArray(order) || typeof store?.get !== 'function') return

  // `ChatNodeSeat` stamps every node with `data-chat-flow-key` === its snapshot
  // key, so seats map 1:1 to `order`.
  const seatByKey = new Map<string, HTMLElement>()
  for (const el of document.querySelectorAll<HTMLElement>('[data-chat-flow-key]')) {
    const k = el.getAttribute('data-chat-flow-key')
    if (k !== null) seatByKey.set(k, el)
  }

  // Collect all rollback markers in ascending seq order.
  const markers: { from: number; seq: number; emptied: boolean }[] = []
  for (const key of order) {
    const node = store.get(key)
    if (node?.kind !== 'rollback-marker') continue
    const from = node?.data?.payload?.truncatedFromSeq
    const seq = typeof node?.data?.seq === 'number' ? node.data.seq : node?.anchorSeq
    if (typeof from !== 'number') continue
    markers.push({ from, seq, emptied: node?.data?.payload?.emptied === true })
  }
  if (markers.length === 0) return

  // Only the LATEST marker's divider/hero survives; every older divider is hidden.
  const latest = markers[markers.length - 1]!
  const latestSeq = latest.seq
  const emptied = latest.emptied

  const column = document.querySelector<HTMLElement>('[data-chat-flow=""]')
  if (emptied) {
    const loadMoreBtn = column === null ? null : column.querySelector(':scope > div:not([data-chat-flow-key]) button')
    if (loadMoreBtn !== null) loadMoreBtn.style.display = 'none'
  }

  // Real content after the latest marker?
  let hasContentAfter = false
  for (const key of order) {
    const node = store.get(key)
    const seq = node?.anchorSeq
    if (typeof seq === 'number' && seq > latestSeq && node?.kind !== 'rollback-marker') { hasContentAfter = true; break }
  }

  let hidden = 0
  for (const key of order) {
    const el = seatByKey.get(key)
    if (el === undefined) continue
    const node = store.get(key)
    const seq = node?.anchorSeq
    if (typeof seq !== 'number') continue

    if (node?.kind === 'rollback-marker') {
      const markerSeq = typeof node?.data?.seq === 'number' ? node.data.seq : node?.anchorSeq
      if (markerSeq !== latestSeq) { el.style.display = 'none'; hidden += 1; continue }
      // The latest marker: hero hides once content resumes; divider always shows.
      if (emptied) el.style.display = hasContentAfter ? 'none' : ''
      else el.style.display = ''
      continue
    }

    // Non-marker nodes: hide when inside ANY rollback marker's shadowed range
    // (messages rolled back by earlier rollbacks stay hidden too).
    const hide = markers.some(m => seq >= m.from && seq < m.seq)
    if (hide) { el.style.display = 'none'; hidden += 1 }
    else el.style.display = ''
  }

  const sig = (emptied ? 'f' : 'p') + ':' + latestSeq + ':' + (hasContentAfter ? 'restart' : 'clean') + ':' + hidden
  if (sig !== (syncHides as unknown as { sig?: string }).sig) {
    ;(syncHides as unknown as { sig?: string }).sig = sig
    log('syncHides ' + (emptied ? 'FULL-RESET' : 'PARTIAL') + ' marker@' + latestSeq + ' hidden=' + hidden + (hasContentAfter ? ' (content resumed)' : ''))
  }

  // When a NEW rollback marker lands, the transcript collapses to the divider
  // and the client's bottom-follow flag can be stranded "not at bottom", which
  // floats a useless "back to bottom" chip with nothing meaningful below it.
  // The collapse's native reflow → React re-render → chip mount happen over the
  // next few ticks, not synchronously, so clear it over a SHORT armed window
  // (re-pin the scrollport and click any visible chip) instead of once. The
  // window closes after ~400ms, so a later, deliberate reader scroll-up after a
  // rollback is left untouched.
  const scrollMeta = syncHides as unknown as { lastMarkerSeq?: number; clearUntil?: number }
  if (scrollMeta.lastMarkerSeq === undefined) {
    scrollMeta.lastMarkerSeq = latestSeq // first observation: baseline only, no reset
  } else if (scrollMeta.lastMarkerSeq !== latestSeq) {
    scrollMeta.lastMarkerSeq = latestSeq
    scrollMeta.clearUntil = Date.now() + 400
  }
  if (!hasContentAfter && scrollMeta.clearUntil !== undefined && Date.now() < scrollMeta.clearUntil) {
    const scrollport = scrollportOf(column)
    if (scrollport !== null) scrollport.scrollTop = scrollport.scrollHeight
    for (const btn of toBottomButtons(scrollport)) {
      try { btn.click() } catch { /* next heartbeat pass retries within the window */ }
    }
  }
}

/**
 * Invisible per-session driver: keeps the injected buttons in sync with the
 * conversation and hosts the confirmation dialog. Renders nothing into its
 * own seat.
 */
function RollbackDriver(props: DriverProps): React.ReactElement | null {
  const { preview, execute, useSession, inputActions, restoreImages } = props
  if (typeof useSession !== 'function') {
    warnOnce('useSession', 'props lack useSession', Object.keys(props))
    return null
  }
  const snapshotRef = React.useRef<any>(null)
  const ensureRef = React.useRef<() => void>(() => {})
  const snapshot = useSession((s: any) => s)

  React.useEffect(() => {
    snapshotRef.current = snapshot
    ensureRef.current()
  })

  const [dialogTurn, setDialogTurn] = React.useState<number | null>(null)
  const [files, setFiles] = React.useState<PreviewFile[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)

  const openDialog = (turn: number) => {
    setDialogTurn(turn)
    setFiles(null)
    setError(null)
    preview(turn).then(setFiles, (e: unknown) => setError(msg(e)))
  }
  const openRef = React.useRef(openDialog)
  openRef.current = openDialog

  React.useEffect(() => {
    log('driver mounted')
    let raf = 0
    const ensure = () => {
      try { syncButtons(snapshotRef.current, openRef) } catch (e) { warnOnce('sync-buttons', 'syncButtons threw', e) }
      try { syncHides(snapshotRef.current) } catch (e) { warnOnce('sync-hides', 'syncHides threw', e) }
      try { syncHiddenRpcRows() } catch (e) { warnOnce('sync-rpc-rows', 'syncHiddenRpcRows threw', e) }
    }
    ensureRef.current = () => {
      if (raf) cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => { raf = 0; ensure() })
    }
    ensure()
    const obs = new MutationObserver(() => ensureRef.current())
    obs.observe(document.body, { childList: true, subtree: true })
    return () => {
      obs.disconnect()
      if (raf) cancelAnimationFrame(raf)
      document.querySelectorAll('[data-rbk-btn]').forEach(b => b.remove())
    }
  }, [])

  const confirm = () => {
    if (dialogTurn === null) return
    const turn = dialogTurn
    setBusy(true)
    setError(null)
    execute(turn).then(
      () => {
        setBusy(false)
        setDialogTurn(null)
        // Replace (not append) the composer content with the rolled-back turn's
        // own text + images, so rolling back message A then B leaves exactly B.
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

  if (dialogTurn === null) return null
  const label = '回退到本轮对话发起前'
  return createPortal(
    React.createElement('div', {
      className: 'rbk-overlay',
      onMouseDown: (ev: React.MouseEvent) => { if (ev.target === ev.currentTarget) setDialogTurn(null) },
    },
      React.createElement('div', { className: 'rbk-panel', role: 'dialog', 'aria-label': '回退确认' },
        React.createElement('div', { className: 'rbk-head' }, label),
        React.createElement('div', { className: 'rbk-warn' }, '此操作不可撤销，将恢复本轮及之后受影响的工作区文件并截断模型上下文。'),
        React.createElement('div', { className: 'rbk-list' },
          files === null && error === null
            ? React.createElement('div', { className: 'rbk-empty' }, '正在分析受影响文件…')
            : null,
          files !== null && files.length === 0
            ? React.createElement('div', { className: 'rbk-empty' }, '本轮及之后无文件变更。')
            : null,
          files !== null
            ? files.map(f => React.createElement('button', {
                key: f.path, type: 'button', className: 'rbk-row',
                title: '在编辑器中打开 ' + f.path,
              },
                React.createElement('span', { className: 'rbk-tag rbk-tag-' + (f.action === '恢复' ? 'restore' : f.action === '删除' ? 'delete' : 'skip') }, f.action),
                React.createElement('span', { className: 'rbk-path' }, f.path),
              ))
            : null,
          error !== null
            ? React.createElement('div', { className: 'rbk-err' }, error)
            : null,
        ),
        React.createElement('div', { className: 'rbk-foot' },
          React.createElement('button', { type: 'button', className: 'rbk-cancel', disabled: busy, onClick: () => setDialogTurn(null) }, '取消'),
          React.createElement('button', { type: 'button', className: 'rbk-confirm', disabled: busy, onClick: confirm }, busy ? '回退中…' : '确认回退'),
        ),
      ),
    ),
    document.body,
  )
}

/**
 * The durable rollback divider: one Context per empty-content assistant/message
 * surface replacement that carries the inert `message.rollback` facts. It is
 * the ONLY load-safe durable signal an out-of-repo plugin may write (custom
 * event types are refused by the persistence read path), and it still adds
 * nothing to the model (empty assistant derives to null).
 */
const markerDefinition = {
  kind: 'rollback-marker',
  target: 'chat',
  match: (event: any) => {
    const message = event?.data?.message
    if (event?.type !== 'assistant/message' || event?.surfaceOp === 'append') return null
    if (message?.rollback === undefined || !Array.isArray(message.content) || message.content.length !== 0) return null
    return { id: String(event.seq), role: 'start' }
  },
  start: (_context: any, match: any) => ({ seq: match.event.seq, payload: match.event.data.message.rollback }),
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

/**
 * The divider view: "↩ 已回退到本轮发起前 · 恢复 X / 删除 Y 个文件" —
 * X in green, Y in red. `data-rbk-marker` anchors the seat-hiding pass.
 */
function RollbackMarkerView({ node }: any): any {
  const d = node?.data?.payload ?? {}
  // A full reset (rollback to before the first turn) clears the transcript:
  // render a centered "back to the start" welcome instead of the invisible
  // divider, so the empty conversation reads as a fresh chat. The `data-rbk-
  // marker` attribute still anchors the seat-hiding pass.
  if (d.emptied === true) {
    return React.createElement('div', { className: 'rbk-hero', role: 'status', 'data-rbk-marker': 'true' },
      React.createElement('div', { className: 'rbk-hero-brand' },
        React.createElement(FishLogo, { size: 44 }),
      ),
      React.createElement('div', { className: 'rbk-hero-title' }, '已回退到对话发起前'),
      React.createElement('div', { className: 'rbk-hero-sub' }, '对话与文件已恢复 · 在下方输入框继续'),
    )
  }
  const files = (d.restoredCount ?? 0) + (d.deletedCount ?? 0)
  return React.createElement('div', { className: 'rbk-marker', role: 'separator', 'data-rbk-marker': 'true' },
    '↩ 已回退到本轮发起前',
    files > 0
      ? React.createElement(React.Fragment, null, ' · ',
          React.createElement('span', { className: 'rbk-num-add' }, '恢复 ' + (d.restoredCount ?? 0)),
          ' / ',
          React.createElement('span', { className: 'rbk-num-del' }, '删除 ' + (d.deletedCount ?? 0)),
          ' 个文件')
      : ' · 对话已截断',
  )
}

/** Client plugin body: stylesheet + the invisible per-session driver entry. */
export function apply(ctx: any): void {
  log('client apply: bundle loaded rev', BUNDLE_REV)
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = 'rollback'
    style.textContent = CSS
    document.head.appendChild(style)
    return () => style.remove()
  })

  // Render the durable rollback divider at its log position.
  ctx.conversationEvents.register(markerDefinition)
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'rollback-marker' },
    RollbackMarkerView,
  ))

  ctx.slots.inject('conversation.input.dock', () => {
    log('dock entry registering')
    const dispose = ctx.slots.register({
      name: 'conversation.input.dock',
      id: 'rollback-driver',
      inject: (sessionId: string) => ({
        preview: async (turn: number) => {
          const r = await extCommand(ctx, sessionId, '/rollback preview ' + turn)
          return parsePreview(r.text)
        },
        execute: async (turn: number) => {
          await extCommand(ctx, sessionId, '/rollback ' + turn)
        },
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