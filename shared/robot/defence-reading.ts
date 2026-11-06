import { partnerOf, rankOf, RANKS, sameSide, SUITS, suitOf, type Card, type Seat, type Suit } from '../cards.ts'
import { dummyOf, remainingCards, tricksOf } from '../game.ts'
import type { Range } from './system/spec.ts'
import { suitCards } from './hand.ts'
import { value, type View } from './view.ts'

/**
 * T4 (ROBOT.md §3.16): a defender reads partner's signals, as the club gives them (ROBOT.md §3,
 * §3.2), and counts the declarer's hand from the auction and the cards played. Only what the
 * defender sees: its own hand, dummy, the cards played (`View`, `TableReading`), never the
 * declarer's or partner's cards. Since S2 (ROBOT.md §3.19) the declarer's hand is read with the
 * card reading of T3 (`card-reading.ts`, `View.cardReading`): the opening lead's holdings, both
 * defenders' count signals, vacant places and the honour layouts the auction's points allow.
 *
 * A signal is read the way a person reads it: a card is low when every lower card of the suit was
 * in view when it was played (our own hand, dummy, cards already played), high when two or more
 * lower cards were out of view; one lower card out of view leaves only the 2–4 low and the 7 up
 * high, the rest unread.
 */

type Level = 'low' | 'high' | null

/** A seat's whole hand as far as this robot may know it: the remaining cards and the ones it played */
function originalHand(view: View, seat: Seat): Card[] {
  return [...remainingCards(view.state, seat), ...view.state.play.filter((p) => p.seat === seat).map((p) => p.card)]
}

/** Whether a card at `index` of the play was low or high as this robot saw it then */
export function signalLevel(view: View, index: number): Level {
  const state = view.state
  const card = state.play[index].card
  const suit = suitOf(card)
  const seen = new Set<Card>(originalHand(view, view.seat))
  const dummy = dummyOf(state)
  if (dummy && index > 0) for (const c of originalHand(view, dummy)) seen.add(c)
  for (const p of state.play.slice(0, index)) seen.add(p.card)
  const lower = [...RANKS.slice(RANKS.indexOf(rankOf(card)) + 1)]
    .map((r) => suit + r)
    .filter((c) => !seen.has(c)).length
  if (lower === 0) return 'low'
  if (lower >= 2) return 'high'
  return value(card) <= 4 ? 'low' : value(card) >= 7 ? 'high' : null
}

/**
 * Partner's attitude to a suit we led (the club's reverse attitude: low likes it, a high spot
 * does not), from partner's first card on our lead of the suit when partner did not try to win
 * (no honour, not over the card winning the trick). After our king partner gives count, not
 * attitude. Null when partner has not shown it.
 */
export function partnerAttitude(view: View, suit: Suit): 'like' | 'dislike' | null {
  const partner = partnerOf(view.seat)
  const tricks = tricksOf(view.state)
  for (let t = 0; t < tricks.length; t++) {
    const trick = tricks[t]
    if (trick.leader !== view.seat || suitOf(trick.cards[0].card) !== suit) continue
    if (rankOf(trick.cards[0].card) === 'K') return null
    const at = trick.cards.findIndex((p) => p.seat === partner)
    if (at < 0) return null
    const card = trick.cards[at].card
    if (suitOf(card) !== suit || value(card) >= 11) return null
    // Partner tried to win: over the card winning the trick at that point
    const before = trick.cards.slice(0, at).filter((p) => suitOf(p.card) === suit)
    if (before.every((p) => value(p.card) < value(card))) return null
    const level = signalLevel(view, t * 4 + at)
    return level === 'low' ? 'like' : level === 'high' ? 'dislike' : null
  }
  return null
}

/**
 * Partner's count of a suit (the club's standard count: high then low is even): partner's cards
 * following the declaring side's lead of the suit, or our king (the club's king asks for count),
 * without trying to win. Two cards compare with each other; with `single`, one card reads by its
 * level (used only for the hold-up, where it was measured: read everywhere, the first card's
 * misreads, 987 low from three, cost a little). The club's Smith Echo trick in notrump is not a
 * count.
 */
export function partnerCount(view: View, suit: Suit, single = false): 'even' | 'odd' | null {
  const state = view.state
  const contract = state.contract!
  const partner = partnerOf(view.seat)
  const tricks = tricksOf(state)
  const smith = contract.strain === 'N' ? tricks.slice(1).find((t) => sameSide(t.leader, contract.declarer)) : undefined
  const shown: number[] = []
  for (let t = 0; t < tricks.length; t++) {
    const trick = tricks[t]
    if (trick === smith || suitOf(trick.cards[0].card) !== suit) continue
    const ours = trick.leader === view.seat && rankOf(trick.cards[0].card) === 'K'
    if (!ours && !sameSide(trick.leader, contract.declarer)) continue
    const at = trick.cards.findIndex((p) => p.seat === partner)
    if (at < 0) continue
    const card = trick.cards[at].card
    if (suitOf(card) !== suit || trick.winner === partner || value(card) >= 11) continue
    shown.push(t * 4 + at)
  }
  if (!shown.length) return null
  if (shown.length >= 2) return value(state.play[shown[0]].card) > value(state.play[shown[1]].card) ? 'even' : 'odd'
  if (!single) return null
  const level = signalLevel(view, shown[0])
  return level === 'low' ? 'odd' : level === 'high' ? 'even' : null
}

/**
 * The declarer's cards left in a suit: the reading (auction and count, `reading.ts`), narrowed by
 * partner's count when the reading has not used it (partner's count after our king; with `single`
 * partner's one card).
 * The two hands we cannot see are partner's and the declarer's, so what partner holds the
 * declarer does not.
 */
export function declarerLen(view: View, suit: Suit, single = false): Range {
  const declarer = view.state.contract!.declarer
  // The card reading (card-reading.ts, T3): the auction and count, and the opening lead's
  // holdings, both defenders' count signals and the vacant places (S2)
  const base = view.cardReading.len(declarer, suit)
  const signal = partnerCount(view, suit, single)
  if (!signal) return base
  const partner = partnerOf(view.seat)
  const out = view.reading.out(suit)
  const played = view.state.play.filter((p) => p.seat === partner && suitOf(p.card) === suit).length
  const [plo, phi] = view.reading.len(partner, suit)
  const fits = (n: number) => (n + played) % 2 === (signal === 'even' ? 0 : 1)
  const lo = fits(plo) ? plo : plo + 1
  const hi = fits(phi) ? phi : phi - 1
  if (lo > hi) return base
  const range: Range = [Math.max(base[0], out - hi), Math.min(base[1], out - lo)]
  return range[0] <= range[1] ? range : base
}

const HCP: Record<string, number> = { A: 4, K: 3, Q: 2, J: 1 }
const hcpOf = (card: Card) => HCP[rankOf(card)] ?? 0

/**
 * Who holds an honour we cannot see, from the declarer's points (the auction less the honours
 * played: "declarer opened 15–17 and has shown 13, so partner has the queen"): the declarer has
 * too few points left for it, or needs it (the other unseen honours do not reach the declarer's
 * minimum); otherwise the card reading's holder at seven in ten (S2; 0.6: +45／−31 IMP, 0.8:
 * −2／−31 on 5,000 boards). Null when it cannot tell.
 */
export function placeHonour(view: View, card: Card): Seat | null {
  const declarer = view.state.contract!.declarer
  if (hcpOf(card) > view.reading.hcp(declarer)[1]) return partnerOf(view.seat)
  if (!view.cardReading.unseen.length || !unseenHonours(view).includes(card)) return null
  // The points decide it (shared with the declarer's card reading, card-reading.ts, T3)
  // the card reading's odds otherwise (S2: the lead, vacant places and the honour layouts the
  // auction's points allow, rather than the reading's clear-margin guess)
  return view.cardReading.placedByPoints(card) ?? view.cardReading.holder(card, PLACED)
}

/** How sure the card reading must be to place an honour (S2) */
const PLACED = 0.7

/** The chance the declarer holds a card we cannot see (the card reading, T3); 0 for one in view */
export function declarerHolds(view: View, card: Card): number {
  return view.cardReading.odds(card)[view.state.contract!.declarer] ?? 0
}

/** The chance partner holds a card we cannot see (the card reading, T3); 0 for one in view */
export function partnerHolds(view: View, card: Card): number {
  return view.cardReading.odds(card)[partnerOf(view.seat)] ?? 0
}

/**
 * The chance of each number of cards of the suit the declarer still holds (index = cards): the
 * card reading's (the lead, both defenders' count signals, vacant places, the auction), kept
 * within `declarerLen` (partner's count after our king). Null when the reading has none
 */
export function declarerOdds(view: View, suit: Suit): number[] | null {
  const p = view.cardReading.lengthOdds(view.state.contract!.declarer, suit)
  if (!p) return null
  const [lo, hi] = declarerLen(view, suit)
  const declarer = view.state.contract!.declarer
  // Counting to thirteen: the declarer's cards left less the fewest the reading leaves in the other suits
  const left = 13 - view.state.play.filter((x) => x.seat === declarer).length
  const most = Math.min(hi, left - SUITS.filter((s) => s !== suit).reduce((n, s) => n + declarerLen(view, s)[0], 0))
  const kept = p.map((w, k) => (k >= lo && k <= most ? w : 0))
  const total = kept.reduce((a, b) => a + b, 0)
  return total > 0 ? kept.map((w) => w / total) : p
}

/** The chance the declarer still holds at least `least` and at most `most` cards of the suit */
export function declarerHas(view: View, suit: Suit, least: number, most = 13): number {
  const p = declarerOdds(view, suit)
  if (!p) {
    const [lo, hi] = declarerLen(view, suit)
    return lo >= least && hi <= most ? 1 : hi < least || lo > most ? 0 : 0.5
  }
  return p.reduce((sum, w, k) => sum + (k >= least && k <= most ? w : 0), 0)
}

/** The honours (A K Q J) neither played nor in view: the declarer's or partner's */
function unseenHonours(view: View): Card[] {
  const seen = new Set<Card>([...view.ownCards(), ...view.dummyCards(), ...view.state.play.map((p) => p.card)])
  const out: Card[] = []
  for (const s of SUITS) for (const r of ['A', 'K', 'Q', 'J']) if (!seen.has(s + r)) out.push(s + r)
  return out
}

/**
 * The tricks dummy's long side suit takes and the declarer's discards on it, by the count: the
 * suit runs as far as dummy's top cards go, and all the way when no defender can hold more cards
 * than those (our own length is exact, the declarer's and partner's from the reading). The
 * declarer discards once out of the suit: run tricks less the declarer's cards (`least` for the
 * fewest discards the count allows, otherwise the most). Null when dummy has no such suit.
 */
export function dummyDiscards(view: View, trump: Suit | null, least: boolean): { suit: Suit; discards: number } | null {
  const dummy = view.dummyCards()
  let best: { suit: Suit; discards: number } | null = null
  for (const s of SUITS) {
    if (s === trump) continue
    const cards = suitCards(dummy, s)
    if (cards.length < 3) continue
    // Dummy's top cards that are masters (counting our cards above them as not out)
    let tops = 0
    for (const c of cards) {
      if (view.higherOut(c).length || ownAbove(view, c)) break
      tops++
    }
    if (!tops) continue
    const mine = suitCards(view.ownCards(), s).length
    const partner = view.reading.len(partnerOf(view.seat), s)[1]
    const dlen = declarerLen(view, s)
    const longest = Math.max(mine, partner, dlen[1])
    const run = longest <= tops ? cards.length : tops
    const discards = run - (least ? dlen[1] : dlen[0])
    if (discards >= 1 && (!best || discards > best.discards)) best = { suit: s, discards }
  }
  return best
}

/** We hold an unplayed card of the suit above the card */
function ownAbove(view: View, card: Card): boolean {
  return suitCards(view.ownCards(), suitOf(card)).some((c) => value(c) > value(card))
}

/**
 * Suit preference from a card of dummy's running suit: the two
 * side suits other than the suit and trumps, high asks for the higher ranking one, low for the
 * lower. Null when there are not two such suits.
 */
export function preferencePair(suit: Suit, trump: Suit | null): [Suit, Suit] | null {
  const pair = SUITS.filter((s) => s !== suit && s !== trump)
  return pair.length === 2 ? [pair[0], pair[1]] : null
}

/**
 * The suit we want partner to lead back: the side suit (of the pair) where we hold a winner, else
 * the one with the most honour points; null when neither. (`View.isMaster` does not see the
 * cards of the trick in progress as still to beat; these are other suits, so it does not matter.)
 */
export function wantedBack(view: View, pair: [Suit, Suit]): Suit | null {
  const own = view.ownCards()
  const master = pair.filter((s) => suitCards(own, s).some((c) => view.isMaster(c)))
  if (master.length === 1) return master[0]
  const points = (s: Suit) => suitCards(own, s).reduce((n, c) => n + hcpOf(c), 0)
  const [a, b] = pair
  if (points(a) === points(b)) return master[0] ?? null
  return points(a) > points(b) ? a : b
}

/**
 * Dummy's long side suit that runs, at the start of the trick beginning at `index`: four cards or
 * more and no unplayed card above dummy's second best outside dummy. The same for both defenders
 * (it does not depend on the defender's own hand), so the one who signals and the one who reads
 * agree on when suit preference replaces count. Trump contracts only.
 */
export function runningSuitAt(view: View, index: number, trump: Suit | null): Suit | null {
  const state = view.state
  const dummy = dummyOf(state)
  if (!trump || !dummy || index < 4) return null
  const gone = new Set(state.play.slice(0, index).map((p) => p.card))
  const held = originalHand(view, dummy).filter((c) => !gone.has(c))
  for (const s of SUITS) {
    if (s === trump) continue
    const cards = suitCards(held, s)
    if (cards.length < 4) continue
    const above = [...RANKS.slice(0, RANKS.indexOf(rankOf(cards[1])))].map((r) => s + r)
    if (above.every((c) => gone.has(c) || cards.includes(c))) return s
  }
  return null
}

/**
 * Partner's suit preference while the declaring side runs dummy's long suit (count means nothing
 * there: dummy shows it): partner's first card following the suit, read by its level. The suit
 * asked for, or null.
 */
export function runningPreference(view: View, trump: Suit | null): Suit | null {
  if (!trump) return null
  const state = view.state
  const partner = partnerOf(view.seat)
  const tricks = tricksOf(state)
  for (let t = 1; t < tricks.length; t++) {
    const trick = tricks[t]
    const run = suitOf(trick.cards[0].card)
    if (!sameSide(trick.leader, state.contract!.declarer) || runningSuitAt(view, t * 4, trump) !== run) continue
    const at = trick.cards.findIndex((p) => p.seat === partner)
    if (at < 0) continue
    const card = trick.cards[at].card
    if (suitOf(card) !== run || value(card) >= 11 || trick.winner === partner) continue
    const pair = preferencePair(run, trump)!
    const level = signalLevel(view, t * 4 + at)
    return level === 'high' ? pair[0] : level === 'low' ? pair[1] : null
  }
  return null
}
