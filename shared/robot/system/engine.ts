import { seatToCall, type AuctionCall, type Call } from '../../auction.ts'
import type { Vulnerability } from '../../board.ts'
import type { Card, Seat } from '../../cards.ts'
import { narrow } from './combine.ts'
import type { Ctx } from './context.ts'
import { evaluate, fits, type Hand } from './evaluate.ts'
import { contextFor } from './infer.ts'
import { callOf, meanings, resolve, rulesFor, shownBefore } from './rules.ts'
import type { Spec, System } from './spec.ts'

/**
 * Runs a system (`spec.ts`): a robot's call is the first rule for the auction whose requirements
 * its hand meets, as GIB picks its "book bid"; an explanation is what the rules for a call show.
 */

export interface Choice {
  call: Call
  /**
   * What the call shows, from the rule that chose it, as the robot alerts it: with everything else
   * it had already shown (`narrow`'s `before`, Z1)
   */
  shows?: Spec
}

/** Each rule for the auction that the hand fits, in the order the engine considers them */
function* fitting(system: System, hand: Hand, ctx: Ctx): Generator<{ choice: Choice; legal: boolean }> {
  for (const rule of rulesFor(system, ctx)) {
    const call = system.firstFit ? (resolve(rule.call, ctx) ?? null) : callOf(rule, ctx)
    if (!call) continue
    const needs = resolve(rule.needs ?? rule.shows, ctx)
    if (needs && !fits(hand, needs)) continue
    if (rule.when && !rule.when(hand, ctx)) continue
    const legal = ctx.legal.has(call)
    // The rule's meaning as the robot alerts it: narrowed to what it has shown, like `meanings`
    const spec = legal ? resolve(rule.shows, ctx) : undefined
    const shows = spec && narrow(spec, ctx.shown.me)
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
  const ctx = contextFor(system, seat, auction, dealer, vul)
  const hand = evaluate(cards)
  // A first-fit system passes when the rule that fits names a call that is not legal here
  for (const { choice, legal } of fitting(system, hand, ctx)) return legal ? explained(revised(system, hand, ctx, choice), ctx) : { call: 'P' }
  // Pass is not allowed and nothing fits: the system's emergency call, explained as any rule for it
  const call = ctx.forced && system.emergency?.(hand, ctx)
  if (call && ctx.legal.has(call)) {
    const shows = meanings(system, ctx, true).get(call)
    return shows ? { call, shows } : { call }
  }
  return { call: 'P' }
}

/**
 * The robot's choice as it alerts it: with everything else it had shown (`narrow`'s `full`, Z1).
 * Only after the choice is made, so the rules and `revise` see the meaning as before
 */
function explained(choice: Choice, ctx: Ctx): Choice {
  return choice.shows ? { call: choice.call, shows: narrow(choice.shows, shownBefore(ctx), true) } : choice
}

/** The system's second look at a chosen call (`System.revise`), kept only when the rules explain it */
function revised(system: System, hand: Hand, ctx: Ctx, choice: Choice): Choice {
  if (!system.revise) return choice
  let known: Map<Call, Spec> | undefined
  const explain = (c: Call) => (known ??= meanings(system, ctx)).get(c)
  const call = system.revise(hand, ctx, choice.call, choice.shows, explain)
  if (!call || call === choice.call || !ctx.legal.has(call)) return choice
  const shows = explain(call)
  return shows ? { call, shows } : choice
}

/**
 * What each legal call would show for the seat whose turn it is (the bidding box hints): with
 * everything else the seat has shown (`full`, Z1), unless `full` is false (the call's own meaning,
 * narrowed as partner reads it)
 */
export function explain(system: System, auction: readonly AuctionCall[], dealer: Seat, vul: Vulnerability = 'None', full = true): Map<Call, Spec> {
  const seat = seatToCall(dealer, auction.length)
  return meanings(system, contextFor(system, seat, auction, dealer, vul), full)
}
