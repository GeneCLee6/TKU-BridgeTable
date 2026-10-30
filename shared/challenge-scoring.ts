import { imps } from './imp.ts'
import { ARTIFICIAL, artificialForNS, ruledScore, type ScoreRuling } from './ruling-scoring.ts'
import type { RulingKind } from './team-scoring.ts'

/**
 * How a challenge is scored (docs/PRD/e7-challenges.md, 計分定義). Every participant plays the
 * same boards from the South seat, so a board's North-South score is the participant's own.
 *
 * - `imp`: head to head, the IMPs between the two scores of each board, added up (with more than
 *   two players it is the same as `crossImp`)
 * - `total`: the scores added up
 * - `mp`: each board, 2 points for every participant beaten and 1 for a tie, as a percentage of
 *   2 × (players − 1); the result is the average over the boards
 * - `crossImp`: each board, the IMPs against every other participant, averaged; added up
 *
 * A board someone has not played is scored by `unfinished`: `avgMinus` is 40% or −3 IMPs, `worst`
 * is 0% or the lowest score anyone made on it. With `total` both use the lowest score (0 when
 * nobody played it). The others on that board are compared only with those who played it; alone,
 * a player gets 50% or 0 IMPs.
 *
 * A director's ruling on someone's board (`e2-t36`, `shared/ruling-scoring.ts`): an assigned score
 * takes the place of theirs and everyone compares with it; Avg, Avg+ or Avg- gives them 50/60/40%
 * or 0/+3/−3 IMPs (with `total`, the others' average and ± 100) and the others compare only with
 * the results that were not given an artificial score. The participant sits South, so a ruling's
 * North-South side is theirs.
 */

export const CHALLENGE_SCORINGS = ['imp', 'total', 'mp', 'crossImp'] as const
export type ChallengeScoring = (typeof CHALLENGE_SCORINGS)[number]

export const UNFINISHED_RULES = ['avgMinus', 'worst'] as const
export type UnfinishedRule = (typeof UNFINISHED_RULES)[number]

/** Avg-: what a board someone did not play is worth */
export const AVG_MINUS = { percent: 40, imps: -3 } as const

export interface ChallengeScores {
  scoring: ChallengeScoring
  unfinished: UnfinishedRule
  /** Each participant's North-South score on every board, in board order; null when not played */
  scores: Record<string, (number | null)[]>
  /** A director's ruling on a participant's board, in the same places as `scores` (`e2-t36`) */
  rulings?: Record<string, (ScoreRuling | null | undefined)[]>
}

export interface Standing {
  player: string
  /** The result of each board: a percentage for `mp`, IMPs or points otherwise */
  boards: number[]
  /** The average percentage for `mp`, the sum otherwise */
  total: number
  /** Equal totals share a place and the next place is skipped: 1, 2, 2, 4 */
  rank: number
  played: number
}

/** Totals this close count as equal (averaged IMPs and percentages are fractions) */
const SAME = 1e-9

function boardResult(scoring: ChallengeScoring, mine: number, others: number[]): number {
  if (scoring === 'total') return mine
  if (scoring === 'mp') {
    if (!others.length) return 50
    const points = others.reduce((sum, other) => sum + (mine > other ? 2 : mine === other ? 1 : 0), 0)
    return (points / (2 * others.length)) * 100
  }
  if (!others.length) return 0
  return others.reduce((sum, other) => sum + imps(mine - other), 0) / others.length
}

/** What an artificial ruling (as the participant gets it) is worth on a board, `others` the scores compared */
export function artificialResult(scoring: ChallengeScoring, kind: RulingKind, others: number[]): number {
  if (scoring === 'mp') return ARTIFICIAL.percent[kind]
  if (scoring !== 'total') return ARTIFICIAL.imps[kind]
  const average = others.length ? Math.round(others.reduce((a, b) => a + b, 0) / others.length / 10) * 10 : 0
  return average + ARTIFICIAL.points[kind]
}

export function scoreChallenge({ scoring, unfinished, scores, rulings }: ChallengeScores): Standing[] {
  const players = Object.keys(scores)
  const boards = Math.max(0, ...players.map((p) => scores[p].length))

  const results = new Map(players.map((p) => [p, [] as number[]]))
  for (let b = 0; b < boards; b++) {
    const ruling = (p: string) => rulings?.[p]?.[b]
    const played = players.filter((p) => typeof scores[p][b] === 'number')
    // Results given an artificial score are compared with nobody (Law 12C2)
    const compared = played.filter((p) => !artificialForNS(ruling(p)))
    const score = (p: string) => ruledScore(scores[p][b]!, ruling(p))
    const lowest = compared.length ? Math.min(...compared.map(score)) : 0
    for (const player of players) {
      const mine = scores[player][b]
      const others = compared.filter((p) => p !== player).map(score)
      const artificial = typeof mine === 'number' ? artificialForNS(ruling(player)) : null
      let result: number
      if (artificial) result = artificialResult(scoring, artificial, others)
      else if (typeof mine === 'number') result = boardResult(scoring, score(player), others)
      else if (scoring === 'total') result = lowest
      else if (unfinished === 'avgMinus') result = scoring === 'mp' ? AVG_MINUS.percent : AVG_MINUS.imps
      else result = scoring === 'mp' ? 0 : boardResult(scoring, lowest, others)
      results.get(player)!.push(result)
    }
  }

  const standings = players.map((player) => {
    const list = results.get(player)!
    const sum = list.reduce((a, b) => a + b, 0)
    return {
      player,
      boards: list,
      total: scoring === 'mp' ? (boards ? sum / boards : 0) : sum,
      rank: 0,
      played: scores[player].filter((s) => typeof s === 'number').length,
    }
  })
  for (const s of standings) s.rank = 1 + standings.filter((o) => o.total > s.total + SAME).length
  // Best first; equal places keep the order the players were given in
  return standings.sort((a, b) => a.rank - b.rank)
}

/**
 * Head to head (the results page, 社長 2026-10-25): how one participant did against each other
 * participant, board by board, as BBO's challenge results show it. The unit follows the challenge's
 * scoring:
 * - `imp`, `crossImp`: the IMPs of the difference between the two scores (positive: I won)
 * - `mp`: the matchpoints of that pair as a percentage: 100 beaten, 50 tied, 0 lost
 * - `total`: the difference in points
 */
export function pairResult(scoring: ChallengeScoring, mine: number, theirs: number): number {
  if (scoring === 'total') return mine - theirs
  if (scoring === 'mp') return mine > theirs ? 100 : mine === theirs ? 50 : 0
  return imps(mine - theirs)
}

/** One opponent: my result against them on each board, and over the boards we both played */
export interface Versus {
  opponent: string
  /** In board order; null where one of us did not play the board */
  boards: (number | null)[]
  /** Boards we both played */
  compared: number
  /** The sum for IMPs and points, the average percentage for `mp`; null when nothing was compared */
  total: number | null
}

/**
 * `me` against every other participant in `scores` (North-South scores by board, null when not
 * played), in the order they were given. Only boards both played are compared, so it works for
 * those who did not finish and for a challenge of one board. With a director's ruling (`e2-t36`)
 * an assigned score is compared instead of the one played, and a board either of us was given
 * Avg, Avg+ or Avg- on is not compared (an artificial score is compared with nobody, Law 12C2)
 */
export function headToHead(
  scoring: ChallengeScoring,
  scores: Record<string, (number | null)[]>,
  me: string,
  rulings: Record<string, (ScoreRuling | null | undefined)[]> = {},
): Versus[] {
  const mine = scores[me] ?? []
  const comparable = (player: string, b: number): number | null => {
    const score = scores[player][b]
    const ruling = rulings[player]?.[b]
    return typeof score === 'number' && !artificialForNS(ruling) ? ruledScore(score, ruling) : null
  }
  return Object.keys(scores)
    .filter((p) => p !== me)
    .map((opponent) => {
      const boards = mine.map((_, b) => {
        const score = comparable(me, b)
        const theirs = comparable(opponent, b)
        return score !== null && theirs !== null ? pairResult(scoring, score, theirs) : null
      })
      const played = boards.filter((r): r is number => r !== null)
      const sum = played.reduce((a, b) => a + b, 0)
      return {
        opponent,
        boards,
        compared: played.length,
        total: played.length ? (scoring === 'mp' ? sum / played.length : sum) : null,
      }
    })
}

/**
 * Against everyone together: the sum of the totals for IMPs and points, the average over every
 * board compared for `mp`; null when nothing was compared
 */
export function headToHeadTotal(scoring: ChallengeScoring, versus: Versus[]): number | null {
  const compared = versus.reduce((n, v) => n + v.compared, 0)
  if (!compared) return null
  if (scoring !== 'mp') return versus.reduce((sum, v) => sum + (v.total ?? 0), 0)
  return versus.reduce((sum, v) => sum + (v.total ?? 0) * v.compared, 0) / compared
}
