import { rankLabel, rankOf, rankValue, SUITS, suitOf, type Card, type Strain, type Suit } from '../../shared/cards.ts'
import type { Strings } from '../strings.ts'

/** Card proportions, names and the order of suits in a hand, shared by every component that draws cards */

/** Height divided by width: a little longer than a poker card, like the bridge-size cards on BBO */
export const CARD_RATIO = 1.5

/** The viewer's card size preference */
export type CardSize = 'small' | 'medium' | 'large'

/** How much each card size scales the cards against the medium size */
export const CARD_SCALE: Record<CardSize, number> = { small: 0.85, medium: 1, large: 1.18 }

export const isCardSize = (value: unknown): value is CardSize => value === 'small' || value === 'medium' || value === 'large'

/** 黑桃A, 紅心10 / "A of spades": the accessible name of a card */
export function cardName(card: Card, t: Strings) {
  return t.cardName(t.suitNames[suitOf(card)], rankLabel(rankOf(card)))
}

const isRed = (suit: Suit) => suit === 'H' || suit === 'D'

/** Every ordering of a few suits, in order of their position in `suits` */
function permutations(suits: readonly Suit[]): Suit[][] {
  if (suits.length <= 1) return [[...suits]]
  return suits.flatMap((suit, i) => permutations([...suits.slice(0, i), ...suits.slice(i + 1)]).map((rest) => [suit, ...rest]))
}

/**
 * The order of suits in a hand at the table, as on BBO: black and red alternate (♠ ♥ ♣ ♦), and
 * once the contract is known the trump suit comes first. `held` is every suit the hand held at the
 * deal: a void could put two suits of one colour side by side, so the others are rearranged
 * around it, and since it is the deal that counts, the order stays put while suits run out.
 */
export function suitOrder(trump: Strain | null | undefined, held: readonly Suit[] = SUITS): Suit[] {
  const first: Suit[] = trump && trump !== 'N' ? [trump] : []
  const lead = first[0] ?? 'S'
  // The preferred order: the suits of the other colour go second and fourth
  const others = SUITS.filter((s) => s !== lead)
  const opposite = others.filter((s) => isRed(s) !== isRed(lead))
  const same = others.filter((s) => isRed(s) === isRed(lead))
  const preferred = [lead, opposite[0], ...same, opposite[1]]
  const clashes = (order: Suit[]) => {
    const shown = order.filter((s) => held.includes(s))
    return shown.slice(1).filter((s, i) => isRed(s) === isRed(shown[i])).length
  }
  const candidates = permutations(preferred.slice(first.length)).map((rest) => [...first, ...rest])
  return candidates.reduce((best, order) => (clashes(order) < clashes(best) ? order : best))
}

/** A hand sorted for display: suits in `order`, high to low within a suit */
export function sortForDisplay(cards: readonly Card[], order: readonly Suit[]): Card[] {
  return [...cards].sort(
    (a, b) => order.indexOf(suitOf(a)) - order.indexOf(suitOf(b)) || rankValue(rankOf(b)) - rankValue(rankOf(a)),
  )
}

/**
 * The box a trick takes for cards `w` wide: a cross a little over three cards wide, or `tall`, with
 * the left and right cards drawn in between the top and bottom ones, only a little over two wide.
 * A phone with dummy on the left or right uses the tall one, so the trick sits on the table
 * instead of against the side seats, in the height the phone has to spare (社長 2026-10-27).
 */
export function trickBox(w: number, tall = false) {
  return tall
    ? { width: Math.round(w * 2.2), height: Math.round(w * CARD_RATIO * 3.1) }
    : { width: Math.round(w * 3.1), height: Math.round(w * CARD_RATIO * 2.3) }
}
