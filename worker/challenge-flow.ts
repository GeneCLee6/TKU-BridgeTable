import {
  challengeDeadline,
  challengePairsOf,
  isOpenChallenge,
  type ChallengeSettings,
  type ChallengeStandingsView,
  type ChallengeStatus,
} from '../shared/challenge.ts'
import { scoreChallenge } from '../shared/challenge-scoring.ts'
import type { DealSet } from '../shared/deal-set.ts'
import type { MessageCode } from '../shared/messages.ts'
import type { ScoreRuling } from '../shared/ruling-scoring.ts'
import type { Challenge, ChallengePlayer, ChallengeResult } from './challenges.ts'

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
  /**
   * 「用這副牌挑戰」 (`e7-t22`): the creator's results from when they played these boards. They do
   * not play again: they count as having played every board, with these results
   */
  known?: ChallengeResult[]
}): Challenge {
  const known = !!c.known
  // A partner challenge (`e7-t28`): each member knows their partner, the creator's is the first invitee
  const partners = new Map<string, string>()
  if (c.settings.partners)
    for (const [a, b] of challengePairsOf(c.creatorId, c.invitees) ?? []) {
      partners.set(a, b)
      partners.set(b, a)
    }
  const partner = (userId: string) => {
    const id = partners.get(userId)
    return id === undefined ? {} : { partnerId: id }
  }
  return {
    id: c.id,
    creatorId: c.creatorId,
    createdAt: c.now,
    status: 'pending',
    deadline: challengeDeadline(c.now, c.settings),
    settings: c.settings,
    deals: c.deals,
    players: [
      {
        userId: c.creatorId,
        status: 'accepted',
        invitedAt: c.now,
        answeredAt: c.now,
        ...(known && { startedAt: c.now, finishedAt: c.now }),
        knownDeals: known,
        ...partner(c.creatorId),
      },
      ...c.invitees.map(
        (userId): ChallengePlayer => ({ userId, status: 'invited', invitedAt: c.now, knownDeals: false, ...partner(userId) }),
      ),
    ],
    results: c.known ?? [],
  }
}

/** Whether answers and play are still taken: an open state and the deadline not reached */
export const challengeTakesPart = (c: Challenge, now: number) => isOpenChallenge(c.status) && now < c.deadline

// ── Partnerships (`e7-t28`) ─────────────────────────────────────────────────────────────────────

/** A participant's partner in a partner challenge (null in any other, or once the partner is gone) */
export function partnerOf(c: Challenge, userId: string): ChallengePlayer | null {
  const id = c.players.find((p) => p.userId === userId)?.partnerId
  return (id !== undefined && c.players.find((p) => p.userId === id)) || null
}

/**
 * The member a partnership's table, results and standings go under: the one invited first (the
 * creator for theirs). Oneself in a challenge without partners
 */
export function pairLead(c: Challenge, userId: string): string {
  const partner = partnerOf(c, userId)
  if (!partner) return userId
  const at = (id: string) => c.players.findIndex((p) => p.userId === id)
  return at(partner.userId) < at(userId) ? partner.userId : userId
}

/** Whether a participant is the second member of a partnership: one entry, so they are not listed apart */
export const isPairSecond = (c: Challenge, userId: string) => pairLead(c, userId) !== userId

/** Whether a participant may sit down to play: accepted, and in a partner challenge their partner too */
export function pairReady(c: Challenge, player: ChallengePlayer): boolean {
  if (player.status !== 'accepted') return false
  if (!c.settings.partners) return true
  return partnerOf(c, player.userId)?.status === 'accepted'
}

/**
 * A partnership is one entry: when one member declines (or the deadline declines them), the other
 * cannot play without them and declines too. Returns the changed rows, the given ones first
 */
function declinePairs(c: Challenge, changed: ChallengePlayer[], now: number): ChallengePlayer[] {
  if (!c.settings.partners) return changed
  const rows = new Map(c.players.map((p) => [p.userId, p]))
  for (const p of changed) rows.set(p.userId, p)
  const out = new Map(changed.map((p) => [p.userId, p]))
  for (const p of changed) {
    if (p.status !== 'declined' || p.partnerId === undefined) continue
    const partner = rows.get(p.partnerId)
    if (!partner || partner.status === 'declined') continue
    const declined: ChallengePlayer = { ...partner, status: 'declined', answeredAt: partner.answeredAt ?? now }
    rows.set(declined.userId, declined)
    out.set(declined.userId, declined)
  }
  return [...out.values()]
}

/** The participants besides the creator and, in a partner challenge, the creator's partner */
function opponentsIn(c: Challenge, players: ChallengePlayer[]): ChallengePlayer[] {
  const own = new Set([c.creatorId])
  const partner = c.settings.partners ? partnerOf(c, c.creatorId) : null
  if (partner) own.add(partner.userId)
  return players.filter((p) => !own.has(p.userId))
}

/**
 * An invitee's answer. Only once, only while the challenge is open and before the deadline. The
 * first acceptance besides the creator makes it `active`; when the last invitee declines and
 * nobody but the creator accepted, there is nobody left to wait for and it is `expired` at once.
 * In a partner challenge (`e7-t28`) a partnership counts once both of them accepted, and one
 * member declining declines their partner too (the change carries both rows)
 */
export function answer(c: Challenge, userId: string, accept: boolean, now: number): ChallengeStep {
  const player = c.players.find((p) => p.userId === userId)
  if (!player) return { error: 'challengeGone' }
  if (!challengeTakesPart(c, now)) return { error: 'challengeClosed' }
  if (player.status !== 'invited') return { error: 'alreadyAnswered' }
  const answered: ChallengePlayer = { ...player, status: accept ? 'accepted' : 'declined', answeredAt: now }
  const changed = declinePairs(c, [answered], now)
  const rows = new Map(changed.map((p) => [p.userId, p]))
  const players = c.players.map((p) => rows.get(p.userId) ?? p)
  const after: Challenge = { ...c, players }
  const others = opponentsIn(c, players)
  if (accept && c.status === 'pending' && others.some((p) => pairReady(after, p))) return { players: changed, status: 'active' }
  if (!accept && c.status === 'pending' && others.every((p) => p.status === 'declined'))
    return { players: changed, status: 'expired' }
  return { players: changed }
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
  const unanswered = c.players
    .filter((p) => p.status === 'invited')
    .map((p): ChallengePlayer => ({ ...p, status: 'declined', answeredAt: now }))
  // A member whose partner never answered could not play: the partnership declined (`e7-t28`)
  const players = declinePairs(c, unanswered, now)
  const rows = new Map(players.map((p) => [p.userId, p]))
  const accepted = opponentsIn(c, c.players).some((p) => (rows.get(p.userId) ?? p).status === 'accepted')
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
export function challengeStandings(
  c: Challenge,
  rulingOf: (boardId: string) => ScoreRuling | undefined = () => undefined,
): ChallengeStandingsView {
  // A partnership is one entry, under its first member (`e7-t28`): both have the same results
  const finishers = c.players.filter((p) => hasFinished(c, p) && !isPairSecond(c, p.userId))
  const scoring = finishers.length > 1 ? c.settings.scoring : 'total'
  const scores: Record<string, number[]> = {}
  // A director's ruling on a participant's board (`e2-t36`), and which boards those are
  const rulings: Record<string, (ScoreRuling | undefined)[]> = {}
  const ruled: Record<string, number[]> = {}
  for (const p of finishers) {
    const row = new Array<number>(c.deals.boards.length).fill(0)
    const rulingRow = new Array<ScoreRuling | undefined>(c.deals.boards.length)
    for (const r of c.results) {
      if (r.userId !== p.userId) continue
      row[r.seq - 1] = r.scoreNS
      rulingRow[r.seq - 1] = rulingOf(r.boardId)
    }
    scores[p.userId] = row
    rulings[p.userId] = rulingRow
    ruled[p.userId] = rulingRow.flatMap((ruling, i) => (ruling ? [i + 1] : []))
  }
  // Everyone ranked played every board, so the rule for unplayed boards never applies
  const ranked = finishers.length ? scoreChallenge({ scoring, unfinished: 'worst', scores, rulings }) : []
  return {
    final: c.status === 'finished',
    scoring,
    ranked: ranked.map((s) => ({
      userId: s.player,
      rank: s.rank,
      total: s.total,
      boards: s.boards,
      ...(ruled[s.player].length > 0 && { ruled: ruled[s.player] }),
      ...withPartner(c, s.player),
    })),
    unfinished: c.players
      .filter((p) => p.status === 'accepted' && !hasFinished(c, p) && !isPairSecond(c, p.userId))
      .map((p) => ({ userId: p.userId, played: playedCount(c, p.userId), ...withPartner(c, p.userId) })),
  }
}

/** `{ partnerId }` for a member of a partnership, nothing otherwise: how the views name the second member */
export function withPartner(c: Challenge, userId: string): { partnerId?: string } {
  const partner = partnerOf(c, userId)
  return partner ? { partnerId: partner.userId } : {}
}
