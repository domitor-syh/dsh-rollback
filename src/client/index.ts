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
 * The DOM pass hides stable node/group identities explicitly revoked by
 * bounded, session-matching Host state. React-owned rows are never deleted.
 * Client-generated read receipts carry an explicit `--internal` marker and are
 * hidden only when their command node matches that marker; user-entered
 * `/rollback list`, `state`, and `preview` commands remain visible.
 *
 * @module @domitor-syh/dsh-rollback/client
 */

import { decodeRestoredFile, planFileRestores, type RestoreAttachment } from './attachment-restore.ts'
import { RollbackCommandMenu } from './command-menu.ts'
import * as React from 'react'
import { createPortal } from 'react-dom'
import { FishLogo, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { footerEntryNeeded, isTurnTailShapeRejection, otherTurnTailShape, turnTailRegistration, type TurnTailShape } from '../core/turn-entry.ts'
import { isRollbackMarkerSource } from '../core/truncation-plan.ts'
import { oldestTurnOf, turnsOf } from '../core/rollback-guard.ts'
import type { RollbackState } from '../core/rollback-boundary.ts'
import { isRevokedSeat, stateForSession, RequestGeneration, previewVersionOf, rollbackRefreshSignature, isInternalReadOnlyRollbackCommand, isRollbackCommand, isReadOnlyRollbackArgs, seatIdentity } from './rollback-state.ts'

/**
 * Required services: slots, the `commands` Remote, and locale. Automatic
 * read-only queries use the same command transport with an explicit
 * `--internal` argument; the presentation pass recognizes only that marker.
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
const BUNDLE_REV = 47
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
  'dialog.conflictWarning': '警告:检测到文件有人为/外部应用修改痕迹，请谨慎回退',
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
  'picker.preview': '选择轮次，预览受影响文件',
  'picker.commands': 'rollback 子命令',
  'picker.enterHint': '选择只补全命令；返回输入框后按回车执行',
  'picker.previewBack': '选择预览轮次 · Esc 返回子命令',
  'picker.loadError': '轮次加载失败，请返回后重试',
  'picker.changed': '输入已变化，未补全或执行命令',
  'picker.latest': '回退到最近一轮',
  'picker.list': '查看可回退轮次',
  'picker.state': '查看回退状态',
  'picker.rescues': '查看文件救援点',
  'picker.diagnose': '运行回退诊断',
  'picker.retry': '继续未完成的回退',
  'picker.abort': '尝试中止未完成的回退',
} satisfies Record<string, string>

const en: Record<keyof typeof zh, string> = {
  'action.label': 'Roll back to before this turn',
  'action.running': 'This turn is still running: pause it or wait for it to finish',
  'dialog.title': 'Roll back to before this turn',
  'dialog.aria': 'Rollback confirmation',
  'dialog.warning': 'This action is irreversible. It will restore workspace files affected by this turn and later, and truncate the model context.',
  'dialog.conflictWarning': 'Warning: Files show signs of manual or external application changes. Roll back with caution.',
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
  'picker.preview': 'Choose a turn to preview affected files',
  'picker.commands': 'rollback subcommands',
  'picker.enterHint': 'Selection completes text only; press Enter in the composer to execute',
  'picker.previewBack': 'Choose a preview turn · Esc returns to subcommands',
  'picker.loadError': 'Unable to load turns; go back and retry',
  'picker.changed': 'Draft changed; no command was completed or executed',
  'picker.latest': 'Rollback the latest turn',
  'picker.list': 'List rollbackable turns',
  'picker.state': 'View rollback state',
  'picker.rescues': 'View file rescue points',
  'picker.diagnose': 'Run rollback diagnostics',
  'picker.retry': 'Continue pending rollback',
  'picker.abort': 'Attempt to abort pending rollback',
}

type RollbackKey = keyof typeof zh

/** One affected file in the preview dialog, normalized to an internal action. */
interface PreviewFile {
  path: string
  action: 'restore' | 'recover' | 'delete' | 'skip'
  conflict?: boolean
}

/** Parse tagged file rows and exact-path conflict metadata from the host preview. */
function parsePreview(text: string | undefined): PreviewFile[] {
  if (text === undefined || text === null) return []
  const out: PreviewFile[] = []
  const conflicts = new Set<string>()
  for (const line of text.split('\n')) {
    if (line.startsWith('RollbackConflicts: ')) {
      try {
        const paths: unknown = JSON.parse(line.slice('RollbackConflicts: '.length))
        if (Array.isArray(paths) && paths.every((path: unknown) => typeof path === 'string')) {
          for (const path of paths) conflicts.add(path)
        }
      } catch { /* Older/malformed metadata must not invent conflicted rows. */ }
      continue
    }
    const m = /^\s*\[(恢复|找回|删除|跳过|restore|recover|delete|skip)\]\s+(.+)$/ui.exec(line)
    if (m === null) continue
    const raw = m[1]!.toLowerCase()
    const action = raw === 'restore' || raw === '恢复' ? 'restore' as const
      : raw === 'recover' || raw === '找回' ? 'recover' as const
        : raw === 'delete' || raw === '删除' ? 'delete' as const
          : 'skip' as const
    out.push({ action, path: m[2]!.trim() })
  }
  for (const file of out) {
    if (conflicts.has(file.path)) file.conflict = true
  }
  return out
}

type AttachmentFailureStage = 'resolve' | 'fetch' | 'response' | 'decode' | 'file'
  | 'createDrafts' | 'createDraftImages' | 'create-result' | 'release'
interface AttachmentFailure {
  stage: AttachmentFailureStage
  api: 'modern' | 'legacy' | 'descriptors' | 'id'
  index?: number
  status?: number
  reason: 'exception' | 'http-status' | 'missing-draft-id' | 'unavailable'
  errorName?: string
}
interface RestoredAttachments {
  ids: string[]
  descriptors: unknown[]
  failures: AttachmentFailure[]
}

/** Never log arbitrary error messages: they may contain URLs, names or file data. */
function attachmentErrorName(error: unknown): string {
  try {
    const name = error instanceof Error ? error.name : ''
    return ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'AbortError', 'NetworkError',
      'NotFoundError', 'NotSupportedError', 'SecurityError', 'InvalidStateError',
      'QuotaExceededError', 'EncodingError'].includes(name) ? name : 'UnknownError'
  } catch { return 'UnknownError' }
}

function reportAttachmentFailure(failure: AttachmentFailure): void {
  console.warn('[rollback] attachment failure:', failure)
}

/**
 * Rebuild image and ordinary-file attachments of a rolled-back turn.
 * Modern images use imageUrl; files use the public rollback command export.
 * Both create fresh drafts; legacy resolveImage + createDraftImages is image-only.
 * No modern-to-legacy fallback. Preserve attachment order and cancellation
 * guards; skip individual failures without rejecting the successful drafts.
 * `decode` describes Response.blob() for images and strict base64 decoding for files.
 * @param ctx - the plugin's own context.
 * @param sessionId - the session the attachments belong to.
 * @param turn - the initiating turn the Host must authorize.
 * @param images - the rolled-back turn's durable attachments, in order.
 * @param current - whether the restore still owns this session operation.
 * @returns successful draft ids/descriptors and privacy-safe failure records.
 */
async function restoreDraftAttachments(
  ctx: any,
  sessionId: string,
  turn: number,
  images: RestoreAttachment[],
  current: () => boolean = () => true,
): Promise<RestoredAttachments> {
  const conversation = ctx?.get?.('conversation')
  const uiConversation = ctx?.get?.('uiConversation')
  if (conversation !== undefined && typeof conversation.createDrafts === 'function') {
    const allowedFiles = planFileRestores(images, turn)
    const ids: string[] = []
    const descriptors: unknown[] = []
    const failures: AttachmentFailure[] = []
    for (const [index, img] of images.entries()) {
      if (!current()) break
      let stage: AttachmentFailureStage = 'resolve'
      try {
        let file: File
        if (img.kind === 'file') {
          if (!allowedFiles.has(index)) throw new RangeError('Invalid or over-budget file reference')
          const response = await extCommand(ctx, sessionId, `/rollback --internal file ${turn} ${img.attachment.attachmentId}`)
          if (!current()) break
          stage = 'decode'
          const { name, decoded } = decodeRestoredFile(response.text, img.attachment.bytes)
          if (!current()) break
          stage = 'file'
          file = new File([decoded], name, { type: 'application/octet-stream' })
        } else {
          if (typeof uiConversation?.imageUrl !== 'function') throw new TypeError('Image API unavailable')
          const url: string = await uiConversation.imageUrl(sessionId, img.attachment)
          if (!current()) break
          stage = 'fetch'
          const resp = await fetch(url)
          if (!current()) break
          stage = 'response'
          if (!resp.ok) {
            const failure: AttachmentFailure = { index, stage, api: 'modern', reason: 'http-status', status: resp.status }
            failures.push(failure)
            reportAttachmentFailure(failure)
            continue
          }
          stage = 'decode'
          const blob = await resp.blob()
          if (!current()) break
          stage = 'file'
          file = new File([blob], img.name || 'attachment', { type: blob.type || img.mediaType || 'application/octet-stream' })
        }
        if (!current()) break
        stage = 'createDrafts'
        const drafts = conversation.createDrafts(sessionId, [file])
        stage = 'create-result'
        const id = drafts?.[0]?.id
        if (typeof id === 'string' && id !== '') {
          ids.push(id)
          descriptors.push(drafts[0])
        } else if (current()) {
          const failure: AttachmentFailure = { index, stage, api: 'modern', reason: 'missing-draft-id' }
          failures.push(failure)
          reportAttachmentFailure(failure)
        }
      } catch (error) {
        if (!current()) break
        const failure: AttachmentFailure = { index, stage, api: 'modern', reason: 'exception', errorName: attachmentErrorName(error) }
        failures.push(failure)
        reportAttachmentFailure(failure)
      }
    }
    // The descriptors, not just the ids: releasing a refused draft needs the object the
    // FIRST-PARTY face takes (`conversation.releaseDraftAttachments(drafts)` — the same
    // call the product's own composer makes), and that is more reliable than this
    // plugin's optional `inputActions` release verb.
    return { ids, descriptors, failures }
  }
  if (conversation !== undefined && typeof conversation.resolveImage === 'function'
    && typeof conversation.createDraftImages === 'function') {
    const ids: string[] = []
    const descriptors: unknown[] = []
    const failures: AttachmentFailure[] = []
    for (const [index, img] of images.entries()) {
      if (!current()) break
      if (img.kind === 'file') {
        const failure: AttachmentFailure = { index, stage: 'resolve', api: 'legacy', reason: 'unavailable' }
        failures.push(failure)
        reportAttachmentFailure(failure)
        continue
      }
      let stage: AttachmentFailureStage = 'resolve'
      try {
        const url: string = await conversation.resolveImage(sessionId, img.attachment)
        if (!current()) break
        stage = 'fetch'
        const resp = await fetch(url)
        if (!current()) break
        stage = 'response'
        if (!resp.ok) {
          const failure: AttachmentFailure = { index, stage, api: 'legacy', reason: 'http-status', status: resp.status }
          failures.push(failure)
          reportAttachmentFailure(failure)
          continue
        }
        stage = 'decode'
        const blob = await resp.blob()
        if (!current()) break
        stage = 'file'
        const file = new File([blob], img.name || 'attachment', { type: blob.type || img.mediaType || 'application/octet-stream' })
        stage = 'createDraftImages'
        const drafts = conversation.createDraftImages([file])
        stage = 'create-result'
        // Keep the legacy acceptance rule; tightening its ID validation is not diagnostics.
        if (drafts !== null && drafts[0] !== undefined && drafts[0].id !== undefined) {
          ids.push(drafts[0].id)
          descriptors.push(drafts[0])
        } else if (current()) {
          const failure: AttachmentFailure = { index, stage, api: 'legacy', reason: 'missing-draft-id' }
          failures.push(failure)
          reportAttachmentFailure(failure)
        }
      } catch (error) {
        if (!current()) break
        const failure: AttachmentFailure = { index, stage, api: 'legacy', reason: 'exception', errorName: attachmentErrorName(error) }
        failures.push(failure)
        reportAttachmentFailure(failure)
      }
    }
    return { ids, descriptors, failures }
  }
  warnOnce(
    'restore-images-api',
    'no attachment-restore API is available: neither conversation.createDrafts + uiConversation.imageUrl (0.1.5) nor conversation.resolveImage + createDraftImages (0.1.1) exists, so the rolled-back turn\'s attachments cannot be re-attached',
  )
  return { ids: [], descriptors: [], failures: [] }
}

/** A `/rollback` command through the shipped Remote, unwrapping its envelope. */
function extCommand(ctx: any, sessionId: string, line: string): Promise<{ text?: string }> {
  return ctx.remote.commands.execute(sessionId, line, []).then((r: any) => {
    if (!r || r.ok === false) throw new Error(r?.error?.message ?? 'command failed')
    const exec = r.value
    if (exec === undefined || exec === null) throw new Error(`cannot resolve command: ${line}`)
    const result = exec.result
    if (result.kind === 'error') throw new Error(result.text ?? 'command failed')
    return { text: result.text }
  })
}

const CSS =
  '.rbk-completion{position:absolute;bottom:100%;left:0;z-index:1400;width:min(680px,90vw);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-panel,16px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 12px 40px #0004;padding:8px;}' +
  '.rbk-completion-columns{display:flex;gap:8px;}.rbk-completion-columns>div{flex:1;min-width:0;max-height:45vh;overflow:auto;}' +
  '.rbk-completion-heading{padding:8px;font-size:12px;color:var(--dsw-alias-label-secondary);}' +
  '.rbk-completion-row{display:flex;flex-direction:column;gap:3px;width:100%;text-align:left;padding:8px;border:0;border-radius:var(--dsw-radius-md,10px);background:transparent;color:inherit;cursor:pointer;}' +
  '.rbk-completion-row:hover,.rbk-completion-row[aria-selected=true]{background:var(--dsw-alias-interactive-bg-hover);}.rbk-completion-row small{color:var(--dsw-alias-label-secondary);}' +
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
  '.rbk-conflict-dot{display:block;box-sizing:border-box;flex:0 0 8px;width:8px;height:8px;min-width:8px;min-height:8px;max-width:8px;max-height:8px;aspect-ratio:1;padding:0;border:0;border-radius:50%;clip-path:circle(50%);background:var(--dsw-static-amber-400);animation:rbk-conflict-blink 2.4s ease-in-out infinite;}' +
  '@keyframes rbk-conflict-blink{0%,100%{opacity:1}50%{opacity:.3}}' +
  '@media(prefers-reduced-motion:reduce){.rbk-conflict-dot{animation:none;opacity:1;}}' +
  '.rbk-conflict-warning{padding:0 16px 12px;font-size:11px;line-height:1.5;color:var(--dsw-alias-state-warn-primary);}' +
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
 * Images use the image-only imageUrl API; ordinary files use a bounded Host
 * command export keyed by session, turn and durable attachment id. Workspace
 * @path references remain text, not binary attachments.
 * @param chat - the chat snapshot slice (see {@link useChatOrSnapshot}).
 * @param turn - the 1-based turn whose attachments are wanted.
 */
function findUserAttachments(chat: any, turn: number): RestoreAttachment[] {
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
      // Keep block kind: file references must never reach the image-only resolver.
      .filter((b: any) => (b?.type === 'image' || b?.type === 'file') && b?.attachment)
      .map((b: any) => ({
        kind: b.type as 'image' | 'file',
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

/** Only known infrastructure is ignored for the cosmetic empty hero; unknown kinds are content. */
function isUiOnlyNode(node: any): boolean {
  if (node?.kind === 'turn-tail' || node?.kind === 'turn-process' || node?.kind === 'rollback-marker') return true
  // Pinned rc.2 isVisibleChatNode excludes these even with visibility:'visible'.
  // They stay in the projection order but have no transcript row.
  if (node?.visibility === 'hidden' || node?.kind === 'system-prompt') return true
  if (node?.kind === 'command' && node.data?.name === 'permission') return true
  if (node?.kind === 'context' && Array.isArray(node.data?.content)) {
    return !node.data.content.some((block: any) => block?.type === 'tool-addition' || block?.type === 'tool-removal')
  }
  return false
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

/** Only plugin-owned hiding is reversible; preserve preexisting inline styles. */
const RBK_HIDDEN_ATTR = 'data-rbk-hidden'
const rollbackHiddenSeats = new Map<HTMLElement, { display: string; priority: string }>()

function hideRollbackSeat(el: HTMLElement): void {
  if (!rollbackHiddenSeats.has(el)) {
    rollbackHiddenSeats.set(el, { display: el.style.getPropertyValue('display'), priority: el.style.getPropertyPriority('display') })
  }
  el.setAttribute(RBK_HIDDEN_ATTR, '')
  el.style.setProperty('display', 'none')
}

function revealRollbackSeat(el: HTMLElement): void {
  const previous = rollbackHiddenSeats.get(el)
  if (previous === undefined) return
  rollbackHiddenSeats.delete(el)
  el.removeAttribute(RBK_HIDDEN_ATTR)
  // Do not overwrite a different display decision made by the framework meanwhile.
  if (el.style.getPropertyValue('display') !== 'none') return
  if (previous.display === '') el.style.removeProperty('display')
  else el.style.setProperty('display', previous.display, previous.priority)
}

function revealAllRollbackSeats(): void {
  for (const el of [...rollbackHiddenSeats.keys()]) revealRollbackSeat(el)
}

let lastCensus = ''

/** Hide finite revoked seats; missing flow/node membership is never proof of revocation. */
function syncHides(chat: any, state: RollbackState | null): void {
  heroWanted.visible = false
  const store = chat?.nodes
  const order = chat?.order
  const internalCommandKeys = new Set<string>(
    Array.isArray(order) && typeof store?.get === 'function'
      ? order.filter((key: unknown) => typeof key === 'string' && isInternalReadOnlyRollbackCommand(store.get(key))).map((key: unknown) => key as string)
      : [],
  )
  const seats = [...document.querySelectorAll<HTMLElement>('[data-chat-node-key], [data-chat-group-key]')]
  const isInternalSeat = (el: HTMLElement): boolean => {
    const identity = seatIdentity(el)
    return identity?.kind === 'node' && internalCommandKeys.has(identity.key)
  }
  const isHiddenRollbackCommandSeat = (el: HTMLElement): boolean => {
    const identity = seatIdentity(el)
    if (identity?.kind !== 'node' || !isRollbackCommand(store?.get?.(identity.key))) return false
    const node = store?.get?.(identity.key)
    const args = node?.data?.args
    return typeof args !== 'string' || !isReadOnlyRollbackArgs(args)
  }
  if (state === null) {
    revealAllRollbackSeats()
    for (const el of seats) if (isInternalSeat(el) || isHiddenRollbackCommandSeat(el)) hideRollbackSeat(el)
    return
  }
  const seqOf = (key: string): unknown => typeof store?.get === 'function' ? store.get(key)?.anchorSeq : undefined
  const revoked = new Set<HTMLElement>()
  for (const el of seats) {
    if (isInternalSeat(el) || isHiddenRollbackCommandSeat(el) || isRevokedSeat(el, state, seqOf)) {
      revoked.add(el)
      hideRollbackSeat(el)
    } else revealRollbackSeat(el)
  }
  for (const el of [...rollbackHiddenSeats.keys()]) {
    if (!revoked.has(el)) revealRollbackSeat(el)
  }

  // The hero is cosmetic. Require both readable nodes and no standing DOM seat;
  // unknown rows/groups keep it off, and never authorize hiding scaffolding.
  if (state.ranges.length > 0 && Array.isArray(order) && typeof store?.get === 'function') {
    const noStandingContent = order.every((key: unknown) => {
      if (typeof key !== 'string') return false
      const node = store.get(key)
      if (node === undefined || node === null) return false
      if (node.kind === 'rollback-marker' || isUiOnlyNode(node) || node.visibility === 'hidden'
        || isInternalReadOnlyRollbackCommand(node)
        || (isRollbackCommand(node) && (typeof node.data?.args !== 'string' || !isReadOnlyRollbackArgs(node.data.args)))) return true
      const seq = node.anchorSeq
      return typeof seq === 'number' && Number.isSafeInteger(seq)
        && state.ranges.some(range => seq >= range.start && seq <= range.end)
    })
    const standingSeat = seats.some(el => {
      const identity = seatIdentity(el)
      // A custom marker renderer returns null, but the framework still mounts its
      // node wrapper. Likewise known infrastructure wrappers carry no content.
      if (identity?.kind === 'node' && isUiOnlyNode(store.get(identity.key))) return false
      return !el.hasAttribute('hidden') && !revoked.has(el)
        && !el.closest('[data-rbk-hidden]') && el.style.display !== 'none'
    })
    heroWanted.visible = noStandingContent && !standingSeat
  }
  const census = { sessionId: state.sessionId, version: state.version, revokedTurns: state.turns,
    ranges: state.ranges, seats: seats.length, hidden: revoked.size, hero: heroWanted.visible }
  const signature = JSON.stringify(census)
  if (signature !== lastCensus) {
    lastCensus = signature
    console.info('[rollback] bounded hides:', census)
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
  // Process-group bodies publish the same attribute. Never portal into a nested
  // flow: its parent may be a revoked, hidden group even when the transcript is empty.
  const column = [...document.querySelectorAll<HTMLElement>('[data-chat-flow=""]')]
    .find(candidate => candidate.parentElement?.closest('[data-chat-flow=""]') == null)
  if (column === undefined) {
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
let rollbackDialogBridge: { sessionId: string; owner: symbol; open: (turn: number) => boolean } | null = null

/** The rollback action rendered on each finalized assistant message's action strip. */
function RollbackAction({ messageId, useSession, useChat, t }: any): React.ReactElement | null {
  if (typeof useSession !== 'function') {
    // Never silent: a missing button must always be traceable to a reason.
    warnOnce('action-session', 'assistant action lacks useSession')
    return null
  }
  const snapshot = useSession((s: any) => s)
  const chat = useChatOrSnapshot(useChat, snapshot)
  const oldest = useRollbackOldest(snapshot?.sessionId)
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
    onClick: () => { const bridge = rollbackDialogBridge; if (!disabled && turn !== undefined && bridge !== null && bridge.sessionId === snapshot?.sessionId) bridge.open(turn) },
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
let rollbackRangeSessionId: string | null = null
const rollbackRangeListeners = new Set<() => void>()

/** Publish the rollback range to the action components. */
function publishRollbackOldest(sessionId: string | null, oldest: number | null): void {
  rollbackRangeSessionId = sessionId
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
function useRollbackOldest(sessionId: string | undefined): number | null {
  const [, bump] = React.useState(0)
  React.useEffect(() => {
    const listener = (): void => { bump(n => n + 1) }
    rollbackRangeListeners.add(listener)
    return () => { rollbackRangeListeners.delete(listener) }
  }, [])
  return sessionId !== undefined && rollbackRangeSessionId === sessionId ? rollbackOldest : null
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
  const snapshot = typeof useSession === 'function' ? useSession((s: any) => s) : undefined
  const oldest = useRollbackOldest(snapshot?.sessionId)
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
  const blocked = snapshot?.running === true || (oldest !== null && turnNo < oldest)
  log('turn-footer action rendered', { turn: turnNo, blocked })
  // Disabled says it: the greyed style is the whole message. A tooltip here would not
  // render anyway (a disabled button takes no hover) and a second wording to keep in
  // sync is exactly the kind of redundant surface this codebase keeps pruning.
  const button = React.createElement('button', {
    type: 'button',
    className: 'rbk-act',
    'aria-label': t('action.label'),
    disabled: blocked,
    onClick: () => { const bridge = rollbackDialogBridge; if (!blocked && bridge !== null && bridge.sessionId === snapshot?.sessionId) bridge.open(turnNo) },
  }, React.createElement(RollbackIcon))
  return React.createElement(Tooltip, { label: t('action.label'), side: 'bottom', children: button })
}

interface DriverProps {
  sessionId: string
  preview: (turn: number) => Promise<{ files: PreviewFile[]; version: number | null }>
  execute: (turn: number, version: number) => Promise<void>
  /** Raw `/rollback list` output, for the range the action entries may offer. */
  list: () => Promise<string>
  /** Bounded, session-bound rollback state; unknown means no hiding. */
  state?: () => Promise<string>
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
  restoreAttachments?: (turn: number, images: RestoreAttachment[], current: () => boolean) =>
    Promise<{ ids: string[]; descriptors: unknown[]; failures?: AttachmentFailure[] }>
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
 * explicitly revoked seats) and hosts the single
 * confirmation dialog, opened from the assistant action through the module
 * bridge. Renders nothing into its own dock seat.
 */
function RollbackDriver(props: DriverProps): React.ReactElement | null {
  const { sessionId, useSession, useChat, inputActions, restoreAttachments, releaseAttachments, conversation, t } = props
  if (typeof useSession !== 'function') {
    warnOnce('useSession', 'props lack useSession', Object.keys({ useSession }))
    return null
  }
  const propsRef = React.useRef(props)
  propsRef.current = props
  const chatRef = React.useRef<any>(undefined)
  const ensureRef = React.useRef<() => void>(() => {})
  const refreshRef = React.useRef<() => Promise<void>>(async () => {})
  const scheduleRefreshRef = React.useRef<() => void>(() => {})
  const stateRef = React.useRef<RollbackState | null>(null)
  const ownerRef = React.useRef<symbol | null>(null)
  const previewRequests = React.useRef(new RequestGeneration())
  const executeRequests = React.useRef(new RequestGeneration())
  const busyRef = React.useRef(false)
  const previewVersionRef = React.useRef<number | null>(null)
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

  // Updated during render, before effects: an old promise cannot touch a switched session.
  const activeSessionRef = React.useRef<string | null>(null)
  activeSessionRef.current = snapshot?.sessionId === sessionId ? sessionId : null
  chatRef.current = chat
  const isCurrent = (owner: symbol | null): boolean => owner !== null
    && ownerRef.current === owner && rollbackDialogBridge?.owner === owner
    && activeSessionRef.current === sessionId

  const [dialogTurn, setDialogTurn] = React.useState<number | null>(null)
  const [files, setFiles] = React.useState<PreviewFile[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [heroOn, setHeroOn] = React.useState(false)
  const heroHostRef = React.useRef<HTMLElement | null>(null)

  const openDialog = React.useCallback((turn: number): boolean => {
    const owner = ownerRef.current
    if (!isCurrent(owner) || busyRef.current || snapshotRef.current?.running === true
      || !Number.isSafeInteger(turn) || turn < 1) return false
    // Opening a newer operation also invalidates any late composer attachment retries.
    executeRequests.current.invalidate()
    const request = previewRequests.current.next()
    previewVersionRef.current = null
    setDialogTurn(turn)
    setFiles(null)
    setError(null)
    void propsRef.current.preview(turn).then(result => {
      if (!isCurrent(owner) || !previewRequests.current.current(request)) return
      if (result.version === null) {
        setError('回退预览缺少有效版本；请更新 Host 后重试。 / Preview has no valid version; update the Host and retry.')
        return
      }
      previewVersionRef.current = result.version
      setFiles(result.files)
    }, (e: unknown) => {
      if (isCurrent(owner) && previewRequests.current.current(request)) setError(msg(e))
    })
    return true
  }, [sessionId])
  const snapshotRef = React.useRef(snapshot)
  snapshotRef.current = snapshot

  const closeDialog = (): void => {
    if (busyRef.current) return
    previewRequests.current.invalidate()
    previewVersionRef.current = null
    setDialogTurn(null)
    setFiles(null)
    setError(null)
  }

  React.useEffect(() => {
    if (snapshot?.sessionId !== sessionId) return
    const owner = Symbol(sessionId)
    ownerRef.current = owner
    rollbackDialogBridge = { sessionId, owner, open: openDialog }
    stateRef.current = null
    busyRef.current = false
    previewVersionRef.current = null
    previewRequests.current.invalidate()
    executeRequests.current.invalidate()
    revealAllRollbackSeats()
    heroWanted.visible = false
    lastCensus = ''
    publishRollbackOldest(sessionId, null)
    setDialogTurn(null)
    setFiles(null)
    setBusy(false)
    setError(null)
    console.info('[rollback] driver mounted:', { sessionId, rev: BUNDLE_REV })
    let raf = 0
    let refreshTimer: ReturnType<typeof setTimeout> | undefined
    const refreshRequests = new RequestGeneration()
    const ensure = (): void => {
      if (!isCurrent(owner)) return
      try { syncHides(chatRef.current, stateRef.current) } catch (error) {
        heroWanted.visible = false
        revealAllRollbackSeats()
        warnOnce('sync-hides', 'syncHides threw; hiding disabled', error)
      }
      try { syncHeroHost(heroHostRef, setHeroOn) } catch (error) {
        warnOnce('sync-hero', 'syncHeroHost threw', error)
      }
    }
    ensureRef.current = () => {
      if (!isCurrent(owner)) return
      if (raf) cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => { raf = 0; ensure() })
    }
    const refresh = async (): Promise<void> => {
      if (!isCurrent(owner)) return
      if (refreshTimer !== undefined) { clearTimeout(refreshTimer); refreshTimer = undefined }
      const request = refreshRequests.next()
      const faces = propsRef.current
      const [listResult, stateResult] = await Promise.allSettled([
        faces.list(), faces.state?.() ?? Promise.resolve(''),
      ])
      if (!isCurrent(owner) || !refreshRequests.current(request)) return
      if (listResult.status === 'fulfilled') publishRollbackOldest(sessionId, oldestTurnOf(listResult.value))
      else {
        publishRollbackOldest(sessionId, null)
        warnOnce('rollback-list', 'could not refresh the rollback range', listResult.reason)
      }
      stateRef.current = stateResult.status === 'fulfilled'
        ? stateForSession(stateResult.value, sessionId, stateRef.current) : null
      if (stateResult.status === 'rejected') warnOnce('rollback-state', 'could not refresh bounded state; hiding disabled', stateResult.reason)
      ensure()
    }
    refreshRef.current = refresh
    scheduleRefreshRef.current = () => {
      if (!isCurrent(owner)) return
      if (refreshTimer !== undefined) clearTimeout(refreshTimer)
      refreshTimer = setTimeout(() => { refreshTimer = undefined; void refresh() }, 120)
    }
    ensure()
    void refresh()
    // Manual rollback/history/checkpoint changes refresh via the semantic signature below.
    // Read RPCs are excluded by their exact official name/args fields, not by guessed IDs.
    const obs = new MutationObserver(() => ensureRef.current())
    obs.observe(document.body, { childList: true, subtree: true, attributes: true,
      attributeFilter: ['data-chat-node-key', 'data-chat-group-key', 'data-chat-turn'] })
    const onFocus = (): void => { void refresh() }
    window.addEventListener('focus', onFocus)
    return () => {
      obs.disconnect()
      window.removeEventListener('focus', onFocus)
      if (raf) cancelAnimationFrame(raf)
      if (refreshTimer !== undefined) clearTimeout(refreshTimer)
      refreshRequests.invalidate()
      // A superseded driver must not clear a newer driver's bridge or hidden seats.
      if (ownerRef.current === owner) {
        ownerRef.current = null
        previewRequests.current.invalidate()
        executeRequests.current.invalidate()
        busyRef.current = false
      }
      heroHostRef.current?.remove()
      heroHostRef.current = null
      if (rollbackDialogBridge?.owner === owner) {
        rollbackDialogBridge = null
        stateRef.current = null
        heroWanted.visible = false
        revealAllRollbackSeats()
        publishRollbackOldest(null, null)
        ensureRef.current = () => {}
        refreshRef.current = async () => {}
        scheduleRefreshRef.current = () => {}
      }
    }
  }, [sessionId, snapshot?.sessionId, openDialog])

  const refreshSignature = React.useMemo(() => rollbackRefreshSignature(chat), [chat])
  React.useEffect(() => {
    ensureRef.current()
    scheduleRefreshRef.current()
  }, [refreshSignature, snapshot?.running, snapshot?.openState, sessionId])

  const confirm = () => {
    const owner = ownerRef.current
    const version = previewVersionRef.current
    if (dialogTurn === null || files === null || error !== null || busyRef.current
      || version === null || !isCurrent(owner) || snapshotRef.current?.running === true) return
    const request = executeRequests.current.next()
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
    busyRef.current = true
    setBusy(true)
    setError(null)
    void propsRef.current.execute(turn, version).then(
      async () => {
        if (!isCurrent(owner) || !executeRequests.current.current(request)) return
        // Successful apply changes both the revoked identities and retained checkpoints.
        await refreshRef.current()
        if (!isCurrent(owner) || !executeRequests.current.current(request)) return
        busyRef.current = false
        setBusy(false)
        previewRequests.current.invalidate()
        previewVersionRef.current = null
        setDialogTurn(null)
        // The host restores the files and replaces the model-visible range in the
        // same call, so the durable marker is already in the log: refresh now and
        // the hide rule below applies it.
        ensureRef.current()
        // A new turn may already have started while state/list were refreshing.
        if (snapshotRef.current?.running === true) return
        const prompt = findUserPrompt(chatRef.current, turn) || promptBefore
        const images = findUserAttachments(chatRef.current, turn)
        const restored = images.length > 0 ? images : imagesBefore
        if (inputActions !== undefined) {
          inputActions.setDraft(prompt)
          // Drop whatever the composer still holds BEFORE the restored ids go in,
          // so the rail ends up holding exactly the rolled-back turn's attachments.
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
            const current = (): boolean => isCurrent(owner) && executeRequests.current.current(request)
              && snapshotRef.current?.running !== true
            restoreAttachments(turn, restored, current).then(result => {
              const { ids, descriptors, failures = [] } = result
              const release = (): void => {
                try {
                  if (typeof conversation?.releaseDraftAttachments === 'function') conversation.releaseDraftAttachments(descriptors)
                  else releaseAttachments?.(ids)
                } catch (error) {
                  reportAttachmentFailure({ stage: 'release', api: typeof conversation?.releaseDraftAttachments === 'function' ? 'descriptors' : 'id', reason: 'exception', errorName: attachmentErrorName(error) })
                }
              }
              if (!current()) { release(); return }
              // Report the OUTCOME, not just the failures: "the API refused" and "the
              // composer rejected the ids" both used to end in the same silence.
              console.info('[rollback] attachments:', { carried: restored.length, rebuilt: ids.length, failed: failures.length })
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
                if (!current()) { release(); return }
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
                release()
              }
              tryAdd()
            }, (e: unknown) => {
              warnOnce('restore-images', 'could not rebuild the composer attachments of the rolled-back turn', { errorName: attachmentErrorName(e) })
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
      (e: unknown) => {
        if (!isCurrent(owner) || !executeRequests.current.current(request)) return
        busyRef.current = false
        previewVersionRef.current = null
        setBusy(false)
        setError(msg(e))
        void refreshRef.current()
      },
    ).catch((e: unknown) => {
      if (!isCurrent(owner) || !executeRequests.current.current(request)) return
      busyRef.current = false
      setBusy(false)
      setError(msg(e))
      console.error('[rollback] post-apply client restore failed:', e)
    })
  }

  const hero = heroOn && heroHostRef.current !== null
    ? createPortal(React.createElement(RollbackHero, { t }), heroHostRef.current)
    : null
  const dialog = dialogTurn === null
    ? null
    : createPortal(
    React.createElement('div', {
      className: 'rbk-overlay',
      onMouseDown: (ev: React.MouseEvent) => { if (ev.target === ev.currentTarget) closeDialog() },
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
                f.conflict === true
                  ? React.createElement('span', { className: 'rbk-conflict-dot', role: 'img', 'aria-label': t('dialog.conflictWarning') })
                  : null,
                React.createElement('span', { className: 'rbk-tag rbk-tag-' + f.action }, t(('tag.' + f.action) as RollbackKey)),
                React.createElement('span', { className: 'rbk-path' }, f.path),
              ))
            : null,
          error !== null
            ? React.createElement('div', { className: 'rbk-err' }, error)
            : null,
        ),
        React.createElement('div', { className: 'rbk-foot' },
          React.createElement('button', { type: 'button', className: 'rbk-cancel', disabled: busy, onClick: closeDialog }, t('dialog.cancel')),
          React.createElement('button', { type: 'button', className: 'rbk-confirm', disabled: busy || files === null || error !== null, onClick: confirm }, busy ? t('dialog.busy') : t('dialog.confirm')),
        ),
        files?.some(file => file.conflict === true)
          ? React.createElement('div', { className: 'rbk-conflict-warning', role: 'status' }, t('dialog.conflictWarning'))
          : null,
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
  // blank conversation, so this always answers with a state object. The state is
  // solely for marker presentation/recognition; session-bound Host state owns hiding.
  // A malformed marker must not erase the chat or guess an unlimited range.
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
  const pickerRequests = new RequestGeneration()
  const optionsOf = async (session: any): Promise<unknown[]> => {
    const sessionId = sessionIdOf(session)
    const bridge = rollbackDialogBridge
    if (sessionId === undefined || bridge === null || bridge.sessionId !== sessionId) return []
    const request = pickerRequests.next()
    const readLine = (line: string): string => '/rollback --internal ' + line
    const text = (await extCommand(ctx, sessionId, readLine('list'))).text ?? ''
    if (!pickerRequests.current(request) || rollbackDialogBridge?.owner !== bridge.owner
      || sessionIdOf(session) !== sessionId) return []
    const turns = turnsOf(text) ?? []
    const newest = turns[turns.length - 1]
    const rows: unknown[] = []
    // The head is a shortcut for the newest turn, which is also listed below — the
    // duplicate is deliberate: the recent turn is the action wanted most of the time.
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
      if (sessionId === undefined) return
      const turn = pickerTurnOf(option?.id)
      if (Number.isNaN(turn)) return
      const bridge = rollbackDialogBridge
      if (bridge === null || bridge.sessionId !== sessionId || !bridge.open(turn)) {
        throw new Error('当前会话没有可用的回退确认对话框。 / No available rollback confirmation dialog for this session.')
      }
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

  // Marker rendering stays quiet; bounded Host state, not guessed marker cuts,
  // drives transcript hiding. The cosmetic hero requires a proved empty surface.
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

  ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
    name: 'conversation.input.overlay', id: 'rollback-completion', order: 10, locale: NS,
    inject: (sessionId: string) => ({
      sessionId,
      list: async () => (await extCommand(ctx, sessionId, '/rollback --internal list')).text ?? '',
    }),
  }, RollbackCommandMenu))

  ctx.slots.inject('conversation.input.dock', () => {
    log('dock entry registering')
    const dispose = ctx.slots.register({
      name: 'conversation.input.dock',
      id: 'rollback-driver',
      locale: NS,
      inject: (sessionId: string) => ({
        sessionId,
        preview: async (turn: number) => {
          const r = await extCommand(ctx, sessionId, '/rollback --internal preview ' + turn)
          return { files: parsePreview(r.text), version: previewVersionOf(r.text) }
        },
        execute: async (turn: number, version: number) => {
          await extCommand(ctx, sessionId, '/rollback --apply ' + turn + ' ' + version)
        },
        list: async () => (await extCommand(ctx, sessionId, '/rollback --internal list')).text ?? '',
        state: async () => (await extCommand(ctx, sessionId, '/rollback --internal state')).text ?? '',
        restoreAttachments: (turn: number, images: RestoreAttachment[], current: () => boolean) =>
          restoreDraftAttachments(ctx, sessionId, turn, images, current),
        // The first-party release face, read once here where the context is at hand.
        conversation: { releaseDraftAttachments: ctx.get?.('conversation')?.releaseDraftAttachments?.bind(ctx.get('conversation')) },
        releaseAttachments: (ids: readonly string[]) => {
          const conversation = ctx.get?.('conversation')
          if (typeof conversation?.releaseDraftAttachment !== 'function') {
            if (ids.length > 0) reportAttachmentFailure({ stage: 'release', api: 'id', reason: 'unavailable' })
            return
          }
          for (const [index, id] of ids.entries()) {
            try { conversation.releaseDraftAttachment(id) } catch (error) {
              reportAttachmentFailure({ index, stage: 'release', api: 'id', reason: 'exception', errorName: attachmentErrorName(error) })
            }
          }
        },
      }),
    }, RollbackDriver)
    return () => dispose()
  })
}