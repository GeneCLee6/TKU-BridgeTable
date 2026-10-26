import { rankOf, rankValue, type Card, type Suit } from '../cards.ts'

/**
 * The card the club leads from a holding (淡江「01 第 4」, ROBOT.md §3): the card led never has
 * a touching card above it, and at most one honour above it (the exceptions: K from AK, Q from KQ).
 *
 * - a singleton; the top of a doubleton
 * - AK and KQ lead either card: the king asks partner for count, the ace or the queen for
 *   attitude (so does the queen from QJ). TKB asks count holding the next honour down (AKQ, KQJ)
 *   and attitude without it (AKJ, KQT, KQx: does partner hold it?)
 * - against a suit contract the honours are A K Q J: never lead away from an ace (AK: the king
 *   from four or more, asking count, can partner ruff the third round; AKx the ace); the top of a
 *   sequence (KQJ the king, KQ otherwise the queen; QJ, JT, T9);
 *   the top of an interior sequence (KJT, KT9, QT9); fourth best from an honour (the lowest from
 *   three); second highest from no honour. So a nine is only ever led from a singleton or doubleton
 * - against notrump an honour lead needs three in a row or two in a row and one more with a gap
 *   (AKQ, AKJ, KQJ, KQT, QJT, QJ9, JT9, JT8, T98, T97) or an interior sequence (AQJ, AJT, KJT, KT9,
 *   AT9, QT9): AKQ the king (count), AKJ the ace (attitude), KQJ the king, KQT the queen, otherwise the
 *   top; fourth best from an honour, the ten counting only with the nine (T9xx fourth best);
 *   leading away from an ace is fine; second highest from no honour
 *
 * `cards` is the holding sorted from the highest.
 */
export function clubLeadCard(cards: Card[], trump: Suit | null): Card {
  if (cards.length <= 2) return cards[0]
  const v = cards.map((c) => rankValue(rankOf(c)))
  if (trump) {
    if (v[0] === 14) return v[1] === 13 && cards.length >= 4 ? cards[1] : cards[0]
    return sequenceLead(cards, trump) ?? (v[0] >= 11 ? fourthBest(cards) : cards[1])
  }
  const sequence = sequenceLead(cards, trump)
  if (sequence) return sequence
  const honour = v[0] >= 11 || (v[0] === 10 && v[1] === 9)
  return honour ? fourthBest(cards) : cards[1]
}

/**
 * The card a sequence leads, if the holding has one the club leads from (`clubLeadCard`); a
 * suit with one is a good lead in its own right
 */
export function sequenceLead(cards: Card[], trump: Suit | null): Card | null {
  if (cards.length < 3) return null
  const v = cards.map((c) => rankValue(rankOf(c)))
  if (trump) {
    if (v[0] === 14) return v[1] === 13 ? clubLeadCard(cards, trump) : null
    if (v[0] === 13 && v[1] === 12) return v[2] === 11 ? cards[0] : cards[1]
    if (v[0] - v[1] === 1 && v[0] >= 10) return cards[0]
    if (v[0] >= 12 && v[0] - v[1] >= 2 && v[1] - v[2] === 1 && v[1] >= 10) return cards[1]
    return null
  }
  if (v[0] >= 10 && v[0] - v[1] === 1 && (v[1] - v[2] === 1 || v[1] - v[2] === 2)) {
    if (v[0] === 14) return v[2] === 12 ? cards[1] : cards[0]
    return v[0] === 13 && v[2] !== 11 ? cards[1] : cards[0]
  }
  if (v[0] >= 12 && v[0] - v[1] >= 2 && v[1] - v[2] === 1 && v[1] >= 10) return cards[1]
  return null
}

function fourthBest(cards: Card[]): Card {
  return cards.length >= 4 ? cards[3] : cards.at(-1)!
}
