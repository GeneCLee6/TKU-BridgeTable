import { isBid, levelOf, type Call } from '../../../auction.ts'
import { SUITS, type Strain, type Suit } from '../../../cards.ts'
import { callsOf, cheapest, lastOf, type Ctx } from '../context.ts'
import type { Hand } from '../evaluate.ts'
import { goalFor } from '../gib/fallback.ts'
import { trumpOf } from '../gib/slam.ts'
import { bid, UP } from '../gib/util.ts'
import type { Book, Rule, Spec } from '../spec.ts'

/**
 * Slam bidding, docs/systems/sayc.md §10: plain Blackwood (aces, not keycards), 5NT for kings with
 * all the aces, a jump to 5NT as the grand slam force, and Gerber over notrump. Any bid or double by
 * an opponent cancels these (the booklet's rule for conventions made for silent auctions), so the
 * answers are only for when the right-hand opponent passed.
 */

const countAces = (h: Hand) => SUITS.filter((s) => h.ranks[s].includes('A')).length
const countKings = (h: Hand) => SUITS.filter((s) => h.ranks[s].includes('K')).length

const weBid = (ctx: Ctx) => ctx.turns.some((t) => t.ours && t.call !== 'P')
const asked = (ctx: Ctx) => [...callsOf(ctx, 'me'), ...callsOf(ctx, 'partner')].some((c) => c === '4N' || c === '5N')
const rhoPassed = (ctx: Ctx) => ctx.turns.at(-1)?.call === 'P'
const partnerSaid = (name: Spec['name']) => (ctx: Ctx) => ctx.said.partner?.name === name
const iSaid = (name: Spec['name']) => (ctx: Ctx) => ctx.said.me?.name === name
const answered = (spec: Spec | undefined, key: 'aces' | 'kings') => spec?.notes?.some((n) => n.key === key) ?? false

/** The count partner's answer stands for: 0 or 4 is worked out from what this hand holds */
const partnerCount = (ctx: Ctx, key: 'aces' | 'kings', mine: number) => {
  const counts = ctx.said.partner?.notes?.find((n) => n.key === key)?.counts ?? [0]
  return counts.length > 1 ? (mine === 0 ? 4 : 0) : counts[0]
}

/** The answers by steps; `calls` starts at the step for 0 or 4 */
const steps = (calls: readonly Call[], key: 'aces' | 'kings', count: (h: Hand) => number): Rule[] =>
  ([[0, 4], [1], [2], [3]] as const).map((counts, i) => ({
    call: calls[i],
    shows: { notes: [{ key, counts }], artificial: true },
    needs: {},
    when: (h) => (counts as readonly number[]).includes(count(h)),
  }))

const topHonours = (h: Hand, s: Suit) => [...'AKQ'].filter((r) => h.ranks[s].includes(r)).length

// ── Asking ───────────────────────────────────────────────────────────────────────────────────

const wants = (h: Hand, ctx: Ctx, kinds: readonly string[]) => {
  const goal = goalFor(h, ctx)
  return !!goal && kinds.includes(goal.kind) && goal.strain === trumpOf(ctx)
}

const askBlackwood: Book = {
  general: true,
  only: (ctx) => weBid(ctx) && !!trumpOf(ctx) && !asked(ctx),
  rules: [
    {
      call: '5N',
      shows: (ctx) => ({ name: 'grandSlamForce', trump: trumpOf(ctx)!, artificial: true, forcing: 'oneRound' }),
      when: (h, ctx) => wants(h, ctx, ['grand']) && countAces(h) >= 3 && topHonours(h, trumpOf(ctx)!) < 3,
    },
    {
      call: '4N',
      shows: (ctx) => ({ name: 'blackwood', trump: trumpOf(ctx)!, notes: [{ key: 'slamInterest' }], artificial: true, forcing: 'oneRound' }),
      when: (h, ctx) => wants(h, ctx, ['slam', 'grand']),
    },
  ],
  more: true,
}

// ── After the answers ────────────────────────────────────────────────────────────────────────

/** The asker of Blackwood: 5NT for kings with all the aces and a grand in view; six with one ace missing; else stop */
function afterAces(): Rule[] {
  const trump = (ctx: Ctx) => ctx.said.me!.trump!
  const total = (h: Hand, ctx: Ctx) => countAces(h) + partnerCount(ctx, 'aces', countAces(h))
  return [
    {
      call: '5N',
      shows: (ctx) => ({ name: 'kingAsk', trump: trump(ctx), artificial: true, forcing: 'oneRound' }),
      needs: {},
      when: (h, ctx) => total(h, ctx) === 4 && goalFor(h, ctx)?.kind === 'grand',
    },
    { call: (ctx) => bid(6, trump(ctx)), shows: { notes: [{ key: 'smallSlam' }] }, when: (h, ctx) => total(h, ctx) >= 3 },
    {
      call: (ctx) => {
        const call = cheapest(ctx, trump(ctx))
        return call && levelOf(call) <= 5 ? call : null
      },
      shows: { notes: [{ key: 'signoff' }] },
    },
    { call: 'P', shows: { notes: [{ key: 'signoff' }] } },
  ]
}

/** The asker after the kings: the slam the count allows */
function afterKings(): Rule[] {
  const known = (h: Hand, ctx: Ctx) => countKings(h) + partnerCount(ctx, 'kings', countKings(h))
  const trump = (ctx: Ctx) => ctx.said.me?.trump
  const strains = (ctx: Ctx): Strain => trump(ctx) ?? 'N'
  return [
    { call: (ctx) => bid(7, strains(ctx)), shows: { notes: [{ key: 'grandSlam' }] }, when: (h, ctx) => known(h, ctx) === 4 && goalFor(h, ctx)?.kind === 'grand' },
    { call: (ctx) => (ctx.legal.has(bid(6, strains(ctx))) ? bid(6, strains(ctx)) : '6N'), shows: { notes: [{ key: 'smallSlam' }] } },
    { call: 'P', shows: { notes: [{ key: 'smallSlam' }] } },
  ]
}

/** The grand slam force: seven with two of the ace, king and queen of the agreed suit */
function grandSlamAnswers(): Rule[] {
  const trump = (ctx: Ctx) => ctx.said.partner!.trump!
  return [
    { call: (ctx) => bid(7, trump(ctx)), shows: { notes: [{ key: 'grandSlam' }] }, needs: {}, when: (h, ctx) => topHonours(h, trump(ctx)) >= 2 },
    { call: (ctx) => bid(6, trump(ctx)), shows: { notes: [{ key: 'smallSlam' }] }, needs: {} },
  ]
}

// ── Gerber ───────────────────────────────────────────────────────────────────────────────────

/** The Gerber asker: 5♣ asks for kings with all the aces; any other bid is to play, 4NT too */
function afterGerber(): Rule[] {
  const total = (h: Hand, ctx: Ctx) => countAces(h) + partnerCount(ctx, 'aces', countAces(h))
  const best = (h: Hand) => UP.find((s) => h.len[s] >= 6) ?? null
  const rules: Rule[] = [
    { call: '5C', shows: { name: 'kingAsk', artificial: true, forcing: 'oneRound' }, needs: {}, when: (h, ctx) => total(h, ctx) === 4 && goalFor(h, ctx)?.kind === 'grand' },
  ]
  for (const s of UP)
    rules.push({
      call: bid(6, s),
      shows: { len: { [s]: [6, 13] }, notes: [{ key: 'smallSlam' }] },
      when: (h, ctx) => best(h) === s && total(h, ctx) >= 3,
    })
  rules.push({ call: '6N', shows: { notes: [{ key: 'smallSlam' }] }, when: (h, ctx) => total(h, ctx) >= 3 })
  for (const s of UP)
    rules.push({
      call: (ctx) => {
        const call = cheapest(ctx, s)
        return call && levelOf(call) <= 5 && !(s === 'C' && call === '5C') ? call : null
      },
      shows: { len: { [s]: [6, 13] }, notes: [{ key: 'toPlay' }] },
      when: (h) => best(h) === s,
    })
  rules.push({ call: (ctx) => cheapest(ctx, 'N'), shows: { notes: [{ key: 'toPlay' }] } })
  return rules
}

// ── The books ────────────────────────────────────────────────────────────────────────────────

const kingAskOf = (ctx: Ctx) => partnerSaid('kingAsk')(ctx) && rhoPassed(ctx)

/** Answers to the slam conventions and the asker's next call: tried first, whatever the auction */
export const slamAnswers: readonly Book[] = [
  { only: (ctx) => partnerSaid('blackwood')(ctx) && rhoPassed(ctx), rules: steps(['5C', '5D', '5H', '5S'], 'aces', countAces) },
  { only: (ctx) => partnerSaid('gerber')(ctx) && rhoPassed(ctx), rules: steps(['4D', '4H', '4S', '4N'], 'aces', countAces) },
  { only: (ctx) => kingAskOf(ctx) && lastOf(ctx, 'partner') === '5N', rules: steps(['6C', '6D', '6H', '6S'], 'kings', countKings) },
  { only: (ctx) => kingAskOf(ctx) && lastOf(ctx, 'partner') === '5C', rules: steps(['5D', '5H', '5S', '5N'], 'kings', countKings) },
  { only: (ctx) => partnerSaid('grandSlamForce')(ctx) && rhoPassed(ctx), rules: grandSlamAnswers() },
  { only: (ctx) => iSaid('blackwood')(ctx) && answered(ctx.said.partner, 'aces') && rhoPassed(ctx), rules: afterAces() },
  { only: (ctx) => iSaid('gerber')(ctx) && answered(ctx.said.partner, 'aces') && rhoPassed(ctx), rules: afterGerber() },
  { only: (ctx) => iSaid('kingAsk')(ctx) && answered(ctx.said.partner, 'kings') && rhoPassed(ctx), rules: afterKings() },
  // Having answered, the decision is the asker's
  { only: (ctx) => (answered(ctx.said.me, 'aces') || answered(ctx.said.me, 'kings')) && rhoPassed(ctx) && !partnerSaid('kingAsk')(ctx), rules: [{ call: 'P', shows: {} }] },
]

/** Asking: after the other books, before the fallback */
export const slamAsks: readonly Book[] = [askBlackwood]

// ── The slam check: a natural game bid with a slam in hand ───────────────────────────────────

const isGameBid = (call: Call) => call === '3N' || call === '4H' || call === '4S' || call === '5C' || call === '5D'

/**
 * A second look at the robot's call (`System.revise`), as in 2/1: the books' game bids take any
 * strength above their floor, so a hand with a slam between us asks with Blackwood when 4NT means
 * that here, or bids the small slam itself when it has the points for it
 */
export function slamCheck(h: Hand, ctx: Ctx, call: Call, shows: Spec | undefined, explain: (call: Call) => Spec | undefined): Call | null {
  if (!ctx.opening?.ours || !isGameBid(call) || shows?.artificial || shows?.notes?.some((n) => n.key === 'signoff')) return null
  if (ctx.turns.some((t) => (!t.ours && t.call !== 'P') || (t.ours && isBid(t.call) && (levelOf(t.call) >= 5 || t.call === '4N')))) return null
  const goal = goalFor(h, ctx)
  if (!goal || (goal.kind !== 'slam' && goal.kind !== 'grand')) return null
  if (goal.strain === trumpOf(ctx) && ctx.legal.has('4N') && explain('4N')?.name === 'blackwood') return '4N'
  if (h.hcp + (ctx.shown.partner.hcp?.[0] ?? 0) < 33) return null
  const six = bid(6, goal.strain)
  return explain(six) && !explain(six)?.artificial ? six : null
}
