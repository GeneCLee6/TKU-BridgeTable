/**
 * The support form (e12-t16, ARCHITECTURE.md §1「客服回報」): a signed-in member's report goes to
 * their club's admins, who may forward it to the platform owner. It stays in the club's own object
 * (forwarding only marks it), so a club's reports are never in another club's. Exactly these fields
 * are kept: no IP address, no page address, nothing else about the member.
 * Pure types and limits, shared by the Worker and the pages.
 */

export const SUPPORT_CATEGORIES = ['bug', 'game', 'account', 'other'] as const
export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number]

export type SupportStatus = 'open' | 'resolved'

/** Where a member's own reports are on 我的帳号, for the link of `supportResolved` */
export const SUPPORT_REPORTS_ANCHOR = 'my-support-reports'

export const SUPPORT_LIMITS = {
  textMin: 5,
  textMax: 2000,
  /** Reports per member per hour */
  perHour: 5,
  /** Reports one member may have open at once */
  openPerMember: 20,
  /** Resolved reports the admin page and the back office list */
  resolvedListed: 50,
  /** A member's own reports on 我的帳號, newest first */
  mineListed: 50,
  /** Resolved reports a club keeps; the oldest go */
  resolvedKept: 500,
  browserMax: 300,
  versionMax: 40,
}

/** `POST /api/support`. The browser is read from the request itself; the club is the object's own */
export interface SupportInput {
  category: SupportCategory
  text: string
  /** The app's version (`<meta name="app-version">`) */
  version?: string
  /** When opened from a record, or from a table */
  boardId?: string
  tableId?: string
}

/** A report as its author gets it in their account export */
export interface SupportReport {
  id: string
  clubId: string
  category: SupportCategory
  text: string
  browser: string
  version: string
  boardId?: string
  /**
   * For the admins and the back office, in place of `boardId`: the report is about a board the member
   * imported, which only they can open (`e4-t39`, ARCHITECTURE.md §4), so a link would lead nowhere
   */
  boardImported?: true
  tableId?: string
  createdAt: number
  status: SupportStatus
  resolvedAt?: number
  forwardedAt?: number
}

/**
 * `GET /api/support/mine`, on the author's 我的帳號: what they wrote and how it stands. Picked field by
 * field, so nothing about who handled or forwarded it is ever in it
 */
export interface MySupportReport {
  id: string
  category: SupportCategory
  text: string
  createdAt: number
  status: SupportStatus
  resolvedAt?: number
}

/** On the club's admin page: with who wrote it and which admin forwarded it */
export interface AdminSupportReport extends SupportReport {
  userId: string
  username: string
  forwardedBy?: string
}

/** `GET /api/admin/support`; `canForward` is false without a platform owner */
export interface AdminSupportView {
  reports: AdminSupportReport[]
  canForward: boolean
}

/** In the platform's back office: the member stays with their club, the admin who forwarded it is who to ask */
export interface ForwardedSupport extends SupportReport {
  forwardedAt: number
  forwardedBy?: string
}
