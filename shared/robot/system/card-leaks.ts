import type { SystemCard } from './card.ts'

/**
 * Finding a system card's rows in built files (ARCHITECTURE.md §4): what `scripts/check-public-assets.ts`
 * runs over the public assets. A minifier rewrites JSON (`"call":"1C"` to `call:"1C"`, `true` to `!0`),
 * so both sides are compared with quotes, escapes and spaces gone.
 */

export const normalized = (text: string) => text.replace(/!0\b/g, 'true').replace(/!1\b/g, 'false').replace(/["'`\\\s]/g, '')

/** Each call of a card, and each article it names, as text to look for */
export function cardRows(card: SystemCard): string[] {
  const rows = card.sections.flatMap((section) => [...section.groups.flatMap((group) => group.calls), ...section.articles])
  return [...new Set(rows.map((row) => normalized(JSON.stringify(row))))]
}

/** The rows of the club's card that say something no public system's card does */
export function clubOnlyRows(club: SystemCard, open: readonly SystemCard[]): string[] {
  const shared = new Set(open.flatMap(cardRows))
  return cardRows(club).filter((row) => !shared.has(row))
}

/** The rows found in any of these files' text */
export function rowsIn(rows: readonly string[], files: readonly string[]): string[] {
  const texts = files.map(normalized)
  return rows.filter((row) => texts.some((text) => text.includes(row)))
}
