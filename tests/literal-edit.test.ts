import { describe, expect, it } from 'vitest'
import {
  applyLiteralEdit,
  countOccurrences,
  detectLineEndings,
  normalizeLineEndings,
  restoreLineEndings,
} from '../src/core/literal-edit.ts'

describe('normalizeLineEndings', () => {
  it('collapses CRLF and leaves a lone CR alone', () => {
    expect(normalizeLineEndings('a\r\nb\r\nc')).toBe('a\nb\nc')
    expect(normalizeLineEndings('a\rb')).toBe('a\rb')
  })
})

describe('detectLineEndings', () => {
  it('reports the dominant style', () => {
    expect(detectLineEndings('a\r\nb\r\n')).toBe('CRLF')
    expect(detectLineEndings('a\nb\n')).toBe('LF')
    expect(detectLineEndings('no newline at all')).toBe('LF')
  })

  it('decides from the head of the file only', () => {
    // The first 4 KiB are LF; a CRLF tail must not flip the verdict.
    const head = `${'x\n'.repeat(3000)}`
    expect(detectLineEndings(`${head}${'y\r\n'.repeat(3000)}`)).toBe('LF')
  })
})

describe('restoreLineEndings', () => {
  it('returns LF content unchanged and converts for CRLF', () => {
    expect(restoreLineEndings('a\nb', 'LF')).toBe('a\nb')
    expect(restoreLineEndings('a\nb', 'CRLF')).toBe('a\r\nb')
  })

  it('never doubles an existing CR', () => {
    expect(restoreLineEndings('a\r\nb', 'CRLF')).toBe('a\r\nb')
  })
})

describe('countOccurrences', () => {
  it('counts forward, never overlapping', () => {
    expect(countOccurrences('aaaa', 'aa')).toBe(2)
    expect(countOccurrences('abcabc', 'abc')).toBe(2)
    expect(countOccurrences('abc', 'z')).toBe(0)
  })
})

describe('applyLiteralEdit', () => {
  it('replaces a single match', () => {
    const result = applyLiteralEdit('one two three', 'two', 'TWO', false, 'E:\\f.txt')
    expect(result).toEqual({ ok: true, content: 'one TWO three', replacements: 1 })
  })

  it('replaces every match when asked', () => {
    const result = applyLiteralEdit('x x x', 'x', 'y', true, 'E:\\f.txt')
    expect(result).toEqual({ ok: true, content: 'y y y', replacements: 3 })
  })

  it('reports the provider wording when the text is absent', () => {
    expect(applyLiteralEdit('abc', 'zz', 'q', false, 'E:\\f.txt')).toEqual({
      ok: false,
      code: 'FS_EDIT_NOT_FOUND',
      message: 'old_string was not found in "E:\\f.txt"',
    })
  })

  it('refuses an empty old_string with the provider wording', () => {
    expect(applyLiteralEdit('abc', '', 'q', false, 'E:\\f.txt')).toEqual({
      ok: false,
      code: 'FS_EDIT_NOT_FOUND',
      message: 'old_string must be a non-empty string',
    })
  })

  it('refuses an ambiguous match unless replaceAll is set', () => {
    expect(applyLiteralEdit('a a', 'a', 'b', false, 'E:\\f.txt')).toEqual({
      ok: false,
      code: 'FS_AMBIGUOUS_EDIT',
      message: 'old_string matched 2 times in "E:\\f.txt"; provide a more specific old_string or set replace_all to true',
    })
    expect(applyLiteralEdit('a a', 'a', 'b', true, 'E:\\f.txt')).toMatchObject({ ok: true, content: 'b b' })
  })

  it('normalizes line endings on BOTH sides of the match', () => {
    // A CRLF old_string still matches normalized content, and a CRLF replacement
    // text never injects CR into the normalized result.
    const result = applyLiteralEdit('a\nb\nc', 'a\r\nb', 'A\nB', false, 'E:\\f.txt')
    expect(result).toEqual({ ok: true, content: 'A\nB\nc', replacements: 1 })
  })
})