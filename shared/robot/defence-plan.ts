import { rankOf, RANKS, SUITS, suitOf, type Card, type Suit } from '../cards.ts'
import { suitCards } from './hand.ts'
import { declarerHas, declarerLen, dummyDiscards } from './defence-reading.ts'
import { value, type View } from './view.ts'

/**
 * The defenders' model of the declarer's plan (Y3, ROBOT.md §3.14): "how would I play this if I
 * were declarer". From what a defender sees (its own hand, dummy, the cards played) and the
 * reading of the declarer's hand from the auction and the count (`reading.ts`): the suit in dummy
 * the declarer will run for discards, whether the declarer's second suit needs ruffs in dummy,
 * how short the declarer is in partner's suit, which length guards the declarer's long suit.
 * Never the declarer's or partner's actual cards.
 */

/**
 * Trick one of a suit contract, third hand holding the ace of partner's suit: take it rather than
 * finesse against dummy's honour when the declarer may hold a singleton honour over our finesse
 * card, so the suit may go only one round. The count (and the auction) leaves the declarer two
 * cards at most when partner keeps one more than the card led.
 */
export function aceNow(view: View, following: Card[], led: Suit): boolean {
  if (view.state.play.length > 3 || !following.some((c) => rankOf(c) === 'A')) return false
  // Our next card wins the trick anyway (dummy holds every card above it but our ace): the
  // finesse costs nothing, and the ace stays over dummy's honours
  const next = [...following].sort((a, b) => value(b) - value(a))[1]
  if (next && !view.unseenAbove(next).length) return false
  return Math.min(declarerLen(view, led)[1], view.reading.out(led) - 1) <= 2
}

/**
 * Dummy's long side suit that already runs, for the declarer to discard losers on: four cards or
 * more, no card out above dummy's second best (AKQxx, KQJT9 once the ace is gone), and we do not
 * hold as many cards with one above dummy's second best. Null when dummy has none.
 */
export function dummyThreat(view: View, trump: Suit | null): Suit | null {
  const dummy = view.dummyCards()
  let best: Suit | null = null
  for (const s of SUITS) {
    if (s === trump) continue
    const cards = suitCards(dummy, s)
    if (cards.length < 4 || (best && cards.length <= suitCards(dummy, best).length)) continue
    if (aboveInPlay(view, cards[1]).some((c) => !cards.includes(c))) continue
    const mine = suitCards(view.ownCards(), s)
    if (mine.length >= cards.length && mine.some((c) => value(c) > value(cards[1]))) continue
    best = s
  }
  return best
}

/**
 * No hurry to cash a winner of the suit: dummy has no running suit the declarer can discard
 * losers on (by the count: the declarer may run out of it first, T4), dummy holds two or more of the suit (it will not ruff it or discard on it soon), and our
 * winners of the suit do not defeat the contract now. The winner stays, and the declarer may
 * have to lead the suit to us.
 */
export function noHurry(view: View, s: Suit, trump: Suit | null): boolean {
  // The count of dummy's suit (T4, ROBOT.md §3.16): a running suit is a reason to hurry only when
  // the declarer may run out of it and discard; a suit of three or more the count says the
  // declarer will discard on is one too
  const threat = dummyThreat(view, trump) && dummyDiscards(view, trump, false)
  if (threat || dummyDiscards(view, trump, true)) return false
  if (suitCards(view.dummyCards(), s).length < 2) return false
  return view.topTricks(s) < view.needed()
}

/**
 * The declarer will ruff a side suit in dummy: the declarer showed four cards or more of it in the
 * auction, dummy holds two at most of it and a trump; and leading a trump costs us nothing (no
 * trump honour of ours that is not a winner)
 */
export function ruffsInDummy(view: View, hand: Card[], trump: Suit): boolean {
  const mine = suitCards(hand, trump)
  if (!mine.length || mine.some((c) => value(c) >= 11 && !view.isMaster(c))) return false
  const dummy = view.dummyCards()
  if (!suitCards(dummy, trump).length) return false
  const declarer = view.state.contract!.declarer
  return SUITS.some((s) => s !== trump && view.reading.bid(declarer, s) && suitCards(dummy, s).length <= 2 && view.outstanding(s) > 0)
}

/**
 * What a defender's discard from a suit gives the declarer, as the declarer's hand reads: the
 * length that guards the declarer's long suit (the card reading gives the declarer as many cards
 * as ours three times in ten or more, and ours are headed by a ten or better) costs 2; a suit
 * neither dummy (none left) nor the declarer (one card at most, nine in ten) can use costs 1
 * less; an honour short of guards against dummy's cards above it costs 4 (S2)
 */
export function declarerLength(view: View, s: Suit, mine: Card[], dummy: Card[]): number {
  let cost = 0
  // The card reading's chance (S2), not the certain range: three in ten that the declarer still
  // holds as many as ours is enough to keep them (one in two: −21／−13 IMP on 5,000 boards)
  if (value(mine[0]) >= 10 && declarerHas(view, s, mine.length) >= GUARD_LENGTH) cost += 2
  if (!dummy.length && declarerHas(view, s, 0, 1) >= 0.9) cost -= 1
  return cost + dummyGuards(view, mine, dummy)
}

/** The chance the declarer holds as many cards as ours that keeps our length (S2) */
const GUARD_LENGTH = 0.3

/**
 * Dummy's cards above our honour need guards too (S2): the discard costs (`discardCosts` in
 * play.ts) count only the cards above it we cannot see, so Kx under dummy's A looked safe to
 * shorten and the bare king fell to the ace. An honour needs one small card more for each of
 * dummy's cards above it; 4 more when the discard leaves it short of them
 */
function dummyGuards(view: View, mine: Card[], dummy: Card[]): number {
  let cost = 0
  for (const c of mine) {
    const over = dummy.filter((d) => value(d) > value(c)).length
    if (value(c) < 11 || !over || view.isMaster(c)) continue
    const below = mine.filter((d) => value(d) < value(c)).length
    const unseen = view.unseenAbove(c).length
    // Only against the declaring side's length: a long card beyond the cards above ours, in dummy
    // or (as the cards read) in the declarer's hand. AQ4 opposite K72 cash three rounds and stop
    const long = dummy.length > unseen + over || declarerHas(view, suitOf(c), unseen + over + 1) >= GUARD_LENGTH
    // Short of guards with dummy's cards counted, but not without them (discardCosts has the 4 then)
    if (long && below <= unseen + over && below > unseen) cost += 4
  }
  return cost
}

/** Unplayed cards of the suit above the card, wherever they are */
function aboveInPlay(view: View, card: Card): Card[] {
  const played = new Set(view.state.play.map((p) => p.card))
  const above = RANKS.slice(0, RANKS.indexOf(rankOf(card)))
  return [...above].map((r) => suitOf(card) + r).filter((c) => !played.has(c))
}
