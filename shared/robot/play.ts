import { isBid, strainOf } from '../auction.ts'
import { nextSeat, partnerOf, rankOf, rankValue, sameSide, SEATS, SUITS, suitOf, type Card, type Seat, type Suit } from '../cards.ts'
import { dummyOf, legalCards, remainingCards, tricksOf, type BoardState, type PlayedCard } from '../game.ts'
import type { RobotKind } from '../protocol.ts'
import { declarerLead, exitLead, holdUp } from './declarer.ts'
import { coverLastHonour, defenceLead, dummyOverruffs, holdUpAgainstDummy, secondHand, thirdHand } from './defence.ts'
import { suitCards } from './hand.ts'
import { clubLeadCard, sequenceLead } from './lead-card.ts'
import { byRank, honours, value, View } from './view.ts'

/**
 * A robot's card play from what it can legitimately see: its own hand, dummy once exposed (the
 * declarer also sees its own hand when playing dummy) and the cards already played. It follows
 * the usual club guidelines: lead top of a sequence or fourth best, second hand low, third hand
 * high, win as cheaply as possible, don't overtake partner, ruff when the opponents are winning,
 * discard from length. The declaring side draws trumps and cashes sure winners. The club's robot
 * defends with the club's signals; the 2/1 robot with GIB's published methods (ROBOT.md §3.2).
 * Both read the auction and count the cards (`reading.ts`): the declaring side finesses through
 * the opponent who showed the missing honour, and nobody cashes a winner into a known ruff or
 * leads a suit the opponents bid when there is a choice. The declaring side plays to a plan
 * (`declarer.ts`), the defenders from their inferences (`defence.ts`).
 */

export function chooseCard(state: BoardState, seat: Seat, kind: RobotKind = 'tku'): Card {
  const gib = kind === 'gib'
  const legal = legalCards(state, seat)
  if (legal.length <= 1) return legal[0]
  const contract = state.contract!
  const trump: Suit | null = contract.strain === 'N' ? null : contract.strain
  const tricks = tricksOf(state)
  const current = tricks.at(-1)
  const trick = current && !current.winner ? current.cards : []
  const view = new View(state, seat, kind)

  if (trick.length === 0) return lead(state, seat, view, legal, trump, gib)

  const led = suitOf(trick[0].card)
  const best = winningCard(trick, trump)
  const partner = partnerOf(seat)
  const partnerWinning = best.seat === partner
  const lastToPlay = trick.length === 3
  const following = legal.filter((c) => suitOf(c) === led)
  const lowest = (cards: Card[]) => [...cards].sort(byRank)[0]

  const defending = !sameSide(seat, contract.declarer)
  // A card that signals rather than wins, from the club's methods (橋牌防守信號) or GIB's
  const signal = (cards: Card[]) =>
    !defending ? lowest(cards) : gib ? gibFollow(state, seat, trick, cards) : signalFollow(state, seat, trick, cards, trump)

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
  if (trumps.length && !partnerSafe) {
    const highestTrump = trick.filter((p) => suitOf(p.card) === trump).map((p) => rankValue(rankOf(p.card)))
    const over = trumps.filter((c) => rankValue(rankOf(c)) > Math.max(0, ...highestTrump))
    // Not when dummy, still to play, is seen to overruff (defence.ts)
    if (over.length && !(defending && dummyOverruffs(view, trick, led, lowest(over), trump!))) return lowest(over)
  }
  if (!defending) return discard(view, legal, trump)
  // GIB's discards carry no signal
  if (gib) return gibDiscard(view, legal, trump)
  return signalDiscard(view, legal, trump, led)
}

function lead(state: BoardState, seat: Seat, view: View, legal: Card[], trump: Suit | null, gib: boolean): Card {
  const declarer = state.contract!.declarer
  const declaring = sameSide(seat, declarer)
  const hand = legal
  const nonTrump = SUITS.filter((s) => s !== trump && suitCards(hand, s).length)

  if (state.play.length === 0) return gib ? gibOpeningLead(state, seat, hand, trump) : openingLead(state, seat, hand, trump)

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
    // Cash winners while they last (holding them back for later costs more than it saves)
    for (const s of nonTrump) {
      const top = suitCards(hand, s)[0]
      if (view.isMaster(top) && state.play.length >= 4 && !ruffed(s)) return top
    }
    // Lead the suit partner asked for with a discard (GIB's discards carry no signal)
    const wanted = gib ? null : partnerSignal(state, seat, trump)
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
 * hold the rest of the winners and partner has no winner outside to come back with, so overtake
 * (with the lowest winner) and run the suit from this hand
 */
function unblock(view: View, following: Card[], best: PlayedCard, led: Suit): Card | null {
  if (best.seat !== partnerOf(view.seat) || suitOf(best.card) !== led || !view.isMaster(best.card)) return null
  const partner = view.partnerCards()
  if (suitCards(partner, led).length || following.length < 2) return null
  const winners = following.filter((c) => value(c) > value(best.card) && view.isMaster(c)).sort(byRank)
  if (!winners.length || partner.some((c) => view.isMaster(c))) return null
  return winners[0]
}

/**
 * Third hand on the declaring side, after partner led and second hand played. Partner's honour
 * that loses only to one outstanding card runs, unless the auction places that card behind us.
 * Otherwise take the finesse: the cheapest card that loses only to one outstanding card, unless
 * the auction places it with the last player; then go up with a winner. Null leaves it to the
 * usual third-hand play.
 */
function declarerThird(view: View, seat: Seat, following: Card[], best: PlayedCard, led: Suit, trump: Suit | null): Card | null {
  if (suitOf(best.card) !== led) return null
  const last = nextSeat(seat)
  const behind = (card: Card) => {
    const over = view.higherOut(card)
    return over.length !== 1 || view.reading.holder(over[0]) === last
  }
  const low = [...following].sort(byRank)[0]
  if (best.seat === partnerOf(seat) && value(best.card) >= 10 && !behind(best.card)) return low
  const beaters = following.filter((c) => value(c) > value(best.card)).sort(byRank)
  // The last player showed out of the suit (and cannot ruff): the cheapest card over the trick wins it
  if (beaters.length && best.seat !== partnerOf(seat) && view.reading.isVoid(last, led) && !view.reading.mayRuff(last, led, trump)) return beaters[0]
  const winner = beaters.find((c) => view.isMaster(c))
  if (!beaters.length || winner === beaters[0]) return winner ?? null
  const finesse = beaters.find((c) => !behind(c))
  if (finesse && winner && dropBetter(view, seat, led, finesse)) return winner
  return finesse ?? winner ?? null
}

/**
 * Eight ever, nine never (e6-t41): with nine cards or more between the hands and two masters to
 * cash, play for the missing card to drop rather than finesse, unless the auction places it with
 * the opponent who has already played
 */
function dropBetter(view: View, seat: Seat, led: Suit, finesse: Card): boolean {
  const second = partnerOf(nextSeat(seat))
  const followed = view.state.play.length % 4 >= 2 && suitOf(view.state.play.at(-1)!.card) === led
  if (view.outstanding(led) + (followed ? 1 : 0) > 4) return false
  const ours = [...suitCards(view.ownCards(), led), ...suitCards(view.partnerCards(), led)]
  if (ours.filter((c) => view.isMaster(c)).length < 2) return false
  return view.reading.holder(view.higherOut(finesse)[0]) !== second
}

function openingLead(state: BoardState, seat: Seat, hand: Card[], trump: Suit | null): Card {
  // Which card from a suit: the club's 01 fourth best (lead-card.ts)
  const lead = (s: Suit) => clubLeadCard(suitCards(hand, s), trump)
  // Partner's suit first
  const partnerBid = state.auction.find((c) => c.seat === partnerOf(seat) && isBid(c.call) && strainOf(c.call) !== 'N')
  if (partnerBid && suitCards(hand, strainOf(partnerBid.call) as Suit).length) return lead(strainOf(partnerBid.call) as Suit)
  const suits = SUITS.filter((s) => s !== trump && suitCards(hand, s).length)
  const pool = suits.length ? suits : SUITS.filter((s) => suitCards(hand, s).length)

  if (trump) {
    for (const s of pool) {
      const cards = suitCards(hand, s)
      if (cards.length >= 2 && rankOf(cards[0]) === 'A' && rankOf(cards[1]) === 'K') return lead(s)
    }
    const singleton = pool.find((s) => suitCards(hand, s).length === 1 && suitCards(hand, trump).length > 0)
    if (singleton) return suitCards(hand, singleton)[0]
  }
  for (const s of pool) {
    const seq = sequenceLead(suitCards(hand, s), trump)
    if (seq) return seq
  }
  // Fourth best from the longest suit, keeping out of a suit headed by the ace against a suit
  // contract (from there only the ace itself is led)
  const ranked = [...pool].sort((a, b) => {
    const aceA = trump && rankOf(suitCards(hand, a)[0]) === 'A' ? 1 : 0
    const aceB = trump && rankOf(suitCards(hand, b)[0]) === 'A' ? 1 : 0
    return aceA - aceB || suitCards(hand, b).length - suitCards(hand, a).length
  })
  return lead(ranked[0])
}

/**
 * GIB's opening leads: partner's suit; against a suit contract AK (the king, the ace from AK
 * doubleton), a side-suit singleton or a small doubleton to ruff; the top of a sequence; against
 * notrump a passive lead, from a five-card suit or else a suit without honours; low from three
 * small, fourth best from length
 */
function gibOpeningLead(state: BoardState, seat: Seat, hand: Card[], trump: Suit | null): Card {
  const partnerBid = state.auction.find((c) => c.seat === partnerOf(seat) && isBid(c.call) && strainOf(c.call) !== 'N')
  if (partnerBid) {
    const cards = suitCards(hand, strainOf(partnerBid.call) as Suit)
    if (cards.length) return gibSequenceTop(cards) ?? fourthBest(cards)
  }
  const suits = SUITS.filter((s) => s !== trump && suitCards(hand, s).length)
  const pool = suits.length ? suits : SUITS.filter((s) => suitCards(hand, s).length)
  const holding = (s: Suit) => suitCards(hand, s)
  const longest = (from: Suit[]) => [...from].sort((a, b) => holding(b).length - holding(a).length)[0]

  if (trump) {
    for (const s of pool) {
      const cards = holding(s)
      if (cards.length >= 2 && rankOf(cards[0]) === 'A' && rankOf(cards[1]) === 'K') return cards.length === 2 ? cards[0] : cards[1]
    }
    if (holding(trump).length) {
      const singleton = pool.find((s) => holding(s).length === 1 && !'KQJ'.includes(rankOf(holding(s)[0])))
      if (singleton) return holding(singleton)[0]
    }
  }
  for (const s of pool) {
    const seq = sequenceTop(holding(s))
    if (seq) return rankOf(seq) === 'A' && rankOf(holding(s)[1]) === 'K' ? holding(s)[1] : seq
  }
  if (trump) {
    const doubleton = pool.find((s) => holding(s).length === 2 && value(holding(s)[0]) < 11)
    if (doubleton) return holding(doubleton)[0]
  } else {
    const five = pool.filter((s) => holding(s).length >= 5)
    if (five.length) return fourthBest(holding(longest(five)))
    const passive = pool.filter((s) => holding(s).length >= 3 && honours(holding(s)) === 0)
    if (passive.length) return fourthBest(holding(longest(passive)))
  }
  const ranked = [...pool].sort((a, b) => {
    const aceA = trump && rankOf(holding(a)[0]) === 'A' ? 1 : 0
    const aceB = trump && rankOf(holding(b)[0]) === 'A' ? 1 : 0
    return aceA - aceB || holding(b).length - holding(a).length
  })
  return fourthBest(holding(ranked[0]))
}

/** GIB's lead in partner's suit: the top of a doubleton or a sequence (the king from AK) */
function gibSequenceTop(cards: Card[]): Card | null {
  if (cards.length >= 2 && rankOf(cards[0]) === 'A' && rankOf(cards[1]) === 'K') return cards.length === 2 ? cards[0] : cards[1]
  if (cards.length === 2) return cards[0]
  return sequenceTop(cards)
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
    // Partner's queen (KQ, QJ) asks attitude too: the jack likes it as well
    const like = cards.some((c) => (rankOf(leader.card) === 'Q' ? 'AKJ' : 'AKQ').includes(rankOf(c)))
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
 * Following suit without trying to win, as GIB does:
 * - partner's lead: attitude, standard: a high spot with the ace or king, or with the queen
 *   sitting over dummy's ace or king; otherwise the lowest
 * - otherwise standard count: high then low with an even number
 */
function gibFollow(state: BoardState, seat: Seat, trick: PlayedCard[], cards: Card[]): Card {
  const low = [...cards].sort(byRank)[0]
  if (cards.length === 1) return low
  const leader = trick[0]
  if (leader.seat === partnerOf(seat)) {
    const dummy = dummyOf(state)
    const overDummy =
      dummy !== null &&
      nextSeat(dummy) === seat &&
      suitCards(remainingCards(state, dummy), suitOf(leader.card)).some((c) => 'AK'.includes(rankOf(c)))
    const like = cards.some((c) => 'AK'.includes(rankOf(c))) || (overDummy && cards.some((c) => rankOf(c) === 'Q'))
    return like ? highSpot(cards) : low
  }
  return cards.length % 2 === 0 ? highSpot(cards) : low
}

/**
 * GIB's discards carry no signal, they only keep the hand safe: with trumps left in a suit
 * contract, from the shortest side suit (to ruff later); otherwise from length
 */
function gibDiscard(view: View, legal: Card[], trump: Suit | null): Card {
  if (!trump || !legal.some((c) => suitOf(c) === trump)) return discard(view, legal, trump)
  const candidates = legal.filter((c) => suitOf(c) !== trump && !view.isMaster(c))
  if (!candidates.length) return discard(view, legal, trump)
  const length = (s: Suit) => legal.filter((c) => suitOf(c) === s).length
  const cost = discardCosts(view, legal, trump)
  return [...candidates].sort((a, b) => cost[suitOf(a)] - cost[suitOf(b)] || length(suitOf(a)) - length(suitOf(b)) || byRank(a, b))[0]
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

