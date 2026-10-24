import { sideOf, type Seat } from '../shared/cards.ts'
import { makeCall, newBoard, playCard, turnOf, type BoardState } from '../shared/game.ts'
import type { RobotKind } from '../shared/protocol.ts'
import { ruleBrain, type RobotBrain } from '../shared/robot/brain.ts'
import type { EvalBoard } from './deals.ts'
import type { BoardOutcome, TableResult } from './stats.ts'

/**
 * Robot against robot (e6-t15, eval/README.md): two configurations play the same boards at two
 * tables with the seats swapped. Everything is deterministic: the rule robot has no randomness of
 * its own, so a match of a configuration against itself scores exactly 0 on every board.
 */

/** One side's robots: all four robots of a side are the same configuration */
export interface RobotConfig {
  /** For the report, such as `tku` or `tku@base` */
  name: string
  kind: RobotKind
  /** Bids (and plays, unless `play` is given); the rule robot when not given */
  brain?: RobotBrain
  /** Plays the cards and answers claims, so a match can swap only the play (same auctions) */
  play?: RobotBrain
}

/** Plays a board out with `ns` in North and South and `ew` in East and West */
export async function playTable(board: EvalBoard, ns: RobotConfig, ew: RobotConfig): Promise<TableResult> {
  const configOf = (seat: Seat) => (sideOf(seat) === 'NS' ? ns : ew)
  let state: BoardState = newBoard(board.boardNo, board.hands)
  while (state.phase === 'auction') {
    const seat = turnOf(state)!
    const config = configOf(seat)
    const { call, alert } = await (config.brain ?? ruleBrain).bid(config.kind, state, seat)
    state = makeCall(state, seat, call, alert)
  }
  while (state.phase === 'play') {
    // The declarer plays dummy's cards: `turnOf` is the seat whose card is due, and both are one side
    const seat = turnOf(state)!
    const config = configOf(seat)
    const card = await (config.play ?? config.brain ?? ruleBrain).play(config.kind, state, seat)
    state = playCard(state, seat, card)
  }
  const result = state.result!
  return { contract: state.contract, declarerTricks: result.declarerTricks, scoreNS: result.scoreNS }
}

export interface MatchOptions {
  a: RobotConfig
  b: RobotConfig
  boards: readonly EvalBoard[]
  /** Called after each board, for progress */
  onBoard?: (outcome: BoardOutcome, done: number) => void
}

/** A against B on every board: A North-South at table 1, East-West at table 2 */
export async function playMatch({ a, b, boards, onBoard }: MatchOptions): Promise<BoardOutcome[]> {
  const outcomes: BoardOutcome[] = []
  for (const board of boards) {
    const outcome: BoardOutcome = {
      boardNo: board.boardNo,
      table1: await playTable(board, a, b),
      table2: await playTable(board, b, a),
    }
    outcomes.push(outcome)
    onBoard?.(outcome, outcomes.length)
  }
  return outcomes
}
