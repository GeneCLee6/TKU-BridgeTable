import { rankOf, rankValue, suitOf, type Card, type Suit } from '../cards.ts'

/** Cards of one suit, high to low */
export function suitCards(cards: readonly Card[], suit: Suit): Card[] {
  return cards.filter((c) => suitOf(c) === suit).sort((a, b) => rankValue(rankOf(b)) - rankValue(rankOf(a)))
}

/** A, Kx, Qxx or Jxxx: enough to bid notrump with that suit */
export function stopper(cards: readonly Card[], suit: Suit): boolean {
  const held = suitCards(cards, suit).map(rankOf)
  return (
    held.includes('A') ||
    (held.includes('K') && held.length >= 2) ||
    (held.includes('Q') && held.length >= 3) ||
    (held.includes('J') && held.length >= 4)
  )
}
