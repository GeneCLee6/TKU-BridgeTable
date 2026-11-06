import { isBid, strainOf } from '../auction.ts'
import { nextSeat, partnerOf, rankOf, rankValue, RANKS, sameSide, SEATS, SUITS, suitOf, type Card, type Seat, type Suit } from '../cards.ts'
import { legalCards, remainingCards, tricksOf, type BoardState, type PlayedCard } from '../game.ts'
import type { RobotKind } from '../protocol.ts'
import { declarerLead, exitLead, holdUp, secondHandWin } from './declarer.ts'
import { masters } from './declarer-technique.ts'
import { declarerLength, noHurry } from './defence-plan.ts'
import { preferencePair, runningPreference, runningSuitAt, wantedBack } from './defence-reading.ts'
import { cashOut, coverLastHonour, defenceLead, dummyOverruffs, holdUpAgainstDummy, raceSuit, secondHand, thirdHand } from './defence.ts'
import { suitCards } from './hand.ts'
import { clubLeadCard, sequenceLead } from './lead-card.ts'
import { byRank, honours, value, View } from './view.ts'

/**
 * A robot's card play from what it can legitimately see: its own hand, dummy once exposed (the
 * declarer also sees its own hand when playing dummy) and the cards already played. It follows
 * the usual club guidelines: lead top of a sequence or fourth best, second hand low, third hand
 * high, win as cheaply as possible, don't overtake partner, ruff when the opponents are winning,
 * discard from length. The declaring side draws trumps and cashes sure winners. Both robots (the
 * club's and the 2/1 one) play the cards the club's way: its leads, signals and discards
 * (ROBOT.md §3.2). Both read the auction and count the cards (`reading.ts`): the declaring side finesses through
 * the opponent who showed the missing honour, and nobody cashes a winner into a known ruff or
 * leads a suit the opponents bid when there is a choice. The declaring side plays to a plan
 * (`declarer.ts`), the defenders from their inferences (`defence.ts`).
 */

/** Third hand does not finesse when the card reading places the missing card behind it this likely (T3) */
const BEHIND = 0.9
/** With the danger hand last, third hand finesses only when the missing card is with second hand this likely (T3) */
const AVOID = 0.75

export function chooseCard(state: BoardState, seat: Seat, kind: RobotKind = 'tku'): Card {
  const legal = legalCards(state, seat)
  if (legal.length <= 1) return legal[0]
  const contract = state.contract!
  const trump: Suit | null = contract.strain === 'N' ? null : contract.strain
  const tricks = tricksOf(state)
  const current = tricks.at(-1)
  const trick = current && !current.winner ? current.cards : []
  const view = new View(state, seat, kind)

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
  const signal = (cards: Card[]) => (!defending ? lowest(cards) : signalFollow(view, trick, cards, trump))

  if (following.length) {
    // A defender after partner's lead: third hand high, with its exceptions (defence.ts)
    if (defending && trick.length === 2) return thirdHand(view, trick, following, best, led, trump) ?? signal(following)
    if (!defending && trick.length === 2) {
      const card = unblock(view, following, best, led)
      if (card) return card
    }
    if (partnerWinning && (lastToPlay || view.isMaster(best.card))) return signal(following)
    if (!defending) {
      const card = holdUp(view, trick, following, led, trump)
      if (card) return card
    }
    if (!defending && trick.length === 2) {
      const card = declarerThird(view, seat, following, best, led, trump)
      if (card) return card
    }
    if (partnerWinning) {
      // Third hand high: protect partner's lead from the last player, with the lowest of equal cards
      const top = [...following].sort(byRank).at(-1)!
      if (rankValue(rankOf(top)) <= rankValue(rankOf(best.card))) return signal(following)
      return view.lowestEqual(top, following)
    }
    const trumped = trump !== null && suitOf(best.card) === trump && led !== trump
    if (trumped) return signal(following)
    const beaters = following.filter((c) => suitOf(best.card) === led && rankValue(rankOf(c)) > rankValue(rankOf(best.card)))
    if (trick.length === 1 && !defending) {
      // With a master partner cannot match, take the trick (declarer.ts, Y4)
      const card = secondHandWin(view, trick, following, led, trump)
      if (card) return card
    }
    if (trick.length === 1 && defending && beaters.length) {
      // The declarer leads towards dummy's long suit with no other way in: hold up, as fourth hand does
      const card = holdUpAgainstDummy(view, trick, following, led, trump)
      if (card) return card
    }
    if (trick.length === 1) {
      // Second hand low, but cover an honour (the last of dummy's touching honours), and rise
      // over a bare honour in dummy
      const honour = rankValue(rankOf(trick[0].card)) >= 11 && (!defending || coverLastHonour(view, trick))
      if (honour && beaters.length) return lowest(beaters)
      return (defending && secondHand(view, trick, following, led, trump)) || signal(following)
    }
    if (defending && beaters.length) {
      const card = holdUpAgainstDummy(view, trick, following, led, trump)
      if (card) return card
    }
    return beaters.length ? lowest(beaters) : signal(following)
  }

  // Void in the suit led
  const trumps = trump ? legal.filter((c) => suitOf(c) === trump) : []
  const partnerSafe = partnerWinning && (lastToPlay || view.isMaster(best.card))
  if (!defending && trumps.length) {
    // Partner, last to play, wins the trick with a master: keep the long hand's trumps (S3)
    const card = spareLongTrump(view, trick, legal, led, trump!)
    if (card) return card
  }
  if (trumps.length && !partnerSafe) {
    const highestTrump = trick.filter((p) => suitOf(p.card) === trump).map((p) => rankValue(rankOf(p.card)))
    const over = trumps.filter((c) => rankValue(rankOf(c)) > Math.max(0, ...highestTrump))
    if (!defending && over.length) {
      // The defender behind may overruff (the card reading): ruff with a master (S3)
      const card = ruffHigh(view, trick, over, led, trump!)
      if (card) return card
    }
    // Not when dummy, still to play, is seen to overruff (defence.ts)
    if (over.length && !(defending && dummyOverruffs(view, trick, led, lowest(over), trump!))) return lowest(over)
  }
  if (!defending) return discard(view, legal, trump)
  return signalDiscard(view, legal, trump, led)
}

function lead(state: BoardState, seat: Seat, view: View, legal: Card[], trump: Suit | null): Card {
  const declarer = state.contract!.declarer
  const declaring = sameSide(seat, declarer)
  const hand = legal
  const nonTrump = SUITS.filter((s) => s !== trump && suitCards(hand, s).length)

  if (state.play.length === 0) return openingLead(state, seat, view, hand, trump)

  // Counting the cards: an opponent known to be void in a suit, with a trump left, ruffs it
  const opponents = SEATS.filter((s) => !sameSide(s, seat))
  const ruffed = (s: Suit) => opponents.some((o) => view.reading.mayRuff(o, s, trump))

  if (declaring) {
    // The declarer's plan (declarer.ts); the count of the trumps out is exact: every card the
    // declaring side cannot see is a defender's
    const planned = declarerLead(view, hand, trump, ruffed, (suits) => finesseLead(view, seat, hand, suits))
    if (planned) return planned
    // Lead towards partner's winner
    const partnerHand = view.partnerCards()
    for (const s of nonTrump) {
      const theirTop = suitCards(partnerHand, s)[0]
      if (theirTop && view.isMaster(theirTop) && !ruffed(s)) return suitCards(hand, s).at(-1)!
    }
    // Nothing better: the lead that gives the least away (declarer.ts)
    const exit = exitLead(view, hand, trump, ruffed, (s) => opponents.some((o) => view.reading.bid(o, s)))
    if (exit) return exit
  } else {
    // Cash winners while they last (holding them back for later costs more than it saves); in
    // notrump not while the opening lead's suit is still being set up, unless they defeat the
    // contract: a side winner is the entry to the long suit (defence.ts); and not when the
    // declarer's plan gives no reason to hurry (dummy has no running suit to discard on and holds
    // two or more of the suit: defence-plan.ts, Y3)
    const race = raceSuit(view, hand, trump)
    for (const s of nonTrump) {
      const top = suitCards(hand, s)[0]
      if (race && s !== race && !cashOut(view, s, trump)) continue
      if (noHurry(view, s, trump)) continue
      if (view.isMaster(top) && state.play.length >= 4 && !ruffed(s)) return top
    }
    // Lead the suit partner asked for with a discard, or with suit preference while dummy's suit ran (T4)
    const wanted = partnerSignal(state, seat, trump) ?? runningPreference(view, trump)
    if (wanted && suitCards(hand, wanted).length && !ruffed(wanted)) {
      const cards = suitCards(hand, wanted)
      return cards.length === 2 ? cards[0] : cards.at(-1)!
    }
    // Attack or sit tight (defence.ts): partner's opening lead, through dummy's honours, a sequence…
    const card = defenceLead(view, hand, trump, ruffed)
    if (card) return card
  }
  // From length, keeping out of the opponents' suits (bid in the auction, or to be ruffed) when we can
  const pool = nonTrump.length ? nonTrump : SUITS.filter((s) => suitCards(hand, s).length)
  const theirs = (s: Suit) => ruffed(s) || opponents.some((o) => view.reading.bid(o, s))
  const safe = pool.filter((s) => !theirs(s))
  const longestSuit = [...(safe.length ? safe : pool)].sort((a, b) => suitCards(hand, b).length - suitCards(hand, a).length)[0]
  return fourthBest(suitCards(hand, longestSuit))
}

/**
 * Lead low towards partner's tenace (AQ against the king, Kx against the ace): partner has a card
 * that loses only to one outstanding card, and the auction places that card with the next player,
 * who must play before partner. Partner then plays the tenace card (`declarerThird`).
 */
function finesseLead(view: View, seat: Seat, hand: Card[], suits: Suit[]): Card | null {
  const partnerHand = view.partnerCards()
  for (const s of suits) {
    const low = suitCards(hand, s).at(-1)
    const tenace = suitCards(partnerHand, s).find((c) => view.higherOut(c).length === 1)
    if (!low || !tenace || value(low) > value(tenace)) continue
    if (view.reading.holder(view.higherOut(tenace)[0]) === nextSeat(seat)) return low
  }
  return null
}

/**
 * Unblocking on the declaring side: partner's winning card is partner's last of the suit, we
 * hold the rest of the winners, and partner has no winner outside to come back with or this
 * hand has no way in outside (a master in a suit partner can lead; V4c: partner's winners do
 * not bring the lead back here), so overtake (with the lowest winner) and run the suit from here
 */
function unblock(view: View, following: Card[], best: PlayedCard, led: Suit): Card | null {
  if (best.seat !== partnerOf(view.seat) || suitOf(best.card) !== led || !view.isMaster(best.card)) return null
  const partner = view.partnerCards()
  if (suitCards(partner, led).length || following.length < 2) return null
  const winners = following.filter((c) => value(c) > value(best.card) && view.isMaster(c)).sort(byRank)
  if (!winners.length) return null
  // Partner has no winner outside to come back with, or this hand has no way in later (a master
  // in a suit partner can lead)
  const own = view.ownCards()
  const entry = SUITS.some((s) => s !== led && suitCards(own, s)[0] && view.isMaster(suitCards(own, s)[0]) && suitCards(partner, s).length > 0)
  return entry && partner.some((c) => view.isMaster(c)) ? null : winners[0]
}

/**
 * Third hand on the declaring side, after partner led and second hand played. Partner's honour
 * that loses only to one outstanding card runs, unless the card reading all but places that card
 * behind us (nine in ten, T3). Otherwise take the finesse: the cheapest card that loses only to
 * one outstanding card, unless the reading all but places it with the last player; then go up
 * with a winner. In notrump with the last player holding a suit we no longer stop, go up unless
 * the missing card is clearly with second hand; and play for the drop when the odds say so
 * (`dropOdds`). Null leaves it to the usual third-hand play.
 */
function declarerThird(view: View, seat: Seat, following: Card[], best: PlayedCard, led: Suit, trump: Suit | null): Card | null {
  if (suitOf(best.card) !== led) return null
  const last = nextSeat(seat)
  const behind = (card: Card) => {
    const over = view.higherOut(card)
    if (over.length !== 1) return true
    // The card reading must all but place it there (T3): a finesse that may win is worth taking
    return (view.cardReading.odds(over[0])[last] ?? 0) >= BEHIND
  }
  const low = [...following].sort(byRank)[0]
  if (best.seat === partnerOf(seat) && value(best.card) >= 10 && !behind(best.card)) return low
  const beaters = following.filter((c) => value(c) > value(best.card)).sort(byRank)
  // The last player showed out of the suit (and cannot ruff): the cheapest card over the trick wins it
  if (beaters.length && best.seat !== partnerOf(seat) && view.reading.isVoid(last, led) && !view.reading.mayRuff(last, led, trump)) return beaters[0]
  const winner = beaters.find((c) => view.isMaster(c))
  if (!beaters.length || winner === beaters[0]) return winner ?? null
  const finesse = beaters.find((c) => !behind(c))
  // Keep the danger hand off lead (T3): in notrump, when the last player holds the established
  // cards of a suit we no longer stop, a losing finesse would put it in; go up unless the reading
  // clearly places the missing card with second hand
  if (finesse && winner && trump === null && SUITS.some((s) => s !== led && view.cardReading.danger(s) === last)) {
    const missing = view.higherOut(finesse)[0]
    if ((view.cardReading.odds(missing)[partnerOf(last)] ?? 0) < AVOID) return winner
  }
  if (finesse && winner && dropOdds(view, seat, led, finesse)) return winner
  return finesse ?? winner ?? null
}

/**
 * Drop or finesse by the odds (T3, ROBOT.md §3.17): the finesse wins when the missing card is
 * with second hand (it has played); the drop when its holder has no more cards of the suit than
 * the rounds our masters can play (second hand one fewer: this round is played). The chances
 * come from the card reading: the lengths each defender has shown (vacant places), the lead,
 * count signals, the points of the auction.
 */
function dropOdds(view: View, seat: Seat, led: Suit, finesse: Card): boolean {
  const last = nextSeat(seat)
  const second = partnerOf(last)
  const missing = view.higherOut(finesse)[0]
  const reading = view.cardReading
  const ours = [...suitCards(view.ownCards(), led), ...suitCards(view.partnerCards(), led)]
  const rounds = Math.min(ours.filter((c) => view.isMaster(c)).length, Math.max(suitCards(view.ownCards(), led).length, suitCards(view.partnerCards(), led).length))
  const pSecond = reading.odds(missing)[second] ?? 0.5
  const falls = (s: Seat, most: number) => {
    const p = reading.lengthOdds(s, led)
    if (!p) return 0
    const total = p.reduce((sum, w, k) => sum + w * k, 0)
    if (total <= 0) return 0
    // The chance the seat holds the card and at most `most` of the suit
    const share = s === second ? pSecond : 1 - pSecond
    return (share * p.reduce((sum, w, k) => sum + (k <= most ? w * k : 0), 0)) / total
  }
  const drop = falls(last, rounds) + falls(second, rounds - 1)
  return drop > pSecond
}

/**
 * The opening lead (ROBOT.md §3). Which suit, in this order: partner's suit (not the trump suit,
 * which partner bid artificially or as a cue bid); a suit partner showed without naming it (the
 * reading: four or more), against a suit contract after AK and a singleton; against a suit contract AK, a side singleton
 * with a trump, and with trump control (the ace or four trumps) a small doubleton; a sequence;
 * then the longest suit, with the declaring side's suits (shown four or more) after the others,
 * and against a suit contract a suit headed by a lone honour (leading away from it) after the
 * rest and one headed by the ace last. Neither a doubleton nor a sequence is led from their
 * suits. The card from the suit is the club's 01 fourth best (lead-card.ts). From the
 * million-deal study (eval/sim/README.md §8).
 */
function openingLead(state: BoardState, seat: Seat, view: View, hand: Card[], trump: Suit | null): Card {
  const lead = (s: Suit) => clubLeadCard(suitCards(hand, s), trump)
  // A suit the call did not show (Precision's 1♣) is not partner's suit; `reading.namesSuit`
  const partnerBid = state.auction.find(
    (c) => c.seat === partnerOf(seat) && isBid(c.call) && strainOf(c.call) !== 'N' && strainOf(c.call) !== trump && view.reading.namesSuit(partnerOf(seat), strainOf(c.call) as Suit),
  )
  const named = partnerBid && suitCards(hand, strainOf(partnerBid.call) as Suit).length ? (strainOf(partnerBid.call) as Suit) : null
  // Suits partner showed (four or more as the auction reads: a natural bid, a negative double, a
  // two-suited overcall), the one held most of
  const shown = SUITS.filter((s) => s !== trump && view.reading.bid(partnerOf(seat), s) && suitCards(hand, s).length)
  shown.sort((a, b) => suitCards(hand, b).length - suitCards(hand, a).length)
  if (named && (!shown.length || shown.includes(named))) return lead(named)
  // Partner showed a suit without naming it, or named one only as a cue bid or artificially: that
  // suit, against a suit contract after AK and a singleton (single dummy, eval/sim/README.md §11)
  const unnamed = shown[0]
  if (unnamed && !trump) return lead(unnamed)
  const declarer = state.contract!.declarer
  const theirs = (s: Suit) => view.reading.bid(declarer, s) || view.reading.bid(partnerOf(declarer), s)
  const top = (s: Suit) => rankOf(suitCards(hand, s)[0])
  const suits = SUITS.filter((s) => s !== trump && suitCards(hand, s).length)
  const pool = suits.length ? suits : SUITS.filter((s) => suitCards(hand, s).length)

  if (trump) {
    for (const s of pool) {
      const cards = suitCards(hand, s)
      if (cards.length >= 2 && rankOf(cards[0]) === 'A' && rankOf(cards[1]) === 'K') return lead(s)
    }
    const trumps = suitCards(hand, trump)
    const singleton = pool.find((s) => suitCards(hand, s).length === 1 && trumps.length > 0)
    if (singleton) return suitCards(hand, singleton)[0]
    if (unnamed) return lead(unnamed)
    const control = trumps.length >= 4 || (trumps.length > 0 && rankOf(trumps[0]) === 'A')
    const doubleton = control && pool.find((s) => suitCards(hand, s).length === 2 && !'AKQJ'.includes(top(s)) && !theirs(s))
    if (doubleton) return lead(doubleton)
  }
  for (const s of pool) {
    const seq = !theirs(s) && sequenceLead(suitCards(hand, s), trump)
    if (seq) return seq
  }
  // The longest suit, in tiers: against a suit contract a suit headed by the ace last (from there
  // only the ace itself is led); then their suits; against a suit contract a suit headed by a
  // lone honour (away from it) after the rest
  const tier = (s: Suit) => {
    if (trump && top(s) === 'A') return 3
    if (theirs(s)) return 2
    return trump && 'KQJ'.includes(top(s)) ? 1 : 0
  }
  const ranked = [...pool].sort((a, b) => tier(a) - tier(b) || suitCards(hand, b).length - suitCards(hand, a).length)
  return lead(ranked[0])
}

function fourthBest(cards: Card[]): Card {
  if (cards.length >= 4) return cards[3]
  if (cards.length === 2) return cards[0]
  return cards.at(-1)!
}

/**
 * Second hand on the declaring side, void in the suit a defender led, holding more trumps than
 * partner: when partner, last to play, holds a master that beats the card led, and the card
 * reading says the defender in between is not void (so it cannot ruff partner's master), throw
 * a loser that costs nothing (`discardCosts`) instead of ruffing in the long hand (S3,
 * ROBOT.md §3.4): the trick is ours anyway, and the long hand keeps its trump length
 */
function spareLongTrump(view: View, trick: PlayedCard[], legal: Card[], led: Suit, trump: Suit): Card | null {
  if (trick.length !== 1) return null
  const partner = view.partnerCards()
  const myTrumps = suitCards(legal, trump).length
  if (myTrumps <= suitCards(partner, trump).length) return null
  const top = suitCards(partner, led)[0]
  if (!top || value(top) < value(trick[0].card) || !view.isMaster(top)) return null
  const third = nextSeat(view.seat)
  if (view.reading.mayRuff(third, led, trump) || (view.cardReading.lengthOdds(third, led)?.[0] ?? 0) > 0.15) return null
  // A real loser: the lowest card of a suit where this hand holds more cards than our masters win
  const cost = discardCosts(view, legal, trump)
  const losers = SUITS.filter((s) => s !== trump && suitCards(legal, s).length > masters(view, s) && cost[s] === 0)
  if (!losers.length) return null
  const s = [...losers].sort((a, b) => suitCards(legal, b).length - suitCards(legal, a).length)[0]
  return suitCards(legal, s).at(-1)!
}

/** The defender behind is out of the suit led at least this likely: ruff high (S3) */
const OVERRUFF = 0.3

/**
 * Ruffing on the declaring side with a defender still to play after us: when the card reading
 * says it is likely out of the suit too (it showed out, or its length odds) and may hold a trump,
 * ruff with the lowest master trump rather than the lowest trump, which it would overruff (S3,
 * ROBOT.md §3.4). Only in the hand with fewer trumps (dummy, usually): the long hand's high trumps
 * draw the defenders' (ruffing high there gave a trump trick back). Null when the low ruff is
 * safe or no master is left.
 */
function ruffHigh(view: View, trick: PlayedCard[], over: Card[], led: Suit, trump: Suit): Card | null {
  if (trick.length > 2 || view.outstanding(trump) === 0) return null
  // Only in the hand with fewer trumps: the long hand's high trumps are the ones that draw theirs
  if (suitCards(view.ownCards(), trump).length >= suitCards(view.partnerCards(), trump).length) return null
  const next = nextSeat(view.seat)
  if (view.reading.len(next, trump)[1] === 0) return null
  if (view.cardReading.exhausted(next, led) < OVERRUFF) return null
  const low = [...over].sort(byRank)[0]
  if (view.isMaster(low)) return null
  return [...over].sort(byRank).find((c) => view.isMaster(c)) ?? null
}

/** Throw the lowest card from the longest side suit, keeping winners and trumps */
function discard(view: View, legal: Card[], trump: Suit | null): Card {
  const candidates = legal.filter((c) => suitOf(c) !== trump && !view.isMaster(c))
  const pool = candidates.length ? candidates : legal.filter((c) => suitOf(c) !== trump)
  const from = pool.length ? pool : legal
  const length = (s: Suit) => from.filter((c) => suitOf(c) === s).length
  const cost = discardCosts(view, legal, trump)
  return [...from].sort((a, b) => cost[suitOf(a)] - cost[suitOf(b)] || length(suitOf(b)) - length(suitOf(a)) || byRank(a, b))[0]
}

/**
 * What a discard from each suit gives away (the lowest card of the suit goes): a master, an
 * honour left without the guards it needs (a king needs one small card, a queen two…, as many as
 * the cards above it we cannot see), or, for a defender, the length that keeps dummy's long suit
 * from running (dummy holds a card above our second best). 0 when nothing.
 */
function discardCosts(view: View, legal: Card[], trump: Suit | null): Record<Suit, number> {
  const costs = {} as Record<Suit, number>
  const defending = !sameSide(view.seat, view.state.contract!.declarer)
  const dummyCards = defending ? view.dummyCards() : []
  for (const s of SUITS) {
    const mine = suitCards(legal, s)
    let cost = 0
    if (mine.length) {
      if (s === trump) cost += 2
      const low = mine.at(-1)!
      if (view.isMaster(low)) cost += 10
      for (const c of mine) {
        if (value(c) < 11 || view.isMaster(c)) continue
        // An honour and the cards below it in hand; it needs as many as the unseen cards above it
        const below = mine.filter((d) => value(d) < value(c)).length
        if (below <= view.unseenAbove(c).length) cost += 4
      }
      const theirs = suitCards(dummyCards, s)
      if (theirs.length >= mine.length && theirs.length >= 2 && mine[1] && theirs.some((c) => value(c) > value(mine[1]))) cost += 2
      if (defending) cost += declarerLength(view, s, mine, theirs)
    }
    costs[s] = cost
  }
  return costs
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

/** The highest card below the jack, so a signal never wastes an honour */
const highSpotOf = (cards: Card[]) => [...cards].sort(byRank).filter((c) => value(c) < 11).at(-1) ?? [...cards].sort(byRank)[0]

/**
 * Following suit without trying to win, as the club signals:
 * - partner's lead: attitude, reversed (小牌＝歡迎，大牌＝不歡迎); after partner leads a king,
 *   count instead (A、Q 看態度，K 看張數)
 * - declarer's lead: count, standard (先大後小＝偶數張); in notrump, the first suit declarer
 *   plays carries a Smith Echo about the opening lead instead (小牌＝歡迎首攻花色)
 */
function signalFollow(view: View, trick: PlayedCard[], cards: Card[], trump: Suit | null): Card {
  const { state, seat } = view
  const low = [...cards].sort(byRank)[0]
  if (cards.length === 1) return low
  // A high signal from cards that cannot take a trick (ours below outnumber the cards out above):
  // T976 after the QJ are gone signals with the 7, the T and 9 may still win once the AK fall; with
  // fewer than two such cards (T93, the honours gone), the next card up from the lowest
  const played = new Set(state.play.map((p) => p.card))
  const couldWin = (c: Card) => {
    const above = [...RANKS.slice(0, RANKS.indexOf(rankOf(c)))].map((r) => suitOf(c) + r).filter((h) => !played.has(h) && !cards.includes(h)).length
    return above <= cards.filter((d) => value(d) < value(c)).length
  }
  const spare = cards.filter((c) => !couldWin(c))
  const sorted = [...cards].sort(byRank)
  const highSpot = (all: Card[]) => (spare.length >= 2 ? highSpotOf(spare) : couldWin(highSpotOf(all)) && value(sorted[1]) < 11 ? sorted[1] : highSpotOf(all))
  const leader = trick[0]
  const led = suitOf(leader.card)
  const hand = remainingCards(state, seat)
  if (leader.seat === partnerOf(seat)) {
    if (rankOf(leader.card) === 'K') return cards.length % 2 === 0 ? highSpot(cards) : low
    // Partner's queen (KQ, QJ) asks attitude too: the jack likes it as well
    const like = cards.some((c) => (rankOf(leader.card) === 'Q' ? 'AKJ' : 'AKQ').includes(rankOf(c)))
    return like ? low : highSpot(cards)
  }
  // Dummy's long suit runs: the count tells partner nothing, so ask for a suit instead (T4)
  if (trump && runningSuitAt(view, state.play.length - trick.length, trump) === led) {
    const pair = preferencePair(led, trump)!
    const want = wantedBack(view, pair)
    if (want) return want === pair[0] ? highSpot(cards) : low
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
  // Throw from the suit that costs least (never a master, no honour unguarded, no length dummy
  // needs), then the weakest
  const cost = discardCosts(view, legal, trump)
  const throwFrom = sideSuits
    .filter((s) => s !== want && spare(s).length)
    .sort((a, b) => cost[a] - cost[b] || strength(a) - strength(b) || spare(b).length - spare(a).length)[0]
  if (!throwFrom) return discard(view, legal, trump)
  const pool = spare(throwFrom)
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

