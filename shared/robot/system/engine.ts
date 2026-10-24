import { seatToCall, type AuctionCall, type Call } from '../../auction.ts'
import type { Vulnerability } from '../../board.ts'
import type { Card, Seat } from '../../cards.ts'
import { evaluate, fits } from './evaluate.ts'
import { contextFor } from './infer.ts'
import { callOf, meanings, resolve, rulesFor } from './rules.ts'
import type { Spec, System } from './spec.ts'

/**
 * Runs a system (`spec.ts`): a robot's call is the first rule for the auction whose requirements
 * its hand meets, as GIB picks its "book bid"; an explanation is what the rules for a call show.
 */

export interface Choice {
  call: Call
  /** What the call shows, from the rule that chose it */
  shows?: Spec
}

/** Each rule for the auction that the hand fits, in the order the engine considers them */
function* fitting(
  system: System,
  cards: readonly Card[],
  seat: Seat,
  auction: readonly AuctionCall[],
  dealer: Seat,
  vul: Vulnerability,
): Generator<{ choice: Choice; legal: boolean }> {
  const ctx = contextFor(system, seat, auction, dealer, vul)
  const hand = evaluate(cards)
  for (const rule of rulesFor(system, ctx)) {
    const call = system.firstFit ? (resolve(rule.call, ctx) ?? null) : callOf(rule, ctx)
    if (!call) continue
    const needs = resolve(rule.needs ?? rule.shows, ctx)
    if (needs && !fits(hand, needs)) continue
    if (rule.when && !rule.when(hand, ctx)) continue
    const legal = ctx.legal.has(call)
    const shows = legal ? resolve(rule.shows, ctx) : undefined
    yield { choice: shows ? { call, shows } : { call }, legal }
  }
}

/** A robot's call: the first rule for the auction that the hand fits; pass when none does */
export function choose(
  system: System,
  cards: readonly Card[],
  seat: Seat,
  auction: readonly AuctionCall[],
  dealer: Seat,
  vul: Vulnerability = 'None',
): Choice {
  // A first-fit system passes when the rule that fits names a call that is not legal here
  for (const { choice, legal } of fitting(system, cards, seat, auction, dealer, vul)) return legal ? choice : { call: 'P' }
  // Pass is not allowed and nothing fits: the system's emergency call, explained as any rule for it
  const ctx = contextFor(system, seat, auction, dealer, vul)
  const hand = evaluate(cards)
  const call = ctx.forced && system.emergency?.(hand, ctx)
  if (call && ctx.legal.has(call)) {
    const shows = meanings(system, ctx).get(call)
    return shows ? { call, shows } : { call }
  }
  return { call: 'P' }
}

/** What each legal call would show for the seat whose turn it is (the bidding box hints) */
export function explain(system: System, auction: readonly AuctionCall[], dealer: Seat, vul: Vulnerability = 'None'): Map<Call, Spec> {
  const seat = seatToCall(dealer, auction.length)
  return meanings(system, contextFor(system, seat, auction, dealer, vul))
}
