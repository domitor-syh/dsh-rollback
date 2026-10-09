import { Buffer } from 'node:buffer'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'

/** Canonical file reference carried by the pinned Host message contract. */
type FileAttachmentRef = Extract<UserMessage['content'][number], { type: 'file' }>['attachment']

export interface ExportedTurnFile {
  readonly name: string
  readonly bytes: number
  /** Exact stored bytes, encoded as base64 (not an image URL or filesystem path). */
  readonly data: string
}

/** Export policy, independent of the attachment provider's upload policy. */
export const MAX_TURN_FILE_EXPORT_BYTES = 8 * 1024 * 1024

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateRef(value: unknown): asserts value is FileAttachmentRef {
  if (!record(value)
    || typeof value.attachmentId !== 'string' || value.attachmentId.trim().length === 0
    || typeof value.name !== 'string'
    || typeof value.bytes !== 'number' || !Number.isSafeInteger(value.bytes) || value.bytes < 0) {
    throw new Error('Invalid authoritative file attachment reference')
  }
  if (value.bytes > MAX_TURN_FILE_EXPORT_BYTES) throw new Error('File attachment exceeds the 8 MiB export limit')
}

/**
 * Export only a file in the first user message of the requested authoritative
 * turn envelope. Caller input is an identity, never a reference or host path.
 * Provider integrity failures and cancellation propagate unchanged.
 */
export async function exportTurnFile(
  ctx: Pick<Context, 'attachments'>,
  session: Pick<Session, 'snapshotEvents'>,
  turn: number,
  attachmentId: string,
  signal?: AbortSignal,
): Promise<ExportedTurnFile> {
  if (!Number.isSafeInteger(turn) || turn <= 0) throw new Error('Turn must be a positive safe integer')
  if (typeof attachmentId !== 'string' || attachmentId.trim().length === 0) throw new Error('Attachment id must be nonempty')
  signal?.throwIfAborted()

  // Copy before sorting: snapshot ownership remains with the session.
  const events = [...session.snapshotEvents()].sort((a, b) => a.seq - b.seq)
  const start = events.findIndex(event => event.type === 'turn/start' && event.data.turn === turn)
  if (start < 0) throw new Error('Unknown turn')
  let candidate: unknown
  for (let index = start + 1; index < events.length; index++) {
    const event = events[index]!
    if (event.type === 'turn/end' || event.type === 'turn/start') break
    if (event.type !== 'user/message') continue
    const content: unknown = event.data.content
    if (Array.isArray(content)) {
      candidate = content.find((block: unknown) => record(block)
        && block.type === 'file' && record(block.attachment)
        && block.attachment.attachmentId === attachmentId)?.attachment
    }
    // A later user message is not this turn's initiating prompt.
    break
  }
  if (candidate === undefined) throw new Error('File attachment not found in this turn')
  validateRef(candidate)
  // Keep only authoritative reference fields; never forward incidental path data.
  const ref: FileAttachmentRef = {
    attachmentId: candidate.attachmentId, name: candidate.name, bytes: candidate.bytes,
  }
  signal?.throwIfAborted()
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of ctx.attachments.readFileStream(ref, signal)) {
    signal?.throwIfAborted()
    if (!(chunk instanceof Uint8Array)) throw new Error('Invalid file attachment stream chunk')
    // Enforce both bounds before copying or retaining any chunk.
    if (chunk.byteLength > MAX_TURN_FILE_EXPORT_BYTES - bytes) throw new Error('File attachment stream exceeds the 8 MiB export limit')
    if (chunk.byteLength > ref.bytes - bytes) throw new Error('File attachment byte count mismatch')
    bytes += chunk.byteLength
    if (chunk.byteLength > 0) chunks.push(Buffer.from(chunk))
  }
  signal?.throwIfAborted()
  if (bytes !== ref.bytes) throw new Error('File attachment byte count mismatch')
  const data = Buffer.concat(chunks, bytes).toString('base64')
  signal?.throwIfAborted()
  return { name: ref.name, bytes, data }
}
