/** Durable synchronous store for tool recovery gaps; records are never aged or pruned. */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export interface RecoveryGap {
  format: 1
  sessionId: string
  turn: number
  callId: string
  tool: string
  expectedPath: string
  reportedPath: string
  stage: 'dispatch' | 'result'
}

const MAX_ID_BYTES = 1024
const MAX_TOOL_BYTES = 1024
const MAX_PATH_BYTES = 16 * 1024
const MAX_ROWS = 100_000
const MAX_FILE_BYTES = 16 * 1024 * 1024
const GAP_KEYS = ['format', 'sessionId', 'turn', 'callId', 'tool', 'expectedPath', 'reportedPath', 'stage'] as const

type GapObject = Record<string, unknown>

function dshHome(): string { return process.env.DSH_HOME?.trim() || join(homedir(), '.dsh') }
function storageRoot(): string { return join(dshHome(), 'storages', 'dsh-rollback', 'recovery-gaps-v1') }
// Keep this identical to checkpoints-v2: UTF-16LE hex is injective for JS strings.
function encodedId(sessionId: string): string { return Buffer.from(sessionId, 'utf16le').toString('hex') }
function sessionFile(sessionId: string): string { return join(storageRoot(), `s-${encodedId(sessionId)}.json`) }
function isENOENT(error: unknown): boolean { return error !== null && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT' }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function bytes(value: string): number { return Buffer.byteLength(value, 'utf8') }

function invalid(message: string): Error { return new Error(`[dsh-rollback] recovery gaps: ${message}`) }

function validString(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length > 0 && bytes(value) <= limit
}

function hasOnlyGapKeys(value: GapObject): boolean {
  const keys = Object.keys(value)
  return keys.length === GAP_KEYS.length && GAP_KEYS.every(key => Object.prototype.hasOwnProperty.call(value, key))
}

function validGap(value: unknown, sessionId: string): value is RecoveryGap {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const gap = value as GapObject
  if (!hasOnlyGapKeys(gap)) return false
  return gap.format === 1
    && gap.sessionId === sessionId
    && validString(gap.sessionId, MAX_ID_BYTES)
    && typeof gap.turn === 'number' && Number.isSafeInteger(gap.turn) && gap.turn > 0
    && validString(gap.callId, MAX_ID_BYTES)
    && validString(gap.tool, MAX_TOOL_BYTES)
    && validString(gap.expectedPath, MAX_PATH_BYTES)
    && validString(gap.reportedPath, MAX_PATH_BYTES)
    && gap.expectedPath !== gap.reportedPath
    && (gap.stage === 'dispatch' || gap.stage === 'result')
}

function validateGap(gap: RecoveryGap): void {
  if (!validGap(gap, gap?.sessionId)) throw invalid('invalid recovery gap')
}

function sameGap(left: RecoveryGap, right: RecoveryGap): boolean {
  return left.format === right.format && left.sessionId === right.sessionId && left.turn === right.turn
    && left.callId === right.callId && left.tool === right.tool && left.expectedPath === right.expectedPath
    && left.reportedPath === right.reportedPath && left.stage === right.stage
}

function readGaps(sessionId: string): RecoveryGap[] {
  const file = sessionFile(sessionId)
  let size: number
  try {
    size = statSync(file).size
  } catch (error) {
    if (isENOENT(error)) return []
    throw invalid(`unreadable durable store ${file}: ${errorMessage(error)}`)
  }
  if (!Number.isSafeInteger(size) || size > MAX_FILE_BYTES) throw invalid(`recovery gap file exceeds ${MAX_FILE_BYTES} bytes: ${file}`)

  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    throw invalid(`unreadable durable store ${file}: ${errorMessage(error)}`)
  }
  if (bytes(text) > MAX_FILE_BYTES) throw invalid(`recovery gap file exceeds ${MAX_FILE_BYTES} bytes: ${file}`)

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw invalid(`corrupt recovery gap file ${file}: ${errorMessage(error)}`)
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_ROWS) throw invalid(`corrupt recovery gap file ${file}`)

  const rows: RecoveryGap[] = []
  const byOperation = new Map<string, RecoveryGap>()
  for (const value of parsed) {
    if (!validGap(value, sessionId)) throw invalid(`corrupt recovery gap row for session ${sessionId}`)
    const gap = value
    const key = `${gap.turn}\u0000${gap.callId}`
    const prior = byOperation.get(key)
    if (prior !== undefined) {
      if (!sameGap(prior, gap)) throw invalid(`conflicting duplicate recovery gap for ${sessionId}, turn ${gap.turn}, call ${gap.callId}`)
      continue
    }
    byOperation.set(key, gap)
    rows.push(gap)
  }
  return rows
}

/** Flush a complete snapshot before replacing the durable file. */
function writeAtomic(file: string, text: string): void {
  if (bytes(text) > MAX_FILE_BYTES) throw invalid(`recovery gap file exceeds ${MAX_FILE_BYTES} bytes`)
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  let handle: number | undefined
  try {
    handle = openSync(temporary, 'wx')
    writeFileSync(handle, text, 'utf8')
    fsyncSync(handle)
    closeSync(handle)
    handle = undefined
    renameSync(temporary, file)
  } finally {
    if (handle !== undefined) closeSync(handle)
    try { unlinkSync(temporary) } catch { /* renamed, or never created */ }
  }
}

export function appendRecoveryGap(gap: RecoveryGap): void {
  validateGap(gap)
  const rows = readGaps(gap.sessionId)
  const existing = rows.find(row => row.turn === gap.turn && row.callId === gap.callId)
  if (existing !== undefined) return
  rows.push(gap)
  const text = JSON.stringify(rows) + '\n'
  if (bytes(text) > MAX_FILE_BYTES || rows.length > MAX_ROWS) throw invalid('recovery gap store limit exceeded')
  writeAtomic(sessionFile(gap.sessionId), text)
}

export function loadRecoveryGaps(sessionId: string, skipTurns?: ReadonlySet<number>): readonly RecoveryGap[] {
  if (!validString(sessionId, MAX_ID_BYTES)) throw invalid('invalid recovery gap session id')
  const rows = readGaps(sessionId)
  return rows.filter(row => skipTurns?.has(row.turn) !== true)
}
