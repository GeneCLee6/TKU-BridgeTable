import { fullDeck, partnerOf, rankOf, rankValue, sameSide, SEATS, SUITS, suitOf, type Card, type Seat, type Suit } from '../cards.ts'
import { dummyOf, remainingCards, tricksOf, type BoardState } from '../game.ts'
import type { RobotKind } from '../protocol.ts'
import { ROBOT_SYSTEMS } from './robots.ts'
import { read } from './system/infer.ts'
import type { Range, Spec } from './system/spec.ts'

/**
 * What a robot can tell, during the play, about the hands it cannot see (e6-t39, e6-t40): the
 * auction read with the system engine (what each seat's calls showed: HCP and suit lengths),
 * narrowed by counting the cards already played and the seats that did not follow suit. It uses
 * only the auction, the cards played and the hands this robot sees (its own, dummy once exposed,
 * the declarer's when playing dummy, a claimer's): never `state.hands` of another seat.
 */

const HCP: Record<string, number> = { A: 4, K: 3, Q: 2, J: 1 }
const hcpOf = (card: Card) => HCP[rankOf(card)] ?? 0
const ALL: Range = [0, 13]
const BALANCED: Range = [2, 5]

/** The auction read once per board and system: the play does not change it */
const auctions = new WeakMap<object, Partial<Record<RobotKind, Record<Seat, Spec>>>>()

function shownIn(state: BoardState, kind: RobotKind): Record<Seat, Spec> {
  const cached = auctions.get(state.auction) ?? {}
  if (!cached[kind]) {
    cached[kind] = read(ROBOT_SYSTEMS[kind], state.auction, state.dealer, state.vul).shown
    auctions.set(state.auction, cached)
  }
  return cached[kind]
}

export class TableReading {
  private readonly state: BoardState
  /** Seats whose remaining cards the robot sees */
  private readonly visible: Set<Seat>
  /** The other seats, whose cards are inferred */
  readonly unseen: Seat[]
  private readonly shown: Record<Seat, Spec>
  /** Seats that did not follow a suit led: they have none left */
  private readonly voids: Record<Seat, Set<Suit>>
  private readonly lengths = {} as Record<Seat, Record<Suit, Range>>
  private readonly points = {} as Record<Seat, Range>
  private readonly unseenCards = new Set<Card>()

  private readonly seat: Seat

  constructor(state: BoardState, seat: Seat, kind: RobotKind) {
    this.state = state
    this.seat = seat
    const dummy = dummyOf(state)
    this.visible = new Set<Seat>([seat, ...(state.claimed ?? [])])
    if (dummy && state.play.length > 0) {
      this.visible.add(dummy)
      if (seat === dummy) this.visible.add(state.contract!.declarer)
    }
    this.unseen = SEATS.filter((s) => !this.visible.has(s))
    this.shown = shownIn(state, kind)
    this.voids = { N: new Set(), E: new Set(), S: new Set(), W: new Set() }
    for (const trick of tricksOf(state)) {
      const led = suitOf(trick.cards[0].card)
      for (const p of trick.cards) if (suitOf(p.card) !== led) this.voids[p.seat].add(led)
    }
    // Whatever is neither played nor in view: worked out from the deck, never read from the hidden hands
    const seen = new Set<Card>(state.play.map((p) => p.card))
    for (const s of this.visible) for (const card of remainingCards(state, s)) seen.add(card)
    for (const card of fullDeck()) if (!seen.has(card)) this.unseenCards.add(card)
    for (const s of SEATS) if (this.visible.has(s)) this.lengths[s] = exactLengths(remainingCards(state, s))
    this.estimateLengths()
    this.estimatePoints()
  }

  /** Cards of a suit this robot cannot see (still held by the unseen seats) */
  out(suit: Suit): number {
    let n = 0
    for (const card of this.unseenCards) if (suitOf(card) === suit) n++
    return n
  }

  /** How many cards of a suit a seat still holds: exact for a hand in view, a range otherwise */
  len(seat: Seat, suit: Suit): Range {
    return this.lengths[seat][suit]
  }

  /** High-card points still in a seat's hand (exact for a hand in view) */
  hcp(seat: Seat): Range {
    return this.points[seat]
  }

  /** The seat has none of the suit left: it showed out, or the count says so */
  isVoid(seat: Seat, suit: Suit): boolean {
    return this.len(seat, suit)[1] === 0
  }

  /** The seat would ruff a lead of the suit: void in it with a trump left */
  mayRuff(seat: Seat, suit: Suit, trump: Suit | null): boolean {
    return trump !== null && suit !== trump && this.isVoid(seat, suit) && this.len(seat, trump)[1] > 0
  }

  /** The seat showed length in the suit in the auction (a natural bid: four cards or more) */
  bid(seat: Seat, suit: Suit): boolean {
    return (this.shown[seat].len?.[suit]?.[0] ?? 0) >= 4
  }

  /**
   * Who most likely holds a card this robot cannot see: the only unseen seat that can (the other
   * is void, or has too few points left); else the one that showed clearly more strength in the
   * auction; else the one with clearly more cards in the suit; null when the reading cannot tell
   */
  holder(card: Card): Seat | null {
    if (!this.unseenCards.has(card)) return null
    const suit = suitOf(card)
    const can = this.unseen.filter((s) => this.len(s, suit)[1] > 0 && this.hcp(s)[1] >= hcpOf(card))
    if (can.length <= 1) return can[0] ?? null
    const clear = (score: (s: Seat) => number, margin: number) => {
      const sorted = [...can].sort((a, b) => score(b) - score(a))
      return score(sorted[0]) - score(sorted[1]) >= margin ? sorted[0] : null
    }
    if (hcpOf(card) > 0) {
      const strength = clear((s) => mid(this.hcp(s)), 3)
      if (strength) return strength
    }
    return clear((s) => mid(this.len(s, suit)), 2)
  }

  /** Each unseen seat's suit lengths: shown in the auction, less what it played, fitted to the count */
  private estimateLengths() {
    for (const seat of this.unseen) {
      const left = 13 - this.state.play.filter((p) => p.seat === seat).length
      const row = {} as Record<Suit, Range>
      for (const suit of SUITS) {
        const played = this.state.play.filter((p) => p.seat === seat && suitOf(p.card) === suit).length
        // A balanced hand (1NT, 2NT…) holds two to five of every suit even when the rule says no lengths
        const shown = this.shown[seat].len?.[suit] ?? (this.shown[seat].balanced ? BALANCED : ALL)
        const cap = Math.min(left, this.out(suit))
        let range: Range = [Math.max(0, shown[0] - played), Math.min(cap, shown[1] - played)]
        // The auction was wrong about this suit (a misbid or a psych): go by the count alone
        if (range[0] > range[1]) range = [0, cap]
        row[suit] = this.voids[seat].has(suit) ? [0, 0] : parity(range, this.countSignal(seat, suit), played)
      }
      this.lengths[seat] = row
    }
    for (const suit of SUITS) this.share(this.out(suit), (s) => this.lengths[s][suit], (s, r) => (this.lengths[s][suit] = r))
  }

  /**
   * A defender's count signal, read by partner (e6-t42): following the declaring side's lead
   * without trying to win, high then low shows an even number, low then high an odd number (the
   * club's count is standard). 'even' or 'odd' for the original length, null
   * when partner has not shown it yet. The club's Smith Echo trick in notrump is not a count.
   */
  countSignal(seat: Seat, suit: Suit): 'even' | 'odd' | null {
    const contract = this.state.contract
    if (!contract || seat !== partnerOf(this.seat) || sameSide(seat, contract.declarer)) return null
    const tricks = tricksOf(this.state)
    const smith = contract.strain === 'N' ? tricks.slice(1).find((t) => sameSide(t.leader, contract.declarer)) : undefined
    const cards: Card[] = []
    for (const trick of tricks) {
      if (trick === smith || !sameSide(trick.leader, contract.declarer) || suitOf(trick.cards[0].card) !== suit) continue
      const theirs = trick.cards.find((p) => p.seat === seat)
      if (!theirs || suitOf(theirs.card) !== suit || trick.winner === seat) continue
      cards.push(theirs.card)
    }
    if (cards.length < 2) return null
    return rankValue(rankOf(cards[0])) > rankValue(rankOf(cards[1])) ? 'even' : 'odd'
  }

  /** Each unseen seat's points: shown in the auction less the honours it played, fitted to the count */
  private estimatePoints() {
    for (const seat of this.visible) this.points[seat] = exactPoints(remainingCards(this.state, seat))
    let total = 0
    for (const card of this.unseenCards) total += hcpOf(card)
    for (const seat of this.unseen) {
      const played = this.state.play.filter((p) => p.seat === seat).reduce((n, p) => n + hcpOf(p.card), 0)
      const shown = this.shown[seat].hcp ?? [0, 40]
      const range: Range = [Math.max(0, shown[0] - played), Math.min(total, shown[1] - played)]
      this.points[seat] = range[0] > range[1] ? [0, total] : range
    }
    this.share(total, (s) => this.points[s], (s, r) => (this.points[s] = r))
  }

  /**
   * The unseen seats hold `total` between them: each holds at least what the others cannot, and at
   * most what the others leave. When the auction cannot be right, the count alone decides.
   */
  private share(total: number, get: (s: Seat) => Range, set: (s: Seat, r: Range) => void) {
    for (let round = 0; round < 2; round++) {
      for (const seat of this.unseen) {
        const others = this.unseen.filter((s) => s !== seat)
        const othersMax = others.reduce((n, s) => n + get(s)[1], 0)
        const othersMin = others.reduce((n, s) => n + get(s)[0], 0)
        const [lo, hi] = get(seat)
        const range: Range = [Math.max(lo, total - othersMax), Math.min(hi, total - othersMin)]
        set(seat, range[0] <= range[1] ? range : [Math.max(0, total - othersMax), Math.max(0, total - othersMin)])
      }
    }
  }
}

const mid = (r: Range) => (r[0] + r[1]) / 2

/** Narrow the cards left in a suit to those that fit the length partner signalled */
function parity(range: Range, signal: 'even' | 'odd' | null, played: number): Range {
  if (!signal) return range
  const want = signal === 'even' ? 0 : 1
  const fits = (n: number) => (n + played) % 2 === want
  const lo = fits(range[0]) ? range[0] : range[0] + 1
  const hi = fits(range[1]) ? range[1] : range[1] - 1
  return lo <= hi ? [lo, hi] : range
}

function exactLengths(cards: Card[]): Record<Suit, Range> {
  const row = {} as Record<Suit, Range>
  for (const suit of SUITS) {
    const n = cards.filter((c) => suitOf(c) === suit).length
    row[suit] = [n, n]
  }
  return row
}

function exactPoints(cards: Card[]): Range {
  const n = cards.reduce((sum, c) => sum + hcpOf(c), 0)
  return [n, n]
}
