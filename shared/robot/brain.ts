import type { Card, Seat } from '../cards.ts'
import type { BoardState } from '../game.ts'
import type { RobotKind } from '../protocol.ts'
import { acceptsClaim } from './claim.ts'
import { chooseCard } from './play.ts'
import { robotCall, type RobotBid } from './robots.ts'

/** An answer now, or later (a brain that thinks elsewhere, e6-t11) */
export type Answer<T> = T | Promise<T>

/**
 * Everything `ClubService` asks a robot, so a stronger brain (TKB Adv with DDS, ROBOT.md §7) can
 * stand in for the rule robot without touching the service (ARCHITECTURE.md §5.1). Each answer
 * uses only what the robot may see. An answer may come later (a `Promise`): the service waits
 * without holding up the club, drops an answer that arrives after the table moved on, and asks the
 * rule robot when a brain takes longer than the think limit or fails (`e6-t11`).
 */
export interface RobotBrain {
  /** The robot's call, with its explanation */
  bid(kind: RobotKind, state: BoardState, seat: Seat): Answer<RobotBid>
  /** The card the robot plays from `seat` (its own hand or, as declarer, dummy) */
  play(kind: RobotKind, state: BoardState, seat: Seat): Answer<Card>
  /** Whether the robot at `seat` accepts the pending claim */
  acceptsClaim(kind: RobotKind, state: BoardState, seat: Seat): Answer<boolean>
}

/** The rule robot, TKB (ROBOT.md): the system engine for the auction, `play.ts` and `claim.ts` for the play */
export const ruleBrain: RobotBrain = {
  bid: (kind, state, seat) => robotCall(kind, state.hands[seat], seat, state.auction, state.dealer, state.vul),
  play: (kind, state, seat) => chooseCard(state, seat, kind),
  acceptsClaim: (_kind, state, seat) => acceptsClaim(state, seat),
}
