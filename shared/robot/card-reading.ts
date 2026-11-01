import { partnerOf, rankOf, rankValue, RANKS, sameSide, SEATS, SUITS, suitOf, type Card, type Seat, type Suit } from '../cards.ts'
import { remainingCards, tricksOf, type BoardState } from '../game.ts'
import { clubLeadCard } from './lead-card.ts'
import type { Range } from './system/spec.ts'
import type { View } from './view.ts'

/**
 * Reading the cards (T3, ROBOT.md §3.16): what a robot can tell, card by card, about the two hands
 * it cannot see, from what it can see (its `View`: its own hand, the hand in view, the cards
 * played, the auction). On top of the auction and the count (`reading.ts`, §3.3):
 *
 * - **the opening lead**: the club leads "01 第 4" (`clubLeadCard`), so every holding the leader
 *   could have led that card from is listed, and those the later play rules out (cards the leader
 *   played, cards partner played, a show-out) are dropped. That is the rule of eleven and more:
 *   fourth best leaves exactly three cards above it, the second highest from no honour one, the
 *   top of a sequence the next card down
 * - **count signals**: a defender following the declaring side's lead without trying to win plays
 *   high then low with an even number (the club's count is standard; ROBOT.md §3.2), so both
 *   defenders' signals narrow their lengths (the Smith Echo trick in notrump is no count)
 * - **vacant places**: with the lengths known so far, a missing card is more likely in the hand
 *   with more room for it; the points shown in the auction (what is left of them) tilt it further
 *
 * Pure, and only from the `View`: never `state.hands` of an unseen seat. The declaring side uses
 * it for hold-ups, finesses and drop or finesse (`declarer.ts`, `play.ts`); a defender may read
 * the declarer and partner the same way.
 */

const HCP: Record<string, number> = { A: 4, K: 3, Q: 2, J: 1 }
const hcpOf = (card: Card) => HCP[rankOf(card)] ?? 0
const value = (card: Card) => rankValue(rankOf(card))
const byHigh = (a: Card, b: Card) => value(b) - value(a)

/** How much less likely a notrump spot-card lead is from three cards or fewer than from four or more */
const SHORT_LEAD = 0.15

const FACT: number[] = [1]
for (let i = 1; i <= 52; i++) FACT[i] = FACT[i - 1] * i
const choose = (n: number, k: number) => (k < 0 || n < 0 || k > n ? 0 : FACT[n] / (FACT[k] * FACT[n - k]))

/** A holding the opening leader may hold now in the suit led, and its weight (not normalised) */
export interface Holding {
  cards: Set<Card>
  weight: number
}

export class CardReading {
  private readonly view: View
  private readonly state: BoardState
  /** The two seats this robot cannot see (fewer after a claim) */
  readonly unseen: Seat[]
  private readonly leader: Seat | null
  private readonly leadSuit: Suit | null
  private leadHoldings: Holding[] | null | undefined
  private readonly dists = new Map<Suit, number[] | null>()
  private honours: Map<Card, number> | null | undefined
  /** Cards neither played nor in a hand in view */
  private readonly hidden = new Set<Card>()

  constructor(view: View) {
    this.view = view
    this.state = view.state
    this.unseen = view.reading.unseen
    const first = this.state.play[0]
    this.leader = first && this.unseen.includes(first.seat) ? first.seat : null
    this.leadSuit = this.leader ? suitOf(first.card) : null
    const seen = new Set(this.state.play.map((p) => p.card))
    for (const s of this.visibleSeats()) for (const c of remainingCards(this.state, s)) seen.add(c)
    for (const suit of SUITS) for (const r of RANKS) if (!seen.has(suit + r)) this.hidden.add(suit + r)
  }

  /** Cards of the suit the seat still holds as far as can be told (exact for a hand in view) */
  len(seat: Seat, suit: Suit): Range {
    if (!this.unseen.includes(seat)) return this.view.reading.len(seat, suit)
    const p = this.lengthOdds(seat, suit)
    if (!p) return this.view.reading.len(seat, suit)
    const ks = p.map((w, k) => (w > 0 ? k : -1)).filter((k) => k >= 0)
    return ks.length ? [ks[0], ks.at(-1)!] : this.view.reading.len(seat, suit)
  }

  /** The chance of each number of cards of the suit the seat still holds (index = cards) */
  lengthOdds(seat: Seat, suit: Suit): number[] | null {
    const d = this.dist(suit)
    if (!d) return null
    return seat === this.unseen[0] ? d : [...d].reverse()
  }

  /** The cards of the suit the seat is expected to hold */
  expected(seat: Seat, suit: Suit): number {
    const p = this.lengthOdds(seat, suit)
    if (!p) {
      const r = this.view.reading.len(seat, suit)
      return (r[0] + r[1]) / 2
    }
    return p.reduce((sum, w, k) => sum + w * k, 0)
  }

  /** The chance that the seat holds no card of the suit after playing `playing` more of it */
  exhausted(seat: Seat, suit: Suit, playing = 0): number {
    const p = this.lengthOdds(seat, suit)
    if (!p) return this.view.reading.len(seat, suit)[1] <= playing ? 1 : 0
    return p.reduce((sum, w, k) => sum + (k <= playing ? w : 0), 0)
  }

  /** The chance that each unseen seat holds a card this robot cannot see (0 for a card it sees) */
  odds(card: Card): Partial<Record<Seat, number>> {
    const out: Partial<Record<Seat, number>> = {}
    if (!this.isUnseen(card)) return out
    if (this.unseen.length === 1) return { [this.unseen[0]]: 1 }
    if (this.unseen.length !== 2) return out
    const [a, b] = this.unseen
    const suit = suitOf(card)
    let pa = this.lengthShare(a, card)
    // Points: an honour goes with the points each hand showed in the auction (less the honours
    // it played), weighed together with the other honours out (honourOdds)
    if (hcpOf(card) > 0) {
      const odds = this.honourOdds()
      if (odds) pa = odds.get(card) ?? pa
      else pa = this.midpointShare(a, b, card, pa)
    }
    if (this.view.reading.isVoid(a, suit)) pa = 0
    if (this.view.reading.isVoid(b, suit)) pa = 1
    out[a] = pa
    out[b] = 1 - pa
    return out
  }

  /**
   * The chance the first unseen hand holds each honour out: every way of sharing the honours
   * between the two hands, each honour where the lengths put it (`lengthShare`), kept when both
   * hands' points fit what they showed in the auction. Null with too many honours out to list
   */
  private honourOdds(): Map<Card, number> | null {
    if (this.honours !== undefined) return this.honours
    this.honours = null
    const [a, b] = this.unseen
    const cards = [...this.hidden].filter((c) => hcpOf(c) > 0)
    if (cards.length > 14) return null
    const share = cards.map((c) => this.lengthShare(a, c))
    const ra = this.view.reading.hcp(a)
    const rb = this.view.reading.hcp(b)
    const total = cards.reduce((n, c) => n + hcpOf(c), 0)
    const held = new Array<number>(cards.length).fill(0)
    let sum = 0
    for (let mask = 0; mask < 1 << cards.length; mask++) {
      let w = 1
      let points = 0
      for (let i = 0; i < cards.length; i++) {
        if (mask & (1 << i)) {
          w *= share[i]
          points += hcpOf(cards[i])
        } else w *= 1 - share[i]
        if (w === 0) break
      }
      if (w === 0 || points < ra[0] || points > ra[1] || total - points < rb[0] || total - points > rb[1]) continue
      sum += w
      for (let i = 0; i < cards.length; i++) if (mask & (1 << i)) held[i] += w
    }
    if (sum <= 0) return null
    this.honours = new Map(cards.map((c, i) => [c, held[i] / sum]))
    return this.honours
  }

  private midpointShare(a: Seat, b: Seat, card: Card, pa: number): number {
    const points = hcpOf(card)
    const ra = this.view.reading.hcp(a)
    const rb = this.view.reading.hcp(b)
    const total = this.unseenPoints()
    const can = (r: Range, other: Range) => r[1] >= points && other[0] <= total - points
    if (!can(ra, rb)) return 0
    if (!can(rb, ra)) return 1
    if (pa <= 0 || pa >= 1) return pa
    const ma = (ra[0] + ra[1]) / 2
    const mb = (rb[0] + rb[1]) / 2
    const share = ma + mb > 0 ? Math.min(0.85, Math.max(0.15, ma / (ma + mb))) : 0.5
    const odds = (pa / (1 - pa)) * (share / (1 - share))
    return odds / (1 + odds)
  }

  /** The seat that holds the card with at least the given chance, or null */
  holder(card: Card, least = 0.6): Seat | null {
    const odds = this.odds(card)
    for (const seat of this.unseen) if ((odds[seat] ?? 0) >= least) return seat
    return null
  }

  /**
   * The holdings the opening leader can still hold in the suit led, from the club's lead card
   * and the play since. Null when the robot is the leader or sees the leader's hand, or when no
   * holding fits (the leader did not lead the club's way)
   */
  leadOptions(): Holding[] | null {
    if (this.leadHoldings !== undefined) return this.leadHoldings
    this.leadHoldings = this.listLeadHoldings()
    return this.leadHoldings
  }

  /**
   * The defender whose cards in the suit would take tricks if they got the lead: the suit is
   * theirs (every card of it out is above every card of ours, and at least one is out), and the
   * defender is clearly the longer in it. Null when there is none or the reading cannot tell
   */
  danger(suit: Suit): Seat | null {
    if (this.unseen.length !== 2 || this.out(suit) === 0) return null
    const ours = [...this.ourCards(suit)].sort(byHigh)[0]
    const outCards = this.unseenCards(suit)
    if (ours && outCards.some((c) => value(c) < value(ours))) return null
    const [a, b] = this.unseen
    const ea = this.expected(a, suit)
    const eb = this.expected(b, suit)
    if (ea - eb >= 1) return a
    if (eb - ea >= 1) return b
    return null
  }

  /** Points left among the cards this robot cannot see */
  private unseenPoints(): number {
    let n = 0
    for (const suit of SUITS) for (const c of this.unseenCards(suit)) n += hcpOf(c)
    return n
  }

  /** Cards of the suit the robot cannot see */
  private unseenCards(suit: Suit): Card[] {
    return [...RANKS].map((r) => suit + r).filter((c) => this.isUnseen(c))
  }

  private isUnseen(card: Card): boolean {
    return this.hidden.has(card)
  }

  private visibleSeats(): Seat[] {
    return SEATS.filter((s) => !this.unseen.includes(s))
  }

  private ourCards(suit: Suit): Card[] {
    const side = [this.view.seat, partnerOf(this.view.seat)].filter((s) => !this.unseen.includes(s))
    return side.flatMap((s) => remainingCards(this.state, s)).filter((c) => suitOf(c) === suit)
  }

  private out(suit: Suit): number {
    return this.view.reading.out(suit)
  }

  private cardsLeft(seat: Seat): number {
    return 13 - this.state.play.filter((p) => p.seat === seat).length
  }

  private playedBy(seat: Seat, suit: Suit): Card[] {
    return this.state.play.filter((p) => p.seat === seat && suitOf(p.card) === suit).map((p) => p.card)
  }

  /** Places left in each unseen hand for a suit: its cards less those known to be of other suits */
  private vacant(seat: Seat, suit: Suit): number {
    let known = 0
    for (const s of SUITS) if (s !== suit) known += this.view.reading.len(seat, s)[0]
    return Math.max(0, this.cardsLeft(seat) - known)
  }

  /** Weight of one particular set of `k` cards of the suit (of `out`) in the first unseen hand */
  private setWeight(suit: Suit, k: number): number {
    const [a, b] = this.unseen
    const out = this.out(suit)
    return (choose(this.vacant(a, suit), k) * choose(this.vacant(b, suit), out - k)) / choose(out, k)
  }

  /** The chance the first unseen hand holds k of the suit's out cards, k = 0…out */
  private dist(suit: Suit): number[] | null {
    if (this.dists.has(suit)) return this.dists.get(suit)!
    const d = this.computeDist(suit)
    this.dists.set(suit, d)
    return d
  }

  private computeDist(suit: Suit): number[] | null {
    if (this.unseen.length !== 2) return null
    const [a, b] = this.unseen
    const out = this.out(suit)
    const ra = this.view.reading.len(a, suit)
    const rb = this.view.reading.len(b, suit)
    const fits = (k: number, strict: boolean) => {
      if (k < ra[0] || k > ra[1] || out - k < rb[0] || out - k > rb[1]) return false
      if (!strict) return true
      return this.parityFits(a, suit, k) && this.parityFits(b, suit, out - k)
    }
    const lead = suit === this.leadSuit ? this.leadOptions() : null
    for (const strict of [true, false]) {
      const w = new Array<number>(out + 1).fill(0)
      if (lead) {
        const aIsLeader = a === this.leader
        for (const h of lead) {
          const k = aIsLeader ? h.cards.size : out - h.cards.size
          if (k >= 0 && k <= out && fits(k, strict)) w[k] += h.weight
        }
      } else {
        for (let k = 0; k <= out; k++) if (fits(k, strict)) w[k] = choose(this.vacant(a, suit), k) * choose(this.vacant(b, suit), out - k)
      }
      const total = w.reduce((x, y) => x + y, 0)
      if (total > 0) return w.map((x) => x / total)
    }
    return null
  }

  /** The chance the seat (one of the two unseen) holds the card, from the lengths alone */
  private lengthShare(seat: Seat, card: Card): number {
    const suit = suitOf(card)
    const out = this.out(suit)
    if (out === 0) return 0
    const lead = suit === this.leadSuit ? this.leadOptions() : null
    if (lead) {
      let total = 0
      let holds = 0
      for (const h of lead) {
        if (!this.parityFits(this.leader!, suit, h.cards.size)) continue
        total += h.weight
        if (h.cards.has(card)) holds += h.weight
      }
      if (total > 0) {
        const p = holds / total
        return seat === this.leader ? p : 1 - p
      }
    }
    const p = this.lengthOdds(seat, suit)
    if (!p) return 0.5
    return p.reduce((sum, w, k) => sum + (w * k) / out, 0)
  }

  /** The count signal, if any, allows the seat to hold k cards of the suit now */
  private parityFits(seat: Seat, suit: Suit, k: number): boolean {
    const signal = this.countSignal(seat, suit)
    if (!signal) return true
    return (k + this.playedBy(seat, suit).length) % 2 === (signal === 'even' ? 0 : 1)
  }

  /**
   * A defender's count signal in a suit (the club's standard count, ROBOT.md §3.2): its first two
   * spot cards (below the jack) following the declaring side's lead without winning the trick,
   * from the suit's first round it played. High then low shows an even number of cards held at
   * the first of them, its first of the suit: the length it was dealt. Null for the declaring
   * side, or when not shown yet
   */
  countSignal(seat: Seat, suit: Suit): 'even' | 'odd' | null {
    const contract = this.state.contract
    if (!contract || sameSide(seat, contract.declarer)) return null
    const tricks = tricksOf(this.state)
    const opening = this.state.play[0] ? suitOf(this.state.play[0].card) : null
    const smith = contract.strain === 'N' ? tricks.slice(1).find((t) => sameSide(t.leader, contract.declarer)) : undefined
    const cards: Card[] = []
    for (const trick of tricks) {
      const mine = trick.cards.find((p) => p.seat === seat)
      if (!mine || suitOf(mine.card) !== suit) continue
      const led = suitOf(trick.cards[0].card)
      const signalling =
        led === suit &&
        sameSide(trick.leader, contract.declarer) &&
        trick.winner !== undefined &&
        trick.winner !== seat &&
        value(mine.card) < 11 &&
        !(trick === smith && suit !== opening)
      // Only from the first time it played the suit: a lead or a win in it first leaves no count
      if (!signalling) {
        if (!cards.length) return null
        break
      }
      cards.push(mine.card)
      if (cards.length === 2) break
    }
    if (cards.length < 2) return null
    return value(cards[0]) > value(cards[1]) ? 'even' : 'odd'
  }

  private listLeadHoldings(): Holding[] | null {
    const leader = this.leader
    const suit = this.leadSuit
    if (!leader || !suit || this.unseen.length !== 2) return null
    const contract = this.state.contract!
    const trump = contract.strain === 'N' ? null : contract.strain
    const led = this.state.play[0].card
    const other = this.unseen.find((s) => s !== leader)!
    // The leader's and partner's cards of the suit at the start: all but the hands in view
    const visible = this.visibleSeats()
    const seenAtStart = new Set<Card>()
    for (const s of visible) {
      for (const c of remainingCards(this.state, s)) seenAtStart.add(c)
      for (const c of this.playedBy(s, suit)) seenAtStart.add(c)
    }
    const pool = [...RANKS].map((r) => suit + r).filter((c) => !seenAtStart.has(c) && c !== led)
    if (pool.length > 12) return null
    const byLeader = new Set(this.playedBy(leader, suit))
    const byOther = new Set(this.playedBy(other, suit))
    const leaderVoid = this.view.reading.isVoid(leader, suit)
    const otherVoid = this.view.reading.isVoid(other, suit)
    const range = this.view.reading.len(leader, suit)
    const playedCount = byLeader.size
    const out = this.out(suit)
    const longest = trump === null && value(led) <= 9 && !this.view.reading.bid(other, suit)
    const list: Holding[] = []
    const fitting: Holding[] = []
    for (let mask = 0; mask < 1 << pool.length; mask++) {
      const cards = [led, ...pool.filter((_, i) => mask & (1 << i))].sort(byHigh)
      const held = new Set(cards)
      if ([...byLeader].some((c) => !held.has(c)) || [...byOther].some((c) => held.has(c))) continue
      if (leaderVoid && cards.length !== playedCount) continue
      if (otherVoid && pool.some((c) => !held.has(c) && !byOther.has(c))) continue
      if (clubLeadCard(cards, trump) !== led) continue
      const now = new Set(cards.filter((c) => !byLeader.has(c)))
      const k = now.size
      if (k > out) continue
      // In notrump a spot card leads the longest suit (ROBOT.md §3: partner's suit and sequences
      // aside), seldom one of three cards or fewer
      const short = longest && cards.length < 4 ? SHORT_LEAD : 1
      const holding = { cards: now, weight: this.leaderSetWeight(suit, k) * short }
      if (holding.weight <= 0) continue
      list.push(holding)
      if (k >= range[0] && k <= range[1]) fitting.push(holding)
    }
    const chosen = fitting.length ? fitting : list
    return chosen.length ? chosen : null
  }

  private leaderSetWeight(suit: Suit, k: number): number {
    const [a] = this.unseen
    return a === this.leader ? this.setWeight(suit, k) : this.setWeight(suit, this.out(suit) - k)
  }
}
