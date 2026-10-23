import type { Suit } from '../../../cards.ts'
import type { Ctx } from '../context.ts'
import type { Hand } from '../evaluate.ts'
import type { Book, Rule, Spec } from '../spec.ts'
import { bid, goodSuit, isMinor, MAJORS, other, plus, ruleOf20, SUITS_DOWN, upTo } from './util.ts'

/** Opening bids, docs/BBO GIB/gib-2over1.md §1 */

/**
 * Worth a one-level opening in this seat: 12+, or 11 with the Rule of 20; third seat also with 10
 * and a good five-card suit; fourth seat only with the Rule of 15 (points plus spades)
 */
export function opens(h: Hand, ctx: Ctx): boolean {
  const sound = h.hcp >= 12 || (h.hcp === 11 && ruleOf20(h) >= 20)
  if (ctx.position === 4) return h.hcp >= 10 && h.hcp + h.len.S >= 15
  if (ctx.position === 3) return sound || (h.hcp >= 10 && SUITS_DOWN.some((s) => h.len[s] >= 5 && goodFive(h, s)))
  return sound
}

/** A five-card suit good enough to open light: "rebiddable" in GIB's terms */
const goodFive = (h: Hand, s: Suit) => h.quality[s] !== null && h.quality[s] !== 'biddable'

/**
 * The suit to open at the one level: five-card majors (♠ with 5-5, a longer minor first), then the
 * longer minor; 4-4 or 5-5 in the minors opens 1♦, 3-3 opens 1♣, 4432 with three diamonds 1♦
 */
export function openingSuit(h: Hand): Suit {
  const minor = Math.max(h.len.D, h.len.C)
  if (h.len.S >= 5 && h.len.S >= h.len.H && h.len.S >= minor) return 'S'
  if (h.len.H >= 5 && h.len.H >= minor) return 'H'
  if (h.len.D !== h.len.C) return h.len.D > h.len.C ? 'D' : 'C'
  return h.len.D >= 4 ? 'D' : 'C'
}

/** What a one-level suit opening shows; a third-seat opening may be a point lighter */
const oneLevel = (s: Suit) => (ctx: Ctx): Spec => ({
  len: { [s]: [MAJORS.includes(s) ? 5 : 3, 13] },
  hcp: [ctx.position === 3 || ctx.position === 4 ? 10 : 11, 21],
  tp: [ctx.position === 3 || ctx.position === 4 ? 11 : 12, 22],
})

/** Preempts and weak twos are for the first three seats */
const notFourth = (ctx: Ctx) => ctx.position <= 3

/** No four cards in a major besides the suit (a weak two in ♦ has no four-card major) */
const noSideMajor = (h: Hand, s: Suit) => MAJORS.every((m) => m === s || h.len[m] < 4)

const weakTwo = (s: Suit): Rule => ({
  call: bid(2, s),
  shows: { name: 'weakTwo', len: { [s]: [6, 6] }, hcp: [5, 10], quality: { [s]: 'twiceRebiddable' } },
  when: (h, ctx) => notFourth(ctx) && goodSuit(h, s) && noSideMajor(h, s),
})

const preempt = (level: number, s: Suit, length: number, longer = false): Rule => ({
  call: bid(level, s),
  shows: { name: 'preempt', len: { [s]: [length, longer ? 13 : length] }, hcp: [5, 10] },
  when: (h, ctx) => notFourth(ctx) && (isMinor(s) || h.len[other(s)] < 4),
})

export const openings: Book = {
  after: '',
  rules: [
    { call: '2C', shows: { name: 'strong2C', hcp: plus(22), forcing: 'oneRound', artificial: true } },
    { call: '2N', shows: { hcp: [20, 21], balanced: true } },
    // 17 with a five-card major counts as 18: open the major
    {
      call: '1N',
      shows: { hcp: [15, 17], balanced: true },
      when: (h) => !(h.hcp === 17 && MAJORS.some((m) => h.len[m] >= 5)),
    },
    weakTwo('S'),
    weakTwo('H'),
    weakTwo('D'),
    preempt(4, 'S', 8, true),
    preempt(4, 'H', 8, true),
    preempt(5, 'D', 9, true),
    preempt(5, 'C', 9, true),
    preempt(4, 'D', 8),
    preempt(4, 'C', 8),
    preempt(3, 'S', 7),
    preempt(3, 'H', 7),
    preempt(3, 'D', 7),
    preempt(3, 'C', 7),
    ...SUITS_DOWN.map(
      (s): Rule => ({
        call: bid(1, s),
        shows: oneLevel(s),
        needs: { hcp: [10, 21] },
        when: (h, ctx) => openingSuit(h) === s && opens(h, ctx),
      }),
    ),
    // Not worth an opening; the fourth seat passes some opening hands without spades
    { call: 'P', shows: (ctx) => ({ hcp: upTo(ctx.position === 4 ? 14 : 11) }) },
  ],
}
