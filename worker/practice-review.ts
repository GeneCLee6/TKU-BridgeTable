import { nextSeat, type Hands, type Seat } from '../shared/cards.ts'
import { makeCall, type BoardState } from '../shared/game.ts'
import type { PracticeReview, PracticeReviewStep, RobotKind } from '../shared/protocol.ts'
import type { RobotBrain } from '../shared/robot/brain.ts'

/**
 * 檢討 of a bidding practice (`e10-t07`, ARCHITECTURE.md §5.11): what TKB would have called at each
 * step of the auction, and how four TKB bid the board. Every question to the brain gives it only
 * the hand of the seat it bids for, and the auction up to that point (`askedState`), the same as
 * when a robot bids at the table (hard rule 6)
 */

/** The board as the robot at `seat` sees it before the `calls`th call: its own hand, nobody else's */
export function askedState(board: BoardState, seat: Seat, calls: number): BoardState {
  const hands: Hands = { N: [], E: [], S: [], W: [], [seat]: board.hands[seat] }
  return {
    boardNo: board.boardNo,
    dealer: board.dealer,
    vul: board.vul,
    hands,
    auction: board.auction.slice(0, calls),
    contract: null,
    play: [],
    phase: 'auction',
  }
}

/** For each call of the board's auction: TKB's call from that seat at that point */
export async function reviewSteps(brain: RobotBrain, kind: RobotKind, board: BoardState): Promise<PracticeReviewStep[]> {
  const steps: PracticeReviewStep[] = []
  for (let i = 0; i < board.auction.length; i++) {
    const seat = board.auction[i].seat
    const bid = await brain.bid(kind, askedState(board, seat, i), seat)
    steps.push({ call: bid.call, ...(bid.meaning && { meaning: bid.meaning }) })
  }
  return steps
}

/** The most calls an auction can have (35 bids, each doubled and redoubled, with passes): a guard only */
const MOST_CALLS = 320

/** Four TKB bid the board from the start, each seeing only its own hand */
export async function robotBidding(brain: RobotBrain, kind: RobotKind, board: BoardState): Promise<NonNullable<PracticeReview['robot']>> {
  let bidding: BoardState = { ...askedState(board, board.dealer, 0), hands: board.hands }
  while (bidding.phase === 'auction' && bidding.auction.length < MOST_CALLS) {
    const seat = nextSeat(bidding.dealer, bidding.auction.length)
    const bid = await brain.bid(kind, askedState(bidding, seat, bidding.auction.length), seat)
    let next: BoardState
    try {
      next = makeCall(bidding, seat, bid.call, bid.alert)
    } catch {
      // A call the rules do not allow (it should not happen): the robot passes, as at the table
      next = makeCall(bidding, seat, 'P')
    }
    const made = { ...next.auction.at(-1)!, robot: true, ...(next.auction.at(-1)!.call === bid.call && bid.meaning && { meaning: bid.meaning }) }
    bidding = { ...next, auction: [...next.auction.slice(0, -1), made] }
  }
  return { auction: bidding.auction, contract: bidding.contract }
}
