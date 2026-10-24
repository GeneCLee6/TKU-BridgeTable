import { bidIndex, isBid, levelOf, strainOf, type Call } from '../../../auction.ts'
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
  convention,
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
 * Competition (淡江橋譜「Responsive dbl 回答性賭倍」「如何對抗弱跳叫2NT兩低」, 5542 自然制 for the
 * rest): raising partner, new suits and the negative double after partner's opening is overcalled;
 * overcalls, takeout doubles, 1NT and Unusual 2NT over the opponents' opening, the responsive
 * double and the answers to partner's overcall or double.
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
    convention(
      rule(
        'X',
        (ctx) => {
          const majors = unbidMajors(ctx)
          return { name: 'negative', hcp: plus(7), ...(majors.length === 1 ? { len: length(majors[0], 4) } : {}) }
        },
        (h, ctx) => unbidMajors(ctx).some((s) => h.len[s] >= 4) && h.hcp >= 7 && levelOf(ctx.last!.call) <= 2 && ctx.legal.has('X'),
      ),
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

// ── The opponents opened ─────────────────────────────────────────────────────────────────────

const theirOpening = (ctx: Ctx): Strain => strainOf(opened(ctx))
const lastLevel = (ctx: Ctx) => levelOf(ctx.last!.call)
const unbid = (ctx: Ctx) => ORDER.filter((s) => s !== theirOpening(ctx))
const overcallPoints = (ctx: Ctx) => (lastLevel(ctx) === 1 ? 8 : lastLevel(ctx) === 2 ? 11 : 15)

/** Our side has made no call but pass */
const silent = (ctx: Ctx) => theyOpened(ctx) && actions(ctx, 'me').length === 0 && actions(ctx, 'partner').length === 0

const takeoutShape = (h: Hand, ctx: Ctx) => {
  const o = theirOpening(ctx)
  return isSuit(o) && h.len[o] <= 2 && unbid(ctx).every((s) => h.len[s] >= 3)
}

const overcalls: Book = {
  only: silent,
  rules: [
    // Unusual 2NT: both minors 5-5 over a major, 8–10 vulnerable, 6–8 not
    convention(
      rule(
        onlyIf((ctx) => (opened(ctx) === '1H' || opened(ctx) === '1S') && ctx.last === ctx.opening, '2N'),
        (ctx) => ({ name: 'unusual2N', len: { D: [5, 13], C: [5, 13] }, hcp: ctx.weVul ? [8, 10] : [6, 8], notes: [{ key: 'bothMinors' }] }),
        (h, ctx) => {
          const [lo, hi] = ctx.weVul ? [8, 10] : [6, 8]
          return h.len.C >= 5 && h.len.D >= 5 && h.hcp >= lo && h.hcp <= hi
        },
      ),
    ),
    rule(
      onlyIf((ctx) => lastLevel(ctx) === 1 && isSuit(theirOpening(ctx)), '1N'),
      (ctx) => ({ hcp: [15, 18], balanced: true, stop: { [theirOpening(ctx)]: 'stop' } }),
      (h, ctx) => h.balanced && h.hcp >= 15 && h.hcp <= 18 && stopper(h, theirOpening(ctx) as Suit),
    ),
    rule(
      'X',
      (ctx) => {
        const o = theirOpening(ctx)
        const len: Spec['len'] = {}
        if (isSuit(o)) for (const s of ORDER) len[s] = s === o ? [0, 2] : [3, 13]
        return { name: 'takeout', len, hcp: plus(12) }
      },
      (h, ctx) => h.hcp >= 12 && takeoutShape(h, ctx) && ctx.legal.has('X'),
    ),
    ...ORDER.map((x) =>
      rule(
        onlyIf((ctx) => x !== theirOpening(ctx), cheapestIn(x)),
        (ctx) => ({ name: 'overcall', len: length(x, 5), hcp: [overcallPoints(ctx), 18] }),
        (h, ctx) => {
          const call = cheapest(ctx, x)
          return (
            longest(h, unbid(ctx)) === x &&
            h.len[x] >= 5 &&
            h.hcp >= overcallPoints(ctx) &&
            h.hcp <= 18 &&
            !!call &&
            levelOf(call) <= Math.max(2, lastLevel(ctx))
          )
        },
      ),
    ),
    rule('X', { name: 'takeout', hcp: plus(17) }, (h, ctx) => h.hcp >= 17 && ctx.legal.has('X')),
    pass(),
  ],
}

// ── Partner overcalled or doubled ────────────────────────────────────────────────────────────

/** Partner's first call other than pass */
const partnerAction = (ctx: Ctx): Call | undefined => actions(ctx, 'partner')[0]
const partnerDoubled = (ctx: Ctx) => partnerAction(ctx) === 'X'
const partnerBid = (ctx: Ctx) => {
  const call = partnerAction(ctx)
  return call && isBid(call) ? call : null
}
const partnerSuit = (ctx: Ctx) => (partnerBid(ctx) ? strainOf(partnerBid(ctx)!) : null)

/** The suit to answer partner's takeout double in: a four-card major, else the longest */
function doubleSuit(h: Hand, ctx: Ctx): Suit {
  const o = theirOpening(ctx)
  const majors = MAJORS.filter((s) => s !== o).sort((a, b) => h.len[b] - h.len[a])
  return majors.find((s) => h.len[s] >= 4) ?? longest(h, ORDER.filter((s) => s !== o))
}

const theirStop = (ctx: Ctx) => (isSuit(theirOpening(ctx)) ? { stop: { [theirOpening(ctx)]: 'stop' as const } } : {})

const advances: Rule[] = [
  // Partner's takeout double
  ...MAJORS.map((x) =>
    rule(
      onlyIf((ctx) => partnerDoubled(ctx) && x !== theirOpening(ctx), bid(4, x)),
      { len: length(x, 4), hcp: plus(12), notes: [{ key: 'game' }] },
      (h, ctx) => h.hcp >= 12 && doubleSuit(h, ctx) === x && h.len[x] >= 4,
    ),
  ),
  rule(onlyIf(partnerDoubled, '3N'), (ctx) => ({ hcp: plus(12), ...theirStop(ctx) }), (h, ctx) => h.hcp >= 12 && isSuit(theirOpening(ctx)) && stopper(h, theirOpening(ctx) as Suit)),
  rule(
    onlyIf(partnerDoubled, (ctx) => cheapestOr(ctx, 'N')),
    (ctx) => ({ hcp: [6, 9], balanced: true, ...theirStop(ctx) }),
    (h, ctx) => isSuit(theirOpening(ctx)) && h.balanced && h.hcp >= 6 && h.hcp <= 9 && stopper(h, theirOpening(ctx) as Suit),
  ),
  ...ORDER.flatMap((x): Rule[] => {
    const here = (ctx: Ctx) => partnerDoubled(ctx) && x !== theirOpening(ctx)
    const jump = (ctx: Ctx) => {
      const call = cheapest(ctx, x)
      return call ? bid(levelOf(call) + 1, x) : null
    }
    const answers = (h: Hand, ctx: Ctx) => doubleSuit(h, ctx) === x && !!cheapest(ctx, x) && (mustBid(ctx) || h.hcp >= 6)
    return [
      rule(onlyIf(here, jump), { len: length(x, 4), hcp: plus(9) }, (h, ctx) => answers(h, ctx) && h.hcp >= 9 && ctx.legal.has(jump(ctx)!) && levelOf(jump(ctx)!) <= 3),
      rule(onlyIf(here, cheapestIn(x)), { len: length(x, 4), hcp: [0, 8] }, answers),
    ]
  }),
  rule(onlyIf(partnerDoubled, 'P')),
  // Partner's overcall: raise with three
  ...ORDER.flatMap((x): Rule[] => {
    const here = (ctx: Ctx) => partnerSuit(ctx) === x
    const raising = (h: Hand) => h.len[x] >= 3 && h.hcp >= 6
    const cheap = (ctx: Ctx) => cheapest(ctx, x)
    const jump = (ctx: Ctx) => (cheap(ctx) ? bid(levelOf(cheap(ctx)!) + 1, x) : null)
    const rules: Rule[] = [rule(onlyIf((ctx) => here(ctx) && !cheap(ctx), 'P'), undefined, raising)]
    if (isMajor(x)) rules.push(rule(onlyIf(here, bid(4, x)), { len: length(x, 3), hcp: plus(13), notes: [{ key: 'support', strain: x }, { key: 'game' }] }, (h) => raising(h) && h.hcp >= 13))
    rules.push(
      rule(onlyIf(here, jump), { len: length(x, 3), hcp: [10, 12], notes: [{ key: 'support', strain: x }] }, (h, ctx) => raising(h) && h.hcp >= 10 && ctx.legal.has(jump(ctx)!)),
      rule(onlyIf((ctx) => here(ctx) && levelOf(cheap(ctx) ?? '4C') <= 3, cheap), { len: length(x, 3), hcp: [6, 9], notes: [{ key: 'support', strain: x }] }, raising),
      rule(onlyIf(here, 'P'), undefined, raising),
    )
    return rules
  }),
  // Partner's Unusual 2NT: the better minor
  rule(onlyIf((ctx) => partnerBid(ctx) === '2N', '5D'), { notes: [{ key: 'preference', strain: 'D' }, { key: 'game' }], hcp: plus(12) }, (h) => h.len.D > h.len.C && h.hcp >= 12),
  rule(onlyIf((ctx) => partnerBid(ctx) === '2N', '5C'), { notes: [{ key: 'preference', strain: 'C' }, { key: 'game' }], hcp: plus(12) }, (h) => h.len.D <= h.len.C && h.hcp >= 12),
  rule(onlyIf((ctx) => partnerBid(ctx) === '2N', '3D'), { notes: [{ key: 'preference', strain: 'D' }] }, (h) => h.len.D > h.len.C),
  rule(onlyIf((ctx) => partnerBid(ctx) === '2N', '3C'), { notes: [{ key: 'preference', strain: 'C' }] }),
  rule(onlyIf((ctx) => partnerSuit(ctx) === 'N', '3N'), { hcp: plus(10), notes: [{ key: 'game' }] }, (h) => h.hcp >= 10),
  pass(),
]

/** The opponent on our right passed: we must answer partner's double */
const mustBid = (ctx: Ctx) => ctx.auction.at(-1)?.call === 'P'

/** The opponents' bids, from the opening on */
const theirBids = (ctx: Ctx) => ctx.turns.filter((t) => !t.ours && isBid(t.call)).map((t) => t.call)

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

const responsive: Book = {
  only: (ctx) => theyOpened(ctx) && responsiveHere(ctx),
  rules: [
    convention(
      rule(
        'X',
        (ctx) => {
          const o = strainOf(theirBids(ctx)[0])
          return { name: 'responsive', hcp: [6, 11], notes: [{ key: isMajor(o) ? 'bothMinors' : 'bothMajors' }] }
        },
        responsiveShape,
      ),
    ),
    ...advances,
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

const advancing: Book = {
  only: (ctx) => theyOpened(ctx) && actions(ctx, 'me').length === 0 && actions(ctx, 'partner').length > 0,
  rules: advances,
}

export const competition: Book[] = [contestedResponses, afterNegativeDouble]
export const defence: Book[] = [overcalls, responsive, answerResponsive, advancing]
