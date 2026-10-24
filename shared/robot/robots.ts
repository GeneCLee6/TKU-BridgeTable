import type { AuctionCall, Call } from '../auction.ts'
import type { Vulnerability } from '../board.ts'
import type { Card, Seat } from '../cards.ts'
import type { RobotKind } from '../protocol.ts'
import { chooseCall } from './bidding.ts'
import { describe } from './system/describe.ts'
import { choose } from './system/engine.ts'
import { GIB } from './system/gib/index.ts'
import type { Spec, System } from './system/spec.ts'

/**
 * The robots a host can seat (ROBOT.md): the club's robot bids the club's system with
 * `bidding.ts`; the 2/1 robot bids GIB's 2/1 with the system engine
 */

export interface RobotBid {
  call: Call
  /** The explanation in Traditional Chinese (kept with the auction, LIN files and the history) */
  alert?: string
  /** What the call shows, for the explanation in each viewer's language (engine systems only) */
  meaning?: Spec
}

/** The engine system each robot bids with; the club's robot still has its own rules */
export const ROBOT_SYSTEMS: Partial<Record<RobotKind, System>> = { gib: GIB }

export function robotCall(
  kind: RobotKind,
  hand: readonly Card[],
  seat: Seat,
  auction: AuctionCall[],
  dealer: Seat,
  vul: Vulnerability,
): RobotBid {
  const system = ROBOT_SYSTEMS[kind]
  if (!system) return chooseCall(hand, seat, auction, dealer, vul)
  const { call, shows } = choose(system, hand, seat, auction, dealer, vul)
  // Like the club's robot (and GIB), every call but pass is alerted with its explanation
  if (call === 'P') return { call }
  return shows ? { call, alert: describe(shows, 'zh'), meaning: shows } : { call, alert: '' }
}
