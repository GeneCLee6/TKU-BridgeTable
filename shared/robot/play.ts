import { isBid, strainOf } from '../auction.ts'
import {
  partnerOf,
  rankOf,
  rankValue,
  RANKS,
  sameSide,
  SUITS,
  suitOf,
  type Card,
  type Seat,
  type Suit,
} from '../cards.ts'
import { dummyOf, legalCards, remainingCards, tricksOf, type BoardState, type PlayedCard } from '../game.ts'
import { suitCards } from './hand.ts'

/**
 * A robot's card play from what it can legitimately see: its own hand, dummy once exposed (the
 * declarer also sees its own hand when playing dummy) and the cards already played. It follows
 * the usual club guidelines: lead top of a sequence or fourth best, second hand low, third hand
 * high, win as cheaply as possible, don't overtake partner, ruff when the opponents are winning,
 * discard from length. The declaring side draws trumps and cashes sure winners.
 */
export function chooseCard(state: BoardState, seat: Seat): Card {
  const legal = legalCards(state, seat)
  if (legal.length <= 1) return legal[0]
  const contract = state.contract!
  const trump: Suit | null = contract.strain === 'N' ? null : contract.strain
  const tricks = tricksOf(state)
  const current = tricks.at(-1)
  const trick = current && !current.winner ? current.cards : []
  const view = new View(state, seat)

  if (trick.length === 0) return lead(state, seat, view, legal, trump)

  const led = suitOf(trick[0].card)
  const best = winningCard(trick, trump)
  const partner = partnerOf(seat)
  const partnerWinning = best.seat === partner
  const lastToPlay = trick.length === 3
  const following = legal.filter((c) => suitOf(c) === led)
  const lowest = (cards: Card[]) => [...cards].sort(byRank)[0]

  const defending = !sameSide(seat, contract.declarer)
  // A card that signals rather than wins, from the club's methods (橋牌防守信號)
  const signal = (cards: Card[]) => (defending ? signalFollow(state, seat, trick, cards, trump) : lowest(cards))

  if (following.length) {
    if (partnerWinning && (lastToPlay || view.isMaster(best.card))) return signal(following)
    if (partnerWinning) {
      // Third hand high: protect partner's lead from the last player
      const top = [...following].sort(byRank).at(-1)!
      return rankValue(rankOf(top)) > rankValue(rankOf(best.card)) ? top : signal(following)
    }
    const trumped = trump !== null && suitOf(best.card) === trump && led !== trump
    if (trumped) return signal(following)
    const beaters = following.filter((c) => suitOf(best.card) === led && rankValue(rankOf(c)) > rankValue(rankOf(best.card)))
    if (trick.length === 1) {
      // Second hand low, but cover an honour
      const honour = rankValue(rankOf(trick[0].card)) >= 11
      return honour && beaters.length ? lowest(beaters) : signal(following)
    }
    return beaters.length ? lowest(beaters) : signal(following)
  }

  // Void in the suit led
  const trumps = trump ? legal.filter((c) => suitOf(c) === trump) : []
  const partnerSafe = partnerWinning && (lastToPlay || view.isMaster(best.card))
  if (trumps.length && !partnerSafe) {
    const highestTrump = trick.filter((p) => suitOf(p.card) === trump).map((p) => rankValue(rankOf(p.card)))
    const over = trumps.filter((c) => rankValue(rankOf(c)) > Math.max(0, ...highestTrump))
    if (over.length) return lowest(over)
  }
  return defending ? signalDiscard(view, legal, trump, led) : discard(view, legal, trump)
}

function lead(state: BoardState, seat: Seat, view: View, legal: Card[], trump: Suit | null): Card {
  const declarer = state.contract!.declarer
  const declaring = sameSide(seat, declarer)
  const hand = legal
  const nonTrump = SUITS.filter((s) => s !== trump && suitCards(hand, s).length)

  if (state.play.length === 0) return openingLead(state, seat, hand, trump)

  if (declaring) {
    // Draw trumps with a master trump while the opponents may still hold some
    if (trump && view.outstanding(trump) > 0) {
      const top = suitCards(hand, trump)[0]
      if (top && view.isMaster(top)) return top
    }
    for (const s of nonTrump) {
      const top = suitCards(hand, s)[0]
      if (view.isMaster(top)) return top
    }
    // Lead towards partner's winner
    const partnerHand = view.partnerCards()
    for (const s of nonTrump) {
      const theirTop = suitCards(partnerHand, s)[0]
      if (theirTop && view.isMaster(theirTop)) return suitCards(hand, s).at(-1)!
    }
  } else {
    for (const s of nonTrump) {
      const top = suitCards(hand, s)[0]
      if (view.isMaster(top) && state.play.length >= 4) return top
    }
    // Lead the suit partner asked for with a discard
    const wanted = partnerSignal(state, seat, trump)
    if (wanted && suitCards(hand, wanted).length) {
      const cards = suitCards(hand, wanted)
      return cards.length === 2 ? cards[0] : cards.at(-1)!
    }
    // Return partner's opening lead
    const first = state.play[0]
    if (first && first.seat === partnerOf(seat)) {
      const cards = suitCards(hand, suitOf(first.card))
      if (cards.length) return cards.length === 2 ? cards[0] : cards.at(-1)!
    }
  }
  const pool = nonTrump.length ? nonTrump : SUITS.filter((s) => suitCards(hand, s).length)
  const longestSuit = [...pool].sort((a, b) => suitCards(hand, b).length - suitCards(hand, a).length)[0]
  return fourthBest(suitCards(hand, longestSuit))
}

function openingLead(state: BoardState, seat: Seat, hand: Card[], trump: Suit | null): Card {
  // Partner's suit first
  const partnerBid = state.auction.find((c) => c.seat === partnerOf(seat) && isBid(c.call) && strainOf(c.call) !== 'N')
  if (partnerBid) {
    const cards = suitCards(hand, strainOf(partnerBid.call) as Suit)
    if (cards.length) {
      if (cards.length <= 2) return cards[0]
      const honour = cards.some((c) => 'AKQJ'.includes(rankOf(c)))
      return honour ? cards.at(-1)! : cards[0]
    }
  }
  const suits = SUITS.filter((s) => s !== trump && suitCards(hand, s).length)
  const pool = suits.length ? suits : SUITS.filter((s) => suitCards(hand, s).length)

  if (trump) {
    for (const s of pool) {
      const cards = suitCards(hand, s)
      if (cards.length >= 2 && rankOf(cards[0]) === 'A' && rankOf(cards[1]) === 'K') return cards[0]
    }
    const singleton = pool.find((s) => suitCards(hand, s).length === 1 && suitCards(hand, trump).length > 0)
    if (singleton) return suitCards(hand, singleton)[0]
  }
  for (const s of pool) {
    const seq = sequenceTop(suitCards(hand, s))
    if (seq) return seq
  }
  // Fourth best from the longest suit, avoiding leading away from an ace against a suit contract
  const ranked = [...pool].sort((a, b) => {
    const aceA = trump && rankOf(suitCards(hand, a)[0]) === 'A' ? 1 : 0
    const aceB = trump && rankOf(suitCards(hand, b)[0]) === 'A' ? 1 : 0
    return aceA - aceB || suitCards(hand, b).length - suitCards(hand, a).length
  })
  return fourthBest(suitCards(hand, ranked[0]))
}

/** KQ, QJ, JT or T9 at the top of a suit of three or more: lead the top card */
function sequenceTop(cards: Card[]): Card | null {
  if (cards.length < 3) return null
  const [a, b] = cards.map((c) => rankValue(rankOf(c)))
  return a - b === 1 && a >= 10 ? cards[0] : null
}

function fourthBest(cards: Card[]): Card {
  if (cards.length >= 4) return cards[3]
  if (cards.length === 2) return cards[0]
  return cards.at(-1)!
}

/** Throw the lowest card from the longest side suit, keeping winners and trumps */
function discard(view: View, legal: Card[], trump: Suit | null): Card {
  const candidates = legal.filter((c) => suitOf(c) !== trump && !view.isMaster(c))
  const pool = candidates.length ? candidates : legal.filter((c) => suitOf(c) !== trump)
  const from = pool.length ? pool : legal
  const length = (s: Suit) => from.filter((c) => suitOf(c) === s).length
  return [...from].sort((a, b) => length(suitOf(b)) - length(suitOf(a)) || byRank(a, b))[0]
}

function winningCard(trick: { seat: Seat; card: Card }[], trump: Suit | null) {
  let best = trick[0]
  for (const played of trick.slice(1)) {
    const same = suitOf(played.card) === suitOf(best.card)
    if (same ? rankValue(rankOf(played.card)) > rankValue(rankOf(best.card)) : suitOf(played.card) === trump && suitOf(best.card) !== trump)
      best = played
  }
  return best
}

const byRank = (a: Card, b: Card) => rankValue(rankOf(a)) - rankValue(rankOf(b))
const value = (card: Card) => rankValue(rankOf(card))
const HONOUR_POINTS: Record<string, number> = { A: 4, K: 3, Q: 2, J: 1 }
const honours = (cards: Card[]) => cards.reduce((sum, c) => sum + (HONOUR_POINTS[rankOf(c)] ?? 0), 0)
/** The highest card below the jack, so a signal never wastes an honour */
const highSpot = (cards: Card[]) => [...cards].sort(byRank).filter((c) => value(c) < 11).at(-1) ?? [...cards].sort(byRank)[0]

/**
 * Following suit without trying to win, as the club signals:
 * - partner's lead: attitude, reversed (小牌＝歡迎，大牌＝不歡迎); after partner leads a king,
 *   count instead (A、Q 看態度，K 看張數)
 * - declarer's lead: count, standard (先大後小＝偶數張); in notrump, the first suit declarer
 *   plays carries a Smith Echo about the opening lead instead (小牌＝歡迎首攻花色)
 */
function signalFollow(state: BoardState, seat: Seat, trick: PlayedCard[], cards: Card[], trump: Suit | null): Card {
  const low = [...cards].sort(byRank)[0]
  if (cards.length === 1) return low
  const leader = trick[0]
  const led = suitOf(leader.card)
  const hand = remainingCards(state, seat)
  if (leader.seat === partnerOf(seat)) {
    if (rankOf(leader.card) === 'K') return cards.length % 2 === 0 ? highSpot(cards) : low
    const like = cards.some((c) => 'AKQ'.includes(rankOf(c)))
    return like ? low : highSpot(cards)
  }
  const tricks = tricksOf(state)
  const firstDeclarerTrick = tricks.slice(1).find((t) => sameSide(t.leader, state.contract!.declarer))
  if (!trump && firstDeclarerTrick && firstDeclarerTrick === tricks.at(-1) && state.play[0]) {
    const opening = suitOf(state.play[0].card)
    if (opening !== led) {
      const mine = suitCards(hand, opening)
      const like = honours(mine) >= 2 || (state.play[0].seat === partnerOf(seat) && mine.length > 0 && mine.length <= 2)
      return like ? low : highSpot(cards)
    }
  }
  return cards.length % 2 === 0 ? highSpot(cards) : low
}

/**
 * Discards that signal, as the club plays them:
 * - trump contracts, odd/even (奇正偶轉): an odd card asks for that suit; an even card refuses
 *   it, high asking for the higher and low for the lower of the other two side suits
 * - notrump, full transfer (全轉換): high asks for the higher, low for the lower of the other two
 */
function signalDiscard(view: View, legal: Card[], trump: Suit | null, led: Suit): Card {
  const sideSuits = SUITS.filter((s) => s !== trump && s !== led && legal.some((c) => suitOf(c) === s))
  if (!sideSuits.length) return discard(view, legal, trump)
  const strength = (s: Suit) => honours(legal.filter((c) => suitOf(c) === s))
  const best = [...sideSuits].sort((a, b) => strength(b) - strength(a))[0]
  const want = strength(best) >= 3 ? best : null
  const spare = (s: Suit) => legal.filter((c) => suitOf(c) === s && !view.isMaster(c))

  if (trump && want) {
    const odd = spare(want).filter((c) => value(c) % 2 === 1 && value(c) < 11)
    if (odd.length && legal.filter((c) => suitOf(c) === want).length >= 3) return odd.sort(byRank)[0]
  }
  const throwFrom = sideSuits
    .filter((s) => s !== want)
    .sort((a, b) => strength(a) - strength(b) || spare(b).length - spare(a).length)[0]
  if (!throwFrom) return discard(view, legal, trump)
  const pool = spare(throwFrom).length ? spare(throwFrom) : legal.filter((c) => suitOf(c) === throwFrom)
  // The two suits a high or low card points to: not the discard suit, not trumps (or, in
  // notrump, not the suit led)
  const pointsTo = SUITS.filter((s) => s !== throwFrom && s !== (trump ?? led))
  const higher = pointsTo.length === 2 ? pointsTo[0] : null
  const askHigh = want !== null && want === higher
  const candidates = trump ? pool.filter((c) => value(c) % 2 === 0 && value(c) < 11) : pool.filter((c) => value(c) < 11)
  const sorted = (candidates.length ? candidates : pool).sort(byRank)
  return askHigh ? sorted.at(-1)! : sorted[0]
}

/** The suit partner asked for with their first discard, read with the club's methods */
function partnerSignal(state: BoardState, seat: Seat, trump: Suit | null): Suit | null {
  const partner = partnerOf(seat)
  for (const trick of tricksOf(state)) {
    const led = suitOf(trick.cards[0].card)
    const theirs = trick.cards.find((p) => p.seat === partner)
    if (!theirs || suitOf(theirs.card) === led || suitOf(theirs.card) === trump) continue
    const suit = suitOf(theirs.card)
    const v = value(theirs.card)
    if (trump && v % 2 === 1 && v < 11) return suit
    const pointsTo = SUITS.filter((s) => s !== suit && s !== (trump ?? led))
    if (pointsTo.length !== 2) return null
    // SUITS runs ♠ ♥ ♦ ♣, so the first is the higher ranking
    const high = trump ? v >= 6 : v >= 7
    return high ? pointsTo[0] : pointsTo[1]
  }
  return null
}

/** The cards a robot may take into account */
class View {
  private readonly state: BoardState
  private readonly seat: Seat
  private readonly played: Set<Card>
  private readonly known: Set<Card>

  constructor(state: BoardState, seat: Seat) {
    this.state = state
    this.seat = seat
    this.played = new Set(state.play.map((p) => p.card))
    this.known = new Set([...remainingCards(state, seat), ...this.partnerCards()])
  }

  /** Partner's cards if visible: dummy once exposed, or the declarer's hand when playing dummy */
  partnerCards(): Card[] {
    const dummy = dummyOf(this.state)
    const partner = partnerOf(this.seat)
    const visible = this.state.play.length > 0 && (partner === dummy || this.seat === dummy)
    return visible ? remainingCards(this.state, partner) : []
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

  /** Cards of a suit neither played nor visible to this robot */
  outstanding(suit: Suit): number {
    let n = 0
    for (const rank of RANKS) {
      const card = suit + rank
      if (!this.played.has(card) && !this.known.has(card)) n++
    }
    return n
  }
}
