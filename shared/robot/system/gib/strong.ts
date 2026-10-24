import type { Suit } from '../../../cards.ts'
import type { Hand } from '../evaluate.ts'
import type { Book, Rule } from '../spec.ts'
import { notrumpBooks, type Ranges } from './notrump.ts'
import { above, bid, goodSuit, isMajor, MAJORS, plus, SUITS_DOWN, UP, upTo } from './util.ts'

/** After 2♣, weak twos and preempts, docs/BBO GIB/gib-2over1.md §6 */

// ── 2♣ ───────────────────────────────────────────────────────────────────────────────────────

/** Responses: a positive in a good five-card suit or 2NT, otherwise the 2♦ waiting bid */
const strongResponses: Rule[] = [
  ...(['H', 'S', 'C', 'D'] as Suit[]).map(
    (x): Rule => ({
      call: bid(isMajor(x) ? 2 : 3, x),
      shows: { len: { [x]: [5, 13] }, hcp: plus(8), forcing: 'game' },
      when: (h) => goodSuit(h, x) && SUITS_DOWN.every((s) => s === x || h.len[s] <= h.len[x]),
    }),
  ),
  { call: '2N', shows: { hcp: plus(8), balanced: true, forcing: 'game' } },
  { call: '2D', shows: { name: 'waiting', forcing: 'oneRound', artificial: true } },
]

/** Opener after 2♣–2♦: 2NT 22–24 (then the 2NT structure), 3NT 25–27, or a long suit */
const strongRebids: Rule[] = [
  { call: '2N', shows: { hcp: [22, 24], balanced: true } },
  { call: '3N', shows: { hcp: [25, 27], balanced: true } },
  ...(['S', 'H', 'D', 'C'] as Suit[]).map(
    (x): Rule => ({
      call: bid(isMajor(x) ? 2 : 3, x),
      shows: { len: { [x]: [5, 13] }, hcp: plus(22), forcing: 'oneRound' },
      when: (h) => SUITS_DOWN.every((s) => s === x || h.len[s] < h.len[x] || (h.len[s] === h.len[x] && SUITS_DOWN.indexOf(s) > SUITS_DOWN.indexOf(x))),
    }),
  ),
]

/** Responder's ranges after 2♣–2♦–2NT (22–24): the 2NT structure, a few points lower */
const STRONG_NT: Ranges = { up: 1, weak: [0, 1], invite: null, game: [2, 8], slamTry: [7, 8], quant: [9, 10], slam: [11, 13], grand: [14, 15], top: 24 }

// ── Weak twos ────────────────────────────────────────────────────────────────────────────────

function weakTwoResponses(s: Suit): Rule[] {
  const game = isMajor(s) ? bid(4, s) : '5D'
  return [
    { minLevel: 'college', call: '2N', shows: { name: 'featureAsk', hcp: plus(15), forcing: 'oneRound', artificial: true } },
    // Game: a weak hand with four trumps (Law of Total Tricks) or a strong one with two (GIB's own example)
    { call: game, shows: { len: { [s]: [4, 13] }, tp: plus(4), notes: [{ key: 'toPlay' }] }, when: (h) => h.len[s] >= 4 && h.hcp <= 11 },
    { call: game, shows: { len: { [s]: [2, 13] }, tp: plus(16), notes: [{ key: 'toPlay' }] }, when: (h) => h.len[s] >= 2 },
    { call: '3N', shows: { hcp: plus(15), notes: [{ key: 'toPlay' }] }, when: (h) => h.len[s] <= 1 },
    // A new suit is forcing for one round
    ...UP.filter((x) => x !== s).map(
      (x): Rule => ({
        call: bid(above(x, s) ? 2 : 3, x),
        shows: { len: { [x]: [5, 13] }, hcp: plus(12), forcing: 'oneRound' },
        when: (h) => h.len[s] <= 2,
      }),
    ),
    // A preemptive raise by the Law of Total Tricks
    { call: bid(3, s), shows: { name: 'preemptiveRaise', len: { [s]: [3, 13] }, hcp: upTo(11) } },
    { call: 'P', shows: {} },
  ]
}

/** Opener answers the feature ask: minimum rebids the suit, maximum shows an outside ace or king */
function featureAnswers(s: Suit): Rule[] {
  const feature = (h: Hand, x: Suit) => /^[AK]/.test(h.ranks[x])
  return [
    { call: '3N', shows: { quality: { [s]: 'solid' }, notes: [{ key: 'maximum' }] }, when: (h) => h.ranks[s].startsWith('AKQ') },
    ...UP.filter((x) => x !== s).map(
      (x): Rule => ({
        call: bid(3, x),
        shows: { name: 'feature', hcp: [8, 10], notes: [{ key: 'maximum' }, { key: 'honourIn', strain: x }] },
        when: (h) => feature(h, x),
      }),
    ),
    { call: bid(3, s), shows: { hcp: [5, 7], notes: [{ key: 'minimum' }] } },
    { call: bid(3, s), shows: { hcp: [8, 10], notes: [{ key: 'maximum' }] } },
  ]
}

// ── Preempts ─────────────────────────────────────────────────────────────────────────────────

function preemptResponses(level: 3 | 4, s: Suit): Rule[] {
  const rules: Rule[] = []
  if (level === 3) {
    rules.push(
      { call: '3N', shows: { hcp: plus(15), notes: [{ key: 'toPlay' }] }, when: (h) => h.len[s] <= 2 && UP.every((x) => x === s || h.stop[x]) },
      ...UP.filter((x) => x !== s && UP.indexOf(x) > UP.indexOf(s)).map(
        (x): Rule => ({ call: bid(3, x), shows: { len: { [x]: [5, 13] }, hcp: plus(15), forcing: 'oneRound' }, when: (h) => h.len[s] <= 1 }),
      ),
    )
  }
  if (isMajor(s) && level === 3)
    rules.push(
      { call: bid(4, s), shows: { len: { [s]: [3, 13] }, tp: plus(4), notes: [{ key: 'toPlay' }] }, when: (h) => h.len[s] >= 3 && h.hcp <= 10 },
      { call: bid(4, s), shows: { len: { [s]: [2, 13] }, tp: plus(15), notes: [{ key: 'toPlay' }] } },
    )
  if (!isMajor(s)) rules.push({ call: bid(5, s), shows: { len: { [s]: [3, 13] }, notes: [{ key: 'toPlay' }] }, when: (h) => h.len[s] >= 4 || h.hcp >= 15 })
  rules.push({ call: 'P', shows: {} })
  return rules
}

// ── The books ─────────────────────────────────────────────────────────────────────────────────

const books: Book[] = [
  { after: '2C (P)', rules: strongResponses, more: true },
  { after: '2C (P) 2D (P)', rules: strongRebids, more: true },
  ...notrumpBooks(STRONG_NT, '2C (P) 2D (P) 2N'),
]
for (const s of ['D', 'H', 'S'] as Suit[])
  books.push(
    { after: `2${s} (P)`, rules: weakTwoResponses(s), more: true },
    { after: `2${s} (P) 2N (P)`, rules: featureAnswers(s), more: true },
  )
for (const s of UP) {
  books.push({ after: `3${s} (P)`, rules: preemptResponses(3, s), more: true })
  if (!MAJORS.includes(s)) books.push({ after: `4${s} (P)`, rules: preemptResponses(4, s), more: true })
}

export const strong: readonly Book[] = books
