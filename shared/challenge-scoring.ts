import { imps } from './imp.ts'

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

export function scoreChallenge({ scoring, unfinished, scores }: ChallengeScores): Standing[] {
  const players = Object.keys(scores)
  const boards = Math.max(0, ...players.map((p) => scores[p].length))

  const results = new Map(players.map((p) => [p, [] as number[]]))
  for (let b = 0; b < boards; b++) {
    const played = players.filter((p) => typeof scores[p][b] === 'number')
    const lowest = played.length ? Math.min(...played.map((p) => scores[p][b]!)) : 0
    for (const player of players) {
      const mine = scores[player][b]
      const others = played.filter((p) => p !== player).map((p) => scores[p][b]!)
      let result: number
      if (typeof mine === 'number') result = boardResult(scoring, mine, others)
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
