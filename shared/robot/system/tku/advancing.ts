import { bidIndex, isBid, levelOf, strainOf, type Call } from '../../../auction.ts'
import type { Suit } from '../../../cards.ts'
import { bidStrains, cheapest, jump, type Ctx } from '../context.ts'
import type { Hand } from '../evaluate.ts'
import type { Book, Rule, Spec } from '../spec.ts'
import { openingKind, theirOpening } from './defence.ts'
import {
  actions,
  bid,
  cheapestIn,
  cheapestOr,
  isMajor,
  isSuit,
  length,
  longest,
  MAJORS,
  onlyIf,
  opened,
  ORDER,
  other,
  pass,
  plus,
  rule,
  shortSuit,
  stopper,
  theyOpened,
  topThree,
} from './util.ts'

/**
 * Partner overcalled or doubled and it is our turn (淡江橋譜「競叫篇」同伴蓋叫後的答叫,
 * 「賭倍性叫品」迫伴賭倍與賭倍之後, 「開叫1NT/2NT」CAPP, 「競叫篇」如何對抗技光的賴本索; 5542 自然制
 * where the handbook is silent): advancing an overcall (e5-t31), answering a takeout double and the
 * doubler's next call (e5-t32), Lebensohl after partner doubles a weak two (e5-t34), the answers to
 * Cappelletti, Michaels and the Unusual 2NT (e5-t38, e5-t30), and the overcaller's next call.
 * Books that do not cover every hand let the fallback (`target`) answer the rest (`more`).
 */

// ── The auction ──────────────────────────────────────────────────────────────────────────────

/** Partner's first call other than pass, and what it meant */
const partnerAction = (ctx: Ctx): Call | undefined => actions(ctx, 'partner')[0]
const partnerSaid = (ctx: Ctx) => ctx.said.partner?.name
/** The opponent on our right passed */
const rhoPassed = (ctx: Ctx) => ctx.auction.at(-1)?.call === 'P'
/** Partner's call is the last bid, and the opponent on our right passed */
const partnerLast = (ctx: Ctx) => rhoPassed(ctx) && ctx.last?.role === 'partner'

/** I have only passed and partner has made one call */
const advancing = (ctx: Ctx) => theyOpened(ctx) && actions(ctx, 'me').length === 0 && actions(ctx, 'partner').length === 1

/** Suits the opponents have bid */
const theirSuits = (ctx: Ctx): Suit[] =>
  bidStrains(ctx, 'theirs').filter((s): s is Suit => isSuit(s) && !(s === 'D' && openingKind(ctx) === 'oneMajor'))
const free = (ctx: Ctx) => ORDER.filter((s) => !theirSuits(ctx).includes(s))
/** Their opening suit (for a cue bid), when it is a suit */
const cueSuit = (ctx: Ctx): Suit | null => (isSuit(theirOpening(ctx)) ? (theirOpening(ctx) as Suit) : null)

const stopsAll = (h: Hand, ctx: Ctx) => theirSuits(ctx).every((s) => stopper(h, s))
const stopSpec = (ctx: Ctx): Spec => {
  const stop: Spec['stop'] = {}
  for (const s of theirSuits(ctx)) stop[s] = 'stop'
  return Object.keys(stop).length ? { stop } : {}
}
const fourMajor = (h: Hand, ctx: Ctx) => MAJORS.some((s) => free(ctx).includes(s) && h.len[s] >= 4)

/** The suit to answer partner's takeout double in: a four-card unbid major, else the longest unbid suit */
function doubleSuit(h: Hand, ctx: Ctx): Suit {
  const majors = MAJORS.filter((s) => free(ctx).includes(s)).sort((a, b) => h.len[b] - h.len[a])
  return majors.find((s) => h.len[s] >= 4) ?? longest(h, free(ctx))
}

/** A call, when it is legal here */
const legal = (ctx: Ctx, call: Call | null | undefined): Call | null => (call && ctx.legal.has(call) ? call : null)

// ── Partner's Cappelletti over 1NT (e5-t38) ───────────────────────────────────────────────────

const capped = (call: Call) => (ctx: Ctx) => partnerAction(ctx) === call

const answerCappelletti: Book = {
  only: (ctx) =>
    advancing(ctx) &&
    opened(ctx) === '1N' &&
    (rhoPassed(ctx) || (ctx.auction.at(-1)?.call === 'X' && ctx.last?.role === 'partner')) &&
    ['cappelletti', 'penalty'].includes(partnerSaid(ctx) ?? ''),
  rules: [
    rule(onlyIf(capped('X'), 'P'), { name: 'penalty' }),
    // Their double of 2♣: pass to play it with five clubs
    rule(onlyIf((ctx) => capped('2C')(ctx) && !rhoPassed(ctx), 'P'), { len: length('C', 5) }, (h) => h.len.C >= 5),
    rule(onlyIf(capped('2C'), '2D'), { name: 'relay', artificial: true, notes: [{ key: 'completes' }] }),
    // 2♦: both majors, the better one (hearts on a tie)
    ...MAJORS.flatMap((m): Rule[] => {
      const best = (h: Hand) => (h.len.H >= h.len.S ? 'H' : 'S') === m
      const here = capped('2D')
      return [
        rule(onlyIf(here, bid(4, m)), { len: length(m, 3), hcp: plus(13), notes: [{ key: 'game' }] }, (h) => best(h) && h.len[m] >= 3 && h.hcp >= 13),
        rule(onlyIf(here, bid(3, m)), { len: length(m, 4), hcp: [10, 12], notes: [{ key: 'invite' }] }, (h) => best(h) && h.len[m] >= 4 && h.hcp >= 10),
        rule(onlyIf(here, bid(2, m)), { notes: [{ key: 'preference', strain: m }] }, best),
      ]
    }),
    // 2♥／2♠: that major and a minor
    ...MAJORS.flatMap((m): Rule[] => {
      const here = capped(bid(2, m))
      return [
        rule(onlyIf(here, bid(4, m)), { len: length(m, 3), hcp: plus(13), notes: [{ key: 'support', strain: m }, { key: 'game' }] }, (h) => h.len[m] >= 3 && h.hcp >= 13),
        rule(onlyIf(here, bid(3, m)), { len: length(m, 3), hcp: [10, 12], notes: [{ key: 'support', strain: m }, { key: 'invite' }] }, (h) => h.len[m] >= 3 && h.hcp >= 10),
        rule(onlyIf(here, 'P'), { len: length(m, 2) }, (h) => h.len[m] >= 2),
        rule(onlyIf(here, '3C'), { name: 'passOrCorrect', len: { [m]: [0, 1] }, notes: [{ key: 'choiceOf', calls: ['3C', '3D'] }] }),
      ]
    }),
    // 2NT: both minors, the longer
    rule(onlyIf(capped('2N'), '5D'), { notes: [{ key: 'preference', strain: 'D' }, { key: 'game' }], hcp: plus(13) }, (h) => h.len.D > h.len.C && h.hcp >= 13),
    rule(onlyIf(capped('2N'), '5C'), { notes: [{ key: 'preference', strain: 'C' }, { key: 'game' }], hcp: plus(13) }, (h) => h.hcp >= 13),
    rule(onlyIf(capped('2N'), '3D'), { notes: [{ key: 'preference', strain: 'D' }] }, (h) => h.len.D > h.len.C),
    rule(onlyIf(capped('2N'), '3C'), { notes: [{ key: 'preference', strain: 'C' }] }),
    pass(),
  ],
}

/** After the relay to 2♦ a diamond suit passes; after partner passed 2♣ doubled, clubs pass */
const namesSuit = (s: Suit, partnerPassed: boolean) => (partnerPassed ? s !== 'C' : s !== 'D')

/** The Cappelletti bidder's next call: name the long suit after the relay, correct 3♣ to 3♦ */
const cappellettiRebid: Book = {
  only: (ctx) => {
    if (!theyOpened(ctx) || opened(ctx) !== '1N' || !rhoPassed(ctx) || ctx.said.me?.name !== 'cappelletti') return false
    const mine = actions(ctx, 'me').join(' ')
    const theirs = actions(ctx, 'partner').join(' ')
    // 2♣ doubled and partner passed: partner has clubs, so name my suit
    if (mine === '2C' && !theirs) return ctx.last?.role === 'me'
    if (!partnerLast(ctx)) return false
    return (mine === '2C' && theirs === '2D') || ((mine === '2H' || mine === '2S') && theirs === '3C')
  },
  rules: [
    ...(['D', 'H', 'S', 'C'] as const).map((s) =>
      rule(
        onlyIf((ctx) => actions(ctx, 'me')[0] === '2C' && namesSuit(s, actions(ctx, 'partner').length === 0), cheapestIn(s)),
        { len: length(s, 6), notes: [{ key: 'oneSuiter' }] },
        (h) => longest(h) === s && h.len[s] >= 6,
      ),
    ),
    rule(onlyIf((ctx) => actions(ctx, 'me')[0] !== '2C', '3D'), { len: length('D', 4), notes: [{ key: 'preference', strain: 'D' }] }, (h) => h.len.D > h.len.C),
    pass(),
  ],
}

// ── Partner's Michaels (e5-t30) ──────────────────────────────────────────────────────────────

/** The major partner showed for sure: either over a minor, the other one over a major */
function michaelsMajor(h: Hand, ctx: Ctx): Suit {
  const o = theirOpening(ctx) as Suit
  return isMajor(o) ? other(o) : h.len.H >= h.len.S ? 'H' : 'S'
}

const answerMichaels: Book = {
  only: (ctx) => advancing(ctx) && partnerLast(ctx) && partnerSaid(ctx) === 'michaels',
  rules: [
    ...MAJORS.flatMap((m): Rule[] => {
      const mine = (h: Hand, ctx: Ctx) => michaelsMajor(h, ctx) === m
      return [
        rule(bid(4, m), { len: length(m, 3), notes: [{ key: 'support', strain: m }, { key: 'game' }] }, (h, ctx) => mine(h, ctx) && ((h.len[m] >= 3 && h.hcp >= 13) || h.len[m] >= 5)),
        rule(
          (ctx) => legal(ctx, jump(ctx, m)),
          { len: length(m, 3), hcp: [10, 12], notes: [{ key: 'support', strain: m }, { key: 'invite' }] },
          (h, ctx) => mine(h, ctx) && h.len[m] >= 3 && h.hcp >= 10 && levelOf(jump(ctx, m)!) <= 3,
        ),
        rule(cheapestIn(m), { notes: [{ key: 'preference', strain: m }] }, (h, ctx) => mine(h, ctx) && (h.len[m] >= 3 || !isMajor(theirOpening(ctx)))),
      ]
    }),
    // Over a major without three of the other one: 2NT asks for the minor
    rule('2N', { name: 'ask', artificial: true, notes: [{ key: 'choiceOf', calls: ['3C', '3D'] }] }),
  ],
}

/** The Michaels bidder names the minor */
const michaelsMinor: Book = {
  only: (ctx) => theyOpened(ctx) && ctx.said.me?.name === 'michaels' && actions(ctx, 'partner').join(' ') === '2N' && partnerLast(ctx),
  rules: [rule('3D', { len: length('D', 5) }, (h) => h.len.D > h.len.C), rule('3C', { len: length('C', 5) })],
}

// ── Partner's takeout double (e5-t32, e5-t34) ────────────────────────────────────────────────

const doubled = (ctx: Ctx) => advancing(ctx) && partnerAction(ctx) === 'X' && partnerSaid(ctx) === 'takeout'

/** Leaving partner's double in (處罰性 Pass): five good trumps and some points, at the one or two level */
const penaltyPass: Rule = rule(
  onlyIf((ctx) => !!cueSuit(ctx) && levelOf(ctx.last!.call) <= 2 && ctx.last!.call === opened(ctx), 'P'),
  (ctx) => ({ name: 'penalty', len: length(cueSuit(ctx)!, 5), hcp: plus(8) }),
  (h, ctx) => h.len[cueSuit(ctx)!] >= 5 && topThree(h, cueSuit(ctx)!) >= 2 && h.hcp >= 8,
)

/** 1♦ X P ? (迫伴賭倍之答叫): 3NT 13+, cue bid 12+, 2NT 10–12, a jump 9–11, 1NT 8–10, a suit 0–8 */
const answerOneLevel: Rule[] = [
  penaltyPass,
  rule('3N', (ctx) => ({ hcp: plus(13), balanced: true, ...stopSpec(ctx) }), (h, ctx) => h.balanced && h.hcp >= 13 && stopsAll(h, ctx) && !fourMajor(h, ctx)),
  rule(
    (ctx) => (cueSuit(ctx) ? cheapest(ctx, cueSuit(ctx)!) : null),
    { name: 'cue', hcp: plus(12), forcing: 'oneRound', artificial: true },
    (h) => h.hcp >= 12,
  ),
  rule(
    onlyIf((ctx) => jump(ctx, 'N') === '2N', '2N'),
    (ctx) => ({ hcp: [10, 12], ...stopSpec(ctx) }),
    (h, ctx) => h.hcp >= 10 && stopsAll(h, ctx) && !fourMajor(h, ctx),
  ),
  ...ORDER.map((x) =>
    rule(
      (ctx) => (free(ctx).includes(x) ? jump(ctx, x) : null),
      { len: length(x, 4), hcp: [9, 11] },
      (h, ctx) => doubleSuit(h, ctx) === x && h.len[x] >= 4 && h.hcp >= 9 && levelOf(jump(ctx, x)!) <= 3,
    ),
  ),
  rule(
    onlyIf((ctx) => cheapest(ctx, 'N') === '1N', '1N'),
    (ctx) => ({ hcp: [8, 10], ...stopSpec(ctx) }),
    (h, ctx) => h.hcp >= 8 && stopsAll(h, ctx) && !fourMajor(h, ctx),
  ),
  ...ORDER.map((x) =>
    rule((ctx) => (free(ctx).includes(x) ? cheapest(ctx, x) : null), { len: length(x, 4), hcp: [0, 8] }, (h, ctx) => doubleSuit(h, ctx) === x),
  ),
]

/**
 * Partner doubled a weak two (如何對抗技光「2♦ X P ?」的賴本索): game with 13+, a three-level bid
 * 10–12, a two-level suit 0–9, 2NT to name a suit at the three level 0–9
 */
const answerWeakTwo: Rule[] = [
  penaltyPass,
  ...MAJORS.map((m) =>
    rule(
      (ctx) => (free(ctx).includes(m) ? legal(ctx, bid(4, m)) : null),
      { len: length(m, 4), hcp: plus(13), notes: [{ key: 'game' }] },
      (h, ctx) => doubleSuit(h, ctx) === m && h.len[m] >= 4 && h.hcp >= 13,
    ),
  ),
  rule('3N', (ctx) => ({ hcp: plus(13), ...stopSpec(ctx), notes: [{ key: 'toPlay' }] }), (h, ctx) => h.hcp >= 13 && stopsAll(h, ctx)),
  ...(['D', 'C'] as const).map((m) =>
    rule((ctx) => (free(ctx).includes(m) ? legal(ctx, bid(5, m)) : null), { len: length(m, 6), hcp: plus(13), notes: [{ key: 'game' }] }, (h, ctx) => longest(h, free(ctx)) === m && h.len[m] >= 6 && h.hcp >= 13),
  ),
  rule('3N', { hcp: plus(13), notes: [{ key: 'toPlay' }] }, (h) => h.hcp >= 13),
  // 10–12: a three-level bid (a jump when the suit is free at two)
  ...ORDER.map((x) =>
    rule(
      (ctx) => {
        if (!free(ctx).includes(x)) return null
        const call = cheapest(ctx, x)
        return call && levelOf(call) === 2 ? jump(ctx, x) : call
      },
      { len: length(x, 4), hcp: [10, 12], notes: [{ key: 'invite' }] },
      (h, ctx) => doubleSuit(h, ctx) === x && h.hcp >= 10,
    ),
  ),
  ...ORDER.map((x) =>
    rule(
      (ctx) => (free(ctx).includes(x) && levelOf(cheapest(ctx, x) ?? '3C') === 2 ? cheapest(ctx, x) : null),
      { len: length(x, 4), hcp: [0, 9] },
      (h, ctx) => doubleSuit(h, ctx) === x,
    ),
  ),
  rule('2N', { name: 'lebensohl', hcp: [0, 9], artificial: true, notes: [{ key: 'relayTo', calls: ['3C'] }] }),
]

/** 3♥ X P ?: game with 10+ (a four-card major, a stopper for 3NT, a long minor), else the cheapest suit */
const answerThree: Rule[] = [
  ...MAJORS.map((m) =>
    rule(
      (ctx) => (free(ctx).includes(m) ? legal(ctx, bid(4, m)) : null),
      { len: length(m, 4), hcp: plus(10), notes: [{ key: 'game' }] },
      (h, ctx) => doubleSuit(h, ctx) === m && h.len[m] >= 4 && h.hcp >= 10,
    ),
  ),
  rule('3N', (ctx) => ({ hcp: plus(10), ...stopSpec(ctx) }), (h, ctx) => h.hcp >= 10 && stopsAll(h, ctx)),
  ...(['D', 'C'] as const).map((m) =>
    rule((ctx) => (free(ctx).includes(m) ? legal(ctx, bid(5, m)) : null), { len: length(m, 5), hcp: plus(12), notes: [{ key: 'game' }] }, (h, ctx) => longest(h, free(ctx)) === m && h.len[m] >= 5 && h.hcp >= 12),
  ),
  ...ORDER.map((x) => rule((ctx) => (free(ctx).includes(x) ? cheapest(ctx, x) : null), { len: length(x, 4), hcp: [0, 9] }, (h, ctx) => doubleSuit(h, ctx) === x)),
]

/** The double of 2♦ (一高弱二) is 12–15 balanced: 3NT 12+, a five-card major 11+ to game, else a suit */
const answerOneMajor: Rule[] = [
  ...MAJORS.map((m) => rule(bid(4, m), { len: length(m, 5), hcp: plus(11), notes: [{ key: 'game' }] }, (h) => h.len[m] >= 5 && h.len[m] >= h.len[other(m)] && h.hcp >= 11)),
  rule('3N', { hcp: plus(12), notes: [{ key: 'toPlay' }] }, (h) => h.hcp >= 12),
  ...ORDER.map((x) => rule(cheapestIn(x), { len: length(x, 4), hcp: [0, 11] }, (h, ctx) => doubleSuit(h, ctx) === x)),
]

/** The opponent on our right bid over partner's double (自由答叫): a suit 7+ at the one level, 8+ higher */
const freeBids: Rule[] = ORDER.map((x) =>
  rule(
    (ctx) => (free(ctx).includes(x) ? cheapest(ctx, x) : null),
    (ctx) => ({ len: length(x, 4), hcp: levelOf(cheapest(ctx, x)!) === 1 ? [7, 11] : [8, 11] }),
    (h, ctx) => {
      const call = cheapest(ctx, x)!
      return doubleSuit(h, ctx) === x && h.len[x] >= (levelOf(call) >= 3 ? 5 : 4) && levelOf(call) <= 3 && h.hcp >= (levelOf(call) === 1 ? 7 : 8)
    },
  ),
)

const answerDouble: Book = {
  only: doubled,
  more: true,
  rules: [
    ...answerWeakTwo.map((r) => within(r, (ctx) => doubledOpening(ctx) === 'weak')),
    ...answerThree.map((r) => within(r, (ctx) => doubledOpening(ctx) === 'three')),
    ...answerOneMajor.map((r) => within(r, (ctx) => doubledOpening(ctx) === 'oneMajor')),
    ...answerOneLevel.map((r) => within(r, (ctx) => rhoPassed(ctx) && !['weak', 'three', 'oneMajor'].includes(doubledOpening(ctx) ?? ''))),
    ...freeBids.map((r) => within(r, (ctx) => !rhoPassed(ctx))),
    rule(onlyIf((ctx) => !rhoPassed(ctx), 'P')),
  ],
}

/** Partner doubled their opening (passed round to us): what the opening was; null when they bid again */
const doubledOpening = (ctx: Ctx) => (rhoPassed(ctx) && ctx.last!.call === opened(ctx) ? openingKind(ctx) : null)

/** A rule only in auctions that pass `test` */
function within(r: Rule, test: (ctx: Ctx) => boolean): Rule {
  return { ...r, call: (ctx: Ctx) => (test(ctx) ? (typeof r.call === 'function' ? r.call(ctx) : r.call) : null) }
}

/** After 2♥ X P 2NT P: complete the relay */
const completeLebensohl: Book = {
  only: (ctx) => theyOpened(ctx) && actions(ctx, 'me').join(' ') === 'X' && actions(ctx, 'partner').join(' ') === '2N' && partnerSaid(ctx) === 'lebensohl' && partnerLast(ctx),
  rules: [rule('3C', { name: 'lebensohl', notes: [{ key: 'completes' }] })],
}

/** After 2♥ X P 2NT P 3♣ P: pass with clubs, else name the suit */
const afterLebensohl: Book = {
  only: (ctx) => theyOpened(ctx) && actions(ctx, 'me').join(' ') === '2N' && ctx.said.me?.name === 'lebensohl' && actions(ctx, 'partner').join(' ') === 'X 3C' && rhoPassed(ctx),
  rules: [
    rule('P', { len: length('C', 4) }, (h, ctx) => doubleSuit(h, ctx) === 'C'),
    ...ORDER.map((x) => rule((ctx) => (free(ctx).includes(x) ? cheapest(ctx, x) : null), { len: length(x, 4), hcp: [0, 9], notes: [{ key: 'signoff' }] }, (h, ctx) => doubleSuit(h, ctx) === x)),
  ],
}

// ── The doubler's next call (迫伴賭倍「強力型」, 平衡叫「賭倍後再叫NT為16-19點」) ─────────────────────

const doublerAgain = (ctx: Ctx) =>
  theyOpened(ctx) && actions(ctx, 'me').join(' ') === 'X' && ctx.said.me?.name === 'takeout' && actions(ctx, 'partner').length === 1 && partnerLast(ctx)

/** My double was in the pass-out seat (1♥ P P X) */
const balancingDouble = (ctx: Ctx) => {
  const first = ctx.turns.findIndex((t) => t.role === 'me' && t.call === 'X')
  return first === 3 && ctx.turns[1].call === 'P' && ctx.turns[2].call === 'P'
}

const answerSuit = (ctx: Ctx): Suit | null => {
  const call = partnerAction(ctx)
  const s = call && isBid(call) ? strainOf(call) : undefined
  return isSuit(s) && !theirSuits(ctx).includes(s) ? s : null
}
/** Partner's answer was the weakest one (from 0 points), or a jump (from 9) */
const weakAnswer = (ctx: Ctx) => (ctx.said.partner?.hcp?.[0] ?? 0) === 0
const jumpAnswer = (ctx: Ctx) => (ctx.said.partner?.hcp?.[0] ?? 0) >= 9

const doublerRebid: Book = {
  only: doublerAgain,
  more: true,
  rules: [
    // Partner's cue bid: a four-card unbid major, notrump with their suit stopped, else the longest suit
    ...MAJORS.map((m) =>
      rule(
        onlyIf((ctx) => partnerSaid(ctx) === 'cue' && free(ctx).includes(m), cheapestIn(m)),
        { len: length(m, 4) },
        (h, ctx) => h.len[m] >= 4 && (h.len[m] > h.len[other(m)] || (h.len[m] === h.len[other(m)] && m === 'H')) && free(ctx).includes(m),
      ),
    ),
    rule(onlyIf((ctx) => partnerSaid(ctx) === 'cue', (ctx) => cheapestOr(ctx, 'N')), (ctx) => stopSpec(ctx), (h, ctx) => stopsAll(h, ctx) && levelOf(cheapestOr(ctx, 'N', '7N')) <= 3),
    ...ORDER.map((x) =>
      rule(
        onlyIf((ctx) => partnerSaid(ctx) === 'cue' && free(ctx).includes(x), cheapestIn(x)),
        { len: length(x, 4) },
        (h, ctx) => longest(h, free(ctx)) === x,
      ),
    ),
    // Partner's suit with four-card support: 16–18 raise, 19–21 jump raise, 22+ game in a major
    rule(
      (ctx) => (answerSuit(ctx) && isMajor(answerSuit(ctx)!) && weakAnswer(ctx) ? legal(ctx, bid(4, answerSuit(ctx)!)) : null),
      (ctx) => ({ len: length(answerSuit(ctx)!, 4), hcp: plus(22), notes: [{ key: 'support', strain: answerSuit(ctx)! }, { key: 'game' }] }),
      (h, ctx) => h.len[answerSuit(ctx)!] >= 4 && h.hcp >= 22,
    ),
    rule(
      (ctx) => (answerSuit(ctx) && weakAnswer(ctx) ? jump(ctx, answerSuit(ctx)!) : null),
      (ctx) => ({ len: length(answerSuit(ctx)!, 4), hcp: [19, 21], notes: [{ key: 'support', strain: answerSuit(ctx)! }, { key: 'invite' }] }),
      (h, ctx) => h.len[answerSuit(ctx)!] >= 4 && h.hcp >= 19 && levelOf(jump(ctx, answerSuit(ctx)!)!) <= 4,
    ),
    rule(
      (ctx) => (answerSuit(ctx) && weakAnswer(ctx) ? cheapest(ctx, answerSuit(ctx)!) : null),
      (ctx) => ({ len: length(answerSuit(ctx)!, 4), hcp: [16, 18], notes: [{ key: 'support', strain: answerSuit(ctx)! }, { key: 'invite' }] }),
      (h, ctx) => h.len[answerSuit(ctx)!] >= 4 && h.hcp >= 16 && levelOf(cheapest(ctx, answerSuit(ctx)!)!) <= 3,
    ),
    // After a jump answer (9–11, or 10–12 over a weak two): game with support
    rule(
      (ctx) => (answerSuit(ctx) && isMajor(answerSuit(ctx)!) && jumpAnswer(ctx) ? legal(ctx, bid(4, answerSuit(ctx)!)) : null),
      (ctx) => ({ len: length(answerSuit(ctx)!, 4), notes: [{ key: 'support', strain: answerSuit(ctx)! }, { key: 'accept' }] }),
      (h, ctx) => h.len[answerSuit(ctx)!] >= 4 && h.hcp >= 14,
    ),
    // A five-card suit of my own: the strong double (16+)
    ...ORDER.map((x) =>
      rule(
        (ctx) => (free(ctx).includes(x) && x !== answerSuit(ctx) && partnerSaid(ctx) !== 'cue' ? cheapest(ctx, x) : null),
        { len: length(x, 5), hcp: plus(16) },
        (h, ctx) => fiveFree(h, ctx) === x && h.hcp >= 16 && levelOf(cheapest(ctx, x)!) <= 3,
      ),
    ),
    // Notrump: 19–21 (16–19 after a double in the pass-out seat), their suit stopped
    rule(
      (ctx) => (weakAnswer(ctx) && levelOf(cheapestOr(ctx, 'N', '7N')) <= 2 ? cheapest(ctx, 'N') : null),
      (ctx) => ({ hcp: balancingDouble(ctx) ? [16, 19] : [19, 21], balanced: true, ...stopSpec(ctx) }),
      (h, ctx) => {
        const [lo, hi] = balancingDouble(ctx) ? [16, 19] : [19, 21]
        return h.balanced && h.hcp >= lo && h.hcp <= hi && stopsAll(h, ctx)
      },
    ),
    // Partner's notrump: 1NT 8–10, 2NT 10–12
    rule(onlyIf((ctx) => partnerAction(ctx) === '1N', '3N'), { hcp: plus(15), notes: [{ key: 'game' }] }, (h) => h.hcp >= 15),
    rule(onlyIf((ctx) => partnerAction(ctx) === '1N', '2N'), { hcp: [13, 14], notes: [{ key: 'invite' }] }, (h) => h.hcp >= 13),
    rule(onlyIf((ctx) => partnerAction(ctx) === '2N', '3N'), { hcp: plus(13), notes: [{ key: 'accept' }] }, (h) => h.hcp >= 13),
    rule(onlyIf((ctx) => partnerSaid(ctx) !== 'cue' && partnerSaid(ctx) !== 'lebensohl', 'P')),
  ],
}

/** My own five-card unbid suit, the longest */
const fiveFree = (h: Hand, ctx: Ctx): Suit | null => {
  const s = longest(h, free(ctx))
  return h.len[s] >= 5 ? s : null
}

// ── Partner's overcall (e5-t31) ──────────────────────────────────────────────────────────────

/** Partner's suit, when partner bid one naturally */
const overcallStrain = (ctx: Ctx): Suit | null => {
  const call = partnerAction(ctx)
  if (!call || !isBid(call)) return null
  const name = partnerSaid(ctx)
  if (name && name !== 'overcall') return null
  const s = strainOf(call)
  return isSuit(s) && !theirSuits(ctx).includes(s) ? s : null
}

const overcalled = (ctx: Ctx) => advancing(ctx) && partnerLast(ctx) && !!overcallStrain(ctx)
const xOf = (ctx: Ctx) => overcallStrain(ctx)!
const supportOf = (h: Hand, ctx: Ctx) => h.len[xOf(ctx)]
const supportSpec = (ctx: Ctx, min: number): Spec['len'] => length(xOf(ctx), min)

/** A side suit (not partner's) with at most one card, for a splinter below four of partner's suit */
const splinterSuit = (h: Hand, ctx: Ctx): Suit | null => {
  const s = shortSuit(h, xOf(ctx))
  return s && legal(ctx, bid(4, s)) && levelOf(bid(4, s)) === 4 && ORDER.indexOf(s) < ORDER.indexOf(xOf(ctx)) ? s : null
}

/** The notrump ranges: over a one-level overcall 1NT 10–12, 2NT 13–15, 3NT 16–18; over two, 2NT 11–14, 3NT 15–18 */
const ntRange = (ctx: Ctx, call: Call): readonly [number, number] | null => {
  const low = cheapest(ctx, 'N') === '1N'
  if (call === '1N') return low ? [10, 12] : null
  if (call === '2N') return low ? [13, 15] : [11, 14]
  return low ? [16, 18] : [15, 18]
}

const ntAdvance = (call: Call): Rule =>
  rule(
    (ctx) => (cheapest(ctx, 'N') && ntRange(ctx, call) && legal(ctx, call) ? call : null),
    (ctx) => ({ hcp: ntRange(ctx, call)!, ...stopSpec(ctx) }),
    (h, ctx) => {
      const [lo, hi] = ntRange(ctx, call)!
      return h.hcp >= lo && h.hcp <= hi && stopsAll(h, ctx) && supportOf(h, ctx) <= 2 && (call !== '3N' || h.balanced)
    },
  )

const answerOvercall: Book = {
  only: overcalled,
  more: true,
  rules: [
    // 「4C/D/H Splinter，16點↑，4張↑」
    ...ORDER.map((s) =>
      rule(
        (ctx) => (s !== xOf(ctx) ? legal(ctx, bid(4, s)) : null),
        (ctx) => ({ name: 'splinter', len: supportSpec(ctx, 4), hcp: plus(16), notes: [{ key: 'shortIn', strain: s }] }),
        (h, ctx) => supportOf(h, ctx) >= 4 && h.hcp >= 16 && splinterSuit(h, ctx) === s,
      ),
    ),
    ntAdvance('3N'),
    ntAdvance('2N'),
    // Cue bid 13+ (「Cue-Bid一圈，13點↑」), the jump cue bid 11–12 with four (「邀請」)
    rule((ctx) => (cueSuit(ctx) && levelOf(cheapest(ctx, cueSuit(ctx)!) ?? '4C') <= 3 ? cheapest(ctx, cueSuit(ctx)!) : null), { name: 'cue', hcp: plus(13), forcing: 'oneRound', artificial: true }, (h) => h.hcp >= 13),
    rule(
      (ctx) => (cueSuit(ctx) ? jump(ctx, cueSuit(ctx)!) : null),
      (ctx) => ({ name: 'cueRaise', len: supportSpec(ctx, 4), hcp: [11, 12], artificial: true }),
      (h, ctx) => supportOf(h, ctx) >= 4 && h.hcp >= 11 && levelOf(jump(ctx, cueSuit(ctx)!)!) <= 3 && bidIndex(jump(ctx, cueSuit(ctx)!)!) < bidIndex(bid(4, xOf(ctx))),
    ),
    // Preemptive raises: four of a major with five, a jump with four (「阻塞」)
    rule(
      (ctx) => (isMajor(xOf(ctx)) ? legal(ctx, bid(4, xOf(ctx))) : null),
      (ctx) => ({ name: 'preemptiveRaise', len: supportSpec(ctx, 5), hcp: [0, 10] }),
      (h, ctx) => supportOf(h, ctx) >= 5 && h.hcp <= 10,
    ),
    rule(
      (ctx) => (levelOf(jump(ctx, xOf(ctx)) ?? '4C') <= 3 ? jump(ctx, xOf(ctx)) : null),
      (ctx) => ({ name: 'preemptiveRaise', len: supportSpec(ctx, 4), hcp: [0, 7] }),
      (h, ctx) => supportOf(h, ctx) >= 4 && h.hcp <= 7,
    ),
    // 「2S 8-10點，3張↑」 (and 11–12 with only three)
    rule(
      (ctx) => (levelOf(cheapest(ctx, xOf(ctx)) ?? '4C') <= 3 ? cheapest(ctx, xOf(ctx)) : null),
      (ctx) => ({ len: supportSpec(ctx, 3), hcp: [8, 12], notes: [{ key: 'support', strain: xOf(ctx) }] }),
      (h, ctx) => supportOf(h, ctx) >= 3 && h.hcp >= 8 && h.hcp <= 12,
    ),
    ntAdvance('1N'),
    // A jump in a new suit 11–13 with a good six (「好牌組」), a new suit 9–12 not forcing
    ...ORDER.map((y) =>
      rule(
        (ctx) => (free(ctx).includes(y) && y !== xOf(ctx) ? jump(ctx, y) : null),
        { len: length(y, 6), hcp: [11, 13], notes: [{ key: 'invite' }] },
        (h, ctx) => longest(h, free(ctx)) === y && h.len[y] >= 6 && topThree(h, y) >= 2 && h.hcp >= 11 && h.hcp <= 13 && levelOf(jump(ctx, y)!) <= 3,
      ),
    ),
    ...ORDER.map((y) =>
      rule(
        (ctx) => (free(ctx).includes(y) && y !== xOf(ctx) ? cheapest(ctx, y) : null),
        (ctx) => ({ len: length(y, 5), hcp: levelOf(cheapest(ctx, y)!) === 1 ? [8, 12] : [9, 12] }),
        (h, ctx) => {
          const call = cheapest(ctx, y)!
          return longest(h, free(ctx)) === y && h.len[y] >= 5 && levelOf(call) <= 2 && h.hcp >= (levelOf(call) === 1 ? 8 : 9) && h.hcp <= 12
        },
      ),
    ),
    pass(),
  ],
}

/** Partner's weak jump overcall: raise to the level of our trumps (總墩數), game with 15+ */
const answerWeakJump: Book = {
  only: (ctx) => advancing(ctx) && partnerLast(ctx) && partnerSaid(ctx) === 'weakJumpOvercall',
  rules: [
    rule(
      (ctx) => {
        const s = strainOf(partnerAction(ctx)!)
        return isMajor(s) ? legal(ctx, bid(4, s)) : null
      },
      (ctx) => ({ len: length(strainOf(partnerAction(ctx)!) as Suit, 3), notes: [{ key: 'support', strain: strainOf(partnerAction(ctx)!) }, { key: 'game' }] }),
      (h, ctx) => {
        const s = strainOf(partnerAction(ctx)!) as Suit
        return (h.len[s] >= 3 && h.hcp >= 15) || h.len[s] >= 4
      },
    ),
    rule(
      (ctx) => (levelOf(cheapest(ctx, strainOf(partnerAction(ctx)!)) ?? '4C') <= 3 ? cheapest(ctx, strainOf(partnerAction(ctx)!)) : null),
      (ctx) => ({ len: length(strainOf(partnerAction(ctx)!) as Suit, 3), notes: [{ key: 'support', strain: strainOf(partnerAction(ctx)!) }] }),
      (h, ctx) => h.len[strainOf(partnerAction(ctx)!) as Suit] >= 3,
    ),
    rule('3N', (ctx) => ({ hcp: plus(16), ...stopSpec(ctx) }), (h, ctx) => h.hcp >= 16 && stopsAll(h, ctx)),
    pass(),
  ],
}

/** Partner's 1NT overcall (15–18): a long major to game, 3NT 10+, 2NT 8–9, a five-card suit to play */
const answerNotrump: Book = {
  only: (ctx) => advancing(ctx) && partnerLast(ctx) && partnerAction(ctx) === '1N',
  more: true,
  rules: [
    ...MAJORS.map((m) => rule((ctx) => (free(ctx).includes(m) ? bid(4, m) : null), { len: length(m, 6), hcp: plus(10), notes: [{ key: 'game' }] }, (h) => h.len[m] >= 6 && h.hcp >= 10)),
    rule('3N', { hcp: plus(10), notes: [{ key: 'game' }] }, (h) => h.hcp >= 10),
    rule('2N', { hcp: [8, 9], notes: [{ key: 'invite' }] }, (h) => h.hcp >= 8 && h.balanced),
    ...ORDER.map((s) =>
      rule(
        (ctx) => (free(ctx).includes(s) && cheapest(ctx, s) === bid(2, s) ? bid(2, s) : null),
        { len: length(s, 5), hcp: [0, 7], notes: [{ key: 'signoff' }] },
        (h, ctx) => longest(h, free(ctx)) === s && h.len[s] >= 5 && h.hcp <= 7,
      ),
    ),
    pass(),
  ],
}

/** Partner's Unusual 2NT: the better minor */
const answerUnusual: Book = {
  only: (ctx) => advancing(ctx) && partnerLast(ctx) && partnerAction(ctx) === '2N' && partnerSaid(ctx) === 'unusual2N',
  rules: [
    rule('5D', { notes: [{ key: 'preference', strain: 'D' }, { key: 'game' }], hcp: plus(12) }, (h) => h.len.D > h.len.C && h.hcp >= 12),
    rule('5C', { notes: [{ key: 'preference', strain: 'C' }, { key: 'game' }], hcp: plus(12) }, (h) => h.len.D <= h.len.C && h.hcp >= 12),
    rule('3D', { notes: [{ key: 'preference', strain: 'D' }] }, (h) => h.len.D > h.len.C),
    rule('3C', { notes: [{ key: 'preference', strain: 'C' }] }),
  ],
}

// ── The overcaller's next call ───────────────────────────────────────────────────────────────

const myOvercall = (ctx: Ctx): Suit | null => {
  const mine = actions(ctx, 'me')
  if (mine.length !== 1 || ctx.said.me?.name !== 'overcall' || !isBid(mine[0])) return null
  const s = strainOf(mine[0])
  return isSuit(s) ? s : null
}

const overcallerRebid: Book = {
  only: (ctx) => theyOpened(ctx) && !!myOvercall(ctx) && actions(ctx, 'partner').length === 1 && partnerLast(ctx) && ['cue', 'cueRaise'].includes(partnerSaid(ctx) ?? ''),
  rules: [
    // After the cue bid (13+): game with six cards in a major and 12+, a jump 12–15, else the suit again
    rule(
      (ctx) => (partnerSaid(ctx) === 'cue' && isMajor(myOvercall(ctx)!) ? legal(ctx, bid(4, myOvercall(ctx)!)) : null),
      (ctx) => ({ len: length(myOvercall(ctx)!, 6), hcp: plus(12), notes: [{ key: 'game' }] }),
      (h, ctx) => h.len[myOvercall(ctx)!] >= 6 && h.hcp >= 12,
    ),
    rule(
      (ctx) => (partnerSaid(ctx) === 'cue' ? jump(ctx, myOvercall(ctx)!) : null),
      (ctx) => ({ len: length(myOvercall(ctx)!, 5), hcp: [12, 15] }),
      (h, ctx) => h.hcp >= 12 && levelOf(jump(ctx, myOvercall(ctx)!)!) <= 3,
    ),
    // After the jump cue bid (11–12, four trumps): game in a major from 12, 3NT with a stopper over a minor
    rule(
      (ctx) => (partnerSaid(ctx) === 'cueRaise' && isMajor(myOvercall(ctx)!) ? legal(ctx, bid(4, myOvercall(ctx)!)) : null),
      { notes: [{ key: 'accept' }] },
      (h, ctx) => h.hcp >= 12 || (h.hcp >= 11 && h.len[myOvercall(ctx)!] >= 6),
    ),
    rule(
      onlyIf((ctx) => partnerSaid(ctx) === 'cueRaise' && !isMajor(myOvercall(ctx)!), '3N'),
      (ctx) => ({ hcp: plus(12), ...stopSpec(ctx) }),
      (h, ctx) => h.hcp >= 12 && stopsAll(h, ctx),
    ),
    rule((ctx) => cheapest(ctx, myOvercall(ctx)!), (ctx) => ({ len: length(myOvercall(ctx)!, 5), hcp: [8, 11], notes: [{ key: 'minimum' }] })),
  ],
}

// ── Support double (支持賭倍, an option: the handbook does not have it) ───────────────────────

/** 淡江橋譜 has no support double; set to true once the club adopts it */
export const SUPPORT_DOUBLE = false

/** 1♣ P 1♥ 1♠ X: exactly three cards in partner's major (two of it shows four) */
export function supportDouble(enabled = SUPPORT_DOUBLE): Book {
  return {
    only: (ctx) => {
      if (!enabled || ctx.opening?.role !== 'me') return false
      const [open, p1, answer, overcall] = ctx.turns
      if (ctx.turns.length !== 4 || p1.call !== 'P' || !isBid(answer.call) || !isBid(overcall.call)) return false
      const m = strainOf(answer.call)
      return levelOf(open.call) === 1 && levelOf(answer.call) === 1 && isMajor(m) && bidIndex(overcall.call) < bidIndex(bid(2, m))
    },
    more: true,
    rules: [
      rule(
        'X',
        (ctx) => ({ name: 'support', len: length(strainOf(ctx.turns[2].call) as Suit, 3, 3), notes: [{ key: 'support', strain: strainOf(ctx.turns[2].call) }] }),
        (h, ctx) => h.len[strainOf(ctx.turns[2].call) as Suit] === 3,
      ),
    ],
  }
}

export const advancingBooks: Book[] = [
  answerCappelletti,
  cappellettiRebid,
  answerMichaels,
  michaelsMinor,
  completeLebensohl,
  afterLebensohl,
  answerDouble,
  doublerRebid,
  answerWeakJump,
  answerNotrump,
  answerUnusual,
  answerOvercall,
  overcallerRebid,
]
