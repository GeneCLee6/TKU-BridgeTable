import {
  challengeDeadline,
  isOpenChallenge,
  type ChallengeSettings,
  type ChallengeStandingsView,
  type ChallengeStatus,
} from '../shared/challenge.ts'
import { scoreChallenge } from '../shared/challenge-scoring.ts'
import type { DealSet } from '../shared/deal-set.ts'
import type { MessageCode } from '../shared/messages.ts'
import type { Challenge, ChallengePlayer } from './challenges.ts'

/**
 * How a challenge moves from state to state (ARCHITECTURE.md §5.5, e7-t05, e7-t06). Pure
 * functions: they read a challenge and say what changes, or which rule says no; `ClubService`
 * checks who is asking, writes the changes to `ChallengeStore` and sends the notifications. The
 * deadline job (`e7-t13`) calls `deadlineOutcome` the same way.
 */

/** A change to write: the players whose row changed, and the new state if it moves on */
export interface ChallengeChange {
  players: ChallengePlayer[]
  status?: ChallengeStatus
}

export type ChallengeStep = ChallengeChange | { error: MessageCode }

/** A new challenge: `pending`, the creator accepted (and may play at once), everyone else invited */
export function newChallenge(c: {
  id: string
  creatorId: string
  invitees: string[]
  settings: ChallengeSettings
  deals: DealSet
  now: number
}): Challenge {
  return {
    id: c.id,
    creatorId: c.creatorId,
    createdAt: c.now,
    status: 'pending',
    deadline: challengeDeadline(c.now, c.settings),
    settings: c.settings,
    deals: c.deals,
    players: [
      { userId: c.creatorId, status: 'accepted', invitedAt: c.now, answeredAt: c.now, knownDeals: false },
      ...c.invitees.map((userId): ChallengePlayer => ({ userId, status: 'invited', invitedAt: c.now, knownDeals: false })),
    ],
    results: [],
  }
}

/** Whether answers and play are still taken: an open state and the deadline not reached */
export const challengeTakesPart = (c: Challenge, now: number) => isOpenChallenge(c.status) && now < c.deadline

/**
 * An invitee's answer. Only once, only while the challenge is open and before the deadline. The
 * first acceptance besides the creator makes it `active`; when the last invitee declines and
 * nobody but the creator accepted, there is nobody left to wait for and it is `expired` at once
 */
export function answer(c: Challenge, userId: string, accept: boolean, now: number): ChallengeStep {
  const player = c.players.find((p) => p.userId === userId)
  if (!player) return { error: 'challengeGone' }
  if (!challengeTakesPart(c, now)) return { error: 'challengeClosed' }
  if (player.status !== 'invited') return { error: 'alreadyAnswered' }
  const answered: ChallengePlayer = { ...player, status: accept ? 'accepted' : 'declined', answeredAt: now }
  const players = c.players.map((p) => (p.userId === userId ? answered : p))
  const others = players.filter((p) => p.userId !== c.creatorId)
  if (accept && c.status === 'pending') return { players: [answered], status: 'active' }
  if (!accept && c.status === 'pending' && others.every((p) => p.status === 'declined'))
    return { players: [answered], status: 'expired' }
  return { players: [answered] }
}

/** The creator calls it off: only while it is open and nobody but the creator has started a board */
export function cancel(c: Challenge, userId: string): ChallengeStep {
  if (!c.players.some((p) => p.userId === userId)) return { error: 'challengeGone' }
  if (c.creatorId !== userId) return { error: 'challengeCreatorOnly' }
  if (!isOpenChallenge(c.status)) return { error: 'challengeClosed' }
  if (c.players.some((p) => p.userId !== c.creatorId && p.startedAt !== undefined)) return { error: 'challengeStarted' }
  return { players: [], status: 'cancelled' }
}

/**
 * What the deadline does (`e7-t13`): whoever has not answered declined, and the challenge is
 * `expired` when nobody but the creator accepted, `finished` otherwise. Nothing for one that ended
 */
export function deadlineOutcome(c: Challenge, now: number): ChallengeChange | null {
  if (!isOpenChallenge(c.status)) return null
  const players = c.players
    .filter((p) => p.status === 'invited')
    .map((p): ChallengePlayer => ({ ...p, status: 'declined', answeredAt: now }))
  const accepted = c.players.some((p) => p.userId !== c.creatorId && p.status === 'accepted')
  return { players, status: accepted ? 'finished' : 'expired' }
}

/** The reminder goes out this long before the deadline (`e7-t07`) */
export const REMINDER_MS = 12 * 3600_000

/** Boards a participant has a result for */
export const playedCount = (c: Challenge, userId: string) => c.results.filter((r) => r.userId === userId).length

/**
 * Whether a participant played every board: an accepted one with a result on each, or the creator
 * of a 「用這副牌挑戰」 challenge, whose earlier results count (`knownDeals`)
 */
export const hasFinished = (c: Challenge, p: ChallengePlayer) =>
  p.status === 'accepted' && (p.knownDeals || playedCount(c, p.userId) >= c.deals.boards.length)

/**
 * When the challenge's job should run next (`e7-t13`): the reminder 12 hours before the deadline
 * until it has gone out, then the deadline; null once it ended. The time may already be past (the
 * object was asleep): the job then runs at once
 */
export function nextChallengeTime(c: Challenge): number | null {
  if (!isOpenChallenge(c.status)) return null
  return c.remindedAt === undefined ? c.deadline - REMINDER_MS : c.deadline
}

/** Who is reminded 12 hours before the deadline: those who accepted and still have boards to play */
export const remindWhom = (c: Challenge): string[] =>
  c.players.filter((p) => p.status === 'accepted' && !hasFinished(c, p)).map((p) => p.userId)

/**
 * Finishing before the deadline (`e7-t13`): every invitee answered and everyone who accepted
 * played every board. Only an `active` challenge: one where nobody but the creator accepted ends
 * `expired` instead (`answer`, `deadlineOutcome`)
 */
export function earlyFinish(c: Challenge): ChallengeChange | null {
  if (c.status !== 'active') return null
  if (c.players.some((p) => p.status === 'invited')) return null
  if (!c.players.every((p) => p.status === 'declined' || hasFinished(c, p))) return null
  return { players: [], status: 'finished' }
}

/**
 * The standings (社長, 2026-10-24): only those who played every board are ranked, so nobody is
 * scored for a board they did not play; the others who accepted are listed as unfinished. With
 * one finisher there is nobody to compare with: they are first, with their total score only.
 * Before the end these are the live standings of those finished so far
 */
export function challengeStandings(c: Challenge): ChallengeStandingsView {
  const finishers = c.players.filter((p) => hasFinished(c, p))
  const scoring = finishers.length > 1 ? c.settings.scoring : 'total'
  const scores: Record<string, number[]> = {}
  for (const p of finishers) {
    const row = new Array<number>(c.deals.boards.length).fill(0)
    for (const r of c.results) if (r.userId === p.userId) row[r.seq - 1] = r.scoreNS
    scores[p.userId] = row
  }
  // Everyone ranked played every board, so the rule for unplayed boards never applies
  const ranked = finishers.length ? scoreChallenge({ scoring, unfinished: 'worst', scores }) : []
  return {
    final: c.status === 'finished',
    scoring,
    ranked: ranked.map((s) => ({ userId: s.player, rank: s.rank, total: s.total, boards: s.boards })),
    unfinished: c.players
      .filter((p) => p.status === 'accepted' && !hasFinished(c, p))
      .map((p) => ({ userId: p.userId, played: playedCount(c, p.userId) })),
  }
}
