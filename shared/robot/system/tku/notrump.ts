import { isBid, levelOf, strainOf } from '../../../auction.ts'
import type { Suit } from '../../../cards.ts'
import type { Ctx } from '../context.ts'
import type { Hand } from '../evaluate.ts'
import type { Book, Rule } from '../spec.ts'
import { answer, answerIs, bid, contested, fiveCard, iOpened, isMajor, length, onlyIf, ORDER, other, ours, overcallOf, overcallSuit, partnerOpened, pass, plus, reads, rule, stopper } from './util.ts'

/**
 * 1NT (淡江橋譜「1NT的答叫」「雷本索特約」): 2♣ Stayman, 2♦/2♥ transfers, 2♠ minor ask, 2NT
 * invitation, 3NT, 4♦/4♥ Texas, 4NT quantitative; Lebensohl when the opponents overcall.
 */

/** A five-card or longer major (spades with equal length), if any */
const longMajor = (h: Hand): Suit | null => (h.len.S >= 5 && h.len.S >= h.len.H ? 'S' : h.len.H >= 5 ? 'H' : null)
const fourMajor = (h: Hand) => h.len.H === 4 || h.len.S === 4

// ── Responses ────────────────────────────────────────────────────────────────────────────────

const stayman = { name: 'stayman', hcp: plus(9), artificial: true, forcing: 'oneRound', notes: [{ key: 'asksMajor' }] } as const

const responses: Book = {
  after: '1N (P)',
  rules: [
    rule('4D', { name: 'texas', len: length('H', 6), hcp: [10, 15], notes: [{ key: 'transferTo', strain: 'H' }] }, (h) => longMajor(h) === 'H' && h.len.H >= 6 && h.hcp >= 10 && h.hcp <= 15),
    rule('4H', { name: 'texas', len: length('S', 6), hcp: [10, 15], notes: [{ key: 'transferTo', strain: 'S' }] }, (h) => longMajor(h) === 'S' && h.len.S >= 6 && h.hcp >= 10 && h.hcp <= 15),
    // Five of one major and four of the other: Stayman with invitational values
    rule('2C', stayman, (h) => !!longMajor(h) && h.len[other(longMajor(h)!)] === 4 && h.hcp >= 9),
    rule('2D', { name: 'transfer', len: length('H', 5), artificial: true, notes: [{ key: 'transferTo', strain: 'H' }] }, (h) => longMajor(h) === 'H'),
    rule('2H', { name: 'transfer', len: length('S', 5), artificial: true, notes: [{ key: 'transferTo', strain: 'S' }] }, (h) => longMajor(h) === 'S'),
    rule('2C', stayman, (h) => fourMajor(h) && h.hcp >= 9),
    rule('2S', { name: 'minorAsk', hcp: [0, 7], artificial: true }, (h) => h.hcp < 8 && (h.len.C >= 6 || h.len.D >= 6)),
    rule('6N', { hcp: [17, 19], notes: [{ key: 'smallSlam' }] }, (h) => h.hcp >= 17 && h.hcp <= 19),
    rule('4N', { name: 'quantitative', hcp: [16, 16], notes: [{ key: 'noMajor' }] }, (h) => h.hcp === 16),
    rule('3N', { hcp: [10, 15], notes: [{ key: 'noMajor' }, { key: 'toPlay' }] }, (h) => h.hcp >= 10),
    rule('2N', { hcp: [8, 9], notes: [{ key: 'noMajor' }, { key: 'invite' }] }, (h) => h.hcp >= 8),
    // Three of a suit is not in the handbook: read as five cards and game values
    ...ORDER.map((s) => reads(bid(3, s), { len: length(s, 5), hcp: plus(12) })),
    pass({ hcp: [0, 7] }),
  ],
}

// ── Opener's rebid ───────────────────────────────────────────────────────────────────────────

const openerRebids: Book[] = [
  {
    after: '1N (P) 2C (P)',
    rules: [
      rule('2H', { name: 'stayman', len: length('H', 4), hcp: [15, 17] }, (h) => h.len.H >= 4),
      rule('2S', { name: 'stayman', len: { H: [0, 3], S: [4, 13] }, hcp: [15, 17] }, (h) => h.len.S >= 4),
      rule('2D', { name: 'stayman', notes: [{ key: 'noMajor' }], artificial: true }),
    ],
  },
  ...(['H', 'S'] as const).map(
    (m): Book => ({
      after: `1N (P) ${m === 'H' ? '2D' : '2H'} (P)`,
      rules: [
        rule(bid(3, m), { name: 'superAccept', len: length(m, 4), hcp: [17, 17] }, (h) => h.len[m] >= 4 && h.hcp >= 17),
        rule(bid(2, m), { name: 'transfer', notes: [{ key: 'completes' }] }),
      ],
    }),
  ),
  { after: '1N (P) 4D (P)', rules: [rule('4H', { name: 'texas', notes: [{ key: 'completes' }] })] },
  { after: '1N (P) 4H (P)', rules: [rule('4S', { name: 'texas', notes: [{ key: 'completes' }] })] },
  {
    after: '1N (P) 2S (P)',
    rules: [
      rule('3C', { name: 'minorAsk', notes: [{ key: 'preference', strain: 'C' }] }, (h) => h.len.C >= h.len.D),
      rule('2N', { name: 'minorAsk', notes: [{ key: 'preference', strain: 'D' }], artificial: true }),
    ],
  },
  { after: '1N (P) 2N (P)', rules: [rule('3N', { hcp: [16, 17], notes: [{ key: 'accept' }] }, (h) => h.hcp >= 16), pass()] },
  { after: '1N (P) 4N (P)', rules: [rule('6N', { hcp: [16, 17], notes: [{ key: 'accept' }] }, (h) => h.hcp >= 16), pass()] },
  {
    after: ORDER.map((s) => `1N (P) 3${s} (P)`),
    rules: [
      ...ORDER.map((s) => rule(onlyIf(answerIs(bid(3, s)), bid(4, s)), { len: length(s, 3), notes: [{ key: 'support', strain: s }] }, (h) => h.len[s] >= 3)),
      rule('3N', { notes: [{ key: 'toPlay' }] }),
    ],
  },
  // Anything else partner bids over 1NT: the handbook stops there
  { after: '1N (P) * (P)', rules: [pass()] },
]

// ── Responder's rebid ────────────────────────────────────────────────────────────────────────

const afterTransfer = (m: Suit): Book => {
  const superAccepted = (ctx: Ctx) => ours(ctx)[2] === bid(3, m)
  return {
    after: `1N (P) ${m === 'H' ? '2D' : '2H'} (P) * (P)`,
    rules: [
      rule(bid(4, m), { notes: [{ key: 'accept' }, { key: 'game' }] }, (h, ctx) => superAccepted(ctx) && h.hcp >= 5),
      rule('P', undefined, (_h, ctx) => superAccepted(ctx)),
      rule(bid(3, m), { len: length(m, 6), hcp: [8, 9], notes: [{ key: 'invite' }] }, (h) => h.len[m] >= 6 && h.hcp >= 8),
      rule('P', undefined, (h) => h.len[m] >= 6),
      rule('3N', { len: length(m, 5, 5), hcp: plus(10), notes: [{ key: 'choiceOf', calls: ['3N', bid(4, m)] }] }, (h) => h.hcp >= 10),
      rule('2N', { len: length(m, 5, 5), hcp: [8, 9], notes: [{ key: 'invite' }] }, (h) => h.hcp >= 8),
      pass(),
    ],
  }
}

const afterStayman: Book = {
  after: '1N (P) 2C (P) * (P)',
  rules: [
    ...(['H', 'S'] as const).flatMap((s): Rule[] => [
      rule(bid(4, s), { len: length(s, 4), hcp: plus(10), notes: [{ key: 'game' }] }, (h, ctx) => staymanAnswer(ctx) === s && h.len[s] >= 4 && h.hcp >= 10),
      rule(bid(3, s), { len: length(s, 4), hcp: [9, 9], notes: [{ key: 'invite' }] }, (h, ctx) => staymanAnswer(ctx) === s && h.len[s] >= 4),
    ]),
    rule('2N', { len: length('S', 4, 4), hcp: [9, 9], notes: [{ key: 'invite' }] }, (h, ctx) => staymanAnswer(ctx) === 'H' && h.len.S >= 4 && h.hcp < 10),
    rule('3N', { hcp: plus(10), notes: [{ key: 'toPlay' }] }, (h) => h.hcp >= 10),
    rule('2N', { hcp: [9, 9], notes: [{ key: 'invite' }] }),
  ],
}

/** Opener's answer to Stayman */
const staymanAnswer = (ctx: Ctx) => strainOf(ours(ctx)[2])

const afterMinorAsk: Book = {
  after: '1N (P) 2S (P) * (P)',
  rules: [
    rule('P', undefined, (h, ctx) => h.len.C >= 6 && ours(ctx)[2] === '3C'),
    rule('3C', { len: length('C', 6), notes: [{ key: 'signoff' }] }, (h) => h.len.C >= 6),
    rule('3D', { len: length('D', 6), notes: [{ key: 'signoff' }] }),
  ],
}

// ── Lebensohl: partner's 1NT and an overcall at the two level ────────────────────────────────

/** Partner opened 1NT, the next player bid a suit at the two level, and this is our first call */
const lebensohlHere = (ctx: Ctx) => {
  const call = overcallOf(ctx)
  return partnerOpened(ctx) && ours(ctx).length === 1 && !!call && isBid(call) && levelOf(call) === 2 && !!overcallSuit(ctx)
}

const theirs = (ctx: Ctx) => overcallSuit(ctx)!

const lebensohl: Book = {
  after: '1N (+)',
  only: lebensohlHere,
  rules: [
    rule('X', (ctx) => ({ name: 'penalty', len: length(theirs(ctx), 4), hcp: plus(8) }), (h, ctx) => h.len[theirs(ctx)] >= 4 && h.hcp >= 8),
    ...ORDER.map((s) =>
      rule(bid(3, s), { len: length(s, 5), hcp: plus(10), forcing: 'game' }, (h, ctx) => fiveCard(h, [theirs(ctx)]) === s && h.hcp >= 10),
    ),
    rule('2N', (ctx) => ({ name: 'lebensohl', hcp: plus(10), stop: { [theirs(ctx)]: 'stop' }, notes: [{ key: 'relayTo', calls: ['3C'] }], artificial: true }), (h, ctx) => h.hcp >= 10 && stopper(h, theirs(ctx))),
    rule('3N', { hcp: plus(10), notes: [{ key: 'toPlay' }] }, (h) => h.hcp >= 10),
    ...ORDER.map((s) =>
      rule(bid(2, s), { len: length(s, 5), hcp: [5, 8], notes: [{ key: 'signoff' }] }, (h, ctx) => fiveCard(h, [theirs(ctx)]) === s && h.hcp >= 5 && ctx.legal.has(bid(2, s))),
    ),
    rule('2N', { name: 'lebensohl', hcp: [5, 9], notes: [{ key: 'relayTo', calls: ['3C'] }], artificial: true }, (h, ctx) => {
      const five = fiveCard(h, [theirs(ctx)])
      return !!five && h.hcp >= 5 && h.len[five] >= 6
    }),
    pass(),
  ],
}

/** After 1NT (overcall) 2NT (pass) 3♣ (pass): game with a stopper, or a long suit to play */
const lebensohlRebid: Book = {
  only: (ctx) => partnerOpened(ctx) && contested(ctx) && ours(ctx).join(' ') === '1N 2N 3C',
  rules: [
    rule('3N', (ctx) => ({ hcp: plus(10), ...(overcallSuit(ctx) ? { stop: { [overcallSuit(ctx)!]: 'stop' } } : {}), notes: [{ key: 'toPlay' }] }), (h) => h.hcp >= 10),
    rule('P', undefined, (h, ctx) => {
      const long = fiveCard(h, [overcallSuit(ctx) ?? undefined], 6)
      return !long || long === 'C'
    }),
    ...ORDER.filter((s) => s !== 'C').map((s) =>
      rule(bid(3, s), { len: length(s, 6), notes: [{ key: 'signoff' }] }, (h, ctx) => fiveCard(h, [overcallSuit(ctx) ?? undefined], 6) === s),
    ),
  ],
}

/** We opened 1NT and the opponents came in: complete the relay, leave partner's double in */
const openerContested: Book = {
  only: (ctx) => iOpened(ctx) && opened1N(ctx) && contested(ctx) && ours(ctx).length === 2 && answer(ctx) !== 'P',
  rules: [
    rule(onlyIf(answerIs('2N'), '3C'), { name: 'lebensohl', notes: [{ key: 'completes' }] }),
    rule(onlyIf(answerIs('X'), 'P')),
    ...ORDER.flatMap((s): Rule[] => {
      const at3 = answerIs(bid(3, s))
      return isMajor(s)
        ? [
            rule(onlyIf(at3, bid(4, s)), { len: length(s, 3), notes: [{ key: 'game' }] }, (h) => h.len[s] >= 3),
            rule(onlyIf(at3, '3N'), (ctx) => ({ ...theirStop(ctx), notes: [{ key: 'choiceOf', calls: ['3N'] }] }), (h, ctx) => !!overcallSuit(ctx) && stopper(h, overcallSuit(ctx)!)),
            rule(onlyIf(at3, bid(4, s)), { notes: [{ key: 'preference', strain: s }] }),
          ]
        : [rule(onlyIf(at3, '3N'), { notes: [{ key: 'toPlay' }] })]
    }),
    pass(),
  ],
}

/** A stopper in the opponents' suit */
const theirStop = (ctx: Ctx) => (overcallSuit(ctx) ? { stop: { [overcallSuit(ctx)!]: 'stop' as const } } : {})

const opened1N = (ctx: Ctx) => ctx.opening?.call === '1N'

export const notrump: Book[] = [responses, ...openerRebids, afterTransfer('H'), afterTransfer('S'), afterStayman, afterMinorAsk, lebensohl, lebensohlRebid, openerContested]

