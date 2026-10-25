import { partnerOf, rankOf, rankValue, RANKS, sameSide, suitOf, type Card, type Seat, type Suit } from '../cards.ts'
import { dummyOf, remainingCards, tricksOf, tricksWon, type BoardState } from '../game.ts'
import type { RobotKind } from '../protocol.ts'
import { suitCards } from './hand.ts'
import { TableReading } from './reading.ts'

export const byRank = (a: Card, b: Card) => rankValue(rankOf(a)) - rankValue(rankOf(b))
export const value = (card: Card) => rankValue(rankOf(card))
const HONOUR_POINTS: Record<string, number> = { A: 4, K: 3, Q: 2, J: 1 }
export const honours = (cards: Card[]) => cards.reduce((sum, c) => sum + (HONOUR_POINTS[rankOf(c)] ?? 0), 0)

/** The cards a robot may take into account */
export class View {
  readonly state: BoardState
  readonly seat: Seat
  private readonly kind: RobotKind
  private readonly played: Set<Card>
  private readonly known: Set<Card>
  private table: TableReading | null = null

  constructor(state: BoardState, seat: Seat, kind: RobotKind) {
    this.state = state
    this.seat = seat
    this.kind = kind
    this.played = new Set(state.play.map((p) => p.card))
    this.known = new Set([...remainingCards(state, seat), ...this.partnerCards()])
  }

  /** This robot's own remaining cards */
  ownCards(): Card[] {
    return remainingCards(this.state, this.seat)
  }

  /** Partner's cards if visible: dummy once exposed, or the declarer's hand when playing dummy */
  partnerCards(): Card[] {
    const dummy = dummyOf(this.state)
    const partner = partnerOf(this.seat)
    const visible = this.state.play.length > 0 && (partner === dummy || this.seat === dummy)
    return visible ? remainingCards(this.state, partner) : []
  }

  /** Dummy's remaining cards once exposed (empty before the opening lead) */
  dummyCards(): Card[] {
    const dummy = dummyOf(this.state)
    return dummy && this.state.play.length > 0 ? remainingCards(this.state, dummy) : []
  }

  /** No higher card of the suit is still out among cards this robot cannot see */
  isMaster(card: Card): boolean {
    const suit = suitOf(card)
    for (const rank of RANKS) {
      if (rank === rankOf(card)) return true
      const higher = suit + rank
      if (!this.played.has(higher) && !this.known.has(higher)) return false
    }
    return true
  }

  /** The lowest of `own` cards equal to `card`: every rank between them is already played */
  lowestEqual(card: Card, own: Card[]): Card {
    const suit = suitOf(card)
    let lowest = card
    for (const rank of RANKS.slice(RANKS.indexOf(rankOf(card)) + 1)) {
      const next = suit + rank
      if (own.includes(next)) lowest = next
      else if (!this.played.has(next)) break
    }
    return lowest
  }

  /** The other hands as the auction and the count describe them (worked out when first asked) */
  get reading(): TableReading {
    this.table ??= new TableReading(this.state, this.seat, this.kind)
    return this.table
  }

  /** Cards of the suit above `card` still out (neither played nor on our side) */
  higherOut(card: Card): Card[] {
    const suit = suitOf(card)
    const out: Card[] = []
    for (const rank of RANKS.slice(0, RANKS.indexOf(rankOf(card)))) {
      const higher = suit + rank
      if (!this.played.has(higher) && !this.known.has(higher)) out.push(higher)
    }
    return out
  }

  /** Cards of a suit neither played nor visible to this robot */
  outstanding(suit: Suit): number {
    let n = 0
    for (const rank of RANKS) {
      const card = suit + rank
      if (!this.played.has(card) && !this.known.has(card)) n++
    }
    return n
  }

  /**
   * Sure tricks in a suit for the hands in view (own and partner's): the masters held between
   * them, one after another from the top, and no more than the longer holding
   */
  topTricks(suit: Suit): number {
    const mine = suitCards(this.ownCards(), suit)
    const theirs = suitCards(this.partnerCards(), suit)
    const ours = new Set([...mine, ...theirs])
    let n = 0
    for (const rank of RANKS) {
      const card = suit + rank
      if (this.played.has(card)) continue
      if (!ours.has(card)) break
      n++
    }
    return Math.min(n, Math.max(mine.length, theirs.length))
  }

  /** Tricks this robot's side still needs: to make the contract, or to defeat it */
  needed(): number {
    const contract = this.state.contract!
    const won = tricksWon(this.state)[this.seat === 'N' || this.seat === 'S' ? 'NS' : 'EW']
    const target = sameSide(this.seat, contract.declarer) ? 6 + contract.level : 8 - contract.level
    return target - won
  }

  /** How many times the suit was led in finished tricks */
  timesLed(suit: Suit): number {
    return tricksOf(this.state).filter((t) => t.winner && suitOf(t.cards[0].card) === suit).length
  }
}

