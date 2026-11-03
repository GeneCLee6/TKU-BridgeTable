import type { PublicUser } from './protocol.ts'
import { TAIWAN_OFFSET_MS } from './weekly-challenge.ts'

/**
 * Club points (社團積分, `e9-t04`–`e9-t06`, AC-9.2, ARCHITECTURE.md §5.21): every finished event gives
 * points by place and by how many sides took part, under rules the admins set per kind of event.
 * Each entry in the ledger names its event, so every point can be traced. Pure functions only.
 */

/** The kinds of event that give points; `pairs` is the pairs event (J3), `individual` the individual event (`e9-t15`) */
export const POINT_KINDS = ['daily', 'weekly', 'challenge', 'match', 'pairs', 'individual'] as const
export type PointKind = (typeof POINT_KINDS)[number]
export const isPointKind = (value: unknown): value is PointKind => POINT_KINDS.includes(value as PointKind)

/**
 * One kind's rule: a side (a player, a pair or a team) placed in a field of N sides gets
 * `participation + perBeaten × (sides placed below it)`, each member the whole of it. Ties share a
 * place and beat the same sides. Fewer than `minSides` ranked sides: no points at all
 */
export interface PointsKindRule {
  enabled: boolean
  participation: number
  perBeaten: number
  minSides: number
}

/** A season (賽季) for the year board: Taiwan dates, both ends included */
export interface Season {
  id: string
  name: string
  /** YYYY-MM-DD */
  from: string
  /** YYYY-MM-DD */
  to: string
}

export interface PointsRules {
  kinds: Record<PointKind, PointsKindRule>
  /** Empty: the year board is the calendar year */
  seasons: Season[]
}

/**
 * The defaults (保守預設, waiting for the club to decide, ARCHITECTURE.md §5.21): the club's own
 * events count most; a challenge among friends needs three who finished, so two cannot trade wins
 */
export const DEFAULT_POINTS_RULES: PointsRules = {
  kinds: {
    daily: { enabled: true, participation: 1, perBeaten: 1, minSides: 2 },
    weekly: { enabled: true, participation: 2, perBeaten: 2, minSides: 2 },
    challenge: { enabled: true, participation: 0, perBeaten: 1, minSides: 3 },
    match: { enabled: true, participation: 2, perBeaten: 4, minSides: 2 },
    pairs: { enabled: true, participation: 2, perBeaten: 1, minSides: 3 },
    // Every player one side: twice the sides of a pairs event of the same size, so half a point a side beaten
    individual: { enabled: true, participation: 2, perBeaten: 0.5, minSides: 4 },
  },
  seasons: [],
}

export const POINTS_LIMITS = {
  points: 100,
  minSides: { min: 2, max: 100 },
  seasons: 20,
  seasonName: 30,
  /** A correction's reason */
  reason: 200,
} as const

/** One side of a finished event and its place */
export interface PlacedSide {
  userIds: readonly string[]
  rank: number
}

export interface PlacePoints {
  userId: string
  rank: number
  /** Sides ranked */
  field: number
  points: number
}

/** Rounded to tenths, so sums stay tidy */
const tenths = (n: number) => Math.round(n * 10) / 10

/** What each member of each side gets under `rule`; nothing when the rule is off or the field too small */
export function placePoints(rule: PointsKindRule, sides: readonly PlacedSide[]): PlacePoints[] {
  if (!rule.enabled || sides.length < rule.minSides) return []
  const field = sides.length
  const seen = new Set<string>()
  const out: PlacePoints[] = []
  for (const side of sides) {
    const beaten = sides.filter((other) => other.rank > side.rank).length
    const points = tenths(rule.participation + rule.perBeaten * beaten)
    for (const userId of side.userIds) {
      if (seen.has(userId)) continue
      seen.add(userId)
      out.push({ userId, rank: side.rank, field, points })
    }
  }
  return out
}

const DATE = /^\d{4}-\d{2}-\d{2}$/
const isDate = (s: unknown): s is string => typeof s === 'string' && DATE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))

function parseKindRule(value: unknown, current: PointsKindRule): PointsKindRule | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { enabled, participation, perBeaten, minSides, ...rest } = value as Record<string, unknown>
  if (Object.keys(rest).length) return null
  const points = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= POINTS_LIMITS.points
  if (enabled !== undefined && typeof enabled !== 'boolean') return null
  if (participation !== undefined && !points(participation)) return null
  if (perBeaten !== undefined && !points(perBeaten)) return null
  if (
    minSides !== undefined &&
    (!Number.isInteger(minSides) || (minSides as number) < POINTS_LIMITS.minSides.min || (minSides as number) > POINTS_LIMITS.minSides.max)
  )
    return null
  return {
    enabled: (enabled as boolean | undefined) ?? current.enabled,
    participation: tenths((participation as number | undefined) ?? current.participation),
    perBeaten: tenths((perBeaten as number | undefined) ?? current.perBeaten),
    minSides: (minSides as number | undefined) ?? current.minSides,
  }
}

function parseSeason(value: unknown): Season | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { id, name, from, to, ...rest } = value as Record<string, unknown>
  if (Object.keys(rest).length) return null
  if (typeof id !== 'string' || !/^[\w-]{1,20}$/.test(id)) return null
  if (typeof name !== 'string' || !name.trim() || name.trim().length > POINTS_LIMITS.seasonName) return null
  if (!isDate(from) || !isDate(to) || from > to) return null
  return { id, name: name.trim(), from, to }
}

/** Checks what an admin sent: any of `kinds` (each kind's fields optional) and `seasons` (the whole list) */
export function parsePointsRules(
  value: unknown,
  current: PointsRules = DEFAULT_POINTS_RULES,
): { rules: PointsRules } | { field: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { field: 'rules' }
  const { kinds, seasons, ...rest } = value as Record<string, unknown>
  const extra = Object.keys(rest)[0]
  if (extra !== undefined) return { field: extra }
  const next: PointsRules = { kinds: { ...current.kinds }, seasons: current.seasons }
  if (kinds !== undefined) {
    if (!kinds || typeof kinds !== 'object' || Array.isArray(kinds)) return { field: 'kinds' }
    for (const [kind, rule] of Object.entries(kinds)) {
      if (!isPointKind(kind)) return { field: kind }
      const parsed = parseKindRule(rule, current.kinds[kind])
      if (!parsed) return { field: kind }
      next.kinds[kind] = parsed
    }
  }
  if (seasons !== undefined) {
    if (!Array.isArray(seasons) || seasons.length > POINTS_LIMITS.seasons) return { field: 'seasons' }
    const list: Season[] = []
    for (const s of seasons) {
      const parsed = parseSeason(s)
      if (!parsed || list.some((o) => o.id === parsed.id)) return { field: 'seasons' }
      list.push(parsed)
    }
    next.seasons = list.sort((a, b) => a.from.localeCompare(b.from))
  }
  return { rules: next }
}

// ── Periods: months, years and seasons, in Taiwan time ─────────────────────────────────────────

/** A board's period: what it is called and the times it covers, `from` included, `to` not */
export type PeriodKey = { month: string } | { year: string } | { season: string }

export interface Period {
  kind: 'month' | 'year' | 'season'
  /** YYYY-MM, YYYY or the season's id */
  key: string
  /** The season's name; absent for months and years */
  name?: string
  from: number
  to: number
}

/** 00:00 Taiwan time of a Taiwan date */
const startOf = (y: number, m: number, d: number) => Date.UTC(y, m, d) - TAIWAN_OFFSET_MS

/** The Taiwan month of `t`, YYYY-MM */
export const taiwanMonth = (t: number): string => new Date(t + TAIWAN_OFFSET_MS).toISOString().slice(0, 7)

/** The month before or after (`step` months), YYYY-MM */
export function shiftMonth(month: string, step: number): string {
  const [y, m] = month.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1 + step, 1)).toISOString().slice(0, 7)
}

/** The period a board asks for, or null when it does not exist (a bad month, an unknown season) */
export function periodOf(key: PeriodKey, seasons: readonly Season[]): Period | null {
  if ('month' in key) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(key.month)) return null
    const [y, m] = key.month.split('-').map(Number)
    return { kind: 'month', key: key.month, from: startOf(y, m - 1, 1), to: startOf(y, m, 1) }
  }
  if ('year' in key) {
    if (!/^\d{4}$/.test(key.year)) return null
    const y = Number(key.year)
    return { kind: 'year', key: key.year, from: startOf(y, 0, 1), to: startOf(y + 1, 0, 1) }
  }
  const season = seasons.find((s) => s.id === key.season)
  if (!season) return null
  const [fy, fm, fd] = season.from.split('-').map(Number)
  const [ty, tm, td] = season.to.split('-').map(Number)
  return { kind: 'season', key: season.id, name: season.name, from: startOf(fy, fm - 1, fd), to: startOf(ty, tm - 1, td + 1) }
}

/** The season `t` falls in, if any */
export function seasonAt(t: number, seasons: readonly Season[]): Season | undefined {
  return seasons.find((s) => {
    const p = periodOf({ season: s.id }, seasons)
    return p && t >= p.from && t < p.to
  })
}

// ── What the pages get ─────────────────────────────────────────────────────────────────────────

export interface LeaderboardRow {
  userId: string
  /** Equal points share a place and the next is skipped: 1, 2, 2, 4 */
  rank: number
  points: number
  /** Events that gave them an entry in the period */
  events: number
  /** Their name and picture, filled in by the server */
  user?: PublicUser
}

/** `GET /api/rankings`: one period's board, with the rules (seasons, for the page's choices) */
export interface LeaderboardView {
  period: Period
  rows: LeaderboardRow[]
  rules: PointsRules
}

/** One correction an admin made to an entry */
export interface PointsAdjustment {
  delta: number
  reason: string
  by: string
  at: number
  /** Written by the re-credit after a director's change to a finished event (`e9-t17` follow-up), not by an admin's 更正 */
  auto?: true
}

/** One ledger entry as the ledger page lists it: the event, the place and the points after corrections */
export interface LedgerEntry {
  eventId: string
  kind: PointKind
  at: number
  rank: number
  field: number
  /** The points the rule gave */
  base: number
  /** After every correction */
  points: number
  adjustments: PointsAdjustment[]
}

/** Places with ties shared: rows sorted by points, most first */
export function rankRows(rows: readonly Omit<LeaderboardRow, 'rank'>[]): LeaderboardRow[] {
  const sorted = [...rows].sort((a, b) => b.points - a.points || b.events - a.events || a.userId.localeCompare(b.userId))
  return sorted.map((row, i) => {
    let first = i
    while (first > 0 && Math.abs(sorted[first - 1].points - row.points) < 1e-9) first--
    return { ...row, rank: first + 1 }
  })
}
