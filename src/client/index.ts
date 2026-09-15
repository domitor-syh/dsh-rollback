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

/** Required services: slots, the `commands` Remote, the conversation node registry, and locale. */
export const inject = ['slots', 'remote', 'remote.commands', 'conversationEvents', 'locale', 'workspaces']

/** Console diagnostics; set to true to debug the client logic. */
const DEBUG = false
/** Bundle revision, logged at apply so a stale cached bundle is identifiable. */
const BUNDLE_REV = 5
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

/** Dictionary namespace owned by this plugin. */
const NS = 'rollback'

const zh = {
  'action.label': '回退到本轮对话发起前',
  'dialog.title': '回退到本轮对话发起前',
  'dialog.aria': '回退确认',
  'dialog.warning': '此操作不可撤销，将恢复本轮及之后受影响的工作区文件并截断模型上下文。',
  'dialog.analyzing': '正在分析受影响文件…',
  'dialog.noFiles': '本轮及之后无文件变更。',
  'dialog.openInEditor': '在编辑器中打开',
  'dialog.cancel': '取消',
  'dialog.confirm': '确认回退',
  'dialog.busy': '回退中…',
  'tag.restore': '恢复',
  'tag.delete': '删除',
  'tag.skip': '跳过',
} satisfies Record<string, string>

const en: Record<keyof typeof zh, string> = {
  'action.label': 'Roll back to before this turn',
  'dialog.title': 'Roll back to before this turn',
  'dialog.aria': 'Rollback confirmation',
  'dialog.warning': 'This action is irreversible. It will restore workspace files affected by this turn and later, and truncate the model context.',
  'dialog.analyzing': 'Analyzing affected files…',
  'dialog.noFiles': 'No file changes in this turn and later.',
  'dialog.openInEditor': 'Open in editor',
  'dialog.cancel': 'Cancel',
  'dialog.confirm': 'Roll back',
  'dialog.busy': 'Rolling back…',
  'tag.restore': 'restore',
  'tag.delete': 'delete',
  'tag.skip': 'skip',
}

type RollbackKey = keyof typeof zh

/** One affected file in the preview dialog, normalized to an internal action. */
interface PreviewFile {
  path: string
  action: 'restore' | 'delete' | 'skip'
}

/** Parse the host `/rollback preview <n>` tagged-line text into entries. */
function parsePreview(text: string | undefined): PreviewFile[] {
  if (text === undefined || text === null) return []
  const out: PreviewFile[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*\[(恢复|删除|跳过|restore|delete|skip)\]\s+(.+)$/ui.exec(line)
    if (m === null) continue
    const raw = m[1]!.toLowerCase()
    const action = raw === 'restore' || raw === '恢复' ? 'restore' as const
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
  if (hiddenRpcIds.size === 0) return
  for (const el of document.querySelectorAll<HTMLElement>('[data-chat-flow-kind="command"][data-chat-flow-key]')) {
    const key = el.getAttribute('data-chat-flow-key') ?? ''
    if (!key.startsWith(COMMAND_KEY_PREFIX)) continue
    if (hiddenRpcIds.has(key.slice(COMMAND_KEY_PREFIX.length))) el.style.display = 'none'
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
  '.rbk-confirm:disabled{opacity:.6;cursor:wait;}'

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
 * Rollbacks this client executed whose truncation marker has not landed yet.
 *
 * The host commits the marker at the next turn's `agent/pre-step` (the empty
 * assistant message DSH accepts only inside an open step), so between the click
 * and the next prompt the durable marker does not exist and its hide rule cannot
 * apply. The client therefore hides the rolled-back seats by turn number itself —
 * otherwise a rollback would look like it did nothing until the next message.
 * Session-scoped and memory-only: the durable log stays the single source of
 * truth. `afterSeq` is the transcript tail when the rollback ran, so only the
 * marker produced by THIS rollback ends the pending state.
 */
const pendingRollbacks = new Map<string, { fromTurn: number; afterSeq: number }>()

/** Highest surface seq currently rendered (the transcript tail), or -1. */
function tailSeqOf(snapshot: any): number {
  const order = snapshot?.chat?.order
  const store = snapshot?.chat?.nodes
  if (!Array.isArray(order) || typeof store?.get !== 'function') return -1
  let max = -1
  for (const key of order) {
    const seq = store.get(key)?.anchorSeq
    if (typeof seq === 'number' && seq > max) max = seq
  }
  return max
}

/**
 * Visually hide every chat seat inside a rollback's shadowed range, and reset
 * bottom-follow over a short armed window after a NEW marker lands. Durable-log
 * side effect: hidden seats need no slot because DSH renders them from events
 * this plugin declared non-surface.
 */
function syncHides(snapshot: any, sessionId?: string): void {
  const chat = snapshot?.chat
  const order = chat?.order
  const store = chat?.nodes
  if (!Array.isArray(order) || typeof store?.get !== 'function') return

  const seatByKey = new Map<string, HTMLElement>()
  for (const el of document.querySelectorAll<HTMLElement>('[data-chat-flow-key]')) {
    const k = el.getAttribute('data-chat-flow-key')
    if (k !== null) seatByKey.set(k, el)
  }

  const markers: { from: number; seq: number; emptied: boolean; fromTurn: number | null }[] = []
  for (const key of order) {
    const node = store.get(key)
    if (node?.kind !== 'rollback-marker') continue
    const from = node?.data?.payload?.truncatedFromSeq
    const seq = typeof node?.data?.seq === 'number' ? node.data.seq : node?.anchorSeq
    if (typeof from !== 'number') continue
    const payload = node?.data?.payload ?? {}
    markers.push({
      from,
      seq,
      emptied: payload.emptied === true,
      fromTurn: typeof payload.fromTurn === 'number' ? payload.fromTurn : null,
    })
  }

  // A pending rollback ends when ITS OWN marker lands (same fromTurn, appended
  // after the transcript tail we recorded) — from then on the marker's bounded
  // seq rule owns the hiding.
  const pending = sessionId === undefined ? undefined : pendingRollbacks.get(sessionId)
  let pendingTurn: number | undefined
  if (pending !== undefined) {
    if (markers.some(m => m.fromTurn === pending.fromTurn && m.seq > pending.afterSeq)) {
      pendingRollbacks.delete(sessionId!)
    } else {
      pendingTurn = pending.fromTurn
    }
  }

  if (markers.length === 0 && pendingTurn === undefined) return

  const latest = markers.length > 0 ? markers[markers.length - 1]! : null
  const latestSeq = latest === null ? -1 : latest.seq
  const emptied = latest !== null && latest.emptied

  const column = document.querySelector<HTMLElement>('[data-chat-flow=""]')
  if (emptied) {
    const loadMoreBtn = column === null ? null : column.querySelector(':scope > div:not([data-chat-flow-key]) button')
    if (loadMoreBtn !== null) loadMoreBtn.style.display = 'none'
  }

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
      // The marker renders nothing; keep its (empty) seat out of the flow.
      el.style.display = 'none'
      hidden += 1
      continue
    }
    // Before its marker lands, a pending rollback hides the seats of the turns
    // it targeted: the marker will name the same fromTurn and take over.
    const nodeTurn = turnNoOf(node?.location) ?? (typeof node?.data?.turn === 'number' ? node.data.turn : undefined)
    const pendingHide = pendingTurn !== undefined && typeof nodeTurn === 'number' && nodeTurn >= pendingTurn
    const hide = pendingHide || markers.some(m => seq >= m.from && seq < m.seq)
    if (hide) { el.style.display = 'none'; hidden += 1 }
    else el.style.display = ''
  }

  const sig = (emptied ? 'f' : 'p') + ':' + latestSeq + ':' + (hasContentAfter ? 'restart' : 'clean') + ':' + hidden
  if (sig !== (syncHides as unknown as { sig?: string }).sig) {
    ;(syncHides as unknown as { sig?: string }).sig = sig
    log('syncHides ' + (emptied ? 'FULL-RESET' : 'PARTIAL') + ' marker@' + latestSeq + ' hidden=' + hidden + (hasContentAfter ? ' (content resumed)' : ''))
  }

  // A rollback collapses the transcript: seats vanish, DSH's own bottom-follow
  // concludes the viewport left the bottom, and its "back to bottom" chip pops
  // out of the collapse itself. Arm a short window per collapse — keyed both on
  // the click-time pending hide and on the durable marker when it lands, and on
  // the FIRST of either in a session — then pin the viewport to the bottom and
  // re-engage follow by pressing the chip.
  const collapseKey = latest !== null ? latest.seq : pendingTurn !== undefined ? -1 : undefined
  const scrollMeta = syncHides as unknown as { collapseKey?: number; clearUntil?: number }
  if (collapseKey !== undefined && scrollMeta.collapseKey !== collapseKey) {
    scrollMeta.collapseKey = collapseKey
    scrollMeta.clearUntil = Date.now() + 800
  }
  const armed = scrollMeta.clearUntil !== undefined && Date.now() < scrollMeta.clearUntil
  if (armed && (latest === null || !hasContentAfter)) {
    const scrollport = scrollportOf(column)
    if (scrollport !== null) scrollport.scrollTop = scrollport.scrollHeight
    for (const btn of toBottomButtons(scrollport)) {
      try { btn.click() } catch { /* next pass retries */ }
    }
  }
}

/** Module-level bridge: the assistant action opens the single dock-hosted dialog. */
let openRollbackDialog: ((turn: number) => void) | null = null

/** The rollback action rendered on each finalized assistant message's action strip. */
function RollbackAction({ messageId, useSession, t }: any): React.ReactElement | null {
  if (typeof useSession !== 'function') return null
  const snapshot = useSession((s: any) => s)
  const running = snapshot?.running === true
  const turn = React.useMemo(() => turnForMessageId(snapshot, messageId), [snapshot, messageId])
  const disabled = running || turn === undefined
  const button = React.createElement('button', {
    type: 'button',
    className: 'rbk-act',
    'aria-label': t('action.label'),
    disabled,
    onClick: () => { if (turn !== undefined && openRollbackDialog !== null) openRollbackDialog(turn) },
  }, React.createElement(ReplyIcon))
  return React.createElement(Tooltip, { label: t('action.label'), side: 'bottom' }, button)
}

interface DriverProps {
  preview: (turn: number) => Promise<PreviewFile[]>
  execute: (turn: number) => Promise<void>
  openFile: (path: string) => Promise<void>
  /** Session this driver is mounted for (the pending-rollback hide is keyed by it). */
  sessionId?: string
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
function RollbackDriver({ preview, execute, openFile, sessionId, useSession, inputActions, restoreImages, t }: DriverProps): React.ReactElement | null {
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
    let raf = 0
    const ensure = () => {
      try { syncHides(snapshotRef.current, sessionId) } catch (e) { warnOnce('sync-hides', 'syncHides threw', e) }
      try { syncHiddenRpcRows() } catch (e) { warnOnce('sync-rpc-rows', 'syncHiddenRpcRows threw', e) }
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
        // The host restores files right away but appends the truncation marker
        // only at the next turn's first step, so hide the rolled-back seats now
        // (the marker will take over and clear this entry).
        if (sessionId !== undefined) pendingRollbacks.set(sessionId, { fromTurn: turn, afterSeq: tailSeqOf(snapshotRef.current) })
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

  if (dialogTurn === null) return null
  return createPortal(
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
          files !== null && files.length === 0
            ? React.createElement('div', { className: 'rbk-empty' }, t('dialog.noFiles'))
            : null,
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
          React.createElement('button', { type: 'button', className: 'rbk-confirm', disabled: busy, onClick: confirm }, busy ? t('dialog.busy') : t('dialog.confirm')),
        ),
      ),
    ),
    document.body,
  )
}

/**
 * The message object a rollback marker rides on, for both marker generations:
 * current builds append a `user/message` (the data IS the message — the only
 * surface replacement DSH accepts outside an open step), while builds up to
 * 0.1.0 appended an empty `assistant/message` (`data.message`).
 */
function markerMessageOf(event: any): any {
  if (event?.type === 'user/message') return event.data
  if (event?.type === 'assistant/message') return event?.data?.message
  return undefined
}

/** The durable rollback divider, driven by the inert `message.rollback` facts. */
const markerDefinition = {
  kind: 'rollback-marker',
  target: 'chat',
  match: (event: any) => {
    if (markerMessageOf(event)?.rollback === undefined) return null
    return { id: String(event.seq), role: 'start' }
  },
  start: (_context: any, match: any) => ({ seq: match.event.seq, payload: markerMessageOf(match.event)?.rollback }),
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

/** The divider/hero view for the rolled-back range — intentionally nothing.
 *
 * The marker node still exists (it is the durable anchor `syncHides` reads the
 * truncated range from), but the rolled-back range must leave NO trace in the
 * transcript: the model's history has nothing in its place, so the UI shows
 * nothing either. */
function RollbackMarkerView(): any {
  return null
}

/** Client plugin body: stylesheet, dictionaries, the assistant action, and the driver. */
export function apply(ctx: any): void {
  log('client apply: bundle loaded rev', BUNDLE_REV)
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = 'rollback'
    style.textContent = CSS
    document.head.appendChild(style)
    return () => style.remove()
  })

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'rollback: dictionaries')

  // The marker node is registered as an event definition only: it is the durable
  // anchor `syncHides` reads the truncated range from, and it renders nothing —
  // a rollback leaves no divider, exactly like it leaves nothing in the model's
  // history.
  ctx.conversationEvents.register(markerDefinition)

  ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register(
    { name: 'conversation.chat.assistant-actions', id: 'rollback', order: 20, locale: NS },
    RollbackAction,
  ))

  ctx.slots.inject('conversation.input.dock', () => {
    log('dock entry registering')
    const dispose = ctx.slots.register({
      name: 'conversation.input.dock',
      id: 'rollback-driver',
      locale: NS,
      inject: (sessionId: string) => ({
        sessionId,
        preview: async (turn: number) => {
          const r = await extCommand(ctx, sessionId, '/rollback preview ' + turn)
          return parsePreview(r.text)
        },
        execute: async (turn: number) => {
          await extCommand(ctx, sessionId, '/rollback ' + turn)
        },
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