import type { Call } from './auction.ts'
import { deal, dealerOf, secureRandomInt, vulnerabilityOf, type RandomInt, type Vulnerability } from './board.ts'
import { hcp, nextSeat, SEATS, sideOf, type Hands, type Seat } from './cards.ts'
import type { DealSet, DealSetBoard } from './deal-set.ts'
import { makeCall, newBoard, type BoardState } from './game.ts'
import type { RobotKind } from './protocol.ts'
import { robotCall } from './robot/robots.ts'

/**
 * How a challenge's boards are dealt (ARCHITECTURE.md §5.5, C8): Best Hand (`e7-t10`), Just
 * Declare (`e7-t11`) and boards from the history turned so their player sits South (`e7-t22`).
 * Everything is decided once, when the challenge is created, and kept in its deal set, so every
 * participant gets exactly the same boards. Pure functions; the robot is TKB, which has no
 * randomness, so the same deal always gets the same auction.
 */

/** The hands turned round the table: the hand at `from` goes to `to`, the others keep their places around it */
export function rotateHands(hands: Hands, from: Seat, to: Seat): Hands {
  const steps = (SEATS.indexOf(to) - SEATS.indexOf(from) + 4) % 4
  const turned = {} as Hands
  for (const seat of SEATS) turned[nextSeat(seat, steps)] = [...hands[seat]]
  return turned
}

/** Ties for the most points go to the first of these: South keeps it, then partner, then West, then East */
export const BEST_HAND_ORDER: readonly Seat[] = ['S', 'N', 'W', 'E']

/** The seat with the most high-card points; ties by `BEST_HAND_ORDER` */
export function bestHandSeat(hands: Hands): Seat {
  let best: Seat = BEST_HAND_ORDER[0]
  for (const seat of BEST_HAND_ORDER) if (hcp(hands[seat]) > hcp(hands[best])) best = seat
  return best
}

/** Best Hand (`e7-t10`): the deal turned so South holds the hand with the most points */
export const bestHand = (hands: Hands): Hands => rotateHands(hands, bestHandSeat(hands), 'S')

/**
 * Four TKB robots of one system bid the board. With `calls` (an auction kept in the deal set) the
 * robots' calls are those, in order; each keeps the robot's explanation when the robot still makes
 * that call today. Returns the board after the auction: `play` with a contract, or `finished` when
 * it was passed out
 */
export function robotAuction(kind: RobotKind, boardNo: number, hands: Hands, calls?: readonly Call[]): BoardState {
  let board = newBoard(boardNo, hands)
  for (let i = 0; board.phase === 'auction'; i++) {
    const seat = nextSeat(board.dealer, board.auction.length)
    const bid = robotCall(kind, hands[seat], seat, board.auction, board.dealer, board.vul)
    const call = calls ? calls[i] : bid.call
    if (call === undefined) throw new Error('the kept auction ends too soon')
    const same = call === bid.call
    board = makeCall(board, seat, call, same ? bid.alert : undefined)
    const made = { ...board.auction.at(-1)!, robot: true, ...(same && bid.meaning ? { meaning: bid.meaning } : {}) }
    board = { ...board, auction: [...board.auction.slice(0, -1), made] }
  }
  return board
}

/** Whether North-South (the participant's side) declares the board */
export const northSouthDeclares = (board: BoardState) =>
  board.phase === 'play' && !!board.contract && sideOf(board.contract.declarer) === 'NS'

/** Random deals tried for one Just Declare board before giving up (each has about even odds) */
export const JUST_DECLARE_TRIES = 60

/**
 * A challenge's random boards, numbered 1…count (`e7-t02`), each turned for Best Hand and, for
 * Just Declare, dealt again until the robots' auction leaves North-South declaring; that auction
 * is kept with the board, so the participant takes over after it. Null if it could not be done
 */
export function challengeDeals(
  spec: { count: number; bestHand: boolean; justDeclare: boolean; robotKind: RobotKind },
  random: RandomInt = secureRandomInt,
): DealSet | null {
  const boards: DealSetBoard[] = []
  for (let boardNo = 1; boardNo <= spec.count; boardNo++) {
    let kept: DealSetBoard | null = null
    for (let tries = 0; !kept && tries < (spec.justDeclare ? JUST_DECLARE_TRIES : 1); tries++) {
      const dealt = deal(random)
      const hands = spec.bestHand ? bestHand(dealt) : dealt
      if (!spec.justDeclare) {
        kept = { boardNo, hands }
        break
      }
      const board = robotAuction(spec.robotKind, boardNo, hands)
      if (northSouthDeclares(board)) kept = { boardNo, hands, auction: board.auction.map((c) => c.call) }
    }
    if (!kept) return null
    boards.push(kept)
  }
  return { boards }
}

/** The board number (1–16) with this dealer and vulnerability: each pair comes once in the cycle */
export function boardNoFor(dealer: Seat, vul: Vulnerability): number {
  for (let boardNo = 1; boardNo <= 16; boardNo++)
    if (dealerOf(boardNo) === dealer && vulnerabilityOf(boardNo) === vul) return boardNo
  throw new Error('no such board number')
}

const turnVul = (vul: Vulnerability, steps: number): Vulnerability =>
  steps % 2 === 0 || vul === 'None' || vul === 'Both' ? vul : vul === 'NS' ? 'EW' : 'NS'

/**
 * A board from the history turned so the seat its player bid from becomes South (「用這副牌挑戰」,
 * `e7-t22`). The dealer and vulnerability turn with the hands, so the board stays the same for
 * that player; its number is the one of the cycle with the turned dealer and vulnerability (the
 * same number when they sat South). `scoreNS` is their result from their side
 */
export function boardAsSouth(
  board: { boardNo: number; hands: Hands; scoreNS: number },
  seat: Seat,
): DealSetBoard & { scoreNS: number } {
  if (seat === 'S') return { boardNo: board.boardNo, hands: rotateHands(board.hands, 'S', 'S'), scoreNS: board.scoreNS }
  const steps = (SEATS.indexOf('S') - SEATS.indexOf(seat) + 4) % 4
  const dealer = nextSeat(dealerOf(board.boardNo), steps)
  const vul = turnVul(vulnerabilityOf(board.boardNo), steps)
  return {
    boardNo: boardNoFor(dealer, vul),
    hands: rotateHands(board.hands, seat, 'S'),
    // A passed-out board stays 0, not -0
    scoreNS: sideOf(seat) === 'NS' ? board.scoreNS : -board.scoreNS || 0,
  }
}
