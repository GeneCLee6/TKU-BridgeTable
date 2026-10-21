import { rankLabel, rankOf, suitOf, type Card } from '../../shared/cards.ts'
import type { Strings } from '../strings.ts'

/** Card proportions and names, shared by every component that draws cards */

/** Height divided by width, close to a real playing card */
export const CARD_RATIO = 1.4

/** 黑桃A, 紅心10 / "A of spades": the accessible name of a card */
export function cardName(card: Card, t: Strings) {
  return t.cardName(t.suitNames[suitOf(card)], rankLabel(rankOf(card)))
}
