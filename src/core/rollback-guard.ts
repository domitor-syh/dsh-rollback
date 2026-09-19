/**
 * The one rule about WHEN a rollback may run.
 *
 * No rollback while a turn is open, whatever the target turn. The agent loop holds a
 * position in the model-visible surface and keeps appending to it, so truncating
 * underneath a running turn would shadow history that turn is still writing while its
 * later output stays; restoring files underneath it would fight whatever it is doing.
 * A command does not interrupt the run either, so this refusal — not the command's
 * own timing — is what keeps a run and a rollback from interleaving.
 *
 * Pure and DSH-free, so the wording and the rule can be pinned by a test.
 *
 * @module @domitor-syh/dsh-rollback/core/rollback-guard
 */

/**
 * Why this rollback must not run, or null when it may.
 * @param inProgressTurn - the currently open turn, or null between turns.
 * @returns the user-facing refusal, or null.
 */
export function rollbackRefusal(inProgressTurn: number | null): string | null {
  if (inProgressTurn === null) return null
  return `第 ${inProgressTurn} 轮还在进行中，不能回退：请先暂停（或等这一轮输出结束）再回退。`
}

/**
 * Why this TARGET is out of reach, or null when it can be honored.
 *
 * Retained checkpoints are a sliding window, so a target older than the oldest one
 * cannot be reconstructed: the records that would describe that state were dropped
 * long ago. Planning anyway does not fail — it silently restores from the OLDEST
 * retained records instead, which is a different state than the one the user asked
 * for, and says nothing about it. Refusing is the only honest answer.
 *
 * A target INSIDE the window is fine even when that particular turn kept no
 * checkpoint (a turn with no output and no file changes is not retained): the
 * records from the turns after it are exactly the ones that describe it.
 * @param fromTurn - the turn the rollback targets.
 * @param availableTurns - turns with retained checkpoints.
 * @returns the user-facing refusal, or null.
 */
export function windowRefusal(fromTurn: number, availableTurns: readonly number[]): string | null {
  if (availableTurns.length === 0) return '当前会话没有可回退的轮次。'
  const oldest = Math.min(...availableTurns)
  const newest = Math.max(...availableTurns)
  if (fromTurn >= oldest) return null
  return `超出可回退范围：只能回退到最近保留的检查点（第 ${oldest}–${newest} 轮，共 ${availableTurns.length} 轮），更早的已丢弃。`
}

/**
 * The oldest rollback-able turn named by the host's `/rollback list` text.
 *
 * The action entries read the range from that command's human-readable output, so the
 * parse lives here where a test can pin it. Only the comma-separated run of numbers
 * DIRECTLY after the marker counts: the same line carries a window hint with a number
 * of its own ("仅最近 10 轮"), and folding that one into the range would disable turns
 * that are perfectly rollback-able.
 *
 * A marker with no numbers means the host can roll back nothing (`Infinity`, so every
 * entry greys out). Text this function does not recognize yields null — "unknown",
 * which blocks nothing: the host refuses out-of-range targets itself, so the cost of
 * not knowing is a refused click rather than a disabled button.
 * @param text - the command's output, as the client received it.
 * @returns the oldest available turn, or null when the text says nothing usable.
 */
export function oldestTurnOf(text: string | null | undefined): number | null {
  if (text === null || text === undefined || text === '') return null
  const marker = text.includes('：') ? '：' : text.includes(':') ? ':' : null
  if (marker === null) return null
  const list = /^\s*((?:\d+\s*,\s*)*\d+)/.exec(text.slice(text.indexOf(marker) + 1))
  if (list === null) return Number.POSITIVE_INFINITY
  const turns = list[1]!
    .split(',')
    .map(part => Number(part.trim()))
    .filter(turn => Number.isSafeInteger(turn) && turn >= 1)
  return turns.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...turns)
}