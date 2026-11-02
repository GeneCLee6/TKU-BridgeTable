import { headToHead, type ChallengeScoring } from './challenge-scoring.ts'
import type { PublicUser } from './protocol.ts'
import type { ScoreRuling } from './ruling-scoring.ts'

/**
 * A member's challenge record (`e7-t29`, ARCHITECTURE.md §5.5): how often they win, their average
 * IMPs and their head to head with everyone they met. Only finished challenges count, and in each
 * only those who played every board (the ranked ones, as in the standings), so a challenge someone
 * did not finish never counts for or against anyone.
 *
 * - A **meeting** is one challenge against one other ranked participant. It is won, lost or drawn
 *   by the challenge's own scoring over the boards both played (`headToHead`: more IMPs or points,
 *   or over 50% for matchpoints).
 * - The **win rate** counts a draw as half: (wins + draws / 2) ÷ meetings.
 * - The **average IMPs** are per board and opponent, whatever the challenge's scoring: the IMPs of
 *   the difference between the two scores, added up and divided by the boards compared.
 */

/** One finished challenge, as the stats need it: the ranked participants' scores */
export interface StatsChallenge {
  id: string
  /** When it ended */
  at: number
  scoring: ChallengeScoring
  /** North-South score on every board for each ranked participant (every board played) */
  scores: Record<string, number[]>
  /** A director's ruling on a participant's board (`e2-t36`), in the same places as `scores` */
  rulings?: Record<string, (ScoreRuling | null | undefined)[]>
  /** Each ranked participant's place */
  ranks: Record<string, number>
}

export interface WinLoss {
  wins: number
  losses: number
  draws: number
}

/** Against one opponent */
export interface OpponentStats extends WinLoss {
  opponent: string
  /** Absent for an account that was deleted */
  user?: PublicUser
  /** Challenges both were ranked in */
  challenges: number
  /** Boards compared */
  boards: number
  /** My IMPs against them, added up (positive: I won more) */
  imps: number
  /** When we last met */
  lastAt: number
}

export interface ChallengeStatsView extends WinLoss {
  /** Finished challenges they were ranked in with at least one other ranked participant */
  challenges: number
  /** Of those, the ones they came first in (shared first places too) */
  firsts: number
  /** (wins + draws / 2) ÷ meetings; null with no meeting */
  winRate: number | null
  /** Boards compared with an opponent, every opponent counted */
  boards: number
  /** IMPs per board compared; null with nothing compared */
  averageImps: number | null
  /** Most challenges together first, then the latest meeting */
  opponents: OpponentStats[]
}

/** Totals this close count as equal (averaged percentages are fractions) */
const SAME = 1e-9

function outcome(scoring: ChallengeScoring, total: number): keyof WinLoss {
  const margin = scoring === 'mp' ? total - 50 : total
  return margin > SAME ? 'wins' : margin < -SAME ? 'losses' : 'draws'
}

export function challengeStats(me: string, challenges: StatsChallenge[]): Omit<ChallengeStatsView, 'opponents'> & {
  opponents: Omit<OpponentStats, 'user'>[]
} {
  const total: WinLoss = { wins: 0, losses: 0, draws: 0 }
  const opponents = new Map<string, Omit<OpponentStats, 'user'>>()
  let counted = 0
  let firsts = 0
  let boards = 0
  let imps = 0
  for (const c of challenges) {
    if (!c.scores[me] || Object.keys(c.scores).length < 2) continue
    counted++
    if (c.ranks[me] === 1) firsts++
    const rulings = c.rulings ?? {}
    const byScoring = headToHead(c.scoring, c.scores, me, rulings)
    const byImps = new Map(headToHead('imp', c.scores, me, rulings).map((v) => [v.opponent, v]))
    for (const versus of byScoring) {
      const found = opponents.get(versus.opponent) ?? {
        opponent: versus.opponent,
        wins: 0,
        losses: 0,
        draws: 0,
        challenges: 0,
        boards: 0,
        imps: 0,
        lastAt: 0,
      }
      found.challenges++
      found.lastAt = Math.max(found.lastAt, c.at)
      // Every board either of us was given an artificial score on: nothing to compare
      if (versus.total !== null) {
        const result = outcome(c.scoring, versus.total)
        found[result]++
        total[result]++
      }
      const inImps = byImps.get(versus.opponent)
      if (inImps && inImps.total !== null) {
        found.boards += inImps.compared
        found.imps += inImps.total
        boards += inImps.compared
        imps += inImps.total
      }
      opponents.set(versus.opponent, found)
    }
  }
  const meetings = total.wins + total.losses + total.draws
  return {
    ...total,
    challenges: counted,
    firsts,
    winRate: meetings ? (total.wins + total.draws / 2) / meetings : null,
    boards,
    averageImps: boards ? imps / boards : null,
    opponents: [...opponents.values()].sort((a, b) => b.challenges - a.challenges || b.lastAt - a.lastAt),
  }
}
