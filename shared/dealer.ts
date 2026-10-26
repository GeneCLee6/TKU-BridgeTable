import type { RandomInt } from './board.ts'
import { hcp, isCard, RANKS, SEATS, sortHand, suitOf, SUITS, type Card, type Hands, type Seat, type Side, type Suit } from './cards.ts'

/**
 * Deals that meet conditions (AC-10.1): points, suit lengths, balanced shape, shapes (5-3-3-2), the
 * longest and the shortest suit, or the whole hand, for any seat (`e10-t16`), and points for a
 * side. A condition can also be a list of alternatives, any of which will do (a five-card major:
 * five spades, or five hearts).
 *
 * Every deal that meets the conditions is equally likely, as if random deals were drawn until one
 * fits. To get there faster, each attempt first draws how many cards of each suit every seat gets
 * (from their true odds) and stops early when those lengths cannot fit; only then are the cards
 * themselves dealt within each suit and the points checked. A seat given its whole hand keeps it,
 * and the others are dealt the rest the same way. After `maxAttempts` it gives up and says so,
 * rather than running on.
 */

export type Range = readonly [min: number, max: number]

export interface SeatConditions {
  /** High-card points (A 4, K 3, Q 2, J 1) */
  hcp?: Range
  lengths?: Partial<Record<Suit, Range>>
  /** 4-3-3-3, 4-4-3-2 or 5-3-3-2 */
  balanced?: boolean
  /** Any of these shapes: the four lengths longest first, whichever the suits (`5332`, `4441`) */
  shapes?: readonly string[]
  /** How long the longest suit is, whichever it is: [5, 13] is a five-card suit or longer */
  longest?: Range
  /** How long the shortest suit is: [0, 1] is a singleton or a void */
  shortest?: Range
  /**
   * This very hand, 13 cards (`e10-t16`): the seat is dealt it as it is and the other seats get the
   * rest; any other condition of the seat must hold for it
   */
  hand?: readonly Card[]
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
/** A shape as `shapes` writes it: longest first */
const shapeOf = (lengths: readonly number[]) => [...lengths].sort((a, b) => b - a).join('')
const within = (value: number, range: Range | undefined) => !range || (value >= range[0] && value <= range[1])
const SIDE_SEATS: Record<Side, [Seat, Seat]> = { NS: ['N', 'S'], EW: ['E', 'W'] }
const suitLengths = (cards: readonly Card[]) => SUITS.map((suit) => cards.filter((c) => suitOf(c) === suit).length)

/** Every shape a hand can have (39 of them), longest first */
export const ALL_SHAPES: readonly string[] = (() => {
  const shapes: string[] = []
  for (let a = 13; a >= 0; a--)
    for (let b = Math.min(a, 13 - a); b >= 0; b--)
      for (let c = Math.min(b, 13 - a - b); c >= 0; c--) {
        const d = 13 - a - b - c
        if (d <= c) shapes.push(`${a}${b}${c}${d}`)
      }
  return shapes
})()

/** A shape as `shapes` writes it: four lengths, longest first, 13 cards */
export const isShape = (shape: unknown): shape is string => typeof shape === 'string' && ALL_SHAPES.includes(shape)

/** Whether a seat's actual suit lengths (♠ ♥ ♦ ♣) meet its conditions */
function seatFits(c: SeatConditions, lengths: readonly number[]): boolean {
  if (c.balanced && !BALANCED.has(shapeKey([...lengths]))) return false
  if (c.shapes && !c.shapes.includes(shapeOf(lengths))) return false
  if (c.longest && !within(Math.max(...lengths), c.longest)) return false
  if (c.shortest && !within(Math.min(...lengths), c.shortest)) return false
  const wanted = c.lengths
  return !wanted || SUITS.every((suit, s) => within(lengths[s], wanted[suit]))
}

/** Whether a seat could have this shape (in some order of the suits) and meet its conditions */
function shapePossible(c: SeatConditions, shape: string): boolean {
  const pattern = [...shape].map(Number)
  const go = (s: number, left: number[]): boolean =>
    s === 4
      ? true
      : left.some((n, i) => within(n, c.lengths?.[SUITS[s]]) && go(s + 1, [...left.slice(0, i), ...left.slice(i + 1)]))
  return seatFits({ ...c, lengths: undefined }, pattern) && go(0, pattern)
}

/**
 * What is wrong with some conditions, or null if they could be met: a range upside down or out of
 * bounds, lengths or shapes no hand can have together, a hand given that is not 13 different cards
 * or does not meet its own seat's conditions, a card given to two seats, or points that cannot add
 * up to the 40 in the pack. The answer says where: `S.hcp`, `N.lengths`, `E.shape`, `W.hand`,
 * `lengths.C` (a suit), `hands`, `hcp` (the four seats), `NS.hcp` (a side)
 */
export function conditionsProblem(conditions: DealConditions): string | null {
  const range = (r: Range | undefined, max: number) =>
    !r || (Number.isInteger(r[0]) && Number.isInteger(r[1]) && r[0] >= 0 && r[0] <= r[1] && r[1] <= max)
  const given = new Set<Card>()
  for (const seat of SEATS) {
    const c = conditions.seats?.[seat]
    if (!c) continue
    if (!range(c.hcp, 37)) return `${seat}.hcp`
    for (const suit of SUITS) if (!range(c.lengths?.[suit], 13)) return `${seat}.lengths`
    const lengths = SUITS.map((suit) => c.lengths?.[suit] ?? [0, 13])
    if (lengths.reduce((sum, r) => sum + r[0], 0) > 13 || lengths.reduce((sum, r) => sum + r[1], 0) < 13)
      return `${seat}.lengths`
    if (c.shapes !== undefined && (!c.shapes.length || !c.shapes.every(isShape))) return `${seat}.shape`
    if (!range(c.longest, 13) || !range(c.shortest, 13)) return `${seat}.shape`
    // Balanced with a void, a 5-3-3-2 with a six-card suit: no hand at all is both
    if (!ALL_SHAPES.some((shape) => shapePossible(c, shape))) return `${seat}.shape`
    if (c.hand !== undefined) {
      if (c.hand.length !== 13 || !c.hand.every(isCard) || new Set(c.hand).size !== 13) return `${seat}.hand`
      if (!seatFits(c, suitLengths(c.hand)) || !within(hcp(c.hand), c.hcp)) return `${seat}.hand`
      for (const card of c.hand) {
        if (given.has(card)) return 'hands'
        given.add(card)
      }
    }
  }
  for (const side of ['NS', 'EW'] as const) if (!range(conditions.sides?.[side]?.hcp, 40)) return `${side}.hcp`
  for (const suit of SUITS) {
    const least = SEATS.reduce((sum, seat) => {
      const c = conditions.seats?.[seat]
      return sum + (c?.hand ? c.hand.filter((card) => suitOf(card) === suit).length : (c?.lengths?.[suit]?.[0] ?? 0))
    }, 0)
    if (least > 13) return `lengths.${suit}`
  }
  // The four hands hold 40 points between them: the seats' and the sides' points must leave room for that
  const points = (seat: Seat): Range => {
    const c = conditions.seats?.[seat]
    return c?.hand ? [hcp(c.hand), hcp(c.hand)] : (c?.hcp ?? [0, 37])
  }
  const sum = (seats: readonly Seat[]): [number, number] =>
    seats.reduce<[number, number]>((t, seat) => [t[0] + points(seat)[0], t[1] + points(seat)[1]], [0, 0])
  const all = sum(SEATS)
  if (all[0] > 40 || all[1] < 40) return 'hcp'
  for (const side of ['NS', 'EW'] as const) {
    const wanted = conditions.sides?.[side]?.hcp
    if (!wanted) continue
    const own = sum(SIDE_SEATS[side])
    const other = sum(SIDE_SEATS[side === 'NS' ? 'EW' : 'NS'])
    if (wanted[0] > own[1] || wanted[1] < own[0] || 40 - wanted[1] > other[1] || 40 - wanted[0] < other[0]) return `${side}.hcp`
  }
  const ns = conditions.sides?.NS?.hcp
  const ew = conditions.sides?.EW?.hcp
  if (ns && ew && (ns[0] + ew[0] > 40 || ns[1] + ew[1] < 40)) return 'hcp'
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

/** The hands some conditions give, by seat (SEATS order); null for a seat to be dealt */
const givenHands = (conditions: DealConditions) => SEATS.map((seat) => conditions.seats?.[seat]?.hand ?? null)
const NOTHING_GIVEN: readonly null[] = [null, null, null, null]

/**
 * Each seat's length in each suit (seat × suit, in SEATS × SUITS order), drawn with the odds of a
 * random deal of the cards no seat was given; a seat given its hand has that hand's lengths
 */
function drawLengths(random: RandomInt, given: readonly (readonly Card[] | null)[] = NOTHING_GIVEN): number[][] {
  // The usual case, every attempt: nobody was given a hand
  if (given === NOTHING_GIVEN) return drawAllLengths(random)
  const fixed = given.map((hand) => (hand ? suitLengths(hand) : null))
  const room = fixed.map((f): number => (f ? 0 : 13))
  const lengths = fixed.map((f) => (f ? [...f] : [0, 0, 0, 0]))
  const free = SEATS.flatMap((_, i) => (fixed[i] ? [] : [i]))
  for (let s = 0; s < 4; s++) {
    let cards = 13 - fixed.reduce((sum, f) => sum + (f ? f[s] : 0), 0)
    let places = room.reduce((a, b) => a + b, 0)
    for (const [k, seat] of free.entries()) {
      const got = k === free.length - 1 ? cards : hypergeometric(places, room[seat], cards, random)
      lengths[seat][s] = got
      cards -= got
      places -= room[seat]
      room[seat] -= got
    }
  }
  return lengths
}

/** drawLengths when no seat was given its hand: the whole pack */
function drawAllLengths(random: RandomInt): number[][] {
  const room = [13, 13, 13, 13]
  const lengths = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]
  for (let s = 0; s < 4; s++) {
    let cards = 13
    let places = room[0] + room[1] + room[2] + room[3]
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
    return !c || seatFits(c, lengths[i])
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

/** Deals the cards of each suit no seat was given to the other seats, in the given lengths */
function dealCards(lengths: number[][], random: RandomInt, given: readonly (readonly Card[] | null)[] = NOTHING_GIVEN): Hands {
  const hands: Hands = { N: [], E: [], S: [], W: [] }
  const taken = given === NOTHING_GIVEN ? null : new Set(given.flatMap((hand) => hand ?? []))
  SUITS.forEach((suit, s) => {
    const all = [...RANKS].map((rank) => suit + rank)
    const cards = taken ? all.filter((card) => !taken.has(card)) : all
    for (let i = cards.length - 1; i > 0; i--) {
      const j = random(i + 1)
      ;[cards[i], cards[j]] = [cards[j], cards[i]]
    }
    let next = 0
    SEATS.forEach((seat, i) => {
      if (given[i]) return
      hands[seat].push(...cards.slice(next, next + lengths[i][s]))
      next += lengths[i][s]
    })
  })
  SEATS.forEach((seat, i) => {
    hands[seat] = sortHand(given[i] ?? hands[seat])
  })
  return hands
}

/**
 * A deal meeting the conditions (or any one of a list of alternatives). Alternatives that give a
 * seat its hand are tried one an attempt, in turn, since each deals the rest of a different pack
 */
export function dealWith(
  conditions: DealConditions | readonly DealConditions[],
  random: RandomInt,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
): DealResult {
  const alternatives = (Array.isArray(conditions) ? conditions : [conditions]) as readonly DealConditions[]
  const possible = alternatives.filter((c) => conditionsProblem(c) === null)
  if (!possible.length) return { ok: false, attempts: 0 }
  const giving = possible.filter((c) => givenHands(c).some(Boolean))
  const dealt = possible.filter((c) => !giving.includes(c))
  const rounds = [...(dealt.length ? [null] : []), ...giving]
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const round = rounds[attempt % rounds.length]
    const given = round ? givenHands(round) : NOTHING_GIVEN
    const lengths = drawLengths(random, given)
    const fitting = (round ? [round] : dealt).filter((c) => lengthsFit(c, lengths))
    if (!fitting.length) continue
    const hands = dealCards(lengths, random, given)
    if (fitting.some((c) => pointsFit(c, hands))) return { ok: true, hands, attempts: attempt }
  }
  return { ok: false, attempts: maxAttempts }
}

/** Whether a deal meets the conditions; the tests and the practice table check deals with it */
export function meetsConditions(conditions: DealConditions | readonly DealConditions[], hands: Hands): boolean {
  const alternatives = (Array.isArray(conditions) ? conditions : [conditions]) as readonly DealConditions[]
  const lengths = SEATS.map((seat) => suitLengths(hands[seat]))
  const handsFit = (c: DealConditions) =>
    SEATS.every((seat) => {
      const hand = c.seats?.[seat]?.hand
      return !hand || (hand.length === hands[seat].length && hand.every((card) => hands[seat].includes(card)))
    })
  return alternatives.some((c) => handsFit(c) && lengthsFit(c, lengths) && pointsFit(c, hands))
}
