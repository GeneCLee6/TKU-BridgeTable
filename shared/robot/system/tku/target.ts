import { bidIndex, levelOf, strainOf, type Call } from '../../../auction.ts'
import type { Strain, Suit } from '../../../cards.ts'
import { cheapest, type Ctx } from '../context.ts'
import type { Hand } from '../evaluate.ts'
import type { Book, Rule } from '../spec.ts'
import { bid, MAJORS, plain, rule, shownLength } from './util.ts'

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
  const combined = h.hcp + partnerPoints(ctx)
  const fits = (['S', 'H', 'D', 'C'] as Suit[]).filter((s) => h.len[s] + shownLength(ctx.shown.partner, s) >= 8)
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
  } else return 'P'

  const goal = bid(level, strain)
  if (!last) return 'P'
  if (last.ours) {
    if (bidIndex(last.call) >= bidIndex(goal)) return 'P'
    if (level < 3 || (strainOf(last.call) === strain && levelOf(last.call) >= level - 1 && combined < 25)) return 'P'
    return goal
  }
  if (bidIndex(last.call) >= bidIndex(goal)) {
    if (!fits.length || combined < 20) return 'P'
    const compete = cheapest(ctx, strain)
    return compete && levelOf(compete) <= 3 ? compete : 'P'
  }
  return combined >= 25 ? goal : (cheapest(ctx, strain) ?? 'P')
}

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
  rules: [...BIDS.map((call): Rule => plain(call, (h, ctx) => aim(h, ctx) === call)), rule('P')],
}
