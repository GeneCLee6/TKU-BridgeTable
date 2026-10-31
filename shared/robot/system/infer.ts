import type { AuctionCall } from '../../auction.ts'
import type { Vulnerability } from '../../board.ts'
import { partnerOf, type Seat } from '../../cards.ts'
import { intersect } from './combine.ts'
import { contextOf, emptyReading, type Ctx, type Reading } from './context.ts'
import { meanings } from './rules.ts'
import type { System } from './spec.ts'

/**
 * Reading the auction: what each player has shown so far, call by call, with the same rules the
 * robots bid with. A player's calls are put together with `intersect` (`combine.ts`), so each
 * feature takes the narrowest range shown (GIB: "combined by taking the maximum of each feature").
 * Each call's meaning (`meanings`) is already narrowed to what its player showed before (Y2), so
 * what a seat said last and what it has shown in all never disagree.
 */

export { intersect }

/** Reads every call so far: what each seat has shown, how far its last call forces, game forces */
export function read(system: System, auction: readonly AuctionCall[], dealer: Seat, vul: Vulnerability): Reading {
  const reading = emptyReading()
  for (let i = 0; i < auction.length; i++) {
    const { seat, call } = auction[i]
    const ctx = contextOf(seat, auction.slice(0, i), dealer, vul, reading)
    const spec = meanings(system, ctx).get(call)
    reading.forcing[seat] = spec?.forcing
    reading.said[seat] = spec
    if (!spec) continue
    reading.shown[seat] = intersect(reading.shown[seat], spec)
    if (spec.forcing === 'game') reading.gameForce[seat] = reading.gameForce[partnerOf(seat)] = true
  }
  return reading
}

/** The auction from a seat's point of view, with what everyone has shown */
export function contextFor(system: System, seat: Seat, auction: readonly AuctionCall[], dealer: Seat, vul: Vulnerability): Ctx {
  return contextOf(seat, auction, dealer, vul, auction.length ? read(system, auction, dealer, vul) : emptyReading())
}
