import type { Suit } from '../../../cards.ts'
import type { Hand } from '../evaluate.ts'
import type { Book, Rule } from '../spec.ts'
import { above, bid, isMajor, plus, SUITS_DOWN, UP } from '../gib/util.ts'

/** After 2♣, weak twos and preempts, docs/systems/sayc.md §6 and §7 */

const longestIs = (h: Hand, x: Suit) => SUITS_DOWN.every((s) => s === x || h.len[s] <= h.len[x])

/** 2♣: natural positives, game forcing, with five cards and 8 points; 2NT is a balanced 8; otherwise 2♦ */
const strongResponses: Rule[] = [
  ...(['H', 'S', 'C', 'D'] as Suit[]).map(
    (x): Rule => ({
      call: bid(isMajor(x) ? 2 : 3, x),
      shows: { len: { [x]: [5, 13] }, hcp: plus(8), forcing: 'game' },
      when: (h) => longestIs(h, x),
    }),
  ),
  { call: '2N', shows: { hcp: [8, 8], balanced: true, forcing: 'game' } },
  { call: '2D', shows: { name: 'waiting', forcing: 'oneRound', artificial: true } },
]

/** A double takes the convention away: 2♦ is natural and positive, a pass is the waiting bid */
const strongDoubled: Rule[] = [
  { call: '2D', shows: { len: { D: [5, 13] }, hcp: plus(8), forcing: 'game' }, when: (h) => longestIs(h, 'D') },
  ...(['H', 'S', 'C'] as Suit[]).map(
    (x): Rule => ({ call: bid(isMajor(x) ? 2 : 3, x), shows: { len: { [x]: [5, 13] }, hcp: plus(8), forcing: 'game' }, when: (h) => longestIs(h, x) }),
  ),
  { call: 'P', shows: { name: 'waiting' } },
]

/** Opener after 2♣–2♦: 2NT 22–24 (the 2NT structure), 3NT 25–27, or a long suit, forcing up to three of a major or four of a minor */
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

/** A weak two: 2NT forces and shows game interest, a new suit forces one round, any raise and 3NT are to play */
function weakTwoResponses(s: Suit): Rule[] {
  const game = isMajor(s) ? bid(4, s) : '5D'
  return [
    { call: '2N', shows: { name: 'featureAsk', hcp: plus(14), forcing: 'oneRound', artificial: true } },
    { call: game, shows: { len: { [s]: [3, 13] }, notes: [{ key: 'toPlay' }] }, when: (h) => h.len[s] >= 4 || h.hcp >= 16 },
    { call: '3N', shows: { hcp: plus(15), notes: [{ key: 'toPlay' }] }, when: (h) => h.len[s] <= 1 },
    ...UP.filter((x) => x !== s).map(
      (x): Rule => ({
        call: bid(above(x, s) ? 2 : 3, x),
        shows: { len: { [x]: [5, 13] }, hcp: plus(12), forcing: 'oneRound' },
        when: (h) => h.len[s] <= 2 && h.len[x] >= 5,
      }),
    ),
    { call: bid(3, s), shows: { len: { [s]: [3, 13] }, notes: [{ key: 'toPlay' }] }, when: (h) => h.len[s] >= 3 },
    { call: 'P', shows: {} },
  ]
}

/** Answering 2NT: a minimum rebids the suit, a maximum shows an ace or a king, or bids 3NT without one */
function featureAnswers(s: Suit): Rule[] {
  const others = UP.filter((x) => x !== s)
  return [
    { call: bid(3, s), shows: { hcp: [5, 8], notes: [{ key: 'minimum' }] }, when: (h) => h.hcp <= 8 },
    ...others.map(
      (x): Rule => ({
        call: bid(3, x),
        shows: { name: 'feature', hcp: [9, 11], notes: [{ key: 'maximum' }, { key: 'honourIn', strain: x }] },
        when: (h) => /^[AK]/.test(h.ranks[x]),
      }),
    ),
    { call: '3N', shows: { hcp: [9, 11], notes: [{ key: 'maximum' }] } },
  ]
}

/** Opener answers a new suit: raises a major with three or an honour doubleton, otherwise a minimum rebids, a maximum says so */
function afterNewSuit(s: Suit, x: Suit): Rule[] {
  const rules: Rule[] = []
  if (isMajor(x)) rules.push({ call: (ctx) => (ctx.legal.has(bid(3, x)) ? bid(3, x) : bid(4, x)), shows: { len: { [x]: [2, 13] }, notes: [{ key: 'support', strain: x }] }, when: (h) => h.len[x] >= 3 || (h.len[x] === 2 && /[AKQ]/.test(h.ranks[x])) })
  rules.push(
    { call: '3N', shows: { hcp: [9, 11], notes: [{ key: 'maximum' }] }, when: (h) => h.hcp >= 9 && h.shape[3] >= 2 },
    { call: bid(3, s), shows: { hcp: [5, 8], notes: [{ key: 'minimum' }] } },
  )
  return rules
}

/** A preempt: raises are to play, a new suit below game forces, 3NT is to play */
function preemptResponses(s: Suit): Rule[] {
  return [
    { call: '3N', shows: { hcp: plus(15), notes: [{ key: 'toPlay' }] }, when: (h) => h.len[s] <= 2 && UP.every((x) => x === s || h.stop[x]) },
    ...UP.filter((x) => x !== s && above(x, s)).map((x): Rule => ({ call: bid(3, x), shows: { len: { [x]: [5, 13] }, hcp: plus(15), forcing: 'oneRound' }, when: (h) => h.len[s] <= 1 })),
    ...(isMajor(s)
      ? [{ call: bid(4, s), shows: { len: { [s]: [2, 13] }, notes: [{ key: 'toPlay' as const }] }, when: (h: Hand) => h.len[s] >= 3 || h.hcp >= 15 }]
      : [{ call: bid(5, s), shows: { len: { [s]: [3, 13] }, notes: [{ key: 'toPlay' as const }] }, when: (h: Hand) => h.len[s] >= 4 || h.hcp >= 15 }]),
    { call: 'P', shows: {} },
  ]
}

const books: Book[] = [
  { after: '2C (P)', rules: strongResponses, more: true },
  { after: '2C (X)', rules: strongDoubled, more: true },
  { after: ['2C (P) 2D (P)', '2C (X) P (P)'], rules: strongRebids, more: true },
]
for (const s of ['D', 'H', 'S'] as Suit[]) {
  books.push(
    // 2NT stays forcing when they double or bid
    { after: [`2${s} (P)`, `2${s} (+)`], rules: weakTwoResponses(s), more: true },
    { after: `2${s} (P) 2N (P)`, rules: featureAnswers(s), more: true },
  )
  for (const x of UP.filter((x) => x !== s)) books.push({ after: `2${s} (P) ${bid(above(x, s) ? 2 : 3, x)} (P)`, rules: afterNewSuit(s, x), more: true })
}
for (const s of UP) books.push({ after: `3${s} (P)`, rules: preemptResponses(s), more: true })

export const strong: readonly Book[] = books
