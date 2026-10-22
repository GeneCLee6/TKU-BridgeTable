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
