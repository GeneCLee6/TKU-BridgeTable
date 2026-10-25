import { bidIndex, isBid, levelOf, strainOf, type Call } from '../../../auction.ts'
import type { Strain, Suit } from '../../../cards.ts'
import { cheapest, gameLevel, type Ctx } from '../context.ts'
import { revalue, type Hand } from '../evaluate.ts'
import type { Book, Rule } from '../spec.ts'
import { bid, MAJORS, plain, rule, shownLength, topThree } from './util.ts'

/**
 * Everything the other books leave out: pick the contract the partnership should reach from this
 * hand and what partner has shown (25 points for game, 33 a small slam, 37 a grand slam; an
 * eight-card fit picks the suit, otherwise notrump), and bid it if the auction is below it. Never
 * bids past it, so two robots always settle.
 */

/** Partner's points as we count them: two above the fewest shown, within what was shown */
function partnerPoints(ctx: Ctx) {
  const [min, max] = ctx.shown.partner.hcp ?? [0, 37]
  return Math.min(max, min + 2)
}

function work(h: Hand, ctx: Ctx): Call {
  const { last } = ctx
  if (penaltyStands(ctx)) return 'P'
  const fits = (['S', 'H', 'D', 'C'] as Suit[]).filter((s) => h.len[s] + shownLength(ctx.shown.partner, s) >= 8)
  // e5-t41: with a fit, short side suits count (`revalue`, the hand with fewer trumps counts more);
  // competing over the opponents (sacrifices, penalty doubles) still goes by high cards
  const fit = fits[0]
  const points = h.hcp + partnerPoints(ctx)
  const combined = points + (fit ? revalue(h, { trump: fit, partnerTrumps: shownLength(ctx.shown.partner, fit) }).shortness : 0)
  const majorFit = fits.find((s) => MAJORS.includes(s))
  const minorFit = fits.find((s) => !MAJORS.includes(s))

  let strain: Strain
  let level: number
  if (combined >= 33) {
    strain = majorFit ?? (h.balanced || !minorFit ? 'N' : minorFit)
    level = combined >= 37 ? 7 : 6
  } else if (combined >= 25) {
    if (majorFit) [strain, level] = [majorFit, 4]
    else if (minorFit && !h.balanced && combined >= 28) [strain, level] = [minorFit, 5]
    else [strain, level] = ['N', 3]
  } else if (majorFit || minorFit) {
    strain = (majorFit ?? minorFit)!
    level = combined >= 23 ? 3 : 2
  } else return last && !last.ours ? compete(h, ctx, points, fits) : 'P'

  const goal = bid(level, strain)
  if (!last) return 'P'
  if (last.ours) {
    if (bidIndex(last.call) >= bidIndex(goal)) return 'P'
    if (level < 3 || (strainOf(last.call) === strain && levelOf(last.call) >= level - 1 && combined < 25)) return 'P'
    return goal
  }
  if (bidIndex(last.call) >= bidIndex(goal)) return compete(h, ctx, points, fits)
  return combined >= 25 ? goal : (cheapest(ctx, strain) ?? 'P')
}

const isGame = (call: Call) => levelOf(call) >= gameLevel(strainOf(call))

/**
 * The opponents have bid past the contract we were aiming for (e5-t33, 競叫篇「再平衡理論」): double
 * them when our side has most of the points and I hold their trumps; otherwise compete in our fit
 * up to the level of our trumps (總墩數定律: eight trumps the two level, nine the three level, ten the
 * four level), and over their game sacrifice by vulnerability (favourable: down three at most,
 * neither side vulnerable: down two).
 */
function compete(h: Hand, ctx: Ctx, combined: number, fits: Suit[]): Call {
  const last = ctx.last!
  const theirs = strainOf(last.call)
  const trumps = (s: Suit) => h.len[s] + shownLength(ctx.shown.partner, s)
  const best = [...fits].sort((a, b) => trumps(b) - trumps(a) || (MAJORS.includes(b) ? 1 : 0) - (MAJORS.includes(a) ? 1 : 0))[0]
  const total = best ? trumps(best) : 0

  if (
    theirs !== 'N' &&
    levelOf(last.call) >= 2 &&
    combined >= 23 &&
    total <= 8 &&
    ctx.legal.has('X') &&
    ((h.len[theirs] >= 4 && h.points[theirs] >= 3) || (h.len[theirs] >= 3 && topThree(h, theirs) >= 2))
  )
    return 'X'
  const call = best ? cheapest(ctx, best) : null
  if (!call) return 'P'
  const level = levelOf(call)
  if (level <= Math.min(total - 6, 4)) return call
  // A sacrifice over their game, when they have most of the points
  const already = ctx.turns.some((t) => t.ours && isBid(t.call) && levelOf(t.call) >= 4)
  if (!isGame(last.call) || combined > 20 || already || level > 5 || ctx.weVul) return 'P'
  return level <= total - (ctx.theyVul ? 4 : 5) ? call : 'P'
}

/** Partner doubled their contract for penalty and the opponent on our right passed: leave it in */
const penaltyStands = (ctx: Ctx) =>
  ctx.said.partner?.name === 'penalty' && ctx.turns.findLast((t) => t.role === 'partner')?.call === 'X' && ctx.auction.at(-1)?.call === 'P'

const decisions = new WeakMap<Ctx, WeakMap<Hand, Call>>()

/** The call this hand makes here (worked out once: every rule of the book asks) */
export function aim(h: Hand, ctx: Ctx): Call {
  let byHand = decisions.get(ctx)
  if (!byHand) decisions.set(ctx, (byHand = new WeakMap()))
  let call = byHand.get(h)
  if (call === undefined) byHand.set(h, (call = work(h, ctx)))
  return call
}

const STRAINS: readonly Strain[] = ['C', 'D', 'H', 'S', 'N']
const BIDS: Call[] = [1, 2, 3, 4, 5, 6, 7].flatMap((level) => STRAINS.map((s) => bid(level, s)))

export const target: Book = {
  only: (ctx) => !!ctx.opening,
  rules: [...BIDS.map((call): Rule => plain(call, (h, ctx) => aim(h, ctx) === call)), plain('X', (h, ctx) => aim(h, ctx) === 'X'), rule('P')],
}
