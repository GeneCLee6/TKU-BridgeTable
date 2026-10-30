import type { Call } from '../../../auction.ts'
import type { Suit } from '../../../cards.ts'
import { cheapest, type Ctx } from '../context.ts'
import type { Hand } from '../evaluate.ts'
import type { Book, Rule, Spec } from '../spec.ts'
import { openerRebids } from './rebids.ts'
import { above, bid, isMajor, MAJORS, other, plus, UP, upTo } from './util.ts'

/** After 1♣ or 1♦, docs/BBO GIB/gib-2over1.md §2 */

const noFourMajor = (h: Hand) => h.len.S < 4 && h.len.H < 4
const fewMajors: Spec['len'] = { S: [0, 3], H: [0, 3] }

/** The major to answer with: 4-4 hearts, 5-5 spades, otherwise the longer */
export function majorToBid(h: Hand): Suit | null {
  if (h.len.S >= 5 && h.len.S >= h.len.H) return 'S'
  if (h.len.H >= 4) return 'H'
  if (h.len.S >= 4) return 'S'
  return null
}

// ── Responses ─────────────────────────────────────────────────────────────────────────────────

function responses(m: Suit, passed: boolean): Rule[] {
  const support = m === 'C' ? 5 : 4
  const rules: Rule[] = []
  if (m === 'D') {
    // 2/1: game forcing by an unpassed hand; natural and not forcing by a passed hand
    rules.push(
      passed
        ? { call: '2C', shows: { len: { C: [5, 13], ...fewMajors }, hcp: [10, 11] } }
        : {
            call: '2C',
            shows: { len: { C: [4, 13] }, hcp: plus(12), forcing: 'game' },
            when: (h) => h.hcp >= 12 && (noFourMajor(h) || (h.len.C >= 5 && h.len.C > Math.max(h.len.S, h.len.H))),
          },
    )
  } else {
    rules.push({
      call: '1D',
      shows: { len: { D: [4, 13] }, hcp: plus(6), forcing: 'oneRound' },
      when: (h) => noFourMajor(h) || (h.len.D >= 5 && h.len.D > Math.max(h.len.S, h.len.H)),
    })
  }
  if (passed) {
    // Fit jumps by a passed hand: a five-card major and support for the minor
    for (const y of MAJORS)
      rules.push({
        call: bid(2, y),
        shows: { name: 'fitJump', len: { [y]: [5, 13], [m]: [4, 13] }, hcp: [9, 11] },
        when: (h) => h.len[m] >= 4 && majorToBid(h) === y,
      })
  }
  for (const y of MAJORS)
    rules.push({ call: bid(1, y), shows: { len: { [y]: [4, 13] }, hcp: plus(6), forcing: 'oneRound' }, when: (h) => majorToBid(h) === y })
  rules.push(
    {
      call: bid(2, m),
      shows: { name: 'invertedMinor', len: { [m]: [support, 13], ...fewMajors }, hcp: plus(10), forcing: 'oneRound' },
    },
    // 13+ (was 13–15: 16+ balanced without a four-card suit to bid passed 1♣, V4a)
    { call: '3N', shows: { hcp: plus(13), balanced: true, len: fewMajors } },
    { call: '2N', shows: { hcp: [11, 12], balanced: true, len: fewMajors, notes: [{ key: 'invite' }] } },
  )
  // Jumps to a lower suit at the three level are natural and invitational
  if (m === 'D') rules.push({ call: '3C', shows: { len: { C: [6, 13], ...fewMajors }, hcp: [9, 11], notes: [{ key: 'invite' }] } })
  rules.push(
    {
      call: bid(3, m),
      shows: { name: 'preemptiveRaise', len: { [m]: [5, 13], ...fewMajors }, hcp: [4, 9] },
      when: (h) => !h.balanced,
    },
    { call: '1N', shows: { hcp: [6, 10], len: fewMajors } },
    { call: 'P', shows: { hcp: upTo(5) } },
  )
  return rules
}

// ── Responder's rebid ─────────────────────────────────────────────────────────────────────────

/**
 * After 1m–1M–1NT: new minor forcing and the natural rebids. After 1♥–1♠–1NT the same with 2♣
 * as the new minor (一般), and 2♥ is preference with three
 */
export function afterNotrumpRebid(m: Suit, M: Suit): Rule[] {
  const nm = m === 'H' ? 'C' : other(m)
  const preference = m === 'H' ? 3 : 4
  // Opener's five hearts: raise with three
  const hearts: Rule[] =
    m === 'H'
      ? [
          { call: '4H', shows: { len: { H: [3, 13] }, hcp: plus(13), notes: [{ key: 'game' }] }, when: (h) => h.len.H >= 3 && h.len.S < 5 },
          { call: '3H', shows: { len: { H: [3, 13] }, hcp: [11, 12], notes: [{ key: 'invite' }] }, when: (h) => h.len.H >= 3 && h.len.S < 5 },
        ]
      : []
  return [
    ...hearts,
    { call: bid(4, M), shows: { len: { [M]: [6, 13] }, hcp: plus(13), notes: [{ key: 'game' }] } },
    // 13+ (was 13–15: with 16+ and no other call TKB passed 1NT, V4a)
    { call: '3N', shows: { hcp: plus(13), notes: [{ key: 'signoff' }] }, when: (h) => h.len[M] <= 4 && (M === 'S' || h.len.S < 4) },
    {
      call: bid(2, nm),
      shows: { name: 'newMinorForcing', hcp: plus(11), forcing: 'oneRound', artificial: true },
      when: (h) => h.len[M] >= 5 || (M === 'H' && h.len.S >= 4),
    },
    { call: bid(3, M), shows: { len: { [M]: [6, 13] }, hcp: [11, 12], notes: [{ key: 'invite' }] } },
    { call: '2N', shows: { hcp: [11, 12], notes: [{ key: 'invite' }] } },
    { call: bid(2, M), shows: { len: { [M]: [6, 13] }, hcp: [6, 10], notes: [{ key: 'signoff' }] } },
    { call: bid(2, m), shows: { len: { [m]: [preference, 13] }, hcp: [6, 10], notes: [{ key: 'signoff' }] }, when: (h) => h.len[m] >= preference },
    { call: 'P', shows: { hcp: [6, 10] } },
  ]
}

/**
 * Responder after opener's answer to new minor forcing (一般; GIB documents the answers): game with
 * a fit and 13+ (or opposite a maximum), notrump game without one, pass or invite with 11–12
 */
function afterNmfAnswer(M: Suit, answer: Call): Rule[] {
  const fitShown = answer === bid(2, M) || answer === bid(3, M)
  const maximum = answer === bid(3, M) || answer === '3N'
  const hearts = answer === '2H' && M === 'S'
  const rules: Rule[] = []
  if (answer === '3N') return [{ call: 'P', shows: { notes: [{ key: 'toPlay' }] } }]
  if (fitShown) {
    rules.push(
      { call: bid(4, M), shows: { len: { [M]: [5, 13] }, hcp: plus(maximum ? 11 : 13), notes: [{ key: 'game' }] }, when: (h) => h.len[M] >= 5 },
      { call: '3N', shows: { len: { [M]: [4, 4] }, hcp: plus(maximum ? 11 : 13), notes: [{ key: 'game' }] } },
      { call: 'P', shows: { hcp: [11, 12], notes: [{ key: 'toPlay' }] } },
    )
    return rules
  }
  if (hearts)
    rules.push(
      { call: '4H', shows: { len: { H: [4, 13] }, hcp: plus(13), notes: [{ key: 'game' }] }, when: (h) => h.len.H >= 4 },
      { call: '3H', shows: { len: { H: [4, 13] }, hcp: [11, 12], notes: [{ key: 'invite' }] }, when: (h) => h.len.H >= 4 },
    )
  rules.push(
    { call: bid(4, M), shows: { len: { [M]: [6, 13] }, hcp: plus(13), notes: [{ key: 'game' }] }, when: (h) => h.len[M] >= 6 },
    { call: '3N', shows: { hcp: plus(13), notes: [{ key: 'game' }] } },
    { call: bid(3, M), shows: { len: { [M]: [6, 13] }, hcp: [11, 12], notes: [{ key: 'invite' }] }, when: (h) => h.len[M] >= 6 && answer !== '2N' },
  )
  rules.push(answer === '2N' ? { call: 'P', shows: { hcp: [11, 12], notes: [{ key: 'toPlay' }] } } : { call: '2N', shows: { hcp: [11, 12], notes: [{ key: 'invite' }] } })
  return rules
}

/** Opener answers new minor forcing: three-card support, the other major, or no fit; minimum or maximum */
export function answersToNmf(M: Suit, otherMajor = M === 'S'): Rule[] {
  const rules: Rule[] = [
    { call: bid(3, M), shows: { len: { [M]: [3, 3] }, hcp: [13, 14], notes: [{ key: 'maximum' }] } },
    { call: bid(2, M), shows: { len: { [M]: [3, 3] }, hcp: [11, 12], notes: [{ key: 'minimum' }] } },
  ]
  if (otherMajor) rules.push({ call: '2H', shows: { len: { H: [4, 4], S: [0, 2] }, hcp: [11, 14] } })
  rules.push(
    { call: '3N', shows: { len: { [M]: [0, 2] }, hcp: [13, 14], notes: [{ key: 'maximum' }] } },
    { call: '2N', shows: { len: { [M]: [0, 2] }, hcp: [11, 12], notes: [{ key: 'minimum' }] } },
  )
  return rules
}

/**
 * Three suits bid at the one or two level: the fourth suit is artificial and game forcing, for a
 * game hand without four cards in opener's second suit or a stopper for notrump
 */
function fourthSuit(fourth: Suit, level: number, second: Suit): Rule[] {
  const stopped = (h: Hand) => h.balanced && (h.stop[fourth] === 'stop' || h.stop[fourth] === 'double')
  return [
    {
      call: bid(level, fourth),
      shows: { name: 'fourthSuit', hcp: plus(12), forcing: 'game', artificial: true },
      when: (h) => h.len[second] < 4 && !stopped(h),
    },
    // A jump in the fourth suit is natural and game forcing
    { call: bid(level + 1, fourth), shows: { len: { [fourth]: [5, 13] }, hcp: plus(12), forcing: 'game' } },
  ]
}

/**
 * Opener answers fourth suit forcing (一般; GIB documents only the ask): three cards in
 * responder's major (four in a minor), notrump with a stopper in the fourth suit, five cards in the
 * second suit, six in the first, otherwise the first suit again (four or more). Each at its cheapest level: the
 * auction is already forcing to game
 */
export function answersFourthSuit(o: Suit, y: Suit, z: Suit, w: Suit): Rule[] {
  const at = (s: Suit | 'N') => (ctx: Ctx) => cheapest(ctx, s)
  const gf = { forcing: 'game' as const }
  return [
    { call: at(y), shows: { len: { [y]: [isMajor(y) ? 3 : 4, 13] }, notes: [{ key: 'support', strain: y }], ...gf }, when: (h) => h.len[y] >= (isMajor(y) ? 3 : 4) },
    { call: at('N'), shows: { stop: { [w]: 'likely' }, ...gf }, when: (h) => h.stop[w] !== null && h.stop[w] !== 'partial' },
    { call: at(z), shows: { len: { [z]: [5, 13] }, ...gf }, when: (h) => h.len[z] >= 5 },
    { call: at(o), shows: { len: { [o]: [6, 13] }, ...gf }, when: (h) => h.len[o] >= 6 },
    { call: at(o), shows: { len: { [o]: [4, 13] }, ...gf } },
  ]
}

/**
 * Opener after an inverted raise (一般; GIB documents the raise as forcing): 2NT 12–14 balanced,
 * 3NT 18–19 balanced, a new suit with four or more and an unbalanced hand (forcing), three of the
 * minor with a minimum and no notrump shape
 */
function afterInverted(m: Suit): Rule[] {
  return [
    { call: '3N', shows: { hcp: [18, 19], balanced: true } },
    { call: '2N', shows: { hcp: [11, 14], balanced: true } },
    ...UP.filter((z) => above(z, m)).map(
      (z): Rule => ({
        call: bid(2, z),
        shows: { len: { [z]: [4, 13] }, hcp: plus(11), forcing: 'oneRound' },
        when: (h) => !h.balanced && h.len[z] >= 4 && h.hcp >= 12 && UP.every((s) => s === z || s === m || !above(s, m) || h.len[s] <= h.len[z]),
      }),
    ),
    { call: bid(3, m), shows: { len: { [m]: [4, 13] }, hcp: [11, 14], notes: [{ key: 'minimum' }] }, when: (h) => h.hcp <= 14 },
    // Extra values without a side four-card suit: a stopper, forcing
    ...UP.filter((z) => above(z, m)).map(
      (z): Rule => ({ call: bid(2, z), shows: { stop: { [z]: 'stop' }, hcp: plus(15), forcing: 'oneRound' }, when: (h) => h.stop[z] === 'stop' || h.stop[z] === 'double' }),
    ),
  ]
}

/**
 * Opener after 1♦–2♣, a game force (一般, as after a 2/1 over a major): raise with four clubs, a
 * four-card major, notrump by strength with a balanced hand, otherwise diamonds again
 */
const afterOneDiamondTwoClubs: Rule[] = [
  { call: '3C', shows: { len: { C: [4, 13] }, forcing: 'game' }, when: (h) => h.len.C >= 4 && !h.balanced },
  ...(['H', 'S'] as Suit[]).map((z): Rule => ({ call: bid(2, z), shows: { len: { [z]: [4, 13] }, forcing: 'game' }, when: (h) => h.len[z] >= 4 && !h.balanced })),
  { call: '3N', shows: { hcp: [18, 19], balanced: true, forcing: 'game' } },
  { call: '2N', shows: { hcp: [11, 14], balanced: true, forcing: 'game' } },
  { call: '3C', shows: { len: { C: [4, 13] }, forcing: 'game' }, when: (h) => h.len.C >= 4 },
  { call: '2D', shows: { len: { D: [4, 13] }, forcing: 'game' } },
]

/** After opener's reverse: 2NT is a weak relay to 3♣ (Lebensohl); anything else is forcing */
const reverseRelay: Rule = {
  call: '2N',
  shows: { name: 'lebensohl', hcp: [5, 8], notes: [{ key: 'relayTo', calls: ['3C'] }], artificial: true, forcing: 'oneRound' },
  when: (h) => h.hcp <= 8,
}

/** After the relay: sign off in our major or opener's minor, or pass 3♣ */
function afterRelay(m: Suit, M: Suit): Rule[] {
  const rules: Rule[] = [{ call: bid(3, M), shows: { len: { [M]: [6, 13] }, hcp: [5, 8], notes: [{ key: 'signoff' }] } }]
  if (m === 'D') rules.push({ call: '3D', shows: { len: { D: [3, 13] }, hcp: [5, 8], notes: [{ key: 'signoff' }] }, when: (h) => h.len.C < 5 })
  rules.push({ call: 'P', shows: { hcp: [5, 8], notes: [{ key: 'toPlay' }] } })
  return rules
}

// ── The books ─────────────────────────────────────────────────────────────────────────────────

const books: Book[] = []
for (const m of ['C', 'D'] as Suit[]) {
  books.push(
    { after: `1${m} (P)`, only: (ctx: Ctx) => !ctx.passed, rules: responses(m, false), more: true },
    { after: `1${m} (P)`, only: (ctx: Ctx) => ctx.passed, rules: responses(m, true), more: true },
  )
  const answers: Suit[] = m === 'C' ? ['D', 'H', 'S'] : ['H', 'S']
  for (const y of answers) books.push({ after: `1${m} (P) 1${y} (P)`, rules: openerRebids(m, y), more: true })
  books.push({ after: `1${m} (P) 2${m} (P)`, rules: afterInverted(m), more: true })
  if (m === 'D') books.push({ after: '1D (P) 2C (P)', only: (ctx: Ctx) => !ctx.partnerPassed, rules: afterOneDiamondTwoClubs, more: true })
  for (const M of MAJORS) {
    books.push(
      { after: `1${m} (P) 1${M} (P) 1N (P)`, rules: afterNotrumpRebid(m, M), more: true },
      { after: `1${m} (P) 1${M} (P) 1N (P) 2${other(m)} (P)`, rules: answersToNmf(M), more: true },
    )
    for (const answer of [bid(2, M), bid(3, M), '2N', '3N', ...(M === 'S' ? ['2H'] : [])])
      books.push({ after: `1${m} (P) 1${M} (P) 1N (P) 2${other(m)} (P) ${answer} (P)`, rules: afterNmfAnswer(M, answer), more: true })
  }
}
// New minor forcing after 1♥–1♠–1NT too (一般): 2♣
books.push(
  { after: '1H (P) 1S (P) 1N (P)', rules: afterNotrumpRebid('H', 'S'), more: true },
  { after: '1H (P) 1S (P) 1N (P) 2C (P)', rules: answersToNmf('S', false), more: true },
  ...['2S', '3S', '2N', '3N'].map((answer): Book => ({ after: `1H (P) 1S (P) 1N (P) 2C (P) ${answer} (P)`, rules: afterNmfAnswer('S', answer), more: true })),
)
for (const m of ['C', 'D'] as Suit[]) {
  for (const M of MAJORS) {
    for (const z of UP.filter((z) => z !== M && above(z, m) && !above(z, M)))
      books.push(
        { after: `1${m} (P) 1${M} (P) 2${z} (P)`, rules: [reverseRelay], more: true },
        { after: `1${m} (P) 1${M} (P) 2${z} (P) 2N (P)`, rules: [{ call: '3C', shows: { notes: [{ key: 'completes' }], artificial: true } }], more: true },
        { after: `1${m} (P) 1${M} (P) 2${z} (P) 2N (P) 3C (P)`, rules: afterRelay(m, M), more: true },
      )
  }
}

// Fourth suit forcing: the auction, the fourth suit at its cheapest level, opener's second suit
// (after a major opening too: 1♥–1♠–2♣–2♦, 1♥–1♠–2♦–3♣)
const FOURTH: readonly [string, Suit, number, Suit][] = [
  ['1C (P) 1D (P) 1H (P)', 'S', 1, 'H'],
  ['1C (P) 1D (P) 1S (P)', 'H', 2, 'S'],
  ['1C (P) 1H (P) 1S (P)', 'D', 2, 'S'],
  ['1D (P) 1H (P) 1S (P)', 'C', 2, 'S'],
  ['1D (P) 1H (P) 2C (P)', 'S', 2, 'C'],
  ['1D (P) 1S (P) 2C (P)', 'H', 2, 'C'],
  ['1H (P) 1S (P) 2C (P)', 'D', 2, 'C'],
  ['1H (P) 1S (P) 2D (P)', 'C', 3, 'D'],
]
for (const [after, fourth, level, second] of FOURTH) {
  const [o, y] = [after[1], after[8]] as Suit[]
  books.push(
    { after, only: (ctx: Ctx) => !ctx.passed, rules: fourthSuit(fourth, level, second), more: true },
    { after: `${after} ${bid(level, fourth)} (P)`, only: (ctx: Ctx) => !ctx.partnerPassed, rules: answersFourthSuit(o, y, second, fourth), more: true },
  )
}

export const minors: readonly Book[] = books
