import type { AuctionCall, Call } from '../auction.ts'
import type { Vulnerability } from '../board.ts'
import type { Card, Seat } from '../cards.ts'
import type { RobotKind, RobotLevel } from '../protocol.ts'
import { paramsOf } from './levels.ts'
import { describe } from './system/describe.ts'
import { choose } from './system/engine.ts'
import { GIB } from './system/gib/index.ts'
import { TKU } from './system/tku/index.ts'
import type { Spec, System } from './system/spec.ts'

/**
 * The robots a host can seat (ROBOT.md): the club's robot bids the club's system, the 2/1 robot
 * GIB's 2/1; both with the system engine (`system/`)
 */

export interface RobotBid {
  call: Call
  /** The explanation in Traditional Chinese (kept with the auction, LIN files and the history) */
  alert?: string
  /** What the call shows, for the explanation in each viewer's language */
  meaning?: Spec
}

/** The system each robot bids with */
export const ROBOT_SYSTEMS: Record<RobotKind, System> = { tku: TKU, gib: GIB }

export function robotCall(
  kind: RobotKind,
  hand: readonly Card[],
  seat: Seat,
  auction: AuctionCall[],
  dealer: Seat,
  vul: Vulnerability,
  level: RobotLevel = 'college',
): RobotBid {
  const { call, shows } = choose(ROBOT_SYSTEMS[kind], hand, seat, auction, dealer, vul, paramsOf(level).system)
  // Like GIB, every call but pass is alerted with its explanation
  if (call === 'P') return { call }
  return shows ? { call, alert: describe(shows, 'zh'), meaning: shows } : { call, alert: '' }
}
