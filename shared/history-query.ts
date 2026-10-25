import { STRAINS } from './auction.ts'
import type { Vulnerability } from './board.ts'
import { isSeat, type Seat, type Strain } from './cards.ts'
import { cleanTag } from './favorites.ts'
import { AppError } from './messages.ts'
import { HISTORY_PAGE_SIZES, LIMITS } from './protocol.ts'

/**
 * A history search (AC-4.6, AC-4.7), as `GET /api/history/search` takes it in its query string.
 * The browser builds the string with `historyQueryString` and the server reads it back with
 * `parseHistoryQuery`, so both sides check the same rules. Every condition is optional and they
 * combine with "and"; "me", "my partner" and `scope=mine` are the member asking.
 */

export const HISTORY_SORTS = ['date_desc', 'date_asc', 'score_desc', 'score_asc', 'tricks_desc', 'tricks_asc'] as const
export type HistorySort = (typeof HISTORY_SORTS)[number]

/** Undoubled only, doubled only, redoubled only, or doubled or redoubled */
export const DOUBLED_FILTERS = ['undoubled', 'X', 'XX', 'doubled'] as const
export type DoubledFilter = (typeof DOUBLED_FILTERS)[number]

/** Part score, game (below slam), small slam, grand slam, or passed out */
export const CONTRACT_BRACKETS = ['partial', 'game', 'slam', 'grand', 'passout'] as const
export type ContractBracket = (typeof CONTRACT_BRACKETS)[number]

/** Who declared, seen from the member asking */
export const DECLARER_SIDES = ['me', 'partner', 'opponents'] as const
export type DeclarerSide = (typeof DECLARER_SIDES)[number]

/** Made (exactly or with overtricks), went down, or made with overtricks */
export const RESULT_FILTERS = ['made', 'down', 'overtricks'] as const
export type ResultFilter = (typeof RESULT_FILTERS)[number]

/** The table modes the history page offers (`mode` takes any word, for modes still to come) */
export const HISTORY_MODES = ['casual', 'challenge'] as const
export type HistoryMode = (typeof HISTORY_MODES)[number]

export const VULNERABILITIES =['None', 'NS', 'EW', 'Both'] as const satisfies readonly Vulnerability[]

export interface HistoryQuery {
  /** Boards the member played, or every board in the club */
  scope: 'mine' | 'all'
  level?: number
  strain?: Strain
  doubled?: DoubledFilter
  bracket?: ContractBracket
  /** Declared by this member */
  declarer?: string
  declarerSeat?: Seat
  declarerSide?: DeclarerSide
  /** This member played the board (with `scope=mine`: "X and I at the same table") */
  player?: string
  /** This member was my partner */
  partner?: string
  /** Taiwan dates, YYYY-MM-DD, both included */
  from?: string
  to?: string
  result?: ResultFilter
  vul?: Vulnerability
  boardNo?: number
  table?: number
  mode?: string
  /** Boards I keep among my favorites with this tag (AC-4.4) */
  tag?: string
  sort: HistorySort
  page: number
  size: number
}

export const DEFAULT_HISTORY_QUERY: HistoryQuery = { scope: 'mine', sort: 'date_desc', page: 1, size: LIMITS.historyPageDefault }

const DATE = /^\d{4}-\d{2}-\d{2}$/
const ID = /^[\w:-]{1,64}$/
const MODE = /^[a-z]{1,16}$/
/** Taiwan has no daylight saving time: midnight there is 16:00 UTC the day before */
const TAIWAN_OFFSET_MS = 8 * 3600_000

const isDate = (value: string) => DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))

/** When a Taiwan date starts, in ms; `taiwanDayStart('2026-10-24')` is 2026-10-23T16:00Z */
export function taiwanDayStart(date: string): number {
  return Date.parse(`${date}T00:00:00Z`) - TAIWAN_OFFSET_MS
}

/** When a Taiwan date ends: the start of the next day */
export const taiwanDayEnd = (date: string) => taiwanDayStart(date) + 24 * 3600_000

function oneOf<T extends string>(list: readonly T[]) {
  return (value: string) => (list.includes(value as T) ? (value as T) : undefined)
}
const integer = (min: number, max: number) => (value: string) => {
  const n = /^\d+$/.test(value) ? Number(value) : NaN
  return n >= min && n <= max ? n : undefined
}
const matching = (pattern: RegExp) => (value: string) => (pattern.test(value) ? value : undefined)

/** How each parameter is read; anything else in the query string is an error */
const READERS: { [K in keyof HistoryQuery]-?: (value: string) => HistoryQuery[K] | undefined } = {
  scope: oneOf(['mine', 'all'] as const),
  level: integer(1, 7),
  strain: oneOf(STRAINS),
  doubled: oneOf(DOUBLED_FILTERS),
  bracket: oneOf(CONTRACT_BRACKETS),
  declarer: matching(ID),
  declarerSeat: (value) => (isSeat(value) ? value : undefined),
  declarerSide: oneOf(DECLARER_SIDES),
  player: matching(ID),
  partner: matching(ID),
  from: (value) => (isDate(value) ? value : undefined),
  to: (value) => (isDate(value) ? value : undefined),
  result: oneOf(RESULT_FILTERS),
  vul: oneOf(VULNERABILITIES),
  boardNo: integer(1, 9999),
  table: integer(1, 9999),
  mode: matching(MODE),
  tag: (value) => {
    const tag = cleanTag(value)
    return tag && tag.length <= LIMITS.favoriteTagMax ? tag : undefined
  },
  sort: oneOf(HISTORY_SORTS),
  page: integer(1, 1_000_000),
  size: (value) => HISTORY_PAGE_SIZES.find((size) => String(size) === value),
}

const isKey = (key: string): key is keyof HistoryQuery => key in READERS

/** Reads a search from a query string; throws `badHistoryQuery` naming the first bad parameter */
export function parseHistoryQuery(params: URLSearchParams): HistoryQuery {
  const query: Record<string, unknown> = { ...DEFAULT_HISTORY_QUERY }
  for (const [key, value] of params) {
    const parsed = isKey(key) ? READERS[key](value) : undefined
    if (parsed === undefined) throw new AppError('badHistoryQuery', { field: key })
    query[key] = parsed
  }
  const result = query as unknown as HistoryQuery
  if (result.from && result.to && result.from > result.to) throw new AppError('badHistoryQuery', { field: 'from' })
  return result
}

/** The query string for a search, leaving out what is the default; parsing it gives the search back */
export function historyQueryString(query: Partial<HistoryQuery>): string {
  const params = new URLSearchParams()
  for (const key of Object.keys(READERS) as (keyof HistoryQuery)[]) {
    const value = query[key]
    if (value === undefined || value === DEFAULT_HISTORY_QUERY[key]) continue
    params.set(key, String(value))
  }
  return params.toString()
}

/**
 * Reads a search from the history page's address, keeping what it understands and dropping the
 * rest, so an old or hand-edited link still opens the list instead of an error
 */
export function readHistoryQuery(params: URLSearchParams): HistoryQuery {
  const query: Record<string, unknown> = { ...DEFAULT_HISTORY_QUERY }
  for (const [key, value] of params) {
    const parsed = isKey(key) ? READERS[key](value) : undefined
    if (parsed !== undefined) query[key] = parsed
  }
  const result = query as unknown as HistoryQuery
  if (result.from && result.to && result.from > result.to) delete result.to
  return result
}

/** Quick date ranges on the history page; anything else is a custom range */
export const DATE_PRESETS = ['today', 'week', 'month'] as const
export type DatePreset = (typeof DATE_PRESETS)[number]

/** The Taiwan date of a moment, YYYY-MM-DD */
export const taiwanDate = (at: number) => new Date(at + TAIWAN_OFFSET_MS).toISOString().slice(0, 10)

/** Today, this week (from Monday) or this month so far, as Taiwan dates */
export function datePresetRange(preset: DatePreset, now: number): { from: string; to: string } {
  const to = taiwanDate(now)
  if (preset === 'today') return { from: to, to }
  if (preset === 'month') return { from: `${to.slice(0, 8)}01`, to }
  const weekday = (new Date(`${to}T00:00:00Z`).getUTCDay() + 6) % 7
  return { from: taiwanDate(taiwanDayStart(to) - weekday * 24 * 3600_000), to }
}

/** Which quick range `from`–`to` is now, if any */
export function datePresetOf(query: Pick<HistoryQuery, 'from' | 'to'>, now: number): DatePreset | undefined {
  if (!query.from || !query.to) return undefined
  return DATE_PRESETS.find((preset) => {
    const range = datePresetRange(preset, now)
    return range.from === query.from && range.to === query.to
  })
}
