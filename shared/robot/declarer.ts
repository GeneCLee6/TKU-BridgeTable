import { nextSeat, partnerOf, sameSide, SUITS, suitOf, type Card, type Seat, type Suit } from '../cards.ts'
import type { PlayedCard } from '../game.ts'
import { suitCards } from './hand.ts'
import { createVoid, crossToRuff, ruffOut, throwIn } from './declarer-technique.ts'
import { byRank, honours, value, type View } from './view.ts'

/**
 * The declarer's plan (e6-t41, ROBOT.md §3.4, V4c §3.10, W1 §3.13): cash the winners this hand
 * cannot get back to; count the sure tricks (a suit that runs counts all its length) against the
 * tricks still needed; ruff losers in the hand with fewer trumps; draw trumps whenever the
 * opponents hold some and our side can outlast them, giving up a trump trick if need be, or cross
 * to the hand that can; when the sure tricks are enough, cash them, the high cards from the shorter holding
 * first; when they are not, take a finesse the auction favours, then set up the longest suit
 * before cashing; in notrump hold up a single stopper in the suit the defence attacks, as long
 * as the card reading says the shorter defender still has one (T3); second hand takes the trick
 * with a master when partner cannot (Y4). In a suit contract the techniques of S3
 * (`declarer-technique.ts`): make the short hand void and ruff before drawing trumps, set up a
 * long suit by ruffing, strip the hands and throw a defender in. Which suit first (§3.22): the suit
 * with the most tricks is cashed first; in notrump a suit that runs on a normal split comes before
 * a finesse; the short hand's trump master goes first; a bare ace above a gap is not "set up"; a
 * hand that will not get the lead again takes its finesse now.
 * Only the cards the declaring side sees and the reading of the other two hands are used.
 */

/** Hold up past the rule of seven when the shorter defender still holds the suit at least this likely (T3) */
const HOLD_LONGER = 0.9

/** Take the last-entry finesse unless the missing card is with second hand less often than this (§3.22) */
const LAST_ENTRY_ODDS = 0.4

/** The declaring side's lead, or null to fall back to the general rules */
export function declarerLead(
  view: View,
  hand: Card[],
  trump: Suit | null,
  ruffed: (s: Suit) => boolean,
  finesse: (suits: Suit[]) => Card | null,
): Card | null {
  const partner = view.partnerCards()
  const mine = (s: Suit) => suitCards(hand, s)
  const sides = SUITS.filter((s) => s !== trump && mine(s).length)
  const trumpsOut = trump !== null && view.outstanding(trump) > 0
  const enough = sureTricks(view, trump) >= view.needed()

  const stranded = strandedMaster(view, hand, partner, trump, ruffed)
  if (stranded) return stranded

  if (trump && trumpsOut) {
    // Ruff a loser in the hand with fewer trumps before they are drawn
    if (!enough) {
      const ruff = ruffInShortHand(view, hand, partner, trump, ruffed)
      if (ruff) return ruff
      // Make the short hand void, or cross to the long hand for the ruff, before drawing trumps (S3)
      const ruffing = createVoid(view, hand, partner, trump, ruffed) ?? crossToRuff(view, hand, partner, trump, ruffed)
      if (ruffing) return ruffing
    }
    const draw = drawTrumps(view, hand, partner, trump) ?? crossToDraw(view, hand, partner, trump, ruffed)
    if (draw) return draw
  }

  if (trump && !enough) {
    // Set up a long suit by ruffing; strip the hands and throw a defender in (S3)
    const technique = ruffOut(view, hand, partner, trump, ruffed) ?? throwIn(view, hand, partner, trump, ruffed)
    if (technique) return technique
  }
  const cashing = cash(view, hand, partner, sides, ruffed)
  if (enough && cashing) return cashing
  // Notrump: run a suit that comes in on a normal split before taking a finesse (ROBOT.md §3.22)
  if (!trump && !enough) {
    const run = sides.find((s) => !ruffed(s) && probableRun(view, s) && view.isMaster(mine(s)[0]))
    if (run) return cash(view, hand, partner, [run], ruffed)
  }
  const finessable = [...(trumpsOut ? [trump!] : []), ...sides.filter((s) => !ruffed(s))]
  const finessing = finesse(finessable)
  if (finessing) return finessing
  // This hand may not get the lead back: take the finesse towards partner's tenace now (§3.22)
  if (!enough) {
    const last = lastEntryFinesse(view, hand, partner, finessable)
    if (last) return last
  }
  if (!enough) {
    const develop = setUp(view, hand, partner, sides, ruffed)
    if (develop) return develop
  }
  return cashing
}

/**
 * Masters this hand cannot reach again: partner is void in the suit and this hand has no master
 * elsewhere that partner could lead to. Cash them now, while this hand is on lead (partner
 * throws its losers on them), unless an opponent is known to ruff.
 */
function strandedMaster(view: View, hand: Card[], partner: Card[], trump: Suit | null, ruffed: (s: Suit) => boolean): Card | null {
  if (!partner.length) return null
  const entry = SUITS.some((s) => {
    const top = suitCards(hand, s)[0]
    return top && view.isMaster(top) && suitCards(partner, s).length > 0
  })
  if (entry) return null
  for (const s of SUITS) {
    if (s === trump || ruffed(s)) continue
    const mine = suitCards(hand, s)
    if (!mine.length || suitCards(partner, s).length || !view.isMaster(mine[0]) || view.outstanding(s) === 0) continue
    // Partner has something to throw: a card that would lose
    if (!partner.some((c) => suitOf(c) !== trump && !view.isMaster(c))) continue
    return mine[0]
  }
  return null
}

/**
 * Draw trumps (W1, ROBOT.md §3.13): while the opponents hold trumps that are not all masters and
 * the longer holding outlasts the defender with the most of them, lead trumps before cashing side
 * winners the opponents could ruff: the master from this hand; low towards partner's master (any
 * count); the top of a sequence to knock out the ones above it; low towards partner's higher trumps;
 * otherwise a low one, giving up the trump trick now.
 */
function drawTrumps(view: View, hand: Card[], partner: Card[], trump: Suit): Card | null {
  const mine = suitCards(hand, trump)
  const theirs = suitCards(partner, trump)
  const out = view.outstanding(trump)
  if (!mine.length || !out) return null
  // Partner, shorter, holds a master: low to it first, so the suit does not block (AJ742 opposite
  // K9: the king, then back for the finesse; ROBOT.md §3.22)
  if (theirs.length && theirs.length < mine.length && view.isMaster(theirs[0]) && !view.isMaster(mine.at(-1)!)) return mine.at(-1)!
  if (view.isMaster(mine[0])) return mine[0]
  if (theirs.length && view.isMaster(theirs[0])) return mine.at(-1)!
  const ours = [...mine, ...theirs].sort(byRank).reverse()
  // Only masters out: they take their tricks anyway, and leading at them spends two of ours (V4c),
  // unless the last one would take the trump entry to partner's winners
  if (view.higherOut(ours[0]).length >= out) return trumpEntry(view, hand, partner, trump)
  // Control: the longer holding outlasts the most a defender can hold in a normal split: three
  // trumps against three or four out, four against five or six (with fewer, ruffing pays better)
  if (Math.max(mine.length, theirs.length) < Math.ceil(out / 2) + 1) return null
  if (touching(view, mine[0], ours) && value(mine[0]) >= 9) return mine[0]
  return mine.at(-1)!
}

/**
 * Draw the last trump out, a master, after all when it blocks the entry to partner's winners (the
 * club president's exception, W1): partner holds two or more masters in a side suit this hand is
 * void in, and no other way in (a side suit this hand holds where partner has a higher card or is
 * void to ruff), but a trump above this hand's lowest. Lead the top trump: the master wins it, and
 * the low trump left reaches partner later. Leaving it out, the master would take that crossing.
 */
function trumpEntry(view: View, hand: Card[], partner: Card[], trump: Suit): Card | null {
  const mine = suitCards(hand, trump)
  const theirs = suitCards(partner, trump)
  if (view.outstanding(trump) !== 1 || mine.length < 2 || !theirs.length || value(theirs[0]) < value(mine.at(-1)!)) return null
  const otherEntry = SUITS.some((s) => {
    if (s === trump || !suitCards(hand, s).length) return false
    // Partner ruffs it
    if (!suitCards(partner, s).length) return true
    const top = suitCards(partner, s)[0]
    return view.isMaster(top) || value(top) > value(suitCards(hand, s)[0])
  })
  if (otherEntry) return null
  const stranded = SUITS.some((s) => s !== trump && !suitCards(hand, s).length && suitCards(partner, s).filter((c) => view.isMaster(c)).length >= 2)
  return stranded ? mine[0] : null
}

/**
 * This hand has no trump to lead: go over to partner, who can draw them, in a side suit where
 * partner holds a master (low from this hand), not one an opponent is known to ruff
 */
function crossToDraw(view: View, hand: Card[], partner: Card[], trump: Suit, ruffed: (s: Suit) => boolean): Card | null {
  if (suitCards(hand, trump).length) return null
  const theirs = suitCards(partner, trump)
  if (!theirs.length || view.higherOut(theirs[0]).length >= view.outstanding(trump)) return null
  if (theirs.length < Math.ceil(view.outstanding(trump) / 2) + 1) return null
  for (const s of SUITS) {
    if (s === trump || ruffed(s)) continue
    const mine = suitCards(hand, s)
    const top = suitCards(partner, s)[0]
    if (mine.length && top && view.isMaster(top) && !view.isMaster(mine.at(-1)!)) return mine.at(-1)!
  }
  return null
}

/** Sure tricks: top tricks in every suit; once trumps are drawn, every trump of the longer holding */
function sureTricks(view: View, trump: Suit | null): number {
  let n = 0
  for (const s of SUITS) {
    if (s === trump && view.outstanding(s) === 0) {
      n += Math.max(suitCards(view.ownCards(), s).length, suitCards(view.partnerCards(), s).length)
    } else n += runningTricks(view, s)
  }
  return n
}

/**
 * The tricks a suit gives cashed from the top: the masters in a row, or every card of the longer
 * holding when there are as many masters as cards out (the rest fall under them)
 */
function runningTricks(view: View, s: Suit): number {
  const top = view.topTricks(s)
  const longer = Math.max(suitCards(view.ownCards(), s).length, suitCards(view.partnerCards(), s).length)
  return top > 0 && top >= view.outstanding(s) ? longer : top
}

/**
 * The suit runs from the top on a normal split, though not on every split: two or more masters
 * in a row, at least half the cards out (rounded up), fewer than the cards out and than the longer
 * holding (AKQ872 opposite 654 against four out; ROBOT.md §3.22)
 */
function probableRun(view: View, s: Suit): boolean {
  const top = view.topTricks(s)
  const out = view.outstanding(s)
  const longer = Math.max(suitCards(view.ownCards(), s).length, suitCards(view.partnerCards(), s).length)
  return top >= 2 && top < longer && top < out && top >= Math.ceil(out / 2)
}

/**
 * Cash a sure winner, not into a ruff: from the shorter holding first so the suit does not block;
 * the suit with the most tricks first, the single winners kept as stoppers and entries (§3.22)
 */
function cash(view: View, hand: Card[], partner: Card[], sides: Suit[], ruffed: (s: Suit) => boolean): Card | null {
  const order = [...sides].sort((a, b) => runningTricks(view, b) - runningTricks(view, a))
  for (const s of order) {
    if (ruffed(s)) continue
    const mine = suitCards(hand, s)
    const theirs = suitCards(partner, s)
    if (!view.isMaster(mine[0])) continue
    // Partner, shorter, holds a master too: lead low to it (unless ours are all masters as well)
    const partnerMaster = theirs.length > 0 && theirs.length < mine.length && view.isMaster(theirs[0])
    if (partnerMaster && !view.isMaster(mine.at(-1)!)) return mine.at(-1)!
    return mine[0]
  }
  return null
}

/**
 * Set up the longest side suit that is not ours yet (does not run from the top; an ace-headed
 * suit such as AQJxx counts): six cards or more between the hands, at most two cards out above
 * our second best. Knock out the top with a sequence, or lead low towards partner's honours. A
 * bare master with a gap below it (the ace of AQ or AJ opposite small cards) knocks nothing out
 * and spends the tenace: try the next suit instead (ROBOT.md §3.22).
 */
function setUp(view: View, hand: Card[], partner: Card[], sides: Suit[], ruffed: (s: Suit) => boolean): Card | null {
  const both = [...hand, ...partner]
  const length = (s: Suit) => Math.max(suitCards(hand, s).length, suitCards(partner, s).length)
  const candidates = sides.filter((s) => {
    if (ruffed(s)) return false
    const ours = suitCards(both, s)
    if (ours.length < 6 || view.outstanding(s) === 0) return false
    const second = ours[1]
    return second !== undefined && view.higherOut(second).length <= 2 && runningTricks(view, s) < length(s)
  })
  const ordered = candidates.sort((a, b) => length(b) - length(a) || honours(suitCards(both, b)) - honours(suitCards(both, a)))
  for (const s of ordered) {
    const mine = suitCards(hand, s)
    const theirs = suitCards(partner, s)
    if (touching(view, mine[0], both) && value(mine[0]) >= 10) return mine[0]
    if (theirs.length && value(theirs[0]) > value(mine[0])) return mine.at(-1)!
    if (view.isMaster(mine[0])) continue
    return value(mine[0]) >= 10 ? mine[0] : null
  }
  return null
}

/**
 * Nothing else to do but cash, and this hand may not get the lead again (no card that wins a
 * round of a suit partner can lead to it): take the finesse towards partner's tenace now, whatever
 * the auction says, unless the card reading puts the missing card behind the tenace (dummy's
 * K532 opposite AKJT: the club towards the jack before the last entry is gone; ROBOT.md §3.22)
 */
function lastEntryFinesse(view: View, hand: Card[], partner: Card[], suits: Suit[]): Card | null {
  if (!partner.length) return null
  const entry = SUITS.some((s) => {
    const top = suitCards(hand, s)[0]
    const theirs = suitCards(partner, s)
    return top && theirs.length > 0 && (view.isMaster(top) || value(top) > value(theirs[0]))
  })
  if (entry) return null
  const second = nextSeat(view.seat)
  for (const s of suits) {
    const low = suitCards(hand, s).at(-1)
    const tenace = suitCards(partner, s).find((c) => view.higherOut(c).length === 1)
    if (!low || !tenace || value(low) > value(tenace)) continue
    if ((view.cardReading.odds(view.higherOut(tenace)[0])[second] ?? 0.5) >= LAST_ENTRY_ODDS) return low
  }
  return null
}

/** The next lower card of the suit is ours too (or already played up to one of ours) */
function touching(view: View, card: Card, ours: Card[]): boolean {
  const own = ours.filter((c) => suitOf(c) === suitOf(card) && c !== card)
  return own.some((c) => view.lowestEqual(card, [card, c]) === c)
}

/**
 * Ruff a loser in the hand with fewer trumps: partner (or this hand) is void in a side suit and
 * has trumps, the other hand holds a card that would lose, and the opponent playing after the
 * ruff is not known to overruff. (Leading the suit first when partner has a singleton of it, to
 * ruff the next round, was tried: −0.04 IMP/board.)
 */
function ruffInShortHand(view: View, hand: Card[], partner: Card[], trump: Suit, ruffed: (s: Suit) => boolean): Card | null {
  const myTrumps = suitCards(hand, trump).length
  const theirTrumps = suitCards(partner, trump).length
  if (!theirTrumps || theirTrumps >= myTrumps) return null
  const after = nextSeat(partnerOf(view.seat))
  for (const s of SUITS) {
    if (s === trump || ruffed(s)) continue
    const mine = suitCards(hand, s)
    if (!mine.length || suitCards(partner, s).length || view.isMaster(mine.at(-1)!)) continue
    if (view.reading.isVoid(after, s) || view.outstanding(s) === 0) continue
    return mine.at(-1)!
  }
  return null
}

/**
 * Nothing in the plan applies: a lead that gives the least away. Towards an honour of partner's
 * that a low card could promote; from a suit with no honour to lose; not an honour led bare from
 * a short holding, not away from a lone honour towards nothing, not into a known ruff and, when
 * there is a choice, not a suit the opponents bid. Low, or the top of a sequence.
 */
export function exitLead(view: View, hand: Card[], trump: Suit | null, ruffed: (s: Suit) => boolean, theirs: (s: Suit) => boolean): Card | null {
  const partner = view.partnerCards()
  const suits = SUITS.filter((s) => s !== trump && suitCards(hand, s).length)
  if (!suits.length) return null
  const honour = (c: Card) => value(c) >= 11 && !view.isMaster(c)
  const score = (s: Suit) => {
    const mine = suitCards(hand, s)
    const partners = suitCards(partner, s)
    let n = 0
    if (ruffed(s)) n -= 10
    if (theirs(s)) n -= 2
    const low = mine.at(-1)!
    const towards = partners.some((c) => honour(c) && value(c) > value(low) && view.higherOut(c).length <= 2)
    if (towards) n += 3
    if (!mine.some(honour) && !partners.some(honour)) n += 1
    const lead = sequenceTop(view, mine) ?? (mine.length <= 2 ? mine[0] : low)
    if (honour(lead) && !sequenceTop(view, mine)) n -= 3
    else if (mine.some(honour) && !towards) n -= 1
    return n
  }
  const s = [...suits].sort((a, b) => score(b) - score(a) || suitCards(hand, b).length - suitCards(hand, a).length)[0]
  const mine = suitCards(hand, s)
  return sequenceTop(view, mine) ?? mine.at(-1)!
}

/** The top of two touching cards (KQ, QJ, JT) at the head of a holding of two or more */
function sequenceTop(view: View, cards: Card[]): Card | null {
  if (cards.length < 2 || value(cards[0]) < 11) return null
  return view.lowestEqual(cards[0], cards) !== cards[0] ? cards[0] : null
}

/**
 * Hold up the only stopper in notrump (the rule of seven): duck the suit the defence leads
 * 7 − (our cards in it) times, so the defender with the long suit has no way to reach partner.
 * The rule guesses a five-card suit; when the card reading (T3, ROBOT.md §3.17) clearly shows
 * the long hand, hold up longer while its partner is all but sure to hold another card, and
 * stop once that partner is all but sure to be out and the long hand leads the suit itself
 */
export function holdUp(view: View, trick: PlayedCard[], following: Card[], led: Suit, trump: Suit | null): Card | null {
  if (trump !== null || sameSide(trick[0].seat, view.seat)) return null
  const best = trick.reduce((a, p) => (suitOf(p.card) === led && value(p.card) > value(a.card) ? p : a), trick[0])
  if (sameSide(best.seat, view.seat)) return null
  const partner = suitCards(view.partnerCards(), led)
  const masters = following.filter((c) => view.isMaster(c))
  if (masters.length !== 1 || partner.some((c) => view.isMaster(c))) return null
  const ours = [...following, ...partner].sort(byRank).reverse()
  if (ours[1] && view.higherOut(ours[1]).length < 2) return null
  const low = [...following].sort(byRank)[0]
  // Last to play with a card below the master that beats the trick: it wins now and the master
  // stays as the stopper (AJ5 over East's ten: the jack; ducking gives the trick away for nothing)
  if (trick.length === 3 && suitOf(best.card) === led && following.some((c) => value(c) > value(best.card) && !masters.includes(c))) return null
  const side = [view.seat, partnerOf(view.seat)]
  const played = view.state.play.filter((p) => side.includes(p.seat) && suitOf(p.card) === led).length
  const combined = following.length + partner.length + played
  // Card reading (T3): the rule of seven guesses the split; the lead, show-outs and count signals
  // may tell it. Hold up longer while the shorter defender still holds a card of the suit (so it
  // has none to lead to partner's long cards later); stop once it has none and the long hand
  // itself leads the suit (there is nothing left to cut)
  const reading = view.cardReading
  if (reading.unseen.length === 2) {
    const [a, b] = reading.unseen
    const long = reading.expected(a, led) >= reading.expected(b, led) ? a : b
    const short = partnerOf(long)
    const toPlay = (s: Seat) => (trick.some((p) => p.seat === s) ? 0 : 1)
    if (reading.expected(long, led) - toPlay(long) - (reading.expected(short, led) - toPlay(short)) >= 1) {
      const holds = 1 - reading.exhausted(short, led, toPlay(short))
      if (holds >= HOLD_LONGER) return low
      if (holds <= 1 - HOLD_LONGER && trick[0].seat === long) return null
    }
  }
  return view.timesLed(led) < 7 - combined ? low : null
}

/**
 * Second hand on the declaring side after a defender's lead (Y4, ROBOT.md §3.14): with a master
 * that beats the card led, take the trick when partner, last to play, cannot. In a trump contract
 * that is whenever partner holds no master of the suit (a low card, a void with trumps to spare,
 * or none); in notrump only when partner is void. Ducking would only hand third hand a cheap
 * trick. Hold-ups (`holdUp`) are decided before this. In notrump with partner holding low cards,
 * second hand stays low: rising there lost (V4c, Y4).
 */
export function secondHandWin(view: View, trick: PlayedCard[], following: Card[], led: Suit, trump: Suit | null): Card | null {
  if (trick.length !== 1 || sameSide(trick[0].seat, view.seat) || suitOf(trick[0].card) !== led) return null
  const master = following.filter((c) => view.winsNow(c)).sort(byRank)[0]
  const partner = view.partnerCards()
  if (!master || !partner.length) return null
  const theirs = suitCards(partner, led)
  const cannot = trump === null ? theirs.length === 0 : !theirs.some((c) => view.isMaster(c))
  return cannot ? master : null
}

/** Partner's cards below this cannot fight for the trick, and this hand's from here up can (ROBOT.md §3.21) */
const COVER_BELOW = 10

/**
 * Second hand on the declaring side after a defender's lead, partner (last to play) holding nothing
 * that can fight for the trick: no card of the ten or higher, or a void with no trump to ruff. Low
 * from here hands third hand a cheap trick, so cover with the cheapest ten or higher over the lead
 * (dummy's Q84 opposite declarer's 753 on a low lead: the queen; ROBOT.md §3.21). Null to stay low.
 */
export function secondHandCover(view: View, trick: PlayedCard[], following: Card[], led: Suit, trump: Suit | null): Card | null {
  if (trick.length !== 1 || sameSide(trick[0].seat, view.seat) || suitOf(trick[0].card) !== led) return null
  const partner = view.partnerCards()
  if (!partner.length) return null
  const theirs = suitCards(partner, led)
  if (!theirs.length && trump && suitCards(partner, trump).length) return null
  if (theirs.some((c) => value(c) >= COVER_BELOW)) return null
  return following.filter((c) => value(c) > value(trick[0].card) && value(c) >= COVER_BELOW).sort(byRank)[0] ?? null
}
