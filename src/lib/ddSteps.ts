import { rankOf, rankValue, sideOf, suitOf, type Card, type Seat } from '../../shared/cards.ts'
import type { BoardState } from '../../shared/game.ts'
import { ddPosition, isCompleteDeal, pbnDeal, type DdPosition } from './doubleDummy.ts'

/**
 * What the cards actually played were worth, double dummy (`e4-t35`, `e10-t12`): at each step of a
 * finished board, the best cards the hand to play had, and how many tricks the card it played cost
 * its side. Plain data: `ddAnalysis.ts` feeds it DDS's answers. A step is either worked out to the
 * end or `tooComplex`; there is no in-between, so no number here comes from a partial search.
 */

interface StepBase {
  /** Which card of the play this is, from 0 */
  index: number
  seat: Seat
  card: Card
  /** The trick it belongs to, from 1 */
  trick: number
  /** The card was played by declarer's side */
  declarerSide: boolean
}

export type SolvedStep = StepBase & {
  status: 'solved'
  /** The cards that keep the most tricks for the side to play (the played one among them when `loss` is 0) */
  best: Card[]
  /** Tricks the played card cost its side against the best card, with best play afterwards */
  loss: number
}

export type DdStep = SolvedStep | (StepBase & { status: 'tooComplex' })

function base(board: BoardState, index: number): StepBase {
  const { seat, card } = board.play[index]
  return { index, seat, card, trick: Math.floor(index / 4) + 1, declarerSide: sideOf(seat) === sideOf(board.contract!.declarer) }
}

/** High cards first within a suit; the suits stay in the order the hand has them */
const byStrength = (a: Card, b: Card) => (suitOf(a) === suitOf(b) ? rankValue(rankOf(b)) - rankValue(rankOf(a)) : 0)

export function tooComplexStep(board: BoardState, index: number): DdStep {
  return { ...base(board, index), status: 'tooComplex' }
}

/** One legal card: nothing to solve and nothing to lose */
export function forcedStep(board: BoardState, index: number): DdStep {
  return { ...base(board, index), status: 'solved', best: [board.play[index].card], loss: 0 }
}

/** The step a position's scores make of the card played there (`scores`: tricks for the side to play) */
export function solvedStep(board: BoardState, index: number, position: DdPosition, scores: ReadonlyMap<Card, number>): DdStep {
  const known = position.legal.filter((card) => scores.has(card))
  const score = scores.get(board.play[index].card)
  // DDS answers for every legal card; an answer that leaves any out is not one to put a number on
  if (score === undefined || known.length !== position.legal.length) return tooComplexStep(board, index)
  const top = Math.max(...known.map((card) => scores.get(card)!))
  return {
    ...base(board, index),
    status: 'solved',
    best: known.filter((card) => scores.get(card) === top).sort(byStrength),
    loss: top - score,
  }
}

/** The point of the play before card `index`, from the record's cards only */
export const positionBefore = (board: BoardState, index: number) => ddPosition(board, board.play.slice(0, index))

/** Whether the board's play can be analysed: finished, a whole deal, a contract and cards played */
export const hasSteps = (board: BoardState) =>
  board.phase === 'finished' && !!board.contract && board.play.length > 0 && isCompleteDeal(board.hands)

/** The same deal, contract and cards always give the same steps, so each board is worked out once */
export const boardKey = (board: BoardState) =>
  [pbnDeal(board.hands), board.contract?.strain, board.contract?.declarer, board.play.map((p) => p.card).join('')].join('|')

/** The steps that cost the most: biggest first, the earlier of two equal ones first */
export function biggestLosses(steps: readonly (DdStep | undefined)[], count = 3): SolvedStep[] {
  return steps
    .filter((step): step is SolvedStep => step?.status === 'solved' && step.loss > 0)
    .sort((a, b) => b.loss - a.loss || a.index - b.index)
    .slice(0, count)
}

export interface StepTotals {
  /** Tricks declarer's side gave away over the board */
  declarerLoss: number
  /** Tricks the defenders gave away */
  defenceLoss: number
  /** Steps that went over the budget, which the totals leave out */
  tooComplex: number
}

export function stepTotals(steps: readonly (DdStep | undefined)[]): StepTotals {
  const totals: StepTotals = { declarerLoss: 0, defenceLoss: 0, tooComplex: 0 }
  for (const step of steps) {
    if (step?.status === 'tooComplex') totals.tooComplex++
    if (step?.status !== 'solved') continue
    if (step.declarerSide) totals.declarerLoss += step.loss
    else totals.defenceLoss += step.loss
  }
  return totals
}
