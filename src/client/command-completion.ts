export const ROLLBACK_SUBCOMMANDS = ['latest', 'list', 'preview', 'state', 'rescues', 'diagnose', 'retry', 'abort'] as const
export type RollbackSubcommand = typeof ROLLBACK_SUBCOMMANDS[number]
export interface ClaimedInput {
  draft: string
  draftRev: number
  phase: string
  claim?: { name: string; token: string }
  occurrences?: readonly unknown[]
}
/** Only the claimed bare command may open the menu. Never replace existing arguments. */
export function isBareClaimedRollback(input: ClaimedInput): boolean {
  return input.phase === 'claimed' && input.claim?.name === 'rollback'
    && input.claim.token.trim() === '/rollback' && /^\/rollback\s+[a-z]*$/i.test(input.draft)
    && (input.occurrences?.length ?? 0) === 0
}
/** Append at the document end without replacing the existing command token/claim. */
export function rollbackCompletion(input: ClaimedInput, command: RollbackSubcommand, turn?: number) {
  if (!isBareClaimedRollback(input) || !ROLLBACK_SUBCOMMANDS.includes(command)) return null
  if (command === 'preview' && (!Number.isSafeInteger(turn) || turn! < 1)) return null
  if (command !== 'preview' && turn !== undefined) return null
  const argumentStart = '/rollback '.length
  const start = input.draft.startsWith('/rollback ') ? argumentStart : input.draft.length
  return {
    text: command === 'preview' ? `preview ${turn}` : command,
    span: { start, end: input.draft.length, draftRev: input.draftRev },
  }
}
