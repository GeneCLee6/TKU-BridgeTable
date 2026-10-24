import type { Suit } from '../../../cards.ts'
import type { Book, Rule } from '../spec.ts'
import { bid, length, pass, plus, reads, rule } from './util.ts'

/**
 * Openings (淡江橋譜「1NT的答叫」「2D 開叫（一高弱二）」, 5542 自然制 for the rest): 1NT 15–17
 * (a five-card suit only in a minor), five-card majors, 1♦ four or more, 1♣ as few as two, 2NT
 * 20–21, 2♣ strong, 2♦ a weak two in one major, three-level preempts.
 */

const fiveMajor = (len: Record<Suit, number>) => len.S >= 5 || len.H >= 5

/** Preempts the robot does not make (two of a major, the four and five levels), read as seven cards */
const otherPreempts: Rule[] = (['2H', '2S', '4C', '4D', '4H', '4S', '5C', '5D'] as const).map((call) =>
  reads(call, { name: 'preempt', len: length(call[1] as Suit, 7), hcp: [5, 10] }),
)

export const openings: Book = {
  after: '',
  rules: [
    rule('2C', { name: 'strong2C', hcp: plus(22), artificial: true, forcing: 'oneRound' }, (h) => h.hcp >= 22),
    rule('2N', { hcp: [20, 21], balanced: true, len: { S: [2, 5], H: [2, 5], D: [2, 5], C: [2, 5] } }, (h) => h.balanced && h.hcp >= 20 && h.hcp <= 21),
    rule(
      '1N',
      { hcp: [15, 17], balanced: true, len: { S: [2, 4], H: [2, 4], D: [2, 5], C: [2, 5] } },
      (h) => h.balanced && !fiveMajor(h.len) && h.hcp >= 15 && h.hcp <= 17,
    ),
    rule('1S', { len: length('S', 5), hcp: [12, 21] }, (h) => h.hcp >= 12 && h.len.S >= 5 && h.len.S >= h.len.H),
    rule('1H', { len: length('H', 5), hcp: [12, 21] }, (h) => h.hcp >= 12 && h.len.H >= 5),
    // 5542: 1♦ promises four, 1♣ may be as short as two (4♠4♥3♦2♣ opens 1♣)
    rule('1D', { len: { S: [0, 4], H: [0, 4], D: [4, 13] }, hcp: [12, 21] }, (h) => h.hcp >= 12 && h.len.D >= 4 && h.len.D >= h.len.C),
    rule('1C', { len: { S: [0, 4], H: [0, 4], C: [2, 13] }, hcp: [12, 21] }, (h) => h.hcp >= 12),
    ...(['S', 'H', 'D', 'C'] as const).map((s) =>
      rule(bid(3, s), { name: 'preempt', len: length(s, 7), hcp: [5, 10] }, (h) => h.hcp >= 5 && h.hcp <= 10 && h.len[s] >= 7),
    ),
    rule('2D', { name: 'oneMajorWeakTwo', hcp: [6, 10] }, (h) => h.hcp >= 5 && h.hcp <= 10 && (h.len.S === 6 || h.len.H === 6)),
    ...otherPreempts,
    reads('3N', { hcp: [5, 10] }),
    pass({ hcp: [0, 11] }),
  ],
}

