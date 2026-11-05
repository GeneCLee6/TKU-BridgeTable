/**
 * Announcements (e12-t15, ARCHITECTURE.md §1「公告」): what the forum's 社團公告 board does not give.
 * The platform owner's notices go to every club's members; a club's admins set one banner of their
 * own. Both are short plain text with an optional end, shown as a banner a member can dismiss on
 * their own browser. Long news, drafts of it and its schedule are the 社團公告 board's (§5.19).
 * Pure types and checks, shared by the Worker and the pages.
 */

/** `GET` here is answered by the Worker itself (worker/routing.ts), not by a club's API */
export const NOTICES_API = '/api/notices'

export const NOTICE_LIMITS = {
  /** A notice's or a banner's text (characters) */
  textMax: 500,
  /** Platform notices out at once: more would push the page down */
  activeMax: 3,
  /** Platform notices kept, drafts and withdrawn ones included */
  storedMax: 50,
}

/** A platform notice's life: written, out, or taken back (it can go out again). Past its end it is simply no longer shown */
export type NoticeStatus = 'draft' | 'published' | 'withdrawn'

/** A platform notice as members get it: never a draft or the back office's bookkeeping */
export interface PlatformNotice {
  id: string
  text: string
  publishedAt: number
  expiresAt?: number
}

/** A platform notice in the back office */
export interface PlatformNoticeView {
  id: string
  text: string
  status: NoticeStatus
  createdAt: number
  updatedAt: number
  publishedAt?: number
  expiresAt?: number
}

/** `POST /api/platform/notices`: a new draft, or (with `id`) an edit of any notice */
export interface PlatformNoticeInput {
  id?: string
  text: string
  /** When it stops being shown (ms); none or null: until it is withdrawn */
  expiresAt?: number | null
}

/** The club's own banner: one at a time, set by its admins, kept in the club's object */
export interface ClubBanner {
  /** New each time it is set, so a banner someone dismissed does not hide the next one */
  id: string
  text: string
  setAt: number
  expiresAt?: number
}

/** `POST /api/admin/banner` */
export interface ClubBannerInput {
  text: string
  expiresAt?: number | null
}

/** `GET /api/notices`: what a signed-in member's page shows */
export interface NoticesView {
  platform: PlatformNotice[]
  club: ClubBanner | null
}

/** Whether a notice's end has not come */
export const noticeLive = (notice: { expiresAt?: number }, now: number) => notice.expiresAt === undefined || notice.expiresAt > now

/** What a browser remembers having dismissed: republishing a notice, or a new banner, shows again */
export const noticeDismissKey = (notice: PlatformNotice | ClubBanner) =>
  'publishedAt' in notice ? `p:${notice.id}:${notice.publishedAt}` : `c:${notice.id}`
