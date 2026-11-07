import type { Suit } from '../../../cards.ts'
import type { Hand } from '../evaluate.ts'
import type { Book, Rule } from '../spec.ts'
import { bid, plus } from './util.ts'

/** After 1♦ (11–15, possibly short), docs/systems/precision.md §3 */

const noFourMajor = (h: Hand) => h.len.H < 4 && h.len.S < 4
const NO_MAJOR = { H: [0, 3], S: [0, 3] } as const

const responses: Rule[] = [
  { call: '3N', shows: { len: NO_MAJOR, hcp: [13, 15], notes: [{ key: 'toPlay' }] }, when: (h) => h.balanced },
  { call: '2N', shows: { len: NO_MAJOR, hcp: [11, 12], notes: [{ key: 'invite' }] }, when: (h) => h.balanced },
  // A jump shift: strong with a good six-card suit
  ...(['S', 'H'] as Suit[]).map(
    (M): Rule => ({
      call: bid(2, M),
      shows: { len: { [M]: [6, 13] }, quality: { [M]: 'twiceRebiddable' }, hcp: plus(16), forcing: 'game' },
    }),
  ),
  // Up the line with four-card majors, the longer first
  { call: '1S', shows: { len: { S: [4, 13] }, hcp: plus(6), forcing: 'oneRound' }, when: (h) => h.len.S > h.len.H || (h.len.S >= 5 && h.len.S === h.len.H) },
  { call: '1H', shows: { len: { H: [4, 13] }, hcp: plus(6), forcing: 'oneRound' } },
  { call: '1S', shows: { len: { S: [4, 13] }, hcp: plus(6), forcing: 'oneRound' } },
  // Four or more diamonds and no major: the inverted raise, or preemptive with five
  { call: '2D', shows: { name: 'invertedMinor', len: { ...NO_MAJOR, D: [4, 13] }, hcp: plus(11), forcing: 'oneRound' }, when: (h) => h.len.D >= h.len.C },
  { call: '2C', shows: { len: { ...NO_MAJOR, C: [4, 13] }, hcp: plus(11), forcing: 'oneRound' } },
  { call: '3D', shows: { name: 'preemptiveRaise', len: { ...NO_MAJOR, D: [5, 13] }, hcp: [5, 9] } },
  { call: '1N', shows: { len: NO_MAJOR, hcp: [6, 10] }, when: noFourMajor },
  { call: 'P', shows: { hcp: [0, 5] } },
]

/** Opener after 1♦–1M: limited, and the balanced 13–15 would have opened 1NT */
function rebids(y: Suit): Rule[] {
  const rules: Rule[] = [
    { call: bid(4, y), shows: { len: { [y]: [4, 13] }, tp: plus(18), notes: [{ key: 'game' }] } },
    { call: bid(3, y), shows: { len: { [y]: [4, 13] }, hcp: [14, 15], notes: [{ key: 'invite' }] } },
    { call: bid(2, y), shows: { len: { [y]: [4, 13] }, hcp: [10, 13] } },
  ]
  if (y === 'H') rules.push({ call: '1S', shows: { len: { S: [4, 13] } } })
  rules.push(
    { call: '1N', shows: { hcp: [10, 12], balanced: true } },
    { call: '3D', shows: { len: { D: [6, 13] }, hcp: [14, 15] } },
    { call: '2D', shows: { len: { D: [5, 13] } } },
    { call: '2C', shows: { len: { C: [4, 13] } } },
    // Nothing else fits (a raise needs four): diamonds, however few
    { call: '2D', shows: {} },
  )
  return rules
}

export const diamond: readonly Book[] = [
  { after: '1D (P)', rules: responses, more: true },
  { after: '1D (P) 1H (P)', rules: rebids('H'), more: true },
  { after: '1D (P) 1S (P)', rules: rebids('S'), more: true },
]
