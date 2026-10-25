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
  /** Losing-trick count (LTC): the missing A, K and Q among each suit's top three cards */
  losers: number
  /** One point for every card past the fourth in a suit */
  lengthPoints: number
  /** Void 3, singleton 2, doubleton 1, whatever the suit holds */
  shortPoints: number
  /** AK 2, AQ 1½, A or KQ 1, Kx ½ in each suit */
  quickTricks: number
  /**
   * Honours in the right places: +1 for a five-card or longer suit with three of the top five
   * honours; −1 for a short honour that may not pull its weight (singleton K, Q or J; doubleton
   * QJ, Qx or Jx)
   */
  honours: number
  /** High-card points plus length points plus `honours`: the hand's starting value */
  adjusted: number
  /** High-card points plus the lengths of the two longest suits (Rule of 20) */
  rule20: number
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
  let lengthPoints = 0
  let shortPoints = 0
  let quickTricks = 0
  let honours = 0
  for (const s of SUITS) {
    const held = ranks[s]
    len[s] = held.length
    points[s] = [...held].reduce((sum, r) => sum + (HCP[r] ?? 0), 0)
    hcp += points[s]
    if (held.length <= 2) short += Math.max(0, 3 - held.length - (points[s] > 0 ? 1 : 0))
    controls += (held.includes('A') ? 2 : 0) + (held.includes('K') ? 1 : 0)
    // A void has no losers, a singleton only the ace is not one, a doubleton A and K, longer AKQ
    losers += [...held.slice(0, 3)].filter((r) => !'AKQ'.slice(0, held.length).includes(r)).length
    lengthPoints += Math.max(0, held.length - 4)
    shortPoints += Math.max(0, 3 - held.length)
    quickTricks += quickTricksOf(held)
    honours += honourAdjustment(held)
    quality[s] = qualityOf(held)
    stop[s] = stopOf(held, points[s])
  }
  const shape = SUITS.map((s) => len[s]).sort((a, b) => b - a)
  const balanced = shape.join('') === '4333' || shape.join('') === '4432' || shape.join('') === '5332'
  return {
    cards: [...cards],
    hcp,
    tp: hcp + short,
    len,
    balanced,
    shape,
    controls,
    points,
    ranks,
    quality,
    stop,
    losers,
    lengthPoints,
    shortPoints,
    quickTricks,
    honours,
    adjusted: hcp + lengthPoints + honours,
    rule20: hcp + shape[0] + shape[1],
  }
}

/** Quick tricks in one suit (ranks high to low) */
function quickTricksOf(held: string): number {
  if (held.startsWith('AK')) return 2
  if (held.startsWith('AQ')) return 1.5
  if (held.startsWith('A')) return 1
  if (held.startsWith('KQ')) return 1
  if (held.startsWith('K') && held.length >= 2) return 0.5
  return 0
}

/** +1 for a strong long suit, −1 for a short honour that may be wasted */
function honourAdjustment(held: string): number {
  const top5 = [...held].filter((r) => 'AKQJT'.includes(r)).length
  if (held.length >= 5 && top5 >= 3) return 1
  if (held.length === 1 && 'KQJ'.includes(held)) return -1
  if (held.length === 2 && (held[0] === 'Q' || held[0] === 'J')) return -1
  return 0
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

/** What the auction has told a hand that changes its value (e5-t40); all of it is public */
export interface Setting {
  /** The agreed or likely trump suit; none for notrump */
  trump?: Suit
  /** The fewest trumps partner has shown */
  partnerTrumps?: number
  /** Suits the right-hand opponent has bid: my honours there sit over the bidder */
  rho?: readonly Suit[]
  /** Suits the left-hand opponent has bid: the bidder sits over my honours there */
  lho?: readonly Suit[]
}

/** A hand's value once the fit and the opponents' suits are known, and where it comes from */
export interface Revalued {
  points: number
  /** Combined trumps; 0 without a trump suit */
  fit: number
  /** Points for short side suits, counted only with an eight-card or longer fit */
  shortness: number
  /** +1 for the queen or jack of trumps, plus the short-honour deduction given back in trumps */
  trumpHonours: number
  /** +1 for each combined trump past the eighth */
  extraTrumps: number
  /** +1 for each king or queen over a suit the right-hand opponent bid, −1 under the left-hand one */
  position: number
}

/** Void, singleton and doubleton points for the dummy with four or more trumps, with three */
const DUMMY_FOUR = [5, 3, 1]
const DUMMY_THREE = [3, 2, 1]
/** ...and for the hand with more trumps, or a dummy with only two */
const DECLARER_SHORT = [2, 1, 0]

/**
 * Re-evaluate a hand after the auction (e5-t40): with an eight-card fit the short side suits
 * count (more for the dummy), the minor honours in trumps are promoted and every trump past the
 * eighth adds one; kings and queens behind the right-hand opponent's suit gain, those in front
 * of the left-hand opponent's suit lose. Without a fit it is `adjusted` plus the honour position.
 */
export function revalue(hand: Hand, setting: Setting): Revalued {
  const rho = setting.rho ?? []
  const lho = setting.lho ?? []
  let position = 0
  for (const s of SUITS) {
    const minor = /[KQ]/.test(hand.ranks[s])
    if (!minor || rho.includes(s) === lho.includes(s)) continue
    position += rho.includes(s) ? 1 : -1
  }

  const trump = setting.trump
  const partner = setting.partnerTrumps ?? 0
  const fit = trump ? hand.len[trump] + partner : 0
  if (!trump || fit < 8) {
    return { points: hand.adjusted + position, fit, shortness: 0, trumpHonours: 0, extraTrumps: 0, position }
  }

  const mine = hand.len[trump]
  const dummy = mine <= partner
  const table = !dummy || mine < 3 ? DECLARER_SHORT : mine === 3 ? DUMMY_THREE : DUMMY_FOUR
  let shortness = 0
  for (const s of SUITS) {
    if (s === trump || hand.len[s] > 2) continue
    shortness += Math.max(0, table[hand.len[s]] - (hand.points[s] > 0 ? 1 : 0))
  }
  const held = hand.ranks[trump]
  const trumpHonours = (/[QJ]/.test(held) ? 1 : 0) - Math.min(0, honourAdjustment(held))
  const extraTrumps = fit - 8
  // The dummy counts its short suits instead of its length
  const base = hand.adjusted - (dummy ? hand.lengthPoints : 0)
  return {
    points: base + shortness + trumpHonours + extraTrumps + position,
    fit,
    shortness,
    trumpHonours,
    extraTrumps,
    position,
  }
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
