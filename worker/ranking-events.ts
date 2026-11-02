import type { ChallengeSettings } from '../shared/challenge.ts'
import type { PointKind } from '../shared/points.ts'
import type { ScoreRuling } from '../shared/ruling-scoring.ts'
import { teamAt } from '../shared/team-match.ts'
import { scoreTeamMatch } from '../shared/team-scoring.ts'
import { challengeStandings } from './challenge-flow.ts'
import type { Challenge } from './challenges.ts'
import type { RankedEvent } from './rankings.ts'
import { boardScores, type TeamMatch } from './team-matches.ts'

/**
 * How each kind of finished event goes into the ledger (`e9-t05`, ARCHITECTURE.md §5.20). Pure:
 * the club calls these when it settles an event, and `RankingStore.record` keeps each event once.
 */

export const challengeKind = (settings: ChallengeSettings): PointKind =>
  settings.daily ? 'daily' : settings.weekly ? 'weekly' : 'challenge'

/**
 * A finished challenge (the daily and weekly events too): its final standings, those who played
 * every board, each a side of one. A player whose own results were known before (`knownDeals`,
 * 用這副牌挑戰) is left out. Counted at its end, but a day's event that ran to its deadline (the
 * next midnight) stays on its own day. Null when it did not finish
 */
export function challengeEvent(
  c: Challenge,
  rulingOf: (boardId: string) => ScoreRuling | undefined,
  now: number,
): RankedEvent | null {
  if (c.status !== 'finished') return null
  const known = new Set(c.players.filter((p) => p.knownDeals).map((p) => p.userId))
  const standings = challengeStandings(c, rulingOf)
  // One finisher has nobody to compare with (`total`): no places to give
  const sides = standings.scoring === 'total' && standings.ranked.length < 2 ? [] : standings.ranked
  return {
    id: c.id,
    kind: challengeKind(c.settings),
    at: Math.min(c.endedAt ?? now, c.deadline - 1),
    sides: sides.filter((s) => !known.has(s.userId)).map((s) => ({ userIds: [s.userId], robots: 0, rank: s.rank })),
  }
}

/** Totals this close count as level (BAM rulings are tenths) */
const SAME = 1e-9

/**
 * A finished team match: two sides, the members of each team (robots count at their fixed rating
 * for the ratings), placed by the final score; level is a draw. Null when it did not finish
 */
export function matchEvent(
  m: TeamMatch,
  rulingOf: (boardId: string) => ScoreRuling | undefined,
  now: number,
): RankedEvent | null {
  if (m.status !== 'finished') return null
  const score = scoreTeamMatch(
    m.settings.scoring,
    Array.from({ length: m.settings.boards }, (_, i) => boardScores(m.boards.find((b) => b.seq === i + 1), rulingOf)),
  )
  const diff = score.totals.A - score.totals.B
  const team = (t: 'A' | 'B') => {
    const seats = m.seats.filter((s) => teamAt(s.room, s.seat) === t)
    const userIds = [...new Set(seats.flatMap((s) => (s.userId !== undefined && !s.robot ? [s.userId] : [])))]
    const robots = seats.filter((s) => s.robot).length
    const rank = Math.abs(diff) < SAME ? 1 : (t === 'A') === diff > 0 ? 1 : 2
    return { userIds, robots, rank }
  }
  return { id: m.id, kind: 'match', at: m.endedAt ?? now, sides: [team('A'), team('B')] }
}
