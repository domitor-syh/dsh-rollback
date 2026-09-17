/**
 * The provider's literal-edit semantics, reproduced exactly.
 *
 * The drive-root fallback performs an `editText` the provider refused only because
 * it pre-creates the parent directory, so it has to reach the SAME decision the
 * provider would have: the same line-ending handling, the same literal match, and
 * the same failure codes and messages. Any divergence would not merely look
 * different — it would edit a file the provider would have refused, or refuse one
 * it would have edited.
 *
 * Results are returned rather than thrown, so this module stays free of the
 * provider's error class while the caller rebuilds its exact shape.
 *
 * Pure and DSH-free.
 *
 * @module @domitor-syh/dsh-rollback/core/literal-edit
 */

/** Line-ending style detected before normalization. */
export type LineEndings = 'LF' | 'CRLF'

/** How much of the file decides the dominant line-ending style. */
const LINE_ENDING_SAMPLE_BYTES = 4096

/**
 * Collapse CRLF to LF — the canonical in-memory form every edit and diff basis
 * uses. Lone `\r` bytes (not followed by `\n`) are left untouched.
 * @param content - decoded text in whatever style the file had.
 * @returns the text with every `\r\n` pair replaced by `\n`.
 */
export function normalizeLineEndings(content: string): string {
  return content.replaceAll('\r\n', '\n')
}

/**
 * Detect the dominant line-ending style from the head of the file, so a write-back
 * can restore it.
 * @param raw - decoded text as read.
 * @returns `CRLF` when it outnumbers bare LF, else `LF`.
 */
export function detectLineEndings(raw: string): LineEndings {
  const sample = raw.slice(0, LINE_ENDING_SAMPLE_BYTES)
  const crlfCount = sample.split('\r\n').length - 1
  const lfCount = sample.split('\n').length - 1 - crlfCount
  return crlfCount > lfCount ? 'CRLF' : 'LF'
}

/**
 * Convert normalized content back to the style detected at read time.
 * @param content - the normalized (edited) text.
 * @param lineEndings - the original file's style.
 * @returns the text in the original file's line-ending style.
 */
export function restoreLineEndings(content: string, lineEndings: LineEndings): string {
  return lineEndings === 'LF' ? content : normalizeLineEndings(content).split('\n').join('\r\n')
}

/**
 * Count occurrences of a needle, scanning forward past each match (the provider's
 * counting rule, which never counts overlapping matches).
 * @param content - haystack.
 * @param needle - non-empty needle.
 * @returns the number of occurrences.
 */
export function countOccurrences(content: string, needle: string): number {
  let count = 0
  let index = 0
  while (true) {
    const found = content.indexOf(needle, index)
    if (found === -1) return count
    count += 1
    index = found + needle.length
  }
}

/** A literal edit's outcome, or the failure the provider would have raised. */
export type LiteralEditResult =
  | { readonly ok: true; readonly content: string; readonly replacements: number }
  | {
    readonly ok: false
    readonly code: 'FS_EDIT_NOT_FOUND' | 'FS_AMBIGUOUS_EDIT'
    readonly message: string
  }

/**
 * Apply one literal replacement, reproducing the provider's checks and wording.
 * @param content - current content, already line-ending normalized.
 * @param oldString - literal text to find; CRLF inside it is normalized first.
 * @param newString - literal replacement; normalized the same way.
 * @param replaceAll - replace every match instead of requiring exactly one.
 * @param displayPath - caller-facing path used in the failure messages.
 * @returns the edited content, or the failure to raise.
 */
export function applyLiteralEdit(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
  displayPath: string,
): LiteralEditResult {
  const oldNorm = normalizeLineEndings(oldString)
  if (oldNorm.length === 0) {
    return { ok: false, code: 'FS_EDIT_NOT_FOUND', message: 'old_string must be a non-empty string' }
  }
  const newNorm = normalizeLineEndings(newString)
  const replacements = countOccurrences(content, oldNorm)
  if (replacements === 0) {
    return { ok: false, code: 'FS_EDIT_NOT_FOUND', message: `old_string was not found in "${displayPath}"` }
  }
  if (!replaceAll && replacements > 1) {
    return {
      ok: false,
      code: 'FS_AMBIGUOUS_EDIT',
      message: `old_string matched ${replacements} times in "${displayPath}"; provide a more specific old_string or set replace_all to true`,
    }
  }
  return { ok: true, content: content.split(oldNorm).join(newNorm), replacements }
}