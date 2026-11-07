import { tokens } from '../context.ts'
import type { Book, Range, Rule, Spec } from '../spec.ts'

/** Helpers the Precision books share */

export { bid, goodSuit, isMajor, isMinor, longest, MAJORS, other, plus, SUITS_DOWN, UP, upTo } from '../gib/util.ts'

/** The opening's strength limit: 16+ goes through 1♣ */
export const LIMITED: Range = [11, 15]
export const STRONG: Range = [16, 40]

const afterOf = (book: Book): readonly string[] => (book.after === undefined ? [] : typeof book.after === 'string' ? [book.after] : book.after)

/** Books for auctions starting with one of these calls are left out */
export const without = (books: readonly Book[], ...openings: string[]): Book[] =>
  books.filter((book) => !afterOf(book).some((after) => openings.includes(tokens(after)[0] ?? '')))

/** Only the books for auctions starting with one of these calls */
export const only = (books: readonly Book[], ...openings: string[]): Book[] =>
  books.filter((book) => afterOf(book).some((after) => openings.includes(tokens(after)[0] ?? '')))

const overlaps = (a: Range, b: Range) => a[0] <= b[1] && b[0] <= a[1]

/**
 * 2/1's books over an opening that is limited here: a rule for a hand the player cannot hold is left
 * out, so the bidding box does not offer it (a 19-point jump shift by an 11–15 opener). Whose turn a
 * book is for shows in its pattern: every fourth token from the opening is the opener's.
 */
export function limited(books: readonly Book[], opener: Range, responder: Range | null = null): Book[] {
  return books.map((book) => {
    const after = afterOf(book)
    const length = after.length ? tokens(after[0]).length : 1
    if (length % 2 !== 0) return book
    const limit = length % 4 === 0 ? opener : responder
    if (!limit) return book
    const possible = (rule: Rule) => {
      const shows = typeof rule.shows === 'function' ? undefined : (rule.shows as Spec | undefined)
      return !shows?.hcp || overlaps(shows.hcp, limit)
    }
    return { ...book, rules: book.rules.filter(possible) }
  })
}
