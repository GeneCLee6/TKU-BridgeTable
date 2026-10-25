import { levelOf, strainOf, type Call } from '../../../auction.ts'
import type { Suit } from '../../../cards.ts'
import { cheapest, type Ctx } from '../context.ts'
import type { Hand } from '../evaluate.ts'
import type { Book, Rule } from '../spec.ts'
import { bid, isMajor, isSuit, length, longest, onlyIf, ORDER, ours, plain, plus, reads, rule, shortSuit } from './util.ts'

/**
 * 2♣ strong (淡江橋譜「開叫2♣」, 22 points or more): 2♦ waiting and 2♥ 0–3 points are the only
 * answers in the handbook, so the robot makes no positive answer (it reads one as a natural five-card
 * suit with 8 points); opener's 2NT 22–24, 3NT 25–27 and 4NT 28–30 balanced, otherwise the long
 * suit; after 2♣ 2♦ 2♥/2♠ responder bids 2NT without a fit, 3 of the major with values and support,
 * 4 of the major to sign off, splinters with a fit, or a five-card suit of their own.
 */

/** 2♣–2♥: 0–3 points (the handbook's only weak answer) */
const BUST = [0, 3] as const

const responses: Book = {
  after: '2C (P)',
  rules: [
    rule('2H', { name: 'doubleNegative', hcp: [...BUST], artificial: true }, (h) => h.hcp <= 3),
    rule('2D', { name: 'waiting', hcp: plus(4), artificial: true }),
    // Not in the handbook: read as a natural positive answer when a person makes it
    ...(['S', 'C', 'D'] as const).map((s) => reads(isMajor(s) ? bid(2, s) : bid(3, s), { len: length(s, 5), hcp: plus(8), notes: [{ key: 'positive' }] })),
    reads('2N', { hcp: plus(8), balanced: true, notes: [{ key: 'positive' }] }),
  ],
}

/** Opener's long suit after 2♥ (bust): hearts go to the three level */
const suitCall = (s: Suit, bust: boolean): Call => (s === 'S' || (s === 'H' && !bust) ? bid(2, s) : bid(3, s))

function rebids(bust: boolean): Book {
  return {
    after: bust ? '2C (P) 2H (P)' : '2C (P) 2D (P)',
    rules: [
      rule('4N', { hcp: [28, 30], balanced: true }, (h) => h.balanced && h.hcp >= 28),
      rule('3N', { hcp: [25, 27], balanced: true }, (h) => h.balanced && h.hcp >= 25),
      rule('2N', { hcp: [22, 24], balanced: true }, (h) => h.balanced && h.hcp <= 24),
      ...(['S', 'H', 'D', 'C'] as const).map((s) =>
        // After 2♥ only 2♠ forces (responder answers 2NT without three spades)
        rule(suitCall(s, bust), { len: length(s, 5), hcp: plus(22), ...(!bust || s === 'S' ? { forcing: 'oneRound' as const } : {}) }, (h) => longest(h) === s && h.len[s] >= 5),
      ),
      // 4-4-4-1 and other hands without five cards: notrump
      rule('2N', { hcp: plus(22) }),
    ],
  }
}

/** Opener's rebid (the third call of our side) */
const rebid = (ctx: Ctx): Call => ours(ctx)[2]
const rebidIs = (call: Call) => (ctx: Ctx) => rebid(ctx) === call

/** Opener's suit, when the rebid was a suit */
const opener = (ctx: Ctx): Suit | null => {
  const s = strainOf(rebid(ctx))
  return isSuit(s) ? s : null
}

/** A side suit (not opener's) of one card or none, for a splinter */
const splinterIn = (h: Hand, ctx: Ctx): Suit | null => {
  const m = opener(ctx)
  return m ? shortSuit(h, m) : null
}

/** Responder after 2♣ 2♦ and opener's rebid (「2♣ 2♦ 2♠ ?」, and the same for the other suits) */
const afterWaiting: Book = {
  after: '2C (P) 2D (P) * (P)',
  rules: [
    // Notrump: 22–24 (game unless responder has nothing more), 25–27, 28–30
    rule(onlyIf(rebidIs('2N'), '6N'), { hcp: plus(10), notes: [{ key: 'smallSlam' }] }, (h) => h.hcp >= 10),
    ...(['S', 'H'] as const).map((m) => rule(onlyIf(rebidIs('2N'), bid(3, m)), { len: length(m, 5), hcp: plus(4), forcing: 'oneRound' }, (h) => h.len[m] >= 5)),
    rule(onlyIf(rebidIs('2N'), '3N'), { hcp: [4, 9], notes: [{ key: 'toPlay' }] }),
    rule(onlyIf(rebidIs('3N'), '6N'), { hcp: plus(7), notes: [{ key: 'smallSlam' }] }, (h) => h.hcp >= 7),
    rule(onlyIf(rebidIs('3N'), 'P')),
    rule(onlyIf(rebidIs('4N'), '6N'), { hcp: plus(5), notes: [{ key: 'smallSlam' }] }, (h) => h.hcp >= 5),
    rule(onlyIf(rebidIs('4N'), 'P')),
    // A major: splinter, 3 of the major with values, 4 of the major to sign off
    ...(['S', 'H'] as const).flatMap((m): Rule[] => {
      const isM = (ctx: Ctx) => opener(ctx) === m && levelOf(rebid(ctx)) === 2
      const fit = (h: Hand) => h.len[m] >= 3
      return [
        ...ORDER.filter((x) => x !== m).map((x) =>
          rule(
            onlyIf(isM, (ctx) => {
              const c = cheapest(ctx, x)
              return c && levelOf(c) === 3 ? bid(4, x) : null
            }),
            { name: 'splinter', len: length(m, 4), notes: [{ key: 'shortIn', strain: x }] },
            (h, ctx) => h.len[m] >= 4 && h.hcp >= 6 && splinterIn(h, ctx) === x,
          ),
        ),
        rule(onlyIf(isM, bid(3, m)), { len: length(m, 3), hcp: plus(6), notes: [{ key: 'slamInterest' }] }, (h) => fit(h) && h.hcp >= 6),
        rule(onlyIf(isM, bid(4, m)), { len: length(m, 3), hcp: [4, 5], notes: [{ key: 'signoff' }] }, fit),
      ]
    }),
    // A minor: raise with four, a five-card major, otherwise notrump
    ...(['C', 'D'] as const).map((m) =>
      rule(onlyIf((ctx) => opener(ctx) === m, bid(4, m)), { len: length(m, 4), notes: [{ key: 'support', strain: m }] }, (h) => h.len[m] >= 4 && !h.balanced),
    ),
    // No fit: a five-card suit of our own, otherwise 2NT (3NT over a minor)
    ...(['S', 'H', 'D', 'C'] as const).map((s) =>
      rule(
        onlyIf((ctx) => !!opener(ctx) && opener(ctx) !== s, (ctx) => {
          const c = cheapest(ctx, s)
          return c && levelOf(c) <= 3 ? c : null
        }),
        { len: length(s, 5) },
        (h) => h.len[s] >= 5,
      ),
    ),
    plain(onlyIf((ctx) => !!opener(ctx), (ctx) => cheapest(ctx, 'N'))),
  ],
}

/** Responder after 2♣ 2♥ (0–3) and opener's rebid */
const afterBust: Book = {
  after: '2C (P) 2H (P) * (P)',
  rules: [
    rule(onlyIf(rebidIs('2S'), '3S'), { len: length('S', 3), hcp: [...BUST] }, (h) => h.len.S >= 3),
    rule(onlyIf(rebidIs('2S'), '2N'), { hcp: [...BUST] }),
    rule(onlyIf(rebidIs('3H'), '4H'), { len: length('H', 3), hcp: [...BUST] }, (h) => h.len.H >= 3),
    rule('P'),
  ],
}

export const twoClubs: Book[] = [responses, rebids(false), rebids(true), afterWaiting, afterBust]
