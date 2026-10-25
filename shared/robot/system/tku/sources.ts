import type { Book } from '../spec.ts'

/**
 * Keeping the club's robot in step with 淡江橋館 (TKU BridgeHall, the club's book; e5-t45, AC-5.9).
 * Each book of rules names the articles it follows (`Book.bookSlugs`, set here by `cite`), and
 * `TKU_SOURCES` records the version of each article the rules were last checked against: the
 * online version (`GET /api/book/content`; 0 is the text the handbook ships with) and the article's
 * `updated` date. When someone edits an article online its version moves on, and the admin page
 * lists it with the rules that follow it until a person has checked the rules against the new
 * text and moved the version here (ROBOT.md §2).
 *
 * Edits to the shipped text arrive with a TKU BridgeBook release, not online; whoever changes an
 * article there checks the robot's rules too and moves its `updated` date here.
 */

export interface BookSource {
  /** The article's address on 淡江橋館 */
  slug: string
  nameZh: string
  /** The online version the rules were checked against; 0 is the shipped text */
  version: number
  /** The article's `updated` date at that version */
  updated: string
}

export const TKU_SOURCES: readonly BookSource[] = [
  { slug: 'system-overview', nameZh: '淡江自然制總覽', version: 0, updated: '2026-10-22' },
  { slug: 'system-one-club', nameZh: '開叫1♣（自然制講義）', version: 0, updated: '2026-10-22' },
  { slug: 'system-one-diamond', nameZh: '開叫1♦（自然制講義）', version: 0, updated: '2026-10-22' },
  { slug: 'system-one-major', nameZh: '開叫1♥/1♠（自然制講義）', version: 0, updated: '2026-10-22' },
  { slug: 'system-notrump', nameZh: '開叫1NT/2NT（自然制講義）', version: 0, updated: '2026-10-22' },
  { slug: 'system-strong-and-preempts', nameZh: '開叫2♣、弱二與阻塞叫（自然制講義）', version: 0, updated: '2026-10-22' },
  { slug: 'system-competition', nameZh: '競叫篇與技光（自然制講義）', version: 0, updated: '2026-10-22' },
  { slug: 'system-doubles', nameZh: '賭倍性叫品（自然制講義）', version: 0, updated: '2026-10-22' },
  { slug: 'notrump-responses', nameZh: '1NT的答叫', version: 0, updated: '2026-10-21' },
  { slug: 'two-notrump-opening', nameZh: '開叫2NT及答叫', version: 0, updated: '2026-10-21' },
  { slug: 'two-diamond-opening', nameZh: '2D 開叫', version: 0, updated: '2026-10-21' },
  { slug: 'bergen-raises', nameZh: 'Bergen加叫（松濤版）', version: 0, updated: '2026-10-21' },
  { slug: 'jacoby-2nt', nameZh: '開叫高花之滿貫詢問叫', version: 0, updated: '2026-10-21' },
  { slug: 'single-raise-major', nameZh: '1H 2H（淡江用）', version: 0, updated: '2026-10-21' },
  { slug: 'new-minor-forcing', nameZh: '新低花迫叫', version: 0, updated: '2026-10-21' },
  { slug: 'lebensohl', nameZh: '雷本索特約', version: 0, updated: '2026-10-21' },
  { slug: 'responsive-double', nameZh: '回答性賭倍', version: 0, updated: '2026-10-21' },
  { slug: 'defense-vs-unusual-2nt', nameZh: '對抗不尋常2NT', version: 0, updated: '2026-10-21' },
]

/** The books, each naming these articles as ones it follows (alongside any it named already) */
export const cite = (slugs: readonly string[], books: readonly Book[]): Book[] =>
  books.map((book) => ({ ...book, bookSlugs: [...new Set([...(book.bookSlugs ?? []), ...slugs])] }))

/** An article as it is online now (`BookService`); absent when it was never edited online */
export interface OnlineArticle {
  version: number
  updatedAt: number
  updatedBy: string
  /** Hidden online (`convention: null`) */
  hidden: boolean
}

export interface BookSyncRow {
  slug: string
  nameZh: string
  /** What the rules were checked against */
  checked: { version: number; updated: string }
  /** The version online now (0: never edited online) */
  version: number
  updatedAt?: number
  updatedBy?: string
  hidden: boolean
  /** The rules follow the article as it is now */
  synced: boolean
  /** How many rules follow the article */
  rules: number
  /** The auctions those rules are for, as the books write them ('' is an opening, `*` any call) */
  auctions: string[]
}

/**
 * Each article the robot follows, against what is online now: out of step when its online version
 * is not the one the rules were checked against (or it was hidden). Out-of-step rows come first.
 */
export function bookSync(books: readonly Book[], online: ReadonlyMap<string, OnlineArticle>, sources: readonly BookSource[] = TKU_SOURCES): BookSyncRow[] {
  const rows = sources.map((source): BookSyncRow => {
    const now = online.get(source.slug)
    const citing = books.filter((book) => book.bookSlugs?.includes(source.slug))
    const auctions = [...new Set(citing.flatMap((book) => (book.after === undefined ? [] : typeof book.after === 'string' ? [book.after] : book.after)))]
    const version = now?.version ?? 0
    const hidden = now?.hidden ?? false
    return {
      slug: source.slug,
      nameZh: source.nameZh,
      checked: { version: source.version, updated: source.updated },
      version,
      ...(now ? { updatedAt: now.updatedAt, updatedBy: now.updatedBy } : {}),
      hidden,
      synced: version === source.version && !hidden,
      rules: citing.reduce((sum, book) => sum + book.rules.length, 0),
      auctions,
    }
  })
  return [...rows.filter((row) => !row.synced), ...rows.filter((row) => row.synced)]
}
