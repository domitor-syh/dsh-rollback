import { describe, expect, it } from 'vitest'
import {
  isRootMkdirEperm,
  isWithin,
  rootWriteAllowed,
  rootWriteTempPath,
} from '../src/core/root-write.ts'

/** The failure observed in the field, as Node reports it. */
function eperm(path: string, syscall = 'mkdir'): NodeJS.ErrnoException {
  const error = new Error(`EPERM: operation not permitted, ${syscall} '${path}'`) as NodeJS.ErrnoException
  error.code = 'EPERM'
  error.syscall = syscall
  error.path = path
  return error
}

describe('isRootMkdirEperm', () => {
  it('matches the drive-root mkdir failure on both separators and any drive', () => {
    expect(isRootMkdirEperm(eperm('E:\\'))).toBe(true)
    expect(isRootMkdirEperm(eperm('C:\\'))).toBe(true)
    expect(isRootMkdirEperm(eperm('e:/'))).toBe(true)
  })

  it('accepts the failure when only its message carries the drive root', () => {
    const error = new Error("EPERM: operation not permitted, mkdir 'E:\\'") as NodeJS.ErrnoException
    error.code = 'EPERM'
    expect(isRootMkdirEperm(error)).toBe(true)
  })

  it('refuses a mkdir that failed somewhere ordinary', () => {
    // A genuine mkdir failure inside a writable tree must never take the
    // fallback path — that is the one outcome this design must not produce.
    expect(isRootMkdirEperm(eperm('E:\\project\\sub'))).toBe(false)
    expect(isRootMkdirEperm(eperm('/home/user/sub'))).toBe(false)
  })

  it('refuses a drive root when the failing call was not mkdir', () => {
    expect(isRootMkdirEperm(eperm('E:\\', 'open'))).toBe(false)
    expect(isRootMkdirEperm(eperm('E:\\', 'rename'))).toBe(false)
  })

  it('refuses anything that is not EPERM', () => {
    const eacces = eperm('E:\\')
    eacces.code = 'EACCES'
    expect(isRootMkdirEperm(eacces)).toBe(false)
    const eexist = eperm('E:\\')
    eexist.code = 'EEXIST'
    expect(isRootMkdirEperm(eexist)).toBe(false)
  })

  it('refuses values that are not error objects', () => {
    for (const value of [null, undefined, 'EPERM', 42, [], {}]) {
      expect(isRootMkdirEperm(value)).toBe(false)
    }
  })
})

describe('rootWriteAllowed', () => {
  it('allows when nothing confines, or the mode is danger-full-access', () => {
    expect(rootWriteAllowed(undefined, undefined, 'E:\\x.txt')).toBe(true)
    expect(rootWriteAllowed('danger-full-access', 'E:\\ws', 'E:\\x.txt')).toBe(true)
  })

  it('allows a drive root that IS the workspace root', () => {
    // The legitimate case a blanket mode gate would wrongly refuse: the session
    // workspace is the whole volume, so a file at its root is inside it.
    expect(rootWriteAllowed('workspace-write', 'E:\\', 'E:\\x.txt')).toBe(true)
    expect(rootWriteAllowed('workspace-write', 'e:/', 'E:\\x.txt')).toBe(true)
    expect(rootWriteAllowed('workspace-write', 'E:\\ws', 'E:\\ws\\x.txt')).toBe(true)
  })

  it('refuses a drive root outside the workspace, failing closed', () => {
    expect(rootWriteAllowed('workspace-write', 'E:\\ws', 'E:\\x.txt')).toBe(false)
    expect(rootWriteAllowed('workspace-write', 'E:\\ws\\deep', 'E:\\other\\x.txt')).toBe(false)
    expect(rootWriteAllowed('workspace-write', undefined, 'E:\\x.txt')).toBe(false)
    expect(rootWriteAllowed('workspace-write', '', 'E:\\x.txt')).toBe(false)
  })

  it('refuses whenever the sandbox is read-only', () => {
    expect(rootWriteAllowed('read-only', 'E:\\', 'E:\\x.txt')).toBe(false)
    expect(rootWriteAllowed('read-only', undefined, 'E:\\x.txt')).toBe(false)
  })

  it('compares case-insensitively and ignores doubled or trailing separators', () => {
    expect(isWithin('e:/ws/x.txt', 'E:\\WS')).toBe(true)
    expect(isWithin('E:\\ws\\x.txt', 'E:\\ws\\')).toBe(true)
    expect(isWithin('E:\\\\ws\\\\x.txt', 'E:\\ws')).toBe(true)
    expect(isWithin('E:\\ws', 'E:\\ws')).toBe(true)
    expect(isWithin('E:\\wsx', 'E:\\ws')).toBe(false)
    expect(isWithin('E:\\', 'E:\\ws')).toBe(false)
  })
})

describe('rootWriteTempPath', () => {
  it('stages inside the destination directory so the rename stays atomic', () => {
    expect(rootWriteTempPath('E:\\foo.txt', 'u1')).toBe('E:\\.foo.txt.u1.rbk-tmp')
    expect(rootWriteTempPath('E:\\dir\\foo.txt', 'u1')).toBe('E:\\dir\\.foo.txt.u1.rbk-tmp')
    expect(rootWriteTempPath('E:/foo.txt', 'u1')).toBe('E:/.foo.txt.u1.rbk-tmp')
  })

  it('never collides with the destination or another staging attempt', () => {
    const temp = rootWriteTempPath('E:\\foo.txt', 'u1')
    expect(temp).not.toBe('E:\\foo.txt')
    expect(rootWriteTempPath('E:\\foo.txt', 'u1')).not.toBe(rootWriteTempPath('E:\\foo.txt', 'u2'))
  })

  it('handles a path with no separator at all', () => {
    expect(rootWriteTempPath('foo.txt', 'u1')).toBe('.foo.txt.u1.rbk-tmp')
  })
})