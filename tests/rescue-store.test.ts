import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadRescues, rescueFile, saveRescue } from '../src/rescue-store.ts'
import type { RescuePoint } from '../src/rescue-store.ts'

let home: string
let previous: string | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'rollback-rescue-'))
  previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
})
afterEach(() => {
  if (previous === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previous
  rmSync(home, { recursive: true, force: true })
})

function point(id = 'rollback-truncation-100-abc'): RescuePoint {
  return {
    format: 1,
    id,
    sessionId: 'session-一',
    fromTurn: 3,
    versionBefore: 9,
    markerId: null,
    committedAt: '1970-01-01T00:01:40.000Z',
    files: [
      { path: 'empty.txt', before: '', after: null },
      { path: 'unicode.txt', before: '之前\n🙂', after: '之后' },
    ],
  }
}

describe('files-only rescue store', () => {
  it('round-trips null, empty and unicode contents and is semantically idempotent', () => {
    const original = point()
    saveRescue(original)
    const reordered = JSON.parse(JSON.stringify({
      files: original.files, committedAt: original.committedAt, markerId: original.markerId,
      versionBefore: original.versionBefore, fromTurn: original.fromTurn, sessionId: original.sessionId,
      id: original.id, format: original.format,
    })) as RescuePoint
    saveRescue(reordered)
    expect(loadRescues(original.sessionId)).toEqual([original])
    const files = readdirSync(join(home, 'storages', 'dsh-rollback', 'rescues-v1'), { withFileTypes: true })
    expect(files).toHaveLength(1)

  })

  it('rejects a conflicting duplicate without replacing the durable point', () => {
    const original = point()
    saveRescue(original)
    expect(() => saveRescue({ ...original, files: [{ path: 'different', before: 'x', after: 'y' }] })).toThrow('内容不一致')
    expect(JSON.parse(readFileSync(rescueFile(original.sessionId, original.id), 'utf8'))).toEqual(original)
  })

  it('rejects byte-over-limit content before writing', () => {
    const oversized: RescuePoint = { ...point('rollback-truncation-101-abc'), files: [{ path: 'large', before: '🙂'.repeat(3 * 1024 * 1024), after: null }] }
    expect(() => saveRescue(oversized)).toThrow('格式无效')
    expect(existsSync(rescueFile(oversized.sessionId, oversized.id))).toBe(false)
  })

  it('fails closed on a malformed rescue file', () => {
    const original = point()
    saveRescue(original)
    writeFileSync(rescueFile(original.sessionId, 'rollback-truncation-999-corrupt'), '{broken', 'utf8')
    expect(() => loadRescues(original.sessionId)).toThrow('不可读')
  })
})
