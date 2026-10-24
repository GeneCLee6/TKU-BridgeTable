import type { Card, Seat } from '../cards.ts'
import type { BoardState } from '../game.ts'
import type { RobotKind } from '../protocol.ts'
import { acceptsClaim } from './claim.ts'
import { chooseCard } from './play.ts'
import { robotCall, type RobotBid } from './robots.ts'

/**
 * Everything `ClubService` asks a robot, so a stronger brain (DDS, simulations) can stand in for
 * the rule robot without touching the service (ARCHITECTURE.md §5.1). Each answer uses only what
 * the robot may see. The answers are synchronous for now; `e6-t11` makes them asynchronous, with
 * the rule robot as the fallback when a brain is late or fails.
 */
export interface RobotBrain {
  /** The robot's call, with its explanation */
  bid(kind: RobotKind, state: BoardState, seat: Seat): RobotBid
  /** The card the robot plays from `seat` (its own hand or, as declarer, dummy) */
  play(kind: RobotKind, state: BoardState, seat: Seat): Card
  /** Whether the robot at `seat` accepts the pending claim */
  acceptsClaim(kind: RobotKind, state: BoardState, seat: Seat): boolean
}

/** The rule robot (ROBOT.md): the system engine for the auction, `play.ts` and `claim.ts` for the play */
export const ruleBrain: RobotBrain = {
  bid: (kind, state, seat) => robotCall(kind, state.hands[seat], seat, state.auction, state.dealer, state.vul),
  play: (kind, state, seat) => chooseCard(state, seat, kind),
  acceptsClaim: (_kind, state, seat) => acceptsClaim(state, seat),
}
