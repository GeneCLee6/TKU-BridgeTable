import type { Suit } from '../../../cards.ts'
import type { Ctx } from '../context.ts'
import type { Hand } from '../evaluate.ts'
import type { Book, Rule, Spec } from '../spec.ts'
import { aces, bid, length, other, pass, plus, reads, rule, topThree } from './util.ts'
import { twoSuiter, twoSuiterShows } from './twosuiters.ts'

/**
 * Openings (淡江橋譜「淡江自然制總覽」「開叫2♣」「開叫2♥/♠（弱二）」「開叫3♣/♦/♥/♠」「輕開叫」,
 * 「1NT的答叫」「2D 開叫（一高弱二）」「競叫篇與技光」): 1NT 15–17 (a five-card suit only in a minor), five-card
 * majors, 1♦ four or more, 1♣ as few as two (4-4 in the minors opens 1♣), 2NT 20–21, 2♣ 22+, 2♦ a weak two in one major,
 * 2♥／2♠ two-suiters (社長 2026-10-25, 	wosuiters.ts), preempts at the three and four levels by vulnerability (the rule of two and three), a light
 * opening in third seat and the Rule of 15 in fourth seat; no weak openings in fourth seat.
 */

const fiveMajor = (len: Record<Suit, number>) => len.S >= 5 || len.H >= 5

/** A suit good enough to open light in third seat: five or more with two of the top three honours */
const goodFive = (h: Hand, s: Suit) => h.len[s] >= 5 && topThree(h, s) >= 2

/**
 * Enough to open one of a suit: 12 points, or a good 11; in third seat 10 with a good five-card suit in the suit
 * opened (輕開叫, to direct the lead); in fourth seat 10 when points plus spades make 15 (15定律)
 */
function enough(h: Hand, ctx: Ctx, s: Suit): boolean {
  if (h.hcp >= 12) return true
  // A good 11 (e5-t41, 牌值): Rule of 20 and two quick tricks, as a 12-point opening (not in fourth seat)
  if (h.hcp === 11 && ctx.position <= 3 && h.rule20 >= 20 && h.quickTricks >= 2) return true
  if (h.hcp < 10) return false
  if (ctx.position === 3) return goodFive(h, s)
  if (ctx.position === 4) return h.hcp + h.len.S >= 15
  return false
}

/** What one of a suit shows: 10 points and up in third and fourth seat */
const oneOf = (len: Spec['len']) => (ctx: Ctx): Spec => ({ len, hcp: [ctx.position >= 3 ? 10 : 12, 21] })

/** No weak opening in fourth seat (第四家不得弱叫); vulnerable (二三定律), one of the top three honours in the suit */
const weakOk = (h: Hand, ctx: Ctx, s: Suit) => ctx.position !== 4 && (!ctx.weVul || topThree(h, s) >= 1)

/** A three- or four-level preempt: as a weak opening, and never two aces (不可以有兩張A) */
const preemptOk = (h: Hand, ctx: Ctx, s: Suit) => weakOk(h, ctx, s) && aces(h) <= 1

/** Preempts the robot does not make (five of a minor), read as seven cards */
const otherPreempts: Rule[] = (['5C', '5D'] as const).map((call) => reads(call, { name: 'preempt', len: length(call[1] as Suit, 7), hcp: [5, 10] }))

/**
 * 1NT and 2NT with a five-card major (5332): the club does not (社長 2026-10-25), such hands open
 * the major; the president may change this later, so it is a single switch (ROBOT.md §2)
 */
export const NOTRUMP_WITH_FIVE_MAJOR = false

export function openingBook(fiveMajorNotrump = NOTRUMP_WITH_FIVE_MAJOR): Book {
  const major = fiveMajorNotrump ? 5 : 4
  const notrumpShape = (h: Hand) => h.balanced && (fiveMajorNotrump || !fiveMajor(h.len))
  return {
    after: '',
    rules: [
      rule('2C', { name: 'strong2C', hcp: plus(22), artificial: true, forcing: 'oneRound' }, (h) => h.hcp >= 22),
      rule('2N', { hcp: [20, 21], balanced: true, len: { S: [2, major], H: [2, major], D: [2, 5], C: [2, 5] } }, (h) => notrumpShape(h) && h.hcp >= 20 && h.hcp <= 21),
      rule('1N', { hcp: [15, 17], balanced: true, len: { S: [2, major], H: [2, major], D: [2, 5], C: [2, 5] } }, (h) => notrumpShape(h) && h.hcp >= 15 && h.hcp <= 17),
      // Five-card majors: 5-5 opens 1♠, 6-5 the longer
      rule('1S', oneOf(length('S', 5)), (h, ctx) => h.len.S >= 5 && h.len.S >= h.len.H && enough(h, ctx, 'S')),
      rule('1H', oneOf(length('H', 5)), (h, ctx) => h.len.H >= 5 && enough(h, ctx, 'H')),
      // 5542: 1♦ promises four, 1♣ may be as short as two (4♠4♥3♦2♣ opens 1♣); 4-4 in the minors opens 1♣
      // (開叫1♣「13-15點4-4低花時，開叫1♣」, 社長 2026-10-25), 5-5 1♦
      rule('1D', oneOf({ S: [0, 4], H: [0, 4], D: [4, 13] }), (h, ctx) => h.len.D >= 4 && (h.len.D > h.len.C || h.len.D >= 5) && h.len.D >= h.len.C && enough(h, ctx, 'D')),
      rule('1C', oneOf({ S: [0, 4], H: [0, 4], C: [2, 13] }), (h, ctx) => enough(h, ctx, 'C')),
      // Four of a suit with eight cards, three with seven (開叫3♣/♦/♥/♠：6–11 點, 二三定律)
      ...(['S', 'H', 'D', 'C'] as const).map((s) =>
        rule(bid(4, s), { name: 'preempt', len: length(s, 8), hcp: [5, 10] }, (h, ctx) => h.hcp >= 5 && h.hcp <= 10 && h.len[s] >= 8 && preemptOk(h, ctx, s)),
      ),
      ...(['S', 'H', 'D', 'C'] as const).map((s) =>
        rule(bid(3, s), { name: 'preempt', len: length(s, 7), hcp: [5, 10] }, (h, ctx) => h.hcp >= 5 && h.hcp <= 10 && h.len[s] >= 7 && preemptOk(h, ctx, s)),
      ),
      // Two-suiters, 5-5 or more (技光, 社長 2026-10-25): 2♥ hearts and another suit, 2♠ spades and a minor
      ...(['H', 'S'] as const).map((m) =>
        rule(bid(2, m), twoSuiterShows[bid(2, m) as '2H' | '2S'], (h, ctx) => h.hcp >= 5 && h.hcp <= 10 && twoSuiter(h, m) && weakOk(h, ctx, m)),
      ),
      // 一高弱二: six cards in one major with an honour, no good four-card other major (開叫2♥/♠（弱二）)
      rule('2D', { name: 'oneMajorWeakTwo', hcp: [6, 10] }, (h, ctx) => {
        const m = h.len.S === 6 ? 'S' : h.len.H === 6 ? 'H' : null
        return !!m && h.hcp >= 5 && h.hcp <= 10 && !(h.len[other(m)] >= 4 && topThree(h, other(m)) >= 1) && weakOk(h, ctx, m) && topThree(h, m) >= 1
      }),
      ...otherPreempts,
      reads('3N', { hcp: [5, 10] }),
      pass({ hcp: [0, 11] }),
    ],
  }
}

export const openings: Book = openingBook()
