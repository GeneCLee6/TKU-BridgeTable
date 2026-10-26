import { DAY_MS, taiwanDate, taiwanDayStart } from '../../shared/history-query.ts'
import type { Lang } from '../../shared/messages.ts'

/** Display formatting that is not a component */

const LOCALE: Record<Lang, string> = { zh: 'zh-TW', 'zh-Hans': 'zh-CN', en: 'en-GB', vi: 'vi-VN', ja: 'ja-JP', ko: 'ko-KR' }

export function formatDateTime(at: number, lang: Lang = 'zh'): string {
  return new Date(at).toLocaleString(LOCALE[lang], {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

/** +620, -100, 0 */
export const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`)

/** 2026/3/2 (in the language's own order) */
export function formatDate(at: number, lang: Lang = 'zh'): string {
  return new Date(at).toLocaleDateString(LOCALE[lang], { year: 'numeric', month: 'numeric', day: 'numeric' })
}

/**
 * A time relative to today, for lists (DESIGN.md §7.8): 今天 08:12, 昨天 22:31, 10/23 22:31 this
 * year, 2025/12/30 before that.
 */
export function formatRelative(
  at: number,
  lang: Lang,
  words: { today: string; yesterday: string },
  now: number = Date.now(),
): string {
  const date = new Date(at)
  const time = date.toLocaleTimeString(LOCALE[lang], { hour: '2-digit', minute: '2-digit', hour12: false })
  const startOfToday = new Date(now).setHours(0, 0, 0, 0)
  const dayStart = new Date(at).setHours(0, 0, 0, 0)
  if (dayStart === startOfToday) return `${words.today} ${time}`
  if (dayStart === new Date(startOfToday - 12 * 3_600_000).setHours(0, 0, 0, 0)) return `${words.yesterday} ${time}`
  if (date.getFullYear() === new Date(now).getFullYear())
    return `${date.toLocaleDateString(LOCALE[lang], { month: 'numeric', day: 'numeric' })} ${time}`
  return formatDate(at, lang)
}

/**
 * A Taiwan date (YYYY-MM-DD, as history keeps days) for the side panel's list by day: 今天, 昨天,
 * then 10/23（五） this year and 2025/12/30（二） before that, in the language's own order
 */
export function formatDay(date: string, lang: Lang, words: { today: string; yesterday: string }, now: number = Date.now()): string {
  const today = taiwanDate(now)
  if (date === today) return words.today
  if (date === taiwanDate(taiwanDayStart(today) - DAY_MS)) return words.yesterday
  // The date's own calendar day, whatever the browser's time zone
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(LOCALE[lang], {
    ...(date.slice(0, 4) !== today.slice(0, 4) && { year: 'numeric' }),
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
    timeZone: 'UTC',
  })
}
