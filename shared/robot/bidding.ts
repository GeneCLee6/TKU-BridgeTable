import {
  bidIndex,
  isBid,
  legalCalls,
  levelOf,
  strainOf,
  type AuctionCall,
  type Call,
} from '../auction.ts'
import { partnerOf, sameSide, SEATS, type Card, type Seat, type Strain, type Suit } from '../cards.ts'
import { analyze, longest, stopper, type HandInfo } from './hand.ts'

/**
 * A robot's bidding: a small natural system close to what club players use, so a human partner
 * can follow it. Opening 1NT 15–17, five-card majors, 2♣ strong, weak twos, Stayman, simple
 * overcalls and takeout doubles. Later rounds aim for a contract from the combined strength and
 * the fits shown so far. It is far simpler than BBO's GIB, but every call is legal and sensible.
 */

export interface RobotCall {
  call: Call
  /** Explanation when the call is conventional; the robot alerts it */
  alert?: string
}

/** What a seat has shown so far */
interface Shown {
  min: number
  max: number
  len: Record<Suit, number>
}

const MAJORS: Suit[] = ['S', 'H']
const SUIT_ORDER: Suit[] = ['C', 'D', 'H', 'S']
const bid = (level: number, strain: Strain) => `${level}${strain}`
const isSuit = (strain: Strain): strain is Suit => strain !== 'N'

interface Context {
  seat: Seat
  partner: Seat
  info: HandInfo
  auction: AuctionCall[]
  legal: Set<Call>
  opening?: AuctionCall
  shown: Record<Seat, Shown>
  /** The last bid in the auction */
  last?: AuctionCall
}

export function chooseCall(hand: readonly Card[], seat: Seat, auction: AuctionCall[], dealer: Seat): RobotCall {
  const legal = legalCalls(auction, dealer)
  const ctx: Context = {
    seat,
    partner: partnerOf(seat),
    info: analyze(hand),
    auction,
    legal,
    opening: auction.find((c) => isBid(c.call)),
    shown: inferShown(auction),
    last: auction.findLast((c) => isBid(c.call)),
  }
  const choice = decide(ctx)
  // Anything unexpected falls back to a pass, which is always legal
  return choice && legal.has(choice.call) ? choice : { call: 'P' }
}

function decide(ctx: Context): RobotCall | null {
  const { seat, partner, opening, auction } = ctx
  if (!opening) return openingBid(ctx.info)

  const mine = auction.filter((c) => c.seat === seat && c.call !== 'P')
  const opponentsActed = auction.some((c) => !sameSide(c.seat, seat) && c.call !== 'P')

  if (opening.seat === partner && mine.length === 0 && !opponentsActed) return response(ctx, opening.call)
  if (opening.seat === seat && !opponentsActed) {
    const special = openerContinuation(ctx)
    if (special) return special
  }
  if (opening.seat === partner && !opponentsActed) {
    const special = responderContinuation(ctx)
    if (special) return special
  }
  if (!sameSide(opening.seat, seat)) {
    const ours = auction.filter((c) => sameSide(c.seat, seat) && c.call !== 'P')
    if (ours.length === 0) return overcall(ctx)
    const partnerAction = ours.find((c) => c.seat === partner)
    if (mine.length === 0 && partnerAction) return advance(ctx, partnerAction)
  }
  return target(ctx)
}

// ── Opening ───────────────────────────────────────────────────────────────────────────────────

function openingBid(h: HandInfo): RobotCall {
  if (h.hcp >= 22) return { call: '2C', alert: '22+ 點強牌，人工叫' }
  if (h.balanced && h.hcp >= 20 && h.hcp <= 21) return { call: '2N', alert: '20–21 點平均牌型' }
  if (h.balanced && h.hcp >= 15 && h.hcp <= 17) return { call: '1N', alert: '15–17 點平均牌型' }
  if (h.hcp >= 12) {
    if (h.len.S >= 5 && h.len.S >= h.len.H) return { call: '1S' }
    if (h.len.H >= 5) return { call: '1H' }
    if (h.len.D >= 4 && h.len.D >= h.len.C) return { call: '1D' }
    if (h.len.C >= 3) return { call: '1C' }
    return { call: '1D' }
  }
  if (h.hcp >= 5 && h.hcp <= 10) {
    for (const s of ['S', 'H', 'D', 'C'] as Suit[]) if (h.len[s] >= 7) return { call: bid(3, s) }
    for (const s of ['S', 'H', 'D'] as Suit[]) if (h.len[s] === 6) return { call: bid(2, s), alert: '弱二：6–10 點，6 張' }
  }
  return { call: 'P' }
}

// ── Responding to partner's opening, with the opponents silent ───────────────────────────────

function response(ctx: Context, opened: Call): RobotCall {
  const h = ctx.info
  const strain = strainOf(opened)
  const level = levelOf(opened)

  if (opened === '1N') {
    if (h.hcp >= 8 && (h.len.H === 4 || h.len.S === 4)) return { call: '2C', alert: 'Stayman：問 4 張高花' }
    if (h.hcp >= 10 && h.len.S >= 5) return { call: '3S' }
    if (h.hcp >= 10 && h.len.H >= 5) return { call: '3H' }
    if (h.hcp >= 16) return { call: '6N' }
    if (h.hcp >= 10) return { call: '3N' }
    if (h.hcp >= 8) return { call: '2N' }
    return { call: 'P' }
  }
  if (opened === '2N') {
    if (h.hcp >= 4 && h.len.S >= 5) return { call: '3S' }
    if (h.hcp >= 4 && h.len.H >= 5) return { call: '3H' }
    if (h.hcp >= 12) return { call: '6N' }
    if (h.hcp >= 4) return { call: '3N' }
    return { call: 'P' }
  }
  if (opened === '2C') {
    if (h.hcp >= 8) {
      const s = longest(h)
      if (h.len[s] >= 5) return { call: s === 'S' || s === 'H' ? bid(2, s) : bid(3, s) }
      return { call: '2N' }
    }
    return { call: '2D', alert: '等待叫' }
  }
  if (level === 2 && isSuit(strain)) {
    // Partner's weak two
    if (h.len[strain] >= 3 && h.hcp >= 16) return { call: strain === 'D' ? (h.balanced ? '3N' : '5D') : bid(4, strain) }
    if (h.len[strain] >= 3 && h.hcp >= 8) return { call: bid(3, strain) }
    if (h.hcp >= 18 && h.balanced) return { call: '3N' }
    return { call: 'P' }
  }
  if (level >= 3) {
    if (isSuit(strain) && h.len[strain] >= 2 && h.hcp >= 16) {
      return { call: MAJORS.includes(strain) ? bid(4, strain) : h.balanced ? '3N' : bid(5, strain) }
    }
    return { call: 'P' }
  }

  // Partner opened one of a suit
  const s = strain as Suit
  if (h.hcp < 6) return { call: 'P' }
  const support = h.len[s] >= (MAJORS.includes(s) ? 3 : 5) || (s === 'D' && h.len.D >= 4)
  if (MAJORS.includes(s) && support) {
    if (h.hcp >= 13) return { call: bid(4, s) }
    if (h.hcp >= 10) return { call: bid(3, s) }
    return { call: bid(2, s) }
  }
  // A new suit at the one level, hearts before spades with four of each
  for (const t of ['H', 'S'] as Suit[]) {
    if (SUIT_ORDER.indexOf(t) > SUIT_ORDER.indexOf(s) && h.len[t] >= 4) return { call: bid(1, t) }
  }
  if (s === 'C' && h.len.D >= 4 && h.len.H < 4 && h.len.S < 4) return { call: '1D' }
  if (h.hcp >= 10) {
    const t = longest(h, SUIT_ORDER.filter((x) => x !== s && SUIT_ORDER.indexOf(x) < SUIT_ORDER.indexOf(s)) as Suit[])
    if (t && h.len[t] >= (t === 'H' ? 5 : 4)) return { call: bid(2, t) }
  }
  if (!MAJORS.includes(s) && support) return { call: h.hcp >= 10 ? bid(3, s) : bid(2, s) }
  if (h.balanced && h.hcp >= 13 && h.hcp <= 15) return { call: '3N' }
  if (h.balanced && h.hcp >= 11 && h.hcp <= 12) return { call: '2N' }
  if (h.hcp >= 13) return { call: '3N' }
  return { call: '1N' }
}

// ── Opener's and responder's second calls in an uncontested auction ──────────────────────────

function openerContinuation(ctx: Context): RobotCall | null {
  const { auction, seat, partner, info: h } = ctx
  const myBids = auction.filter((c) => c.seat === seat && c.call !== 'P')
  const partnerBids = auction.filter((c) => c.seat === partner && c.call !== 'P')
  if (myBids.length !== 1 || partnerBids.length !== 1) return null
  const opened = myBids[0].call
  const answer = partnerBids[0].call

  // Notrump openings
  if ((opened === '1N' && answer === '2C') || (opened === '2N' && answer === '3C')) {
    const level = opened === '1N' ? 2 : 3
    if (h.len.H >= 4) return { call: bid(level, 'H') }
    if (h.len.S >= 4) return { call: bid(level, 'S') }
    return { call: bid(level, 'D'), alert: '沒有 4 張高花' }
  }
  if ((opened === '1N' || opened === '2N') && (answer === '3H' || answer === '3S')) {
    const s = strainOf(answer) as Suit
    return { call: h.len[s] >= 3 ? bid(4, s) : '3N' }
  }
  if (opened === '1N' && answer === '2N') return { call: h.hcp >= 16 ? '3N' : 'P' }
  if (opened === '1N' || opened === '2N') return null

  // 2♣ strong, after the 2♦ wait
  if (opened === '2C' && answer === '2D') {
    if (h.balanced) return { call: h.hcp >= 25 ? '3N' : '2N' }
    const s = longest(h)
    return { call: s === 'S' || s === 'H' ? bid(2, s) : bid(3, s) }
  }
  if (opened === '2C') return null

  if (levelOf(opened) !== 1) return null
  const mine = strainOf(opened) as Suit
  const theirs = strainOf(answer)

  // Partner raised our suit
  if (theirs === mine) {
    const raise = levelOf(answer)
    if (raise >= 4) return { call: 'P' }
    const game = MAJORS.includes(mine) ? bid(4, mine) : '3N'
    if (raise === 3) return { call: h.hcp >= 14 ? game : 'P' }
    if (h.hcp >= 18) return { call: game }
    if (h.hcp >= 15) return { call: bid(3, mine) }
    return { call: 'P' }
  }
  // Partner bid notrump
  if (theirs === 'N') {
    const level = levelOf(answer)
    if (level >= 3) return { call: 'P' }
    if (level === 2) return { call: h.hcp >= 13 ? '3N' : 'P' }
    if (h.balanced) return { call: h.hcp >= 18 ? '3N' : h.hcp >= 16 ? '2N' : 'P' }
    if (h.len[mine] >= 6) return { call: h.hcp >= 16 ? bid(3, mine) : bid(2, mine) }
    const second = SUIT_ORDER.filter((s) => s !== mine && SUIT_ORDER.indexOf(s) < SUIT_ORDER.indexOf(mine))
    const other = second.find((s) => h.len[s] >= 4)
    return { call: other ? bid(2, other) : 'P' }
  }
  // Partner bid a new suit: forcing for one round
  const newSuit = theirs as Suit
  const step = levelOf(answer)
  if (h.len[newSuit] >= 4) {
    // A single raise with a minimum, a jump with extras, game in a major with a strong hand
    const raise = h.hcp >= 18 && MAJORS.includes(newSuit) ? 4 : h.hcp >= 15 ? step + 2 : step + 1
    return { call: bid(Math.min(raise, 5), newSuit) }
  }
  if (step === 1) {
    const spades = newSuit === 'H' && mine !== 'S' && h.len.S >= 4
    if (spades) return { call: '1S' }
  }
  if (h.balanced) {
    if (h.hcp >= 18) return { call: '3N' }
    return { call: step === 1 ? '1N' : '2N' }
  }
  if (h.len[mine] >= 6) return { call: h.hcp >= 16 ? bid(3, mine) : cheapestCall(ctx, mine) ?? 'P' }
  const other = SUIT_ORDER.find((s) => s !== mine && s !== newSuit && h.len[s] >= 4 && SUIT_ORDER.indexOf(s) < SUIT_ORDER.indexOf(mine))
  if (other) return { call: cheapestCall(ctx, other) ?? 'P' }
  return { call: cheapestCall(ctx, mine) ?? '2N' }
}

function responderContinuation(ctx: Context): RobotCall | null {
  const { auction, seat, partner, info: h } = ctx
  const myBids = auction.filter((c) => c.seat === seat && c.call !== 'P')
  const partnerBids = auction.filter((c) => c.seat === partner && c.call !== 'P')
  if (myBids.length !== 1 || partnerBids.length !== 2) return null
  const opened = partnerBids[0].call
  const asked = myBids[0].call
  const reply = partnerBids[1].call

  if ((opened === '1N' && asked === '2C') || (opened === '2N' && asked === '3C')) {
    const s = strainOf(reply)
    const fit = (s === 'H' || s === 'S') && h.len[s] >= 4
    const strong = opened === '2N' || h.hcp >= 10
    if (fit) return { call: strong ? bid(4, s) : bid(3, s) }
    // No fit: spades may still fit if opener showed hearts
    if (s === 'H' && h.len.S >= 4 && !strong) return { call: '2S' }
    return { call: strong ? '3N' : '2N' }
  }
  return null
}

// ── Competing after the opponents opened ─────────────────────────────────────────────────────

function overcall(ctx: Context): RobotCall {
  const { info: h, opening, last } = ctx
  if (!opening || !last) return { call: 'P' }
  const theirs = strainOf(opening.call)
  const lastLevel = levelOf(last.call)

  if (lastLevel === 1 && isSuit(theirs) && h.balanced && h.hcp >= 15 && h.hcp <= 18 && stopper(h.cards, theirs))
    return { call: '1N' }

  const unbid = SUIT_ORDER.filter((s) => s !== theirs)
  const shortInTheirs = isSuit(theirs) ? h.len[theirs] <= 2 : false
  const takeout = shortInTheirs && unbid.every((s) => h.len[s] >= 3)
  if (h.hcp >= 12 && takeout && ctx.legal.has('X')) return { call: 'X' }

  const best = longest(h, unbid)
  const minPoints = lastLevel === 1 ? 8 : lastLevel === 2 ? 11 : 15
  if (h.len[best] >= 5 && h.hcp >= minPoints && h.hcp <= 18) {
    const call = cheapestCall(ctx, best)
    if (call && levelOf(call) <= Math.max(2, lastLevel)) return { call }
  }
  if (h.hcp >= 17 && ctx.legal.has('X')) return { call: 'X' }
  return { call: 'P' }
}

/** Partner overcalled or doubled; this is our first call */
function advance(ctx: Context, partnerAction: AuctionCall): RobotCall {
  const { info: h, opening } = ctx
  const theirs = opening ? strainOf(opening.call) : 'N'

  if (partnerAction.call === 'X') {
    const lastByThem = ctx.auction.at(-1)
    // A takeout double must be answered unless the next opponent bid
    const mustBid = lastByThem?.call === 'P'
    const majors = MAJORS.filter((s) => s !== theirs).sort((a, b) => h.len[b] - h.len[a])
    const suit = majors.find((s) => h.len[s] >= 4) ?? longest(h, SUIT_ORDER.filter((s) => s !== theirs))
    if (h.hcp >= 12) {
      if (MAJORS.includes(suit) && h.len[suit] >= 4) return { call: bid(4, suit) }
      if (isSuit(theirs) && stopper(h.cards, theirs)) return { call: '3N' }
    }
    if (isSuit(theirs) && h.balanced && h.hcp >= 6 && h.hcp <= 9 && stopper(h.cards, theirs)) return { call: cheapestCall(ctx, 'N') ?? 'P' }
    const call = cheapestCall(ctx, suit)
    if (call && (mustBid || h.hcp >= 6)) {
      const jump = h.hcp >= 9 ? bid(levelOf(call) + 1, suit) : call
      return { call: ctx.legal.has(jump) && levelOf(jump) <= 3 ? jump : call }
    }
    return { call: 'P' }
  }

  if (isBid(partnerAction.call)) {
    const s = strainOf(partnerAction.call)
    if (isSuit(s) && h.len[s] >= 3 && h.hcp >= 6) {
      const call = cheapestCall(ctx, s)
      if (!call) return { call: 'P' }
      if (h.hcp >= 13 && MAJORS.includes(s)) return { call: bid(4, s) }
      if (h.hcp >= 10 && ctx.legal.has(bid(levelOf(call) + 1, s))) return { call: bid(levelOf(call) + 1, s) }
      return { call: levelOf(call) <= 3 ? call : 'P' }
    }
    if (s === 'N' && h.hcp >= 10) return { call: '3N' }
  }
  return { call: 'P' }
}

// ── Everything else: aim for a contract ──────────────────────────────────────────────────────

/**
 * Picks the contract the partnership should reach from my hand and what partner has shown, and
 * bids it if the auction is below it. Never bids past it, so two robots always settle.
 */
function target(ctx: Context): RobotCall {
  const { info: h, shown, partner, last, seat } = ctx
  const p = shown[partner]
  const partnerPoints = Math.min(p.max, p.min + 2)
  const combined = h.hcp + partnerPoints

  const fits = (['S', 'H', 'D', 'C'] as Suit[]).filter((s) => h.len[s] + p.len[s] >= 8)
  const majorFit = fits.find((s) => MAJORS.includes(s))
  const minorFit = fits.find((s) => !MAJORS.includes(s))

  let strain: Strain
  let level: number
  if (combined >= 33) {
    strain = majorFit ?? (h.balanced || !minorFit ? 'N' : minorFit)
    level = combined >= 37 ? 7 : 6
  } else if (combined >= 25) {
    if (majorFit) [strain, level] = [majorFit, 4]
    else if (minorFit && !h.balanced && combined >= 28) [strain, level] = [minorFit, 5]
    else [strain, level] = ['N', 3]
  } else if (majorFit || minorFit) {
    strain = (majorFit ?? minorFit)!
    level = combined >= 23 ? 3 : 2
  } else {
    return { call: 'P' }
  }

  const goal = bid(level, strain)
  if (!last) return { call: 'P' }
  const ourContract = sameSide(last.seat, seat)
  if (ourContract) {
    // Already high enough, or partner chose a strain we can live with at this level
    if (bidIndex(last.call) >= bidIndex(goal)) return { call: 'P' }
    if (level < 3 || (strainOf(last.call) === strain && levelOf(last.call) >= level - 1 && combined < 25)) return { call: 'P' }
    return { call: goal }
  }
  // The opponents have the contract: compete in a fit, or bid our game
  if (bidIndex(last.call) >= bidIndex(goal)) {
    if (!fits.length || combined < 20) return { call: 'P' }
    const compete = cheapestCall(ctx, strain)
    return compete && levelOf(compete) <= 3 ? { call: compete } : { call: 'P' }
  }
  return { call: combined >= 25 ? goal : cheapestCall(ctx, strain) ?? 'P' }
}

/** The cheapest legal bid in a strain */
function cheapestCall(ctx: Context, strain: Strain): Call | null {
  for (let level = 1; level <= 7; level++) if (ctx.legal.has(bid(level, strain))) return bid(level, strain)
  return null
}

// ── What each seat has shown ─────────────────────────────────────────────────────────────────

function inferShown(auction: readonly AuctionCall[]): Record<Seat, Shown> {
  const shown = {} as Record<Seat, Shown>
  for (const seat of SEATS) shown[seat] = { min: 0, max: 37, len: { S: 0, H: 0, D: 0, C: 0 } }
  const at = (seat: Seat, min: number, max: number, suit?: Suit, len?: number) => {
    const s = shown[seat]
    s.min = Math.max(s.min, min)
    s.max = Math.max(s.min, Math.min(s.max, max))
    if (suit && len) s.len[suit] = Math.max(s.len[suit], len)
  }

  auction.forEach((entry, i) => {
    const before = auction.slice(0, i)
    const opening = before.find((c) => isBid(c.call))
    const { seat, call } = entry
    const partner = partnerOf(seat)
    const contested = before.some((c) => !sameSide(c.seat, opening?.seat ?? seat) && c.call !== 'P')
    const ownEarlier = before.filter((c) => c.seat === seat && c.call !== 'P')
    const partnerEarlier = before.filter((c) => c.seat === partner && c.call !== 'P')

    if (call === 'P') {
      if (!opening) at(seat, 0, 11)
      else if (opening.seat === partner && ownEarlier.length === 0 && !contested) at(seat, 0, 5)
      return
    }
    if (call === 'X') {
      if (opening && !sameSide(opening.seat, seat) && ownEarlier.length === 0) at(seat, 12, 37)
      return
    }
    if (call === 'XX') return

    const strain = strainOf(call)
    const level = levelOf(call)
    const suit = isSuit(strain) ? strain : undefined
    if (!opening) {
      if (call === '1N') at(seat, 15, 17, undefined)
      else if (call === '2N') at(seat, 20, 21)
      else if (call === '2C') at(seat, 22, 37)
      else if (level === 1) at(seat, 12, 21, suit, suit === 'S' || suit === 'H' ? 5 : suit === 'D' ? 4 : 3)
      else if (level === 2) at(seat, 5, 10, suit, 6)
      else at(seat, 5, 10, suit, 7)
      if (call === '1N' || call === '2N') for (const s of SUIT_ORDER) shown[seat].len[s] = Math.max(shown[seat].len[s], 2)
      return
    }
    const partnersOpening = opening.seat === partner
    if (partnersOpening && ownEarlier.length === 0 && !contested) {
      const opened = opening.call
      if (opened === '1N' && call === '2C') return at(seat, 8, 37)
      if (opened === '2C' && call === '2D') return
      if (opened === '1N' || opened === '2N') {
        if (suit) at(seat, opened === '1N' ? 10 : 4, 37, suit, 5)
        else at(seat, call === '2N' ? 8 : 10, call === '2N' ? 9 : 15)
        return
      }
      const openedSuit = strainOf(opened)
      if (strain === openedSuit) {
        at(seat, level >= 4 ? 13 : level === 3 ? 10 : 6, level >= 4 ? 37 : level === 3 ? 12 : 9, suit, 3)
      } else if (strain === 'N') {
        at(seat, level === 1 ? 6 : level === 2 ? 11 : 13, level === 1 ? 10 : level === 2 ? 12 : 15)
      } else {
        at(seat, level === 1 ? 6 : 10, 37, suit, 4)
      }
      return
    }
    // Stayman replies
    if (partnerEarlier.length === 1 && ownEarlier.length === 1 && ownEarlier[0].call === '1N' && partnerEarlier[0].call === '2C') {
      if (suit === 'H' || suit === 'S') at(seat, 15, 17, suit, 4)
      return
    }
    if (opening && !sameSide(opening.seat, seat) && ownEarlier.length === 0 && partnerEarlier.length === 0) {
      if (strain === 'N') at(seat, 15, 18)
      else at(seat, 8, 18, suit, 5)
      return
    }
    // Natural later bids: a suit bid again shows extra length; a raise of partner's suit shows support
    if (suit) {
      const rebid = ownEarlier.some((c) => strainOf(c.call) === suit)
      const raise = partnerEarlier.some((c) => strainOf(c.call) === suit)
      at(seat, 0, 37, suit, rebid ? shown[seat].len[suit] + 1 : raise ? 3 : 4)
    }
  })
  return shown
}

