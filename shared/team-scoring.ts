import { imps } from './imp.ts'
import { artificialForNS, ruledScore, type ScoreRuling } from './ruling-scoring.ts'

/**
 * How a two-table team match is scored (docs/PRD/e8-two-table-team-match.md, ARCHITECTURE.md §5.8).
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
 *
 * A director's ruling on one room's board record (`e2-t35`, `e2-t36`) counts when the host did not
 * rule on the whole board (the host's match ruling wins, and the record's ruling is then only shown):
 * an assigned score takes the place of that room's North-South score; Avg, Avg+ or Avg- is given to
 * the team sitting on that side in that room and decides the board like the host's ruling (the
 * other room's score is not compared with it). Both rooms given one: the IMPs are added up (BAM:
 * the two shares averaged).
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
  /** The host's ruling on the whole board (`e8-t15`): it wins over the rooms' own rulings */
  ruling?: Ruling
  /** A director's ruling on one room's board record (`e2-t36`) */
  rooms?: { open?: ScoreRuling; closed?: ScoreRuling }
}

/** What each team won on a board: IMPs (never negative; one of the two is 0) or BAM points */
export interface TeamBoardResult {
  A: number
  B: number
  /** Team A's net score (open − closed North-South); absent when Avg, Avg+ or Avg- decided the board */
  net?: number
  /** A ruling counted: the host's, or a director's on a room's board (`e2-t36`) */
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
  const { open: openRuling, closed: closedRuling } = board.rooms ?? {}
  // Avg, Avg+ or Avg- in a room: for the team on that side there (open North-South is A, closed B)
  const artificial = [
    { kind: artificialForNS(openRuling), team: 'A' as const },
    { kind: artificialForNS(closedRuling), team: 'B' as const },
  ].flatMap(({ kind, team }) => (kind ? [ruled(scoring, { kind, team })] : []))
  if (artificial.length === 1) return artificial[0]
  if (artificial.length === 2) {
    if (scoring === 'bam') {
      const a = (artificial[0].A + artificial[1].A) / 2
      return { A: a, B: 1 - a, ruled: true }
    }
    const margin = artificial[0].A - artificial[0].B + artificial[1].A - artificial[1].B
    return { A: Math.max(0, margin), B: Math.max(0, -margin), ruled: true }
  }
  const net = ruledScore(board.open, openRuling) - ruledScore(board.closed, closedRuling)
  const ruledHere = !!(openRuling || closedRuling)
  if (scoring === 'bam') {
    const a = net > 0 ? 1 : net < 0 ? 0 : 0.5
    return { A: a, B: 1 - a, net, ruled: ruledHere }
  }
  const won = imps(net)
  return { A: Math.max(0, won), B: Math.max(0, -won), net, ruled: ruledHere }
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
