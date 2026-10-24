import { isBid, seatToCall, type AuctionCall, type Call } from '../../auction.ts'
import type { Vulnerability } from '../../board.ts'
import type { Card, Seat } from '../../cards.ts'
import { usesRule, type SystemDepth } from '../levels.ts'
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
  depth: SystemDepth,
): Generator<{ choice: Choice; legal: boolean }> {
  const ctx = contextFor(system, seat, auction, dealer, vul)
  const hand = evaluate(cards)
  for (const rule of rulesFor(system, ctx)) {
    if (!usesRule(depth, rule.minLevel)) continue
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

/**
 * A robot's call: the first rule for the auction that the hand fits; pass when none does. A robot
 * bidding at `depth` leaves out the rules marked for a higher level (`minLevel`)
 */
export function choose(
  system: System,
  cards: readonly Card[],
  seat: Seat,
  auction: readonly AuctionCall[],
  dealer: Seat,
  vul: Vulnerability = 'None',
  depth: SystemDepth = 'master',
): Choice {
  // A first-fit system passes when the rule that fits names a call that is not legal here
  for (const { choice, legal } of fitting(system, cards, seat, auction, dealer, vul, depth)) return legal ? choice : { call: 'P' }
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

/**
 * The robot's second choice, for a deliberate mistake (e6-t21): the next rule that fits after the
 * one `choose` takes, when it names a different legal bid. Only a bid replaces a bid: a robot
 * never passes, doubles or redoubles by mistake, nor bids when it means to pass or double, so a
 * mistake misjudges the level or the strain rather than throwing a game away. Null when there is none.
 */
export function alternative(
  system: System,
  cards: readonly Card[],
  seat: Seat,
  auction: readonly AuctionCall[],
  dealer: Seat,
  vul: Vulnerability = 'None',
  depth: SystemDepth = 'master',
): Choice | null {
  let best: Call | undefined
  for (const { choice, legal } of fitting(system, cards, seat, auction, dealer, vul, depth)) {
    if (best === undefined) {
      if (!legal || !isBid(choice.call)) return null
      best = choice.call
    } else if (legal && isBid(choice.call) && choice.call !== best) return choice
  }
  return null
}

/** What each legal call would show for the seat whose turn it is (the bidding box hints) */
export function explain(system: System, auction: readonly AuctionCall[], dealer: Seat, vul: Vulnerability = 'None'): Map<Call, Spec> {
  const seat = seatToCall(dealer, auction.length)
  return meanings(system, contextFor(system, seat, auction, dealer, vul))
}
