import { bidIndex, isBid, legalCalls, levelOf, strainOf, type AuctionCall, type Call } from '../auction.ts'
import { isVulnerable, type Vulnerability } from '../board.ts'
import { partnerOf, rankOf, sameSide, SEATS, type Card, type Seat, type Strain, type Suit } from '../cards.ts'
import { analyze, longest, stopper, suitCards, type HandInfo } from './hand.ts'

/**
 * A robot's bidding in the club's system, as written in TKU BridgeBook 淡江橋譜:
 *
 * - Openings: 1NT 15–17 (a five-card suit only in a minor), five-card majors, 2♦ a weak two in
 *   one major (一高弱二), 2NT 20–21, 2♣ strong, three-level preempts.
 * - 1NT: 2♣ Stayman, 2♦/2♥ transfers, 2♠ minor ask, 2NT invite, 4♦/4♥ Texas, Lebensohl when
 *   the opponents overcall.
 * - 1♥/1♠: 1NT forcing one round, 2/1 game force, the three-card single raise with the club's
 *   long-suit try (1H 2H 淡江用), Bergen raises (松濤版), splinters and J2N (1♠–2NT, 1♥–2♠).
 * - Competition: overcalls, takeout and negative doubles, Unusual 2NT, the club's defence to
 *   Unusual 2NT, and responsive doubles.
 *
 * Later rounds fall back to aiming for a contract from the combined strength and the fits shown.
 * Every call is checked against the legal calls; anything unexpected becomes a pass. Conventional
 * calls carry the explanation from the handbook as their alert.
 */

export interface RobotCall {
  call: Call
  /** Explanation when the call is conventional; the robot alerts it */
  alert?: string
}

interface Shown {
  min: number
  max: number
  len: Record<Suit, number>
}

interface Context {
  seat: Seat
  partner: Seat
  h: HandInfo
  auction: AuctionCall[]
  legal: Set<Call>
  vulnerable: boolean
  opening?: AuctionCall
  /** Our side's calls from the opening on, passes included */
  ours: Call[]
  /** Opponents made a call other than pass after the opening */
  contested: boolean
  shown: Record<Seat, Shown>
  last?: AuctionCall
}

type Rule = RobotCall | null

const MAJORS: Suit[] = ['S', 'H']
const ORDER: Suit[] = ['C', 'D', 'H', 'S']
const bid = (level: number, strain: Strain) => `${level}${strain}`
const isSuit = (strain: Strain): strain is Suit => strain !== 'N'
const other = (major: Suit): Suit => (major === 'S' ? 'H' : 'S')
const said = (call: Call, alert?: string): RobotCall => (alert ? { call, alert } : { call })

export function chooseCall(
  hand: readonly Card[],
  seat: Seat,
  auction: AuctionCall[],
  dealer: Seat,
  vul: Vulnerability = 'None',
): RobotCall {
  const legal = legalCalls(auction, dealer)
  const opening = auction.find((c) => isBid(c.call))
  const from = opening ? auction.indexOf(opening) : auction.length
  const ctx: Context = {
    seat,
    partner: partnerOf(seat),
    h: analyze(hand),
    auction,
    legal,
    vulnerable: isVulnerable(vul, seat),
    opening,
    ours: auction.slice(from).filter((c) => sameSide(c.seat, seat)).map((c) => c.call),
    contested: auction.slice(from).some((c) => !sameSide(c.seat, opening!.seat) && c.call !== 'P'),
    shown: inferShown(auction),
    last: auction.findLast((c) => isBid(c.call)),
  }
  const choice = decide(ctx)
  return choice && legal.has(choice.call) ? choice : { call: 'P' }
}

function decide(ctx: Context): Rule {
  const { opening, seat, partner } = ctx
  if (!opening) return openingBid(ctx)
  const weOpened = sameSide(opening.seat, seat)
  if (weOpened) {
    const rule = opening.seat === partner ? responderRules(ctx) : openerRules(ctx)
    if (rule) return rule
  } else {
    const rule = defenderRules(ctx)
    if (rule) return rule
  }
  return target(ctx)
}

// ── Openings ──────────────────────────────────────────────────────────────────────────────────

function openingBid({ h }: Context): RobotCall {
  const fiveMajor = h.len.S >= 5 || h.len.H >= 5
  if (h.hcp >= 22) return said('2C', '22+ 點強牌，人工叫')
  if (h.balanced && h.hcp >= 20 && h.hcp <= 21) return said('2N', '20–21 點平均牌型')
  if (h.balanced && !fiveMajor && h.hcp >= 15 && h.hcp <= 17) return said('1N', '15–17，3334、4432、5332（五張只能是低花）')
  if (h.hcp >= 12) {
    if (h.len.S >= 5 && h.len.S >= h.len.H) return said('1S')
    if (h.len.H >= 5) return said('1H')
    if (h.len.D > h.len.C) return said('1D')
    if (h.len.C > h.len.D) return said('1C')
    return said(h.len.D >= 4 ? '1D' : '1C')
  }
  if (h.hcp >= 5 && h.hcp <= 10) {
    for (const s of ORDER.slice().reverse()) if (h.len[s] >= 7) return said(bid(3, s))
    if (h.len.S === 6 || h.len.H === 6) return said('2D', '一高弱二：6–10 點，6 張高花')
  }
  return said('P')
}

// ── Our side opened: responder ───────────────────────────────────────────────────────────────

function responderRules(ctx: Context): Rule {
  const { ours, contested } = ctx
  const opened = ours[0]
  const myTurn = Math.floor(ours.length / 2) // 0 for the first response
  if (myTurn === 0) {
    if (!contested) return response(ctx, opened)
    if (opened === '1N') return lebensohl(ctx)
    if ((opened === '1H' || opened === '1S') && overcallOf(ctx) === '2N') return versusUnusual(ctx, opened)
    return contestedResponse(ctx)
  }
  if (!contested) return responderRebid(ctx)
  if (opened === '1N') return lebensohlRebid(ctx)
  return null
}

function response(ctx: Context, opened: Call): Rule {
  const { h } = ctx
  if (opened === '1N') return notrumpResponse(ctx)
  if (opened === '2N') {
    if (h.hcp >= 4 && h.len.S >= 5) return said('3S')
    if (h.hcp >= 4 && h.len.H >= 5) return said('3H')
    if (h.hcp >= 12) return said('6N')
    return said(h.hcp >= 4 ? '3N' : 'P')
  }
  if (opened === '2C') {
    if (h.hcp >= 8) {
      const s = longest(h)
      if (h.len[s] >= 5) return said(MAJORS.includes(s) ? bid(2, s) : bid(3, s))
      return said('2N')
    }
    return said('2D', '等待叫')
  }
  if (opened === '2D') return weakTwoResponse(ctx)
  if (levelOf(opened) >= 3) {
    const s = strainOf(opened) as Suit
    if (h.len[s] >= 2 && h.hcp >= 16) return said(MAJORS.includes(s) ? bid(4, s) : h.balanced ? '3N' : bid(5, s))
    return said('P')
  }
  const s = strainOf(opened) as Suit
  return MAJORS.includes(s) ? majorResponse(ctx, s) : minorResponse(ctx, s)
}

function notrumpResponse({ h }: Context): Rule {
  const fourMajor = h.len.H === 4 || h.len.S === 4
  const longMajor: Suit | null = h.len.S >= 5 && h.len.S >= h.len.H ? 'S' : h.len.H >= 5 ? 'H' : null
  if (longMajor && h.len[longMajor] >= 6 && h.hcp >= 10 && h.hcp <= 15)
    return said(longMajor === 'H' ? '4D' : '4H', `Texas transfer：6 張${longMajor === 'H' ? '♥' : '♠'}↑，有成局力量`)
  // Five of one major and four of the other: Stayman with invitational values
  if (longMajor && h.len[other(longMajor)] === 4 && h.hcp >= 9) return said('2C', 'Stayman：詢問高花')
  if (longMajor) return said(longMajor === 'H' ? '2D' : '2H', `transfer：5 張${longMajor === 'H' ? '♥' : '♠'}↑轉換`)
  if (fourMajor && h.hcp >= 9) return said('2C', 'Stayman：詢問高花，9↑')
  if (h.hcp < 8 && (h.len.C >= 6 || h.len.D >= 6)) return said('2S', '詢問低花，通常是爛牌')
  if (h.hcp >= 17 && h.hcp <= 19) return said('6N')
  if (h.hcp === 16) return said('4N', '15–16，無 4 張高花，邀請 6NT')
  if (h.hcp >= 10) return said('3N')
  if (h.hcp >= 8) return said('2N', '8–10，無 4 張高花，邀請 3NT')
  return said('P')
}

/** Support points: high cards plus shortness, used with four-card support (Bergen counts 牌值) */
function supportPoints(h: HandInfo, trump: Suit) {
  let points = h.hcp
  for (const s of ORDER) if (s !== trump) points += h.len[s] === 0 ? 3 : h.len[s] === 1 ? 2 : h.len[s] === 2 ? 1 : 0
  return points
}

function shortSuit(h: HandInfo, trump: Suit): Suit | null {
  return ORDER.find((s) => s !== trump && h.len[s] <= 1) ?? null
}

function majorResponse(ctx: Context, m: Suit): Rule {
  const { h } = ctx
  const spades = m === 'S'
  const fit = h.len[m]
  if (fit >= 4) {
    const short = shortSuit(h, m)
    if (h.hcp >= 12 && h.hcp <= 13 && short) {
      const void_ = h.len[short] === 0
      if (void_) return said(spades ? '3N' : '3S', `12–13，4+${spades ? '♠' : '♥'}，一門 void`)
      const splinter = spades ? bid(4, short) : short === 'S' ? '3N' : bid(4, short)
      return said(splinter, `12–13，4+${spades ? '♠' : '♥'}，${symbol(short)}單張`)
    }
    if (h.hcp >= 12) return said(spades ? '2N' : '2S', `J2N：${spades ? '♠' : '♥'} fit，迫叫成局`)
    const sp = supportPoints(h, m)
    const steps = spades ? ['3C', '3D', '3H', '3S'] : ['2N', '3C', '3D', '3H']
    if (sp >= 10) return said(steps[0], `Bergen：10–11，4 張${spades ? '♠' : '♥'}`)
    if (sp >= 8) return said(steps[1], 'Bergen：8–9，4 張王')
    if (sp >= 6) return said(steps[2], 'Bergen：6–7，4 張王')
    if (sp >= 4) return said(steps[3], 'Bergen：4–5，4 張王')
    return said('P')
  }
  if (fit === 3) {
    if (h.hcp >= 13) return said(spades ? '2N' : '2S', `J2N：${spades ? '♠' : '♥'} fit，迫叫成局`)
    if (h.hcp >= 8 && h.hcp <= 10) return said(bid(2, m), `3 張${spades ? '♠' : '♥'}，8–10`)
  }
  if (h.hcp < 6) return said('P')
  if (!spades && h.len.S >= 4 && (fit < 3 || h.hcp < 8)) return said('1S', '6↑，迫叫')
  if (h.hcp >= 12 && fit < 3) {
    if (!spades || h.len.H < 5) {
      if (spades && h.len.H >= 5) return said('2H', '12+，迫叫成局，5 張♥↑')
    } else return said('2H', '12+，迫叫成局，5 張♥↑')
    if (h.len.D >= (spades ? 4 : 5) && h.len.D > h.len.C) return said('2D', `12+，迫叫成局，${spades ? 4 : 5} 張♦↑`)
    if (!spades && h.len.S >= 4) return said('1S', '6↑，迫叫')
    return said('2C', '12+，迫叫成局')
  }
  return said('1N', '6–12，迫叫一圈')
}

function minorResponse({ h }: Context, s: Suit): Rule {
  if (h.hcp < 6) return said('P')
  for (const t of ['H', 'S'] as Suit[]) if (h.len[t] >= 4 && h.len[t] >= h.len[other(t)]) return said(bid(1, t))
  for (const t of ['H', 'S'] as Suit[]) if (h.len[t] >= 4) return said(bid(1, t))
  if (s === 'C' && h.len.D >= 4) return said('1D')
  const support = h.len[s] >= (s === 'C' ? 5 : 4)
  if (h.hcp >= 11 && s === 'D' && h.len.C >= 4) return said('2C')
  if (support && h.hcp <= 10) return said(h.hcp >= 10 ? bid(3, s) : bid(2, s))
  if (h.balanced && h.hcp >= 13) return said('3N')
  if (h.balanced && h.hcp >= 11) return said('2N')
  if (h.hcp >= 11) return said(bid(3, s))
  return said('1N')
}

/** 2♦ (一高弱二): pass-or-correct and the 2NT ask */
function weakTwoResponse({ h }: Context): Rule {
  if (h.hcp >= 15) return said('2N', '詢問')
  if (h.hcp >= 12 && (h.len.C >= 6 || h.len.D >= 6)) return said(h.len.C >= h.len.D ? '3C' : '3D', '6 張，迫叫')
  if (h.hcp >= 13 && h.len.H >= 3 && h.len.S >= 3) return said('4H', 'P/C：同伴 ♥ 就派司，♠ 改 4♠')
  if (h.len.D >= 5 && h.len.H <= 1 && h.len.S <= 1) return said('P')
  if (h.len.H <= 1 && h.len.S >= 3) return said('2S', 'P/C')
  return said('2H', 'P/C')
}

/** Responder's second and later calls, opponents silent */
function responderRebid(ctx: Context): Rule {
  const { ours, h } = ctx
  const [opened, mine, theirs] = ours
  if (theirs === undefined || ours.length !== 3) return null

  // 1NT: transfers, Stayman, minor ask
  if (opened === '1N') {
    if (mine === '2D' || mine === '2H') {
      const m: Suit = mine === '2D' ? 'H' : 'S'
      if (theirs === bid(3, m)) return said(h.hcp >= 5 ? bid(4, m) : 'P')
      if (h.len[m] >= 6) return said(h.hcp >= 8 ? bid(3, m) : 'P')
      if (h.hcp >= 10) return said('3N')
      if (h.hcp >= 8) return said('2N', `5 張${m === 'H' ? '♥' : '♠'}，邀請`)
      return said('P')
    }
    if (mine === '2C') {
      const s = strainOf(theirs)
      const fit = (s === 'H' || s === 'S') && h.len[s] >= 4
      const game = h.hcp >= 10
      if (fit) return said(game ? bid(4, s) : bid(3, s))
      if (s === 'H' && h.len.S >= 4 && !game) return said('2N')
      return said(game ? '3N' : '2N')
    }
    if (mine === '2S') {
      if (h.len.C >= 6 && theirs === '3C') return said('P')
      if (h.len.C >= 6) return said('3C')
      return said('3D')
    }
    return null
  }

  // 2♦ weak two: pass or correct, then the answers to 2NT
  if (opened === '2D') {
    if (mine === '2N') {
      const heart = theirs === '3C' || theirs === '3S'
      const high = theirs === '3H' || theirs === '3S'
      const m: Suit = heart ? 'H' : 'S'
      const game = h.hcp + (high ? 9 : 7) >= 24 && h.len[m] >= 2
      return said(game ? bid(4, m) : h.len[m] >= 2 ? bid(3, m) : '3N')
    }
    return said('P')
  }

  // Single raise of a major, 淡江用: answer the long-suit try or the invitation
  if ((opened === '1H' || opened === '1S') && mine === bid(2, strainOf(opened))) {
    const m = strainOf(opened) as Suit
    if (theirs === bid(3, m)) return said(h.hcp >= 10 ? bid(4, m) : 'P')
    const tried = strainOf(theirs)
    if (isSuit(tried) && tried !== m && levelOf(theirs) <= 3) {
      const help = suitCards(h.cards, tried).slice(0, 2).some((c) => 'AKQ'.includes(rankOf(c))) || h.len[tried] <= 1
      return said(h.hcp >= 9 || help ? bid(4, m) : bid(3, m))
    }
    return null
  }

  // 1NT forcing with three-card support: preference or the delayed limit raise
  if ((opened === '1H' || opened === '1S') && mine === '1N') {
    const m = strainOf(opened) as Suit
    if (h.len[m] >= 3) return said(h.hcp >= 10 ? bid(3, m) : bid(2, m))
    if (h.len[m] === 2 && strainOf(theirs) !== m && isSuit(strainOf(theirs)) && h.len[strainOf(theirs) as Suit] < 4)
      return said(bid(2, m))
    return null
  }
  return null
}

// ── Our side opened: opener ──────────────────────────────────────────────────────────────────

function openerRules(ctx: Context): Rule {
  const { ours, contested, h } = ctx
  if (ours.length !== 2 && !(contested && ours.length === 2)) return null
  const [opened, answer] = ours
  if (answer === 'P') return null

  if (contested) {
    // Lebensohl relay, penalty double, Unusual 2NT defence, negative double
    if (opened === '1N') {
      if (answer === '2N') return said('3C', 'Lebensohl：完成接力')
      if (answer === 'X') return said('P')
      if (isBid(answer) && levelOf(answer) === 3 && isSuit(strainOf(answer))) {
        const s = strainOf(answer) as Suit
        const theirs = overcallSuit(ctx)
        if (MAJORS.includes(s) && h.len[s] >= 3) return said(bid(4, s))
        return said(theirs && stopper(h.cards, theirs) ? '3N' : MAJORS.includes(s) ? bid(4, s) : '3N')
      }
      return said('P')
    }
    if ((opened === '1H' || opened === '1S') && overcallOf(ctx) === '2N') return openerVersusUnusual(ctx, opened, answer)
    if (answer === 'X') return openerAfterNegativeDouble(ctx, opened)
    return null
  }

  if (opened === '1N') {
    if (answer === '2C') {
      if (h.len.H >= 4) return said('2H')
      if (h.len.S >= 4) return said('2S')
      return said('2D', '無 4 張高花')
    }
    if (answer === '2D' || answer === '2H') {
      const m: Suit = answer === '2D' ? 'H' : 'S'
      return h.len[m] >= 4 && h.hcp >= 17 ? said(bid(3, m), '4 張王，17 點好牌') : said(bid(2, m))
    }
    if (answer === '4D') return said('4H')
    if (answer === '4H') return said('4S')
    if (answer === '2S') return h.len.C >= h.len.D ? said('3C') : said('2N', '♦ 較好')
    if (answer === '2N') return said(h.hcp >= 16 ? '3N' : 'P')
    if (answer === '4N') return said(h.hcp >= 16 ? '6N' : 'P')
    if (isBid(answer) && levelOf(answer) === 3 && isSuit(strainOf(answer))) {
      const s = strainOf(answer) as Suit
      return said(h.len[s] >= 3 ? (MAJORS.includes(s) ? bid(4, s) : bid(4, s)) : '3N')
    }
    return said('P')
  }
  if (opened === '2C' && answer === '2D') {
    if (h.balanced) return said(h.hcp >= 25 ? '3N' : '2N')
    const s = longest(h)
    return said(MAJORS.includes(s) ? bid(2, s) : bid(3, s))
  }
  if (opened === '2D') {
    const m: Suit = h.len.H >= 6 ? 'H' : 'S'
    const high = h.hcp >= 9
    if (answer === '2N') {
      const reply = m === 'H' ? (high ? '3S' : '3C') : high ? '3H' : '3D'
      return said(reply, `${m === 'H' ? '♥' : '♠'}${high ? '高限' : '低限'}`)
    }
    if (answer === '2H') return said(m === 'H' ? 'P' : '2S')
    if (answer === '2S') return said(m === 'S' ? 'P' : '3H')
    if (answer === '3H') return said(m === 'H' ? 'P' : '3S')
    if (answer === '3S') return said(m === 'S' ? 'P' : '4H')
    if (answer === '4H') return said(m === 'H' ? 'P' : '4S')
    return said('P')
  }
  if (opened === '1H' || opened === '1S') return majorRebid(ctx, strainOf(opened) as Suit, answer)
  if (opened === '1C' || opened === '1D') return minorRebid(ctx, strainOf(opened) as Suit, answer)
  return null
}

function majorRebid(ctx: Context, m: Suit, answer: Call): Rule {
  const { h } = ctx
  const spades = m === 'S'
  const game = bid(4, m)
  // Bergen raises
  const bergen = spades ? ['3C', '3D', '3H', '3S'] : ['2N', '3C', '3D', '3H']
  const needed = [14, 15, 17, 19]
  const step = bergen.indexOf(answer)
  if (step >= 0) return said(h.hcp >= needed[step] ? game : step === 3 ? 'P' : bid(3, m))
  // J2N: game, or slam when the hands are clearly strong enough
  if (answer === (spades ? '2N' : '2S')) return said(h.hcp >= 19 ? bid(6, m) : game)
  // Splinters
  const splinters = spades ? ['3N', '4C', '4D', '4H'] : ['3S', '3N', '4C', '4D']
  if (splinters.includes(answer)) return said(h.hcp >= 18 ? bid(6, m) : game)
  if (answer === game) return said('P')
  // Single raise, 淡江用: long-suit try or invitation
  if (answer === bid(2, m)) {
    if (h.hcp >= 19) return said(game)
    if (h.hcp >= 16) {
      const tries = ORDER.filter((s) => s !== m && h.len[s] >= 3)
      const weak = tries.find((s) => suitCards(h.cards, s).filter((c) => 'AK'.includes(rankOf(c))).length <= 1)
      if (weak) {
        const call = cheapest(ctx, weak)
        if (call && levelOf(call) <= 3) return said(call, `長門邀請，至少迫叫至 3${spades ? '♠' : '♥'}`)
      }
      return said(bid(3, m), '旁門無 4 張之邀請')
    }
    return said('P')
  }
  // 1NT forcing one round
  if (answer === '1N') {
    if (h.len[m] >= 6) return said(h.hcp >= 16 ? bid(3, m) : bid(2, m))
    if (spades && h.len.H >= 4) return said('2H')
    const minor: Suit = h.len.D > h.len.C ? 'D' : h.len.C > h.len.D ? 'C' : h.len.C >= 3 ? 'C' : 'D'
    if (h.balanced && h.hcp >= 18) return said('2N')
    return said(bid(2, minor))
  }
  // Responder's new suit (1♠ over 1♥, or a 2/1 game force)
  const s = strainOf(answer)
  if (isSuit(s) && s !== m) {
    const twoOverOne = levelOf(answer) === 2
    if (h.len[s] >= 4 || (MAJORS.includes(s) && h.len[s] >= 3 && twoOverOne && s === 'H')) {
      if (!twoOverOne) return said(h.hcp >= 18 ? bid(4, s) : h.hcp >= 15 ? bid(3, s) : bid(2, s))
      return said(bid(3, s))
    }
    if (h.len[m] >= 6) return said(cheapest(ctx, m) ?? 'P')
    const side = ORDER.find((x) => x !== m && x !== s && h.len[x] >= 4)
    if (side) {
      const call = cheapest(ctx, side)
      if (call && levelOf(call) <= (twoOverOne ? 3 : 2)) return said(call)
    }
    if (h.balanced) return said(twoOverOne ? '2N' : h.hcp >= 18 ? '2N' : '1N')
    return said(cheapest(ctx, m) ?? 'P')
  }
  return null
}

function minorRebid(ctx: Context, mine: Suit, answer: Call): Rule {
  const { h } = ctx
  const s = strainOf(answer)
  const level = levelOf(answer)
  if (s === mine) {
    if (level >= 3) return said(h.hcp >= 15 && h.balanced ? '3N' : 'P')
    return said(h.hcp >= 18 ? '3N' : h.hcp >= 16 ? bid(3, mine) : 'P')
  }
  if (s === 'N') {
    if (level >= 3) return said('P')
    if (level === 2) return said(h.hcp >= 13 ? '3N' : 'P')
    return said(h.hcp >= 18 ? '3N' : h.hcp >= 16 && h.balanced ? '2N' : h.len[mine] >= 6 ? bid(2, mine) : 'P')
  }
  if (!isSuit(s)) return null
  if (h.len[s] >= 4) return said(h.hcp >= 18 && MAJORS.includes(s) ? bid(4, s) : h.hcp >= 15 ? bid(level + 1, s) : bid(level === 1 ? 2 : level, s))
  if (s === 'H' && h.len.S >= 4) return said('1S')
  if (h.balanced) return said(h.hcp >= 18 ? '2N' : level === 1 ? '1N' : '2N')
  if (h.len[mine] >= 6) return said(cheapest(ctx, mine) ?? 'P')
  const side = ORDER.find((x) => x !== mine && x !== s && h.len[x] >= 4 && ORDER.indexOf(x) < ORDER.indexOf(mine))
  if (side) return said(cheapest(ctx, side) ?? 'P')
  return said(cheapest(ctx, mine) ?? '1N')
}

// ── Competition after our opening ────────────────────────────────────────────────────────────

/** The opponents' first call after our opening */
function overcallOf(ctx: Context): Call | undefined {
  const { auction, opening } = ctx
  return auction.slice(auction.indexOf(opening!) + 1).find((c) => !sameSide(c.seat, opening!.seat) && c.call !== 'P')?.call
}

function overcallSuit(ctx: Context): Suit | null {
  const call = overcallOf(ctx)
  return call && isBid(call) && isSuit(strainOf(call)) ? (strainOf(call) as Suit) : null
}

/** Partner opened 1NT and the next player overcalled: Lebensohl (雷本索) */
function lebensohl(ctx: Context): Rule {
  const { h } = ctx
  const call = overcallOf(ctx)
  if (!call || !isBid(call)) return null
  const theirs = overcallSuit(ctx)
  if (!theirs || levelOf(call) !== 2) return null
  const held = stopper(h.cards, theirs)
  if (h.len[theirs] >= 4 && h.hcp >= 8) return said('X', '處罰')
  const five = ORDER.filter((s) => s !== theirs && h.len[s] >= 5).sort((a, b) => h.len[b] - h.len[a])[0]
  if (five && h.hcp >= 10) return said(bid(3, five), '5 張+，迫叫成局，10+')
  if (h.hcp >= 10) return held ? said('2N', 'Lebensohl：迫叫 3♣（之後 3NT 表示有擋）') : said('3N', '有成局點，無高花，敵叫花色沒擋')
  if (five && h.hcp >= 5) {
    const two = bid(2, five)
    if (ctx.legal.has(two)) return said(two, '5 張+不迫叫，5–8')
    if (h.len[five] >= 6) return said('2N', 'Lebensohl：迫叫 3♣')
  }
  return said('P')
}

function lebensohlRebid(ctx: Context): Rule {
  const { ours, h } = ctx
  if (ours.length !== 3 || ours[1] !== '2N' || ours[2] !== '3C') return null
  if (h.hcp >= 10) return said('3N', '成局點，有擋，無高花')
  const theirs = overcallSuit(ctx)
  const long = ORDER.filter((s) => s !== theirs && h.len[s] >= 6).sort((a, b) => h.len[b] - h.len[a])[0]
  if (!long || long === 'C') return said('P')
  return said(bid(3, long))
}

/** We opened 1♥/1♠ and they bid Unusual 2NT: the club's defence */
function versusUnusual(ctx: Context, opened: Call): Rule {
  const { h } = ctx
  const m = strainOf(opened) as Suit
  const o = other(m)
  const hearts = m === 'H'
  const fitCue = hearts ? '3C' : '3D'
  const otherGF = hearts ? '3D' : '3C'
  if (h.len[m] >= 4 && h.hcp >= 6 && h.hcp <= 9 && shortSuit(h, m)) return said(bid(4, m), `4 張${symbol(m)}↑，6–9，牌型牌`)
  if (h.len[m] >= 3 && h.hcp >= 10) return said(fitCue, `${symbol(m)} fit，至少邀請點，迫叫至 3${symbol(m)}`)
  if (h.len[o] >= 5 && h.hcp >= 13) return said(otherGF, `5 張${symbol(o)}↑，至少成局點`)
  if ((h.len[o] >= 5 && h.hcp >= 10) || (h.len[o] >= 6 && h.hcp >= 8)) return said(bid(3, o), `5 張${symbol(o)}，10–12 或 6 張 8–10，不迫叫`)
  if (h.len[m] >= 3 && h.hcp >= 6) return said(bid(3, m))
  if (h.balanced && h.hcp >= 10) return said('X', `平均牌型，${symbol(m)}不 fit，至少邀請點，建議處罰`)
  return said('P')
}

function openerVersusUnusual(ctx: Context, opened: Call, answer: Call): Rule {
  const { h } = ctx
  const m = strainOf(opened) as Suit
  const o = other(m)
  const hearts = m === 'H'
  const fitCue = hearts ? '3C' : '3D'
  const otherGF = hearts ? '3D' : '3C'
  if (answer === fitCue) return said(h.hcp >= 15 ? bid(4, m) : bid(3, m))
  if (answer === otherGF) {
    if (h.len[o] >= 3) return said(bid(4, o))
    if (h.len[m] >= 6) return said(bid(4, m))
    return said(stopper(h.cards, 'C') && stopper(h.cards, 'D') ? '3N' : bid(4, m))
  }
  if (answer === bid(3, o)) return said(h.len[o] >= 3 && h.hcp >= 14 ? bid(4, o) : 'P')
  if (answer === bid(3, m)) return said(h.hcp >= 17 ? bid(4, m) : 'P')
  return said('P')
}

/** Partner opened, the next player overcalled, and this is our first call */
function contestedResponse(ctx: Context): Rule {
  const { h, ours } = ctx
  const opened = ours[0]
  if (!isBid(opened)) return null
  const mine = strainOf(opened)
  const theirs = overcallSuit(ctx)
  if (!theirs || !ctx.last) return null
  if (isSuit(mine) && h.len[mine] >= (MAJORS.includes(mine) ? 3 : 5) && h.hcp >= 6) {
    const call = cheapest(ctx, mine)
    if (!call) return null
    if (h.hcp >= 13 && MAJORS.includes(mine)) return said(bid(4, mine))
    if (h.hcp >= 10 && ctx.legal.has(bid(levelOf(call) + 1, mine))) return said(bid(levelOf(call) + 1, mine))
    return levelOf(call) <= 3 ? said(call) : said('P')
  }
  const five = ORDER.filter((s) => s !== theirs && s !== mine && h.len[s] >= 5).sort((a, b) => h.len[b] - h.len[a])[0]
  if (five) {
    const call = cheapest(ctx, five)
    if (call && (levelOf(call) === 1 ? h.hcp >= 6 : h.hcp >= 10)) return said(call)
  }
  const unbidMajors = MAJORS.filter((s) => s !== theirs && s !== mine && h.len[s] >= 4)
  if (unbidMajors.length && h.hcp >= 7 && levelOf(ctx.last.call) <= 2 && ctx.legal.has('X')) return said('X', '負性賭倍')
  if (stopper(h.cards, theirs) && h.hcp >= 8) {
    const nt = cheapest(ctx, 'N')
    if (nt && levelOf(nt) <= 2) return said(h.hcp >= 11 && levelOf(nt) === 1 ? '2N' : nt)
    if (h.hcp >= 13) return said('3N')
  }
  return said('P')
}

function openerAfterNegativeDouble(ctx: Context, opened: Call): Rule {
  const { h } = ctx
  const theirs = overcallSuit(ctx)
  const majors = MAJORS.filter((s) => s !== theirs && s !== strainOf(opened) && h.len[s] >= 4)
  if (majors.length) {
    const call = cheapest(ctx, majors[0])
    if (call) return said(h.hcp >= 15 && ctx.legal.has(bid(levelOf(call) + 1, majors[0])) ? bid(levelOf(call) + 1, majors[0]) : call)
  }
  if (theirs && h.balanced && stopper(h.cards, theirs)) return said(cheapest(ctx, 'N') ?? 'P')
  const own = strainOf(opened)
  return said(isSuit(own) ? (cheapest(ctx, own) ?? 'P') : 'P')
}

// ── The opponents opened ─────────────────────────────────────────────────────────────────────

function defenderRules(ctx: Context): Rule {
  const { auction, seat, partner, h } = ctx
  const ourCalls = auction.filter((c) => sameSide(c.seat, seat) && c.call !== 'P')
  const mine = ourCalls.filter((c) => c.seat === seat)
  const partners = ourCalls.filter((c) => c.seat === partner)
  if (ourCalls.length === 0) return overcall(ctx)

  // Responsive double: they opened, partner doubled, the next player raised
  const theirs = auction.filter((c) => !sameSide(c.seat, seat) && isBid(c.call))
  const opened = theirs[0]
  if (mine.length === 0 && partners.length === 1 && partners[0].call === 'X' && theirs.length === 2) {
    const o = strainOf(opened.call)
    const raised = strainOf(theirs[1].call) === o && bidIndex(theirs[1].call) <= bidIndex('3S')
    if (raised && isSuit(o) && h.hcp >= 6 && h.hcp <= 11 && ctx.legal.has('X')) {
      const unbid = ORDER.filter((s) => s !== o)
      const fiveMajor = MAJORS.some((s) => s !== o && h.len[s] >= 5)
      const twoSuits = MAJORS.includes(o)
        ? (h.len.C >= 4 && h.len.D >= 4) || (h.len[other(o)] === 3 && !unbid.some((s) => h.len[s] >= 5))
        : h.len.H >= 4 && h.len.S >= 4
      if (twoSuits && !fiveMajor) return said('X', '回答性賭倍：6–11')
    }
  }
  // Answering partner's responsive double
  if (mine.length === 1 && mine[0].call === 'X' && partners.length === 1 && partners[0].call === 'X') {
    const o = strainOf(opened.call) as Suit
    const choices = (MAJORS.includes(o) ? [other(o), 'D', 'C'] : ['S', 'H', 'D', 'C']).filter((s) => s !== o) as Suit[]
    const pick = choices.find((s) => h.len[s] >= 4) ?? longest(h, choices)
    return said(cheapest(ctx, pick) ?? 'P')
  }
  if (mine.length === 0 && partners.length) return advance(ctx, partners[0])
  return null
}

function overcall(ctx: Context): Rule {
  const { h, opening, last, vulnerable } = ctx
  if (!opening || !last) return said('P')
  const theirs = strainOf(opening.call)
  const lastLevel = levelOf(last.call)

  // Unusual 2NT: both minors 5-5 over a major, 8–10 vulnerable, 6–8 not
  if ((opening.call === '1H' || opening.call === '1S') && last === opening && h.len.C >= 5 && h.len.D >= 5) {
    const [lo, hi] = vulnerable ? [8, 10] : [6, 8]
    if (h.hcp >= lo && h.hcp <= hi) return said('2N', `不尋常 2NT：兩低 5-5↑，${lo}–${hi}`)
  }
  if (lastLevel === 1 && isSuit(theirs) && h.balanced && h.hcp >= 15 && h.hcp <= 18 && stopper(h.cards, theirs))
    return said('1N')

  const unbid = ORDER.filter((s) => s !== theirs)
  const takeout = isSuit(theirs) && h.len[theirs] <= 2 && unbid.every((s) => h.len[s] >= 3)
  if (h.hcp >= 12 && takeout && ctx.legal.has('X')) return said('X')

  const best = longest(h, unbid)
  const minPoints = lastLevel === 1 ? 8 : lastLevel === 2 ? 11 : 15
  if (h.len[best] >= 5 && h.hcp >= minPoints && h.hcp <= 18) {
    const call = cheapest(ctx, best)
    if (call && levelOf(call) <= Math.max(2, lastLevel)) return said(call)
  }
  if (h.hcp >= 17 && ctx.legal.has('X')) return said('X')
  return said('P')
}

/** Partner overcalled or doubled; this is our first call */
function advance(ctx: Context, partnerAction: AuctionCall): Rule {
  const { h, opening } = ctx
  const theirs = opening ? strainOf(opening.call) : 'N'

  if (partnerAction.call === 'X') {
    const mustBid = ctx.auction.at(-1)?.call === 'P'
    const majors = MAJORS.filter((s) => s !== theirs).sort((a, b) => h.len[b] - h.len[a])
    const suit = majors.find((s) => h.len[s] >= 4) ?? longest(h, ORDER.filter((s) => s !== theirs))
    if (h.hcp >= 12) {
      if (MAJORS.includes(suit) && h.len[suit] >= 4) return said(bid(4, suit))
      if (isSuit(theirs) && stopper(h.cards, theirs)) return said('3N')
    }
    if (isSuit(theirs) && h.balanced && h.hcp >= 6 && h.hcp <= 9 && stopper(h.cards, theirs))
      return said(cheapest(ctx, 'N') ?? 'P')
    const call = cheapest(ctx, suit)
    if (call && (mustBid || h.hcp >= 6)) {
      const jump = h.hcp >= 9 ? bid(levelOf(call) + 1, suit) : call
      return said(ctx.legal.has(jump) && levelOf(jump) <= 3 ? jump : call)
    }
    return said('P')
  }

  if (isBid(partnerAction.call)) {
    const s = strainOf(partnerAction.call)
    if (isSuit(s) && h.len[s] >= 3 && h.hcp >= 6) {
      const call = cheapest(ctx, s)
      if (!call) return said('P')
      if (h.hcp >= 13 && MAJORS.includes(s)) return said(bid(4, s))
      if (h.hcp >= 10 && ctx.legal.has(bid(levelOf(call) + 1, s))) return said(bid(levelOf(call) + 1, s))
      return said(levelOf(call) <= 3 ? call : 'P')
    }
    if (partnerAction.call === '2N' && opening) {
      // Partner's Unusual 2NT: pick the better minor
      const minor: Suit = h.len.D > h.len.C ? 'D' : 'C'
      return said(h.hcp >= 12 ? bid(5, minor) : bid(3, minor))
    }
    if (s === 'N' && h.hcp >= 10) return said('3N')
  }
  return said('P')
}

// ── Everything else: aim for a contract ──────────────────────────────────────────────────────

/**
 * Picks the contract the partnership should reach from this hand and what partner has shown, and
 * bids it if the auction is below it. Never bids past it, so two robots always settle.
 */
function target(ctx: Context): RobotCall {
  const { h, shown, partner, last, seat } = ctx
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
    return said('P')
  }

  const goal = bid(level, strain)
  if (!last) return said('P')
  if (sameSide(last.seat, seat)) {
    if (bidIndex(last.call) >= bidIndex(goal)) return said('P')
    if (level < 3 || (strainOf(last.call) === strain && levelOf(last.call) >= level - 1 && combined < 25)) return said('P')
    return said(goal)
  }
  if (bidIndex(last.call) >= bidIndex(goal)) {
    if (!fits.length || combined < 20) return said('P')
    const compete = cheapest(ctx, strain)
    return compete && levelOf(compete) <= 3 ? said(compete) : said('P')
  }
  return said(combined >= 25 ? goal : (cheapest(ctx, strain) ?? 'P'))
}

function cheapest(ctx: Context, strain: Strain): Call | null {
  for (let level = 1; level <= 7; level++) if (ctx.legal.has(bid(level, strain))) return bid(level, strain)
  return null
}

const symbol = (s: Suit) => ({ S: '♠', H: '♥', D: '♦', C: '♣' })[s]

// ── What each seat has shown ─────────────────────────────────────────────────────────────────

/** Point ranges and suit lengths each call shows, in the club's system */
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
    const contested = !!opening && before.slice(before.indexOf(opening) + 1).some((c) => !sameSide(c.seat, opening.seat) && c.call !== 'P')
    const ownEarlier = before.filter((c) => c.seat === seat && c.call !== 'P')
    const partnerEarlier = before.filter((c) => c.seat === partner && c.call !== 'P')

    if (call === 'P') {
      if (!opening) at(seat, 0, 11)
      else if (opening.seat === partner && ownEarlier.length === 0 && !contested) at(seat, 0, 5)
      return
    }
    if (call === 'X') {
      if (opening && !sameSide(opening.seat, seat) && ownEarlier.length === 0) at(seat, partnerEarlier.length ? 6 : 12, 37)
      return
    }
    if (call === 'XX') return

    const strain = strainOf(call)
    const level = levelOf(call)
    const suit = isSuit(strain) ? strain : undefined
    if (!opening) {
      if (call === '1N') at(seat, 15, 17)
      else if (call === '2N') at(seat, 20, 21)
      else if (call === '2C') at(seat, 22, 37)
      else if (call === '2D') at(seat, 6, 10)
      else if (level === 1) at(seat, 12, 21, suit, suit === 'S' || suit === 'H' ? 5 : 3)
      else at(seat, 5, 10, suit, 7)
      if (call === '1N' || call === '2N') for (const s of ORDER) shown[seat].len[s] = Math.max(shown[seat].len[s], 2)
      return
    }
    if (opening.seat === partner && ownEarlier.length === 0 && !contested) {
      const opened = opening.call
      if (opened === '1N') {
        if (call === '2C') return at(seat, 9, 37)
        if (call === '2D') return at(seat, 0, 37, 'H', 5)
        if (call === '2H') return at(seat, 0, 37, 'S', 5)
        if (call === '2S') return at(seat, 0, 7)
        if (call === '4D') return at(seat, 10, 15, 'H', 6)
        if (call === '4H') return at(seat, 10, 15, 'S', 6)
        if (call === '2N') return at(seat, 8, 9)
        if (call === '3N') return at(seat, 10, 15)
        if (suit) return at(seat, 12, 37, suit, 5)
        return
      }
      if (opened === '2C' || opened === '2D') return
      if (opened === '2N') return suit ? at(seat, 4, 37, suit, 5) : at(seat, 4, 10)
      const o = strainOf(opened)
      if (o === 'S' || o === 'H') {
        const m = o as Suit
        const spades = m === 'S'
        const bergen = spades ? ['3C', '3D', '3H', '3S'] : ['2N', '3C', '3D', '3H']
        const ranges = [[10, 11], [8, 9], [6, 7], [3, 5]]
        const step = bergen.indexOf(call)
        if (step >= 0) return at(seat, ranges[step][0], ranges[step][1], m, 4)
        if (call === (spades ? '2N' : '2S')) return at(seat, 12, 37, m, 3)
        if (call === bid(2, m)) return at(seat, 8, 10, m, 3)
        if ((spades ? ['3N', '4C', '4D', '4H'] : ['3S', '3N', '4C', '4D']).includes(call)) return at(seat, 12, 13, m, 4)
        if (call === '1N') return at(seat, 6, 12)
        if (level === 2 && suit) return at(seat, 12, 37, suit, suit === 'H' || (!spades && suit === 'D') ? 5 : 4)
        if (suit) return at(seat, 6, 37, suit, 4)
        return
      }
      if (strain === o) return at(seat, level >= 3 ? 10 : 6, level >= 3 ? 12 : 10, suit, 4)
      if (strain === 'N') return at(seat, level === 1 ? 6 : level === 2 ? 11 : 13, level === 1 ? 10 : level === 2 ? 12 : 15)
      return at(seat, level === 1 ? 6 : 11, 37, suit, 4)
    }
    // Stayman and transfer replies
    if (ownEarlier.length === 1 && ownEarlier[0].call === '1N' && partnerEarlier.length === 1) {
      if (partnerEarlier[0].call === '2C' && (suit === 'H' || suit === 'S')) at(seat, 15, 17, suit, 4)
      return
    }
    if (!sameSide(opening.seat, seat) && ownEarlier.length === 0 && partnerEarlier.length === 0) {
      if (call === '2N' && (opening.call === '1H' || opening.call === '1S')) {
        at(seat, 6, 10, 'C', 5)
        at(seat, 6, 10, 'D', 5)
      } else if (strain === 'N') at(seat, 15, 18)
      else at(seat, 8, 18, suit, 5)
      return
    }
    if (suit) {
      const rebid = ownEarlier.some((c) => isBid(c.call) && strainOf(c.call) === suit)
      const raise = partnerEarlier.some((c) => isBid(c.call) && strainOf(c.call) === suit)
      at(seat, 0, 37, suit, rebid ? shown[seat].len[suit] + 1 : raise ? 3 : 4)
    }
  })
  return shown
}
