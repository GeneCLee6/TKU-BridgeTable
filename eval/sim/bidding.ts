import { contractOf, isBid, legalCalls, levelOf, strainOf, type AuctionCall, type Call, type Contract } from '../../shared/auction.ts'
import { isVulnerable, type Vulnerability } from '../../shared/board.ts'
import { hcp, partnerOf, sameSide, sideOf, SUIT_SYMBOL, SUITS, suitOf, type Card, type Hands, type Seat, type Side, type Strain, type Suit } from '../../shared/cards.ts'
import { makeCall, newBoard, turnOf, type BoardState } from '../../shared/game.ts'
import { imps } from '../../shared/imp.ts'
import type { RobotKind } from '../../shared/protocol.ts'
import { TableReading } from '../../shared/robot/reading.ts'
import { robotCall } from '../../shared/robot/robots.ts'
import type { Spec } from '../../shared/robot/system/spec.ts'
import { duplicateScore } from '../../shared/scoring.ts'
import type { EvalBoard } from '../deals.ts'
import { auctionText, contractText } from './board.ts'
import { pbnHand, pbnOf, type DdTable, type Solver } from './dds.ts'

/**
 * The bidding study (eval/sim/README.md §7, `e5-t66`): every call TKB makes, against one or two
 * reasonable alternatives. Each board of the deal set is bid out by four TKBs; each call is a
 * decision point of one kind — constructive (opening or not, the first response, part score,
 * invitation or game, game or slam), competitive after the opponents opened (direct overcall or
 * pass, takeout double, balancing, against a preempt, against 1NT, the high-level decisions), or
 * our side's after the opponents came in. At each point the alternatives are the other natural
 * calls of the position — pass, one level lower or higher in the same strain, game or slam,
 * another strain for game, double, an overcall — chosen from what the bidder can see (its hand
 * and what partner showed, as the robots read it). Each alternative is made and four TKBs bid on;
 * every final contract is scored on the board's DD table and the difference turned into IMPs.
 * TKB's result is also measured against par (DDS `DealerPar`), which is double dummy and leans
 * towards bidding, so a real weakness is one that loses on both counts.
 *
 * The study reads the whole deal (it is analysis off the table): the partnership's real points
 * and fit go into the record for the report's point ranges. The robots it runs still bid from
 * their own hands only (`robotCall`).
 */

export type ConstructiveCategory = 'opening' | 'response' | 'game' | 'slam'
export type CompeteCategory = 'direct' | 'takeout' | 'balancing' | 'preempt' | 'notrump' | 'high'
export type BiddingCategory = ConstructiveCategory | CompeteCategory | 'contested'

export const CONSTRUCTIVE: readonly ConstructiveCategory[] = ['opening', 'response', 'game', 'slam']
export const COMPETE_CATEGORIES: readonly CompeteCategory[] = ['direct', 'takeout', 'balancing', 'preempt', 'notrump', 'high']
export const CATEGORIES: readonly BiddingCategory[] = [...CONSTRUCTIVE, ...COMPETE_CATEGORIES, 'contested']

export const CATEGORY_LABEL: Record<BiddingCategory, string> = {
  opening: '開叫與否',
  response: '第一次答叫',
  game: '部分合約／邀請／成局',
  slam: '成局或滿貫',
  direct: '直接位置蓋叫／不叫',
  takeout: '技術性賭倍',
  balancing: '平衡位置',
  preempt: '對抗阻擊',
  notrump: '對抗 1NT',
  high: '犧牲與處罰賭倍',
  contested: '我方開叫被干擾',
}

/** The groups the report and the practice sets use */
export const GROUP_OF = (c: BiddingCategory): 'constructive' | 'competitive' => (CONSTRUCTIVE.includes(c as ConstructiveCategory) ? 'constructive' : 'competitive')

/** What an alternative is next to TKB's call */
export type AltKind = 'pass' | 'lower' | 'higher' | 'strain' | 'double' | 'bid'
export const ALT_LABEL: Record<AltKind, string> = { pass: 'Pass', lower: '少叫', higher: '多叫', strain: '換花色', double: '賭倍', bid: '叫' }

export function altKind(tkb: Call, alt: Call): AltKind {
  if (alt === 'P') return 'pass'
  if (alt === 'X' || alt === 'XX') return 'double'
  if (!isBid(tkb)) return 'bid'
  if (strainOf(tkb) !== strainOf(alt)) return 'strain'
  return levelOf(alt) < levelOf(tkb) ? 'lower' : 'higher'
}

/** Whether the alternative bids less than TKB (stops lower), more, or neither */
export function direction(tkb: Call, alt: Call): 'conservative' | 'aggressive' | 'other' {
  const k = altKind(tkb, alt)
  if (k === 'pass' || k === 'lower') return tkb === 'P' ? 'other' : 'conservative'
  if (k === 'higher') return 'aggressive'
  if ((k === 'bid' || k === 'double') && tkb === 'P') return 'aggressive'
  return 'other'
}

/** One of the alternatives tried at a decision point, bid out by four TKBs */
export interface Alternative {
  call: Call
  /** The final contract, '4SX-N', or 'P' when passed out */
  contract: string
  /** Its score for the deciding side on the DD table */
  score: number
  /** The calls from the alternative on, '2H-P-P-P' */
  auction: string
}

export interface BiddingPoint {
  /** Calls before the decision (the decision is call number `index` + 1) */
  index: number
  seat: Seat
  category: BiddingCategory
  /** The level of the contract the seat faces (0 before any bid) */
  level: number
  /** The seat's hand in PBN */
  hand: string
  /** The deciding side's real points and longest combined suit (the study can see; the robot cannot) */
  pairHcp: number
  fit: number
  tkb: Call
  /** TKB's result (the board's actual final contract) for the deciding side */
  score: number
  /** Par for the deciding side */
  par: number
  alternatives: Alternative[]
}

export interface BiddingRecord {
  board: number
  system: RobotKind
  dealer: Seat
  vul: Vulnerability
  /** TKB's auction */
  auction: string
  contract: string
  /** Par for North–South and the par contracts as DDS writes them */
  par?: number
  parContracts?: string[]
  /** Alternatives that could not be bid out (a robot failed), not counted */
  failed?: number
  /**
   * The side with more points (North–South on a tie), its points and its most tricks double dummy
   * in any strain from either hand: whether a slam was there (the slam-zone summary, §9)
   */
  strong?: { side: Side; hcp: number; tricks: number; score: number }
  points: BiddingPoint[]
}

/** '4SX-N', or 'P' for a board passed out */
export const contractKey = (contract: Contract | null) => (contract ? `${contractText(contract)}-${contract.declarer}` : 'P')

/** The score of a final contract on the DD table, for `side` */
export function scoreOn(table: DdTable, contract: Contract | null, vul: Vulnerability, side: Side): number {
  if (!contract) return 0
  const score = duplicateScore(contract, table[contract.strain][contract.declarer], isVulnerable(vul, contract.declarer))
  return sideOf(contract.declarer) === side ? score : -score
}

const lengthOf = (hand: readonly Card[], suit: Suit) => hand.filter((card) => suitOf(card) === suit).length
const lastBidOf = (calls: readonly AuctionCall[]) => calls.findLast((c) => isBid(c.call))

/** The lowest level of a strain that is game: 3NT, four of a major, five of a minor */
export const gameLevel = (strain: Strain) => (strain === 'N' ? 3 : strain === 'H' || strain === 'S' ? 4 : 5)

/** 3NT, four of a major, five of a minor, or higher */
export const isGameOrHigher = (bid: Call) => levelOf(bid) >= gameLevel(strainOf(bid))

/** The suits a set of seats bid (naturally or not: where the strength may be) */
function suitsBid(calls: readonly AuctionCall[], side: (seat: Seat) => boolean): Suit[] {
  const suits = new Set<Suit>()
  for (const c of calls) if (side(c.seat) && isBid(c.call) && strainOf(c.call) !== 'N') suits.add(strainOf(c.call) as Suit)
  return [...suits]
}

/** What the robots' calls before the decision showed, call by call (artificial, forcing) */
export type Meanings = readonly (Spec | undefined)[]

/**
 * The kind of decision the seat to call faces after `before`, or null when it is not one of the
 * study's. Constructive while the opponents have only passed; competitive when they opened (the
 * six kinds of `classifyCompetitive`); `contested` when we opened and they came in.
 */
export function classify(before: readonly AuctionCall[], seat: Seat, hand: readonly Card[], meanings: Meanings = []): { category: BiddingCategory; level: number } | null {
  const opening = before.find((c) => c.call !== 'P')
  const last = lastBidOf(before)
  const level = last ? levelOf(last.call) : 0
  if (!opening) return { category: 'opening', level }
  if (!sameSide(opening.seat, seat)) return classifyCompetitive(before, seat, hand, meanings)
  const theyActed = before.some((c) => !sameSide(c.seat, seat) && c.call !== 'P')
  if (theyActed) return { category: 'contested', level }
  const mine = before.filter((c) => c.seat === seat && c.call !== 'P').length
  const partners = before.filter((c) => c.seat === partnerOf(seat) && c.call !== 'P').length
  if (opening.seat !== seat && mine === 0 && partners === 1) return { category: 'response', level }
  return { category: isGameOrHigher(last!.call) ? 'slam' : 'game', level }
}

/** A double of an ace-asking bid or its answer, or of any artificial bid, means little to the robots */
function artificialLast(before: readonly AuctionCall[], meanings: Meanings, seat: Seat): boolean {
  const i = before.findLastIndex((c) => isBid(c.call))
  if (i < 0) return false
  if (meanings[i]?.artificial) return true
  const theirBids = before.filter((c) => !sameSide(c.seat, seat) && isBid(c.call))
  return /^[45]N$/.test(before[i].call) || /^[45]N$/.test(theirBids.at(-2)?.call ?? '')
}

/**
 * The opponents opened: the first decision of our side against their opening, a one-level
 * response or a single raise (direct, takeout-shaped, balancing, against a preempt, against 1NT);
 * the decision against their first game; or, once we have bid, any decision against their
 * contract at the three level or higher (`high`). A strong 2♣ or 2NT opening is left out.
 */
export function classifyCompetitive(before: readonly AuctionCall[], seat: Seat, hand: readonly Card[], meanings: Meanings = []): { category: CompeteCategory; level: number } | null {
  const opening = before.find((c) => c.call !== 'P')
  if (!opening || sameSide(opening.seat, seat)) return null
  const last = lastBidOf(before)!
  if (sameSide(last.seat, seat)) return null
  const level = levelOf(last.call)
  const entered = before.some((c) => sameSide(c.seat, seat) && c.call !== 'P')
  const theirBids = before.filter((c) => !sameSide(c.seat, seat) && isBid(c.call))
  const asking = artificialLast(before, meanings, seat)
  if (entered) return level >= 3 && !asking ? { category: 'high', level } : null
  if (isGameOrHigher(last.call) && last !== opening) {
    // The opponents' first game bid; above it they are cue-bidding or asking, not competing
    return !asking && theirBids.filter((c) => isGameOrHigher(c.call)).length === 1 ? { category: 'high', level } : null
  }
  const raise = levelOf(last.call) === levelOf(opening.call) + 1 && strainOf(last.call) === strainOf(opening.call)
  if (last !== opening && levelOf(last.call) > 1 && !raise) return null
  if (opening.call === '1N') return last === opening ? { category: 'notrump', level } : null
  if (opening.call === '2C' || opening.call === '2N') return null
  if (levelOf(opening.call) >= 2) return last === opening ? { category: 'preempt', level } : null
  const passOut = before.length >= 3 && before.at(-1)!.call === 'P' && before.at(-2)!.call === 'P'
  if (passOut) return { category: 'balancing', level }
  const theirs = suitsBid(before, (s) => !sameSide(s, seat))
  const shaped = theirs.every((suit) => lengthOf(hand, suit) <= 2) && SUITS.filter((suit) => !theirs.includes(suit)).every((suit) => lengthOf(hand, suit) >= 3)
  return { category: shaped && hcp(hand) >= 11 ? 'takeout' : 'direct', level }
}

/** The cheapest legal bid in a strain, if it is not above `maxLevel` */
function cheapest(legal: Set<Call>, strain: string, maxLevel: number): Call | null {
  for (let level = 1; level <= maxLevel; level++) if (legal.has(`${level}${strain}`)) return `${level}${strain}`
  return null
}

/** What the bidder knows at the table: its hand, and partner's points and lengths as the robots read the auction */
export interface BidderView {
  hand: readonly Card[]
  /** Partner's shown points, low and high */
  partner: { hcp: readonly [number, number]; len: Record<Suit, number> }
}

/** The bidder's view through the robots' own reading of the auction (`TableReading`) */
export function viewOf(state: BoardState, seat: Seat, kind: RobotKind): BidderView {
  const reading = new TableReading(state, seat, kind)
  const p = partnerOf(seat)
  return {
    hand: state.hands[seat],
    partner: { hcp: reading.hcp(p), len: Object.fromEntries(SUITS.map((s) => [s, reading.len(p, s)[0]])) as Record<Suit, number> },
  }
}

const UNKNOWN: BidderView['partner'] = { hcp: [0, 37], len: { S: 0, H: 0, D: 0, C: 0 } }

/**
 * The one or two alternatives tried against TKB's call: the other natural actions of the
 * position, from what the bidder knows. Nothing when the hand has no reasonable action but TKB's
 * (a weak hand passing), or TKB's call is artificial (an ask, a relay, a cue bid).
 */
export function alternativesFor(
  before: readonly AuctionCall[],
  dealer: Seat,
  seat: Seat,
  view: BidderView | readonly Card[],
  category: BiddingCategory,
  tkb: Call,
  meanings: Meanings = [],
  tkbMeaning?: Spec,
): Call[] {
  const { hand, partner } = Array.isArray(view) ? { hand: view as readonly Card[], partner: UNKNOWN } : (view as BidderView)
  const legal = legalCalls(before, dealer)
  const points = hcp(hand)
  const len = (s: Suit) => lengthOf(hand, s)
  const last = lastBidOf(before)
  const lastIndex = before.findLastIndex((c) => isBid(c.call))
  const theirs = suitsBid(before, (s) => !sameSide(s, seat))
  const partners = suitsBid(before, (s) => s === partnerOf(seat))
  const partnerCalls = before.map((c, i) => ({ c, m: meanings[i] })).filter(({ c }) => c.seat === partnerOf(seat) && c.call !== 'P')
  const partnerLast = partnerCalls.at(-1)
  // Pass is no choice after partner's forcing call (or once our side is forced to game below it)
  const forcedToGame = before.some((c, i) => sameSide(c.seat, seat) && meanings[i]?.forcing === 'game') && !!last && !isGameOrHigher(last.call) && sameSide(last.seat, seat)
  const passForbidden = (!!partnerLast && !!partnerLast.m?.forcing && before.at(-1)?.call === 'P' && before.at(-2) === partnerLast.c) || forcedToGame
  const pass = () => (passForbidden ? null : 'P')
  // The partnership's points as the bidder can count them: partner's minimum, and a likely
  // middle (partner's range, its top cut to six above the bottom)
  const est = points + partner.hcp[0]
  const likely = points + (partner.hcp[0] + Math.min(partner.hcp[1], partner.hcp[0] + 6)) / 2
  const fitOf = (s: Suit) => len(s) + partner.len[s]
  const bestFit = (): Suit | null => {
    const fits = SUITS.filter((s) => fitOf(s) >= 8).sort((a, b) => Number(b === 'S' || b === 'H') - Number(a === 'S' || a === 'H') || fitOf(b) - fitOf(a))
    return fits[0] ?? null
  }
  const out: (Call | null)[] = []
  const add = (...calls: (Call | null)[]) => out.push(...calls)
  const artificial = !!tkbMeaning?.artificial || (tkb !== 'P' && isBid(tkb) && /^[45]N$/.test(tkb))

  /** One level lower or higher in the strain of TKB's natural bid */
  const step = (by: number, cap: number): Call | null => {
    if (!isBid(tkb)) return null
    const to = levelOf(tkb) + by
    if (to < 1 || to > cap) return null
    const call = `${to}${strainOf(tkb)}`
    return legal.has(call) ? call : null
  }
  const lowerOrPass = () => step(-1, 7) ?? (last && sameSide(last.seat, seat) ? pass() : null)
  const games = (): Call[] => {
    const calls: Call[] = []
    const fit = bestFit()
    if (fit && legal.has(`${gameLevel(fit)}${fit}`)) calls.push(`${gameLevel(fit)}${fit}`)
    if (legal.has('3N')) calls.push('3N')
    for (const s of SUITS) if (fitOf(s) >= 8 && legal.has(`${gameLevel(s)}${s}`)) calls.push(`${gameLevel(s)}${s}`)
    return calls
  }

  switch (category) {
    case 'opening': {
      if (tkb === 'P') {
        if (points >= 10) {
          const suit = [...SUITS].sort((a, b) => len(b) - len(a) || SUITS.indexOf(a) - SUITS.indexOf(b))[0]
          add(`1${suit}`)
        }
      } else if (points <= 12 || levelOf(tkb) >= 2) {
        if (tkb !== '2C' && tkb !== '2N') add('P')
      }
      break
    }
    case 'response': {
      if (artificial) break
      if (tkb === 'P') {
        if (points < 5) break
        const raise = partners.find((s) => len(s) >= 3 && partnerLast && !partnerLast.m?.artificial)
        const own = [...SUITS].filter((s) => !partners.includes(s)).sort((a, b) => len(b) - len(a))[0]
        add(raise ? cheapest(legal, raise, 3) : null, len(own) >= 4 ? cheapest(legal, own, points >= 10 ? 2 : 1) : null, cheapest(legal, 'N', 1))
      } else if (isBid(tkb)) {
        add(points <= 9 ? pass() : null, step(-1, 7), step(1, gameLevel(strainOf(tkb))))
      }
      break
    }
    case 'game':
    case 'contested': {
      if (artificial) break
      if (tkb === 'P' || tkb === 'X' || tkb === 'XX') {
        // Bidding on: one more in our strain, or game
        const ourStrain = last && sameSide(last.seat, seat) && !meanings[lastIndex]?.artificial ? strainOf(last.call) : null
        if (category === 'contested') {
          const raise = partners.filter((s) => len(s) >= 3 && !theirs.includes(s)).sort((a, b) => len(b) - len(a))[0]
          const own = [...SUITS].filter((s) => !theirs.includes(s) && len(s) >= 5).sort((a, b) => len(b) - len(a))[0]
          if (tkb !== 'X' && legal.has('X') && points >= 8) add('X')
          if (tkb !== 'P') add(pass())
          add(raise ? cheapest(legal, raise, 4) : own && points >= 8 ? cheapest(legal, own, 3) : null)
        } else if (ourStrain && est >= 18) {
          const next = cheapest(legal, ourStrain, gameLevel(ourStrain))
          add(next)
          if (est >= 21) add(...games().filter((g) => g !== next))
        }
      } else if (isBid(tkb)) {
        add(lowerOrPass(), step(1, gameLevel(strainOf(tkb))))
        if (isGameOrHigher(tkb)) add(likely >= 30 && levelOf(tkb) < 6 ? `6${strainOf(tkb)}` : null, ...games().filter((g) => g !== tkb))
        if (category === 'contested' && tkb !== 'X' && legal.has('X') && points >= 10) add('X')
      }
      break
    }
    case 'slam': {
      if (artificial) break
      if (tkb === 'P') {
        const ourStrain = last && sameSide(last.seat, seat) && !meanings[lastIndex]?.artificial ? strainOf(last.call) : null
        if (ourStrain && likely >= 30 && last && levelOf(last.call) < 6) add(legal.has(`6${ourStrain}`) ? `6${ourStrain}` : null)
      } else if (isBid(tkb)) {
        add(lowerOrPass(), levelOf(tkb) >= 5 ? step(1, 7) : null)
      }
      break
    }
    default:
      add(...competitiveAlternatives(before, seat, hand, category, tkb, meanings, legal, last!))
  }
  const seen = new Set<Call>([tkb])
  const result: Call[] = []
  for (const call of out) {
    if (call && !seen.has(call) && legal.has(call) && (!isBid(call) || levelOf(call) <= 7)) {
      seen.add(call)
      result.push(call)
      if (result.length === 2) break
    }
  }
  return result
}

/**
 * The competitive alternatives: against a pass, a double (with the values for it and no length
 * in the opponents' suit) and a bid (the side's fit at the high level, otherwise the longest suit
 * the opponents did not bid, five cards or more); against a bid, pass and (with values) double;
 * against a double, pass and a bid
 */
function competitiveAlternatives(
  before: readonly AuctionCall[],
  seat: Seat,
  hand: readonly Card[],
  category: BiddingCategory,
  tkb: Call,
  meanings: Meanings,
  legal: Set<Call>,
  last: AuctionCall,
): (Call | null)[] {
  const points = hcp(hand)
  const len = (s: Suit) => lengthOf(hand, s)
  const theirStrain = strainOf(last.call)
  const theirs = suitsBid(before, (s) => !sameSide(s, seat))
  const ours = suitsBid(before, (s) => sameSide(s, seat))
  const partner = suitsBid(before, (s) => sameSide(s, seat) && s !== seat)
  const maxLevel = category === 'high' ? 5 : category === 'preempt' ? 4 : 3
  const canDouble = legal.has('X') && !artificialLast(before, meanings, seat)

  const double = (): Call | null => {
    if (!canDouble) return null
    if (category === 'high') return points >= 9 || (theirStrain !== 'N' && len(theirStrain as Suit) >= 4 && points >= 6) ? 'X' : null
    const short = theirStrain === 'N' || len(theirStrain as Suit) <= 3
    return short && points >= (category === 'balancing' ? 9 : category === 'notrump' ? 14 : 11) ? 'X' : null
  }
  const bid = (minimum: number): Call | null => {
    if (category === 'high') {
      // Compete or sacrifice in the side's best fit: partner's suit with three cards, or my own six
      const fits = ours.filter((suit) => (partner.includes(suit) && len(suit) >= 3) || len(suit) >= 6).sort((a, b) => len(b) - len(a))
      for (const suit of fits) {
        const call = cheapest(legal, suit, maxLevel)
        if (call) return call
      }
      return null
    }
    if (points < (category === 'balancing' ? 6 : 7)) return null
    const suits = SUITS.filter((suit) => !theirs.includes(suit) && len(suit) >= minimum).sort((a, b) => len(b) - len(a) || SUITS.indexOf(a) - SUITS.indexOf(b))
    for (const suit of suits) {
      const call = cheapest(legal, suit, maxLevel)
      if (call) return call
    }
    return null
  }
  if (tkb === 'P') return [double(), bid(5)]
  if (tkb === 'X') return ['P', bid(4)]
  if (tkb === 'XX') return ['P']
  return ['P', canDouble && (points >= 11 || (category === 'high' && points >= 8)) ? 'X' : null]
}

/** Four TKBs bid on from a state to the end of the auction; what each call showed is kept alongside */
export function bidOn(state: BoardState, kind: RobotKind, meanings: (Spec | undefined)[] = []): BoardState {
  while (state.phase === 'auction') {
    const seat = turnOf(state)!
    const { call, alert, meaning } = robotCall(kind, state.hands[seat], seat, state.auction, state.dealer, state.vul)
    meanings.push(meaning)
    state = makeCall(state, seat, call, alert)
  }
  return state
}

/** The calls from `from` on, '2H-P-P-P' */
const callsFrom = (state: BoardState, from: number) => state.auction.slice(from).map((c) => c.call).join('-')

/** The deciding side's real points and longest combined suit */
function pairOf(hands: Hands, seat: Seat): { pairHcp: number; fit: number } {
  const both = [...hands[seat], ...hands[partnerOf(seat)]]
  return { pairHcp: hcp(both), fit: Math.max(...SUITS.map((s) => lengthOf(both, s))) }
}

/** The side with more points and its most tricks double dummy */
export function strongSide(hands: Hands, table: DdTable, state: BoardState): NonNullable<BiddingRecord['strong']> {
  const side = strongOf(hands)
  const seats: Seat[] = side === 'NS' ? ['N', 'S'] : ['E', 'W']
  const tricks = Math.max(...(Object.keys(table) as Strain[]).flatMap((strain) => seats.map((seat) => table[strain][seat])))
  return { side, hcp: hcp([...hands[seats[0]], ...hands[seats[1]]]), tricks, score: scoreOn(table, state.contract, state.vul, side) }
}

const strongOf = (hands: Hands): Side => (hcp([...hands.N, ...hands.S]) >= 20 ? 'NS' : 'EW')
/** Whether the slam-zone summary wants the board: the stronger side has 26 points or more */
const inSlamZone = (hands: Hands) => hcp(strongOf(hands) === 'NS' ? [...hands.N, ...hands.S] : [...hands.E, ...hands.W]) >= 26

export interface BiddingOptions {
  /** Only these kinds of decision (the `compete` study is the competitive ones) */
  categories?: readonly BiddingCategory[]
}

/** A board's decision points, each with its alternatives bid out; the DD table only when there is a point */
export function biddingRecord(board: EvalBoard, kind: RobotKind, solver: Pick<Solver, 'table' | 'par'>, options: BiddingOptions = {}): BiddingRecord {
  const meanings: (Spec | undefined)[] = []
  const state = bidOn(newBoard(board.boardNo, board.hands), kind, meanings)
  const record: BiddingRecord = {
    board: board.boardNo,
    system: kind,
    dealer: state.dealer,
    vul: state.vul,
    auction: auctionText(state),
    contract: contractKey(state.contract),
    points: [],
  }
  const found: { index: number; seat: Seat; category: BiddingCategory; level: number; branches: { call: Call; state: BoardState }[] }[] = []
  let failed = 0
  let replay = newBoard(board.boardNo, board.hands)
  state.auction.forEach((made, index) => {
    const before = state.auction.slice(0, index)
    const at = replay
    replay = makeCall(replay, made.seat, made.call, made.alert)
    const hand = state.hands[made.seat]
    const kindOf = classify(before, made.seat, hand, meanings)
    if (!kindOf || (options.categories && !options.categories.includes(kindOf.category))) return
    const view = GROUP_OF(kindOf.category) === 'constructive' || kindOf.category === 'contested' ? viewOf(at, made.seat, kind) : { hand, partner: UNKNOWN }
    const calls = alternativesFor(before, state.dealer, made.seat, view, kindOf.category, made.call, meanings, meanings[index])
    if (!calls.length) return
    const branches: { call: Call; state: BoardState }[] = []
    for (const call of calls) {
      try {
        branches.push({ call, state: bidOn(makeCall(at, made.seat, call), kind) })
      } catch {
        failed++
      }
    }
    if (branches.length) found.push({ index, seat: made.seat, category: kindOf.category, level: kindOf.level, branches })
  })
  if (failed) record.failed = failed
  if (!found.length && !inSlamZone(board.hands)) return record
  const table = solver.table(board.hands)
  const par = solver.par(table, state.dealer, state.vul)
  record.par = par.ns
  record.parContracts = par.contracts
  record.strong = strongSide(board.hands, table, state)
  for (const point of found) {
    const side = sideOf(point.seat)
    record.points.push({
      index: point.index,
      seat: point.seat,
      category: point.category,
      level: point.level,
      hand: pbnHand(state.hands[point.seat]),
      ...pairOf(state.hands, point.seat),
      tkb: state.auction[point.index].call,
      score: scoreOn(table, state.contract, state.vul, side),
      par: side === 'NS' ? par.ns : -par.ns,
      alternatives: point.branches.map((b) => ({
        call: b.call,
        contract: contractKey(contractOf(b.state.auction)),
        score: scoreOn(table, b.state.contract, b.state.vul, side),
        auction: callsFrom(b.state, point.index),
      })),
    })
  }
  return record
}

// ---------------------------------------------------------------------------------------------
// The study: decisions added up by kind, by points and by what the alternative was

/** Pass, double, or a bid, for TKB's call */
export type Action = 'pass' | 'double' | 'bid'
export const actionOf = (call: Call): Action => (call === 'P' ? 'pass' : call === 'X' || call === 'XX' ? 'double' : 'bid')
export const ACTION_LABEL: Record<Action, string> = { pass: 'Pass', double: '賭倍', bid: '叫' }

/** The partnership's real points, in the ranges the report uses */
export const HCP_BUCKETS = ['–17', '18–20', '21–22', '23–24', '25–26', '27–29', '30–32', '33+'] as const
export type HcpBucket = (typeof HCP_BUCKETS)[number]
export function hcpBucket(points: number): HcpBucket {
  if (points <= 17) return '–17'
  if (points <= 20) return '18–20'
  if (points <= 22) return '21–22'
  if (points <= 24) return '23–24'
  if (points <= 26) return '25–26'
  if (points <= 29) return '27–29'
  if (points <= 32) return '30–32'
  return '33+'
}

/** Running mean and standard error */
export class Mean {
  n = 0
  sum = 0
  private squares = 0
  add(x: number) {
    this.n++
    this.sum += x
    this.squares += x * x
  }
  get mean() {
    return this.n ? this.sum / this.n : 0
  }
  get error() {
    if (this.n < 2) return 0
    const variance = (this.squares - (this.sum * this.sum) / this.n) / (this.n - 1)
    return Math.sqrt(Math.max(0, variance) / this.n)
  }
}

export interface Example {
  board: number
  dealer: Seat
  vul: Vulnerability
  seat: Seat
  category: BiddingCategory
  hand: string
  pairHcp: number
  /** The auction up to the decision */
  before: string
  tkb: Call
  tkbContract: string
  tkbScore: number
  alternative: Call
  altContract: string
  altScore: number
  /** IMPs TKB's call won against the alternative (negative: lost) */
  imps: number
  par: number
}

export interface Cell {
  n: number
  mean: number
  error: number
  /** The alternative did better / worse */
  altBetter: number
  /** Sum of TKB − alternative over the cell: what always choosing the alternative would change */
  total: number
}

const cellOf = (m: Mean, altBetter: number): Cell => ({ n: m.n, mean: m.mean, error: m.error, altBetter, total: m.sum })

export interface CategoryStats {
  category: BiddingCategory
  decisions: number
  /** TKB against each alternative, IMPs a comparison */
  vsAlternative: Cell & { tkbBetter: number }
  /** TKB against par, IMPs a decision */
  vsPar: { mean: number; error: number }
  /** The alternative against par, IMPs a comparison */
  altVsPar: { mean: number }
  /** TKB's kind of call against the kind of alternative */
  transitions: (Cell & { tkb: Action; alt: AltKind })[]
  /** By the partnership's real points: against the alternatives that bid less, and those that bid more */
  byPoints: { bucket: HcpBucket; decisions: number; conservative: Cell; aggressive: Cell; vsPar: number }[]
  /** The same by the partnership's real points: where a threshold may be off */
  fine: (Cell & { tkb: Action; alt: AltKind; bucket: HcpBucket })[]
  /** The decisions TKB lost most on (against its worst alternative) */
  worst: Example[]
}

/**
 * The slam zone (§9): boards where the stronger side has 26 points or more, by how many tricks it
 * can take double dummy (11 or fewer, 12, 13) and how high TKB's final contract was for it (below
 * a slam — including the other side's contract —, small slam, grand slam), with TKB against par
 */
export const SLAM_TRICKS = ['≤11', '12', '13'] as const
export const SLAM_REACHED = ['below', 'small', 'grand'] as const
export type SlamTricks = (typeof SLAM_TRICKS)[number]
export type SlamReached = (typeof SLAM_REACHED)[number]
export interface SlamCell {
  tricks: SlamTricks
  reached: SlamReached
  boards: number
  /** TKB's result against par, IMPs a board */
  vsPar: number
  error: number
}

export function slamCellOf(record: BiddingRecord): { tricks: SlamTricks; reached: SlamReached } | null {
  const strong = record.strong
  if (!strong || strong.hcp < 26) return null
  const tricks: SlamTricks = strong.tricks >= 13 ? '13' : strong.tricks === 12 ? '12' : '≤11'
  const [contract, declarer] = record.contract.split('-')
  const ours = record.contract !== 'P' && sideOf(declarer as Seat) === strong.side
  const level = ours ? Number(contract[0]) : 0
  return { tricks, reached: level === 7 ? 'grand' : level === 6 ? 'small' : 'below' }
}

export interface BiddingStudy {
  boards: number
  withPoints: number
  failed: number
  categories: CategoryStats[]
  /** The slam-zone summary: empty when no board's stronger side had 26 points */
  slam: SlamCell[]
}

const WORST = 15

class Counted {
  readonly mean = new Mean()
  altBetter = 0
  tkbBetter = 0
  add(swing: number) {
    this.mean.add(swing)
    if (swing < 0) this.altBetter++
    if (swing > 0) this.tkbBetter++
  }
  cell(): Cell {
    return cellOf(this.mean, this.altBetter)
  }
}

function at<K, V>(map: Map<K, V>, key: K, make: () => V): V {
  let value = map.get(key)
  if (value === undefined) {
    value = make()
    map.set(key, value)
  }
  return value
}

export function exampleOf(record: BiddingRecord, p: BiddingPoint, a: Alternative): Example {
  return {
    board: record.board,
    dealer: record.dealer,
    vul: record.vul,
    seat: p.seat,
    category: p.category,
    hand: p.hand,
    pairHcp: p.pairHcp,
    before: record.auction.split('-').slice(0, p.index).join('-'),
    tkb: p.tkb,
    tkbContract: record.contract,
    tkbScore: p.score,
    alternative: a.call,
    altContract: a.contract,
    altScore: a.score,
    imps: imps(p.score - a.score),
    par: p.par,
  }
}

export class BiddingStudyBuilder {
  private boards = 0
  private withPoints = 0
  private failed = 0
  private readonly decisions = new Map<BiddingCategory, number>()
  private readonly vsAlt = new Map<BiddingCategory, Counted>()
  private readonly vsPar = new Map<BiddingCategory, Mean>()
  private readonly altVsPar = new Map<BiddingCategory, Mean>()
  private readonly transitions = new Map<string, Counted>()
  private readonly fine = new Map<string, Counted>()
  private readonly buckets = new Map<string, { decisions: number; conservative: Counted; aggressive: Counted; par: Mean }>()
  private readonly worst = new Map<BiddingCategory, Example[]>()
  private readonly slam = new Map<string, Mean>()

  add(record: BiddingRecord) {
    this.boards++
    this.failed += record.failed ?? 0
    const zone = slamCellOf(record)
    if (zone && record.par !== undefined) {
      const par = record.strong!.side === 'NS' ? record.par : -record.par
      at(this.slam, `${zone.tricks}|${zone.reached}`, () => new Mean()).add(imps(record.strong!.score - par))
    }
    if (record.points.length) this.withPoints++
    for (const p of record.points) {
      const c = p.category
      this.decisions.set(c, (this.decisions.get(c) ?? 0) + 1)
      const parImps = imps(p.score - p.par)
      at(this.vsPar, c, () => new Mean()).add(parImps)
      const bucket = at(this.buckets, `${c}|${hcpBucket(p.pairHcp)}`, () => ({ decisions: 0, conservative: new Counted(), aggressive: new Counted(), par: new Mean() }))
      bucket.decisions++
      bucket.par.add(parImps)
      let worstHere: Example | null = null
      for (const a of p.alternatives) {
        const swing = imps(p.score - a.score)
        at(this.vsAlt, c, () => new Counted()).add(swing)
        at(this.altVsPar, c, () => new Mean()).add(imps(a.score - p.par))
        at(this.transitions, `${c}|${actionOf(p.tkb)}|${altKind(p.tkb, a.call)}`, () => new Counted()).add(swing)
        at(this.fine, `${c}|${actionOf(p.tkb)}|${altKind(p.tkb, a.call)}|${hcpBucket(p.pairHcp)}`, () => new Counted()).add(swing)
        const d = direction(p.tkb, a.call)
        if (d !== 'other') bucket[d].add(swing)
        if (!worstHere || swing < worstHere.imps) worstHere = exampleOf(record, p, a)
      }
      if (worstHere && worstHere.imps < 0) {
        const list = at(this.worst, c, () => [])
        list.push(worstHere)
        list.sort((x, y) => x.imps - y.imps || x.board - y.board)
        if (list.length > WORST) list.length = WORST
      }
    }
  }

  build(): BiddingStudy {
    return {
      boards: this.boards,
      withPoints: this.withPoints,
      failed: this.failed,
      slam: SLAM_TRICKS.flatMap((tricks) =>
        SLAM_REACHED.flatMap((reached) => {
          const m = this.slam.get(`${tricks}|${reached}`)
          return m ? [{ tricks, reached, boards: m.n, vsPar: m.mean, error: m.error }] : []
        }),
      ),
      categories: CATEGORIES.map((category) => {
        const vs = this.vsAlt.get(category) ?? new Counted()
        const par = this.vsPar.get(category) ?? new Mean()
        const transitions: CategoryStats['transitions'] = []
        for (const [key, t] of this.transitions) {
          const [c, tkb, alt] = key.split('|')
          if (c === category) transitions.push({ tkb: tkb as Action, alt: alt as AltKind, ...t.cell() })
        }
        transitions.sort((a, b) => a.total - b.total)
        const fine: CategoryStats['fine'] = []
        for (const [key, t] of this.fine) {
          const [c, tkb, alt, bucket] = key.split('|')
          if (c === category) fine.push({ tkb: tkb as Action, alt: alt as AltKind, bucket: bucket as HcpBucket, ...t.cell() })
        }
        fine.sort((a, b) => a.total - b.total)
        const byPoints: CategoryStats['byPoints'] = []
        for (const bucket of HCP_BUCKETS) {
          const b = this.buckets.get(`${category}|${bucket}`)
          if (b) byPoints.push({ bucket, decisions: b.decisions, conservative: b.conservative.cell(), aggressive: b.aggressive.cell(), vsPar: b.par.mean })
        }
        return {
          category,
          decisions: this.decisions.get(category) ?? 0,
          vsAlternative: { ...vs.cell(), tkbBetter: vs.tkbBetter },
          vsPar: { mean: par.mean, error: par.error },
          altVsPar: { mean: (this.altVsPar.get(category) ?? new Mean()).mean },
          transitions,
          fine,
          byPoints,
          worst: this.worst.get(category) ?? [],
        }
      }),
    }
  }
}

export function biddingStudy(records: Iterable<BiddingRecord>): BiddingStudy {
  const builder = new BiddingStudyBuilder()
  for (const r of records) builder.add(r)
  return builder.build()
}

// ---------------------------------------------------------------------------------------------
// The report

/** '1♥', 'Pass', 'X' */
export function callLabel(call: Call): string {
  if (call === 'P') return 'Pass'
  if (call === 'X' || call === 'XX') return call
  return `${call[0]}${SUIT_SYMBOL[strainOf(call)]}`
}

const auctionLabel = (text: string) => (text ? text.split('-').map(callLabel).join(' ') : '（第一個叫品）')

const contractLabel = (key: string) => {
  if (key === 'P') return '全部 Pass'
  const [contract, declarer] = key.split('-')
  return `${callLabel(contract.slice(0, 2))}${contract.slice(2)} ${declarer}`
}

/** A PBN hand as '♠AKQ32 ♥T9 ♦… ♣…' */
export const handLabel = (pbn: string) => pbn.split('.').map((ranks, i) => `${SUIT_SYMBOL[SUITS[i]]}${ranks || '—'}`).join(' ')

const signed = (x: number, digits = 2) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(digits)}`
const percent = (part: number, whole: number) => (whole ? `${((part / whole) * 100).toFixed(0)}%` : '—')
const cellText = (c: Cell) => (c.n ? `${signed(c.mean)} ± ${c.error.toFixed(2)}（${c.n}）` : '—')

export function biddingReport(study: BiddingStudy, title: string, categories: readonly BiddingCategory[] = CATEGORIES): string {
  const shown = study.categories.filter((c) => categories.includes(c.category))
  const per1000 = (total: number) => (study.boards ? (total / study.boards) * 1000 : 0)
  const lines: string[] = []
  lines.push(`# 叫牌研究（${title}）`, '')
  lines.push(`${study.boards} 副，${study.withPoints} 副有決策點${study.failed ? `；${study.failed} 個替代叫品叫不完（不算）` : ''}。`, '')
  lines.push(
    '「TKB − 替代」是 TKB 的叫品比替代叫品多贏的 IMP（每個對照，± 標準誤）；「每千副」是那一格對照的總和 ÷ 副數 × 1,000：每一千副牌，總是改叫替代叫品會少（負）或多拿的 IMP，修規則依這個排先後。「TKB − par」是最後合約的分數對 par 的 IMP（par 雙明手、偏向叫高）。',
    '',
  )
  lines.push('| 類別 | 決策 | 對照 | TKB − 替代 | 替代較好／TKB 較好 | 每千副 | TKB − par | 替代 − par |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const c of shown) {
    const v = c.vsAlternative
    lines.push(
      `| ${CATEGORY_LABEL[c.category]} | ${c.decisions} | ${v.n} | ${signed(v.mean)} ± ${v.error.toFixed(2)} | ${percent(v.altBetter, v.n)}／${percent(v.tkbBetter, v.n)} | ${signed(per1000(v.total), 1)} | ${signed(c.vsPar.mean)} ± ${c.vsPar.error.toFixed(2)} | ${signed(c.altVsPar.mean)} |`,
    )
  }
  if (study.slam.length) {
    const reached: Record<SlamReached, string> = { below: '沒叫到滿貫', small: '小滿貫', grand: '大滿貫' }
    lines.push('', '## 滿貫區（強方合計 26 點以上：雙明手最多幾墩 × TKB 叫到哪裡）', '')
    lines.push('強方是點力多的一方；「最多幾墩」是強方任一家、任一王牌的雙明手墩數。12 墩以上沒叫到滿貫是漏叫，11 墩以下叫了滿貫是叫過頭；「TKB − par」是那一格每副對 par 的 IMP。', '')
    lines.push('| 最多幾墩 | TKB 叫到 | 副數 | TKB − par |')
    lines.push('| --- | --- | --- | --- |')
    for (const c of study.slam) lines.push(`| ${c.tricks} | ${reached[c.reached]} | ${c.boards} | ${signed(c.vsPar)} ± ${c.error.toFixed(2)} |`)
  }
  const cells = shown.flatMap((c) => c.transitions.map((t) => ({ c, t }))).filter(({ t }) => t.mean < 0 && t.n >= 30 && t.mean + 2 * t.error < 0)
  cells.sort((a, b) => a.t.total - b.t.total)
  lines.push('', '## 損失最多的格（替代叫品顯著較好，依每千副的總損失排）', '')
  lines.push('| 類別 | TKB → 替代 | 對照 | TKB − 替代 | 替代較好 | 每千副 |')
  lines.push('| --- | --- | --- | --- | --- | --- |')
  for (const { c, t } of cells.slice(0, 25))
    lines.push(`| ${CATEGORY_LABEL[c.category]} | ${ACTION_LABEL[t.tkb]} → ${ALT_LABEL[t.alt]} | ${t.n} | ${signed(t.mean)} ± ${t.error.toFixed(2)} | ${percent(t.altBetter, t.n)} | ${signed(per1000(t.total), 1)} |`)
  const fine = shown.flatMap((c) => c.fine.map((t) => ({ c, t }))).filter(({ t }) => t.mean < 0 && t.n >= 30 && t.mean + 2 * t.error < 0)
  fine.sort((a, b) => a.t.total - b.t.total)
  lines.push('', '## 損失最多的細格（再分雙方實際點力：門檻可能不對的地方）', '')
  lines.push('| 類別 | TKB → 替代 | 雙方點力 | 對照 | TKB − 替代 | 替代較好 | 每千副 |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- |')
  for (const { c, t } of fine.slice(0, 30))
    lines.push(`| ${CATEGORY_LABEL[c.category]} | ${ACTION_LABEL[t.tkb]} → ${ALT_LABEL[t.alt]} | ${t.bucket} | ${t.n} | ${signed(t.mean)} ± ${t.error.toFixed(2)} | ${percent(t.altBetter, t.n)} | ${signed(per1000(t.total), 1)} |`)
  lines.push('', '## 每一類：TKB 的叫品對替代叫品', '')
  lines.push('| 類別 | TKB → 替代 | 對照 | TKB − 替代 | 替代較好 | 每千副 |')
  lines.push('| --- | --- | --- | --- | --- | --- |')
  for (const c of shown)
    for (const t of c.transitions)
      lines.push(`| ${CATEGORY_LABEL[c.category]} | ${ACTION_LABEL[t.tkb]} → ${ALT_LABEL[t.alt]} | ${t.n} | ${signed(t.mean)} ± ${t.error.toFixed(2)} | ${percent(t.altBetter, t.n)} | ${signed(per1000(t.total), 1)} |`)
  lines.push('', '## 依雙方實際點力（牌值判斷的邊界）', '')
  lines.push('「少叫」欄是 TKB 對 Pass 或少叫一線的替代：負的表示 TKB 叫太多；「多叫」欄是對多叫一線、成局、滿貫或出手的替代：負的表示 TKB 叫太少。括號是對照數。', '')
  for (const c of shown) {
    if (!c.byPoints.length) continue
    lines.push(`### ${CATEGORY_LABEL[c.category]}`, '')
    lines.push('| 雙方點力 | 決策 | TKB − 少叫 | TKB − 多叫 | TKB − par |')
    lines.push('| --- | --- | --- | --- | --- |')
    for (const b of c.byPoints) lines.push(`| ${b.bucket} | ${b.decisions} | ${cellText(b.conservative)} | ${cellText(b.aggressive)} | ${signed(b.vsPar)} |`)
    lines.push('')
  }
  for (const c of shown) {
    if (!c.worst.length) continue
    lines.push('', `## ${CATEGORY_LABEL[c.category]}：TKB 損失最大的牌例`, '')
    lines.push('| 副 | 發牌／身價 | 座位 | 手牌 | 雙方點力 | 叫牌到這裡 | TKB → 合約（分） | 替代 → 合約（分） | IMP | par |')
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
    for (const e of c.worst)
      lines.push(
        `| ${e.board} | ${e.dealer}／${e.vul} | ${e.seat} | ${handLabel(e.hand)} | ${e.pairHcp} | ${auctionLabel(e.before)} | ${callLabel(e.tkb)} → ${contractLabel(e.tkbContract)}（${e.tkbScore}） | ${callLabel(e.alternative)} → ${contractLabel(e.altContract)}（${e.altScore}） | ${e.imps} | ${e.par} |`,
      )
  }
  return lines.join('\n') + '\n'
}

// ---------------------------------------------------------------------------------------------
// Practice deals (shared/practice-sets/*.json, for the bidding practice room, U2b reads them)

/**
 * A practice deal as the practice room reads it: `{ id, dealer, vulnerability, hands, category,
 * note }`, plus what the study knows about the decision (the system, the seat to call and the
 * calls before it, the favoured call and TKB's, the IMPs on the deal)
 */
export interface PracticeDeal {
  id: string
  dealer: Seat
  vulnerability: 'None' | 'NS' | 'EW' | 'All'
  /** The four hands as a PBN deal, North first: 'N:AK32.KQ4.J52.Q43 … … …' */
  hands: string
  category: BiddingCategory
  /** The teaching point, in Traditional Chinese */
  note: string
  system: RobotKind
  board: number
  seat: Seat
  auction: Call[]
  answer: Call
  tkb: Call
  imps: number
}

/** The practice room writes both vulnerable as 'All' */
const practiceVul = (vul: Vulnerability): PracticeDeal['vulnerability'] => (vul === 'Both' ? 'All' : vul)

const shapeOf = (pbn: string) => pbn.split('.').map((ranks) => ranks.length).join('-')

const POSITION: Record<BiddingCategory, string> = {
  opening: '輪到你開叫',
  response: '同伴開叫之後',
  game: '我方自由叫牌',
  slam: '我方已到成局',
  direct: '對方開叫之後',
  takeout: '對方開叫之後',
  balancing: '平衡位置（再 Pass 叫牌就結束）',
  preempt: '對方阻擊之後',
  notrump: '對方開叫 1NT 之後',
  high: '對方叫到高線之後',
  contested: '我方開叫、對方插叫之後',
}

/** The teaching point of a decision: what the deal says the hand should do */
export function practiceNote(e: Example): string {
  const pts = hcp(e.hand.split('.').flatMap((ranks, i) => [...ranks].map((r) => SUITS[i] + r)))
  const lead = `${auctionLabel(e.before)}，${POSITION[e.category]}，你 ${pts} 點 ${shapeOf(e.hand)}`
  const kind = altKind(e.tkb, e.alternative)
  const competitive = GROUP_OF(e.category) === 'competitive'
  const why: Record<AltKind, string> = {
    pass: competitive ? '這手牌不值得在這個高度出手，Pass 讓對方去打' : '牌力不夠再往上，停在這裡',
    lower: '這副少叫一線就夠，不必叫到那麼高',
    higher: e.category === 'slam' ? '雙方牌力夠滿貫，再叫上去' : e.category === 'high' ? '我方配合夠長，再叫一線競叫或犧牲' : '牌力夠再叫一線（邀請或成局）',
    strain: '換一個王牌（或無王）比較好打',
    double: e.category === 'high' || e.category === 'notrump' ? '對方叫得太高，賭倍處罰' : e.category === 'contested' ? '用賭倍表示牌力，讓同伴決定' : '短門在對方的花色，該賭倍讓同伴選花色',
    bid: e.category === 'opening' ? '這手牌值得開叫' : e.category === 'response' ? '有牌力就要答叫' : competitive || e.category === 'contested' ? '這手牌值得出手叫出來' : '牌力夠，該叫下去',
  }
  return `${lead}：TKB 叫 ${callLabel(e.tkb)}，這副 ${callLabel(e.alternative)} 比較好（${-e.imps} IMP，雙方合計 ${e.pairHcp} 點）。${why[kind]}。`
}

/**
 * The deals of a study worth practising: decisions where the alternative beat TKB by `minImps` or
 * more, and only where that kind of alternative is better on average in that kind of decision (so
 * the lesson is not one lucky lie), the biggest first, at most `perCategory` a kind
 */
export function practiceDeals(
  records: Iterable<BiddingRecord>,
  hands: (board: number) => Hands,
  study: BiddingStudy,
  categories: readonly BiddingCategory[],
  perCategory = 40,
  minImps = 5,
  minSupport = 20,
  keep: (e: Example) => boolean = () => true,
): PracticeDeal[] {
  // A kind of decision where that kind of alternative wins on average, overall or in the
  // partnership's point range (a slam missed with 31 points teaches something, whatever the rest)
  const good = new Set<string>()
  for (const c of study.categories) {
    for (const t of c.transitions) if (t.mean < 0 && t.n >= minSupport) good.add(`${c.category}|${t.tkb}|${t.alt}`)
    for (const t of c.fine) if (t.mean < 0 && t.n >= minSupport) good.add(`${c.category}|${t.tkb}|${t.alt}|${t.bucket}`)
  }
  const picked = new Map<BiddingCategory, PracticeDeal[]>()
  for (const record of records) {
    const calls = record.auction.split('-')
    for (const p of record.points) {
      if (!categories.includes(p.category)) continue
      for (const a of p.alternatives) {
        const e = exampleOf(record, p, a)
        const cell = `${p.category}|${actionOf(p.tkb)}|${altKind(p.tkb, a.call)}`
        if (-e.imps < minImps || !(good.has(cell) || good.has(`${cell}|${hcpBucket(p.pairHcp)}`)) || !keep(e)) continue
        at(picked, p.category, () => []).push({
          id: `${GROUP_OF(p.category) === 'constructive' ? 'bid' : 'comp'}-${record.system}-${record.board}-${p.index + 1}`,
          dealer: record.dealer,
          vulnerability: practiceVul(record.vul),
          hands: pbnOf(hands(record.board)),
          category: p.category,
          note: practiceNote(e),
          system: record.system,
          board: record.board,
          seat: p.seat,
          auction: calls.slice(0, p.index),
          answer: a.call,
          tkb: p.tkb,
          imps: -e.imps,
        })
      }
    }
  }
  const out: PracticeDeal[] = []
  for (const category of categories) {
    const list = (picked.get(category) ?? []).sort((a, b) => b.imps - a.imps || a.board - b.board)
    const ids = new Set<string>()
    for (const deal of list) {
      if (ids.has(deal.id)) continue
      ids.add(deal.id)
      out.push(deal)
      if (ids.size === perCategory) break
    }
  }
  return out
}
