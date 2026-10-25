import type { ChallengeScoring } from '../../shared/challenge-scoring.ts'
import { isOpenChallenge, type ChallengePlayerView, type ChallengeView } from '../../shared/challenge.ts'
import { SEATS } from '../../shared/cards.ts'
import type { BoardRecord, RobotKind } from '../../shared/protocol.ts'
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

/** 每週社團挑戰 for the club's weekly challenge (`e7-t23`), otherwise 某某的挑戰 */
export const challengeTitle = (t: Strings, c: ChallengeView) =>
  c.settings.weekly ? t.weeklyChallengeTitle : t.challengeBy(participantName(t, playerOf(c, c.creatorId)))

/** A participant's name; accounts deleted after the challenge ended have none */
export const participantName = (t: Strings, p: ChallengePlayerView | undefined) => p?.user?.username ?? t.deletedMember

/** 8 副 · IMP · TKB（2/1）, with Best Hand and Just Declare when they are on */
export const settingsLine = (t: Strings, c: ChallengeView) =>
  [
    t.challengeSettingsLine(c.boards, t.scorings[c.settings.scoring], t.robots[c.settings.robotKind]),
    c.settings.bestHand && t.bestHand,
    c.settings.justDeclare && t.justDeclare,
  ]
    .filter(Boolean)
    .join(' · ')

/**
 * One-click rematch (`e7-t21`): once it ended, a participant who accepted can challenge the others
 * who did not decline again; the server checks it all again
 */
export function rematchable(c: ChallengeView, userId: string) {
  // Next week's club challenge comes by itself (`e7-t23`)
  if (c.settings.weekly || isOpenChallenge(c.status) || playerOf(c, userId)?.status !== 'accepted') return false
  return c.players.some((p) => p.userId !== userId && p.status !== 'declined' && p.user)
}

/**
 * 「用這副牌挑戰」 (`e7-t22`): the robots' system when the member played this board with three
 * robots of one system and anyone may see it by now, otherwise null. The server checks it again
 */
export function challengeRobotsOf(record: BoardRecord, userId: string, now: number): RobotKind | null {
  const seat = SEATS.find((s) => record.players[s]?.id === userId)
  if (!seat || !record.board.result || (record.revealAt ?? 0) > now) return null
  const others = SEATS.filter((s) => s !== seat).map((s) => record.players[s])
  if (!others.every((p) => p?.robot)) return null
  const kinds = new Set(others.map((p) => p.robotKind ?? 'tku'))
  return kinds.size === 1 ? [...kinds][0] : null
}

/** A result in the scoring's unit: a percentage for matchpoints, signed IMPs, signed points */
export function formatScore(value: number, scoring: ChallengeScoring) {
  const n = Number.isInteger(value) ? String(value) : value.toFixed(scoring === 'mp' ? 1 : 2)
  if (scoring === 'mp') return `${n}%`
  return value > 0 ? `+${n}` : n
}

/** The colour of a result: above or below the average for matchpoints, its sign otherwise */
export const tone = (value: number, scoring: ChallengeScoring) => (scoring === 'mp' ? value - 50 : value)

/**
 * Each participant's North-South score on every board, from the travellers the server sent (null
 * where they did not play it or it is not shown), in the order they were invited. For the head to
 * head of the results page (`headToHead`); the server already left out what the member may not see
 */
export function travellerScores(c: ChallengeView): Record<string, (number | null)[]> {
  const scores: Record<string, (number | null)[]> = {}
  for (const x of c.travellers ?? [])
    for (const e of x.entries) (scores[e.userId] ??= new Array<number | null>(c.boards).fill(null))[x.seq - 1] = e.scoreNS
  return Object.fromEntries(c.players.filter((p) => scores[p.userId]).map((p) => [p.userId, scores[p.userId]]))
}

/** The order of the results page: the member first, then by place, then the others as invited */
export function resultOrder(c: ChallengeView, userId: string): string[] {
  const ids = [
    userId,
    ...(c.standings?.ranked.map((r) => r.userId) ?? []),
    ...(c.standings?.unfinished.map((u) => u.userId) ?? []),
    ...c.players.map((p) => p.userId),
  ]
  return [...new Set(ids)]
}
