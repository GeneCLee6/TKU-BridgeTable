import type { AuctionCall } from '../../auction.ts'
import type { Vulnerability } from '../../board.ts'
import { partnerOf, SUITS, type Seat, type Suit } from '../../cards.ts'
import { contextOf, emptyReading, type Ctx, type Reading } from './context.ts'
import { meanings } from './rules.ts'
import { QUALITIES, STOPS, type Range, type Spec, type System } from './spec.ts'

/**
 * Reading the auction: what each player has shown so far, call by call, with the same rules the
 * robots bid with. A player's calls are put together with `intersect`, so each feature takes the
 * narrowest range shown (GIB: "combined by taking the maximum of each feature").
 */

/** Narrowest of two ranges; when they do not overlap the newer one wins (the player changed their mind) */
function narrowest(known: Range | undefined, shown: Range | undefined): Range | undefined {
  if (!known) return shown
  if (!shown) return known
  const range: Range = [Math.max(known[0], shown[0]), Math.min(known[1], shown[1])]
  return range[0] <= range[1] ? range : shown
}

const strongest = <T extends string>(ladder: readonly T[], a: T | undefined, b: T | undefined) =>
  a && b ? (ladder.indexOf(a) >= ladder.indexOf(b) ? a : b) : (a ?? b)

/** Everything `known` and `shown` say about a hand together (hand features only, no names or notes) */
export function intersect(known: Spec, shown: Spec): Spec {
  const out: Spec = {}
  const hcp = narrowest(known.hcp, shown.hcp)
  const tp = narrowest(known.tp, shown.tp)
  const controls = narrowest(known.controls, shown.controls)
  if (hcp) out.hcp = hcp
  if (tp) out.tp = tp
  if (controls) out.controls = controls
  const len: Partial<Record<Suit, Range>> = {}
  const quality: Spec['quality'] = {}
  const stop: Spec['stop'] = {}
  for (const s of SUITS) {
    const l = narrowest(known.len?.[s], shown.len?.[s])
    const q = strongest(QUALITIES, known.quality?.[s], shown.quality?.[s])
    const st = strongest(STOPS, known.stop?.[s], shown.stop?.[s])
    if (l) len[s] = l
    if (q) quality[s] = q
    if (st) stop[s] = st
  }
  if (Object.keys(len).length) out.len = len
  if (Object.keys(quality).length) out.quality = quality
  if (Object.keys(stop).length) out.stop = stop
  const balanced = shown.balanced ?? known.balanced
  if (balanced !== undefined) out.balanced = balanced
  return out
}

/** Reads every call so far: what each seat has shown, how far its last call forces, game forces */
export function read(system: System, auction: readonly AuctionCall[], dealer: Seat, vul: Vulnerability): Reading {
  const reading = emptyReading()
  for (let i = 0; i < auction.length; i++) {
    const { seat, call } = auction[i]
    const ctx = contextOf(seat, auction.slice(0, i), dealer, vul, reading)
    const spec = meanings(system, ctx).get(call)
    reading.forcing[seat] = spec?.forcing
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
