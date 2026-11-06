import { isBid, levelOf, strainOf, type Call } from '../../../auction.ts'
import type { Suit } from '../../../cards.ts'
import { cheapest, type Ctx } from '../context.ts'
import type { Hand } from '../evaluate.ts'
import type { Book, Range, Rule, Spec } from '../spec.ts'
import { bid, goodSuit, isMajor, longest, plus, STRONG, SUITS_DOWN, UP } from './util.ts'

/** After the strong 1♣, docs/systems/precision.md §2 */

/** No suit of five: 4333, 4432 or 4441 */
const noFive = (h: Hand) => h.shape[0] <= 4
const FLAT: Spec['len'] = { S: [0, 4], H: [0, 4], D: [0, 4], C: [0, 4] }
/** The suit to show: the longest, the higher of equal ones */
const myLongest = (h: Hand, s: Suit) => longest(h) === s

// ── Responses ─────────────────────────────────────────────────────────────────────────────────

const jumpResponse = (s: Suit, level: number, length: number): Rule => ({
  call: bid(level, s),
  shows: { len: { [s]: [length, 13] }, hcp: [4, 7] },
  when: (h) => goodSuit(h, s),
})

const positive = (s: Suit): Rule => ({
  call: bid(isMajor(s) ? 1 : 2, s),
  shows: { len: { [s]: [5, 13] }, hcp: plus(8), notes: [{ key: 'positive' }], forcing: 'game' },
  when: (h) => myLongest(h, s),
})

const responses: Rule[] = [
  // Balanced or 4441, no five-card suit
  { call: '3N', shows: { len: FLAT, hcp: [14, 15], notes: [{ key: 'positive' }], forcing: 'game' } },
  { call: '2N', shows: { len: FLAT, hcp: [11, 13], notes: [{ key: 'positive' }], forcing: 'game' } },
  { call: '2N', shows: { len: FLAT, hcp: plus(16), notes: [{ key: 'positive' }], forcing: 'game' } },
  { call: '1N', shows: { len: FLAT, hcp: [8, 10], notes: [{ key: 'positive' }], forcing: 'game' } },
  ...SUITS_DOWN.map(positive),
  ...SUITS_DOWN.map((s) => jumpResponse(s, 3, 7)),
  jumpResponse('S', 2, 6),
  jumpResponse('H', 2, 6),
  { call: '1D', shows: { name: 'clubNegative', hcp: [0, 7], artificial: true } },
]

// ── Opener after the negative ────────────────────────────────────────────────────────────────

/** Opener after 1♣–1♦ (or a double and a pass or 1♦): notrump by range, otherwise the longest suit */
const afterNegative: Rule[] = [
  { call: '3N', shows: { hcp: plus(25), balanced: true } },
  // A five-card major is shown first; a five-card minor may be in the notrump
  { call: '2N', shows: { hcp: [19, 21], balanced: true }, when: (h) => h.len.S < 5 && h.len.H < 5 },
  { call: '1N', shows: { hcp: [16, 18], balanced: true }, when: (h) => h.len.S < 5 && h.len.H < 5 },
  // A jump in the suit forces to game
  ...SUITS_DOWN.map(
    (s): Rule => ({
      call: bid(isMajor(s) ? 2 : 3, s),
      shows: { len: { [s]: [5, 13] }, hcp: plus(20), forcing: 'game' },
      when: (h) => myLongest(h, s),
    }),
  ),
  ...SUITS_DOWN.map(
    (s): Rule => ({
      call: bid(isMajor(s) ? 1 : 2, s),
      shows: { len: { [s]: [4, 13] }, hcp: [16, 19] },
      when: (h) => myLongest(h, s),
    }),
  ),
]

/** Opener after a positive suit response: raise, notrump, or the longest other suit; a game force */
function afterPositive(y: Suit): Rule[] {
  const support = isMajor(y) ? 3 : 4
  return [
    { call: (ctx) => cheapest(ctx, y), shows: { len: { [y]: [support, 13] }, notes: [{ key: 'support', strain: y }], forcing: 'game' }, when: (h) => h.len[y] >= support },
    { call: (ctx) => cheapest(ctx, 'N'), shows: { hcp: STRONG, balanced: true, forcing: 'game' } },
    ...UP.filter((s) => s !== y).map(
      (s): Rule => ({
        call: (ctx) => cheapest(ctx, s),
        shows: { len: { [s]: [4, 13] }, forcing: 'game' },
        when: (h) => longest(h, UP.filter((t) => t !== y)) === s,
      }),
    ),
  ]
}

// ── Second rounds after the negative ─────────────────────────────────────────────────────────

/** Responder after 1♣–1♦–suit (not forcing): a raise, a five-card suit, 1NT, else pass; never more with 7 at most */
function afterRebid(y: Suit): Rule[] {
  const support = isMajor(y) ? 3 : 4
  return [
    { call: (ctx) => cheapest(ctx, y), shows: { len: { [y]: [support, 13] }, hcp: [4, 7], notes: [{ key: 'support', strain: y }] }, when: (h) => h.len[y] >= support },
    ...UP.filter((s) => s !== y).map(
      (s): Rule => ({
        call: (ctx) => {
          const call = cheapest(ctx, s)
          return call && levelOf(call) <= 2 ? call : null
        },
        shows: { len: { [s]: [5, 13] }, hcp: [3, 7] },
        when: (h) => longest(h, UP.filter((t) => t !== y)) === s,
      }),
    ),
    {
      call: (ctx) => {
        const call = cheapest(ctx, 'N')
        return call && levelOf(call) === 1 ? call : null
      },
      shows: { hcp: [4, 7] },
    },
    { call: 'P', shows: {} },
  ]
}

/** Opener after 1♣–1♦–suit–1NT: a second suit or a six-card first suit rather than play notrump */
function afterRebidNotrump(y: Suit): Rule[] {
  return [
    ...UP.filter((s) => s !== y).map(
      (s): Rule => ({
        call: (ctx) => cheapest(ctx, s),
        shows: { len: { [s]: [4, 13] } },
        when: (h) => !h.balanced && longest(h, UP.filter((t) => t !== y)) === s,
      }),
    ),
    { call: (ctx) => cheapest(ctx, y), shows: { len: { [y]: [6, 13] } } },
  ]
}

// ── Interference ─────────────────────────────────────────────────────────────────────────────

/** Their suit when they overcalled 1♣ with a suit bid; null for notrump */
function theirSuit(ctx: Ctx): Suit | null {
  const call = ctx.turns[1]?.call
  if (!call || !isBid(call) || strainOf(call) === 'N') return null
  return strainOf(call) as Suit
}

/** A new suit at its cheapest level, up to the three level: 5+ and 8+ as without the overcall */
const naturalOver = (s: Suit): Rule => ({
  call: (ctx: Ctx): Call | null => {
    const call = cheapest(ctx, s)
    return call && theirSuit(ctx) !== s && levelOf(call) <= 3 ? call : null
  },
  shows: { len: { [s]: [5, 13] }, hcp: plus(8), notes: [{ key: 'positive' }], forcing: 'game' },
  when: (h, ctx) => longest(h, UP.filter((t) => t !== theirSuit(ctx))) === s,
})

/** Over an overcall of 1♣: a natural positive, notrump with a stopper, the cue bid without one, double 5–7, pass 0–4 */
const overOvercall: Rule[] = [
  ...SUITS_DOWN.map(naturalOver),
  {
    call: (ctx) => {
      const call = cheapest(ctx, 'N')
      return call && levelOf(call) <= 3 ? call : null
    },
    shows: (ctx): Spec => {
      const theirs = theirSuit(ctx)
      return { hcp: plus(8), ...(theirs ? { stop: { [theirs]: 'stop' as const } } : {}), notes: [{ key: 'positive' }], forcing: 'game' }
    },
    when: (h, ctx) => {
      const theirs = theirSuit(ctx)
      return noFive(h) && (!theirs || h.stop[theirs] === 'stop' || h.stop[theirs] === 'double')
    },
  },
  {
    call: (ctx) => {
      const theirs = theirSuit(ctx)
      return theirs ? cheapest(ctx, theirs) : null
    },
    shows: { name: 'cue', hcp: plus(8), forcing: 'game', artificial: true },
  },
  {
    call: 'X',
    shows: (ctx): Spec => (theirSuit(ctx) ? { name: 'negative', hcp: [5, 7], forcing: 'oneRound' } : { name: 'penalty', hcp: plus(8) }),
  },
  { call: 'P', shows: (ctx): Spec => ({ hcp: theirSuit(ctx) ? [0, 4] : [0, 7] }) },
]

/** The suit the opponents bid last, when they bid one */
function lastTheirs(ctx: Ctx): Suit | null {
  const call = ctx.turns.findLast((t) => !t.ours && isBid(t.call))?.call
  return call && strainOf(call) !== 'N' ? (strainOf(call) as Suit) : null
}

/**
 * Opener when partner has shown little and the opponents bid (1♣–1♦–overcall, or 1♣–overcall–pass–
 * pass): a strong hand does not sell out at a low level. A five-card suit, notrump with a stopper,
 * or a takeout double with `double` or more
 */
const openerOverInterference = (suit: number, double: number): Rule[] => [
  ...SUITS_DOWN.map(
    (s): Rule => ({
      call: (ctx: Ctx): Call | null => {
        const call = cheapest(ctx, s)
        return call && lastTheirs(ctx) !== s && levelOf(call) <= 3 ? call : null
      },
      shows: { len: { [s]: [5, 13] }, hcp: plus(suit) },
      when: (h, ctx) => longest(h, UP.filter((t) => t !== lastTheirs(ctx))) === s,
    }),
  ),
  {
    call: (ctx) => {
      const call = cheapest(ctx, 'N')
      return call && lastTheirs(ctx) && levelOf(call) <= 2 ? call : null
    },
    shows: (ctx): Spec => ({ hcp: plus(suit), balanced: true, stop: { [lastTheirs(ctx)!]: 'stop' } }),
  },
  {
    call: (ctx) => (lastTheirs(ctx) && levelOf(ctx.last!.call) <= 3 ? 'X' : null),
    shows: (ctx): Spec => ({ name: 'takeout', hcp: plus(double), len: { [lastTheirs(ctx)!]: [0, 2] }, forcing: 'oneRound' }),
  },
]

/** Opener after the cue bid (8+, no five-card suit, no stopper): a major first, then notrump or a long minor */
const afterCue: Rule[] = [
  ...(['S', 'H'] as Suit[]).map(
    (M): Rule => ({
      call: (ctx: Ctx) => (theirSuit(ctx) === M ? null : cheapest(ctx, M)),
      shows: { len: { [M]: [4, 13] }, forcing: 'game' },
      when: (h) => h.len[M] >= (M === 'S' ? Math.max(4, h.len.H) : 4),
    }),
  ),
  {
    call: (ctx) => cheapest(ctx, 'N'),
    shows: (ctx): Spec => ({ stop: { [theirSuit(ctx)!]: 'stop' }, forcing: 'game' }),
  },
]

/** Opener over a notrump response: a five-card suit himself, so the strong hand declares it (2♣ or 3♣ is Stayman) */
const naturalOverNotrump = (level: 2 | 3): Rule[] =>
  SUITS_DOWN.filter((s) => !(s === 'C' && level === 2)).map(
    (s): Rule => ({
      call: bid(s === 'C' ? level + 1 : level === 2 ? 2 : 3, s),
      shows: { len: { [s]: [5, 13] }, forcing: 'game' },
      when: (h) => longest(h) === s,
    }),
  )

/** Over a double of 1♣: pass 0–4, 1♦ 5–7, redouble 8+ with no five-card suit, a suit positive as usual */
const overDouble: Rule[] = [
  { call: 'XX', shows: { len: FLAT, hcp: plus(8), notes: [{ key: 'positive' }], forcing: 'game' } },
  ...SUITS_DOWN.map(positive),
  { call: '1D', shows: { name: 'clubNegative', hcp: [5, 7], artificial: true } },
  { call: 'P', shows: { hcp: [0, 4] } },
]

// ── The books ────────────────────────────────────────────────────────────────────────────────

/** The ranges of the notrump rebids, for their responses (`index.ts`) */
export const REBID_1N: Range = [16, 18]
export const REBID_2N: Range = [19, 21]

const books: Book[] = [
  { after: '1C (P)', rules: responses, more: true },
  { after: ['1C (P) 1D (P)', '1C (X) P (P)', '1C (X) 1D (P)'], rules: afterNegative, more: true },
  { after: '1C (X)', rules: overDouble, more: true },
  { after: '1C (+)', only: (ctx) => ctx.turns[1]?.call !== 'X', rules: overOvercall, more: true },
]
for (const y of UP) {
  const low = bid(isMajor(y) ? 1 : 2, y)
  books.push(
    { after: `1C (P) ${low} (P)`, rules: afterPositive(y), more: true },
    { after: `1C (P) 1D (P) ${low} (P)`, rules: afterRebid(y), more: true },
    { after: `1C (P) 1D (P) ${low} (P) 1N (P)`, rules: afterRebidNotrump(y), more: true },
  )
}
const suitOvercall = (ctx: Ctx) => !!lastTheirs(ctx)
books.push(
  { after: '1C (P) 1D (+)', only: suitOvercall, rules: openerOverInterference(16, 18), more: true },
  { after: '1C (+) P (P)', only: (ctx) => ctx.turns[1]?.call !== 'X' && suitOvercall(ctx), rules: openerOverInterference(18, 19), more: true },
  { after: '1C (+) * (P)', only: (ctx) => ctx.said.partner?.name === 'cue', rules: afterCue, more: true },
  { after: '1C (P) 1N (P)', rules: naturalOverNotrump(2), more: true },
  { after: '1C (P) 2N (P)', rules: naturalOverNotrump(3), more: true },
)

export const club: readonly Book[] = books
