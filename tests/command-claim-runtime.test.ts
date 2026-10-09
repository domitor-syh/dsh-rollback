import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
const require = createRequire(import.meta.url)
const source = readFileSync(join(dirname(require.resolve('@deepseek-ai/dsh-client-ui-conversation/package.json')), 'lib/client.js'), 'utf8')
const retainStart = source.indexOf('function retainsClaim(draft, token)')
const retainEnd = source.indexOf('/** Pure phase, claim, and attempt owner', retainStart)
const methodStart = source.indexOf('onDraftChanged(draft) {')
const methodEnd = source.indexOf('/** The editor applied a claim-token replacement', methodStart)

describe('actual rc.2 claimed command runtime', () => {
  it('keeps the blue claim after end-only subcommand insertion', () => {
    expect(retainStart).toBeGreaterThan(-1); expect(retainEnd).toBeGreaterThan(retainStart)
    expect(methodStart).toBeGreaterThan(-1); expect(methodEnd).toBeGreaterThan(methodStart)
    const method = source.slice(methodStart, methodEnd).trim().replace(/^onDraftChanged\(draft\)/, 'function(draft)')
    const run = new Function(`${source.slice(retainStart, retainEnd)}; return (${method});`)() as (this: any, draft: string) => void
    for (const draft of ['/rollback latest', '/rollback preview 8', '/rollback diagnose', '/rollback retry']) {
      const claim = { name: 'rollback', token: '/rollback ' }
      const machine = { phase: 'claimed', claim }
      run.call(machine, draft)
      expect(machine.phase).toBe('claimed'); expect(machine.claim).toBe(claim)
    }
    const changed: any = { phase: 'claimed', claim: { name: 'rollback', token: '/rollback ' } }
    run.call(changed, '/rollbacklatest')
    expect(changed.phase).toBe('plain')
  })
})
