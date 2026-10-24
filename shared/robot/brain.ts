import type { Card, Seat } from '../cards.ts'
import type { BoardState } from '../game.ts'
import type { RobotKind, RobotLevel } from '../protocol.ts'
import { acceptsClaim } from './claim.ts'
import { paramsOf } from './levels.ts'
import { actionNumber, errs, mistakenCard } from './mistakes.ts'
import { chooseCard } from './play.ts'
import { robotCall, type RobotBid } from './robots.ts'

/** An answer now, or later (a brain that thinks elsewhere, e6-t11) */
export type Answer<T> = T | Promise<T>

/**
 * Everything `ClubService` asks a robot, so a stronger brain (DDS, simulations) can stand in for
 * the rule robot without touching the service (ARCHITECTURE.md §5.1). Each answer uses only what
 * the robot may see. An answer may come later (a `Promise`): the service waits without holding up
 * the club, drops an answer that arrives after the table moved on, and asks the rule robot when a
 * brain takes longer than the think limit or fails (`e6-t11`). `level` is the robot's level
 * (ROBOT.md §7), 大專 when not given. `seed` is the key for the level's deliberate mistakes
 * (`mistakes.ts`); without it the robot never errs on purpose.
 */
export interface RobotBrain {
  /** The robot's call, with its explanation */
  bid(kind: RobotKind, state: BoardState, seat: Seat, level?: RobotLevel, seed?: string): Answer<RobotBid>
  /** The card the robot plays from `seat` (its own hand or, as declarer, dummy) */
  play(kind: RobotKind, state: BoardState, seat: Seat, level?: RobotLevel, seed?: string): Answer<Card>
  /** Whether the robot at `seat` accepts the pending claim */
  acceptsClaim(kind: RobotKind, state: BoardState, seat: Seat, level?: RobotLevel): Answer<boolean>
}

/** Whether the robot errs on purpose at this action (its level's `errorRate`, e6-t21) */
const erring = (state: BoardState, level: RobotLevel | undefined, seed: string | undefined) =>
  errs(paramsOf(level).errorRate, seed, actionNumber(state))

/** The rule robot (ROBOT.md): the system engine for the auction, `play.ts` and `claim.ts` for the play */
export const ruleBrain: RobotBrain = {
  bid: (kind, state, seat, level, seed) =>
    robotCall(kind, state.hands[seat], seat, state.auction, state.dealer, state.vul, level, erring(state, level, seed)),
  play: (kind, state, seat, level, seed) => {
    const card = chooseCard(state, seat, kind, paramsOf(level))
    return (erring(state, level, seed) && mistakenCard(state, seat, card)) || card
  },
  acceptsClaim: (_kind, state, seat) => acceptsClaim(state, seat),
}
