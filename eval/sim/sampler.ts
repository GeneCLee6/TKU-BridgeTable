import type { RandomInt } from '../../shared/board.ts'
import { fullDeck, hcp, nextSeat, SEATS, SUITS, suitOf, type Card, type Seat, type Suit } from '../../shared/cards.ts'
import { remainingCards, tricksOf, type BoardState } from '../../shared/game.ts'
import type { RobotKind } from '../../shared/protocol.ts'
import { TableReading } from '../../shared/robot/reading.ts'
import type { Range } from '../../shared/robot/system/spec.ts'
import type { Position } from './dds.ts'

/**
 * Single dummy by sampling (eval/sim/README.md §2): what one seat can see, turned into layouts of
 * the cards it cannot see that agree with everything it knows. The knowledge is the robot's own
 * (`TableReading`, ROBOT.md §3.3): the hands in view, the cards played, the suits a seat showed
 * out of, and the lengths and points the auction showed, read with the robot's system. Nothing
 * here reads the hidden hands: the unseen cards are the deck less what is in view or played, and
 * the hidden hands are re-dealt by rejection sampling in the way of `shared/dealer.ts` (the suit
 * lengths drawn first, with their true odds, so most impossible layouts cost almost nothing).
 */

export interface SeatConstraint {
  seat: Seat
  /** Cards the seat still holds */
  count: number
  lengths: Record<Suit, Range>
  hcp: Range
}

export interface SamplingProblem {
  /** The cards the seat cannot see, to be shared among `seats` */
  unseen: Card[]
  seats: SeatConstraint[]
}

/** What a seat knows at a moment of the play, ready for the sampler and the solver */
export interface Knowledge {
  seat: Seat
  /** The hands this seat sees (its own, dummy's once exposed, the declarer's when playing dummy, a claimer's) */
  visible: Partial<Record<Seat, Card[]>>
  problem: SamplingProblem
  trump: Suit | null
  /** The current trick: who led it and the cards on the table */
  leader: Seat
  trick: Card[]
}

/** The seat's knowledge, from its own view only (the robot's reading of the table) */
export function knowledgeOf(state: BoardState, seat: Seat, kind: RobotKind): Knowledge {
  const reading = new TableReading(state, seat, kind)
  const unseenSeats = new Set(reading.unseen)
  const visible: Partial<Record<Seat, Card[]>> = {}
  const seen = new Set<Card>(state.play.map((p) => p.card))
  for (const s of SEATS) {
    if (unseenSeats.has(s)) continue
    visible[s] = remainingCards(state, s)
    for (const card of visible[s]) seen.add(card)
  }
  const unseen = fullDeck().filter((card) => !seen.has(card))
  const seats = reading.unseen.map((s) => ({
    seat: s,
    count: 13 - state.play.filter((p) => p.seat === s).length,
    lengths: Object.fromEntries(SUITS.map((suit) => [suit, reading.len(s, suit)])) as Record<Suit, Range>,
    hcp: reading.hcp(s),
  }))
  const current = tricksOf(state).at(-1)
  const open = current && !current.winner ? current : undefined
  const contract = state.contract!
  // The trick on the table, else the last winner leads, else the opening lead
  const leader = open ? open.leader : (current?.winner ?? nextSeat(contract.declarer))
  return {
    seat,
    visible,
    problem: { unseen, seats },
    trump: contract.strain === 'N' ? null : contract.strain,
    leader,
    trick: open ? open.cards.map((p) => p.card) : [],
  }
}

/** How many of `draws` cards land in a group of `group` out of `population` places, at random */
function hypergeometric(population: number, group: number, draws: number, random: RandomInt): number {
  let hits = 0
  for (let i = 0; i < draws; i++) if (random(population - i) < group - hits) hits++
  return hits
}

const within = (value: number, range: Range) => value >= range[0] && value <= range[1]

/**
 * One layout of the unseen cards that meets every constraint, or null after `maxAttempts`
 * draws. Each layout that fits is equally likely, as if random layouts were drawn until one fit.
 */
export function sampleLayout(problem: SamplingProblem, random: RandomInt, maxAttempts = 5000): { hands: Record<Seat, Card[]>; attempts: number } | null {
  const { seats } = problem
  const bySuit = SUITS.map((suit) => problem.unseen.filter((card) => suitOf(card) === suit))
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Suit lengths first, from their true odds; most layouts that cannot fit stop here
    const room = seats.map((s) => s.count)
    const lengths = seats.map(() => [0, 0, 0, 0])
    let fits = true
    for (let s = 0; s < 4 && fits; s++) {
      let cards = bySuit[s].length
      let places = room.reduce((a, b) => a + b, 0)
      for (let i = 0; i < seats.length; i++) {
        const got = i === seats.length - 1 ? cards : hypergeometric(places, room[i], cards, random)
        lengths[i][s] = got
        cards -= got
        places -= room[i]
        room[i] -= got
        if (!within(got, seats[i].lengths[SUITS[s]])) {
          fits = false
          break
        }
      }
    }
    if (!fits) continue
    const hands = {} as Record<Seat, Card[]>
    for (const s of seats) hands[s.seat] = []
    for (let s = 0; s < 4; s++) {
      const cards = [...bySuit[s]]
      for (let i = cards.length - 1; i > 0; i--) {
        const j = random(i + 1)
        ;[cards[i], cards[j]] = [cards[j], cards[i]]
      }
      let next = 0
      seats.forEach((seat, i) => {
        hands[seat.seat].push(...cards.slice(next, next + lengths[i][s]))
        next += lengths[i][s]
      })
    }
    if (seats.every((s) => within(hcp(hands[s.seat]), s.hcp))) return { hands, attempts: attempt }
  }
  return null
}

export interface Sampling {
  layouts: Record<Seat, Card[]>[]
  /** Layouts drawn, fitting or not: the acceptance rate is layouts / attempts */
  attempts: number
  /** How many layouts needed the constraints loosened (the auction's reading was too tight to meet) */
  relaxed: number
}

/** The constraints a step looser: a point either way, a card either way */
function relax(problem: SamplingProblem): SamplingProblem {
  const seats = problem.seats.map((s) => {
    const lengths = {} as Record<Suit, Range>
    for (const suit of SUITS) lengths[suit] = [Math.max(0, s.lengths[suit][0] - 1), Math.min(13, s.lengths[suit][1] + 1)]
    return { ...s, hcp: [Math.max(0, s.hcp[0] - 1), Math.min(40, s.hcp[1] + 1)] as Range, lengths }
  })
  return { ...problem, seats }
}

/**
 * `n` layouts. When the constraints cannot be met in `maxAttempts` draws (a reading that the cards
 * contradict), they are loosened a step at a time until a layout fits, and the layout is counted
 * as relaxed.
 */
export function sampleLayouts(problem: SamplingProblem, n: number, random: RandomInt, maxAttempts = 5000): Sampling {
  const sampling: Sampling = { layouts: [], attempts: 0, relaxed: 0 }
  while (sampling.layouts.length < n) {
    let current = problem
    let found = sampleLayout(current, random, maxAttempts)
    let loosened = false
    while (!found) {
      sampling.attempts += maxAttempts
      current = relax(current)
      loosened = true
      found = sampleLayout(current, random, maxAttempts)
    }
    sampling.attempts += found.attempts
    if (loosened) sampling.relaxed++
    sampling.layouts.push(found.hands)
  }
  return sampling
}

/** The position to solve for one layout: the hands in view plus the sampled hidden hands */
export function positionOf(knowledge: Knowledge, layout: Record<Seat, Card[]>): Position {
  const hands = {} as Record<Seat, readonly Card[]>
  for (const seat of SEATS) hands[seat] = knowledge.visible[seat] ?? layout[seat]
  return { trump: knowledge.trump, leader: knowledge.leader, trick: knowledge.trick, hands }
}
