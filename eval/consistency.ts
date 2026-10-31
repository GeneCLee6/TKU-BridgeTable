import { isAuctionComplete, seatToCall, type AuctionCall, type Call } from '../shared/auction.ts'
import type { Vulnerability } from '../shared/board.ts'
import { partnerOf, SUITS, type Card, type Hands, type Seat } from '../shared/cards.ts'
import { newBoard } from '../shared/game.ts'
import type { RobotKind } from '../shared/protocol.ts'
import { ROBOT_SYSTEMS } from '../shared/robot/robots.ts'
import { contextOf, emptyReading } from '../shared/robot/system/context.ts'
import { choose } from '../shared/robot/system/engine.ts'
import { evaluate, fits } from '../shared/robot/system/evaluate.ts'
import { intersect } from '../shared/robot/system/infer.ts'
import { meanings } from '../shared/robot/system/rules.ts'
import { ANY, type Range, type Spec } from '../shared/robot/system/spec.ts'
import { evalBoards } from './deals.ts'
import { inferenceAuction, loadInferenceBank } from './inference.ts'
import { auctionOf, loadBank, parseHand, seatOf } from './quiz.ts'

/**
 * The consistency check (X2, eval/README.md): a player's later call must not be explained as
 * something their earlier calls already ruled out ("11+ HCP" and then "7–10"). Each auction is
 * read call by call the way the robots read it (`infer.ts`); before a call is added to what its
 * player has shown, its explanation is set against it, feature by feature (high-card points, total
 * points, each suit's length), and any feature whose two ranges do not overlap is a conflict. Two
 * explanations are checked: what partner and the bidding box read the call as (`meanings`, every
 * rule for the call), and for a robot's own call the alert it gives (`choose`, the rule it used).
 *
 * The auctions: the eval deal set bid out by four TKBs in each system, the bidding quiz's
 * auctions with both the book's answer and TKB's, and the inference quiz's auctions.
 */

export type Explanation = 'reading' | 'alert'
export type Source = 'deal' | 'quiz' | 'inference'

export interface Conflict {
  system: RobotKind
  source: Source
  /** Board number or question id */
  id: string
  /** Which explanation contradicts what the player showed */
  kind: Explanation
  seat: Seat
  /** Every call up to and including the one in conflict */
  auction: Call[]
  /** The auction as the rules see it (our side bare, theirs in brackets), ending with the call */
  pattern: string
  /** `hcp`, `tp`, `len S`… or `shape` (the suit lengths shown add up to more than 13) */
  feature: string
  known?: Range
  shown?: Range
  /** For a robot's call: whether its hand fits what the call is explained as */
  handFits?: boolean
}

const overlap = (a: Range | undefined, b: Range | undefined) => !a || !b || (a[0] <= b[1] && b[0] <= a[1])

/** The features where `shown` contradicts `known` */
export function contradictions(known: Spec, shown: Spec): { feature: string; known?: Range; shown?: Range }[] {
  const out: { feature: string; known?: Range; shown?: Range }[] = []
  if (!overlap(known.hcp, shown.hcp)) out.push({ feature: 'hcp', known: known.hcp, shown: shown.hcp })
  if (!overlap(known.tp, shown.tp)) out.push({ feature: 'tp', known: known.tp, shown: shown.tp })
  // Total points are never fewer than high-card points
  else if (known.hcp && shown.tp && shown.tp[1] < known.hcp[0]) out.push({ feature: 'tp', known: known.hcp, shown: shown.tp })
  for (const s of SUITS)
    if (!overlap(known.len?.[s], shown.len?.[s])) out.push({ feature: `len ${s}`, known: known.len![s], shown: shown.len![s] })
  if (!out.length) {
    const both = intersect(known, shown)
    const least = SUITS.reduce((sum, s) => sum + (both.len?.[s]?.[0] ?? 0), 0)
    const most = SUITS.reduce((sum, s) => sum + (both.len?.[s]?.[1] ?? 13), 0)
    if (least > 13 || most < 13) out.push({ feature: 'shape' })
  }
  return out
}

interface Walk {
  system: RobotKind
  source: Source
  id: string
  dealer: Seat
  vul: Vulnerability
  auction: readonly AuctionCall[]
  /** Hands, when the robots bid them */
  hands?: Partial<Record<Seat, readonly Card[]>>
  /** Alerts the robots gave, by index in the auction */
  alerts?: Map<number, Spec | undefined>
}

/** Every conflict in one auction */
export function auctionConflicts(walk: Walk): Conflict[] {
  const system = ROBOT_SYSTEMS[walk.system]
  const reading = emptyReading()
  const found: Conflict[] = []
  for (let i = 0; i < walk.auction.length; i++) {
    const { seat, call } = walk.auction[i]
    const ctx = contextOf(seat, walk.auction.slice(0, i), walk.dealer, walk.vul, reading)
    const spec = meanings(system, ctx).get(call)
    const known = reading.shown[seat]
    const cards = walk.hands?.[seat]
    const add = (kind: Explanation, shows: Spec) => {
      for (const c of contradictions(known, shows))
        found.push({
          system: walk.system,
          source: walk.source,
          id: walk.id,
          kind,
          seat,
          auction: walk.auction.slice(0, i + 1).map((a) => a.call),
          pattern: [...ctx.key, call].join(' '),
          ...c,
          ...(cards ? { handFits: fits(evaluate(cards), shows) } : {}),
        })
    }
    if (spec) add('reading', spec)
    const alert = walk.alerts?.get(i)
    if (alert && JSON.stringify(alert) !== JSON.stringify(spec)) add('alert', alert)
    reading.forcing[seat] = spec?.forcing
    reading.said[seat] = spec
    if (!spec) continue
    reading.shown[seat] = intersect(reading.shown[seat], spec)
    if (spec.forcing === 'game') reading.gameForce[seat] = reading.gameForce[partnerOf(seat)] = true
  }
  return found
}

/** Four TKBs bid a deal out; the auction and each call's alert */
export function bidOut(kind: RobotKind, hands: Hands, dealer: Seat, vul: Vulnerability): { auction: AuctionCall[]; alerts: Map<number, Spec | undefined> } {
  const system = ROBOT_SYSTEMS[kind]
  const auction: AuctionCall[] = []
  const alerts = new Map<number, Spec | undefined>()
  while (!isAuctionComplete(auction) && auction.length < 60) {
    const seat = seatToCall(dealer, auction.length)
    const { call, shows } = choose(system, hands[seat], seat, auction, dealer, vul)
    if (call !== 'P') alerts.set(auction.length, shows)
    auction.push({ seat, call })
  }
  return { auction, alerts }
}

export interface ConsistencyOptions {
  systems?: readonly RobotKind[]
  /** How many boards of the eval set to bid out (from board 1) */
  deals?: number
  seed?: string
  /** Include the bidding and inference quizzes */
  quizzes?: boolean
}

export interface Consistency {
  conflicts: Conflict[]
  /** Calls checked, by `system source` */
  calls: Record<string, number>
}

export function consistencyCheck(options: ConsistencyOptions = {}): Consistency {
  const systems = options.systems ?? (['tku', 'gib'] as const)
  const conflicts: Conflict[] = []
  const calls: Record<string, number> = {}
  const check = (walk: Walk, only?: number) => {
    const key = `${walk.system} ${walk.source}`
    calls[key] = (calls[key] ?? 0) + (only === undefined ? walk.auction.length : 1)
    conflicts.push(...auctionConflicts(walk).filter((c) => only === undefined || c.auction.length === only + 1))
  }
  const boards = evalBoards(options.deals ?? 0, options.seed)
  for (const system of systems) {
    for (const board of boards) {
      const { dealer, vul } = newBoard(board.boardNo, board.hands)
      const { auction, alerts } = bidOut(system, board.hands, dealer, vul)
      check({ system, source: 'deal', id: String(board.boardNo), dealer, vul, auction, hands: board.hands, alerts })
    }
    if (options.quizzes === false) continue
    // The bidding quiz: the auction with the book's answer, and TKB's call when it differs
    for (const file of loadBank())
      for (const q of file.questions) {
        if (q.system !== system) continue
        const before = auctionOf(q)
        const seat = seatOf(q)
        const cards = parseHand(q.hand)
        const robot = choose(ROBOT_SYSTEMS[system], cards, seat, before, q.dealer, q.vul)
        const walk = { system, source: 'quiz' as const, dealer: q.dealer, vul: q.vul, hands: { [seat]: cards } }
        check({ ...walk, id: q.id, auction: [...before, { seat, call: q.answer }] })
        const alerts = robot.call === 'P' ? undefined : new Map([[before.length, robot.shows]])
        if (robot.call !== q.answer) check({ ...walk, id: `${q.id} (TKB)`, auction: [...before, { seat, call: robot.call }], alerts }, before.length)
      }
    for (const file of loadInferenceBank())
      for (const q of file.questions)
        if (q.system === system) check({ system, source: 'inference', id: q.id, dealer: q.dealer, vul: q.vul, auction: inferenceAuction(q) })
  }
  return { conflicts, calls }
}

const range = (r: Range | undefined) => (!r ? '—' : r[1] >= ANY ? `${r[0]}+` : `${r[0]}–${r[1]}`)

/** The conflicts counted by system, explanation and source, and the most frequent auctions */
export function consistencyReport({ conflicts, calls }: Consistency, top = 30): string {
  const lines: string[] = ['calls checked:']
  for (const [k, n] of Object.entries(calls)) lines.push(`  ${k.padEnd(24)} ${n}`)
  const count = (pick: (c: Conflict) => string) => {
    const m = new Map<string, number>()
    for (const c of conflicts) m.set(pick(c), (m.get(pick(c)) ?? 0) + 1)
    return [...m].sort((a, b) => b[1] - a[1])
  }
  lines.push(`conflicts: ${conflicts.length}`)
  for (const [k, n] of count((c) => `${c.system} ${c.source} ${c.kind}`)) lines.push(`  ${k.padEnd(24)} ${n}`)
  lines.push('', 'by feature:')
  for (const [k, n] of count((c) => `${c.system} ${c.feature}`)) lines.push(`  ${k.padEnd(24)} ${n}`)
  lines.push('', `most frequent (system kind pattern feature: known → shown, hand fits):`)
  const groups = new Map<string, Conflict[]>()
  for (const c of conflicts) {
    const k = `${c.system} ${c.kind} ${c.pattern} | ${c.feature}`
    groups.set(k, [...(groups.get(k) ?? []), c])
  }
  for (const [k, list] of [...groups].sort((a, b) => b[1].length - a[1].length).slice(0, top)) {
    const c = list[0]
    const fit = list.filter((x) => x.handFits === false).length
    lines.push(`  ${String(list.length).padStart(5)}  ${k}: ${range(c.known)} → ${range(c.shown)}${fit ? `  (hand outside ${fit})` : ''}  e.g. ${c.source} ${c.id}`)
  }
  return lines.join('\n')
}
