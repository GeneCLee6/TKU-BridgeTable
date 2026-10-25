import type { Contract } from '../../shared/auction.ts'
import { makeCall, newBoard, turnOf, type BoardState } from '../../shared/game.ts'
import type { RobotKind } from '../../shared/protocol.ts'
import { ruleBrain } from '../../shared/robot/brain.ts'
import type { EvalBoard } from '../deals.ts'

/** A board bid out by four TKBs of one system (the auctions the studies are made on) */
export async function bidBoard(board: EvalBoard, kind: RobotKind): Promise<BoardState> {
  let state = newBoard(board.boardNo, board.hands)
  while (state.phase === 'auction') {
    const seat = turnOf(state)!
    const { call, alert } = await ruleBrain.bid(kind, state, seat)
    state = makeCall(state, seat, call, alert)
  }
  return state
}

/** '1N-P-3N-P-P-P', from the dealer */
export const auctionText = (state: BoardState) => state.auction.map((c) => c.call).join('-')

/** '3N', '4SX' */
export const contractText = (c: Contract) => `${c.level}${c.strain}${c.doubled}`

/** The contract back from its text (declarer given separately) */
export function parseContract(text: string, declarer: Contract['declarer']): Contract {
  return { level: Number(text[0]), strain: text[1] as Contract['strain'], doubled: text.slice(2) as Contract['doubled'], declarer }
}
