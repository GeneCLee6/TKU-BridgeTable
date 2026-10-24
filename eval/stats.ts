import type { Contract } from '../shared/auction.ts'
import { sideOf } from '../shared/cards.ts'
import { imps } from '../shared/imp.ts'

/**
 * Scoring a match between two robot configurations, A and B (e6-t15, eval/README.md). Each board is
 * played at two tables with the seats swapped: A sits North-South at table 1 and East-West at
 * table 2, so A's result on the board is table 1's North-South score minus table 2's.
 */

/** How one table played a board */
export interface TableResult {
  /** null when the board was passed out */
  contract: Contract | null
  declarerTricks: number
  scoreNS: number
}

export interface BoardOutcome {
  boardNo: number
  /** A North-South, B East-West */
  table1: TableResult
  /** B North-South, A East-West */
  table2: TableResult
}

/** What one configuration's side did as declarer over the match */
export interface DeclarerCounts {
  /** Boards on which its side declared, at either table */
  declared: number
  made: number
  down: number
  partscores: number
  games: number
  slams: number
  doubled: number
}

export interface MatchSummary {
  boards: number
  /** A's IMPs over the match (B's is the negative) */
  imps: number
  /** A's IMPs per board, and its standard error */
  impsPerBoard: number
  standardError: number
  /** The 95% confidence interval of the IMPs per board (± 1.96 standard errors) */
  ci95: [number, number]
  /** A's matchpoint percentage: a board won by any score scores 1, a tie ½ */
  mpPercent: number
  /** Boards A won, lost and tied on the score */
  won: number
  lost: number
  tied: number
  /** Boards with the same contract by the same declarer at both tables */
  sameContract: number
  /** Boards passed out at each table */
  passedOut: number
  a: DeclarerCounts
  b: DeclarerCounts
}

/** A's IMPs on a board */
export const boardImps = (board: BoardOutcome) => imps(board.table1.scoreNS - board.table2.scoreNS)

const sameContract = (x: Contract | null, y: Contract | null) =>
  x === y ||
  (!!x && !!y && x.level === y.level && x.strain === y.strain && x.doubled === y.doubled && x.declarer === y.declarer)

/** A contract worth game: 3NT, 4 of a major or 5 of a minor and up, below a slam */
const isGame = (c: Contract) => c.level < 6 && (c.strain === 'N' ? c.level >= 3 : c.strain === 'H' || c.strain === 'S' ? c.level >= 4 : c.level >= 5)

const noCounts = (): DeclarerCounts => ({ declared: 0, made: 0, down: 0, partscores: 0, games: 0, slams: 0, doubled: 0 })

function count(counts: DeclarerCounts, table: TableResult) {
  const c = table.contract!
  counts.declared++
  if (table.declarerTricks >= c.level + 6) counts.made++
  else counts.down++
  if (c.level >= 6) counts.slams++
  else if (isGame(c)) counts.games++
  else counts.partscores++
  if (c.doubled) counts.doubled++
}

/** The mean, sample standard error and 95% interval of numbers (0 error below two numbers) */
export function meanAndError(values: readonly number[]): { mean: number; standardError: number; ci95: [number, number] } {
  const n = values.length
  const mean = n ? values.reduce((s, v) => s + v, 0) / n : 0
  const variance = n > 1 ? values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1) : 0
  const standardError = n > 1 ? Math.sqrt(variance / n) : 0
  return { mean, standardError, ci95: [mean - 1.96 * standardError, mean + 1.96 * standardError] }
}

export function summarize(outcomes: readonly BoardOutcome[]): MatchSummary {
  const perBoard = outcomes.map(boardImps)
  const { mean, standardError, ci95 } = meanAndError(perBoard)
  const summary: MatchSummary = {
    boards: outcomes.length,
    imps: perBoard.reduce((s, v) => s + v, 0),
    impsPerBoard: mean,
    standardError,
    ci95,
    mpPercent: 0,
    won: 0,
    lost: 0,
    tied: 0,
    sameContract: 0,
    passedOut: 0,
    a: noCounts(),
    b: noCounts(),
  }
  for (const { table1, table2 } of outcomes) {
    const diff = table1.scoreNS - table2.scoreNS
    if (diff > 0) summary.won++
    else if (diff < 0) summary.lost++
    else summary.tied++
    if (sameContract(table1.contract, table2.contract)) summary.sameContract++
    // At table 1 A is North-South; at table 2 A is East-West
    for (const [table, aSide] of [[table1, 'NS'], [table2, 'EW']] as const) {
      if (!table.contract) summary.passedOut++
      else count(sideOf(table.contract.declarer) === aSide ? summary.a : summary.b, table)
    }
  }
  summary.mpPercent = outcomes.length ? ((summary.won + summary.tied / 2) / outcomes.length) * 100 : 50
  return summary
}

/**
 * The CI gate (e6-t17): the branch's robot (A) against main's (B) fails when it is worse by more
 * than two standard errors and by more than `floor` IMPs a board. Two standard errors keep chance
 * from failing a PR (about 1 in 40 when nothing changed for the worse); the floor keeps a tiny,
 * real loss on 200 boards with a small spread from blocking a PR that trades it for something else.
 */
export const GATE_FLOOR = 0.25
export const GATE_ERRORS = 2

export function regressed(summary: MatchSummary, floor = GATE_FLOOR, errors = GATE_ERRORS): boolean {
  return summary.impsPerBoard < -floor && summary.impsPerBoard < -errors * summary.standardError
}
