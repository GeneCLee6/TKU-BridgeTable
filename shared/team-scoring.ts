import { imps } from './imp.ts'

/**
 * How a two-table team match is scored (docs/PRD/e8-two-table-team-match.md, ARCHITECTURE.md §5.7).
 * Team A sits North-South in the open room and East-West in the closed room, team B the other way
 * round, so on every board team A's net score is the open room's North-South score minus the
 * closed room's: A won those points at the open table and B won the closed room's North-South
 * score, which is A's loss.
 *
 * - `imp`: the net score on the WBF IMP scale (`shared/imp.ts`); the IMPs go to the team that won
 *   them, so a match reads "A 23 : B 15"
 * - `bam` (Board-a-Match): the team with the better net score gets 1, a tie is ½ each
 *
 * A board the host ruled on (over the time limit, AC-8.6) is scored by the ruling instead of the
 * two rooms' scores: Avg is 0 IMPs (½ each with BAM); Avg+ for a team is +3 IMPs to it (60% of the
 * board with BAM) and Avg- is the same the other way round, so a board's result is zero-sum.
 */

export const MATCH_SCORINGS = ['imp', 'bam'] as const
export type MatchScoring = (typeof MATCH_SCORINGS)[number]

export const TEAMS = ['A', 'B'] as const
export type Team = (typeof TEAMS)[number]

export const otherTeam = (team: Team): Team => (team === 'A' ? 'B' : 'A')

/** The host's adjusted scores (AC-8.6) */
export const RULINGS = ['avg', 'avgPlus', 'avgMinus'] as const
export type RulingKind = (typeof RULINGS)[number]

export interface Ruling {
  kind: RulingKind
  /** Whom Avg+ or Avg- is for; the other team gets the opposite. Avg ignores it */
  team: Team
}

/** What a ruling gives the team it is for: IMPs, or the share of the board with BAM */
export const RULING_VALUE: Record<MatchScoring, Record<RulingKind, number>> = {
  imp: { avg: 0, avgPlus: 3, avgMinus: -3 },
  bam: { avg: 0.5, avgPlus: 0.6, avgMinus: 0.4 },
}

/** One board of the match: each room's North-South score, null until that room has played it */
export interface TeamBoardScores {
  open: number | null
  closed: number | null
  ruling?: Ruling
}

/** What each team won on a board: IMPs (never negative; one of the two is 0) or BAM points */
export interface TeamBoardResult {
  A: number
  B: number
  /** Team A's net score (open − closed North-South); absent when the board was ruled */
  net?: number
  ruled: boolean
}

export interface TeamMatchScore {
  /** Each board in order; null while a room has not played it and there is no ruling */
  boards: (TeamBoardResult | null)[]
  totals: Record<Team, number>
  /** Boards with a result */
  completed: number
  /** The team ahead, null when level */
  leader: Team | null
}

/** Totals this close count as equal (BAM rulings are tenths) */
const SAME = 1e-9

function ruled(scoring: MatchScoring, ruling: Ruling): TeamBoardResult {
  const mine = RULING_VALUE[scoring][ruling.kind]
  const theirs = scoring === 'imp' ? -mine : 1 - mine
  const forA = ruling.team === 'A'
  const a = forA ? mine : theirs
  const b = forA ? theirs : mine
  // IMPs go to whoever won them: +3 to A is A 3, B 0
  if (scoring === 'imp') return { A: Math.max(0, a), B: Math.max(0, b), ruled: true }
  return { A: a, B: b, ruled: true }
}

/** One board's result, or null while it is still being played in a room and nobody ruled on it */
export function teamBoardResult(scoring: MatchScoring, board: TeamBoardScores): TeamBoardResult | null {
  if (board.ruling) return ruled(scoring, board.ruling)
  if (board.open === null || board.closed === null) return null
  const net = board.open - board.closed
  if (scoring === 'bam') {
    const a = net > 0 ? 1 : net < 0 ? 0 : 0.5
    return { A: a, B: 1 - a, net, ruled: false }
  }
  const won = imps(net)
  return { A: Math.max(0, won), B: Math.max(0, -won), net, ruled: false }
}

/** The whole match so far: every board's result, the totals and who is ahead */
export function scoreTeamMatch(scoring: MatchScoring, boards: TeamBoardScores[]): TeamMatchScore {
  const results = boards.map((board) => teamBoardResult(scoring, board))
  const totals: Record<Team, number> = { A: 0, B: 0 }
  for (const result of results) {
    if (!result) continue
    totals.A += result.A
    totals.B += result.B
  }
  const margin = totals.A - totals.B
  return {
    boards: results,
    totals,
    completed: results.filter(Boolean).length,
    leader: Math.abs(margin) < SAME ? null : margin > 0 ? 'A' : 'B',
  }
}
