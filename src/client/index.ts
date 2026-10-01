/**
 * Rollback plugin, browser half — a per-message "回退" action on the
 * finalized assistant message's IconActions strip.
 *
 * The button rides DSH's official `conversation.chat.assistant-actions` slot
 * (the same surface the Like/Dislike feedback uses), so the placement and
 * life-cycle are framework-managed — the button itself needs no DOM injection and
 * no observer. Clicking opens the affected-files dialog (host RPC through the
 * shipped `commands` Remote) with an irreversible confirm.
 *
 * The remaining DOM-touching helpers (`syncHides`, `syncHiddenRpcRows`) are not
 * button placement: they hide chat seats DSH renders but this plugin rolls
 * back, and suppress the receipt cards of button-dispatched command calls —
 * both are durable-log side effects with no official slot. Those passes DO run
 * under a `MutationObserver` (see the driver effect below): hiding is an
 * attribute on a seat React owns, so a re-render that replaces the element would
 * otherwise bring a rolled-back row back, and the observer re-runs the pass on
 * every child-list change rather than trusting the previous reading.
 *
 * @module @domitor-syh/dsh-rollback/client
 */

import * as React from 'react'
import { createPortal } from 'react-dom'
import { FishLogo, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { footerEntryNeeded, isTurnTailShapeRejection, otherTurnTailShape, turnTailRegistration, type TurnTailShape } from '../core/turn-entry.ts'
import { isRollbackMarkerSource } from '../core/truncation-plan.ts'
import { oldestTurnOf, turnsOf } from '../core/rollback-guard.ts'

/**
 * Required services: slots, the `commands` Remote, and locale.
 *
 * The conversation node registry is deliberately NOT named here. 0.1.5 moved it
 * to `uiConversation.events` and no longer provides `conversationEvents` at all,
 * and cordis reads a plain array as a REQUIRED set: a name no service ever
 * provides parks this fiber in "pending" forever, so `apply()` never runs and the
 * plugin is invisible with no error anywhere — the exact silence this file keeps
 * having to design against. The registry is therefore acquired dynamically and
 * the result is audited (see `registerMarkerDefinition`, `auditContracts`).
 *
 * `workspaces` used to be named here for the preview dialog's "open in editor"
 * rows. Those rows are a read-out now, so the requirement is gone — and dropping
 * it is the safe direction: one fewer name that a future core could retire and
 * park this fiber on.
 */
export const inject = ['slots', 'remote', 'remote.commands', 'locale']

/** Console diagnostics; set to true to debug the client logic. */
const DEBUG = false
/** Bundle revision — always reported once at apply, so a stale cached bundle is
 * identifiable in the console instead of looking like "the fix did nothing". */
const BUNDLE_REV = 28
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

/**
 * Report once per key a broken framework contract — the loud half of
 * {@link warnOnce}, for conditions where the plugin cannot work at all.
 * @param key - the once-per-key identity of this report.
 * @param parts - the message and any values worth printing.
 */
function errorOnce(key: string, ...parts: unknown[]): void {
  const seen = errorOnce as unknown as Record<string, boolean>
  if (seen[key] === true) return
  seen[key] = true
  console.error('[rollback]', ...parts)
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
  'dialog.cancel': '取消',
  'dialog.confirm': '确认回退',
  'dialog.busy': '回退中…',
  'tag.restore': '恢复',
  'tag.recover': '找回',
  'tag.delete': '删除',
  'tag.skip': '跳过',
  'hero.title': '已回退到对话发起前',
  'hero.sub': '对话与文件已恢复 · 在下方输入框继续',
  // The turn picker's copy. There is no `command.*` pair any more: the menu row is
  // the host command's, and its description carries both languages itself.
  'picker.previous': '回退到上一轮',
  'picker.turn': '第 {turn} 轮',
  'picker.placeholder': '搜索轮次',
  'picker.empty': '当前会话没有可回退的轮次',
  'picker.noResults': '没有匹配的轮次',
} satisfies Record<string, string>

const en: Record<keyof typeof zh, string> = {
  'action.label': 'Roll back to before this turn',
  'action.running': 'This turn is still running: pause it or wait for it to finish',
  'dialog.title': 'Roll back to before this turn',
  'dialog.aria': 'Rollback confirmation',
  'dialog.warning': 'This action is irreversible. It will restore workspace files affected by this turn and later, and truncate the model context.',
  'dialog.analyzing': 'Analyzing affected files…',
  'dialog.cancel': 'Cancel',
  'dialog.confirm': 'Roll back',
  'dialog.busy': 'Rolling back…',
  'tag.restore': 'restore',
  'tag.recover': 'recover',
  'tag.delete': 'delete',
  'tag.skip': 'skip',
  'hero.title': 'Rolled back to the start',
  'hero.sub': 'Conversation and files restored · continue below',
  'picker.previous': 'Roll back the previous turn',
  'picker.turn': 'Turn {turn}',
  'picker.placeholder': 'Search turns',
  'picker.empty': 'No turn in this session can be rolled back',
  'picker.noResults': 'No matching turn',
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
/**
 * Longest text a hidden row may have. Conversation content is long; a command receipt is
 * not. This guard exists because a text-based matcher once hid assistant messages, and
 * the mutation observer then hid another one on every re-render.
 */
const MAX_RECEIPT_CHARS = 500
/**
 * The qualifier that excludes rows the framework has folded away.
 *
 * 0.1.5 collapses rows with `hidden="until-found"` (ui-chat's `useSearchableHidden`)
 * and its own row sweeps all say `:not([hidden])`. A folded row is not part of the
 * visible transcript, so a sweep that counted it would answer "what is on screen"
 * from rows the user cannot see — which is what the rollback passes and the
 * welcome-hero decision read. The attribute is the plain `hidden` attribute, so on
 * 0.1.1 (which folds nothing) the qualifier matches every row and both versions
 * behave identically.
 */
const VISIBLE_ROW = ':not([hidden])'
/** Every chat seat the plugin may act on. */
const FLOW_ROW_SELECTOR = '[data-chat-flow-key]' + VISIBLE_ROW
/** Every command receipt seat the plugin may act on. */
/**
 * Command receipts, INCLUDING rows DSH folded away with `hidden`.
 *
 * Deliberately unqualified: the plugin's own receipts must stay hidden even when the
 * browser's find-in-page reveals the folded group they sit in. The emptiness decision
 * is the opposite case — a folded row must not count as standing content — so it keeps
 * the qualified {@link FLOW_ROW_SELECTOR}.
 */
const FLOW_COMMAND_ROW_SELECTOR = '[data-chat-flow-kind="command"][data-chat-flow-key]'
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
  // Kind AND identity, both read from the seat itself. A receipt is a `command`
  // seat by definition, so restricting the sweep to that kind makes it
  // impossible for this pass to hide conversation content even if `hiddenRpcIds`
  // were polluted by a stale bundle or an id arrived short enough to be a suffix
  // of another key: no content node is ever `data-chat-flow-kind="command"`.
  for (const el of document.querySelectorAll<HTMLElement>(FLOW_COMMAND_ROW_SELECTOR)) {
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
  for (const el of document.querySelectorAll<HTMLElement>(FLOW_COMMAND_ROW_SELECTOR)) {
    const key = el.getAttribute('data-chat-flow-key') ?? ''
    if (key.startsWith(COMMAND_KEY_PREFIX)) seen.add(key.slice(COMMAND_KEY_PREFIX.length))
  }
  pendingCommandSeen = seen
}

/** Hide command receipts that appeared since {@link markPendingCommandDispatch}. */
function syncPendingRpcRow(): void {
  if (pendingCommandSeen === null) return
  let caught = false
  for (const el of document.querySelectorAll<HTMLElement>(FLOW_COMMAND_ROW_SELECTOR)) {
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

/**
 * Rebuild draft attachments for the images a rolled-back turn had, so the composer
 * holds them again.
 *
 * Two generations of the same idea:
 *
 * - **0.1.5**: durable bytes are read with `uiConversation.imageUrl(sessionId, ref)`
 *   (the same loader the transcript images use; it hands back an object URL over
 *   the stored bytes), turned into a browser `File`, and registered as runtime
 *   draft attachments with `conversation.createDrafts(sessionId, files)`. That is
 *   exactly how first-party code attaches a picked or pasted file, and it is what
 *   makes the bytes ride the next prompt instead of a client-side preview.
 *   `resolveImage` and `createDraftImages` are gone in 0.1.5, hence the split.
 * - **0.1.1**: `conversation.resolveImage` + `conversation.createDraftImages`, kept
 *   verbatim so the older build behaves exactly as it did.
 *
 * The two are alternatives, not a chain, and neither is guessed: a build whose
 * verbs cannot be found is reported once instead of quietly restoring nothing.
 * A single image that fails (an unreadable attachment, an unsupported type, a
 * browser that refuses the fetch) is skipped and the rest still restore.
 * @param ctx - the plugin's own context.
 * @param sessionId - the session the images belong to.
 * @param attachments - the rolled-back turn's durable attachments, in order.
 * @returns the created draft ids plus the draft descriptors they came from, so a
 *   refused append can be released through the first-party face.
 */
async function restoreDraftAttachments(
  ctx: any,
  sessionId: string,
  images: { name: string; mediaType: string; attachment: any }[],
): Promise<{ ids: string[]; descriptors: unknown[] }> {
  const conversation = ctx?.get?.('conversation')
  const uiConversation = ctx?.get?.('uiConversation')
  if (conversation !== undefined && typeof conversation.createDrafts === 'function'
    && uiConversation !== undefined && typeof uiConversation.imageUrl === 'function') {
    const ids: string[] = []
    const descriptors: unknown[] = []
    for (const img of images) {
      try {
        const url: string = await uiConversation.imageUrl(sessionId, img.attachment)
        const resp = await fetch(url)
        const blob = await resp.blob()
        const file = new File([blob], img.name || 'attachment', { type: blob.type || img.mediaType || 'application/octet-stream' })
        const drafts = conversation.createDrafts(sessionId, [file])
        const id = drafts?.[0]?.id
        if (typeof id === 'string' && id !== '') {
          ids.push(id)
          descriptors.push(drafts[0])
        }
      } catch { /* skip a failed image */ }
    }
    // The descriptors, not just the ids: releasing a refused draft needs the object the
    // FIRST-PARTY face takes (`conversation.releaseDraftAttachments(drafts)` — the same
    // call the product's own composer makes), and that is more reliable than this
    // plugin's optional `inputActions` release verb.
    return { ids, descriptors }
  }
  if (conversation !== undefined && typeof conversation.resolveImage === 'function'
    && typeof conversation.createDraftImages === 'function') {
    const ids: string[] = []
    const descriptors: unknown[] = []
    for (const img of images) {
      try {
        const url: string = await conversation.resolveImage(sessionId, img.attachment)
        const resp = await fetch(url)
        const blob = await resp.blob()
        const file = new File([blob], img.name || 'attachment', { type: blob.type || img.mediaType || 'application/octet-stream' })
        const drafts = conversation.createDraftImages([file])
        if (drafts !== null && drafts[0] !== undefined && drafts[0].id !== undefined) {
          ids.push(drafts[0].id)
          descriptors.push(drafts[0])
        }
      } catch { /* skip a failed image */ }
    }
    return { ids, descriptors }
  }
  warnOnce(
    'restore-images-api',
    'no attachment-restore API is available: neither conversation.createDrafts + uiConversation.imageUrl (0.1.5) nor conversation.resolveImage + createDraftImages (0.1.1) exists, so the rolled-back turn\'s attachments cannot be re-attached',
  )
  return { ids: [], descriptors: [] }
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
  '.rbk-act{position:relative;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:5px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;}' +
  '.rbk-act:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);}' +
  '.rbk-act:disabled{cursor:default;opacity:.4;}' +
  // The box stays 28px because that is the action row's own height
  // (`.xD_KDq_actions{height:28px}`) and a taller button would stick out of it. The
  // GLYPH is what grows: 17px is the official size for the same button when the row
  // is the end-of-turn variant (`.xD_KDq_actions[data-clock=end] .xD_KDq_action
  // svg{width:17px}`), so this is a size the design already uses rather than an
  // invented one. Padding drops to 5px to make room inside the fixed box.
  '.rbk-act svg{width:17px;height:17px;}' +
  '.rbk-overlay{position:fixed;inset:0;z-index:1300;display:flex;align-items:center;justify-content:center;background:rgb(0 0 0/.4);backdrop-filter:blur(2px);}' +
  // `--dsw-radius-panel` (28px) is the official dialog radius: the primitives'
  // Modal uses it (`Modal.module.css:44`) and so does the composer's own card
  // (`.RlGAzG_card` in dsh-client-ui-conversation), which is the input box this
  // dialog sits under. It replaces a hand-picked 12px.
  '.rbk-panel{width:min(460px,calc(100vw - 32px));max-height:70vh;display:flex;flex-direction:column;border-radius:var(--dsw-radius-panel);border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);box-shadow:0 16px 48px rgb(0 0 0/.35);color:var(--dsw-alias-label-primary);}' +
  '.rbk-head{padding:14px 16px 8px;font-size:14px;font-weight:700;}' +
  '.rbk-warn{padding:0 16px 8px;font-size:12px;color:var(--dsw-alias-label-secondary);}' +
  // `overflow: hidden auto` rather than `overflow-y: auto`: when one axis is not
  // `visible`, CSS computes the other axis's `visible` to `auto` too, so a vertical
  // scroller alone still produced a horizontal bar under the file list whenever a row
  // came out a pixel wide. The intent is vertical-only, so the x axis says so.
  '.rbk-list{overflow:hidden auto;padding:2px 8px;flex:1;}' +
  // The rows are a READ-OUT, not a control: no hover, no pointer, no click.
  '.rbk-row{display:flex;align-items:center;gap:8px;width:100%;text-align:left;padding:6px 8px;border-radius:var(--dsw-radius-sm);border:none;background:transparent;color:var(--dsw-alias-label-primary);font-size:12.5px;}' +
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

/**
 * The curved reply/return arrow (↩) — this plugin's mark, used both on the
 * rollback buttons and as the `/rollback` entry's icon in the command menu.
 *
 * Drawn to the primitives' own convention so it sits beside theirs without
 * reading heavy: a 16-unit viewBox like every `Icon*Outline*` there, and the
 * REGULAR stroke weight they use — `ICON_REGULAR_STROKE = 1`
 * (`dsh-client-ui-primitives/lib/index.js:250`). This plugin drew it at 1.4,
 * which is above even their MEDIUM weight (1.3), and that is why it looked
 * thicker than the buttons it stands next to.
 *
 * The props are theirs too (`{ size, className, strokeWidth }`), so the very
 * same element is what `commandUi.register` accepts as its `icon`.
 * @param props - render props, all optional.
 * @returns the icon element.
 */
function RollbackIcon({ size = 16, className, strokeWidth = 1 }: { size?: number; className?: string; strokeWidth?: number } = {}): React.ReactElement {
  // `strokeWidth` rides the <svg>, exactly as the primitives do it, so both
  // paths inherit one weight instead of each carrying its own copy.
  return React.createElement('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', className, strokeWidth, 'aria-hidden': true },
    React.createElement('path', { d: 'M6.6 3.4 3 7l3.6 3.6', stroke: 'currentColor', strokeLinecap: 'round', strokeLinejoin: 'round' }),
    React.createElement('path', { d: 'M3 7h6.4c2.3 0 4 1.7 4 3.9V13', stroke: 'currentColor', strokeLinecap: 'round', strokeLinejoin: 'round' }),
  )
}

/** The turn NUMBER from a node's location (object form or bare number). */
function turnNoOf(loc: any): number | undefined {
  const t = loc?.turn
  const n = (t !== null && typeof t === 'object') ? t.turn : t
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 1 ? n : undefined
}

/**
 * The chat slice every read below works on, from whichever route this DSH
 * version publishes it on.
 *
 * 0.1.5 removed `chat` from the session snapshot and instead hands the chat
 * target to every session-scoped slot entry as the session kit hook `useChat`
 * (the standard source `chat` that ui-chat provides). 0.1.1 had no such hook and
 * carried the slice on the snapshot. Preferring the hook keeps 0.1.5 working and
 * the fallback keeps 0.1.1 working — with neither, the caller passes undefined
 * and every read no-ops, so the absence is what {@link auditContracts} and the
 * driver's own check report.
 *
 * The hook is called only when the prop is a function: React forbids a changing
 * hook order, and this prop is fixed for the whole life of a DSH version, so the
 * branch is stable — while calling an absent prop would throw.
 * @param useChat - the session kit hook from props, when this build has one.
 * @param snapshot - the session snapshot, for the 0.1.1 route.
 * @returns the chat snapshot, or undefined when this session has none yet.
 */
function useChatOrSnapshot(useChat: unknown, snapshot: any): any {
  const live = typeof useChat === 'function' ? useChat((s: any) => s) : undefined
  return live ?? snapshot?.chat
}

/**
 * Plain text of the turn-opening user prompt for one turn.
 * @param chat - the chat snapshot slice (see {@link useChatOrSnapshot}).
 * @param turn - the 1-based turn whose opening prompt is wanted.
 */
function findUserPrompt(chat: any, turn: number): string {
  const order = chat?.order
  const store = chat?.nodes
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

/**
 * Block census of the LAST user message {@link findUserAttachments} read, for the
 * restore diagnostic. Module state is enough: the diagnostic is read in the same
 * rollback pass that just called that function.
 */
let lastAttachmentCensus: Record<string, number> | null = null

/**
 * Durable attachments of a turn-opening user prompt, for re-attaching to the composer.
 *
 * Both block kinds qualify, not just images: a `file` block carries the same
 * `{ attachment }` durable reference, and the reader behind `imageUrl` is generic —
 * it keys on `attachment.attachmentId` and types the blob from the attachment's own
 * `mediaType`, with no image check anywhere. So a rolled-back turn's files come back
 * through exactly the same path as its images, and the name `imageUrl` is historical
 * rather than a restriction. (Files dropped into the composer with a workspace path
 * never become attachments at all: they are `@path` references, so their text already
 * returns with the prompt.)
 * @param chat - the chat snapshot slice (see {@link useChatOrSnapshot}).
 * @param turn - the 1-based turn whose images are wanted.
 */
function findUserAttachments(chat: any, turn: number): { name: string; mediaType: string; attachment: any }[] {
  const order = chat?.order
  const store = chat?.nodes
  if (!Array.isArray(order) || typeof store?.get !== 'function') return []
  for (const key of order) {
    const node = store.get(key)
    if (node?.kind !== 'user' || turnNoOf(node.location) !== turn) continue
    const content = node?.data?.content
    if (!Array.isArray(content)) return []
    // Census of what the turn's message ACTUALLY carries, for the restore diagnostic.
    // Measured on the desktop (2026-10-01): two reports of "the attachment did not come
    // back" were both turns whose logged message carried `text` blocks only — the file
    // never reached the message at all. That is indistinguishable from "the plugin
    // failed to rebuild it" without this line, and the code's own silence is why it
    // took two rounds to tell the two apart.
    const kinds: Record<string, number> = {}
    for (const block of content) {
      const kind = typeof block?.type === 'string' ? block.type : '(no type)'
      kinds[kind] = (kinds[kind] ?? 0) + 1
    }
    lastAttachmentCensus = kinds
    return content
      // Both kinds of durable attachment, not only images. A `file` block carries the
      // same `{ attachment }` reference, and the loader written for images is generic:
      // it keys on `attachment.attachmentId` and types the blob from the attachment's
      // own `mediaType`, with no image check in it at all — so `imageUrl` is a
      // historical name, not a restriction. (A file dropped in WITH a workspace path
      // never becomes an attachment at all: it is an `@path` reference, so its text
      // already returns with the prompt.)
      .filter((b: any) => (b?.type === 'image' || b?.type === 'file') && b?.attachment)
      .map((b: any) => ({
        name: b.attachment.name ?? (b.type === 'image' ? 'image' : 'file'),
        // Only the fallback: the reader types the bytes from the attachment itself.
        mediaType: b.attachment.mediaType ?? (b.type === 'image' ? 'image/png' : 'application/octet-stream'),
        attachment: b.attachment,
      }))
  }
  return []
}

/**
 * The turn a finalized assistant `messageId` belongs to, resolved from the chat
 * snapshot. `assistant-actions` fires once per settled turn with its closing
 * message, so this maps the end-of-turn anchor back to its 1-based turn — and an
 * undefined result is what leaves the rollback button permanently disabled, so
 * the chat slice has to come from the right route (see {@link useChatOrSnapshot}).
 * @param chat - the chat snapshot slice.
 * @param messageId - the closing assistant message's durable id.
 * @returns the 1-based turn, or undefined when this build published no chat data.
 */
function turnForMessageId(chat: any, messageId: string): number | undefined {
  const order = chat?.order
  const store = chat?.nodes
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
 * DSH's "load earlier" paging control, across the shipped locales. 0.1.5 renders
 * it as the sole button of a `div.older` that is a direct child of the chat
 * column (`t("chat.loadOlder")`:
 * dsh-client-ui-chat/lib/client.js:2526-2533, labels at :2639 and :2745).
 */
const LOAD_EARLIER_LABELS = new Set(['加载更早', 'Load earlier'])

/**
 * The visible "load earlier" control of one chat column, or null.
 *
 * Identity, not position. An earlier version hid whatever button sat inside the
 * column's first non-seat child — a guess about layout, and the same class of
 * inference that once hid conversation rows. The control is recognized by its own
 * label, and a button whose label cannot be read is never touched, so a layout
 * change costs a stranded paging button instead of a hidden control the user
 * needed.
 * @param column - the chat flow column, when the page has one.
 * @returns the paging button, or null when none could be identified.
 */
function loadEarlierButtonOf(column: HTMLElement | null): HTMLElement | null {
  if (column === null) return null
  for (const btn of column.querySelectorAll<HTMLElement>(':scope > div:not([data-chat-flow-key]) button')) {
    if (LOAD_EARLIER_LABELS.has((btn.textContent ?? '').trim())) return btn
  }
  return null
}

/**
 * The replaced window a rollback-marker node records, in three readings.
 *
 * - a number: the first seq the rollback shadowed, so exactly `[cut, seq)` was
 *   taken out of the conversation (the host's `replace` form);
 * - `null`: the rollback replaced NOTHING — the host's `append` form, written when
 *   the system-prompt clamp left no replaceable node. That is an empty range BY
 *   CONTRACT, not a missing one: the node still proves a rollback happened (which
 *   is what the emptiness decision needs), and it covers no seq, so it cannot hide
 *   a row (see {@link coveredByRollback});
 * - `undefined`: unreadable, reported rather than guessed. Such a marker
 *   contributes no window at all, which is the only safe reading of one.
 *
 * This is the ONE place that knows the marker state's shape, which `start()`
 * writes as a FLAT `{ seq, truncatedFromSeq }` for a replacement and as a FLAT
 * `{ seq, replacedNothing: true }` for an append. Reading it through a stale path
 * is how a working rollback once became a silent no-op: the host truncated the
 * conversation, the client collected zero markers, and nothing was hidden. A
 * marker without a readable cut is therefore reported rather than skipped — and
 * skipping it is what keeps the account safe: an unresolvable marker hides
 * nothing.
 * @param node - a chat node of kind `rollback-marker`.
 * @returns the cut seq, `null` for a marker that replaced nothing, or `undefined`
 * when the node carries no readable reading.
 */
function markerCutOf(node: any): number | null | undefined {
  // Read BEFORE the cut: an append-form marker carries no `truncatedFromSeq`, and
  // reading that absence as an unreadable range is the exact failure this branch
  // rules out — the host had emptied the transcript, the marker was dropped, and
  // the welcome hero never appeared over the infrastructure rows left behind.
  if (node?.data?.replacedNothing === true) return null
  const from = node?.data?.truncatedFromSeq
  if (typeof from === 'number' && Number.isSafeInteger(from) && from >= 0) return from
  errorOnce('marker-cut', 'rollback marker node carries no readable cut seq, so its range stays visible', {
    dataKeys: node?.data === null || node?.data === undefined ? String(node?.data) : Object.keys(node.data as Record<string, unknown>).join(','),
    truncatedFromSeq: node?.data?.truncatedFromSeq,
  })
  return undefined
}

/**
 * The first shadowed sequence one `replace` surface operation declared.
 *
 * 0.1.5 names the two ends `startSeq`/`endSeq`:
 * `export type SurfaceOp = 'append' | { op: 'replace'; startSeq: SessionSeq; endSeq: SessionSeq }`
 * (`dsh-session/lib/types/types.d.ts:429-433`), and the validator the CLIENT runs
 * on every event it receives demands exactly those three keys
 * (`dsh-session/lib/index.js:262-264`, reached from
 * `dsh-api-session-controller/lib/types/client/session-wire-event.js:40`) — so a
 * replace-shaped event the browser can see always carries `startSeq`, and a
 * reader looking at `start` alone finds nothing on this build. This plugin's own
 * host half still writes the earlier `start`/`end` spelling, so both are read: a
 * marker must never be skipped, and a range must never be guessed from the wrong
 * field.
 * @param op - the event's surface operation, as the log carries it.
 * @returns the shadowed range's first seq, or undefined when unreadable.
 */
function surfaceCutOf(op: any): number | undefined {
  for (const candidate of [op?.startSeq, op?.start]) {
    if (typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0) return candidate
  }
  return undefined
}

/** Report once a marker event whose shadowed-range start cannot be read. */
function reportUnreadableCut(op: any): void {
  if (surfaceCutOf(op) !== undefined) return
  errorOnce(
    'marker-cut-event',
    'rollback marker event carries no readable shadowed-range start: neither surfaceOp.startSeq (0.1.5) nor surfaceOp.start (<=0.1.1) is a seq, so its range stays visible',
    { surfaceOpKeys: op === null || typeof op !== 'object' ? String(op) : Object.keys(op as Record<string, unknown>).join(',') },
  )
}

/**
 * Chat node kinds that ARE conversation content, by inverting the old rule.
 *
 * The previous rule listed *infrastructure* kinds and counted everything else as
 * content. Measured on the desktop (2026-10-01), that denylist missed **three**
 * different kinds in turn — `turn-process` ("已停止"), text-free steps
 * ("已完成分析"), and then a third that survived both fixes — because the status/UI
 * family of a chat snapshot is open-ended and grows with the product, while the
 * CONTENT family is small and stable.
 *
 * So this is an ALLOWLIST: only a kind listed here can count as content or keep the
 * welcome page away. Anything else is treated as UI scaffolding. The direction is
 * safe because the hero is gated twice — the log must prove a rollback emptied the
 * transcript AND no content seat may still be visible — and because a genuinely new
 * message arrives as `user` (listed), which immediately makes `contentLeft` non-zero
 * and keeps the transcript on screen. An unrecognized kind can therefore only lose a
 * stranding status row, never a message that arrived after the rollback.
 *
 * `compaction`, `skill` and `apply` are listed because DSH renders them as their own
 * rows: they are product UI, but they narrate what happened, so keeping them visible
 * (and keeping the hero away) preserves the honest reading of "the screen is empty".
 */
const CONTENT_KINDS = new Set<string>([
  'user',
  'assistant-step',
  'system-prompt',
  'compaction',
  'skill',
  'apply',
])

/**
 * Whether a node is UI scaffolding rather than conversation content: its kind is not
 * a content kind, or it is a step with nothing to show.
 * @param node - one chat node.
 * @returns whether the node may be ignored for emptiness and hidden when emptied.
 */
function isUiOnlyNode(node: any): boolean {
  const kind = node?.kind
  if (typeof kind !== 'string' || !CONTENT_KINDS.has(kind)) return true
  return isTextFreeStep(node)
}

/**
 * Whether a node is a step that carries NO user-visible text — only reasoning or
 * tool blocks.
 *
 * Such a step is DSH's process/progress row, not conversation content, and a
 * rollback hides reasoning by design: rolling back past a turn must not leave its
 * "已完成分析" (`message.stepProcess.done.thinking`) disclosure standing above the
 * welcome page, which is exactly what was reported from the desktop on
 * 2026-10-01 — twice, both times on a turn that had been INTERRUPTED, because an
 * interrupted step is settled as reasoning-only with no final text.
 *
 * Erring toward CONTENT is deliberate in every uncertain case (an unreadable
 * `blocks`, an empty block list, any `text` block): only a step whose blocks are
 * readable AND contain no `text` at all is treated as process UI. An `assistant-step`
 * is never whole-message content when it has no text to show.
 * @param node - one chat node.
 * @returns whether the node is a text-free step.
 */
function isTextFreeStep(node: any): boolean {
  if (node?.kind !== 'assistant-step') return false
  const blocks = node?.data?.blocks
  if (!Array.isArray(blocks) || blocks.length === 0) return false
  return !blocks.some((block: any) => block?.kind === 'text')
}

/**
 * Whether the transcript is currently emptied by a rollback, as {@link syncHides}
 * last determined.
 *
 * The driver reads this and renders the welcome hero into a host element IT
 * injects into the transcript. The hero used to be revealed by un-hiding the
 * marker node's own seat — which silently produced nothing whenever that seat was
 * missing, or nested inside a container the hide pass had collapsed. Hosting it
 * ourselves removes that dependency entirely.
 *
 * Only a pass that PROVED the emptiness sets it: the log count must be zero AND
 * no content seat may still be visible (see {@link syncHides}), and every
 * fail-closed path clears it. A hero standing over a visible transcript is the
 * one thing this flag must never express.
 */
const heroWanted = { visible: false }

/**
 * The attribute marking a seat THIS plugin's rollback passes hid, so those
 * passes can hand every one of them back the moment they cannot prove what they
 * are looking at.
 *
 * Hiding a row is a claim about durable state — "this row is inside a rollback's
 * shadowed range". When the claim's inputs stop looking like the shape it was
 * written against, the only safe answer is "hide nothing", and that also means
 * restoring whatever an earlier, better-informed pass hid. Only the rollback
 * passes use this attribute: the receipt sweeps hide by identity for a different
 * reason and are never revealed here.
 */
const RBK_HIDDEN_ATTR = 'data-rbk-hidden'
/** Seats the rollback passes hid, for the fail-closed restore. */
const rollbackHiddenSeats = new Set<HTMLElement>()

/** Hide one seat as a rollback side effect, remembering it for the restore. */
function hideRollbackSeat(el: HTMLElement): void {
  el.setAttribute(RBK_HIDDEN_ATTR, '')
  el.style.display = 'none'
  rollbackHiddenSeats.add(el)
}

/** Give back one seat — and only one this plugin hid. */
function revealRollbackSeat(el: HTMLElement): void {
  rollbackHiddenSeats.delete(el)
  if (!el.hasAttribute(RBK_HIDDEN_ATTR)) return
  el.removeAttribute(RBK_HIDDEN_ATTR)
  el.style.display = ''
}

/**
 * Give back every seat the rollback passes hid. The fail-closed direction: a
 * pass that cannot establish what it is looking at must not leave a transcript
 * it hid earlier on the strength of a reading it can no longer make.
 */
function revealAllRollbackSeats(): void {
  for (const el of [...rollbackHiddenSeats]) {
    if (!document.body.contains(el)) {
      rollbackHiddenSeats.delete(el)
      continue
    }
    revealRollbackSeat(el)
  }
}

/** What a chat node actually looks like, for the one loud line a broken shape earns. */
function nodeShapeOf(node: unknown): string {
  if (node === null) return 'null'
  if (node === undefined) return 'undefined'
  if (typeof node !== 'object') return typeof node
  const shape = node as { kind?: unknown }
  return `kind=${String(shape.kind)} keys=[${Object.keys(node as Record<string, unknown>).join(',')}]`
}

/**
 * Whether a node's own position provably sits inside a rollback's shadowed
 * window.
 *
 * This is THE content-hiding predicate of this file: `from` is the first seq the
 * replacement shadowed and `seq` is the marker event's own seq, so the window is
 * exactly the range the rollback removed. Both the emptiness count and the hide
 * pass call it, which is what makes them provably agree.
 *
 * A `from` of `null` is a marker that replaced nothing (the append form), and it
 * answers `false` for EVERY seq — by this rule, never by an accident of
 * arithmetic — so an append-form marker can never hide a row.
 * @param markers - the readable marker windows, oldest first.
 * @param seq - the node's anchor position.
 * @returns whether this position was rolled back.
 */
function coveredByRollback(markers: { from: number | null; seq: number }[], seq: number): boolean {
  return markers.some(m => m.from !== null && seq >= m.from && seq < m.seq)
}

/**
 * Refuse to hide anything, loudly.
 *
 * The one outcome this file must never produce is a blank transcript, and every
 * hide below reads a framework shape. So when the shape is not the one the
 * passes were written against, they hide NOTHING and give back what they hid
 * before: a future framework change degrades to "no hiding at all", never to
 * "hide the conversation".
 * @param key - once-per-key identity of this report.
 * @param what - the observation, in the caller's words.
 * @param observed - the values that made the shape unrecognizable.
 */
function failClosedHides(key: string, what: string, observed: unknown): void {
  heroWanted.visible = false
  revealAllRollbackSeats()
  errorOnce(key, 'hiding disabled for this pass: ' + what, observed)
}

/**
 * Visually hide every chat seat inside a rollback's shadowed range, and reset
 * bottom-follow over a short armed window after a NEW marker lands. Durable-log
 * side effect: hidden seats need no slot because DSH renders them from events
 * this plugin declared non-surface.
 * @param chat - the chat snapshot slice, resolved by the caller
 * (see {@link useChatOrSnapshot}); a build that publishes neither route passes
 * undefined, and the missing contract is reported by the audit, not here.
 */
function syncHides(chat: any): void {
  const order = chat?.order
  const store = chat?.nodes

  // Fail closed on an unrecognized chat slice, before anything is hidden. The
  // passes below are written against ONE shape — `order` is the array of visible
  // node keys, `nodes.get(key)` answers for each of them, and every node carries
  // `kind` plus a numeric `anchorSeq` (0.1.5:
  // dsh-client-ui-chat/lib/types/client/contract/snapshot.d.ts:20-29 and
  // chat-nodes.d.ts:3-20) — so a build that publishes anything else gets "no
  // hiding at all" plus one loud line, not a computation on missing fields.
  if (!Array.isArray(order)) {
    failClosedHides('hides-order', 'the chat slice has no readable node order (order is not an array)', {
      orderType: typeof order,
      chatKeys: chat === null || chat === undefined ? 'no chat slice' : Object.keys(chat).join(','),
    })
    return
  }
  if (typeof store?.get !== 'function') {
    failClosedHides('hides-store', 'the chat node store has no get(key) reader', {
      storeType: typeof store,
      storeKeys: store === null || store === undefined ? String(store) : Object.keys(store).join(','),
    })
    return
  }

  // Read every node ONCE, before any hiding. The emptiness count, the marker
  // windows and the hide pass then provably see the same nodes, so no pass can
  // hide a row another pass counted as standing content.
  const nodes: { key: string; node: any }[] = []
  for (const key of order) {
    nodes.push({ key, node: typeof key === 'string' ? store.get(key) : undefined })
  }
  if (nodes.length > 0 && !nodes.some(entry => typeof entry.node?.anchorSeq === 'number')) {
    // Either the store answers for none of its own keys, or the assembled nodes
    // moved the position to another field: in both cases no range can be bounded
    // and no emptiness can be established, so nothing may be hidden.
    const sample = nodes.find(entry => entry.node !== undefined && entry.node !== null) ?? nodes[0]!
    failClosedHides('hides-anchor', 'no chat node carries a numeric anchorSeq, so neither a rollback range nor an emptiness can be established', {
      orderLength: nodes.length,
      sampleKey: sample.key,
      sampleNode: nodeShapeOf(sample.node),
    })
    return
  }

  const seatByKey = new Map<string, HTMLElement>()
  for (const el of document.querySelectorAll<HTMLElement>(FLOW_ROW_SELECTOR)) {
    const k = el.getAttribute('data-chat-flow-key')
    if (k !== null) seatByKey.set(k, el)
  }

  const markers: { from: number | null; seq: number }[] = []
  for (const { node } of nodes) {
    if (node?.kind !== 'rollback-marker') continue
    const from = markerCutOf(node)
    if (from === undefined) continue
    const seq = typeof node?.data?.seq === 'number' ? node.data.seq : node?.anchorSeq
    // A marker whose own position is unreadable cannot bound a window: it hides
    // nothing, which is the only safe reading of an unresolvable marker.
    if (typeof seq !== 'number') {
      errorOnce('marker-seq', 'rollback marker node carries no readable seq, so its range stays visible', nodeShapeOf(node))
      continue
    }
    // `from === null` (the append form) is KEPT, not skipped: it is a marker that
    // replaced nothing, so it bounds an EMPTY window. It hides no row, while still
    // counting as "a rollback happened" for the emptiness decision below — which is
    // exactly the degenerate case, where only infrastructure rows are left.
    markers.push({ from, seq })
  }
  // A session with no rollback marker must CLEAR the flag, not skip past it:
// `heroWanted` is module state that outlives the session it was set in, so
// returning early here left the welcome page standing at the end of every
// conversation opened afterwards — until a page reload reset the module.
// An append-form marker is a marker here like any other: it proves a rollback
// happened, and a rollback with nothing left to replace is the case that leaves
// nothing standing but the infrastructure rows.
  if (markers.length === 0) {
    heroWanted.visible = false
    revealAllRollbackSeats()
    return
  }

  const latest = markers[markers.length - 1]!
  const latestSeq = latest.seq

  let hasContentAfter = false
  for (const { node } of nodes) {
    const seq = node?.anchorSeq
    if (typeof seq === 'number' && seq > latestSeq && node?.kind !== 'rollback-marker') { hasContentAfter = true; break }
  }

  // Pass 1 — emptiness, decided from the chat NODES and never from the seats the
// DOM happens to hold. A message reaches the log before React renders its seat,
// so counting seats made a brand-new message invisible to this test for several
// frames — long enough to flash the hero between the old conversation and the new
// message. Every non-marker node either is covered by a rollback's range (hidden)
// or is still standing content, and the transcript is empty when nothing is left
// standing. An append-form marker contributes NO coverage — its window is empty —
// so on that path only the infrastructure kinds are excluded, which is precisely
// what a rollback with nothing to replace leaves behind.
  let contentLeft = 0
  /**
   * What is still standing, by kind, for the one diagnostic line below. Measured on
   * the desktop (2026-10-01): a rollback of an INTERRUPTED turn left status rows above
   * the welcome page whose kinds were not in the old infrastructure denylist — first
   * `turn-process` ("已停止"), then a text-free step ("已完成分析"), then a third that
   * survived both fixes. That is why the rule is now an allowlist ({@link CONTENT_KINDS})
   * and why this census exists: the next unexpected kind names itself instead of
   * costing another round of guessing.
   */
  const leftovers = new Map<string, number>()
  for (const { node } of nodes) {
    const seq = node?.anchorSeq
    if (typeof seq !== 'number') continue
    if (node?.kind === 'rollback-marker') continue
    if (isUiOnlyNode(node)) continue
    if (coveredByRollback(markers, seq)) continue
    contentLeft += 1
    const kind = typeof node?.kind === 'string' ? node.kind : '(no kind)'
    leftovers.set(kind, (leftovers.get(kind) ?? 0) + 1)
  }
  const emptied = contentLeft === 0

  // Pass 2 — marker seats render nothing at all: no divider, and no hero either
  // (the welcome page is hosted by the driver, see `heroWanted`). A marker whose
  // seat never appeared is reported, since it still explains an empty page.
  let hidden = 0
  let markerSeats = 0
  for (const { key, node } of nodes) {
    if (node?.kind !== 'rollback-marker') continue
    const el = seatByKey.get(key)
    if (el === undefined) {
      warnOnce('marker-seat', 'rollback marker node has no DOM seat', { key, seq: node?.anchorSeq })
      continue
    }
    markerSeats += 1
    hideRollbackSeat(el)
    hidden += 1
  }

  // Pass 3 — hide exactly the seats a rollback's range covers, and nothing else.
  //
  // `coveredByRollback` is the ONLY rule here that can hide content, and it is a
  // proof about one row: this node's own seq sits inside a marker's shadowed
  // window. An emptiness COUNT is not a proof about a row and therefore never
  // hides one — a hidden message cannot be recovered by the user, while a
  // stranded log-only row is cosmetic. So `emptied` adds only UI scaffolding
  // ({@link isUiOnlyNode}: a kind outside {@link CONTENT_KINDS}, or a text-free
  // step): those rows sit before the rollback point, were never in the model's
  // context, and must not strand above the welcome page. Every content kind stays.
  // An append-form marker adds no coverage of its own here: `coveredByRollback` is
  // false for every seq of an empty window, so it can hide nothing by range and only
  // the `emptied` half of this rule can ever touch its session's rows.
  for (const { key, node } of nodes) {
    const el = seatByKey.get(key)
    if (el === undefined) continue
    const seq = node?.anchorSeq
    if (typeof seq !== 'number' || node?.kind === 'rollback-marker') continue
    const strayUi = emptied && isUiOnlyNode(node)
    if (coveredByRollback(markers, seq) || strayUi) {
      hideRollbackSeat(el)
      hidden += 1
    } else {
      revealRollbackSeat(el)
    }
  }

  // The hero stands in for an emptied transcript, and only for one a ROLLBACK
  // emptied — `markers` is non-empty here, since this pass returns early without
  // one, and a session that never had content therefore never reaches it. An
  // append-form marker counts as such a rollback: it replaced nothing, and that is
  // exactly the screen the hero belongs on. The DOM must agree too: a content seat
  // still visible after Pass 3 keeps the welcome page away, because "the log says
  // empty" and "the screen is empty" are two different readings and the second one
  // is the one the user sees. The same allowlist decides this, so the two readings
  // cannot disagree about which rows are content.
  let contentSeatsVisible = 0
  for (const { key, node } of nodes) {
    if (node?.kind === 'rollback-marker') continue
    // The same allowlist the emptiness count uses, so the log reading and the DOM
    // reading can never disagree about which rows are content.
    if (isUiOnlyNode(node)) continue
    const el = seatByKey.get(key)
    if (el === undefined || el.style.display === 'none') continue
    contentSeatsVisible += 1
  }

  // Pass 4 — seats with NO node in the chat slice: the durable ghost rows.
  //
  // Passes 1–3 all walk `nodes`, so a row left behind by the surface replace without a
  // node was never even considered. First measured on 2026-10-01 (`contentLeft: 0`,
  // `contentSeatsVisible: 0`, `emptied: true`, welcome page standing — and a
  // "已完成分析" row still on screen), and then reported AGAIN the next day in a worse
  // form: it came back as soon as the user sent a new message, because hiding it was
  // tied to the emptied state, and a transcript with a new message is not empty.
  //
  // Hiding cannot be the answer for these rows, because there is no state in which they
  // are legitimate: a seat the chat slice has no node for cannot have been rendered by
  // this snapshot's data, so React is not tracking it and only a stale DOM node can
  // explain it. The pass therefore REMOVES them, which is what the user asked for — a
  // ghost must not survive the next message. Removal is scoped exactly this narrowly
  // (node-less seats only, restored by a page load like any other DOM leaf), so a row
  // that belongs to a real message is never touched: real messages always have nodes.
  const knownKeys = new Set(nodes.map(entry => entry.key))
  const nodeLessSeats: string[] = []
  for (const [key, el] of seatByKey) {
    if (knownKeys.has(key)) continue
    nodeLessSeats.push(key)
    try {
      el.remove()
      hidden += 1
    } catch { /* a detached node needs no removal */ }
  }

  heroWanted.visible = emptied && contentSeatsVisible === 0

  const column = document.querySelector<HTMLElement>('[data-chat-flow=""]')

  // An emptied transcript also stops offering "load earlier": there is no earlier
  // range left to reach for. Hiding is identity-gated — the control is the button
  // DSH labels "加载更早" / "Load earlier", never merely "the first button inside
  // the column", which is a guess about layout rather than a fact about the
  // control. It is also gated on the PROVEN empty state (the hero's), not on the
  // count: hiding a paging control is only true once nothing is left to page to.
  if (heroWanted.visible) {
    const loadEarlier = loadEarlierButtonOf(column)
    if (loadEarlier === null) {
      warnOnce('load-earlier', 'no readable "load earlier" control was found in the emptied transcript', { columnPresent: column !== null })
    } else {
      hideRollbackSeat(loadEarlier)
    }
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
      // WHICH kinds are still standing, so a stranded row names itself in the console
      // instead of costing a "which kind was it?" round trip (see `leftovers`).
      contentKinds: Object.fromEntries(leftovers),
      // Seats the chat slice has no node for (Pass 4). A non-empty list here means the
      // DOM is holding rows the log does not describe — the shape that produced a
      // stranded status row while every node-side count read zero.
      nodeLessSeats: nodeLessSeats.length,
      nodeLessSample: nodeLessSeats.slice(0, 5),
      contentSeatsVisible,
      emptied,
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
 *
 * This pass can only ever ADD an element (and take it back): it never hides a
 * seat, so a wrong input here cannot blank the transcript. Its one real risk is
 * that the column belongs to React, which knows nothing about a foreign child —
 * so the host is inserted only when the PROVEN empty state asks for it, always as
 * the last child, and it is removed the moment the flag clears (including on
 * driver unmount), which keeps React's own appends below it and the hero last.
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
function RollbackAction({ messageId, useSession, useChat, t }: any): React.ReactElement | null {
  if (typeof useSession !== 'function') {
    // Never silent: a missing button must always be traceable to a reason.
    warnOnce('action-session', 'assistant action lacks useSession')
    return null
  }
  const snapshot = useSession((s: any) => s)
  const chat = useChatOrSnapshot(useChat, snapshot)
  const oldest = useRollbackOldest()
  const open = snapshot?.running === true
  const turn = React.useMemo(() => turnForMessageId(chat, messageId), [chat, messageId])
  const blocked = turn !== undefined && oldest !== null && turn < oldest
  const disabled = open || turn === undefined || blocked
  const label = open ? t('action.running') : t('action.label')
  const button = React.createElement('button', {
    type: 'button',
    className: 'rbk-act',
    'aria-label': label,
    disabled,
    onClick: () => { if (!disabled && turn !== undefined && openRollbackDialog !== null) openRollbackDialog(turn) },
  }, React.createElement(RollbackIcon))
  // `children` goes INSIDE the props object, not as createElement's third argument.
  // React treats both identically at runtime, but the official Tooltip declares
  // `children` as a required prop and current @types/react no longer derives it from
  // createElement's varargs — so only this spelling type-checks against the component
  // the host actually ships. It was invisible while the client half was checked with
  // react's unresolved-package fallout silenced.
  return React.createElement(Tooltip, { label, side: 'bottom', children: button })
}

/**
 * Routing selector for the turn-footer entry on builds that declare the seat as a
 * CHAIN (0.1.5): a chain entry MUST supply `select` (the framework throws without
 * it), and its non-null result becomes the component's `matched` prop.
 *
 * Returning null whenever the assistant action strip can offer the button keeps the
 * familiar placement and guarantees one button per turn — the footer shows up only
 * where that strip cannot exist (an interrupted turn, which has no closing message).
 * The tail data is read through the location's own reader rather than from the node,
 * because the selector only ever receives the owner props.
 *
 * 0.2.0 declares the same seat as a LIST instead, which has no election at all, so
 * this function is only reachable through {@link registerTurnTailEntry}'s legacy
 * branch; {@link RollbackTurnAction} states the same rule for both routes.
 */
function selectFooterAction(owner: any): { turn: number } | null {
  const location = owner?.turn
  const turnNo = turnNoOf(location)
  if (turnNo === undefined) return null
  if (!footerEntryNeeded(closingOf(location) as never)) return null
  return { turn: turnNo }
}

/**
 * The closing assistant node a turn's footer data carries, read through the
 * location's own reader rather than from the node.
 *
 * Both shapes of failure are answered the same way — with `undefined`, which
 * {@link footerEntryNeeded} treats as "no closing message" — because the caller's
 * choice is fail-open: a button the host may decline is better than a button that
 * silently never appears.
 * @param location - the turn location the footer seat delivers.
 * @returns the closing node, or undefined when it cannot be read.
 */
function closingOf(location: any): unknown {
  try {
    return location?.data?.get?.('turn-tail')?.closing
  } catch (e) {
    warnOnce('footer-tail-data', 'turn footer could not read its tail data', e)
    return undefined
  }
}

/**
 * Register the turn-footer entry under whichever spelling this build's
 * `conversation.chat.turnTail` seat takes.
 *
 * One artifact serves both versions: the modern `list` spelling is tried first,
 * and the legacy `chain` one only when the seat refuses the list form by name
 * (see {@link isTurnTailShapeRejection}). Nothing is recorded by a refused
 * registration, so the retry cannot leave a half-registered entry behind.
 * {@link RollbackTurnAction} re-applies the election itself, so both routes end
 * with the same single button per turn.
 * @param ctx - the plugin's own context.
 * @returns the registration's disposer.
 */
function registerTurnTailEntry(ctx: any): () => void {
  const fields = { id: 'rollback', order: 20, locale: NS, select: selectFooterAction }
  let shape: TurnTailShape = 'list'
  for (;;) {
    try {
      return ctx.slots.register(turnTailRegistration(shape, fields), RollbackTurnAction)
    } catch (error) {
      if (!isTurnTailShapeRejection(error)) throw error
      const next = otherTurnTailShape(shape)
      // Both spellings refused: the seat exists but takes a shape neither supported
      // build declares, so this is a real failure and the caller reports it.
      if (next === 'list') throw error
      shape = next
    }
  }
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
  // Every hook this entry uses runs before any early return: 0.2.0 renders the
  // seat as a LIST, so most turns end in one of the returns below, and a hook
  // reached only on the turns that survive would change the hook order between
  // renders.
  const oldest = useRollbackOldest()
  if (typeof useSession !== 'function') {
    warnOnce('footer-action-session', 'turn footer action lacks useSession')
    return null
  }
  const turnNo = matched?.turn ?? turnNoOf(location)
  if (turnNo === undefined) {
    warnOnce('footer-action-turn', 'turn footer action could not resolve its turn', location)
    return null
  }
  // The election the chain spelling used to express (see
  // {@link selectFooterAction}) applies on both routes: the footer offers the
  // button only where the assistant action strip cannot, so a turn never shows
  // two of them.
  if (!footerEntryNeeded(closingOf(location) as never)) return null
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
  }, React.createElement(RollbackIcon))
  return React.createElement(Tooltip, { label: t('action.label'), side: 'bottom', children: button })
}

interface DriverProps {
  preview: (turn: number) => Promise<PreviewFile[]>
  execute: (turn: number) => Promise<void>
  /** Raw `/rollback list` output, for the range the action entries may offer. */
  list: () => Promise<string>
  useSession: <T>(selector: (snapshot: any) => T) => T
  /**
   * The session kit hook carrying the chat target (0.1.5). Absent on 0.1.1,
   * where the same data sits on the session snapshot — see
   * {@link useChatOrSnapshot}, which resolves both.
   */
  useChat?: (selector: (snapshot: any) => any) => any
  t: (key: RollbackKey) => string
  /**
   * The session input action face. 0.1.5 renamed the attachment verbs
   * (`addAttachments` / `pruneAttachments`) and kept `setDraft`; 0.1.1 published
   * `addImages` / `pruneImages`. Both spellings stay optional here and are
   * feature-detected at the call site, so one bundle serves both builds.
   */
  inputActions?: {
    setDraft(text: string): void
    addAttachments?(ids: readonly string[]): boolean
    addImages?(ids: readonly string[]): boolean
    pruneAttachments?(ids: readonly string[]): void
    pruneImages?(ids: readonly string[]): void
  }
  /**
   * Rebuild draft attachments for the attachments a rolled-back turn had.
   * @returns the draft ids plus the draft descriptors they came from, so a refused
   *   append can be released through the first-party `releaseDraftAttachments` face.
   */
  restoreAttachments?: (images: { name: string; mediaType: string; attachment: any }[]) =>
    Promise<{ ids: string[]; descriptors: unknown[] }>
  /**
   * Release draft attachments the input refused (0.1.5's `addAttachments` returns
   * false while a submission is in flight). Mirrors first-party code, which
   * releases the descriptors it just created when the shell declines them.
   */
  releaseAttachments?: (ids: readonly string[]) => void
  /**
   * The conversation face, for the first-party release verb only
   * (`releaseDraftAttachments(drafts)`, which is what the product's own composer
   * calls). Preferred over {@link releaseAttachments} when present.
   */
  conversation?: { releaseDraftAttachments?: (descriptors: unknown) => void }
}

/**
 * Invisible per-session driver: runs the durable-log side-effect passes (hide
 * rolled-back seats, suppress button command receipts) and hosts the single
 * confirmation dialog, opened from the assistant action through the module
 * bridge. Renders nothing into its own dock seat.
 */
function RollbackDriver({ preview, execute, list, useSession, useChat, inputActions, restoreAttachments, releaseAttachments, conversation, t }: DriverProps): React.ReactElement | null {
  if (typeof useSession !== 'function') {
    warnOnce('useSession', 'props lack useSession', Object.keys({ useSession }))
    return null
  }
  const chatRef = React.useRef<any>(undefined)
  const ensureRef = React.useRef<() => void>(() => {})
  const snapshot = useSession((s: any) => s)
  // Both chat routes are resolved here, once per render: the hide pass and the
  // post-rollback draft restore read the slice through `chatRef`, so they always
  // see the newest of whichever route this build publishes it on.
  const chat = useChatOrSnapshot(useChat, snapshot)
  // The exact form of the contract break the start-up audit can only
  // approximate: with no route at all, every read below is undefined, the hide
  // pass no-ops and the button stays disabled for the whole session — reported
  // once, so it cannot be mistaken for a button that is disabled by design.
  if (typeof useChat !== 'function' && chat === undefined && snapshot !== undefined) {
    errorOnce('chat-snapshot', 'framework contract mismatch: no chat snapshot — neither the session kit hook "useChat" nor snapshot.chat is available, so no turn can be resolved and the rollback button will never enable')
  }

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
    chatRef.current = chat
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
      try {
        syncHides(chatRef.current)
      } catch (error) {
        // A pass that died halfway may have hidden rows and left `heroWanted`
        // standing on a reading it never finished. Both are undone here: an
        // exception is not a proof, and a blank transcript is not a diagnosis.
        heroWanted.visible = false
        revealAllRollbackSeats()
        warnOnce('sync-hides', 'syncHides threw', error)
      }
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
    chatRef.current = chat
    ensureRef.current()
  })

  const confirm = () => {
    if (dialogTurn === null) return
    const turn = dialogTurn
    // Read the turn's prompt and images from the LIVE snapshot before the host is
    // asked to truncate it. The post-rollback read below is the normal route, but
    // it races the client's own surface-replacement handling: once that lands the
    // rolled-back nodes can already be gone, and the restore would silently have
    // nothing to restore — the exact "images came back? no" outcome this feature
    // exists to prevent. A pre-read cannot be worse: the values are identical
    // whenever the later read still sees the nodes.
    const promptBefore = findUserPrompt(chatRef.current, turn)
    const imagesBefore = findUserAttachments(chatRef.current, turn)
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
        const prompt = findUserPrompt(chatRef.current, turn) || promptBefore
        const images = findUserAttachments(chatRef.current, turn)
        const restored = images.length > 0 ? images : imagesBefore
        if (inputActions !== undefined) {
          inputActions.setDraft(prompt)
          // Drop whatever the composer still holds BEFORE the restored ids go in,
          // so the rail ends up holding exactly the rolled-back turn's images.
          // 0.1.5 renamed this verb; both spellings are the same "keep only these
          // live ids" call, and an empty list therefore empties the rail.
          if (inputActions.pruneAttachments !== undefined) inputActions.pruneAttachments([])
          else if (inputActions.pruneImages !== undefined) inputActions.pruneImages([])
        }
        if (restored.length > 0 && restoreAttachments !== undefined && inputActions !== undefined) {
          const add = inputActions.addAttachments !== undefined
            ? (ids: readonly string[]) => inputActions.addAttachments!(ids)
            : inputActions.addImages !== undefined
              ? (ids: readonly string[]) => inputActions.addImages!(ids)
              : undefined
          if (add === undefined) {
            warnOnce('input-add-attachments', 'input actions expose neither addAttachments (0.1.5) nor addImages (0.1.1), so the rolled-back images cannot be re-attached')
          } else {
            restoreAttachments(restored).then(result => {
              const { ids, descriptors } = result
              // Report the OUTCOME, not just the failures: "the API refused" and "the
              // composer rejected the ids" both used to end in the same silence.
              console.info('[rollback] attachments:', { carried: restored.length, rebuilt: ids.length })
              if (ids.length === 0) return
              // RETRY the append, do not fire once. The composer's action face is handed
              // to us by the chat seat and can still be the previous instance for a moment
              // after the surface was replaced — which is exactly what a rollback just did.
              // A single refused call therefore loses the chip while the draft text (set
              // through the same face) appears, i.e. "text came back, the chip did not".
              // The peer plugin of this kind retries this up to 8 times at 150 ms
              // (`dsh-recall-plugin`'s `fillDraft`, read from its shipped bundle), and the
              // measured symptom it prevents is the one reported here on 2026-10-01.
              let attempts = 0
              const tryAdd = (): void => {
                let accepted: boolean | undefined
                try { accepted = add(ids) } catch (error) { accepted = false; void error }
                if (accepted !== false) {
                  if (attempts > 0) console.info('[rollback] attachments accepted after retry:', { attempts, ids })
                  return
                }
                attempts += 1
                if (attempts < 8) { setTimeout(tryAdd, 150); return }
                console.warn('[rollback] the composer refused the rebuilt attachments after 8 attempts; releasing them', { ids })
                // Release through the FIRST-PARTY face, which is what the product's own
                // composer calls; the input-action verb is this plugin's optional fallback.
                try {
                  if (typeof conversation?.releaseDraftAttachments === 'function') conversation.releaseDraftAttachments(descriptors)
                  else releaseAttachments?.(ids)
                } catch (error) { void error }
              }
              tryAdd()
            }, (e: unknown) => {
              warnOnce('restore-images', 'could not rebuild the composer attachments of the rolled-back turn', e)
            })
          }
        }
        // ALWAYS say what the rolled-back turn's message carried — not only when
        // something was found. Measured on the desktop (2026-10-01): two reports of
        // "the attachment did not come back" were turns whose logged message carried
        // `text` blocks only, and the plugin's silence in exactly that case is why it
        // took two rounds to tell "nothing was ever attached" apart from "the rebuild
        // failed". The census comes from the same read the restore used.
        console.info('[rollback] rolled-back turn message:', {
          turn,
          blocks: lastAttachmentCensus ?? '(no user message node found for this turn)',
          restorable: restored.length,
          beforeRead: imagesBefore.length,
        })
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
          // A read-out, not a control: the list says WHICH files this rollback
          // will touch, and that is all it is for. Opening one from here was
          // possible and turned out to be a surface nobody used — the editor is
          // one click away in the sidebar and the path is already on screen — so
          // the rows are plain elements now: no hover, no pointer, no focus stop.
          files !== null && files.length > 0
            ? files.map(f => React.createElement('div', { key: f.path, className: 'rbk-row' },
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
    // Current builds: a `user/message` stamped with this plugin's provenance.
    // Its content is the model-facing checkpoint text, so the client reads the
    // rolled-back range from the EVENT (`surfaceOp.startSeq`/`start`) instead.
    if (event?.type === 'user/message') {
      const source = event?.data?.source
      // Either provenance spelling: `{kind:'plugin:rollback'}` is what the host
      // writes now (format v4 refuses the retired wrapper), and
      // `{kind:'plugin', plugin:'rollback'}` is what a pre-fix log carries.
      if (!isRollbackMarkerSource(source)) return null
      // The PROVENANCE is the marker, and the host writes that marker under two
      // surface ops: a `replace` naming the range it took out, and an `append` for
      // the degenerate rollback that had nothing left to replace (the only legal
      // spelling there — a `replace` over the protected system prompt is refused by
      // the framework and an empty one cannot be spelled; see `appendRollbackMarker`
      // in the host half). Both forms match here, whether or not a replace op is
      // present: the append form replaces nothing, which `start` records as an EMPTY
      // range, never as a missing one — dropping it is what left the checkpoint text
      // as an ordinary message, no marker at all, and the infrastructure rows
      // standing on an otherwise empty screen.
      if (op === 'append' || op === undefined) return { id: String(event.seq), role: 'start' }
      // Any OTHER op shape is one this Definition was not written against, and it is
      // deliberately left unmatched: the checkpoint text then stays visible, which is
      // cosmetic, instead of being turned into a claim about a range nobody can read.
      if (op?.op !== 'replace') return null
      reportUnreadableCut(op)
      return { id: String(event.seq), role: 'start' }
    }
    // Legacy builds (<= 852c656): an empty-content `assistant/message` whose
    // message carried the rollback facts. Still recognized so an old session's
    // markers keep hiding their range.
    if (event?.type === 'assistant/message' && event?.data?.message?.rollback !== undefined) {
      if (op === undefined || op === 'append' || op?.op !== 'replace') return null
      reportUnreadableCut(op)
      return { id: String(event.seq), role: 'start' }
    }
    return null
  },
  // 0.1.5 refuses an undefined state outright — `requireState` throws
  // `conversation Definition "…" returned undefined from start()`
  // (dsh-client-ui-conversation/lib/client.js:2165-2168), and that throw lands
  // inside the conversation view's own assembly, which leaves the transcript
  // EMPTY. Returning undefined here is therefore not a missing feature but a
  // blank conversation, so this always answers with a state object: a marker that
  // replaced nothing says so (`replacedNothing`), and an unreadable cut yields a
  // state whose `truncatedFromSeq` is absent, which `markerCutOf` reports and
  // skips. The marker then hides nothing, which is the only acceptable failure for
  // a range that cannot be established.
  start: (_context: any, match: any) => {
    const event = match?.event
    const seq = typeof event?.seq === 'number' && Number.isSafeInteger(event.seq) ? event.seq : 0
    const op = event?.surfaceOp
    // The append form is the degenerate rollback: the host had nothing left to
    // replace (the system-prompt clamp), so it appended the checkpoint without any
    // range. That is an empty replaced range BY CONTRACT, recorded as
    // `replacedNothing`, because a `truncatedFromSeq` that is merely absent means
    // "unreadable" everywhere else in this file and must keep meaning exactly that.
    if (op === 'append' || op === undefined) return { seq, replacedNothing: true }
    return { seq, truncatedFromSeq: surfaceCutOf(op) }
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

/**
 * The conversation-node registry this DSH build ships, in preference order.
 *
 * 0.1.5 keeps it on `uiConversation` (`uiConversation.events`, a
 * `ConversationEventRegistry`); 0.1.1 provided the same role as a service of its
 * own, `conversationEvents`. Both are looked up through `ctx.get`, which needs no
 * `inject` entry and returns undefined while the providing fiber is inactive — so
 * this answers "can the registry be used right now", not "does the package
 * exist". Naming either one in `inject` is what must never happen (see the
 * `inject` comment): the other version would park the fiber forever.
 * @param ctx - a context able to resolve services.
 * @returns the registry, or undefined when neither route is available.
 */
function eventRegistryOf(ctx: any): any {
  const modern = ctx?.get?.('uiConversation')?.events
  if (modern !== undefined && typeof modern.register === 'function') return modern
  const legacy = ctx?.get?.('conversationEvents')
  if (legacy !== undefined && typeof legacy.register === 'function') return legacy
  return undefined
}

/** Whether the marker Definition is registered, and for which plugin context. */
let markerRegistered = false
let markerOwner: any = null

/**
 * Register the marker Definition on whichever registry this build ships.
 *
 * Exactly once per plugin context: `register` THROWS when the kind is already
 * taken, and both registries could exist in one future composition, so the two
 * waits in `apply()` must not race into a duplicate. A different (new) plugin
 * context re-attempts the registration instead of trusting the flag, because a
 * registration belongs to the fiber that made it — a re-run whose anchor silently
 * vanished is precisely the failure mode this file exists to prevent, and a
 * still-live Definition turns the second attempt into the reported duplicate
 * rather than into two markers.
 *
 * The registry owns the registration's lifetime through the CALLER's context
 * (cordis rebinds the service to the caller), so passing the plugin's own `ctx`
 * — never an injected child's — ties the marker to this plugin and not to a
 * transient dependency wait.
 * @param ctx - the plugin's own context.
 * @returns whether a registry was found (and now carries the Definition).
 */
function registerMarkerDefinition(ctx: any): boolean {
  if (markerRegistered && markerOwner === ctx) return true
  const registry = eventRegistryOf(ctx)
  if (registry === undefined) return false
  try {
    registry.register(markerDefinition)
  } catch (error) {
    // Already registered: the durable anchor exists either way, so a duplicate is
    // not a failure — but it IS printed, because a foreign owner of
    // `rollback-marker` would otherwise look exactly like success.
    warnOnce('marker-dup', 'rollback marker Definition is already registered on this registry', msg(error))
  }
  markerRegistered = true
  markerOwner = ctx
  return true
}

/**
 * Whether the session kit declares the 0.1.5 `chat` hook (delivered to entries as
 * the `useChat` prop).
 *
 * It is read from the live session-standard roster — the very object the renderer
 * turns into props — rather than guessed from a version number. The roster lists
 * every DECLARED hook even while no Session is selected, so the answer is about
 * the composition, not about the current conversation.
 * @param ctx - a context able to resolve services.
 * @returns true/false when the roster is readable, undefined when this build has
 * no readable roster (the audit then stays silent instead of guessing).
 */
function chatHookDeclared(ctx: any): boolean | undefined {
  const hooks = ctx?.get?.('uiSession')?.adapter?.current?.getSnapshot?.()?.hooks
  if (hooks === null || typeof hooks !== 'object') return undefined
  return Object.prototype.hasOwnProperty.call(hooks, 'chat')
}

/**
 * How long the start-up audit keeps re-checking before it reports (ms), and how
 * often it looks in that window. The wait exists because a MISSING seam and a
 * NOT-YET-MOUNTED one are indistinguishable at boot: our bundle may be applied
 * before the plugin that ships the seam (nothing makes ui-chat load first), so a
 * single early check would name a healthy composition as broken. A seam that is
 * still absent after this window is a real mismatch for this page load.
 */
const AUDIT_WINDOW_MS = 8000
const AUDIT_INTERVAL_MS = 500

/**
 * The framework seams this bundle needs and cannot find right now, by name.
 *
 * The chat hook is audited only where the modern registry route is in play,
 * because that is by definition the route that moved chat off the session
 * snapshot: on the legacy route `snapshot.chat` is the expected source, so a
 * roster without a `chat` hook proves nothing there.
 * @param ctx - the plugin's own context.
 * @returns one message per missing seam, empty when both are present.
 */
function missingContracts(ctx: any): string[] {
  const missing: string[] = []
  if (!markerRegistered) {
    missing.push('conversation-node registry — neither ctx.get("uiConversation").events nor ctx.get("conversationEvents") is available, so the rollback marker cannot be anchored')
  }
  if (ctx?.get?.('uiConversation')?.events !== undefined && chatHookDeclared(ctx) === false) {
    missing.push('chat snapshot hook — the session kit declares no "chat" hook, so no useChat prop reaches the entries and 0.1.5 has no snapshot.chat to fall back to')
  }
  return missing
}

/**
 * Start-up audit of the two framework seams this bundle cannot work without,
 * reported LOUDLY and by name.
 *
 * Written for the failure this port hit: the browser half loaded, `apply()` never
 * ran because a service it named no longer existed, and a plugin that renders
 * nothing is indistinguishable from a plugin that was never installed. "It does
 * nothing" is not a diagnosis, so each seam is named individually — and only
 * after {@link AUDIT_WINDOW_MS} of re-checking, so a seam that merely arrives
 * late is never reported. The driver reports the chat half again per session,
 * where the props make it directly observable.
 * @param ctx - the plugin's own context.
 */
function auditContracts(ctx: any): void {
  const deadline = Date.now() + AUDIT_WINDOW_MS
  const check = (): void => {
    const missing = missingContracts(ctx)
    if (missing.length === 0) return
    if (Date.now() < deadline) {
      setTimeout(check, AUDIT_INTERVAL_MS)
      return
    }
    errorOnce('contracts', 'framework contract mismatch: ' + missing.join('; ')
      + ' — still missing ' + (AUDIT_WINDOW_MS / 1000) + 's after the client applied')
  }
  // The first check lands on a macrotask, because the `ctx.inject` waits in
  // `apply()` run on a microtask: checking synchronously would report a healthy
  // service as absent.
  if (typeof setTimeout === 'function') setTimeout(check, 0)
  else check()
}

/** The marker node's view: nothing at all.
 *
 * It exists as the durable anchor `syncHides` reads the replaced range from — a
 * range that a `replace` marker states and an `append` marker states as empty
 * (nothing was left to replace) — and a rollback must leave no trace in the
 * transcript: no divider, no notice. The welcome hero is NOT rendered here,
 * because a node's seat can be missing or sit inside a container the hide pass
 * collapsed, which would swallow the hero silently; the driver hosts it instead
 * (see {@link RollbackHero}). */
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
/** Turn number encoded in a picker option id (`turn-12`, or `previous-12` for the head). */
function pickerTurnOf(id: unknown): number {
  const m = typeof id === 'string' ? /^(?:turn|previous)-(\d+)$/.exec(id) : null
  if (m === null) return Number.NaN
  const turn = Number(m[1])
  return Number.isSafeInteger(turn) && turn >= 1 ? turn : Number.NaN
}

/**
 * The `/rollback` turn picker, and the two menu rows that reach it.
 *
 * Picking an entry inserts NOTHING into the composer — the menu consumes the token
 * and the shell is the framework's own component — so this is the whole interaction:
 * open, choose a turn, done. That is why the host command no longer advertises a
 * spelling to copy.
 *
 * It takes TWO registrations because the framework splits what a row may carry:
 *
 * - `decorate` hangs the popup on the HOST command. A host row can never carry an
 *   icon or localized copy (the catalog hands the client its name and its one
 *   description, and the localized faces are a table inside `dsh-client-ui-commands`
 *   that third parties cannot extend) — so this is what makes picking `rollback`
 *   open the picker.
 * - `register` adds the Chinese row. A client contribution is the only kind of row
 *   that can carry `icon`/`label`/`description`, and it may NOT share a name with a
 *   host command: that check throws while the menu is being built and takes the whole
 *   command group down with it. So `回退` is registered as its own row rather than as
 *   a second spelling on the host's, and only while the interface is Chinese — an
 *   English interface has the `rollback` row for exactly this.
 *
 * The replacement for a Remote call: a profile-loaded host half cannot import a core
 * package at runtime (measured — the entry fails to import), so the client reaches
 * this plugin's host half through the shipped `commands` Remote, and the host command
 * therefore has to keep existing under a name of its own.
 * @param ctx - the plugin's client context.
 * @param t - the plugin's translator, already bound to {@link NS}.
 */
function registerRollbackCommand(ctx: any, t: (key: RollbackKey, params?: Record<string, string | number>) => string): void {
  const sessionIdOf = (session: any): string | undefined =>
    typeof session?.sessionId === 'string' ? session.sessionId : undefined

  // Every turn the host still holds a checkpoint for. An unreadable list yields no
  // rows, and the picker then says so, rather than offering a turn a click would fail
  // on. Newest first: the recent turns are the ones worth undoing.
  const optionsOf = async (session: any): Promise<unknown[]> => {
    const sessionId = sessionIdOf(session)
    if (sessionId === undefined) return []
    const turns = turnsOf((await extCommand(ctx, sessionId, '/rollback list')).text ?? '') ?? []
    const newest = turns[turns.length - 1]
    const rows: unknown[] = []
    // The head is a shortcut for the newest turn, which is also listed below — the
    // duplicate is deliberate: it is the action wanted most of the time.
    if (newest !== undefined) rows.push({ id: `previous-${newest}`, label: t('picker.previous') })
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      const turn = turns[i]!
      rows.push({ id: `turn-${turn}`, label: t('picker.turn', { turn }) })
    }
    return rows
  }

  const ui = {
    kind: 'popupSelect',
    searchMode: 'substring',
    searchLabels: () => ({
      placeholder: t('picker.placeholder'),
      empty: t('picker.empty'),
      noResults: t('picker.noResults'),
    }),
    options: optionsOf,
    // Choosing a turn opens the SAME confirmation the button opens — the affected
    // files, and the right to cancel — instead of rolling back on the spot. That is
    // what makes the picker a menu rather than a trigger: it picks a TARGET, it does
    // not commit to one. It is the module-level bridge the assistant action and the
    // turn footer already use, so this path inherits that whole flow, including
    // re-attaching the rolled-back turn's images to the composer.
    onSelect: async (option: any, session: any): Promise<void> => {
      const sessionId = sessionIdOf(session)
      const turn = pickerTurnOf(option?.id)
      if (sessionId === undefined || Number.isNaN(turn)) return
      if (openRollbackDialog !== null) {
        openRollbackDialog(turn)
        return
      }
      // The dialog is hosted by the dock entry, so this only happens with no
      // conversation surface mounted. Executing is the one route left; saying so is
      // better than a picker that silently does nothing.
      warnOnce('picker-no-dialog', 'no rollback dialog is mounted, so the picked turn is executed without confirmation')
      await extCommand(ctx, sessionId, '/rollback --apply ' + turn)
    },
  }

  ctx.inject(['commandUi'], (scope: any) => {
    const commandUi = scope.get?.('commandUi') ?? scope.commandUi
    if (commandUi === undefined || typeof commandUi.decorate !== 'function') {
      errorOnce('command-ui', 'the command menu is unavailable: no commandUi service, so /rollback offers no turn picker')
      return
    }
    scope.effect(
      () => commandUi.decorate({ name: 'rollback', available: () => true, ui }),
      'rollback: /rollback turn picker',
    )
    // Deliberately NO client contribution. A contribution is the only kind of row
    // that can carry an icon or localized copy, but it may not share a name with a
    // host command (that check throws while the menu is built and takes the whole
    // command group down), and the host command has to exist — the browser half
    // reaches this plugin's host through the shipped `commands` Remote, and a
    // profile-loaded host half cannot import a core package to expose a Remote of its
    // own (measured: the entry fails to import). So the menu can never be one row AND
    // carry an icon, and this plugin chose the one row: the host command's, whose
    // description carries both languages because it cannot follow the interface.
  })
}

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

  // The command menu row and its turn picker. Registered through a dynamic inject
  // rather than by naming `commandUi` in `inject`: a name no service provides would
  // park this whole half in "pending" forever (see the inject comment at the top),
  // and the picker is an addition, not a reason to lose the rollback button.
  if (typeof ctx.locale?.bind === 'function') {
    const t = ctx.locale.bind(NS) as (key: RollbackKey, params?: Record<string, string | number>) => string
    registerRollbackCommand(ctx, t)
  } else {
    errorOnce('locale-bind', 'no locale.bind, so the /rollback menu entry and its turn picker are not registered')
  }

  // The marker node is the durable anchor `syncHides` reads the replaced range
  // from — the range a `replace` marker states, or the empty one an `append` marker
  // states — and the driver renders the welcome hero when that rollback emptied the
  // surface (see RollbackMarkerView): an ordinary rollback renders no divider.
  //
  // The registry is acquired dynamically (see `eventRegistryOf`): a synchronous
  // hit is the normal case, and the `ctx.inject` waits cover a service that only
  // becomes active later. Each wait names ONE service, because a plain array is a
  // required SET in cordis and a single wait for both would be parked forever by
  // whichever one this build lacks — the very bug this registration replaces.
  if (!registerMarkerDefinition(ctx) && typeof ctx.inject === 'function') {
    ctx.inject(['uiConversation'], () => { registerMarkerDefinition(ctx) })
    ctx.inject(['conversationEvents'], () => { registerMarkerDefinition(ctx) })
  }

  // The audit re-checks over a short window (see `auditContracts`): its first
  // check lands on a macrotask, because the waits above run on a microtask.
  auditContracts(ctx)

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
  // would be missing exactly when it is wanted. The entry renders nothing for every
  // other turn, so this never duplicates the strip's button.
  //
  // The seat's own shape is the one thing that differs between the supported builds
  // — a chain with a `select` election on 0.1.5, a list with an `id` on 0.2.0 — so
  // the registration picks whichever spelling this build takes (see
  // registerTurnTailEntry). The guard stays because a rejection here leaves a
  // silently empty row: reported loudly, and the strip's button remains the only —
  // still working — entry.
  ctx.slots.inject('conversation.chat.turnTail', () => {
    try {
      const dispose = registerTurnTailEntry(ctx)
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
          await extCommand(ctx, sessionId, '/rollback --apply ' + turn)
        },
        list: async () => (await extCommand(ctx, sessionId, '/rollback list')).text ?? '',
        restoreAttachments: (images: { name: string; mediaType: string; attachment: any }[]) =>
          restoreDraftAttachments(ctx, sessionId, images),
        // The first-party release face, read once here where the context is at hand.
        conversation: { releaseDraftAttachments: ctx.get?.('conversation')?.releaseDraftAttachments?.bind(ctx.get('conversation')) },
        releaseAttachments: (ids: readonly string[]) => {
          const conversation = ctx.get?.('conversation')
          if (conversation?.releaseDraftAttachment === undefined) return
          for (const id of ids) {
            try { conversation.releaseDraftAttachment(id) } catch { /* best effort */ }
          }
        },
      }),
    }, RollbackDriver)
    return () => dispose()
  })
}