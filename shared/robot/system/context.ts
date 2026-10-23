import { bidIndex, isBid, legalCalls, levelOf, strainOf, type AuctionCall, type Call } from '../../auction.ts'
import { isVulnerable, type Vulnerability } from '../../board.ts'
import { nextSeat, partnerOf, SEATS, type Seat, type Strain } from '../../cards.ts'
import type { Spec } from './spec.ts'

/** Who made a call, from the point of view of the seat about to call */
export type Role = 'me' | 'partner' | 'lho' | 'rho'

export interface Turn {
  seat: Seat
  role: Role
  call: Call
  /** Made by our side (me or partner) */
  ours: boolean
}

/** Everything a rule may look at besides the hand: the auction from the caller's seat */
export interface Ctx {
  seat: Seat
  dealer: Seat
  vul: Vulnerability
  auction: readonly AuctionCall[]
  legal: ReadonlySet<Call>
  /** Calls from the opening bid on (passes before it are left out) */
  turns: readonly Turn[]
  /** The opening bid, if anyone has opened */
  opening: Turn | null
  /** The opener's seat position, 1–4; before an opening, the position of the seat to call */
  position: number
  /** I passed before the opening */
  passed: boolean
  partnerPassed: boolean
  weVul: boolean
  theyVul: boolean
  /** What each player has shown so far (`infer`) */
  shown: Record<Role, Spec>
  /** What each player's last call meant, if anything (to answer a convention: RKCB, a relay) */
  said: Partial<Record<Role, Spec>>
  /** Pass is not allowed by agreement: partner forced, or we are in a game force below game */
  forced: boolean
  /** The last bid (not pass, double or redouble), if any */
  last: Turn | null
  /** The auction as a book pattern: '1N (P) 2C (P)' */
  key: readonly string[]
}

/** What `infer` knows about the earlier calls */
export interface Reading {
  shown: Record<Seat, Spec>
  /** What each seat's last call meant */
  said: Partial<Record<Seat, Spec>>
  /** How far each seat's last call forces its partner */
  forcing: Partial<Record<Seat, Spec['forcing']>>
  /** Seats whose side has agreed to play game */
  gameForce: Partial<Record<Seat, boolean>>
}

export const emptyReading = (): Reading => ({ shown: { N: {}, E: {}, S: {}, W: {} }, said: {}, forcing: {}, gameForce: {} })

export function roleOf(me: Seat, seat: Seat): Role {
  return seat === me ? 'me' : seat === partnerOf(me) ? 'partner' : seat === nextSeat(me) ? 'lho' : 'rho'
}

export function contextOf(seat: Seat, auction: readonly AuctionCall[], dealer: Seat, vul: Vulnerability, reading: Reading): Ctx {
  const start = auction.findIndex((c) => isBid(c.call))
  const opened = start >= 0
  const turns: Turn[] = (opened ? auction.slice(start) : []).map((c) => {
    const role = roleOf(seat, c.seat)
    return { seat: c.seat, role, call: c.call, ours: role === 'me' || role === 'partner' }
  })
  const before = opened ? auction.slice(0, start) : auction
  const lastBid = turns.findLast((t) => isBid(t.call)) ?? null
  const shown = {} as Record<Role, Spec>
  const said: Partial<Record<Role, Spec>> = {}
  for (const s of SEATS) {
    shown[roleOf(seat, s)] = reading.shown[s]
    if (reading.said[s]) said[roleOf(seat, s)] = reading.said[s]
  }
  return {
    seat,
    dealer,
    vul,
    auction,
    legal: legalCalls(auction, dealer),
    turns,
    opening: turns[0] ?? null,
    position: (opened ? start : auction.length) + 1,
    passed: before.some((c) => c.seat === seat),
    partnerPassed: before.some((c) => c.seat === partnerOf(seat)),
    weVul: isVulnerable(vul, seat),
    theyVul: isVulnerable(vul, nextSeat(seat)),
    shown,
    said,
    forced: isForced(seat, turns, lastBid, reading),
    last: lastBid,
    key: turns.map((t) => (t.ours ? t.call : `(${t.call})`)),
  }
}

/** Game for a strain: 3NT, 4♥/4♠, 5♣/5♦ */
export const gameLevel = (strain: Strain) => (strain === 'N' ? 3 : strain === 'H' || strain === 'S' ? 4 : 5)

function isForced(seat: Seat, turns: readonly Turn[], lastBid: Turn | null, reading: Reading): boolean {
  const partner = turns.findLast((t) => t.role === 'partner')
  if (!partner) return false
  const after = turns.slice(turns.lastIndexOf(partner) + 1)
  // An opponent's double or bid frees us to pass
  if (after.some((t) => t.call !== 'P')) return false
  if (partner.call === 'P') return false
  if (reading.forcing[partner.seat]) return true
  return !!reading.gameForce[seat] && !!lastBid && lastBid.ours && levelOf(lastBid.call) < gameLevel(strainOf(lastBid.call))
}

/** Splits a book pattern into tokens; '' is the empty auction */
export const tokens = (pattern: string): string[] => pattern.split(' ').filter(Boolean)

/**
 * Whether the auction fits a book pattern. Tokens count back from the caller: the last one is the
 * right-hand opponent's, the one before partner's, so ours and theirs alternate
 */
export function fitsPattern(pattern: readonly string[], key: readonly string[]): boolean {
  if (pattern.length !== key.length) return false
  for (let i = 0; i < key.length; i++) {
    const p = pattern[i]
    const k = key[i]
    if (p === k) continue
    const theirs = k.startsWith('(')
    if (p === '*' && !theirs) continue
    if (p === '(*)' && theirs) continue
    if (p === '(+)' && theirs && k !== '(P)') continue
    return false
  }
  return true
}

/** A pattern is well formed when the opponents' calls (in brackets) sit where the opponents call */
export function patternProblem(pattern: string): string | null {
  const list = tokens(pattern)
  for (let i = 0; i < list.length; i++) {
    const theirs = (list.length - 1 - i) % 2 === 0
    const bracketed = list[i].startsWith('(') && list[i].endsWith(')')
    if (theirs !== bracketed) return `'${pattern}': '${list[i]}' is ${theirs ? 'theirs' : 'ours'}`
    const call = bracketed ? list[i].slice(1, -1) : list[i]
    if (!['*', '+', 'P', 'X', 'XX'].includes(call) && !isBid(call)) return `'${pattern}': '${list[i]}' is not a call`
    if (call === '+' && !theirs) return `'${pattern}': '+' is only for the opponents`
  }
  return null
}

// ── Helpers for rules ─────────────────────────────────────────────────────────────────────────

const bid = (level: number, strain: Strain): Call => `${level}${strain}`

/** The cheapest legal bid in a strain */
export function cheapest(ctx: Ctx, strain: Strain): Call | null {
  for (let level = 1; level <= 7; level++) if (ctx.legal.has(bid(level, strain))) return bid(level, strain)
  return null
}

/** A bid `extra` levels above the cheapest in the strain (1 is a single jump) */
export function jump(ctx: Ctx, strain: Strain, extra = 1): Call | null {
  const base = cheapest(ctx, strain)
  if (!base) return null
  const level = levelOf(base) + extra
  return level <= 7 ? bid(level, strain) : null
}

/** How many levels a bid jumps over the cheapest bid in its strain */
export function jumpOf(ctx: Ctx, call: Call): number {
  const base = cheapest(ctx, strainOf(call))
  return base ? levelOf(call) - levelOf(base) : 0
}

/** The calls one player made from the opening on */
export const callsOf = (ctx: Ctx, role: Role): Call[] => ctx.turns.filter((t) => t.role === role).map((t) => t.call)

/** The last call by a player, if any */
export const lastOf = (ctx: Ctx, role: Role): Call | undefined => ctx.turns.findLast((t) => t.role === role)?.call

/** Strains anyone has bid */
export const bidStrains = (ctx: Ctx, side?: 'ours' | 'theirs'): Strain[] => [
  ...new Set(
    ctx.turns
      .filter((t) => isBid(t.call) && (side === undefined || t.ours === (side === 'ours')))
      .map((t) => strainOf(t.call)),
  ),
]

/** Whether `a` is a higher bid than `b` */
export const above = (a: Call, b: Call) => bidIndex(a) > bidIndex(b)
