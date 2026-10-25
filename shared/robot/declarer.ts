import { nextSeat, partnerOf, sameSide, SUITS, suitOf, type Card, type Suit } from '../cards.ts'
import type { PlayedCard } from '../game.ts'
import { suitCards } from './hand.ts'
import { byRank, honours, value, type View } from './view.ts'

/**
 * The declarer's plan (e6-t41, ROBOT.md §3.4): count the sure tricks against the tricks still
 * needed; draw trumps, knocking out a missing top trump; ruff losers in the hand with fewer
 * trumps; when the sure tricks are enough, cash them, the high cards from the shorter holding
 * first; when they are not, take a finesse the auction favours, then set up the longest suit
 * before cashing; in notrump hold up a single stopper in the suit the defence attacks.
 * Only the cards the declaring side sees and the reading of the other two hands are used.
 */

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
  const theirs = (s: Suit) => suitCards(partner, s)
  const sides = SUITS.filter((s) => s !== trump && mine(s).length)
  const trumpsOut = trump !== null && view.outstanding(trump) > 0
  const enough = sureTricks(view, trump) >= view.needed()

  if (trump && trumpsOut) {
    const top = mine(trump)[0]
    // Ruff a loser in the hand with fewer trumps before they are drawn
    if (!enough) {
      const ruff = ruffInShortHand(view, hand, partner, trump, ruffed)
      if (ruff) return ruff
    }
    // Draw trumps with a master
    if (top && view.isMaster(top)) return top
    const partnerTop = theirs(trump)[0]
    if (top && mine(trump).length + theirs(trump).length >= 7) {
      // Towards partner's master trump, or knock out the one trump above a sequence
      if (partnerTop && view.isMaster(partnerTop)) return mine(trump).at(-1)!
      if (view.higherOut(top).length === 1 && touching(view, top, [...hand, ...partner])) return top
    }
  }

  const cashing = cash(view, hand, partner, sides, ruffed)
  if (enough && cashing) return cashing
  const finessing = finesse([...(trumpsOut ? [trump!] : []), ...sides.filter((s) => !ruffed(s))])
  if (finessing) return finessing
  if (!enough) {
    const develop = setUp(view, hand, partner, sides, ruffed)
    if (develop) return develop
  }
  return cashing
}

/** Sure tricks: top tricks in every suit; once trumps are drawn, every trump of the longer holding */
function sureTricks(view: View, trump: Suit | null): number {
  let n = 0
  for (const s of SUITS) {
    if (s === trump && view.outstanding(s) === 0) {
      n += Math.max(suitCards(view.ownCards(), s).length, suitCards(view.partnerCards(), s).length)
    } else n += view.topTricks(s)
  }
  return n
}

/** Cash a sure winner, not into a ruff: from the shorter holding first so the suit does not block */
function cash(view: View, hand: Card[], partner: Card[], sides: Suit[], ruffed: (s: Suit) => boolean): Card | null {
  for (const s of sides) {
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
 * Set up the longest side suit that is not ours yet: seven cards or more between the hands,
 * at most two cards out above our second best. Knock out the top with a sequence, or lead
 * low towards partner's honours.
 */
function setUp(view: View, hand: Card[], partner: Card[], sides: Suit[], ruffed: (s: Suit) => boolean): Card | null {
  const both = [...hand, ...partner]
  const candidates = sides.filter((s) => {
    if (ruffed(s)) return false
    const ours = suitCards(both, s)
    if (ours.length < 6 || view.outstanding(s) === 0) return false
    const second = ours[1]
    return second !== undefined && view.higherOut(second).length <= 2 && view.higherOut(ours[0]).length > 0
  })
  if (!candidates.length) return null
  const length = (s: Suit) => Math.max(suitCards(hand, s).length, suitCards(partner, s).length)
  const s = [...candidates].sort((a, b) => length(b) - length(a) || honours(suitCards(both, b)) - honours(suitCards(both, a)))[0]
  const mine = suitCards(hand, s)
  const theirs = suitCards(partner, s)
  if (touching(view, mine[0], both) && value(mine[0]) >= 10) return mine[0]
  if (theirs.length && value(theirs[0]) > value(mine[0])) return mine.at(-1)!
  return value(mine[0]) >= 10 ? mine[0] : null
}

/** The next lower card of the suit is ours too (or already played up to one of ours) */
function touching(view: View, card: Card, ours: Card[]): boolean {
  const own = ours.filter((c) => suitOf(c) === suitOf(card) && c !== card)
  return own.some((c) => view.lowestEqual(card, [card, c]) === c)
}

/**
 * Ruff a loser in the hand with fewer trumps: partner (or this hand) is void in a side suit and
 * has trumps, the other hand holds a card that would lose, and the opponent playing after the
 * ruff is not known to overruff
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
 * Hold up the only stopper in notrump (the rule of seven): duck the suit the defence leads
 * 7 − (our cards in it) times, so the defender with the long suit has no way to reach partner
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
  const side = [view.seat, partnerOf(view.seat)]
  const played = view.state.play.filter((p) => side.includes(p.seat) && suitOf(p.card) === led).length
  const combined = following.length + partner.length + played
  if (view.timesLed(led) >= 7 - combined) return null
  return [...following].sort(byRank)[0]
}

