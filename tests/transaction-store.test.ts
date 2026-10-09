import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { clearTransaction, loadTransaction, saveTransaction, transactionFile, type RollbackTransaction } from '../src/transaction-store.ts'

let root: string
let previous: string | undefined
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'rollback-journal-')); previous = process.env.DSH_HOME; process.env.DSH_HOME = root })
afterEach(() => { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; rmSync(root, { recursive: true, force: true }) })
function journal(): RollbackTransaction {
  return { format: 1, id: 'transaction', sessionId: 'session', fromTurn: 1, version: 3, phase: 'restoring', marker: null, files: [{ path: 'a', before: '', after: null }] }
}
function raw(value: unknown) { const file = transactionFile('session'); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(value)) }

describe('rollback write-ahead journal', () => {
  it('roundtrips empty content and confirmed absence through atomic replacement', () => {
    expect(loadTransaction('session')).toBeNull()
    const value = journal(); saveTransaction(value)
    expect(loadTransaction('session')).toEqual(value)
    value.phase = 'aborting'; saveTransaction(value)
    expect(loadTransaction('session')?.phase).toBe('aborting')
    clearTransaction('session'); expect(loadTransaction('session')).toBeNull()
  })
  it.each(['restore', 'recover', 'delete'] as const)('roundtrips conversation-derived action %s independently of live pre-state', action => {
    const value = journal()
    value.files = [{ path: 'a', before: action === 'restore' ? null : 'external', after: action === 'delete' ? null : '', action }]
    saveTransaction(value)
    expect(loadTransaction('session')).toEqual(value)
  })
  it('roundtrips numerically inverted but positionally aligned marker endpoints', () => {
    const value = journal()
    value.marker = { data: { id: 'marker', role: 'user', source: { kind: 'plugin:rollback' }, content: [] }, range: { start: 9, end: 3 }, shadowed: [9, 7, 3], sourceEventSeqs: [3, 9, 7] }
    saveTransaction(value)
    expect(loadTransaction('session')).toEqual(value)
    raw({ ...value, marker: { ...value.marker, shadowed: [3, 7, 9] } })
    expect(() => loadTransaction('session')).toThrow('损坏')
  })
  it('does not collide for session ids sanitized to the same legacy name', () => {
    expect(transactionFile('a/b')).not.toBe(transactionFile('a:b'))
  })
  it.each([
    ['negative version', { ...journal(), version: -1 }],
    ['invalid phase', { ...journal(), phase: 'done' }],
    ['invalid action', { ...journal(), files: [{ path: 'a', before: 'a', after: 'b', action: 'erase' }] }],
    ['delete with present target', { ...journal(), files: [{ path: 'a', before: 'a', after: 'b', action: 'delete' }] }],
    ['restore with absent target', { ...journal(), files: [{ path: 'a', before: 'a', after: null, action: 'restore' }] }],
    ['duplicate path', { ...journal(), files: [journal().files[0], journal().files[0]] }],
    ['empty path', { ...journal(), files: [{ path: '', before: null, after: '' }] }],
    ['foreign session', { ...journal(), sessionId: 'other' }],
    ['unsafe marker', { ...journal(), marker: { data: { id: 'marker', role: 'assistant', source: { kind: 'plugin:rollback' }, content: [] }, range: { start: 0, end: 10 }, shadowed: [0], sourceEventSeqs: [0] } }],
  ])('rejects corruption: %s', (_name, value) => { raw(value); expect(() => loadTransaction('session')).toThrow('损坏') })
  it('does not confuse unreadable journal paths with absence', () => {
    mkdirSync(transactionFile('session'), { recursive: true })
    expect(() => loadTransaction('session')).toThrow()
  })
})
