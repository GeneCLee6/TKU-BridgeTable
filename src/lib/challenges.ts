import { isOpenChallenge, type ChallengePlayerView, type ChallengeView } from '../../shared/challenge.ts'
import type { Strings } from '../strings.ts'

/** What the challenge pages work out from a `ChallengeView` (ARCHITECTURE.md §5.5) */

export const CHALLENGE_TABS = ['waiting', 'active', 'done'] as const
export type ChallengeTab = (typeof CHALLENGE_TABS)[number]

export const playerOf = (c: ChallengeView, userId: string) => c.players.find((p) => p.userId === userId)

/** Whether the member can play the challenge now: accepted, still open, boards left */
export function playable(c: ChallengeView, userId: string, now: number) {
  const me = playerOf(c, userId)
  return (
    !!me &&
    me.status === 'accepted' &&
    !me.knownDeals &&
    me.played < c.boards &&
    isOpenChallenge(c.status) &&
    now < c.deadline
  )
}

/**
 * Which tab of the challenge lobby a challenge is under (`e7-t16`): 等待接受 while it waits for
 * the member's answer or for anyone besides the creator; 進行中 once someone accepted; 已完成 when
 * it ended, or the member declined and is out of it
 */
export function challengeTab(c: ChallengeView, userId: string, now: number): ChallengeTab {
  const me = playerOf(c, userId)
  if (!isOpenChallenge(c.status) || now >= c.deadline || !me || me.status === 'declined') return 'done'
  if (me.status === 'invited' || c.status === 'pending') return 'waiting'
  return 'active'
}

/** The creator may call it off while open and nobody else has started (§5.5) */
export const cancellable = (c: ChallengeView, userId: string) =>
  c.creatorId === userId && isOpenChallenge(c.status) && c.players.every((p) => p.userId === userId || p.startedAt === undefined)

/** May the member answer the invitation now */
export const answerable = (c: ChallengeView, userId: string, now: number) =>
  isOpenChallenge(c.status) && now < c.deadline && playerOf(c, userId)?.status === 'invited'

/** 還剩 2 天 5 小時: the time to the deadline, rounded down to the minute */
export function timeLeft(t: Strings, ms: number) {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  return t.timeLeft(Math.floor(minutes / 1440), Math.floor((minutes % 1440) / 60), minutes % 60)
}

/** A participant's name; accounts deleted after the challenge ended have none */
export const participantName = (t: Strings, p: ChallengePlayerView | undefined) => p?.user?.username ?? t.deletedMember

/** 8 副 · IMP · TKB（2/1） */
export const settingsLine = (t: Strings, c: ChallengeView) =>
  t.challengeSettingsLine(c.boards, t.scorings[c.settings.scoring], t.robots[c.settings.robotKind])
