import type { Call } from '../../../auction.ts'
import type { Strain, Suit } from '../../../cards.ts'
import type { Hand } from '../evaluate.ts'
import { ANY, type Range } from '../spec.ts'

/** Small helpers the 2/1 books share */

export const MAJORS: readonly Suit[] = ['S', 'H']
export const MINORS: readonly Suit[] = ['D', 'C']
/** Suits from the top: ♠ ♥ ♦ ♣ */
export const SUITS_DOWN: readonly Suit[] = ['S', 'H', 'D', 'C']
/** Suits from the bottom: ♣ ♦ ♥ ♠ */
export const UP: readonly Suit[] = ['C', 'D', 'H', 'S']
/** Whether suit `a` ranks above suit `b` */
export const above = (a: Suit, b: Suit) => UP.indexOf(a) > UP.indexOf(b)

export const bid = (level: number, strain: Strain): Call => `${level}${strain}`
export const isMajor = (s: Strain): s is Suit => s === 'S' || s === 'H'
export const isMinor = (s: Strain): s is Suit => s === 'D' || s === 'C'
/** The other major, or the other minor */
export const other = (s: Suit): Suit => ({ S: 'H', H: 'S', D: 'C', C: 'D' } as const)[s]

export const plus = (min: number): Range => [min, ANY]
export const upTo = (max: number): Range => [0, max]

/** The longest suit, the higher of equal ones */
export const longest = (h: Hand, among: readonly Suit[] = SUITS_DOWN): Suit =>
  [...among].sort((a, b) => h.len[b] - h.len[a] || SUITS_DOWN.indexOf(a) - SUITS_DOWN.indexOf(b))[0]

/** High-card points plus the lengths of the two longest suits (the Rule of 20) */
export const ruleOf20 = (h: Hand) => h.hcp + h.shape[0] + h.shape[1]

/** Honours among the top three and the top five of a suit */
export function honours(h: Hand, s: Suit) {
  const held = h.ranks[s]
  return { top3: [...held].filter((r) => 'AKQ'.includes(r)).length, top5: [...held].filter((r) => 'AKQJT'.includes(r)).length }
}

/** A disciplined preempt or weak two: two of the top three honours or three of the top five */
export const goodSuit = (h: Hand, s: Suit) => {
  const { top3, top5 } = honours(h, s)
  return top3 >= 2 || top5 >= 3
}
