import { describe, expect, it } from 'vitest'
import { TKU } from '../../shared/robot/system/tku/index.ts'
import { bookSync, TKU_SOURCES, type OnlineArticle } from '../../shared/robot/system/tku/sources.ts'

/** The club's robot kept in step with 淡江橋館 (e5-t45, AC-5.9) */

describe('the club’s robot and 淡江橋館', () => {
  it('names the articles every book of rules follows, each one a recorded source', () => {
    const known = new Set(TKU_SOURCES.map((s) => s.slug))
    for (const book of TKU.books) {
      expect(book.bookSlugs?.length, `a book for ${String(book.after)}`).toBeGreaterThan(0)
      for (const slug of book.bookSlugs!) expect(known, slug).toContain(slug)
    }
    expect(new Set(TKU_SOURCES.map((s) => s.slug)).size).toBe(TKU_SOURCES.length)
  })

  it('is in step when nothing was edited online since the rules were checked', () => {
    const rows = bookSync(TKU.books, new Map())
    expect(rows).toHaveLength(TKU_SOURCES.length)
    expect(rows.every((row) => row.synced && row.version === 0)).toBe(true)
    expect(rows.find((row) => row.slug === 'notrump-responses')!.auctions).toContain('1N (P)')
    expect(rows.every((row) => row.rules > 0)).toBe(true)
  })

  it('lists an article edited or hidden online first, with the rules that follow it', () => {
    const online = new Map<string, OnlineArticle>([
      ['new-minor-forcing', { version: 2, updatedAt: 1000, updatedBy: 'joey', hidden: false }],
      ['lebensohl', { version: 1, updatedAt: 2000, updatedBy: 'amy', hidden: true }],
      // Edited online, but not an article the robot follows
      ['good-bad-2nt', { version: 1, updatedAt: 3000, updatedBy: 'joey', hidden: false }],
    ])
    const rows = bookSync(TKU.books, online)
    expect(rows.slice(0, 2).map((row) => [row.slug, row.synced])).toEqual([
      ['new-minor-forcing', false],
      ['lebensohl', false],
    ])
    expect(rows[0]).toMatchObject({ version: 2, checked: { version: 0 }, updatedBy: 'joey', hidden: false })
    expect(rows[1].hidden).toBe(true)
    expect(rows.slice(2).every((row) => row.synced)).toBe(true)
    expect(rows.some((row) => row.slug === 'good-bad-2nt')).toBe(false)
  })
})
