import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendRecoveryGap, loadRecoveryGaps } from '../src/recovery-gap-store.ts'
import type { RecoveryGap } from '../src/recovery-gap-store.ts'

let home: string
let previousHome: string | undefined

beforeEach(() => {
  previousHome = process.env.DSH_HOME
  home = mkdtempSync(join(tmpdir(), 'rbk-recovery-gaps-'))
  process.env.DSH_HOME = home
})

afterEach(() => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  rmSync(home, { recursive: true, force: true })
})

function gap(overrides: Partial<RecoveryGap> = {}): RecoveryGap {
  return {
    format: 1,
    sessionId: 'session-一',
    turn: 1,
    callId: 'call-1',
    tool: 'workspace.write',
    expectedPath: 'expected.txt',
    reportedPath: 'reported.txt',
    stage: 'dispatch',
    ...overrides,
  }
}

function fileOf(sessionId: string): string {
  return join(home, 'storages', 'dsh-rollback', 'recovery-gaps-v1', `s-${Buffer.from(sessionId, 'utf16le').toString('hex')}.json`)
}

function writeStore(sessionId: string, value: unknown): void {
  mkdirSync(join(home, 'storages', 'dsh-rollback', 'recovery-gaps-v1'), { recursive: true })
  writeFileSync(fileOf(sessionId), typeof value === 'string' ? value : JSON.stringify(value))
}

describe('recovery gap store', () => {
  it('loads absent storage, appends a gap, and reloads the durable snapshot', () => {
    expect(loadRecoveryGaps('session-一')).toEqual([])
    const original = gap()
    appendRecoveryGap(original)
    expect(loadRecoveryGaps(original.sessionId)).toEqual([original])
    expect(JSON.parse(readFileSync(fileOf(original.sessionId), 'utf8'))).toEqual([original])
  })

  it('deduplicates one operation and preserves the first mismatch metadata', () => {
    const original = gap()
    appendRecoveryGap(original)
    appendRecoveryGap({ ...original, tool: 'different-tool', expectedPath: 'first.txt', reportedPath: 'second.txt', stage: 'result' })
    expect(loadRecoveryGaps(original.sessionId)).toEqual([original])
  })

  it('keeps the same call distinct across turns and stages', () => {
    const first = gap({ callId: 'same-call', turn: 1 })
    const second = gap({ callId: 'same-call', turn: 2, stage: 'result' })
    appendRecoveryGap(first)
    appendRecoveryGap(second)
    expect(loadRecoveryGaps(first.sessionId)).toEqual([first, second])
  })

  it('uses injective UTF-16LE filenames for colliding-looking session ids', () => {
    const ids = ['a/b', 'a_b', 'A', 'a', 's-YS9i', '大小', '\ud800', '\ud801']
    for (const sessionId of ids) appendRecoveryGap(gap({ sessionId, expectedPath: 'e', reportedPath: 'r' }))
    const files = readdirSync(join(home, 'storages', 'dsh-rollback', 'recovery-gaps-v1'))
    expect(new Set(files.map(file => file.toLowerCase())).size).toBe(ids.length)
    for (const sessionId of ids) expect(loadRecoveryGaps(sessionId)[0]?.sessionId).toBe(sessionId)
  })

  it('filters skipped turns without changing the durable snapshot', () => {
    appendRecoveryGap(gap({ turn: 1 }))
    appendRecoveryGap(gap({ turn: 2, callId: 'call-2' }))
    const before = readFileSync(fileOf('session-一'), 'utf8')
    expect(loadRecoveryGaps('session-一', new Set([1]))).toEqual([gap({ turn: 2, callId: 'call-2' })])
    expect(readFileSync(fileOf('session-一'), 'utf8')).toBe(before)
    expect(loadRecoveryGaps('session-一')).toHaveLength(2)
  })

  it('stores only gap metadata and rejects source-content fields', () => {
    appendRecoveryGap(gap())
    const stored = JSON.parse(readFileSync(fileOf('session-一'), 'utf8')) as Record<string, unknown>[]
    expect(stored[0]).toEqual(gap())
    expect(stored[0]).not.toHaveProperty('content')
    expect(() => appendRecoveryGap({ ...gap(), content: 'source text' } as RecoveryGap & { content: string })).toThrow()
  })

  it.each([
    ['wrong format', { format: 2 }],
    ['zero turn', { turn: 0 }],
    ['unsafe turn', { turn: Number.MAX_SAFE_INTEGER + 1 }],
    ['empty call', { callId: '' }],
    ['equal paths', { expectedPath: 'same', reportedPath: 'same' }],
    ['wrong stage', { stage: 'unknown' }],
  ])('rejects %s before writing', (_label, changes) => {
    expect(() => appendRecoveryGap({ ...gap(), ...changes } as RecoveryGap)).toThrow()
    expect(loadRecoveryGaps('session-一')).toEqual([])
  })

  it('rejects corrupt format, foreign, duplicate-conflict, and extra-content rows', () => {
    const rows = [
      { ...gap(), format: 2 },
      { ...gap(), sessionId: 'foreign' },
      { ...gap(), content: 'source text' },
    ]
    writeStore('session-一', rows)
    expect(() => loadRecoveryGaps('session-一')).toThrow()

    writeStore('session-一', [gap(), { ...gap(), tool: 'conflict' }])
    expect(() => loadRecoveryGaps('session-一')).toThrow(/conflicting duplicate/)
  })

  it('rejects malformed JSON, oversized rows, oversized files, and too many rows', () => {
    writeStore('session-一', '{broken')
    expect(() => loadRecoveryGaps('session-一')).toThrow()

    writeStore('session-一', [{ ...gap(), expectedPath: 'x'.repeat(16 * 1024 + 1) }])
    expect(() => loadRecoveryGaps('session-一')).toThrow()

    writeFileSync(fileOf('session-一'), 'x'.repeat(16 * 1024 * 1024 + 1))
    expect(() => loadRecoveryGaps('session-一')).toThrow()

    mkdirSync(fileOf('other'), { recursive: true })
    expect(() => loadRecoveryGaps('other')).toThrow()
  })

  it('rejects invalid session ids and validates them on load', () => {
    expect(() => loadRecoveryGaps('')).toThrow()
    expect(() => appendRecoveryGap(gap({ sessionId: 'x'.repeat(1025) }))).toThrow()
    writeStore('session-一', [{ ...gap(), sessionId: 'other' }])
    expect(() => loadRecoveryGaps('session-一')).toThrow()
  })
})
