import type { Suit } from '../../../cards.ts'
import type { Ctx } from '../context.ts'
import type { Hand } from '../evaluate.ts'
import type { Book, Rule, Spec } from '../spec.ts'
import { bid, isMajor, MAJORS, other, plus, upTo } from './util.ts'

/** After 1♣ or 1♦, docs/BBO GIB/gib-2over1.md §2 */

/** Suits from the bottom: ♣ ♦ ♥ ♠ */
const UP: readonly Suit[] = ['C', 'D', 'H', 'S']
const above = (a: Suit, b: Suit) => UP.indexOf(a) > UP.indexOf(b)

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
    { call: '3N', shows: { hcp: [13, 15], balanced: true, len: fewMajors } },
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

// ── Opener's rebid after a one-level response ─────────────────────────────────────────────────

/** Opener's rebids after 1m–1y */
function openerRebids(m: Suit, y: Suit): Rule[] {
  const rules: Rule[] = []
  const others = UP.filter((z) => z !== m && z !== y)
  // A new suit we can show at the one level, the cheapest first
  const oneLevel = others.filter((z) => above(z, y))
  // At the two level: a reverse when higher than our minor, a plain new suit when lower
  const twoLevel = others.filter((z) => !above(z, y))
  const jumpLevel = (z: Suit) => (above(z, y) ? 2 : 3)

  if (isMajor(y)) rules.push({ call: bid(4, y), shows: { len: { [y]: [4, 13] }, hcp: [18, 21], notes: [{ key: 'game' }] } })
  rules.push({ call: '2N', shows: { hcp: [18, 19], balanced: true } })
  // Jump shifts: 19+ and game forcing
  for (const z of others)
    rules.push({ call: bid(jumpLevel(z), z), shows: { len: { [z]: [4, 13] }, hcp: [19, 21], forcing: 'game' }, when: (h) => !(isMajor(y) && h.len[y] >= 4) })
  rules.push(
    { call: bid(3, y), shows: { len: { [y]: [4, 13] }, hcp: [15, 17], notes: [{ key: 'invite' }] } },
    { call: bid(3, m), shows: { len: { [m]: [6, 13] }, hcp: [17, 20] } },
  )
  // Reverses: a higher suit at the two level, 17+, the minor longer, forcing
  for (const z of twoLevel.filter((z) => above(z, m)))
    rules.push({
      call: bid(2, z),
      shows: { name: 'reverse', len: { [z]: [4, 13], [m]: [5, 13] }, hcp: [17, 21], forcing: 'oneRound' },
      when: (h) => h.len[m] > h.len[z] && !(isMajor(y) && h.len[y] >= 4),
    })
  // A raise of 1♦ would hide a four-card major
  rules.push({ call: bid(2, y), shows: { len: { [y]: [4, 13] }, hcp: [11, 14] }, when: (h) => isMajor(y) || noFourMajor(h) })
  // A new suit at the one level: four or more, the cheapest first (no four cards in partner's major)
  for (const z of oneLevel)
    rules.push({ call: bid(1, z), shows: { len: { [z]: [4, 13] }, hcp: [11, 17] }, when: (h) => !(isMajor(y) && h.len[y] >= 4) })
  rules.push({ call: '1N', shows: { hcp: [11, 14], balanced: true } })
  for (const z of twoLevel.filter((z) => !above(z, m)))
    rules.push({ call: bid(2, z), shows: { len: { [z]: [4, 13] }, hcp: [11, 17] } })
  rules.push({ call: bid(2, m), shows: { len: { [m]: [5, 13] }, hcp: [11, 16] } })
  return rules
}

// ── Responder's rebid ─────────────────────────────────────────────────────────────────────────

/** After 1m–1M–1NT: new minor forcing and the natural rebids */
function afterNotrumpRebid(m: Suit, M: Suit): Rule[] {
  const nm = other(m)
  return [
    { call: bid(4, M), shows: { len: { [M]: [6, 13] }, hcp: plus(13), notes: [{ key: 'game' }] } },
    { call: '3N', shows: { hcp: [13, 15], notes: [{ key: 'signoff' }] }, when: (h) => h.len[M] <= 4 && (M === 'S' || h.len.S < 4) },
    {
      call: bid(2, nm),
      shows: { name: 'newMinorForcing', hcp: plus(11), forcing: 'oneRound', artificial: true },
      when: (h) => h.len[M] >= 5 || (M === 'H' && h.len.S >= 4),
    },
    { call: bid(3, M), shows: { len: { [M]: [6, 13] }, hcp: [11, 12], notes: [{ key: 'invite' }] } },
    { call: '2N', shows: { hcp: [11, 12], notes: [{ key: 'invite' }] } },
    { call: bid(2, M), shows: { len: { [M]: [6, 13] }, hcp: [6, 10], notes: [{ key: 'signoff' }] } },
    { call: bid(2, m), shows: { len: { [m]: [4, 13] }, hcp: [6, 10], notes: [{ key: 'signoff' }] }, when: (h) => h.len[m] >= 4 },
    { call: 'P', shows: { hcp: [6, 10] } },
  ]
}

/** Opener answers new minor forcing: three-card support, the other major, or no fit; minimum or maximum */
function answersToNmf(M: Suit): Rule[] {
  const rules: Rule[] = [
    { call: bid(3, M), shows: { len: { [M]: [3, 3] }, hcp: [13, 14], notes: [{ key: 'maximum' }] } },
    { call: bid(2, M), shows: { len: { [M]: [3, 3] }, hcp: [11, 12], notes: [{ key: 'minimum' }] } },
  ]
  if (M === 'S') rules.push({ call: '2H', shows: { len: { H: [4, 4], S: [0, 2] }, hcp: [11, 14] } })
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
  for (const M of MAJORS) {
    books.push(
      { after: `1${m} (P) 1${M} (P) 1N (P)`, rules: afterNotrumpRebid(m, M), more: true },
      { after: `1${m} (P) 1${M} (P) 1N (P) 2${other(m)} (P)`, rules: answersToNmf(M), more: true },
    )
    for (const z of UP.filter((z) => z !== M && above(z, m) && !above(z, M)))
      books.push(
        { after: `1${m} (P) 1${M} (P) 2${z} (P)`, rules: [reverseRelay], more: true },
        { after: `1${m} (P) 1${M} (P) 2${z} (P) 2N (P)`, rules: [{ call: '3C', shows: { notes: [{ key: 'completes' }], artificial: true } }], more: true },
        { after: `1${m} (P) 1${M} (P) 2${z} (P) 2N (P) 3C (P)`, rules: afterRelay(m, M), more: true },
      )
  }
}

// Fourth suit forcing: the auction, the fourth suit at its cheapest level, opener's second suit
const FOURTH: readonly [string, Suit, number, Suit][] = [
  ['1C (P) 1D (P) 1H (P)', 'S', 1, 'H'],
  ['1C (P) 1D (P) 1S (P)', 'H', 2, 'S'],
  ['1C (P) 1H (P) 1S (P)', 'D', 2, 'S'],
  ['1D (P) 1H (P) 1S (P)', 'C', 2, 'S'],
  ['1D (P) 1H (P) 2C (P)', 'S', 2, 'C'],
  ['1D (P) 1S (P) 2C (P)', 'H', 2, 'C'],
]
for (const [after, fourth, level, second] of FOURTH) books.push({ after, rules: fourthSuit(fourth, level, second), more: true })

export const minors: readonly Book[] = books
