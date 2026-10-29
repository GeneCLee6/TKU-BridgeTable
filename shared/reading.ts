/**
 * 閱讀進度 (BridgeHall e5-t14, AC-5.8): where a member stopped in an article (the block they had
 * reached) or an e-book (the page), kept with their account so 「繼續閱讀」 on 我的帳號 can take them
 * back. The same types are in the handbook's `src/lib/reading.ts` (type parity, CLAUDE.md rule 10).
 */

export const READING_KINDS = ['article', 'ebook'] as const
export type ReadingKind = (typeof READING_KINDS)[number]

export const READING_LIMITS = {
  /** Places kept per member; the oldest goes first */
  kept: 30,
  idMax: 60,
  titleMax: 200,
  /** Blocks in an article, pages in a book */
  placeMax: 100_000,
} as const

/** What the reader sends (`PUT /api/book/reading`) */
export interface ReadingInput {
  kind: ReadingKind
  /** The article's slug, or the e-book's id */
  id: string
  /** Its title when read, so the list needs nothing else */
  title: string
  /** The block reached (from 0) in an article; the page (from 1) in a book */
  place: number
  /** The article's blocks, or the book's pages */
  of: number
}

/** A place as kept: when it was read */
export type ReadingPlace = ReadingInput & { at: number }
