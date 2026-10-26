import { bySuit, nextSeat, RANKS, rankOf, SEATS, sortHand, SUITS, type Card, type Hands, type Seat } from './cards.ts'

/**
 * Hands written as text, the way PBN and most bridge tools write them: one hand is its four suits
 * in the order ♠.♥.♦.♣, high to low, `AKQ2.K73.9.AJ852` (a void is an empty suit, `AKQ2.K73..AJ8652`);
 * a deal is `N:` and the four hands from that seat round the table. Ten is `T` (`10` is read too).
 * Pure: the practice dialog reads what the member types with it, the server checks deal sets with it.
 */

/** One hand as `♠.♥.♦.♣` text */
export function formatHand(cards: readonly Card[]): string {
  const groups = bySuit(cards)
  return SUITS.map((suit) => groups[suit].map(rankOf).join('')).join('.')
}

/**
 * The cards of one hand written as text, or null: four suits, known ranks, no card twice. `size`
 * is how many cards it must have (13; null for any number, while it is being typed)
 */
export function parseHand(text: string, size: number | null = 13): Card[] | null {
  const suits = String(text ?? '')
    .trim()
    .toUpperCase()
    .replace(/10/g, 'T')
    .split('.')
  if (suits.length !== 4) return null
  const cards: Card[] = []
  for (const [i, ranks] of suits.entries()) {
    for (const rank of ranks.replace(/\s/g, '')) {
      if (!RANKS.includes(rank)) return null
      cards.push(SUITS[i] + rank)
    }
  }
  if (new Set(cards).size !== cards.length) return null
  if (size !== null && cards.length !== size) return null
  return sortHand(cards)
}

/** A whole deal in PBN, `N:<north> <east> <south> <west>` (or starting from any seat), or null: 52 different cards */
export function parseDeal(text: string): Hands | null {
  const match = /^\s*([NESW]):\s*(\S*)\s+(\S*)\s+(\S*)\s+(\S*)\s*$/i.exec(String(text ?? ''))
  if (!match) return null
  const first = match[1].toUpperCase() as Seat
  const hands = {} as Hands
  for (let i = 0; i < 4; i++) {
    const hand = parseHand(match[i + 2])
    if (!hand) return null
    hands[nextSeat(first, i)] = hand
  }
  const all = SEATS.flatMap((seat) => hands[seat])
  return new Set(all).size === 52 ? hands : null
}

/** A deal as PBN, from North */
export const formatDeal = (hands: Hands) => `N:${SEATS.map((seat) => formatHand(hands[seat])).join(' ')}`
