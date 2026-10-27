import type { HistoryMode, HistoryQuery } from '../../shared/history-query.ts'
import { HISTORY_PAGE_SIZES, LIMITS } from '../../shared/protocol.ts'

/**
 * What every list of boards or challenges shares (DESIGN.md §7.4): pages of a size the viewer picks
 * (remembered in the browser, one choice for every list), and the way records are grouped (history
 * page and the side panel's records alike).
 */

/** How a list that the browser holds whole (challenges, featured boards, team matches) can be sorted */
export const LIST_SORTS = ['newest', 'oldest', 'deadline'] as const
export type ListSort = (typeof LIST_SORTS)[number]

/**
 * How records are grouped (社長 2026-10-27): by date first (the default, U3a), by topic first —
 * 一般, 挑戰, 隊制賽, 練習, then the dates inside it — or not at all (one long list)
 */
export const RECORD_GROUPINGS = ['date', 'topic', 'none'] as const
export type RecordGrouping = (typeof RECORD_GROUPINGS)[number]

export const isGrouping = (value: unknown): value is RecordGrouping =>
  RECORD_GROUPINGS.includes(value as RecordGrouping)

const SIZE_KEY = 'tku-bridge-table:history-size'

/** The page size the viewer picked last, or the default */
export function readPageSize(): number {
  try {
    const stored = Number(window.localStorage.getItem(SIZE_KEY))
    return (HISTORY_PAGE_SIZES as readonly number[]).includes(stored)
      ? stored
      : LIMITS.historyPageDefault
  } catch {
    return LIMITS.historyPageDefault
  }
}

export function writePageSize(size: number) {
  try {
    window.localStorage.setItem(SIZE_KEY, String(size))
  } catch {
    // Not remembered; the list still changes
  }
}

/** Page numbers to offer: the first, the last and two either side of the current one, with gaps */
export function pageNumbers(page: number, last: number): (number | null)[] {
  const wanted = [...new Set([1, last, ...[-2, -1, 0, 1, 2].map((d) => page + d)])]
    .filter((n) => n >= 1 && n <= last)
    .sort((a, b) => a - b)
  return wanted.flatMap((n, i) => (i > 0 && n - wanted[i - 1] > 1 ? [null, n] : [n]))
}

/** One page of a list held whole; a page past the end shows the last one */
export function paginate<T>(
  items: readonly T[],
  page: number,
  size: number,
): { items: T[]; page: number; total: number } {
  const last = Math.max(1, Math.ceil(items.length / size))
  const shown = Math.min(Math.max(1, page), last)
  return { items: items.slice((shown - 1) * size, shown * size), page: shown, total: items.length }
}

/** Sorts a list held whole by when each item was made (or by `deadline`, soonest first) */
export function sortList<T>(
  items: readonly T[],
  sort: ListSort,
  at: (item: T) => number,
  deadline?: (item: T) => number,
): T[] {
  const list = [...items]
  if (sort === 'deadline' && deadline) return list.sort((a, b) => deadline(a) - deadline(b))
  return list.sort((a, b) => (sort === 'oldest' ? at(a) - at(b) : at(b) - at(a)))
}

/** A search for one group of records: the topic as `mode`, the date as both ends of the range */
export function groupQuery(
  query: HistoryQuery,
  topic: HistoryMode | null,
  day: string | null,
): HistoryQuery {
  return { ...query, ...(topic && { mode: topic }), ...(day && { from: day, to: day }) }
}
