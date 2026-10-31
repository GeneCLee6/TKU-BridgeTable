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
  const race = raceSuit(view, hand, trump)

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
    // Nothing in dummy (in notrump a void too: the declarer's honours sit in front of partner's)
    else if ((theirs.length || trump === null) && !theirs.some((c) => value(c) >= 10)) n += 1
    if (s === trump) n += 2
    if (state.play[0].seat === partner && suitOf(state.play[0].card) === s) n += 4
    // Our own opening lead in notrump, still being set up: keep at it
    if (s === race && state.play[0].seat === view.seat) n += 3
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
 * In notrump, the suit of the opening lead (ours or partner's) while it is still being set up: we
 * hold a card of it that is not yet a winner, a card of it is still out of view, and partner, if
 * the leader, has not shown out
 */
export function raceSuit(view: View, hand: Card[], trump: Suit | null): Suit | null {
  const state = view.state
  if (trump !== null || !state.play.length) return null
  const opening = state.play[0]
  const suit = suitOf(opening.card)
  if (opening.seat !== view.seat && opening.seat !== partnerOf(view.seat)) return null
  const mine = suitCards(hand, suit)
  if (!mine.length || view.isMaster(mine[0]) || !view.outstanding(suit)) return null
  if (opening.seat !== view.seat && view.reading.isVoid(opening.seat, suit)) return null
  return suit
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
 * Second hand, when low is not the answer:
 * - the declarer leads low towards a bare honour in dummy (a singleton king or queen): rise with
 *   the ace, low would let it score and the ace takes nothing else later
 * - the declarer leads and dummy, playing next, has nothing above our cheapest card over the lead
 *   (and cannot ruff): win cheaply rather than let the lead win, it costs nothing
 * - dummy leads a ten or higher and we have a sure winner over it: take it with the cheapest
 * Null for second hand low (the signal).
 */
export function secondHand(view: View, trick: PlayedCard[], following: Card[], led: Suit, trump: Suit | null): Card | null {
  const state = view.state
  const dummy = dummyOf(state)!
  if (trick.length !== 1) return null
  const lead = trick[0]
  const dummyLed = lead.seat === dummy
  const dummyCards = view.dummyCards()
  const dummySuit = suitCards(dummyCards, led)
  const beaters = following.filter((c) => value(c) > value(lead.card)).sort(byRank)
  if (!beaters.length) return null
  const master = beaters.find((c) => view.isMaster(c))
  if (master && cashOut(view, led, trump)) return master
  if (!dummyLed) {
    if (value(lead.card) < 10 && dummySuit.length === 1 && value(dummySuit[0]) >= 12 && view.unseenAbove(dummySuit[0]).length === 0) {
      const ace = following.find((c) => rankOf(c) === 'A')
      if (ace) return ace
    }
    const dummyRuffs = trump !== null && led !== trump && dummySuit.length === 0 && suitCards(dummyCards, trump).length > 0
    if (!dummyRuffs && !dummySuit.some((c) => value(c) > value(beaters[0]))) return beaters[0]
    // Dummy has one card left in the suit and must play it: cover it with the cheapest card over it
    if (!dummyRuffs && dummySuit.length === 1) return beaters.find((c) => value(c) > value(dummySuit[0])) ?? null
    return null
  }
  if (value(lead.card) < 10) return null
  return beaters.find((c) => view.unseenAbove(c).length === 0) ?? null
}

/**
 * The tricks to defeat the contract are in our hand: the sure winners of the suit led (and, in
 * notrump, of the other suits) are as many as the tricks still needed, so take them now rather
 * than give the declarer a chance to discard them or get in first
 */
export function cashOut(view: View, led: Suit, trump: Suit | null): boolean {
  let sure = view.topTricks(led)
  if (trump === null) for (const s of SUITS) if (s !== led) sure += view.topTricks(s)
  return sure >= view.needed()
}

/**
 * Whether dummy, still to play after us, would overruff: it has no card of the suit led and a
 * trump above the one we would ruff with (so ruffing just throws a trump away)
 */
export function dummyOverruffs(view: View, trick: PlayedCard[], led: Suit, ruff: Card, trump: Suit): boolean {
  const dummy = dummyOf(view.state)!
  if (trick.some((p) => p.seat === dummy) || trick[0].seat === dummy) return false
  const dummyCards = view.dummyCards()
  if (suitCards(dummyCards, led).length) return false
  return suitCards(dummyCards, trump).some((c) => value(c) > value(ruff))
}

/**
 * Third hand after partner's lead (ROBOT.md §3, §3.12): high, with the lowest of touching cards,
 * so the declarer does not win cheaply; but not over a card of partner's that nobody can beat
 * (the cards above it are all in view, or the declarer has played and dummy, last, has nothing
 * over it), nor over partner's honour (except a doubleton honour in notrump, which overtakes so
 * the suit does not block), and only as high as dummy makes necessary: a tenace over an honour
 * dummy keeps finesses against it (AQ against the K; KT against dummy's AJ, the T), and nothing is
 * spent on a trick dummy, still to play, wins anyway. Once dummy has played low, its honours have
 * passed: a king behind dummy's AJx wins the trick. The rule of eleven on a low opening lead says
 * the lead is already winning only when partner showed four cards or more in the auction: the
 * club leads the lowest from three with an honour, and a person may lead anything. Null leaves
 * the card to the signals.
 */
export function thirdHand(view: View, trick: PlayedCard[], following: Card[], best: PlayedCard, led: Suit, trump: Suit | null): Card | null {
  if (trick.length !== 2 || suitOf(best.card) !== led) return null
  const state = view.state
  const dummy = dummyOf(state)!
  const partnerCard = trick[0].card
  const partnerWinning = best.seat === trick[0].seat
  const beaters = following.filter((c) => value(c) > value(best.card)).sort(byRank)
  if (!beaters.length) return null
  const top = beaters.at(-1)!
  const dummyLeft = suitCards(view.dummyCards(), led)
  const dummyLast = trick[1].seat !== dummy
  // Dummy, still to play, holds a card over partner's: partner's card is not winning after all
  const dummyBeats = dummyLast && dummyLeft.some((c) => value(c) > value(best.card))

  if (partnerWinning && !dummyBeats) {
    const honourLed = value(partnerCard) >= 11
    // Unblock in notrump: a doubleton honour over partner's honour
    if (honourLed) return trump === null && following.length === 2 && value(top) > value(partnerCard) ? top : null
    // Nobody can beat partner's card: the declarer has played to the trick and dummy, last, has
    // nothing over it; or the cards above it are all in view
    if (dummyLast) return null
    const hidden = view.unseenAbove(best.card).length
    if (hidden === 0) return null
    // The rule of eleven on a low opening lead in notrump: fourth best from four or more leaves
    // partner exactly three cards above the one led, so when exactly three are out of view declarer
    // has none. Only when the auction shows partner's four cards: the club's lowest from three
    // with an honour (Q86 leads the 6) leaves declarer one of them (W2: dummy's AJx, the K ducked
    // and declarer's T won). Against a suit contract a low lead is as often from a short suit
    const fourCards = view.reading.len(trick[0].seat, led)[0] >= 3
    if (fourCards && trump === null && state.play.length < 4 && value(partnerCard) <= 7 && hidden === 3) return null
  }

  if (dummyLast) {
    // Dummy plays last: the cheapest card over its top card; with none, force the top card out
    // with the cheapest card over dummy's next one when we keep a higher card (KT5 against dummy's
    // A9: the T, and the K is good); else keep ours
    const dummyTop = dummyLeft[0]
    const over = dummyTop ? beaters.filter((c) => value(c) > value(dummyTop)) : beaters
    if (over.length) return view.lowestEqual(over[0], following)
    const next = dummyLeft[1]
    const force = next && value(next) > value(best.card) ? beaters.find((c) => value(c) > value(next) && value(c) >= 9) : undefined
    if (force && following.some((c) => value(c) > value(force))) return view.lowestEqual(force, following)
    return null
  }
  // Dummy played second and keeps an honour above the trick: with a card over that honour, finesse
  // against it with the highest card below it (the lowest of touching cards). Against a suit
  // contract only with the ten or higher: a nine that loses to declarer's ten may be the suit's
  // only trick before declarer ruffs
  const kept = dummyLeft.filter((c) => value(c) > value(best.card) && value(c) >= 10)
  if (kept.length) {
    const lowest = trump === null ? 9 : 10
    const over = beaters.some((c) => value(c) > value(kept[0]))
    const under = beaters.filter((c) => value(c) < value(kept[0]))
    if (over && under.length && value(under.at(-1)!) >= lowest) return view.lowestEqual(under.at(-1)!, following)
    // Nothing over dummy's top honour: finesse against the next one down with the card just below
    // it when we hold a card over it (KT against dummy's AJ: the T, and the K stays over the J)
    for (const honour of kept.slice(1)) {
      if (!beaters.some((c) => value(c) > value(honour))) continue
      const below = beaters.filter((c) => value(c) < value(honour)).at(-1)
      const touching = below && !view.unseenAbove(below).some((c) => value(c) < value(honour))
      if (below && touching && value(below) >= lowest) return view.lowestEqual(below, following)
    }
  }
  // Third hand high
  return view.lowestEqual(top, following)
}
/**
 * Hold up the stopper in notrump against dummy's long suit with no other way in: while the
 * count (auction and partner's count signal) says the declarer still has a card of the suit
 * to lead again, duck; take it when the declarer's last one is played. Only when dummy's suit
 * is worth shutting out (its top card would be good once our stopper is gone) and dummy has no
 * entry: no outside winner, and no outside honour we do not sit over with every higher card
 */
export function holdUpAgainstDummy(view: View, trick: PlayedCard[], following: Card[], led: Suit, trump: Suit | null): Card | null {
  const state = view.state
  const declarer = state.contract!.declarer
  const dummy = dummyOf(state)!
  if (trump !== null || trick[0].seat !== declarer) return null
  const dummyCards = view.dummyCards()
  const dummySuit = suitCards(dummyCards, led)
  const dummyPlayed = trick.some((p) => p.seat === dummy)
  const dummyLeft = dummySuit.length - (dummyPlayed ? 0 : 1)
  if (dummyLeft < 2) return null
  const masters = following.filter((c) => view.isMaster(c) || aboveAllOut(view, c))
  if (masters.length !== 1) return null
  // Dummy's suit is not worth shutting out: its top card (after this trick) would not be good
  // even once our master is gone
  const dummyTop = dummySuit[0]
  if (!dummyTop || view.higherOut(dummyTop).length) return null
  // Dummy has a way back in outside the suit: a winner, or an honour that may be one
  const entry = (c: Card) => suitOf(c) !== led && (aboveAllOut(view, c) || (value(c) >= 11 && !view.coveredByMe(c)))
  if (dummyCards.some(entry)) return null
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

