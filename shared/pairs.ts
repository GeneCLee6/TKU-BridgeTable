import type { Contract } from './auction.ts'
import type { Card } from './cards.ts'
import { plannedPlays, type Movement, type PairDirection } from './movement.ts'
import type { PublicUser } from './protocol.ts'

/**
 * Pairs events (雙人賽, `e9-t10`–`e9-t13`, AC-9.4, ARCHITECTURE.md §5.22): the settings, the
 * matchpoint scoring with the Neuberg adjustment, and what the pages see. Pure functions; the
 * event itself lives in `worker/pairs-flow.ts`, what each viewer may see is cut in `worker/views.ts`.
 */

export const PAIRS_STATUSES = ['open', 'playing', 'finished', 'cancelled'] as const
export type PairsStatus = (typeof PAIRS_STATUSES)[number]

export const PAIRS_LIMITS = { titleMax: 40, boardMinutesMax: 30 } as const

export interface PairsSettings {
  /** Shown on the list and the page; empty shows 「雙人賽」 */
  title: string
  /** Boards a round (1–4); fewer when the tables would need more than 32 boards (`boardsPerRoundFor`) */
  boardsPerRound: number
  /** Each board's time limit at the tables, 0 for none */
  boardMinutes: number
}

export const DEFAULT_PAIRS_SETTINGS: PairsSettings = { title: '', boardsPerRound: 3, boardMinutes: 8 }

/** Settings from a request, or null when any field given is wrong */
export function parsePairsSettings(value: unknown): PairsSettings | null {
  const input = (value ?? {}) as Partial<Record<keyof PairsSettings, unknown>>
  if (typeof input !== 'object') return null
  const settings = { ...DEFAULT_PAIRS_SETTINGS }
  if (input.title !== undefined) {
    if (typeof input.title !== 'string') return null
    const title = input.title.trim()
    if (title.length > PAIRS_LIMITS.titleMax) return null
    settings.title = title
  }
  if (input.boardsPerRound !== undefined) {
    if (!Number.isInteger(input.boardsPerRound) || (input.boardsPerRound as number) < 1 || (input.boardsPerRound as number) > 4)
      return null
    settings.boardsPerRound = input.boardsPerRound as number
  }
  if (input.boardMinutes !== undefined) {
    const minutes = input.boardMinutes as number
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > PAIRS_LIMITS.boardMinutesMax) return null
    settings.boardMinutes = minutes
  }
  return settings
}

/** One board played at one table of a round */
export interface PairsResult {
  round: number
  table: number
  boardNo: number
  /** The pairs (indices in the event's list) */
  ns: number
  ew: number
  /** The board record (`board:<id>`) */
  boardId: string
  scoreNS: number
  contract: Contract | null
  declarerTricks: number | null
  lead?: Card
  playedAt: number
}

/** A result's matchpoints, Neuberg-adjusted, as percentages for each side */
export interface ScoredResult {
  result: PairsResult
  /** Adjusted matchpoints on the 2-a-beat scale, out of `top` */
  mpNS: number
  mpEW: number
  top: number
  percentNS: number
  percentEW: number
}

export interface PairStanding {
  pair: number
  dir: PairDirection
  /** Equal percentages share a place: 1, 2, 2, 4 */
  rank: number
  /** The adjusted matchpoints added up, and their share of the tops of the boards played */
  mp: number
  percent: number
  boards: number
}

const SAME = 1e-9

/**
 * Matchpoints (2 for every result beaten, 1 for a tie; NS compared with NS, EW gets the rest) on
 * each board, adjusted by **Neuberg** to the most a board is played in the movement (N):
 * `mp' = (mp + 1) × N / n − 1`, top `2 × (N − 1)`, where n is how often this board was played.
 * A board played once gets 50%. Then each field (NS, EW) is ranked by its share of the tops of
 * the boards it played, so a pair that sat out or has not played every board yet compares fairly
 * (the live standings, `e9-t12`).
 */
export function scorePairs(movement: Movement, results: PairsResult[]): { scored: ScoredResult[]; standings: PairStanding[] } {
  const most = Math.max(1, ...plannedPlays(movement))
  const top = 2 * (most - 1)
  const byBoard = new Map<number, PairsResult[]>()
  for (const r of results) byBoard.set(r.boardNo, [...(byBoard.get(r.boardNo) ?? []), r])
  const scored: ScoredResult[] = []
  for (const list of byBoard.values()) {
    const n = list.length
    for (const r of list) {
      const raw = list.reduce((sum, o) => sum + (o === r ? 0 : r.scoreNS > o.scoreNS ? 2 : r.scoreNS === o.scoreNS ? 1 : 0), 0)
      const mpNS = top ? ((raw + 1) * most) / n - 1 : 0
      const mpEW = top - mpNS
      const percentNS = top ? (mpNS / top) * 100 : 50
      scored.push({ result: r, mpNS, mpEW, top, percentNS, percentEW: 100 - percentNS })
    }
  }
  const totals = new Map<number, { mp: number; boards: number; dir: PairDirection }>()
  for (let pair = 0; pair < movement.pairs; pair++)
    totals.set(pair, { mp: 0, boards: 0, dir: pair < movement.tables ? 'NS' : 'EW' })
  for (const s of scored) {
    const ns = totals.get(s.result.ns)
    const ew = totals.get(s.result.ew)
    if (ns) {
      ns.mp += s.mpNS
      ns.boards++
    }
    if (ew) {
      ew.mp += s.mpEW
      ew.boards++
    }
  }
  const standings: PairStanding[] = [...totals].map(([pair, t]) => ({
    pair,
    dir: t.dir,
    rank: 0,
    mp: t.mp,
    percent: t.boards ? (top ? (t.mp / (t.boards * top)) * 100 : 50) : 0,
    boards: t.boards,
  }))
  for (const s of standings)
    s.rank = 1 + standings.filter((o) => o.dir === s.dir && o.boards > 0 && o.percent > s.percent + SAME).length
  standings.sort((a, b) => (a.dir === b.dir ? a.rank - b.rank || a.pair - b.pair : a.dir === 'NS' ? -1 : 1))
  return { scored, standings }
}

// ── What the pages see (`GET /api/pairs`, `GET /api/pairs/:id`, built in worker/views.ts) ──────

export interface PairsSummary {
  id: string
  title: string
  status: PairsStatus
  director: PublicUser
  createdAt: number
  pairs: number
  /** The viewer is in a pair */
  mine: boolean
  round: number
  rounds: number
}

export interface PairsPairView {
  /** The pair's index in the list */
  pair: number
  players: PublicUser[]
  /** From the start: its place in the movement */
  dir?: PairDirection
  no?: number
}

export interface PairsTableView {
  table: number
  ns: number
  ew: number
  tableId: string
  boards: number[]
  /** Boards finished at it this round */
  played: number
}

export interface PairsTravellerEntry {
  round: number
  table: number
  ns: number
  ew: number
  contract: Contract | null
  declarerTricks: number | null
  lead?: Card
  scoreNS: number
  percentNS: number
  /** Only when the viewer may open the record: their own, or once the event is over */
  boardId?: string
}

export interface PairsTraveller {
  boardNo: number
  entries: PairsTravellerEntry[]
}

export interface PairsView {
  id: string
  title: string
  status: PairsStatus
  director: PublicUser
  createdAt: number
  settings: PairsSettings
  pairs: PairsPairView[]
  /** The viewer's pair, if they are in one */
  myPair?: number
  /** From the start */
  movement?: { kind: 'mitchell'; tables: number; rounds: number; boardsPerRound: number; boards: number }
  round: number
  /** The viewer's table this round (null: they sit out); absent when they play none */
  myTable?: PairsTableView | null
  /** The current round's tables */
  tables: PairsTableView[]
  /** The live standings, by field */
  standings: PairStanding[]
  /**
   * The boards' travellers the viewer may see: while the event is on, a player sees only those of
   * the boards their pair already played (the director who is not playing sees all); everyone once it is over
   */
  travellers: PairsTraveller[]
  startedAt?: number
  finishedAt?: number
  /** The viewer may start, cancel or remove pairs */
  canDirect: boolean
}
