import type { Suit } from '../../../cards.ts'
import type { Hand } from '../evaluate.ts'
import type { Book, Rule } from '../spec.ts'
import { bid, MAJORS, plus, SUITS_DOWN } from './util.ts'

/** After 2♣, 2♦ and the gambling 3NT, docs/systems/precision.md §4 */

const anyFourMajor = (h: Hand) => h.len.S >= 4 || h.len.H >= 4

// ── 2♣: 11–15, six clubs or five and a four-card major ───────────────────────────────────────

const overTwoClubs: Rule[] = [
  ...(['S', 'H', 'D'] as Suit[]).map(
    (s): Rule => ({
      call: bid(3, s),
      shows: { len: { [s]: [5, 13] }, quality: { [s]: 'rebiddable' }, hcp: plus(14), forcing: 'game' },
    }),
  ),
  // The ask with a major; 3NT without one
  { call: '2D', shows: { name: 'ask', hcp: plus(11), notes: [{ key: 'asksMajor' }], forcing: 'oneRound', artificial: true }, when: anyFourMajor },
  { call: '3N', shows: { hcp: plus(13), len: { H: [0, 3], S: [0, 3] }, notes: [{ key: 'toPlay' }] } },
  { call: '2N', shows: { hcp: [10, 12], len: { H: [0, 3], S: [0, 3] }, notes: [{ key: 'invite' }] }, when: (h) => h.len.C <= 3 },
  { call: '4C', shows: { name: 'preemptiveRaise', len: { C: [4, 13] }, hcp: [0, 7] }, when: (h) => h.shape[3] <= 1 },
  { call: '3C', shows: { name: 'preemptiveRaise', len: { C: [3, 13] }, hcp: [6, 10] } },
  ...MAJORS.map((M): Rule => ({ call: bid(2, M), shows: { len: { [M]: [5, 13] }, hcp: [6, 10] } })),
  { call: 'P', shows: { hcp: [0, 10] } },
]

/** Opener answers the ask: a four-card major, hearts first; otherwise by strength with six clubs */
const answerTwoClubs: Rule[] = [
  { call: '2H', shows: { len: { H: [4, 4] } } },
  { call: '2S', shows: { len: { S: [4, 4], H: [0, 3] } } },
  { call: '2N', shows: { len: { C: [6, 13], S: [0, 3], H: [0, 3] }, hcp: [14, 15], notes: [{ key: 'maximum' }] } },
  { call: '3C', shows: { len: { C: [6, 13], S: [0, 3], H: [0, 3] }, hcp: [11, 13], notes: [{ key: 'minimum' }] } },
]

// ── 2♦: 11–15, short diamonds ────────────────────────────────────────────────────────────────

const overTwoDiamonds: Rule[] = [
  { call: '2N', shows: { name: 'ask', hcp: plus(12), forcing: 'oneRound', artificial: true } },
  // Game in a five-card major, enough with partner's three or four cards and short diamonds
  ...MAJORS.map((M): Rule => ({ call: bid(4, M), shows: { len: { [M]: [5, 13] }, hcp: [8, 11], notes: [{ key: 'toPlay' }] } })),
  // Inviting game in a suit of four or more
  ...MAJORS.map((M): Rule => ({ call: bid(3, M), shows: { len: { [M]: [4, 13] }, hcp: [9, 11], notes: [{ key: 'invite' }] } })),
  { call: '3D', shows: { len: { D: [6, 13] }, hcp: [0, 9], notes: [{ key: 'toPlay' }] } },
  { call: '3C', shows: { len: { C: [4, 13] }, hcp: [0, 9], notes: [{ key: 'toPlay' }] }, when: (h) => h.len.C > Math.max(h.len.H, h.len.S) },
  { call: 'P', shows: { len: { D: [5, 13] }, hcp: [0, 11] }, when: (h) => h.len.H < 3 && h.len.S < 3 },
  { call: '2S', shows: { len: { S: [3, 13] }, hcp: [0, 8], notes: [{ key: 'toPlay' }] }, when: (h) => h.len.S > h.len.H },
  { call: '2H', shows: { len: { H: [2, 13] }, hcp: [0, 8], notes: [{ key: 'toPlay' }] } },
  { call: '2S', shows: { len: { S: [2, 13] }, hcp: [0, 8], notes: [{ key: 'toPlay' }] } },
]

/** Opener answers 2NT: 3♣ any minimum; with a maximum the shape */
const answerTwoDiamonds: Rule[] = [
  { call: '3C', shows: { hcp: [11, 13], notes: [{ key: 'minimum' }] } },
  { call: '3D', shows: { len: { S: [4, 4], H: [4, 4] }, hcp: [14, 15], notes: [{ key: 'maximum' }] } },
  { call: '3H', shows: { len: { H: [4, 4], S: [3, 3], C: [5, 5] }, hcp: [14, 15], notes: [{ key: 'maximum' }] } },
  { call: '3S', shows: { len: { S: [4, 4], H: [3, 3], C: [5, 5] }, hcp: [14, 15], notes: [{ key: 'maximum' }] } },
]

// ── The gambling 3NT ─────────────────────────────────────────────────────────────────────────

const overGambling: Rule[] = [
  { call: 'P', shows: { notes: [{ key: 'toPlay' }] }, when: (h) => h.hcp >= 10 && SUITS_DOWN.filter((s) => h.stop[s]).length >= 3 },
  { call: '4C', shows: { name: 'passOrCorrect', artificial: true } },
]

const answerGambling: Rule[] = [
  { call: '4D', shows: { len: { D: [7, 13] } }, when: (h) => h.len.D >= 7 },
  { call: 'P', shows: { len: { C: [7, 13] } } },
]

export const twos: readonly Book[] = [
  { after: '2C (P)', rules: overTwoClubs, more: true },
  { after: '2C (P) 2D (P)', rules: answerTwoClubs, more: true },
  { after: '2D (P)', rules: overTwoDiamonds, more: true },
  { after: '2D (P) 2N (P)', rules: answerTwoDiamonds, more: true },
  { after: '3N (P)', rules: overGambling, more: true },
  { after: '3N (P) 4C (P)', rules: answerGambling, more: true },
]
