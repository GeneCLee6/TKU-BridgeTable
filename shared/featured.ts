import type { BoardSummary, PublicUser } from './protocol.ts'

/**
 * Featured boards (精選牌局, AC-4.5, `e4-t29`): a member with the `boardCurate` permission picks a
 * finished board, gives it a title, a category and an explanation, and may add a note to any of
 * its tricks that the replay shows when it reaches that trick (`e4-t31`). Only a board everyone
 * may already see can be featured (ARCHITECTURE.md §4). The server keeps them in
 * `worker/featured.ts`; this file holds the types and the input check both sides use.
 */

export const FEATURED_CATEGORIES = ['bidding', 'declarer', 'defence', 'other'] as const
export type FeaturedCategory = (typeof FEATURED_CATEGORIES)[number]
export const isFeaturedCategory = (value: unknown): value is FeaturedCategory =>
  FEATURED_CATEGORIES.includes(value as FeaturedCategory)

export const FEATURED_LIMITS = {
  titleMax: 60,
  explanationMax: 4000,
  trickNoteMax: 1000,
  tricks: 13,
} as const

/** What a curator writes; `trickNotes` maps a trick (1–13) to its note */
export interface FeaturedInput {
  title: string
  category: FeaturedCategory
  explanation: string
  trickNotes: Record<number, string>
}

/** A featured board as members see it, with the board's summary for the cards */
export interface FeaturedBoard extends FeaturedInput {
  boardId: string
  /** Who featured it (`—` once their account is gone) */
  by: PublicUser
  at: number
  updatedAt: number
  board: BoardSummary
}

/**
 * Checks what a curator sent: a title (trimmed, not empty), a known category, an explanation and
 * notes for tricks 1–13; empty notes are dropped. Answers the first field that is wrong
 */
export function parseFeaturedInput(value: unknown): { input: FeaturedInput } | { field: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { field: 'featured' }
  const { title, category, explanation, trickNotes, ...rest } = value as Record<string, unknown>
  const extra = Object.keys(rest)[0]
  if (extra !== undefined) return { field: extra }
  const { titleMax, explanationMax, trickNoteMax, tricks } = FEATURED_LIMITS
  if (typeof title !== 'string' || !title.trim() || title.trim().length > titleMax) return { field: 'title' }
  if (!isFeaturedCategory(category)) return { field: 'category' }
  if (explanation !== undefined && (typeof explanation !== 'string' || explanation.trim().length > explanationMax))
    return { field: 'explanation' }
  const notes: Record<number, string> = {}
  if (trickNotes !== undefined) {
    if (!trickNotes || typeof trickNotes !== 'object' || Array.isArray(trickNotes)) return { field: 'trickNotes' }
    for (const [key, note] of Object.entries(trickNotes)) {
      const trick = Number(key)
      if (!Number.isInteger(trick) || trick < 1 || trick > tricks || String(trick) !== key) return { field: 'trickNotes' }
      if (typeof note !== 'string' || note.trim().length > trickNoteMax) return { field: 'trickNotes' }
      if (note.trim()) notes[trick] = note.trim()
    }
  }
  return {
    input: {
      title: title.trim(),
      category,
      explanation: typeof explanation === 'string' ? explanation.trim() : '',
      trickNotes: notes,
    },
  }
}
