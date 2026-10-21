/**
 * Cards, suits and seats. Pure data helpers shared by the browser and the Worker.
 * A card is a two-letter string: suit then rank, e.g. 'SA' (♠A), 'HT' (♥10), 'C2' (♣2).
 */

export type Suit = 'S' | 'H' | 'D' | 'C'
export type Strain = Suit | 'N'
export type Seat = 'N' | 'E' | 'S' | 'W'
export type Side = 'NS' | 'EW'
export type Card = string
export type Hands = Record<Seat, Card[]>

/** Display order of suits in a hand: ♠ ♥ ♦ ♣ */
export const SUITS: readonly Suit[] = ['S', 'H', 'D', 'C']
/** Ranks from high to low; 'T' is the ten */
export const RANKS = 'AKQJT98765432'
/** Seats in clockwise order */
export const SEATS: readonly Seat[] = ['N', 'E', 'S', 'W']

export const SUIT_SYMBOL: Record<Strain, string> = { S: '♠', H: '♥', D: '♦', C: '♣', N: 'NT' }

export const suitOf = (card: Card) => card[0] as Suit
export const rankOf = (card: Card) => card[1]
/** 14 for an ace down to 2 for a deuce */
export const rankValue = (rank: string) => 14 - RANKS.indexOf(rank)
/** 'T' is shown as '10' */
export const rankLabel = (rank: string) => (rank === 'T' ? '10' : rank)

export const nextSeat = (seat: Seat, steps = 1): Seat =>
  SEATS[(SEATS.indexOf(seat) + steps) % 4]
export const partnerOf = (seat: Seat) => nextSeat(seat, 2)
export const sideOf = (seat: Seat): Side => (seat === 'N' || seat === 'S' ? 'NS' : 'EW')
export const sameSide = (a: Seat, b: Seat) => sideOf(a) === sideOf(b)

export function fullDeck(): Card[] {
  return SUITS.flatMap((suit) => [...RANKS].map((rank) => suit + rank))
}

/** Sort ♠ ♥ ♦ ♣, high to low within a suit */
export function sortHand(cards: readonly Card[]): Card[] {
  return [...cards].sort(
    (a, b) =>
      SUITS.indexOf(suitOf(a)) - SUITS.indexOf(suitOf(b)) ||
      rankValue(rankOf(b)) - rankValue(rankOf(a)),
  )
}

export function isCard(value: unknown): value is Card {
  return (
    typeof value === 'string' &&
    value.length === 2 &&
    SUITS.includes(value[0] as Suit) &&
    RANKS.includes(value[1])
  )
}

export function isSeat(value: unknown): value is Seat {
  return typeof value === 'string' && SEATS.includes(value as Seat)
}

/** Group a hand by suit, each suit high to low */
export function bySuit(cards: readonly Card[]): Record<Suit, Card[]> {
  const groups: Record<Suit, Card[]> = { S: [], H: [], D: [], C: [] }
  for (const card of sortHand(cards)) groups[suitOf(card)].push(card)
  return groups
}

/** High-card points: A 4, K 3, Q 2, J 1 */
export function hcp(cards: readonly Card[]): number {
  const points: Record<string, number> = { A: 4, K: 3, Q: 2, J: 1 }
  return cards.reduce((sum, card) => sum + (points[rankOf(card)] ?? 0), 0)
}
