import { rankOf, SUITS, suitOf, type Card, type Suit } from '../../cards.ts'
import { ANY, QUALITIES, STOPS, type Quality, type Range, type Spec, type Stop } from './spec.ts'

/**
 * A hand the way GIB sees it (GIB Bid Descriptions, docs/BBO GIB/gib-2over1.md §0): high-card
 * points, total points, suit lengths, suit quality, stoppers and controls.
 */
export interface Hand {
  cards: readonly Card[]
  hcp: number
  /** High-card points plus short suits: void 3, singleton 2, doubleton 1, less 1 when it holds points */
  tp: number
  len: Record<Suit, number>
  /** 4333, 4432 or 5332 */
  balanced: boolean
  /** Suit lengths, longest first, e.g. [5, 3, 3, 2] */
  shape: number[]
  /** Aces 2, kings 1 */
  controls: number
  /** High-card points in each suit */
  points: Record<Suit, number>
  /** Ranks held in each suit, high to low, e.g. 'AQT62' */
  ranks: Record<Suit, string>
  quality: Record<Suit, Quality | null>
  stop: Record<Suit, Stop | null>
  /** Losing-trick count, at most three a suit */
  losers: number
}

const HCP: Record<string, number> = { A: 4, K: 3, Q: 2, J: 1 }
const ORDER = 'AKQJT98765432'

export function evaluate(cards: readonly Card[]): Hand {
  const ranks = { S: '', H: '', D: '', C: '' } as Record<Suit, string>
  for (const card of cards) ranks[suitOf(card)] += rankOf(card)
  for (const s of SUITS) ranks[s] = [...ranks[s]].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b)).join('')

  const len = {} as Record<Suit, number>
  const points = {} as Record<Suit, number>
  const quality = {} as Record<Suit, Quality | null>
  const stop = {} as Record<Suit, Stop | null>
  let hcp = 0
  let short = 0
  let controls = 0
  let losers = 0
  for (const s of SUITS) {
    const held = ranks[s]
    len[s] = held.length
    points[s] = [...held].reduce((sum, r) => sum + (HCP[r] ?? 0), 0)
    hcp += points[s]
    if (held.length <= 2) short += Math.max(0, 3 - held.length - (points[s] > 0 ? 1 : 0))
    controls += (held.includes('A') ? 2 : 0) + (held.includes('K') ? 1 : 0)
    // A void has no losers, a singleton only the ace is not one, a doubleton A and K, longer AKQ
    losers += [...held.slice(0, 3)].filter((r) => !'AKQ'.slice(0, held.length).includes(r)).length
    quality[s] = qualityOf(held)
    stop[s] = stopOf(held, points[s])
  }
  const shape = SUITS.map((s) => len[s]).sort((a, b) => b - a)
  const balanced = shape.join('') === '4333' || shape.join('') === '4432' || shape.join('') === '5332'
  return { cards: [...cards], hcp, tp: hcp + short, len, balanced, shape, controls, points, ranks, quality, stop, losers }
}

/** The best quality the suit reaches, GIB's ladder */
function qualityOf(held: string): Quality | null {
  const n = held.length
  const top5 = [...held].filter((r) => 'AKQJT'.includes(r)).length
  if (
    (n === 6 && (held.startsWith('AKQJ') || held.startsWith('AKQT'))) ||
    (n === 7 && held.startsWith('AKQ')) ||
    (n >= 8 && (held.startsWith('AKJ') || held.startsWith('AKQ') || (n >= 9 && held.startsWith('AK'))))
  )
    return 'solid'
  // "Biddable": five cards, or four with the ace, the king or three of the top five honours
  const good = held.includes('A') || held.includes('K') || top5 >= 3
  const extra = n - (good ? 4 : 5)
  if (extra >= 2 && (top5 >= 4 || held.startsWith('AKQ'))) return 'strongRebiddable'
  if (extra >= 2) return 'twiceRebiddable'
  if (extra === 1) return 'rebiddable'
  if (extra === 0) return 'biddable'
  return null
}

/** GIB's stoppers from length plus high-card points in the suit */
function stopOf(held: string, points: number): Stop | null {
  const value = held.length + points
  if (value >= 8) return 'double'
  if (held.includes('A') || (held.startsWith('QJ') && held.length >= 3) || points >= 5 || value >= 7) return 'stop'
  if (value >= 5) return 'likely'
  if (value === 4) return 'partial'
  return null
}

/** Keycards for a trump suit: the four aces and the trump king */
export function keycards(hand: Hand, trump: Suit): number {
  return SUITS.filter((s) => hand.ranks[s].includes('A')).length + (hand.ranks[trump].includes('K') ? 1 : 0)
}

const within = (value: number, range: Range | undefined) => !range || (value >= range[0] && value <= range[1])
const atLeast = <T extends string>(ladder: readonly T[], have: T | null, need: T | undefined) =>
  !need || (have !== null && ladder.indexOf(have) >= ladder.indexOf(need))

/** Whether the hand has everything the specification asks for */
export function fits(hand: Hand, spec: Spec): boolean {
  if (!within(hand.hcp, spec.hcp) || !within(hand.tp, spec.tp) || !within(hand.controls, spec.controls)) return false
  if (spec.balanced !== undefined && hand.balanced !== spec.balanced) return false
  for (const s of SUITS) {
    if (!within(hand.len[s], spec.len?.[s])) return false
    if (!atLeast(QUALITIES, hand.quality[s], spec.quality?.[s])) return false
    if (!atLeast(STOPS, hand.stop[s], spec.stop?.[s])) return false
  }
  if (spec.trump) {
    if (spec.keycards && !spec.keycards.includes(keycards(hand, spec.trump))) return false
    if (spec.trumpQueen !== undefined && hand.ranks[spec.trump].includes('Q') !== spec.trumpQueen) return false
  }
  return true
}

/** A range for the description: '5+' up to `ANY` */
export const open = (min: number): Range => [min, ANY]
