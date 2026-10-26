import type { ChallengeView } from '../../shared/challenge.ts'
import type { Notification, NotificationKind } from '../../shared/protocol.ts'
import type { TeamMatchView } from '../../shared/team-match.ts'
import { answerable } from './challenges.ts'
import { mySeat } from './matches.ts'

/**
 * The invitations that pop up (`e1-t35`): a challenge or a seat in a team match, from the bell's
 * notifications. Which ones this browser has dealt with (answered, put off, or seen gone) and which
 * have rung are kept in localStorage, so the same invitation pops up once per browser and rings in
 * one tab only; the notification itself stays in the bell.
 */

export const INVITE_KINDS: ReadonlySet<NotificationKind> = new Set(['challengeInvited', 'matchInvited'])

export type InviteTarget = { kind: 'challenge'; id: string } | { kind: 'match'; id: string }

/** What an invitation is about; null for any other notification */
export function inviteTarget(n: Notification): InviteTarget | null {
  if (n.kind === 'challengeInvited' && n.params.challengeId) return { kind: 'challenge', id: String(n.params.challengeId) }
  if (n.kind === 'matchInvited' && n.params.matchId) return { kind: 'match', id: String(n.params.matchId) }
  return null
}

export const targetKey = (t: InviteTarget) => `${t.kind}:${t.id}`

/** The challenge or match another notification is news about (cancelled, taken off, …) */
export function newsKey(n: Notification): string | null {
  if (n.params.challengeId) return `challenge:${n.params.challengeId}`
  if (n.params.matchId) return `match:${n.params.matchId}`
  return null
}

export interface PendingInvite {
  key: string
  target: InviteTarget
  /** The latest invitation to it */
  latest: Notification
  /** Every invitation notification to it, to mark read and to remember together */
  ids: string[]
}

/** The invitations not dealt with in this browser, one per challenge or match, oldest first */
export function pendingInvites(items: readonly Notification[], handled: ReadonlySet<string>): PendingInvite[] {
  const byKey = new Map<string, PendingInvite>()
  for (const n of [...items].sort((a, b) => a.at - b.at)) {
    const target = inviteTarget(n)
    if (!target) continue
    const key = targetKey(target)
    const known = byKey.get(key)
    if (known) {
      known.latest = n
      known.ids.push(n.id)
    } else byKey.set(key, { key, target, latest: n, ids: [n.id] })
  }
  // Invited again after being taken off: only the newest invitation counts
  return [...byKey.values()].filter((p) => !handled.has(p.latest.id)).sort((a, b) => a.latest.at - b.latest.at)
}

/** The challenge or match behind an invitation, as fetched (or pushed) */
export type InviteDetail = { kind: 'challenge'; challenge: ChallengeView } | { kind: 'match'; match: TeamMatchView }

/** Whether the member can still answer: not answered, not called off, not past the deadline */
export function stillOpen(detail: InviteDetail, userId: string, now: number): boolean {
  if (detail.kind === 'challenge') return answerable(detail.challenge, userId, now)
  return detail.match.status === 'setup' && mySeat(detail.match, userId)?.status === 'invited'
}

// ── What this browser remembers ──

/** Invitation notification ids this browser dealt with, and those that already rang */
export const HANDLED_KEY = 'tku-invites-handled'
export const RANG_KEY = 'tku-invites-rang'
/** Older marks are dropped: an invitation does not last this long */
const KEEP_MS = 60 * 24 * 3600_000

function read(key: string): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(key) ?? '{}')
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : {}
  } catch {
    return {}
  }
}

export function marked(key: string): Set<string> {
  return new Set(Object.keys(read(key)))
}

/** Remembers these ids; returns false when every one was remembered already */
export function mark(key: string, ids: readonly string[]): boolean {
  const now = Date.now()
  const all = read(key)
  const fresh = ids.filter((id) => !(id in all))
  if (!fresh.length) return false
  const kept = Object.fromEntries(Object.entries(all).filter(([, at]) => now - at < KEEP_MS))
  for (const id of fresh) kept[id] = now
  try {
    window.localStorage.setItem(key, JSON.stringify(kept))
  } catch {
    // Private mode with no storage: the invitation may pop up again after a reload
  }
  return true
}
