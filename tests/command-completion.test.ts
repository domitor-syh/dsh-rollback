import { describe, it, expect } from 'vitest'
import { isBareClaimedRollback, rollbackCompletion, ROLLBACK_SUBCOMMANDS } from '../src/client/command-completion.ts'
const input = { draft: '/rollback ', draftRev: 12, phase: 'claimed', claim: { name: 'rollback', token: '/rollback ' }, occurrences: [] }
describe('claim-preserving rollback completions', () => {
  it('opens only for a claimed, empty rollback argument', () => {
    expect(isBareClaimedRollback(input)).toBe(true)
    for (const change of [{ phase: 'plain' }, { phase: 'submitting' }, { draft: '/rollback latest' }, { draft: '/rollback' }, { claim: { name: 'other', token: '/other ' } }, { occurrences: [{}] }]) {
      const changed = { ...input, ...change }
      expect(isBareClaimedRollback(changed)).toBe(change.draft === '/rollback latest')
    }
  })
  it('appends every supported subcommand without replacing the blue token', () => {
    for (const command of ROLLBACK_SUBCOMMANDS.filter(c => c !== 'preview')) {
      const completion = rollbackCompletion(input, command)!
      expect(completion.span).toEqual({ start: 10, end: 10, draftRev: 12 })
      const completed = input.draft + completion.text
      expect(completed.startsWith(input.claim.token)).toBe(true)
      expect(completed).toBe(`/rollback ${command}`)
    }
  })
  it('requires a valid turn for preview and appends its actual command', () => {
    expect(rollbackCompletion(input, 'preview', 8)?.text).toBe('preview 8')
    for (const turn of [undefined, 0, -1, 1.5, NaN, Infinity]) expect(rollbackCompletion(input, 'preview', turn)).toBeNull()
    expect(rollbackCompletion(input, 'latest', 8)).toBeNull()
  })
  it('replaces a typed partial argument without touching the command token', () => {
    const partial = { ...input, draft: '/rollback l' }
    expect(isBareClaimedRollback(partial)).toBe(true)
    const completion = rollbackCompletion(partial, 'latest')!
    expect(completion.span).toEqual({ start: 10, end: 11, draftRev: 12 })
    expect(partial.draft.slice(0, completion.span.start) + completion.text).toBe('/rollback latest')
  })
})
