import type { Suit } from '../../../cards.ts'
import type { Ctx } from '../context.ts'
import type { Hand } from '../evaluate.ts'
import type { Book, Rule } from '../spec.ts'
import { bid, honours, isMinor, MAJORS, plus, ruleOf20, SUITS_DOWN, upTo } from '../gib/util.ts'

/** Opening bids, docs/systems/sayc.md §1 */

/** Worth a one-level opening: 12+, or 11 with the Rule of 20 (the booklet names no floor) */
export const opens = (h: Hand) => h.hcp >= 12 || (h.hcp === 11 && ruleOf20(h) >= 20)

/**
 * Five-card majors, the higher of equal long suits; 1♦ with 4-4 in the minors, 1♣ with 3-3 (so
 * 4-4-3-2 with three diamonds opens 1♦)
 */
export function openingSuit(h: Hand): Suit {
  const longest = Math.max(h.len.S, h.len.H, h.len.D, h.len.C)
  for (const s of MAJORS) if (h.len[s] >= 5 && h.len[s] === longest) return s
  if (h.len.D !== h.len.C) {
    const minor = h.len.D > h.len.C ? 'D' : 'C'
    for (const s of MAJORS) if (h.len[s] >= 5 && h.len[s] >= h.len[minor]) return s
    return minor
  }
  return h.len.D >= 4 ? 'D' : 'C'
}

/** Rough tricks of a hand playing in its long suit: the length less the missing top honours, and quick tricks outside */
export function playingTricks(h: Hand, s: Suit): number {
  const held = h.ranks[s]
  const losers = [...'AKQ'].slice(0, Math.min(3, held.length)).filter((r) => !held.includes(r)).length
  const quick = (ranks: string) =>
    ranks.startsWith('AK') ? 2 : ranks.startsWith('AQ') ? 1.5 : ranks.startsWith('A') || ranks.startsWith('KQ') ? 1 : ranks.startsWith('K') && ranks.length >= 2 ? 0.5 : 0
  return held.length - losers + SUITS_DOWN.filter((x) => x !== s).reduce((sum, x) => sum + quick(h.ranks[x]), 0)
}

/** How many tricks short a preempt may be: two vulnerable against not, three at equal, four at favourable */
const margin = (ctx: Ctx) => (ctx.weVul && !ctx.theyVul ? 2 : ctx.weVul === ctx.theyVul ? 3 : 4)

/** Preempts and weak twos are for the first three seats */
const notFourth = (ctx: Ctx) => ctx.position <= 3

const preempt = (level: number, s: Suit, length: number, most = 13): Rule => ({
  call: bid(level, s),
  shows: { name: 'preempt', len: { [s]: [length, most] }, hcp: [5, 10] },
  when: (h, ctx) => notFourth(ctx) && playingTricks(h, s) >= level + 6 - margin(ctx),
})

/** A six-card suit of reasonable quality: an ace, king or queen and another of the top five */
const reasonable = (h: Hand, s: Suit) => {
  const { top3, top5 } = honours(h, s)
  return top3 >= 1 && top5 >= 2
}

const weakTwo = (s: Suit): Rule => ({
  call: bid(2, s),
  shows: { name: 'weakTwo', len: { [s]: [6, 7] }, hcp: [5, 11] },
  // A seven-card suit that got here was not good enough for the three level
  when: (h, ctx) => notFourth(ctx) && h.shape[1] < 5 && (h.len[s] === 7 || reasonable(h, s)),
})

const notrump = (hcp: readonly [number, number]) => ({ hcp, balanced: true })

export const openings: Book = {
  after: '',
  rules: [
    { call: '3N', shows: notrump([25, 27]) },
    { call: '2C', shows: { name: 'strong2C', hcp: plus(22), forcing: 'oneRound', artificial: true } },
    { call: '2N', shows: notrump([20, 21]) },
    { call: '1N', shows: notrump([15, 17]) },
    ...(['S', 'H', 'D', 'C'] as Suit[]).flatMap((s): Rule[] =>
      isMinor(s) ? [preempt(5, s, 9), preempt(4, s, 8, 8), preempt(3, s, 7, 8)] : [preempt(4, s, 8), preempt(3, s, 7, 8)],
    ),
    weakTwo('S'),
    weakTwo('H'),
    weakTwo('D'),
    ...SUITS_DOWN.map(
      (s): Rule => ({
        call: bid(1, s),
        shows: { len: { [s]: [MAJORS.includes(s) ? 5 : 3, 13] }, hcp: [11, 21] },
        when: (h) => openingSuit(h) === s && opens(h),
      }),
    ),
    { call: 'P', shows: { hcp: upTo(11) } },
  ],
}
