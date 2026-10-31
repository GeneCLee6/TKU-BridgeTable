import type { AuctionCall, Call } from '../auction.ts'
import type { Vulnerability } from '../board.ts'
import type { Card, Seat } from '../cards.ts'
import type { RobotKind } from '../protocol.ts'
import { describe } from './system/describe.ts'
import { choose } from './system/engine.ts'
import { contextFor } from './system/infer.ts'
import { meanings } from './system/rules.ts'
import { GIB } from './system/gib/index.ts'
import { TKU } from './system/tku/index.ts'
import type { Spec, System } from './system/spec.ts'

/**
 * The robot a host can seat, TKB (ROBOT.md), in either system: the club's system or GIB's 2/1;
 * both with the system engine (`system/`)
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
): RobotBid {
  const { call, shows } = choose(ROBOT_SYSTEMS[kind], hand, seat, auction, dealer, vul)
  // Like GIB, every call but pass is alerted with its explanation
  if (call === 'P') return { call }
  return shows ? { call, alert: describe(shows, 'zh'), meaning: shows } : { call, alert: '' }
}

/**
 * What the engine reads a person's call as (e5-t22, AC-5.7): the meaning the system's rules give
 * that call in that auction, as the robots read it (`infer.ts`). `auction` ends with the call.
 * Nothing when no rule makes the call or it shows nothing.
 */
export function inferredMeaning(kind: RobotKind, auction: readonly AuctionCall[], dealer: Seat, vul: Vulnerability): Spec | undefined {
  const made = auction.at(-1)
  if (!made) return undefined
  const system = ROBOT_SYSTEMS[kind]
  const spec = meanings(system, contextFor(system, made.seat, auction.slice(0, -1), dealer, vul), true).get(made.call)
  return spec && Object.keys(spec).length ? spec : undefined
}
