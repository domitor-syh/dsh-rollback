import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { planRollback } from '../src/core/restore-plan.ts'
import type { TurnCheckpoint } from '../src/core/model.ts'

const hostSource = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
const planStart = hostSource.indexOf('function planText(')
const planEnd = hostSource.indexOf('/** List the turns', planStart)
if (planStart < 0 || planEnd < 0) throw new Error('Host planText extraction boundaries changed')
const planCompiled = ts.transpileModule(hostSource.slice(planStart, planEnd), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText
const planText = new Function(`${planCompiled}; return planText` )() as (plan: unknown, header: string) => string

const clientSource = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')
const parseStart = clientSource.indexOf('function parsePreview(')
const parseEnd = clientSource.indexOf('\ntype AttachmentFailureStage', parseStart)
if (parseStart < 0 || parseEnd < 0) throw new Error('Client parsePreview extraction boundaries changed')
const parseCompiled = ts.transpileModule(clientSource.slice(parseStart, parseEnd), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText
const parsePreview = new Function(`${parseCompiled}; return parsePreview`)() as (text: string) => Array<{ path: string; action: string; conflict?: boolean }>

const checkpoint = (turn: number, path: string, kind: 'created' | 'updated' | 'removed', before: string | null, basisKnown = true): TurnCheckpoint => ({
  turn, startSeq: turn * 10, endSeq: turn * 10 + 1,
  changes: { [path]: { path, kind, before, after: kind === 'removed' ? null : 'after', basisKnown } },
})

describe('file-label attribution projections', () => {
  it('formats and parses all four file labels, including exact conflict metadata', () => {
    const plan = {
      fromTurn: 1,
      restored: [
        { path: '/updated.txt', action: 'restore', content: 'old', kind: 'updated', conflict: true },
        { path: '/removed.txt', action: 'recover', content: 'gone', kind: 'removed' },
        { path: '/created.txt', action: 'delete', content: null, kind: 'created' },
      ],
      skipped: [{ path: '/unknown.txt', reason: 'basis-unknown' }],
      truncation: { start: 10, end: 40 },
    }
    const text = planText(plan, '预览')
    expect(text).toContain('  [恢复] /updated.txt')
    expect(text).toContain('  [找回] /removed.txt')
    expect(text).toContain('  [删除] /created.txt')
    expect(text).toContain('  [跳过] /unknown.txt（basis-unknown）')
    expect(parsePreview(text)).toEqual([
      { path: '/updated.txt', action: 'restore', conflict: true },
      { path: '/removed.txt', action: 'recover' },
      { path: '/created.txt', action: 'delete' },
      { path: '/unknown.txt（basis-unknown）', action: 'skip' },
    ])
  })

  it('keeps a visible no-file-change turn free of all file labels', () => {
    const text = planText({ fromTurn: 2, restored: [], skipped: [], truncation: null }, '预览')
    expect(text).not.toMatch(/\[(恢复|找回|删除|跳过)\]/u)
    expect(parsePreview(text)).toEqual([])
  })

  it('attributes external-only changes to no later no-op turn and preserves first-touch basis', () => {
    const old = checkpoint(1, '/shared.txt', 'updated', 'original')
    const noOp: TurnCheckpoint = { turn: 2, startSeq: 20, endSeq: 21, changes: {} }
    const later = checkpoint(3, '/shared.txt', 'updated', 'external-user-edit')

    expect(planRollback([old, noOp], 2, 21)).toMatchObject({ restored: [], skipped: [] })
    expect(planRollback([old, noOp], 1, 21).restored).toEqual([
      { path: '/shared.txt', action: 'restore', content: 'original', kind: 'updated' },
    ])
    expect(planRollback([old, noOp, later], 3, 31).restored).toEqual([
      { path: '/shared.txt', action: 'restore', content: 'external-user-edit', kind: 'updated' },
    ])
  })

  it('does not let an unknown basis leak into a later no-op turn', () => {
    const unknown = checkpoint(1, '/opaque.bin', 'updated', null, false)
    const noOp: TurnCheckpoint = { turn: 2, startSeq: 20, endSeq: 21, changes: {} }
    expect(planRollback([unknown, noOp], 1, 21).skipped).toEqual([{ path: '/opaque.bin', reason: 'basis-unknown' }])
    expect(planRollback([unknown, noOp], 2, 21)).toMatchObject({ restored: [], skipped: [] })
  })
})
