import { Buffer } from 'node:buffer'
import { Context } from '@deepseek-ai/cordis'
import { inject } from '../src/index.ts'
import { describe, expect, it, vi } from 'vitest'
import { exportTurnFile, MAX_TURN_FILE_EXPORT_BYTES } from '../src/file-attachment-export.ts'

type Event = { seq: number; type: string; data: any }
const event = (seq: number, type: string, data: any = {}): Event => ({ seq, type, data })
const ref = (bytes = 3) => ({ attachmentId: 'file-id', name: 'binary.dat', bytes })
const message = (...blocks: unknown[]) => ({ content: blocks })
const file = (attachment: unknown = ref()) => ({ type: 'file', attachment })
const envelope = (attachment: unknown = ref()) => [
  event(10, 'turn/start', { turn: 2 }), event(11, 'user/message', message(file(attachment))),
  event(12, 'turn/end', { turn: 2 }),
]
async function* stream(...chunks: Uint8Array[]) { yield* chunks }
function fixture(events = envelope(), source: AsyncIterable<Uint8Array> = stream(Uint8Array.of(0, 128, 255))) {
  const readFileStream = vi.fn((_ref: unknown, _signal?: AbortSignal) => source)
  const snapshotEvents = vi.fn(() => events)
  const ctx = { attachments: { readFileStream } } as unknown as Parameters<typeof exportTurnFile>[0]
  const session = { snapshotEvents } as unknown as Parameters<typeof exportTurnFile>[1]
  return { ctx, session, readFileStream, snapshotEvents }
}
const run = (f: ReturnType<typeof fixture>, turn = 2, id = 'file-id', signal?: AbortSignal) =>
  exportTurnFile(f.ctx, f.session, turn, id, signal)

describe('authoritative turn file export', () => {
  it('exports through a real Cordis scope using the Host dependency declaration', async () => {
    const root = new Context()
    const f = fixture()
    for (const key of inject) root.provide(key, key === 'attachments' ? f.ctx.attachments : {})
    let result: Promise<Awaited<ReturnType<typeof exportTurnFile>>> | undefined
    const scope = root.plugin({
      name: 'rollback-attachment-contract', inject,
      apply(ctx: Context) { result = exportTurnFile(ctx, f.session, 2, 'file-id') },
    })
    try {
      await vi.waitFor(() => expect(result).toBeDefined())
      expect(await result).toEqual({ name: 'binary.dat', bytes: 3, data: 'AID/' })
      expect(f.readFileStream).toHaveBeenCalledOnce()
    } finally { await scope.dispose() }
  })
  it('exports exact binary bytes in sequence order without mutating the snapshot', async () => {
    const events = envelope({ ...ref(), path: 'forged/path', data: 'forged' }).reverse()
    const original = [...events]
    const f = fixture(events, stream(Uint8Array.of(0), Uint8Array.of(128, 255)))
    const signal = new AbortController().signal
    expect(await run(f, 2, 'file-id', signal)).toEqual({ name: 'binary.dat', bytes: 3, data: 'AID/' })
    expect(f.readFileStream).toHaveBeenCalledOnce()
    expect(f.readFileStream).toHaveBeenCalledWith(ref(), signal)
    expect(events).toEqual(original)
  })

  it('exports zero-byte files and ignores empty chunks', async () => {
    const f = fixture(envelope(ref(0)), stream(new Uint8Array()))
    expect(await run(f)).toEqual({ name: 'binary.dat', bytes: 0, data: '' })
  })

  it('copies chunks before a provider reuses their storage', async () => {
    const bytes = Uint8Array.of(0)
    const f = fixture(envelope(ref(2)), (async function* () {
      yield bytes; bytes[0] = 255; yield bytes
    })())
    expect((await run(f)).data).toBe('AP8=')
  })

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid turn %s before reading the session', async turn => {
    const f = fixture()
    await expect(run(f, turn)).rejects.toThrow(/positive safe integer/)
    expect(f.snapshotEvents).not.toHaveBeenCalled()
    expect(f.readFileStream).not.toHaveBeenCalled()
  })

  it.each(['', '  ', null, {}, { attachmentId: 'file-id', path: '/secret' }])('rejects non-identity input %s', async id => {
    const f = fixture()
    await expect(run(f, 2, id as string)).rejects.toThrow(/nonempty/)
    expect(f.readFileStream).not.toHaveBeenCalled()
  })

  it.each([1, 3])('rejects a forged or cross-turn identity for turn %s', async turn => {
    const f = fixture([event(0, 'turn/start', { turn: 1 }), event(1, 'user/message', message()), event(2, 'turn/end'), ...envelope()])
    await expect(run(f, turn)).rejects.toThrow(/Unknown turn|not found/)
    expect(f.readFileStream).not.toHaveBeenCalled()
  })

  it('rejects an unknown attachment and image-only matches', async () => {
    for (const f of [fixture(), fixture([event(10, 'turn/start', { turn: 2 }), event(11, 'user/message', message({ type: 'image', attachment: ref() }))])]) {
      await expect(run(f, 2, 'image-or-unknown')).rejects.toThrow(/not found/)
      expect(f.readFileStream).not.toHaveBeenCalled()
    }
    const image = fixture([event(10, 'turn/start', { turn: 2 }), event(11, 'user/message', message({ type: 'image', attachment: ref() }))])
    await expect(run(image)).rejects.toThrow(/not found/)
    expect(image.readFileStream).not.toHaveBeenCalled()
  })

  it('never searches later user messages or outside a turn envelope', async () => {
    const tails = [
      [event(11, 'user/message', message()), event(12, 'user/message', message(file()))],
      [event(11, 'turn/end'), event(12, 'user/message', message(file()))],
      [event(11, 'turn/start', { turn: 3 }), event(12, 'user/message', message(file()))],
    ]
    for (const tail of tails) {
      const f = fixture([event(9, 'user/message', message(file())), event(10, 'turn/start', { turn: 2 }), ...tail])
      await expect(run(f)).rejects.toThrow(/not found/)
      expect(f.readFileStream).not.toHaveBeenCalled()
    }
  })

  it.each([
    { ...ref(), name: null }, { attachmentId: 'file-id', bytes: 3 },
    ...[-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '3'].map(bytes => ({ ...ref(), bytes })),
  ])('rejects malformed authoritative metadata %j', async attachment => {
    const f = fixture(envelope(attachment))
    await expect(run(f)).rejects.toThrow(/Invalid authoritative/)
    expect(f.readFileStream).not.toHaveBeenCalled()
  })

  it('rejects oversized metadata without starting a stream', async () => {
    const f = fixture(envelope(ref(MAX_TURN_FILE_EXPORT_BYTES + 1)))
    await expect(run(f)).rejects.toThrow(/8 MiB/)
    expect(f.readFileStream).not.toHaveBeenCalled()
  })

  it('accepts exactly the cap', async () => {
    const f = fixture(envelope(ref(MAX_TURN_FILE_EXPORT_BYTES)), stream(new Uint8Array(MAX_TURN_FILE_EXPORT_BYTES)))
    const result = await run(f)
    expect(result.bytes).toBe(MAX_TURN_FILE_EXPORT_BYTES)
    expect(Buffer.from(result.data, 'base64').byteLength).toBe(MAX_TURN_FILE_EXPORT_BYTES)
  })

  it.each([{ chunks: [] }, { chunks: [Uint8Array.of(1, 2)] }, { chunks: [Uint8Array.of(1, 2, 3, 4)] }])('rejects stream length mismatch %j', async ({ chunks }) => {
    const f = fixture(envelope(), stream(...chunks))
    await expect(run(f)).rejects.toThrow(/byte count mismatch/)
  })

  it('stops and closes the iterator on cap overflow before collecting it', async () => {
    const closed = vi.fn(), continued = vi.fn()
    const f = fixture(envelope(ref(MAX_TURN_FILE_EXPORT_BYTES)), (async function* () {
      try { yield new Uint8Array(MAX_TURN_FILE_EXPORT_BYTES + 1); continued() } finally { closed() }
    })())
    await expect(run(f)).rejects.toThrow(/8 MiB/)
    expect(continued).not.toHaveBeenCalled()
    expect(closed).toHaveBeenCalledOnce()
  })

  it.each(['invalid', null, [1, 2, 3], { byteLength: 3 }])('rejects non-byte stream chunks %j', async chunk => {
    const f = fixture(envelope(), (async function* () { yield chunk })() as AsyncIterable<Uint8Array>)
    await expect(run(f)).rejects.toThrow(/Invalid.*chunk/)
  })

  it('propagates provider corruption and synchronous stream errors unchanged', async () => {
    const error = new Error('checksum corruption')
    const f = fixture(envelope(), (async function* () { yield Uint8Array.of(0, 128, 255); throw error })())
    await expect(run(f)).rejects.toBe(error)
    const immediate = fixture()
    immediate.readFileStream.mockImplementation(() => { throw error })
    await expect(run(immediate)).rejects.toBe(error)
  })

  it('honors abort before session access and after provider completion', async () => {
    const controller = new AbortController(), reason = new Error('cancelled')
    controller.abort(reason)
    const before = fixture()
    await expect(run(before, 2, 'file-id', controller.signal)).rejects.toBe(reason)
    expect(before.snapshotEvents).not.toHaveBeenCalled()
    const afterController = new AbortController()
    const after = fixture(envelope(ref(0)), (async function* () { afterController.abort(reason) })())
    await expect(run(after, 2, 'file-id', afterController.signal)).rejects.toBe(reason)
  })

  it('honors abort during iteration even if the provider ignores the signal', async () => {
    const controller = new AbortController(), reason = new Error('cancelled'), closed = vi.fn()
    const f = fixture(envelope(), (async function* () {
      try { yield Uint8Array.of(0); controller.abort(reason); yield Uint8Array.of(128, 255) } finally { closed() }
    })())
    await expect(run(f, 2, 'file-id', controller.signal)).rejects.toBe(reason)
    expect(closed).toHaveBeenCalledOnce()
  })
})
