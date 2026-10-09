import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { File } from 'node:buffer'
import { decodeRestoredFile, planFileRestores, MAX_RESTORE_FILE_BYTES as cap, type RestoreAttachment } from '../src/client/attachment-restore.ts'
const file = (bytes = 3, attachmentId = 'file-id'): RestoreAttachment => ({ kind: 'file', name: 'untrusted', mediaType: '', attachment: { bytes, attachmentId } })
const payload = (bytes = 3, data = 'YWJj') => JSON.stringify({ name: 'host.txt', bytes, data })
// Execute the actual index implementation without importing browser UI packages.
const source = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')
const body = source.slice(source.indexOf('function attachmentErrorName'), source.indexOf('const CSS ='))
const compiled = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
const restore = new Function('decodeRestoredFile', 'planFileRestores', 'File', 'warnOnce', `${compiled}; return restoreDraftAttachments`)(decodeRestoredFile, planFileRestores, File, () => {})
function modern(text: string = payload()) {
  const createDrafts = vi.fn((_session, files) => [{ id: 'draft-id', file: files[0] }])
  const execute = vi.fn(async () => ({ ok: true, value: { result: { kind: 'success', text } } }))
  const imageUrl = vi.fn(async () => 'image-url')
  const ctx = { get: (key: string) => key === 'conversation' ? { createDrafts } : { imageUrl }, remote: { commands: { execute } } }
  return { ctx, execute, createDrafts, imageUrl }
}
describe('ordinary attachment restoration', () => {
  it('decodes exact bytes and uses authoritative Host name', () => {
    expect(decodeRestoredFile(payload(), 3)).toEqual({ name: 'host.txt', decoded: new Uint8Array([97, 98, 99]) })
    expect(decodeRestoredFile(payload(0, ''), 0).decoded.length).toBe(0)
  })
  it('accepts a full 8 MiB canonical export without regex recursion', () => {
    const data = Buffer.alloc(cap).toString('base64')
    expect(decodeRestoredFile(payload(cap, data), cap).decoded.length).toBe(cap)
  })
  it('keeps image resolution and mixed attachment order', async () => {
    const m = modern()
    const fetchMock = vi.fn(async () => ({ ok: true, blob: async () => new Blob(['png'], { type: 'image/png' }) }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const image: RestoreAttachment = { ...file(), kind: 'image', name: 'image.png', mediaType: 'image/png' }
      const result = await restore(m.ctx, 'session', 7, [image, file()])
      expect(m.imageUrl).toHaveBeenCalledWith('session', image.attachment)
      expect(m.execute).toHaveBeenCalledOnce()
      expect(result.descriptors.map((draft: any) => draft.file.name)).toEqual(['image.png', 'host.txt'])
    } finally { vi.unstubAllGlobals() }
  })
  it('rejects malformed, noncanonical, mismatched and oversized data', () => {
    for (const [text, expected] of [[payload(1, 'YR=='), 1], [payload(3, 'YW Jj'), 3], [payload(3, 'YWJ='), 3], [payload(3), 2], [payload(-1), -1], [payload(cap + 1), cap + 1], ['null', 0], ['{}', 0], ['not json', 0], [payload(1.5), 1.5]]) expect(() => decodeRestoredFile(text, expected as number)).toThrow()
  })
  it('reserves at most 32 MiB before requests and rejects invalid references', () => {
    expect([...planFileRestores(Array.from({ length: 5 }, () => file(cap)), 2)]).toEqual([0, 1, 2, 3])
    for (const item of [file(-1), file(NaN), file(1.5), file(cap + 1), file(0, ''), file(0, 'id extra'), file(0, '"id"')]) expect(planFileRestores([item], 1).size).toBe(0)
    expect(planFileRestores([file()], 0).size).toBe(0)
  })
  it('uses exact command driver, fresh session drafts, never image resolver', async () => {
    const m = modern()
    const result = await restore(m.ctx, 'session', 7, [file()])
    expect(m.execute).toHaveBeenCalledWith('session', '/rollback --internal file 7 file-id', [])
    expect(m.imageUrl).not.toHaveBeenCalled()
    expect(m.createDrafts).toHaveBeenCalledOnce()
    const draft = result.descriptors[0]
    expect(draft.file.name).toBe('host.txt'); expect(draft.file.type).toBe('application/octet-stream')
    expect(await draft.file.text()).toBe('abc'); expect(result.ids).toEqual(['draft-id'])
  })
  it('counts invalid files and continues successful siblings', async () => {
    const m = modern()
    const result = await restore(m.ctx, 'session', 7, [file(cap + 1), file()])
    expect(result.failures.length).toBe(1); expect(result.ids.length).toBe(1); expect(m.execute).toHaveBeenCalledOnce()
  })
  it('rejects mismatched export without creating drafts', async () => {
    const m = modern(payload(2, 'YWI='))
    const result = await restore(m.ctx, 'session', 7, [file()])
    expect(result.failures.length).toBe(1); expect(m.createDrafts).not.toHaveBeenCalled()
  })
  it('does not create drafts after cancellation during request', async () => {
    const m = modern(); let current = true
    m.execute.mockImplementation(async () => { current = false; return { ok: true, value: { result: { kind: 'success', text: payload() } } } })
    const result = await restore(m.ctx, 'session', 7, [file()], () => current)
    expect(result.ids).toEqual([]); expect(m.createDrafts).not.toHaveBeenCalled()
  })
  it('retains created descriptors for stale caller release', async () => {
    const m = modern(); let current = true
    m.createDrafts.mockImplementation((_session, files) => { current = false; return [{ id: 'draft-id', file: files[0] }] })
    const result = await restore(m.ctx, 'session', 7, [file(), file()], () => current)
    expect(result.ids).toEqual(['draft-id']); expect(result.descriptors.length).toBe(1); expect(m.execute).toHaveBeenCalledOnce()
  })
  it('explicitly skips legacy files and counts failure', async () => {
    const resolveImage = vi.fn(); const createDraftImages = vi.fn()
    const result = await restore({ get: () => ({ resolveImage, createDraftImages }) }, 'session', 7, [file()])
    expect(result.failures).toEqual([{ index: 0, stage: 'resolve', api: 'legacy', reason: 'unavailable' }])
    expect(resolveImage).not.toHaveBeenCalled(); expect(createDraftImages).not.toHaveBeenCalled()
  })
})
