import { describe, expect, it } from 'vitest'
import { credentialText, toFullWidth, toHalfWidth } from '../../shared/halfwidth.ts'

/** U+3000, the ideographic space */
const IDEO = String.fromCharCode(0x3000)

describe('full-width ASCII to half-width', () => {
  it('turns what a full-width input method types into ASCII', () => {
    expect(toHalfWidth('ＡＢＣ１２３')).toBe('ABC123')
    expect(toHalfWidth('ａｂｃ！＠＃～')).toBe('abc!@#~')
    expect(toHalfWidth('ｇｅｎｅ．ｌｅｅ＠ｍａｉｌ．ｃｏｍ')).toBe('gene.lee@mail.com')
  })

  it('makes the ideographic space a plain space', () => {
    expect(toHalfWidth(`ａ${IDEO}ｂ`)).toBe('a b')
  })

  it('covers exactly U+FF01 to U+FF5E', () => {
    for (let code = 0x21; code <= 0x7e; code++)
      expect(toHalfWidth(String.fromCharCode(code + 0xfee0))).toBe(String.fromCharCode(code))
    // Just outside the block: the full-width brackets ｟ and ｠ and the half-width katakana stay
    expect(toHalfWidth('｟｠ｱ')).toBe('｟｠ｱ')
  })

  it('leaves Chinese, half-width text and the length alone', () => {
    expect(toHalfWidth('淡江橋藝 abc-123')).toBe('淡江橋藝 abc-123')
    const mixed = `橋牌ＡＢＣ${IDEO}ｘ`
    expect(toHalfWidth(mixed)).toHaveLength(mixed.length)
  })

  it('goes back to full-width for the legacy password check', () => {
    expect(toFullWidth('ABC 123')).toBe(`ＡＢＣ${IDEO}１２３`)
    expect(toHalfWidth(toFullWidth('club-secret-1!'))).toBe('club-secret-1!')
    expect(toFullWidth('橋牌')).toBe('橋牌')
  })

  it('reads a request field as half-width and trimmed', () => {
    expect(credentialText(`${IDEO}ｇｅｎｅ${IDEO}`)).toBe('gene')
    expect(credentialText(undefined)).toBe('')
    expect(credentialText(42)).toBe('42')
  })
})
