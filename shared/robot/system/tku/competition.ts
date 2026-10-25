import { bidIndex, isBid, levelOf, strainOf } from '../../../auction.ts'
import type { Strain, Suit } from '../../../cards.ts'
import { cheapest, type Ctx } from '../context.ts'
import type { Hand } from '../evaluate.ts'
import type { Book, Rule, Spec } from '../spec.ts'
import {
  actions,
  answer,
  bid,
  cheapestIn,
  cheapestOr,
  contested,
  fiveCard,
  iOpened,
  isMajor,
  isSuit,
  length,
  longest,
  MAJORS,
  onlyIf,
  opened,
  ORDER,
  other,
  ours,
  overcallOf,
  overcallSuit,
  partnerOpened,
  pass,
  plus,
  rule,
  stopper,
  theyOpened,
} from './util.ts'

/**
 * Competition (淡江橋譜「Responsive dbl 回答性賭倍」, 5542 自然制 for the rest): raising partner, new
 * suits and the negative double after partner's opening is overcalled; the responsive double. Our
 * side's actions over the opponents' opening are in `defence.ts`, the answers to them in
 * `advancing.ts`.
 */

// ── Partner opened and the next player overcalled ─────────────────────────────────────────────

const ourSuit = (ctx: Ctx): Strain => strainOf(opened(ctx))
const theirs = (ctx: Ctx) => overcallSuit(ctx)!

/** The opening suit with enough support to raise: three cards in a major, five in a minor */
const raiseLength = (s: Strain) => (isMajor(s) ? 3 : 5)
const supports = (h: Hand, ctx: Ctx) => {
  const s = ourSuit(ctx)
  return isSuit(s) && h.len[s] >= raiseLength(s) && h.hcp >= 6
}
const support = (ctx: Ctx): Spec['len'] => (isSuit(ourSuit(ctx)) ? length(ourSuit(ctx) as Suit, raiseLength(ourSuit(ctx))) : undefined)
/** One level above the cheapest raise */
const jumpRaise = (ctx: Ctx) => {
  const call = isSuit(ourSuit(ctx)) ? cheapest(ctx, ourSuit(ctx)) : null
  return call ? bid(levelOf(call) + 1, ourSuit(ctx)) : null
}

/** Unbid majors of four or more (for the negative double) */
const unbidMajors = (ctx: Ctx) => MAJORS.filter((s) => s !== overcallSuit(ctx) && s !== ourSuit(ctx))

const contestedResponses: Book = {
  only: (ctx) =>
    partnerOpened(ctx) &&
    ours(ctx).length === 1 &&
    contested(ctx) &&
    opened(ctx) !== '1N' &&
    !(isMajor(ourSuit(ctx)) && levelOf(opened(ctx)) === 1 && overcallOf(ctx) === '2N') &&
    !!overcallSuit(ctx),
  rules: [
    rule(
      onlyIf((ctx) => isMajor(ourSuit(ctx)), (ctx) => bid(4, ourSuit(ctx))),
      (ctx) => ({ len: support(ctx), hcp: plus(13), notes: [{ key: 'game' }] }),
      (h, ctx) => supports(h, ctx) && h.hcp >= 13,
    ),
    rule(jumpRaise, (ctx) => ({ len: support(ctx), hcp: [10, 12] }), (h, ctx) => supports(h, ctx) && h.hcp >= 10 && ctx.legal.has(jumpRaise(ctx)!)),
    rule(
      (ctx) => (isSuit(ourSuit(ctx)) ? cheapest(ctx, ourSuit(ctx)) : null),
      (ctx) => ({ len: support(ctx), hcp: [6, 9] }),
      (h, ctx) => supports(h, ctx) && levelOf(cheapest(ctx, ourSuit(ctx))!) <= 3,
    ),
    rule('P', undefined, supports),
    // A five-card suit of our own
    ...ORDER.map((x) =>
      rule(
        onlyIf((ctx) => x !== overcallSuit(ctx) && x !== ourSuit(ctx), cheapestIn(x)),
        (ctx) => ({ len: length(x, 5), hcp: plus(levelOf(cheapest(ctx, x) ?? '2C') === 1 ? 6 : 10) }),
        (h, ctx) => {
          const call = cheapest(ctx, x)
          return fiveCard(h, [theirs(ctx), ourSuit(ctx)]) === x && !!call && h.hcp >= (levelOf(call) === 1 ? 6 : 10)
        },
      ),
    ),
    rule(
        'X',
        (ctx) => {
          const majors = unbidMajors(ctx)
          return { name: 'negative', hcp: plus(7), ...(majors.length === 1 ? { len: length(majors[0], 4) } : {}) }
        },
        (h, ctx) => unbidMajors(ctx).some((s) => h.len[s] >= 4) && h.hcp >= 7 && levelOf(ctx.last!.call) <= 2 && ctx.legal.has('X'),
      ),
    // Notrump with a stopper in their suit
    rule(
      onlyIf((ctx) => cheapest(ctx, 'N') === '1N', '2N'),
      (ctx) => ({ hcp: [11, 12], stop: { [theirs(ctx)]: 'stop' } }),
      (h, ctx) => stopper(h, theirs(ctx)) && h.hcp >= 11,
    ),
    rule(
      onlyIf((ctx) => levelOf(cheapest(ctx, 'N') ?? '3N') <= 2, cheapestIn('N')),
      (ctx) => ({ hcp: cheapest(ctx, 'N') === '1N' ? [8, 10] : plus(8), stop: { [theirs(ctx)]: 'stop' } }),
      (h, ctx) => stopper(h, theirs(ctx)) && h.hcp >= 8,
    ),
    rule(
      onlyIf((ctx) => levelOf(cheapest(ctx, 'N') ?? '3N') > 2, '3N'),
      (ctx) => ({ hcp: plus(13), stop: { [theirs(ctx)]: 'stop' } }),
      (h, ctx) => stopper(h, theirs(ctx)) && h.hcp >= 13,
    ),
    pass(),
  ],
}

/** We opened, the opponents overcalled and partner made a negative double */
const negativeMajors = (h: Hand, ctx: Ctx) => MAJORS.filter((s) => s !== overcallSuit(ctx) && s !== ourSuit(ctx) && h.len[s] >= 4)

const afterNegativeDouble: Book = {
  only: (ctx) =>
    iOpened(ctx) &&
    contested(ctx) &&
    ours(ctx).length === 2 &&
    answer(ctx) === 'X' &&
    opened(ctx) !== '1N' &&
    !(isMajor(ourSuit(ctx)) && levelOf(opened(ctx)) === 1 && overcallOf(ctx) === '2N'),
  rules: [
    ...MAJORS.flatMap((s): Rule[] => {
      const jump = (ctx: Ctx) => {
        const call = cheapest(ctx, s)
        return call ? bid(levelOf(call) + 1, s) : null
      }
      return [
        rule(jump, { len: length(s, 4), hcp: plus(15) }, (h, ctx) => negativeMajors(h, ctx)[0] === s && !!cheapest(ctx, s) && h.hcp >= 15 && ctx.legal.has(jump(ctx)!)),
        rule(cheapestIn(s), { len: length(s, 4), hcp: [12, 14] }, (h, ctx) => negativeMajors(h, ctx)[0] === s),
      ]
    }),
    rule(
      (ctx) => cheapestOr(ctx, 'N'),
      (ctx) => ({ balanced: true, ...(overcallSuit(ctx) ? { stop: { [overcallSuit(ctx)!]: 'stop' as const } } : {}) }),
      (h, ctx) => !!overcallSuit(ctx) && h.balanced && stopper(h, overcallSuit(ctx)!),
    ),
    rule(
      (ctx) => (isSuit(ourSuit(ctx)) ? cheapestOr(ctx, ourSuit(ctx)) : 'P'),
      (ctx) => (isSuit(ourSuit(ctx)) ? { len: length(ourSuit(ctx) as Suit, 5), notes: [{ key: 'noMajor' }] } : {}),
    ),
  ],
}

// ── Partner doubled and they raised: the responsive double ───────────────────────────────────

/** The opponents' bids, from the opening on */
const theirBids = (ctx: Ctx) => ctx.turns.filter((t) => !t.ours && isBid(t.call)).map((t) => t.call)
const theirOpening = (ctx: Ctx): Strain => strainOf(opened(ctx))

/** They opened, partner doubled and they raised (up to 3♠): our first call */
const responsiveHere = (ctx: Ctx) => {
  const bids = theirBids(ctx)
  return actions(ctx, 'me').length === 0 && actions(ctx, 'partner').join(' ') === 'X' && bids.length === 2
}

function responsiveShape(h: Hand, ctx: Ctx): boolean {
  const [first, second] = theirBids(ctx)
  const o = strainOf(first)
  const raised = strainOf(second) === o && bidIndex(second) <= bidIndex('3S')
  if (!raised || !isSuit(o) || h.hcp < 6 || h.hcp > 11 || !ctx.legal.has('X')) return false
  const others = ORDER.filter((s) => s !== o)
  const fiveMajor = MAJORS.some((s) => s !== o && h.len[s] >= 5)
  const twoSuits = isMajor(o)
    ? (h.len.C >= 4 && h.len.D >= 4) || (h.len[other(o)] === 3 && !others.some((s) => h.len[s] >= 5))
    : h.len.H >= 4 && h.len.S >= 4
  return twoSuits && !fiveMajor
}

/** Hands that do not double go on to the answers to partner's double (`advancing.ts`) */
const responsive: Book = {
  only: (ctx) => theyOpened(ctx) && responsiveHere(ctx),
  more: true,
  rules: [
    rule(
      'X',
      (ctx) => {
        const o = strainOf(theirBids(ctx)[0])
        return { name: 'responsive', hcp: [6, 11], notes: [{ key: isMajor(o) ? 'bothMinors' : 'bothMajors' }] }
      },
      responsiveShape,
    ),
  ],
}

/** Partner answers our responsive double with the cheapest four-card suit */
const answerResponsive: Book = {
  only: (ctx) => theyOpened(ctx) && actions(ctx, 'me').join(' ') === 'X' && actions(ctx, 'partner').join(' ') === 'X',
  rules: ORDER.map((x) => {
    const choices = (ctx: Ctx): Suit[] => {
      const o = theirOpening(ctx)
      return (isMajor(o) ? [other(o), 'D', 'C'] : ['S', 'H', 'D', 'C']).filter((s) => s !== o) as Suit[]
    }
    return rule(
      onlyIf((ctx) => choices(ctx).includes(x), (ctx) => cheapestOr(ctx, x)),
      { name: 'responsive', notes: [{ key: 'preference', strain: x }] },
      (h, ctx) => (choices(ctx).find((s) => h.len[s] >= 4) ?? longest(h, choices(ctx))) === x,
    )
  }),
}

export const competition: Book[] = [contestedResponses, afterNegativeDouble]
export const responsiveBooks: Book[] = [responsive, answerResponsive]
