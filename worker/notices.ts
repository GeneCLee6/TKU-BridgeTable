import { NOTICE_LIMITS, noticeLive, type ClubBanner } from '../shared/notices.ts'
import type { AuditLog } from './audit.ts'
import { ClubError } from './errors.ts'
import type { Store } from './store.ts'

/**
 * A club's own banner (e12-t15, ARCHITECTURE.md §1「公告」): one short text with an optional end, set
 * by its admins. In `meta:banner`, so a backup neither holds nor brings back an old one. The
 * platform's notices are in worker/platform.ts; longer news is the forum's 社團公告 board (§5.19)
 */

const BANNER_KEY = 'meta:banner'

/** How much of a notice's text the audit trail keeps */
const AUDIT_EXCERPT = 100
export const noticeExcerpt = (text: string) => [...text].slice(0, AUDIT_EXCERPT).join('')

/** The text of a notice or a banner, checked */
export function noticeText(value: unknown): string {
  const text = String(value ?? '').trim()
  const length = [...text].length
  if (length < 1 || length > NOTICE_LIMITS.textMax) throw new ClubError('badNoticeText', { max: NOTICE_LIMITS.textMax })
  return text
}

/** An end in the future, or none (`undefined`, `null`, the form's empty box) */
export function noticeExpiry(value: unknown, now: number): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= now) throw new ClubError('badNoticeExpiry')
  return value
}

export class ClubBanners {
  private readonly store: Store
  private readonly audit: AuditLog
  private readonly now: () => number
  private readonly newId: () => string

  constructor(store: Store, audit: AuditLog, now: () => number, newId: () => string) {
    this.store = store
    this.audit = audit
    this.now = now
    this.newId = newId
  }

  /** The banner, unless its end has come */
  async current(): Promise<ClubBanner | null> {
    const banner = await this.store.get<ClubBanner>(BANNER_KEY)
    return banner && noticeLive(banner, this.now()) ? banner : null
  }

  async set(by: string, input: { text?: unknown; expiresAt?: unknown }): Promise<ClubBanner> {
    const text = noticeText(input.text)
    const expiresAt = noticeExpiry(input.expiresAt, this.now())
    const banner: ClubBanner = { id: this.newId(), text, setAt: this.now(), ...(expiresAt !== undefined && { expiresAt }) }
    await this.store.put(BANNER_KEY, banner)
    await this.audit.record({ by, action: 'club:banner', target: banner.id, note: noticeExcerpt(text) })
    return banner
  }

  async clear(by: string): Promise<void> {
    const banner = await this.store.get<ClubBanner>(BANNER_KEY)
    if (!banner) return
    await this.store.delete(BANNER_KEY)
    await this.audit.record({ by, action: 'club:bannerClear', target: banner.id, note: noticeExcerpt(banner.text) })
  }
}
