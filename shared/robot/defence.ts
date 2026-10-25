import { nextSeat, partnerOf, rankOf, RANKS, SUITS, suitOf, type Card, type Suit } from '../cards.ts'
import { dummyOf, type PlayedCard } from '../game.ts'
import { suitCards } from './hand.ts'
import { byRank, value, type View } from './view.ts'

/**
 * Defending from inferences (e6-t42, ROBOT.md §3.5): the declarer's shape from the auction and
 * partner's count signals (`reading.ts`) decides when to take a winner and when to hold it up;
 * dummy's cards decide whether to attack (lead through dummy's honours, towards partner's suit)
 * or sit tight (a sequence, a suit with nothing to lose, a trump against dummy's ruffs).
 */

/** The defender's lead when there is nothing to cash, no signal to follow and no lead to return */
export function defenceLead(view: View, hand: Card[], trump: Suit | null, ruffed: (s: Suit) => boolean): Card | null {
  const state = view.state
  const dummy = dummyOf(state)!
  const declarer = state.contract!.declarer
  const partner = partnerOf(view.seat)
  const dummyCards = view.dummyCards()
  const throughDummy = nextSeat(view.seat) === dummy
  const suits = SUITS.filter((s) => suitCards(hand, s).length && (s !== trump || trumpLead(view, hand, trump, dummyCards)))
  if (!suits.length) return null

  const score = (s: Suit) => {
    const mine = suitCards(hand, s)
    const theirs = suitCards(dummyCards, s)
    let n = 0
    if (ruffed(s)) n -= 10
    if (view.reading.bid(declarer, s) || view.reading.bid(dummy, s)) n -= 3
    if (view.reading.bid(partner, s)) n += 3
    const seq = sequence(view, mine)
    if (seq) n += 3
    // Leading away from a lone honour gives a trick away
    else if (mine.some((c) => value(c) >= 11 && !view.isMaster(c))) n -= 3
    const dummyHonour = theirs.some((c) => value(c) >= 11 && !view.isMaster(c))
    if (throughDummy) {
      // Dummy plays next: lead through its honours, partner sits over them
      if (dummyHonour) n += 2
    } else if (dummyHonour) n -= 2
    else if (theirs.length && !theirs.some((c) => value(c) >= 10)) n += 1
    if (s === trump) n += 2
    if (state.play[0].seat === partner && suitOf(state.play[0].card) === s) n += 4
    return n
  }
  const best = [...suits].sort((a, b) => score(b) - score(a) || suitCards(hand, b).length - suitCards(hand, a).length)[0]
  const cards = suitCards(hand, best)
  const seq = sequence(view, cards)
  if (seq) return seq
  if (cards.length <= 2) return cards[0]
  return cards.some((c) => value(c) >= 11) ? (cards[3] ?? cards.at(-1)!) : cards[0]
}

/**
 * A trump lead is worth considering against dummy's ruffs: dummy has a short side suit and
 * trumps, and the lead costs nothing (no trump honour of ours to lose)
 */
function trumpLead(view: View, hand: Card[], trump: Suit, dummyCards: Card[]): boolean {
  const mine = suitCards(hand, trump)
  if (mine.length < 2 || !suitCards(dummyCards, trump).length) return false
  if (mine.some((c) => value(c) >= 11 && !view.isMaster(c))) return false
  return SUITS.some((s) => s !== trump && suitCards(dummyCards, s).length <= 1)
}

/** The top of two or more touching cards at the head of the holding (KQ, QJ, JT, AK) */
function sequence(view: View, cards: Card[]): Card | null {
  if (cards.length < 2 || value(cards[0]) < 10) return null
  return view.lowestEqual(cards[0], cards) !== cards[0] ? cards[0] : null
}

/**
 * Whether second hand covers an honour: when dummy leads one and still holds the next card
 * down, covering now just lets the next one win, so wait for the last of the touching honours
 */
export function coverLastHonour(view: View, trick: PlayedCard[]): boolean {
  const lead = trick[0]
  if (lead.seat !== dummyOf(view.state) || value(lead.card) < 10) return true
  const dummy = suitCards(view.dummyCards(), suitOf(lead.card))
  return !dummy.some((c) => view.lowestEqual(lead.card, [lead.card, c]) === c)
}

/**
 * Hold up the stopper in notrump against dummy's long suit with no other way in: while the
 * count (auction and partner's count signal) says the declarer still has a card of the suit
 * to lead again, duck; take it when the declarer's last one is played
 */
export function holdUpAgainstDummy(view: View, trick: PlayedCard[], following: Card[], led: Suit, trump: Suit | null): Card | null {
  const state = view.state
  const declarer = state.contract!.declarer
  const dummy = dummyOf(state)!
  if (trump !== null || trick[0].seat !== declarer) return null
  const dummyCards = view.dummyCards()
  const dummyPlayed = trick.some((p) => p.seat === dummy)
  const dummyLeft = suitCards(dummyCards, led).length - (dummyPlayed ? 0 : 1)
  if (dummyLeft < 2) return null
  // Dummy has a winner outside the suit to get back in: no point holding up
  if (dummyCards.some((c) => suitOf(c) !== led && value(c) >= 13)) return null
  if (dummyCards.some((c) => suitOf(c) !== led && aboveAllOut(view, c))) return null
  const masters = following.filter((c) => view.isMaster(c) || aboveAllOut(view, c))
  if (masters.length !== 1) return null
  const declarerPlayed = trick.some((p) => p.seat === declarer)
  const left = view.reading.len(declarer, led)[0] - (declarerPlayed ? 0 : 1)
  return left >= 1 ? [...following].sort(byRank)[0] : null
}

/** No card of the suit above this one is left anywhere but in the hand that holds it */
function aboveAllOut(view: View, card: Card): boolean {
  const suit = suitOf(card)
  const played = new Set(view.state.play.map((p) => p.card))
  for (const rank of RANKS) {
    if (rank === rankOf(card)) return true
    if (!played.has(suit + rank)) return false
  }
  return true
}

