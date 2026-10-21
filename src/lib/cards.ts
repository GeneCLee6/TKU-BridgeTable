import { rankLabel, rankOf, suitOf, type Card } from '../../shared/cards.ts'

/** Card sizes on screen and card names for screen readers */

export type CardSize = 'lg' | 'md' | 'sm'

export const CARD_SIZES: Record<CardSize, { w: number; h: number; font: number }> = {
  lg: { w: 66, h: 94, font: 22 },
  md: { w: 52, h: 74, font: 18 },
  sm: { w: 40, h: 58, font: 15 },
}

export const cardWidth = (size: CardSize) => CARD_SIZES[size].w

const SUIT_TEXT = { S: '黑桃', H: '紅心', D: '方塊', C: '梅花' }

/** 黑桃A, 紅心10: used for screen readers and tests */
export function cardName(card: Card) {
  return `${SUIT_TEXT[suitOf(card)]}${rankLabel(rankOf(card))}`
}
