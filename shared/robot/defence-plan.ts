import { rankOf, RANKS, SUITS, suitOf, type Card, type Suit } from '../cards.ts'
import { suitCards } from './hand.ts'
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
  const declarer = view.state.contract!.declarer
  return Math.min(view.reading.len(declarer, led)[1], view.reading.out(led) - 1) <= 2
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
 * No hurry to cash a winner of the suit: dummy has no running suit for the declarer's losers,
 * dummy holds two or more of the suit (it will not ruff it or discard on it soon), and our
 * winners of the suit do not defeat the contract now. The winner stays, and the declarer may
 * have to lead the suit to us.
 */
export function noHurry(view: View, s: Suit, trump: Suit | null): boolean {
  if (dummyThreat(view, trump)) return false
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
 * length that guards the declarer's long suit (the auction or the count gives the declarer at
 * least as many cards as ours, and ours are headed by a ten or better) costs 2; a suit neither
 * dummy (none left) nor the declarer (one card at most) can use costs 1 less
 */
export function declarerLength(view: View, s: Suit, mine: Card[], dummy: Card[]): number {
  const [lo, hi] = view.reading.len(view.state.contract!.declarer, s)
  let cost = 0
  if (lo >= mine.length && value(mine[0]) >= 10) cost += 2
  if (!dummy.length && hi <= 1) cost -= 1
  return cost
}

/** Unplayed cards of the suit above the card, wherever they are */
function aboveInPlay(view: View, card: Card): Card[] {
  const played = new Set(view.state.play.map((p) => p.card))
  const above = RANKS.slice(0, RANKS.indexOf(rankOf(card)))
  return [...above].map((r) => suitOf(card) + r).filter((c) => !played.has(c))
}
