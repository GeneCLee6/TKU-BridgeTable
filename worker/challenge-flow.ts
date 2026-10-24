import { challengeDeadline, isOpenChallenge, type ChallengeSettings, type ChallengeStatus } from '../shared/challenge.ts'
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
 * What the deadline does (for `e7-t13`): whoever has not answered declined, and the challenge is
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
