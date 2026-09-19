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