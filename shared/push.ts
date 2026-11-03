import type { NotificationKind } from './protocol.ts'

/**
 * Push notifications (PWA 推播, e1-t28, AC-1.8; ARCHITECTURE.md §5.4): which kinds are pushed is a
 * choice per kind (`PushKinds`), kept by the server. "My account" shows them in groups, a box per
 * group switching all of its kinds; every kind is in exactly one group (a test checks).
 */

export const PUSH_GROUPS = {
  challenges: [
    'challengeInvited',
    'challengeAccepted',
    'challengeDeclined',
    'challengeCancelled',
    'challengeReminder',
    'challengeResults',
    'challengeWeekly',
    'challengePartnerDeclined',
    'challengePartnerSeated',
  ],
  tables: ['tableInvited', 'tableRequest', 'tableRequestApproved', 'tableRequestDeclined', 'directorCalled'],
  matches: [
    'matchInvited',
    'matchAccepted',
    'matchDeclined',
    'matchLeft',
    'matchRemoved',
    'matchCancelled',
    'matchStarted',
    'matchFinished',
    'matchAbandoned',
    'matchSubIn',
  ],
  pairs: ['pairInvited', 'pairAccepted', 'pairDeclined', 'pairEnded'],
  tournaments: [
    'tournamentAnnounced',
    'tournamentPartner',
    'tournamentWithdrawn',
    'tournamentRemoved',
    'tournamentCancelled',
    'tournamentDayReminder',
    'tournamentReminder',
    'tournamentResults',
    'teamEventRound',
  ],
  featured: ['boardFeatured'],
  friends: ['friendOnline'],
  book: [
    'bookPublished',
    'bookOverrideChanged',
    'bookReviewRequested',
    'bookReturned',
    'bookSuggestUnify',
    'articleReviewRequested',
    'articleReturned',
    'articlePublished',
  ],
  forum: ['forumReply', 'forumMention', 'forumAnnouncement', 'forumPinned', 'forumHidden', 'forumUnhidden'],
  admin: ['application', 'passwordResetRequested', 'filesNearlyFull'],
} as const satisfies Record<string, readonly NotificationKind[]>

export type PushGroup = keyof typeof PUSH_GROUPS
export const PUSH_GROUP_NAMES = Object.keys(PUSH_GROUPS) as PushGroup[]

/** Kinds not pushed until the member turns them on: a friend coming online would ring too often */
export const PUSH_OFF_BY_DEFAULT: readonly NotificationKind[] = ['friendOnline']

/** Whether each kind is pushed */
export type PushKinds = Record<NotificationKind, boolean>

/** A device that gets pushes, as "My account" lists it */
export interface PushDevice {
  /** The first 16 hex digits of the SHA-256 of its endpoint (`pushDeviceId`): the page finds its own the same way */
  id: string
  /** Browser and system, from its User-Agent when it subscribed */
  name: string
  createdAt: number
}

/** `GET /api/push`: whether the club has push, its VAPID key, the member's devices and choices */
export interface PushView {
  enabled: boolean
  /** The VAPID public key for `pushManager.subscribe` (base64url); only when enabled */
  publicKey?: string
  devices: PushDevice[]
  kinds: PushKinds
}

/** Most devices one member may have; subscribing one more drops the oldest */
export const PUSH_DEVICES_MAX = 10

/** A device's id: the start of its endpoint's SHA-256, worked out the same way by the server and the page */
export async function pushDeviceId(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint))
  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
