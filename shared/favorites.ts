import { AppError } from './messages.ts'
import { LIMITS, type FavoriteTag } from './protocol.ts'

/**
 * Favorites' notes and tags (AC-4.4), the same rules in the browser and on the server. A tag is
 * trimmed, runs of spaces become one, and it may not hold control characters or commas (the tag
 * box splits on them); tags differing only in letter case are the same tag, the first spelling kept.
 */

/** A tag as it is kept, or '' when nothing is left of it */
export function cleanTag(raw: string): string {
  return raw.replace(/[\p{C},，、]+/gu, ' ').replace(/\s+/g, ' ').trim()
}

/** Tags cleaned, empty ones dropped and repeats (ignoring case) taken out, in their order */
export function cleanTags(raw: readonly string[]): string[] {
  const seen = new Set<string>()
  const tags: string[] = []
  for (const value of raw) {
    const tag = cleanTag(value)
    const key = tag.toLowerCase()
    if (!tag || seen.has(key)) continue
    seen.add(key)
    tags.push(tag)
  }
  return tags
}

/** Whether a tag is one of `tags`, ignoring case */
export const hasTag = (tags: readonly string[], tag: string) => tags.some((t) => t.toLowerCase() === tag.toLowerCase())

/**
 * A note and tags as they are saved; throws `favoriteNoteTooLong` or `favoriteTagsBad` when they
 * break the limits (LIMITS.favoriteNoteMax, favoriteTagsMax, favoriteTagMax)
 */
export function checkFavorite(note: unknown, tags: unknown): { note: string; tags: string[] } {
  const text = typeof note === 'string' ? note.trim() : ''
  if (text.length > LIMITS.favoriteNoteMax) throw new AppError('favoriteNoteTooLong', { max: LIMITS.favoriteNoteMax })
  const list = cleanTags(Array.isArray(tags) ? tags.filter((t): t is string => typeof t === 'string') : [])
  if (list.length > LIMITS.favoriteTagsMax || list.some((t) => t.length > LIMITS.favoriteTagMax))
    throw new AppError('favoriteTagsBad', { max: LIMITS.favoriteTagsMax, length: LIMITS.favoriteTagMax })
  return { note: text, tags: list }
}

/** The member's tags to offer for what is typed (autocomplete): matching ones not chosen yet, most used first */
export function tagSuggestions(known: readonly FavoriteTag[], chosen: readonly string[], typed: string, shown = 6): string[] {
  const text = cleanTag(typed).toLowerCase()
  if (!text) return []
  return known
    .map((k) => k.tag)
    .filter((tag) => tag.toLowerCase().includes(text) && !hasTag(chosen, tag))
    .slice(0, shown)
}
