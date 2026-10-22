import { CARD_RATIO } from './cards.ts'

/**
 * Measurements of the table's parts, shared by the components that draw them and by the table
 * layout, which works out the card size from them and keeps room free for each part.
 */

/**
 * How a hand of cards is laid out:
 * - horizontal: one overlapped row (your hand, partner, a hidden hand)
 * - rows: one overlapped row per suit, stacked so only the top of each row shows; narrow, so it
 *   suits the left and right seats (BBO's dummy there)
 * - vertical: one column fanned downwards (side hands on a phone)
 */
export type Orientation = 'horizontal' | 'rows' | 'vertical'

/** How far a playable card slides up, as a share of the card width */
export const LIFT = 0.2

/** Visible height of each suit row but the last, as a share of the card width */
export const ROW_STEP = 0.76

/** The height a hand of cards takes */
export function handHeight(width: number, orientation: Orientation, suits = 4) {
  const card = Math.round(width * CARD_RATIO)
  if (orientation === 'rows') return Math.round(width * LIFT) + Math.max(0, suits - 1) * Math.round(width * ROW_STEP) + card
  return Math.round(width * LIFT) + card
}

/** The auction table never gets smaller than this, whatever its size */
export const auctionCell = (size: number) => Math.max(44, size)

/** The auction table's height with `rows` rounds; with `names` the header has a second line */
export function auctionBoxHeight(size: number, rows: number, names = true) {
  const cell = auctionCell(size)
  return Math.round(cell * (names ? 0.62 : 0.42)) + Math.round(cell * 0.5) * rows + 2
}

export const bidKeyHeight = (size: number) => Math.max(30, Math.round(size * 0.62))

/** The two-row bidding box's height */
export const biddingBoxHeight = (size: number) => 2 * bidKeyHeight(size) + Math.round(size * 0.08) + 2 * Math.round(size * 0.12)
