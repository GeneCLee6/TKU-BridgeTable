import type { Contract } from '../../shared/auction.ts'
import type { Card } from '../../shared/cards.ts'
import { duplicateScore } from '../../shared/scoring.ts'

/**
 * Scoring the candidate cards of a decision from the double-dummy results of the sampled layouts
 * (eval/sim/README.md §2). Each layout gives every card the tricks the side to play then takes;
 * over the layouts a card gets its average tricks, how often the contract is made or defeated
 * (whichever the side wants) and the average duplicate score. Which one decides is the objective.
 *
 * Double dummy flatters the declarer: it sees every card, so it never misguesses a finesse and
 * cannot be deceived. `ddBias` takes that many tricks (fractions allowed) off the declarer in
 * every layout before the contract and the score are judged, a crude correction knob whose right
 * value the comparisons against real play will have to find.
 */

export type Objective = 'tricks' | 'contract' | 'score'

export interface ScoreContext {
  contract: Contract
  /** The seat to play is on the declaring side */
  declaring: boolean
  /** The declarer is vulnerable */
  vulnerable: boolean
  /** Tricks the seat's side has won so far */
  won: number
}

export interface CardScore {
  card: Card
  /** Layouts the card was scored on */
  n: number
  /** The side's tricks at the end of the deal, on average (those won so far included) */
  meanTricks: number
  /** How often the contract is made (declaring) or defeated (defending), 0 to 1 */
  pSuccess: number
  /** The side's average duplicate score */
  meanScore: number
}

interface Outcome {
  success: number
  score: number
}

function outcome(ctx: ScoreContext, declarerTricks: number): Outcome {
  const tricks = Math.max(0, Math.min(13, declarerTricks))
  const made = tricks >= ctx.contract.level + 6
  const score = duplicateScore(ctx.contract, tricks, ctx.vulnerable)
  return ctx.declaring ? { success: made ? 1 : 0, score } : { success: made ? 0 : 1, score: -score }
}

/** The outcome with the declarer `bias` tricks worse off; a fraction mixes the two nearest whole numbers */
function biased(ctx: ScoreContext, declarerTricks: number, bias: number): Outcome {
  const whole = Math.floor(bias)
  const part = bias - whole
  const low = outcome(ctx, declarerTricks - whole)
  if (part === 0) return low
  const high = outcome(ctx, declarerTricks - whole - 1)
  return { success: low.success * (1 - part) + high.success * part, score: low.score * (1 - part) + high.score * part }
}

/**
 * Every card's score over the layouts. Each layout's map gives the tricks the side to play takes
 * from the rest of the deal with each card; a card missing from a layout (never, with DDS) is left
 * out of that layout's count.
 */
export function scoreCards(layouts: readonly Map<Card, number>[], ctx: ScoreContext, ddBias = 0): CardScore[] {
  const totals = new Map<Card, { n: number; tricks: number; success: number; score: number }>()
  for (const layout of layouts) {
    for (const [card, remaining] of layout) {
      const ours = ctx.won + remaining
      const declarerTricks = ctx.declaring ? ours : 13 - ours
      const { success, score } = biased(ctx, declarerTricks, ddBias)
      const total = totals.get(card) ?? { n: 0, tricks: 0, success: 0, score: 0 }
      total.n++
      total.tricks += ours
      total.success += success
      total.score += score
      totals.set(card, total)
    }
  }
  return [...totals].map(([card, t]) => ({ card, n: t.n, meanTricks: t.tricks / t.n, pSuccess: t.success / t.n, meanScore: t.score / t.n }))
}

/** What the objective looks at */
export function objectiveValue(score: CardScore, objective: Objective): number {
  return objective === 'tricks' ? score.meanTricks : objective === 'contract' ? score.pSuccess : score.meanScore
}

/** The best card by the objective; ties go to the better average tricks, then the better contract odds */
export function bestCard(scores: readonly CardScore[], objective: Objective): CardScore {
  return [...scores].sort(
    (a, b) => objectiveValue(b, objective) - objectiveValue(a, objective) || b.meanTricks - a.meanTricks || b.pSuccess - a.pSuccess,
  )[0]
}
