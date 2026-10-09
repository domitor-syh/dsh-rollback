/** Bounds for ordinary-file rollback exports; images retain their existing API. */
export const MAX_RESTORE_FILE_BYTES = 8 * 1024 * 1024
export const MAX_RESTORE_TOTAL_FILE_BYTES = 32 * 1024 * 1024

export interface RestoreAttachment {
  kind: 'image' | 'file'
  name: string
  mediaType: string
  attachment: any
}

/** Reject invalid references before a command is built; reserve the entire batch up front. */
export function planFileRestores(attachments: readonly RestoreAttachment[], turn: number): Set<number> {
  const allowed = new Set<number>()
  let reserved = 0
  for (const [index, item] of attachments.entries()) {
    if (item.kind !== 'file') continue
    const ref = item.attachment
    if (!Number.isSafeInteger(turn) || turn < 1
      || typeof ref?.attachmentId !== 'string' || !/^[^\s"'\\]+$/.test(ref.attachmentId)
      || !Number.isSafeInteger(ref?.bytes) || ref.bytes < 0 || ref.bytes > MAX_RESTORE_FILE_BYTES
      || ref.bytes > MAX_RESTORE_TOTAL_FILE_BYTES - reserved) continue
    reserved += ref.bytes
    allowed.add(index)
  }
  return allowed
}

/** Decode a canonical base64 Host export, checking size before allocating decoded bytes. */
export function decodeRestoredFile(text: unknown, expectedBytes: number): { name: string; decoded: Uint8Array<ArrayBuffer> } {
  if (typeof text !== 'string') throw new TypeError('Missing file export')
  const payload: unknown = JSON.parse(text)
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('Invalid file export')
  const { name, bytes, data } = payload as Record<string, unknown>
  if (typeof name !== 'string' || typeof bytes !== 'number' || !Number.isSafeInteger(bytes)
    || bytes < 0 || bytes > MAX_RESTORE_FILE_BYTES || bytes !== expectedBytes
    || typeof data !== 'string' || data.length !== 4 * Math.ceil(bytes / 3)
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    throw new TypeError('Invalid file export')
  }
  const binary = atob(data)
  // atob alone accepts non-canonical padding bits; round-trip excludes those too.
  if (binary.length !== bytes || btoa(binary) !== data) throw new TypeError('Invalid file bytes')
  const decoded = new Uint8Array(bytes)
  for (let i = 0; i < bytes; i++) decoded[i] = binary.charCodeAt(i)
  return { name, decoded }
}
