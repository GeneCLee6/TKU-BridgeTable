import { isCard, isSeat, type Card, type Seat } from './cards.ts'

/**
 * The teaching table's marks (`e10-t11`, ARCHITECTURE.md §4, §5.11): what a teacher draws on the
 * table while it is paused. Pure: the browser builds a mark, the table checks it with
 * `parseTeachMark`, and `worker/views.ts` decides who is sent which one.
 */

/** What an arrow points from or to: a seat, or a card (sent only to those who can see that card) */
export type TeachAnchor = { seat: Seat } | { card: Card }

export type TeachMarkInput =
  | { kind: 'circle'; card: Card }
  | { kind: 'arrow'; from: TeachAnchor; to: TeachAnchor }
  /** Short text, for the whole table or next to a seat */
  | { kind: 'text'; text: string; seat?: Seat }

export type TeachMark = TeachMarkInput & { id: number }

/** Marks on the table at once */
export const TEACH_MARKS_MAX = 30
/** Characters of a text mark */
export const TEACH_TEXT_MAX = 80

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const onlyKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every((k) => keys.includes(k))

function parseAnchor(value: unknown): TeachAnchor | null {
  if (!isObject(value) || Object.keys(value).length !== 1) return null
  if (isSeat(value.seat)) return { seat: value.seat }
  if (isCard(value.card)) return { card: value.card }
  return null
}

const sameAnchor = (a: TeachAnchor, b: TeachAnchor) =>
  'seat' in a ? 'seat' in b && a.seat === b.seat : 'card' in b && a.card === b.card

/** A text mark's words: one line without control or format characters, or null when empty or too long */
export function cleanTeachText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value
    .replace(/\p{C}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text && [...text].length <= TEACH_TEXT_MAX ? text : null
}

/** A mark as sent from the browser, with nothing else in it; null when it is not one */
export function parseTeachMark(value: unknown): TeachMarkInput | null {
  if (!isObject(value)) return null
  switch (value.kind) {
    case 'circle':
      return onlyKeys(value, ['kind', 'card']) && isCard(value.card)
        ? { kind: 'circle', card: value.card }
        : null
    case 'arrow': {
      if (!onlyKeys(value, ['kind', 'from', 'to'])) return null
      const from = parseAnchor(value.from)
      const to = parseAnchor(value.to)
      return from && to && !sameAnchor(from, to) ? { kind: 'arrow', from, to } : null
    }
    case 'text': {
      if (!onlyKeys(value, ['kind', 'text', 'seat'])) return null
      const text = cleanTeachText(value.text)
      if (!text) return null
      if (value.seat === undefined) return { kind: 'text', text }
      return isSeat(value.seat) ? { kind: 'text', text, seat: value.seat } : null
    }
    default:
      return null
  }
}
