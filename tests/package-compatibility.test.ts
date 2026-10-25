import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import * as invariant from '../src/invariant.js'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
// Use the actual pinned host's public admission function, without booting DSH or
// touching a profile. Resolve through the CLI package to respect pnpm isolation.
const host = createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json'))
const { evaluatePluginCompatibility, getDshRuntimeVersion } = await import(
  pathToFileURL(host.resolve('@deepseek-ai/dsh-app-boot')).href
)

describe('package compatibility admission and legacy companion', () => {
  it('admits the pinned adaptation target through top-level engines even if peers disagree', () => {
    expect(getDshRuntimeVersion()).toBe(manifest.devDependencies['@deepseek-ai/dsh'])
    expect(manifest.engines.dsh).toBeTypeOf('string')
    expect(manifest.dsh).not.toHaveProperty('engines')
    expect(evaluatePluginCompatibility({
      ...manifest,
      peerDependencies: { '@deepseek-ai/dsh': '=99.0.0' },
    })).toBeUndefined()
  })

  // This checks version admission only, not execution on these historical hosts.
  it.each(['0.1.5-rc.2', '0.1.5-rc.3', '0.2.0-rc.2', '0.2.1-rc.2', '0.2.1-rc.3'])(
    'retains declared admission for %s', version => {
      expect(evaluatePluginCompatibility(manifest, {}, version)).toBeUndefined()
      // Older boot code uses the retained DSH peers when engines.dsh is absent.
      const { engines: _engines, ...peerFallback } = manifest
      expect(evaluatePluginCompatibility(peerFallback, {}, version)).toBeUndefined()
    },
  )

  it.each(['0.1.5-rc.1', '0.3.0-rc.1', '1.0.0'])(
    'rejects out-of-range runtime %s through the supported engine field', version => {
      expect(evaluatePluginCompatibility(manifest, {}, version)).toMatchObject({
        requirements: { 'engines.dsh': manifest.engines.dsh },
        exempted: false,
      })
    },
  )

  it('activates and unloads the legacy entry without an invariant service', async () => {
    expect(manifest.exports['./invariant']).toBe('./lib/invariant.js')
    expect(manifest.peerDependencies).not.toHaveProperty('@deepseek-ai/dsh-invariants')
    expect(manifest.devDependencies).not.toHaveProperty('@deepseek-ai/dsh-invariants')
    const ctx = new Context()
    const apply = vi.fn(invariant.apply)
    const fiber = ctx.plugin({ ...invariant, apply })
    try {
      await fiber
      expect(apply).toHaveBeenCalledOnce()
      expect(fiber.getEffects()).toEqual([])
    } finally {
      await fiber.dispose()
    }
  })
})
