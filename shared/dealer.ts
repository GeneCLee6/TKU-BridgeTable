import type { RandomInt } from './board.ts'
import { hcp, RANKS, SEATS, sortHand, SUITS, type Hands, type Seat, type Side, type Suit } from './cards.ts'

/**
 * Deals that meet conditions (AC-10.1): points, suit lengths and balanced shape for any seat, and
 * points for a side. A condition can also be a list of alternatives, any of which will do (a five-
 * card major: five spades, or five hearts).
 *
 * Every deal that meets the conditions is equally likely, as if random deals were drawn until one
 * fits. To get there faster, each attempt first draws how many cards of each suit every seat gets
 * (from their true odds) and stops early when those lengths cannot fit; only then are the cards
 * themselves dealt within each suit and the points checked. After `maxAttempts` it gives up and
 * says so, rather than running on.
 */

export type Range = readonly [min: number, max: number]

export interface SeatConditions {
  /** High-card points (A 4, K 3, Q 2, J 1) */
  hcp?: Range
  lengths?: Partial<Record<Suit, Range>>
  /** 4-3-3-3, 4-4-3-2 or 5-3-3-2 */
  balanced?: boolean
}

export interface DealConditions {
  seats?: Partial<Record<Seat, SeatConditions>>
  /** The two hands of a side together */
  sides?: Partial<Record<Side, { hcp?: Range }>>
}

export type DealResult = { ok: true; hands: Hands; attempts: number } | { ok: false; attempts: number }

export const DEFAULT_MAX_ATTEMPTS = 100_000

const BALANCED = new Set(['3334', '2344', '2335'])
const shapeKey = (lengths: number[]) => [...lengths].sort((a, b) => a - b).join('')
const within = (value: number, range: Range | undefined) => !range || (value >= range[0] && value <= range[1])
const SIDE_SEATS: Record<Side, [Seat, Seat]> = { NS: ['N', 'S'], EW: ['E', 'W'] }

/**
 * What is wrong with some conditions, or null if they could be met: a range upside down, out of
 * bounds, or lengths that cannot add up to 13 cards
 */
export function conditionsProblem(conditions: DealConditions): string | null {
  const range = (r: Range | undefined, max: number) =>
    !r || (Number.isInteger(r[0]) && Number.isInteger(r[1]) && r[0] >= 0 && r[0] <= r[1] && r[1] <= max)
  for (const seat of SEATS) {
    const c = conditions.seats?.[seat]
    if (!c) continue
    if (!range(c.hcp, 37)) return `${seat}.hcp`
    for (const suit of SUITS) if (!range(c.lengths?.[suit], 13)) return `${seat}.lengths.${suit}`
    const lengths = SUITS.map((suit) => c.lengths?.[suit] ?? [0, 13])
    if (lengths.reduce((sum, r) => sum + r[0], 0) > 13 || lengths.reduce((sum, r) => sum + r[1], 0) < 13)
      return `${seat}.lengths`
  }
  for (const side of ['NS', 'EW'] as const) if (!range(conditions.sides?.[side]?.hcp, 40)) return `${side}.hcp`
  for (const suit of SUITS) {
    const least = SEATS.reduce((sum, seat) => sum + (conditions.seats?.[seat]?.lengths?.[suit]?.[0] ?? 0), 0)
    if (least > 13) return `lengths.${suit}`
  }
  return null
}

/** How many of `draws` cards land in a group of `group` out of `population` places, at random */
function hypergeometric(population: number, group: number, draws: number, random: RandomInt): number {
  let hits = 0
  for (let i = 0; i < draws; i++) {
    if (random(population - i) < group - hits) hits++
  }
  return hits
}

/** Each seat's length in each suit (seat × suit, in SEATS × SUITS order), drawn with the odds of a random deal */
function drawLengths(random: RandomInt): number[][] {
  const room = [13, 13, 13, 13]
  const lengths = SEATS.map(() => [0, 0, 0, 0])
  for (let s = 0; s < 4; s++) {
    let cards = 13
    let places = room.reduce((a, b) => a + b, 0)
    for (let seat = 0; seat < 4; seat++) {
      const got = seat === 3 ? cards : hypergeometric(places, room[seat], cards, random)
      lengths[seat][s] = got
      cards -= got
      places -= room[seat]
      room[seat] -= got
    }
  }
  return lengths
}

function lengthsFit(conditions: DealConditions, lengths: number[][]): boolean {
  return SEATS.every((seat, i) => {
    const c = conditions.seats?.[seat]
    if (!c) return true
    if (c.balanced && !BALANCED.has(shapeKey(lengths[i]))) return false
    return SUITS.every((suit, s) => within(lengths[i][s], c.lengths?.[suit]))
  })
}

function pointsFit(conditions: DealConditions, hands: Hands): boolean {
  const points = Object.fromEntries(SEATS.map((seat) => [seat, hcp(hands[seat])])) as Record<Seat, number>
  if (!SEATS.every((seat) => within(points[seat], conditions.seats?.[seat]?.hcp))) return false
  return (['NS', 'EW'] as const).every((side) => {
    const [a, b] = SIDE_SEATS[side]
    return within(points[a] + points[b], conditions.sides?.[side]?.hcp)
  })
}

/** Deals the cards of each suit to the seats in the given lengths */
function dealCards(lengths: number[][], random: RandomInt): Hands {
  const hands: Hands = { N: [], E: [], S: [], W: [] }
  SUITS.forEach((suit, s) => {
    const cards = [...RANKS].map((rank) => suit + rank)
    for (let i = cards.length - 1; i > 0; i--) {
      const j = random(i + 1)
      ;[cards[i], cards[j]] = [cards[j], cards[i]]
    }
    let next = 0
    SEATS.forEach((seat, i) => {
      hands[seat].push(...cards.slice(next, next + lengths[i][s]))
      next += lengths[i][s]
    })
  })
  for (const seat of SEATS) hands[seat] = sortHand(hands[seat])
  return hands
}

/** A deal meeting the conditions (or any one of a list of alternatives) */
export function dealWith(
  conditions: DealConditions | readonly DealConditions[],
  random: RandomInt,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
): DealResult {
  const alternatives = (Array.isArray(conditions) ? conditions : [conditions]) as readonly DealConditions[]
  const possible = alternatives.filter((c) => conditionsProblem(c) === null)
  if (!possible.length) return { ok: false, attempts: 0 }
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const lengths = drawLengths(random)
    const fitting = possible.filter((c) => lengthsFit(c, lengths))
    if (!fitting.length) continue
    const hands = dealCards(lengths, random)
    if (fitting.some((c) => pointsFit(c, hands))) return { ok: true, hands, attempts: attempt }
  }
  return { ok: false, attempts: maxAttempts }
}

/** Whether a deal meets the conditions; the tests and the practice table check deals with it */
export function meetsConditions(conditions: DealConditions | readonly DealConditions[], hands: Hands): boolean {
  const alternatives = (Array.isArray(conditions) ? conditions : [conditions]) as readonly DealConditions[]
  const lengths = SEATS.map((seat) => SUITS.map((suit) => hands[seat].filter((c) => c[0] === suit).length))
  return alternatives.some((c) => lengthsFit(c, lengths) && pointsFit(c, hands))
}
