/** Durable write-ahead journal for incomplete rollback and compensation.
 * The journal is independent of withdrawn-turn checkpoint retention.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { TruncationMarkerPlan } from './core/truncation-plan.ts'

export interface TransactionFile {
  path: string
  /** The actual state captured before any restore I/O. null = confirmed absent. */
  before: string | null
  /** The intended rollback state. null = absent. */
  after: string | null
  /** Conversation-derived preview action; absent in legacy journals. */
  action?: 'restore' | 'recover' | 'delete'
}
export interface RollbackTransaction {
  format: 1
  id: string
  sessionId: string
  fromTurn: number
  /** Log identity, excluding command receipts, before file restoration. */
  version: number
  phase: 'restoring' | 'marker' | 'committed' | 'aborting'
  marker: TruncationMarkerPlan | null
  files: TransactionFile[]
}

export function transactionFile(sessionId: string): string {
  const root = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(root, 'storages', 'dsh-rollback', 'transactions-v1', `${createHash('sha256').update(sessionId).digest('hex')}.json`)
}

export function loadTransaction(sessionId: string): RollbackTransaction | null {
  const path = transactionFile(sessionId)
  let text: string
  try { text = readFileSync(path, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const value = JSON.parse(text) as RollbackTransaction
  const seq = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
  const marker = value?.marker
  const validMarker = marker === null || (marker !== undefined && marker.data?.role === 'user'
    && typeof marker.data.id === 'string' && marker.data.id !== ''
    && marker.data.source?.kind === 'plugin:rollback' && Array.isArray(marker.data.content)
    && Array.isArray(marker.sourceEventSeqs) && marker.sourceEventSeqs.every(seq)
    && Array.isArray(marker.shadowed) && marker.shadowed.every(seq)
    // Surface endpoints are positional, not numerically ordered after replacement.
    && (marker.range === null || (seq(marker.range?.start) && marker.range.start > 0 && seq(marker.range?.end)
      && marker.shadowed.length > 0 && marker.shadowed[0] === marker.range.start && marker.shadowed.at(-1) === marker.range.end)))
  if (value?.format !== 1 || value.sessionId !== sessionId || typeof value.id !== 'string' || value.id === ''
    || !Number.isSafeInteger(value.fromTurn) || value.fromTurn < 1 || !seq(value.version)
    || !['restoring', 'marker', 'committed', 'aborting'].includes(value.phase)
    || !Array.isArray(value.files) || value.files.some(file => typeof file?.path !== 'string' || file.path === ''
      || (file.before !== null && typeof file.before !== 'string') || (file.after !== null && typeof file.after !== 'string')
      || (file.action !== undefined && (!['restore', 'recover', 'delete'].includes(file.action)
        || (file.action === 'delete') !== (file.after === null))))
    || (Array.isArray(value.files) && new Set(value.files.map(file => file.path)).size !== value.files.length)
    || !validMarker) {
    throw new Error('恢复日志损坏，已阻止回退及模型执行；请保留日志并人工核查。')
  }
  return value
}

/** POSIX directory-entry barrier. Windows cannot open directories for fsync via Node;
 * on Windows this journal guarantees process-crash recovery, not sudden power loss.
 * Other platforms fail loudly if their filesystem cannot supply the barrier.
 */
function syncDirectory(path: string): void {
  if (process.platform === 'win32') return
  const handle = openSync(path, 'r')
  try { fsyncSync(handle) } finally { closeSync(handle) }
}

/** Atomic replacement; failure is loud and leaves the previous journal usable. */
export function saveTransaction(transaction: RollbackTransaction): void {
  const path = transactionFile(transaction.sessionId)
  const directory = dirname(path)
  const missing: string[] = []
  let ancestor = directory
  while (!existsSync(ancestor)) { missing.push(ancestor); ancestor = dirname(ancestor) }
  for (const entry of missing.reverse()) { mkdirSync(entry); syncDirectory(dirname(entry)) }
  const temporary = `${path}.${randomUUID()}.tmp`
  let handle: number | undefined
  try {
    handle = openSync(temporary, 'wx', 0o600)
    writeFileSync(handle, JSON.stringify(transaction), 'utf8')
    fsyncSync(handle)
    closeSync(handle)
    handle = undefined
    renameSync(temporary, path)
    syncDirectory(directory)
  } finally {
    if (handle !== undefined) closeSync(handle)
    // Exactly the temporary sibling constructed above; never touch the journal.
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}

/** Remove only after the marker's durability barrier (or full compensation). */
export function clearTransaction(sessionId: string): void {
  const path = transactionFile(sessionId)
  try { unlinkSync(path); syncDirectory(dirname(path)) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}
