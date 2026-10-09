/** Durable files-only rescue points for successfully committed rollbacks. */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { TransactionFile } from './transaction-store.ts'

export interface RescuePoint {
  format: 1
  id: string
  sessionId: string
  fromTurn: number
  versionBefore: number
  markerId: string | null
  committedAt: string
  files: TransactionFile[]
}

const MAX_FILES = 256
const MAX_POINTS = 128
const MAX_CONTENT = 8 * 1024 * 1024
const MAX_TOTAL = 64 * 1024 * 1024

function root(): string {
  return join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'storages', 'dsh-rollback', 'rescues-v1')
}
function sessionDir(sessionId: string): string { return join(root(), createHash('sha256').update(sessionId).digest('hex')) }
function fileOf(sessionId: string, id: string): string { return join(sessionDir(sessionId), `${createHash('sha256').update(id).digest('hex')}.json`) }
function isENOENT(error: unknown): boolean { return error !== null && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT' }
function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory() } catch (error) {
    if (isENOENT(error)) return false
    throw error
  }
}
function syncDirectory(path: string): void {
  if (process.platform === 'win32') return
  const handle = openSync(path, 'r')
  try { fsyncSync(handle) } finally { closeSync(handle) }
}
function writeAtomic(path: string, text: string): void {
  const directory = dirname(path)
  const missing: string[] = []
  let ancestor = directory
  while (!isDirectory(ancestor)) { missing.push(ancestor); ancestor = dirname(ancestor) }
  for (const entry of missing.reverse()) { mkdirSync(entry); syncDirectory(dirname(entry)) }
  const temporary = `${path}.${randomUUID()}.tmp`
  let handle: number | undefined
  try {
    handle = openSync(temporary, 'wx', 0o600)
    writeFileSync(handle, text, 'utf8')
    fsyncSync(handle)
    closeSync(handle); handle = undefined
    renameSync(temporary, path)
    syncDirectory(directory)
  } finally {
    if (handle !== undefined) closeSync(handle)
    try { unlinkSync(temporary) } catch { /* renamed or never created */ }
  }
}
function utf8Size(value: string): number { return Buffer.byteLength(value, 'utf8') }
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.keys(value as Record<string, unknown>).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
}
function validatePoint(value: unknown, sessionId: string): value is RescuePoint {
  if (value === null || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  const files = r.files
  if (r.format !== 1 || r.sessionId !== sessionId || typeof r.id !== 'string' || r.id === ''
    || !Number.isSafeInteger(r.fromTurn) || (r.fromTurn as number) < 1
    || !Number.isSafeInteger(r.versionBefore) || (r.versionBefore as number) < 0
    || (r.markerId !== null && typeof r.markerId !== 'string') || typeof r.committedAt !== 'string'
    || !Array.isArray(files) || files.length > MAX_FILES) return false
  let total = 0
  const paths = new Set<string>()
  for (const item of files) {
    if (item === null || typeof item !== 'object') return false
    const f = item as Record<string, unknown>
    if (typeof f.path !== 'string' || f.path === '' || paths.has(f.path)
      || (f.before !== null && typeof f.before !== 'string')
      || (f.after !== null && typeof f.after !== 'string')) return false
    paths.add(f.path)
    for (const content of [f.before, f.after]) {
      if (typeof content === 'string') {
        const bytes = utf8Size(content)
        if (bytes > MAX_CONTENT) return false
        total += bytes
      }
    }
  }
  return total <= MAX_TOTAL
}
function pointNames(sessionId: string): string[] {
  const directory = sessionDir(sessionId)
  try { return readdirSync(directory).filter(name => name.endsWith('.json')) } catch (error) {
    if (isENOENT(error)) return []
    throw new Error(`救援点目录不可读：${directory}；${String(error)}`)
  }
}

/** Validate all deterministic rescue constraints before any rollback I/O. */
export function validateRescuePoint(point: RescuePoint): void {
  if (!validatePoint(point, point.sessionId)) throw new Error('救援点格式无效，未清理恢复日志。')
  const existing = pointNames(point.sessionId)
  const target = `${createHash('sha256').update(point.id).digest('hex')}.json`
  if (existing.length > MAX_POINTS || (existing.length === MAX_POINTS && !existing.includes(target))) {
    throw new Error(`救援点数量超过上限 ${MAX_POINTS}；未开始回退。`)
  }
  const path = fileOf(point.sessionId, point.id)
  try {
    const current = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!validatePoint(current, point.sessionId) || canonical(current) !== canonical(point)) {
      throw new Error(`救援点 ${point.id} 已存在但内容不一致，拒绝覆盖；恢复日志将保留。`)
    }
  } catch (error) {
    if (!isENOENT(error)) throw error
  }
}

/** Save once, allowing an exact semantic idempotent retry but never replacing a conflict. */
export function saveRescue(point: RescuePoint): void {
  validateRescuePoint(point)
  const path = fileOf(point.sessionId, point.id)
  try {
    const existing = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!validatePoint(existing, point.sessionId) || canonical(existing) !== canonical(point)) {
      throw new Error(`救援点 ${point.id} 已存在但内容不一致，拒绝覆盖；恢复日志将保留。`)
    }
    return
  } catch (error) {
    if (!isENOENT(error)) throw error
  }
  writeAtomic(path, JSON.stringify(point) + '\n')
}

export function loadRescues(sessionId: string): RescuePoint[] {
  const directory = sessionDir(sessionId)
  let names: string[]
  try { names = readdirSync(directory) } catch (error) {
    if (isENOENT(error)) return []
    throw error
  }
  if (names.filter(name => name.endsWith('.json')).length > MAX_POINTS) throw new Error(`救援点数量超过上限 ${MAX_POINTS}；已拒绝忽略。`)
  const points: RescuePoint[] = []
  for (const name of names.filter(name => name.endsWith('.json')).sort()) {
    const path = join(directory, name)
    let value: unknown
    try { value = JSON.parse(readFileSync(path, 'utf8')) } catch (error) { throw new Error(`救援点不可读：${path}；${String(error)}`) }
    if (!validatePoint(value, sessionId) || name !== `${createHash('sha256').update(value.id).digest('hex')}.json`) throw new Error(`救援点损坏：${path}；已拒绝忽略。`)
    points.push(value)
  }
  return points.sort((a, b) => a.committedAt.localeCompare(b.committedAt) || a.id.localeCompare(b.id))
}

export const RESCUE_LIMITS = Object.freeze({ maxFiles: MAX_FILES, maxPoints: MAX_POINTS, maxContentBytes: MAX_CONTENT, maxTotalBytes: MAX_TOTAL })

export function rescueCount(sessionId: string): number {
  return pointNames(sessionId).length
}

export function discardRescue(point: Pick<RescuePoint, 'sessionId' | 'id'>): void {
  const path = fileOf(point.sessionId, point.id)
  try { unlinkSync(path); syncDirectory(dirname(path)) } catch (error) {
    if (!isENOENT(error)) throw error
  }
}

export function rescueFile(sessionId: string, id: string): string { return fileOf(sessionId, id) }
