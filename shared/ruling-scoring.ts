import type { BoardRuling } from './board-events.ts'
import type { RulingKind } from './team-scoring.ts'

/**
 * A director's ruling on a board (`e2-t35`) in the scoring of challenges and team matches
 * (`e2-t36`, ARCHITECTURE.md §5.16). Two kinds of ruling (Laws of Duplicate Bridge 2017, Law 12C):
 *
 * - an assigned score (`score`, Law 12C1): the board counts as if the director's score had been
 *   played; everyone compares with it as with any result
 * - an artificial score (Avg, Avg+, Avg-, Law 12C2): the board is worth a fixed amount to the one
 *   it was given to, and nobody else compares with it. With matchpoints Avg is 50%, Avg+ 60% and
 *   Avg- 40% (Law 12C2(a)); with IMPs Avg is 0, Avg+ +3 and Avg- −3 IMPs (Law 86A). Law 12C2's
 *   "or the session's percentage when it is higher" for Avg+ is left out: one board is ranked at
 *   a time
 *
 * Only this module imports the record's ruling type, and only as a type, so `board-events.ts`
 * (which needs `RULINGS`) and `team-scoring.ts` can both use it without a cycle.
 */

/** A ruling as the scoring reads it: what it gives, without who gave it or why */
export type ScoreRuling = Pick<BoardRuling, 'kind' | 'side' | 'scoreNS'>

/** What an artificial ruling is worth: a percentage with matchpoints, IMPs otherwise */
export const ARTIFICIAL = {
  percent: { avg: 50, avgPlus: 60, avgMinus: 40 },
  imps: { avg: 0, avgPlus: 3, avgMinus: -3 },
  /**
   * Total points have no rule of their own: Avg is the average of the others' scores on the board
   * and Avg+/Avg- that ± 100 points (about the 3 IMPs of Avg± with IMPs)
   */
  points: { avg: 0, avgPlus: 100, avgMinus: -100 },
} as const satisfies Record<string, Record<RulingKind, number>>

/** The part of a ruling the scoring needs (the reason and the director stay in the record) */
export const scoreRuling = (ruling: ScoreRuling): ScoreRuling => ({
  kind: ruling.kind,
  ...(ruling.side && { side: ruling.side }),
  ...(ruling.scoreNS !== undefined && { scoreNS: ruling.scoreNS }),
})

/**
 * An artificial ruling (Avg, Avg+, Avg-) as North-South get it: Avg+ for East-West is Avg- for
 * North-South and the other way round. Null for no ruling or an assigned score
 */
export function artificialForNS(ruling: ScoreRuling | null | undefined): RulingKind | null {
  if (!ruling || ruling.kind === 'score') return null
  if (ruling.kind === 'avg' || ruling.side !== 'EW') return ruling.kind
  return ruling.kind === 'avgPlus' ? 'avgMinus' : 'avgPlus'
}

/** The North-South score a board counts with: the score the director gave, else the one played */
export const ruledScore = (scoreNS: number, ruling: ScoreRuling | null | undefined): number =>
  ruling?.kind === 'score' && ruling.scoreNS !== undefined ? ruling.scoreNS : scoreNS
