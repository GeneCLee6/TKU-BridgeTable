import { hcp, rankOf, rankValue, SUITS, suitOf, type Card, type Suit } from '../cards.ts'

/** What a robot knows about its own hand at a glance */
export interface HandInfo {
  cards: Card[]
  hcp: number
  len: Record<Suit, number>
  balanced: boolean
}

export function analyze(cards: readonly Card[]): HandInfo {
  const len: Record<Suit, number> = { S: 0, H: 0, D: 0, C: 0 }
  for (const card of cards) len[suitOf(card)]++
  const shape = SUITS.map((s) => len[s]).sort((a, b) => b - a)
  // 4333, 4432 and 5332
  const balanced = shape[3] >= 2 && shape[2] >= 2 && shape[0] <= 5 && !(shape[2] === 2 && shape[3] === 2)
  return { cards: [...cards], hcp: hcp(cards), len, balanced }
}

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

/** The longest suit, majors first on ties ('S' 'H' 'D' 'C' order) */
export function longest(info: HandInfo, among: readonly Suit[] = SUITS): Suit {
  return [...among].sort((a, b) => info.len[b] - info.len[a] || SUITS.indexOf(a) - SUITS.indexOf(b))[0]
}
