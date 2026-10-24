import { levelOf, strainOf, type Call } from '../../../auction.ts'
import type { Suit } from '../../../cards.ts'
import { cheapest, type Ctx } from '../context.ts'
import type { Hand } from '../evaluate.ts'
import type { Book, Rule, Spec } from '../spec.ts'
import {
  convention,
  aceKings,
  answer,
  answerIs,
  bid,
  cheapestIn,
  cheapestOr,
  isSuit,
  length,
  MAJORS,
  onlyIf,
  ORDER,
  other,
  ours,
  pass,
  plain,
  plus,
  rule,
  shortSuit,
  stopper,
  supportPoints,
  topHonour,
} from './util.ts'

/**
 * After 1♥/1♠ (淡江橋譜「Bergen加叫（松濤版）」「開叫高花之滿貫詢問叫（J2N）」「1H 2H（淡江用）」
 * 「如何對抗弱跳叫2NT兩低」): Bergen raises, splinters, J2N, the three-card single raise with the
 * club's long-suit try, 1NT forcing one round, 2/1 game force; the club's defence to Unusual 2NT.
 */

/** Bergen: the four steps from the cheapest, with what each shows and what opener needs to bid game */
const bergen = (m: Suit) => (m === 'S' ? ['3C', '3D', '3H', '3S'] : ['2N', '3C', '3D', '3H'])
const BERGEN_POINTS: readonly (readonly [number, number])[] = [
  [10, 11],
  [8, 9],
  [6, 7],
  [3, 5],
]
const BERGEN_GAME = [14, 15, 17, 19]
const SUPPORT_POINTS = [10, 8, 6, 4]

/** J2N: 1♠–2NT, 1♥–2♠ */
const j2n = (m: Suit) => (m === 'S' ? '2N' : '2S')
/** Splinters: a void (1♠–3NT, 1♥–3♠), or a singleton */
const voidSplinter = (m: Suit) => (m === 'S' ? '3N' : '3S')
const splinter = (m: Suit, x: Suit) => (m === 'S' ? bid(4, x) : x === 'S' ? '3N' : bid(4, x))
const splinters = (m: Suit) => (m === 'S' ? ['3N', '4C', '4D', '4H'] : ['3S', '3N', '4C', '4D'])

// ── Responses ────────────────────────────────────────────────────────────────────────────────

function responses(m: Suit): Book {
  const spades = m === 'S'
  const four = (h: Hand) => h.len[m] >= 4
  const splinterHand = (h: Hand) => four(h) && h.hcp >= 12 && h.hcp <= 13 && !!shortSuit(h, m)
  const P = { hcp: [0, 5] } as const satisfies Spec
  const rules: Rule[] = [
    convention(rule(voidSplinter(m), { name: 'splinter', len: length(m, 4), hcp: [12, 13], notes: [{ key: 'void' }] }, (h) => splinterHand(h) && h.len[shortSuit(h, m)!] === 0)),
    ...ORDER.filter((x) => x !== m).map((x) =>
      convention(rule(splinter(m, x), { name: 'splinter', len: length(m, 4), hcp: [12, 13], notes: [{ key: 'shortIn', strain: x }] }, (h) => splinterHand(h) && shortSuit(h, m) === x)),
    ),
    convention(rule(j2n(m), { name: 'j2n', len: length(m, 4), hcp: plus(12), forcing: 'game' }, (h) => four(h) && h.hcp >= 12)),
    // The beginner keeps Bergen's natural raise to three and leaves out the artificial steps
    ...bergen(m).map((call, i) => {
      const r = rule(call, { name: 'bergen', len: length(m, 4), hcp: BERGEN_POINTS[i], artificial: call !== bid(3, m) }, (h) => four(h) && supportPoints(h, m) >= SUPPORT_POINTS[i])
      return call === bid(3, m) ? r : convention(r)
    }),
    rule('P', P, four),
    convention(rule(j2n(m), { name: 'j2n', len: length(m, 3, 3), hcp: plus(13), forcing: 'game' }, (h) => h.len[m] === 3 && h.hcp >= 13)),
    rule(bid(2, m), { len: length(m, 3, 3), hcp: [8, 10] }, (h) => h.len[m] === 3 && h.hcp >= 8 && h.hcp <= 10),
    rule('P', P, (h) => h.hcp < 6),
  ]
  if (!spades) rules.push(rule('1S', { len: length('S', 4), hcp: plus(6), forcing: 'oneRound' }, (h) => h.len.S >= 4 && (h.len.H < 3 || h.hcp < 8)))
  const gameForce = (h: Hand) => h.hcp >= 12 && h.len[m] < 3
  if (spades) rules.push(rule('2H', { len: length('H', 5), hcp: plus(12), forcing: 'game' }, (h) => gameForce(h) && h.len.H >= 5))
  rules.push(
    rule('2D', { len: length('D', spades ? 4 : 5), hcp: plus(12), forcing: 'game' }, (h) => gameForce(h) && h.len.D >= (spades ? 4 : 5) && h.len.D > h.len.C),
    rule('2C', { len: length('C', 4), hcp: plus(12), forcing: 'game' }, gameForce),
    rule('1N', { hcp: [6, 12], forcing: 'oneRound' }),
  )
  return { after: `1${m} (P)`, rules }
}

// ── Opener's rebid ───────────────────────────────────────────────────────────────────────────

/** The first side suit of three or more cards with at most one ace or king: a long-suit try */
const weakTry = (h: Hand, m: Suit): Suit | undefined => ORDER.filter((x) => x !== m && h.len[x] >= 3).find((x) => aceKings(h, x) <= 1)

/** The minor to rebid after 1NT forcing: the longer, clubs with 3-3 or better, else diamonds */
const minorRebid = (h: Hand): Suit => (h.len.D > h.len.C ? 'D' : h.len.C > h.len.D ? 'C' : h.len.C >= 3 ? 'C' : 'D')

/** The answers to our major the handbook has a rebid for (anything else: the fallback) */
function handled(m: Suit, call: Call | undefined): boolean {
  if (!call || call === 'P' || call === 'X' || call === 'XX') return false
  const s = strainOf(call)
  if (s === 'N') return levelOf(call) <= 3
  return s !== m || levelOf(call) <= 4
}

function openerRebids(m: Suit): Book {
  const spades = m === 'S'
  const game = bid(4, m)
  const is = (call: Call) => onlyIf(answerIs(call), game)
  const rules: Rule[] = []
  /** Answers with a meaning of their own (a new suit is anything else) */
  const special = [...bergen(m), j2n(m), ...splinters(m), game, bid(2, m), '1N']

  // Bergen raises: game with enough, otherwise three (or pass the preemptive raise)
  bergen(m).forEach((call, i) => {
    rules.push(rule(is(call), { hcp: plus(BERGEN_GAME[i]), notes: [{ key: 'accept' }, { key: 'game' }] }, (h) => h.hcp >= BERGEN_GAME[i]))
    rules.push(rule(onlyIf(answerIs(call), i === 3 ? 'P' : bid(3, m)), i === 3 ? undefined : { notes: [{ key: 'decline' }, { key: 'signoff' }] }))
  })
  // J2N: game, or slam when the hands are clearly strong enough
  rules.push(
    rule(onlyIf(answerIs(j2n(m)), bid(6, m)), { hcp: plus(19), notes: [{ key: 'smallSlam' }] }, (h) => h.hcp >= 19),
    rule(is(j2n(m)), { notes: [{ key: 'game' }] }),
  )
  for (const call of splinters(m))
    rules.push(rule(onlyIf(answerIs(call), bid(6, m)), { hcp: plus(18), notes: [{ key: 'smallSlam' }] }, (h) => h.hcp >= 18), rule(is(call), { notes: [{ key: 'game' }] }))
  rules.push(rule(onlyIf(answerIs(game), 'P')))

  // The single raise, 淡江用: game, a long-suit try, or the invitation
  const raised = answerIs(bid(2, m))
  rules.push(rule(onlyIf(raised, game), { hcp: plus(19), notes: [{ key: 'game' }] }, (h) => h.hcp >= 19))
  for (const x of ORDER.filter((s) => s !== m))
    rules.push(
      convention(
        rule(
          onlyIf(raised, cheapestIn(x)),
          { name: 'longSuitTry', len: length(x, 3), hcp: [16, 18], notes: [{ key: 'tryIn', strain: x }], forcing: 'oneRound' },
          (h, ctx) => h.hcp >= 16 && weakTry(h, m) === x && levelOf(cheapest(ctx, x)!) <= 3,
        ),
      ),
    )
  rules.push(rule(onlyIf(raised, bid(3, m)), { hcp: [16, 18], notes: [{ key: 'invite' }] }, (h) => h.hcp >= 16), rule(onlyIf(raised, 'P')))

  // 1NT forcing one round: always rebid
  const forcing = answerIs('1N')
  rules.push(
    rule(onlyIf(forcing, bid(3, m)), { len: length(m, 6), hcp: [16, 18] }, (h) => h.len[m] >= 6 && h.hcp >= 16),
    rule(onlyIf(forcing, bid(2, m)), { len: length(m, 6), hcp: [12, 15] }, (h) => h.len[m] >= 6),
  )
  if (spades) rules.push(rule(onlyIf(forcing, '2H'), { len: length('H', 4), hcp: [12, 17] }, (h) => h.len.H >= 4))
  rules.push(
    rule(onlyIf(forcing, '2N'), { hcp: [18, 19], balanced: true }, (h) => h.balanced && h.hcp >= 18),
    rule(onlyIf(forcing, '2C'), { len: length('C', 3) }, (h) => minorRebid(h) === 'C'),
    rule(onlyIf(forcing, '2D'), { len: length('D', 3) }),
  )

  // Responder's new suit: 1♠ over 1♥, or a 2/1 game force
  for (const s of ORDER.filter((x) => x !== m)) {
    for (const two of [false, true]) {
      const here = (ctx: Ctx) => strainOf(answer(ctx)) === s && (levelOf(answer(ctx)) === 2) === two && !special.includes(answer(ctx))
      const at = (call: Call | ((ctx: Ctx) => Call | null)) => onlyIf(here, call)
      const fit = (h: Hand) => h.len[s] >= 4 || (s === 'H' && h.len.H >= 3 && two)
      if (!two)
        rules.push(
          rule(at(bid(4, s)), { len: length(s, 4), hcp: [18, 21] }, (h) => fit(h) && h.hcp >= 18),
          rule(at(bid(3, s)), { len: length(s, 4), hcp: [15, 17], notes: [{ key: 'invite' }] }, (h) => fit(h) && h.hcp >= 15),
          rule(at(bid(2, s)), { len: length(s, 4), hcp: [12, 14] }, fit),
        )
      else rules.push(rule(at(bid(3, s)), { len: length(s, s === 'H' ? 3 : 4), notes: [{ key: 'support', strain: s }], forcing: 'game' }, fit))
      rules.push(rule(at((ctx) => cheapestOr(ctx, m)), { len: length(m, 6) }, (h) => h.len[m] >= 6))
      for (const x of ORDER.filter((y) => y !== m && y !== s))
        rules.push(
          rule(at(cheapestIn(x)), { len: length(x, 4) }, (h, ctx) => {
            const side = ORDER.find((y) => y !== m && y !== s && h.len[y] >= 4)
            const call = cheapest(ctx, x)
            return side === x && !!call && levelOf(call) <= (two ? 3 : 2)
          }),
        )
      if (two) rules.push(rule(at('2N'), { balanced: true, forcing: 'game' }, (h) => h.balanced))
      else
        rules.push(
          rule(at('2N'), { hcp: [18, 19], balanced: true }, (h) => h.balanced && h.hcp >= 18),
          rule(at('1N'), { hcp: [12, 14], balanced: true }, (h) => h.balanced),
        )
      rules.push(rule(at((ctx) => cheapestOr(ctx, m)), { len: length(m, 5) }))
    }
  }
  return {
    after: `1${m} (P) * (P)`,
    only: (ctx) => handled(m, answer(ctx)),
    rules,
  }
}

// ── Responder's rebid ────────────────────────────────────────────────────────────────────────

/** After the single raise: answer the long-suit try or the invitation */
function afterRaise(m: Suit): Book {
  const rebid = (ctx: Ctx) => ours(ctx)[2]
  const invited = (ctx: Ctx) => rebid(ctx) === bid(3, m)
  const tried = (ctx: Ctx): Suit | null => {
    const s = strainOf(rebid(ctx))
    return isSuit(s) && s !== m && levelOf(rebid(ctx)) <= 3 ? s : null
  }
  const accepts = (h: Hand, ctx: Ctx) => h.hcp >= 9 || topHonour(h, tried(ctx)!) || h.len[tried(ctx)!] <= 1
  return {
    after: `1${m} (P) 2${m} (P) * (P)`,
    only: (ctx) => invited(ctx) || !!tried(ctx),
    rules: [
      rule(onlyIf(invited, bid(4, m)), { hcp: [10, 10], notes: [{ key: 'accept' }, { key: 'game' }] }, (h) => h.hcp >= 10),
      rule(onlyIf(invited, 'P')),
      rule(onlyIf((ctx) => !invited(ctx), bid(4, m)), { name: 'longSuitTry', notes: [{ key: 'accept' }, { key: 'game' }] }, accepts),
      rule(onlyIf((ctx) => !invited(ctx), bid(3, m)), { name: 'longSuitTry', notes: [{ key: 'decline' }] }),
    ],
  }
}

/** After 1NT forcing: preference with two, the delayed raise with three (otherwise the fallback) */
function afterForcingNotrump(m: Suit): Book {
  const rebidSuit = (ctx: Ctx) => strainOf(ours(ctx)[2])
  return {
    after: `1${m} (P) 1N (P) * (P)`,
    // When the hand fits none of these, the fallback decides
    more: true,
    rules: [
      rule(bid(3, m), { len: length(m, 3, 3), hcp: [10, 12], notes: [{ key: 'invite' }] }, (h) => h.len[m] >= 3 && h.hcp >= 10),
      rule(bid(2, m), { len: length(m, 3, 3), hcp: [6, 9] }, (h) => h.len[m] >= 3),
      rule(bid(2, m), { len: length(m, 2, 2), notes: [{ key: 'preference', strain: m }] }, (h, ctx) => {
        const s = rebidSuit(ctx)
        return h.len[m] === 2 && isSuit(s) && s !== m && h.len[s] < 4
      }),
    ],
  }
}

// ── The opponents' Unusual 2NT (淡江橋譜「如何對抗弱跳叫2NT兩低」) ─────────────────────────

const cues = (m: Suit) => (m === 'H' ? { fit: '3C', other: '3D' } : { fit: '3D', other: '3C' })

function versusUnusual(m: Suit): Book {
  const o = other(m)
  const { fit, other: otherGF } = cues(m)
  return {
    after: `1${m} (2N)`,
    rules: [
      rule(bid(4, m), { len: length(m, 4), hcp: [6, 9], notes: [{ key: 'shortSomewhere' }] }, (h) => h.len[m] >= 4 && h.hcp >= 6 && h.hcp <= 9 && !!shortSuit(h, m)),
      convention(rule(fit, { name: 'unusualVsUnusual', len: length(m, 3), hcp: plus(10), forcing: 'oneRound', artificial: true }, (h) => h.len[m] >= 3 && h.hcp >= 10)),
      convention(rule(otherGF, { name: 'unusualVsUnusual', len: length(o, 5), hcp: plus(13), forcing: 'game', artificial: true }, (h) => h.len[o] >= 5 && h.hcp >= 13)),
      rule(bid(3, o), { len: length(o, 5), hcp: [8, 12] }, (h) => (h.len[o] >= 5 && h.hcp >= 10) || (h.len[o] >= 6 && h.hcp >= 8)),
      rule(bid(3, m), { len: length(m, 3), hcp: [6, 9] }, (h) => h.len[m] >= 3 && h.hcp >= 6),
      rule('X', { name: 'penalty', balanced: true, hcp: plus(10) }, (h) => h.balanced && h.hcp >= 10),
      pass(),
    ],
  }
}

function openerVersusUnusual(m: Suit): Book {
  const o = other(m)
  const { fit, other: otherGF } = cues(m)
  const after = (call: Call, then: Call) => onlyIf(answerIs(call), then)
  return {
    after: `1${m} (2N) * (*)`,
    only: (ctx) => answer(ctx) !== 'P',
    rules: [
      plain(after(fit, bid(4, m)), (h) => h.hcp >= 15),
      plain(after(fit, bid(3, m))),
      plain(after(otherGF, bid(4, o)), (h) => h.len[o] >= 3),
      plain(after(otherGF, bid(4, m)), (h) => h.len[m] >= 6),
      plain(after(otherGF, '3N'), (h) => stopper(h, 'C') && stopper(h, 'D')),
      plain(after(otherGF, bid(4, m))),
      plain(after(bid(3, o), bid(4, o)), (h) => h.len[o] >= 3 && h.hcp >= 14),
      plain(after(bid(3, m), bid(4, m)), (h) => h.hcp >= 17),
      pass(),
    ],
  }
}

// ── 2♦, a weak two in one major (淡江橋譜「2D 開叫（一高弱二）」) ───────────────────────────────

const weakTwoResponses: Book = {
  after: '2D (P)',
  rules: [
    rule('2N', { name: 'ask', hcp: plus(15), forcing: 'oneRound', artificial: true }, (h) => h.hcp >= 15),
    rule('3C', { len: length('C', 6), hcp: plus(12), forcing: 'oneRound' }, (h) => h.hcp >= 12 && h.len.C >= 6 && h.len.C >= h.len.D),
    rule('3D', { len: length('D', 6), hcp: plus(12), forcing: 'oneRound' }, (h) => h.hcp >= 12 && h.len.D >= 6),
    rule('4H', { name: 'passOrCorrect', len: { H: [3, 13], S: [3, 13] }, hcp: plus(13), notes: [{ key: 'choiceOf', calls: ['4H', '4S'] }] }, (h) => h.hcp >= 13 && h.len.H >= 3 && h.len.S >= 3),
    rule('P', undefined, (h) => h.len.D >= 5 && h.len.H <= 1 && h.len.S <= 1),
    rule('2S', { name: 'passOrCorrect', len: { H: [0, 1], S: [3, 13] } }, (h) => h.len.H <= 1 && h.len.S >= 3),
    rule('2H', { name: 'passOrCorrect' }),
  ],
}

/** The major of our weak two */
const weakMajor = (h: Hand): Suit => (h.len.H >= 6 ? 'H' : 'S')

const weakTwoRebids: Book = {
  after: '2D (P) * (P)',
  only: (ctx) => answer(ctx) !== 'P',
  rules: [
    ...(
      [
        ['3C', 'H', false],
        ['3D', 'S', false],
        ['3H', 'S', true],
        ['3S', 'H', true],
      ] as const
    ).map(([call, m, high]) =>
      rule(onlyIf(answerIs('2N'), call), { len: length(m, 6, 6), hcp: high ? [9, 10] : [6, 8], notes: [{ key: high ? 'maximum' : 'minimum' }], artificial: true }, (h) => weakMajor(h) === m && h.hcp >= 9 === high),
    ),
    // Pass or correct: pass in our major, otherwise bid it
    ...(
      [
        ['2H', 'H', '2S'],
        ['2S', 'S', '3H'],
        ['3H', 'H', '3S'],
        ['3S', 'S', '4H'],
        ['4H', 'H', '4S'],
      ] as const
    ).flatMap(([asked, m, correct]): Rule[] => [
      rule(onlyIf(answerIs(asked), 'P'), undefined, (h) => weakMajor(h) === m),
      rule(onlyIf(answerIs(asked), correct), { len: length(other(m), 6, 6) }),
    ]),
    pass(),
  ],
}

/** After 2♦–2NT and opener's answer: game or a sign-off in opener's major */
const weakTwoPlacing: Book = {
  after: '2D (P) * (P) * (P)',
  rules: [
    ...MAJORS.flatMap((m): Rule[] => {
      const isM = (ctx: Ctx) => ours(ctx)[1] === '2N' && answerMajor(ctx) === m
      return [
        rule(onlyIf(isM, bid(4, m)), { notes: [{ key: 'game' }] }, (h, ctx) => h.hcp + (answerHigh(ctx) ? 9 : 7) >= 24 && h.len[m] >= 2),
        rule(onlyIf(isM, bid(3, m)), { notes: [{ key: 'signoff' }] }, (h) => h.len[m] >= 2),
        rule(onlyIf(isM, '3N'), { notes: [{ key: 'signoff' }] }),
      ]
    }),
    pass(),
  ],
}

const answerMajor = (ctx: Ctx): Suit => (ours(ctx)[2] === '3C' || ours(ctx)[2] === '3S' ? 'H' : 'S')
const answerHigh = (ctx: Ctx) => ours(ctx)[2] === '3H' || ours(ctx)[2] === '3S'

export const majors: Book[] = [
  ...MAJORS.flatMap((m) => [responses(m), openerRebids(m), afterRaise(m), afterForcingNotrump(m)]),
  weakTwoResponses,
  weakTwoRebids,
  weakTwoPlacing,
]

/** Opponents bid Unusual 2NT over our major (both sides of the partnership) */
export const unusual: Book[] = MAJORS.flatMap((m) => [versusUnusual(m), openerVersusUnusual(m)])

