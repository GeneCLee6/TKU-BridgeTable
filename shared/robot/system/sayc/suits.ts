import type { Suit } from '../../../cards.ts'
import { cheapest, type Ctx } from '../context.ts'
import type { Hand } from '../evaluate.ts'
import type { Book, Range, Rule, Spec } from '../spec.ts'
import { above, bid, isMajor, isMinor, MAJORS, plus, UP, upTo } from '../gib/util.ts'

/** After a one-level suit opening, docs/systems/sayc.md §2 and §3: a two-level new suit forces one round, not to game */

const MIN: Range = [11, 15]
const MEDIUM: Range = [16, 18]
const MAX: Range = [19, 21]
/** Opener's minimum notrump rebid: 15 balanced opened 1NT */
const MIN_NT: Range = [11, 14]
/** Responder's sign-off, invitation and game-going strength */
const WEAK: Range = [6, 9]
const INVITE: Range = [10, 11]
const GAME = plus(12)

const lengthToRaise = (s: Suit) => (isMajor(s) ? 3 : s === 'D' ? 4 : 5)
const noFourMajor = (h: Hand) => h.len.S < 4 && h.len.H < 4
const fewMajors: Spec['len'] = { S: [0, 3], H: [0, 3] }

/** The suit to bid at the one level over `o`: the longest, the lowest of equal ones (up the line) */
function upTheLine(h: Hand, o: Suit): Suit | null {
  const able = UP.filter((s) => above(s, o) && h.len[s] >= 4)
  return able.length ? able.reduce((best, s) => (h.len[s] > h.len[best] ? s : best)) : null
}

/** A new suit at the two level over `o`: hearts need five; of the minors the longer, the lower of 4-4, the higher of 5-5 */
function twoLevelSuit(h: Hand, o: Suit): Suit | null {
  const minors = UP.filter((s) => isMinor(s) && s !== o && !above(s, o) && h.len[s] >= 4)
  const best = minors.length ? minors.reduce((a, s) => (h.len[s] > h.len[a] || (h.len[s] === h.len[a] && h.len[s] >= 5) ? s : a)) : null
  if (o === 'S' && h.len.H >= 5 && (!best || h.len.H >= h.len[best])) return 'H'
  return best
}

/** A strong jump shift: 17+, the suit the hand's longest */
const jumpShift = (o: Suit, x: Suit): Rule => ({
  call: bid(above(x, o) ? 2 : 3, x),
  shows: { len: { [x]: [5, 13] }, hcp: plus(17), notes: [{ key: 'slamInterest' }], forcing: 'game' },
  when: (h) => UP.every((s) => h.len[s] <= h.len[x]),
})

// ── Responses to a major ─────────────────────────────────────────────────────────────────────

function majorResponses(M: Suit, passed: boolean): Rule[] {
  const rules: Rule[] = []
  if (!passed) {
    rules.push({
      call: '2N',
      shows: { name: 'jacoby2N', len: { [M]: [3, 13] }, tp: plus(13), forcing: 'game' },
      // Three trumps only without a suit to bid first and raise afterwards
      when: (h) => h.len[M] >= 4 || (h.len[M] === 3 && !twoLevelSuit(h, M)),
    })
    rules.push({ call: '3N', shows: { len: { [M]: [2, 2] }, hcp: [15, 17], balanced: true } })
    for (const x of UP.filter((s) => s !== M)) rules.push(jumpShift(M, x))
  }
  rules.push(
    { call: bid(4, M), shows: { name: 'preemptiveRaise', len: { [M]: [5, 13] }, hcp: upTo(9) }, when: (h) => h.shape[3] <= 1 },
    { call: bid(3, M), shows: { name: 'limitRaise', len: { [M]: [3, 13] }, tp: INVITE, notes: [{ key: 'invite' }] } },
  )
  if (M === 'H') rules.push({ call: '1S', shows: { len: { S: [4, 13] }, hcp: plus(6), forcing: 'oneRound' }, when: (h) => h.len.H < 3 || h.len.S >= 5 })
  const twoLevel = (x: Suit): Rule => ({
    call: bid(2, x),
    shows: { len: { [x]: [x === 'H' ? 5 : 4, 13] }, hcp: plus(10), ...(passed ? {} : { forcing: 'oneRound' as const }) },
    when: (h) => twoLevelSuit(h, M) === x,
  })
  if (M === 'S') rules.push(twoLevel('H'))
  rules.push(
    twoLevel('D'),
    twoLevel('C'),
    { call: bid(2, M), shows: { len: { [M]: [3, 13] }, tp: [6, 10] } },
    // No suit to bid and too good to raise once: the limit raise, a point over
    { call: bid(3, M), shows: { name: 'limitRaise', len: { [M]: [3, 13] }, tp: [12, 12], notes: [{ key: 'invite' }] } },
    { call: '1N', shows: { hcp: WEAK } },
    { call: 'P', shows: { hcp: upTo(5) } },
  )
  return rules
}

// ── Responses to a minor ─────────────────────────────────────────────────────────────────────

function minorResponses(m: Suit, passed: boolean): Rule[] {
  const support = lengthToRaise(m)
  const noOneLevel = (h: Hand) => !upTheLine(h, m)
  const rules: Rule[] = []
  if (!passed) {
    for (const x of UP.filter((s) => s !== m)) rules.push(jumpShift(m, x))
    rules.push(
      { call: '3N', shows: { hcp: [16, 18], balanced: true, len: fewMajors }, when: noOneLevel },
      { call: '2N', shows: { hcp: [13, 15], balanced: true, len: fewMajors, forcing: 'game' }, when: noOneLevel },
    )
  }
  rules.push({ call: bid(3, m), shows: { len: { [m]: [support, 13], ...fewMajors }, tp: INVITE, notes: [{ key: 'invite' }] }, when: noOneLevel })
  if (m === 'D')
    rules.push({
      call: '2C',
      shows: { len: { C: [4, 13] }, hcp: plus(10), ...(passed ? {} : { forcing: 'oneRound' as const }) },
      when: (h) => noFourMajor(h) || (h.len.C >= 5 && h.len.C > Math.max(h.len.S, h.len.H)),
    })
  for (const y of UP.filter((s) => above(s, m))) rules.push({ call: bid(1, y), shows: { len: { [y]: [4, 13] }, hcp: plus(6), forcing: 'oneRound' }, when: (h) => upTheLine(h, m) === y })
  rules.push(
    { call: bid(2, m), shows: { len: { [m]: [support, 13], ...fewMajors }, tp: [6, 10] }, when: noOneLevel },
    { call: bid(3, m), shows: { len: { [m]: [support, 13], ...fewMajors }, tp: [12, 12], notes: [{ key: 'invite' }] }, when: noOneLevel },
    // Nothing else describes 10–12 without a long suit: the widest notrump
    { call: '1N', shows: { hcp: [6, 12], len: fewMajors } },
    { call: 'P', shows: { hcp: upTo(5) } },
  )
  return rules
}

// ── Opener's rebid ───────────────────────────────────────────────────────────────────────────

/**
 * Opener after a one-level response (`y`) by strength: 11–15 the lowest rebids, 16–18 a jump or a
 * reverse, 19+ a double jump or a jump shift; a non-reverse new suit may be anything up to 18
 */
function openerRebids(o: Suit, y: Suit): Rule[] {
  const others = UP.filter((z) => z !== o && z !== y)
  const fourInMajor = (h: Hand) => isMajor(y) && h.len[y] >= 4
  const jumpLevel = (z: Suit) => (above(z, y) ? 2 : 3)
  const own: Range = [isMajor(o) ? 5 : 4, 13]
  const rules: Rule[] = []
  if (isMajor(y)) rules.push({ call: bid(4, y), shows: { len: { [y]: [4, 13] }, hcp: MAX, notes: [{ key: 'game' }] } })
  if (isMajor(o)) rules.push({ call: bid(4, o), shows: { len: { [o]: [6, 13] }, hcp: MAX, notes: [{ key: 'game' }] }, when: (h) => h.len[o] >= 6 })
  rules.push({ call: '2N', shows: { hcp: [18, 19], balanced: true } })
  for (const z of others) rules.push({ call: bid(jumpLevel(z), z), shows: { len: { [z]: [4, 13] }, hcp: MAX, forcing: 'game' }, when: (h) => !fourInMajor(h) })
  rules.push(
    { call: bid(3, y), shows: { len: { [y]: [4, 13] }, hcp: MEDIUM, notes: [{ key: 'invite' }] } },
    { call: bid(3, o), shows: { len: { [o]: [6, 13] }, hcp: MEDIUM, notes: [{ key: 'invite' }] } },
  )
  for (const z of others.filter((z) => above(z, o) && !above(z, y)))
    rules.push({
      call: bid(2, z),
      shows: { name: 'reverse', len: { [z]: [4, 13], [o]: [5, 13] }, hcp: MEDIUM, forcing: 'oneRound' },
      when: (h) => h.len[o] > h.len[z] && !fourInMajor(h),
    })
  rules.push({
    call: bid(2, y),
    shows: { len: { [y]: [isMajor(y) ? 3 : 4, 13] }, hcp: MIN },
    // Good three-card support with a ruffing value is enough for a major; 1♦ hides no four-card major
    when: (h) => (isMajor(y) ? h.len[y] >= 4 || (/[AKQ]/.test(h.ranks[y]) && h.shape[3] <= 1) : noFourMajor(h) && h.len[y] >= 4),
  })
  for (const z of others.filter((z) => above(z, y))) rules.push({ call: bid(1, z), shows: { len: { [z]: [4, 13] }, hcp: [11, 18] }, when: (h) => !fourInMajor(h) })
  rules.push({ call: '1N', shows: { hcp: MIN_NT, balanced: true } })
  for (const z of others.filter((z) => !above(z, y) && !above(z, o))) rules.push({ call: bid(2, z), shows: { len: { [z]: [4, 13] }, hcp: [11, 18] } })
  rules.push({ call: bid(2, o), shows: { len: { [o]: own }, hcp: MIN } })
  return rules
}

/** Opener after 1x–1NT, which may be passed */
function openerAfterNotrump(o: Suit): Rule[] {
  const others = UP.filter((z) => z !== o)
  const rules: Rule[] = []
  if (isMajor(o)) rules.push({ call: bid(4, o), shows: { len: { [o]: [6, 13] }, hcp: MAX, notes: [{ key: 'game' }] } })
  rules.push({ call: '3N', shows: { hcp: MAX, balanced: true } })
  for (const z of others.filter((z) => !above(z, o))) rules.push({ call: bid(3, z), shows: { len: { [z]: [4, 13] }, hcp: MAX, forcing: 'game' } })
  rules.push(
    { call: '2N', shows: { hcp: [18, 19], balanced: true, notes: [{ key: 'invite' }] } },
    { call: bid(3, o), shows: { len: { [o]: [6, 13] }, hcp: MEDIUM, notes: [{ key: 'invite' }] } },
  )
  for (const z of others.filter((z) => above(z, o))) rules.push({ call: bid(2, z), shows: { name: 'reverse', len: { [z]: [4, 13], [o]: [5, 13] }, hcp: plus(16), forcing: 'oneRound' }, when: (h) => h.len[o] > h.len[z] })
  for (const z of others.filter((z) => !above(z, o))) rules.push({ call: bid(2, z), shows: { len: { [z]: [4, 13] }, hcp: [11, 18] } })
  rules.push(
    { call: bid(2, o), shows: { len: { [o]: [isMajor(o) ? 6 : 5, 13] }, hcp: MIN }, when: (h) => !h.balanced },
    { call: 'P', shows: { hcp: MIN_NT, balanced: true } },
    { call: bid(2, o), shows: { len: { [o]: [isMajor(o) ? 5 : 3, 13] }, hcp: MIN } },
  )
  return rules
}

/** Responder after 1x–1NT–2z: pass with z, a preference to our suit, or a raise with the top */
function responderAfterNotrump(o: Suit, z: Suit): Rule[] {
  return [
    { call: bid(3, z), shows: { len: { [z]: [4, 13] }, hcp: [8, 12], notes: [{ key: 'invite' }] }, when: (h) => h.len[z] >= 4 && h.hcp >= 8 },
    { call: bid(2, o), shows: { len: { [o]: [isMajor(o) ? 2 : 3, 13] }, notes: [{ key: 'preference', strain: o }] }, when: (h) => h.len[o] > h.len[z] },
    { call: 'P', shows: { notes: [{ key: 'preference', strain: z }] } },
  ]
}

/** After a raise of a major: a new suit asks for help there (natural), three of the major invites, 19+ bids game */
function afterMajorRaise(M: Suit): Rule[] {
  const help = (h: Hand, x: Suit) => h.len[x] >= 3 && /[AKQ]/.test(h.ranks[x]) && !h.ranks[x].startsWith('AK')
  const rules: Rule[] = [{ call: bid(4, M), shows: { tp: plus(19), notes: [{ key: 'game' }] } }]
  for (const x of UP.filter((s) => s !== M)) {
    const call = above(x, M) ? bid(2, x) : bid(3, x)
    rules.push({ call, shows: { name: 'longSuitTry', len: { [x]: [3, 13] }, tp: [16, 18], notes: [{ key: 'tryIn', strain: x }], forcing: 'oneRound' }, when: (h) => help(h, x) })
  }
  rules.push(
    { call: '2N', shows: { hcp: [18, 19], balanced: true, notes: [{ key: 'invite' }] } },
    { call: bid(3, M), shows: { tp: [16, 18], notes: [{ key: 'invite' }] } },
    { call: 'P', shows: { tp: upTo(15) } },
  )
  return rules
}

/** Responder answers a try: game with the top of the raise or help in the suit */
function answerTry(M: Suit, x: Suit | null): Rule[] {
  const helps = (h: Hand) => !!x && (h.len[x] <= 1 || /[AK]/.test(h.ranks[x]))
  return [
    { call: bid(4, M), shows: { notes: [{ key: 'accept' }] }, when: (h) => h.tp >= 9 || (h.tp >= 7 && helps(h)) },
    { call: bid(3, M), shows: { notes: [{ key: 'decline' }] } },
    { call: 'P', shows: { notes: [{ key: 'decline' }] } },
  ]
}

/** Jacoby 2NT: second suit, shortness, then strength with neither */
function afterJacoby(M: Suit): Rule[] {
  const rules: Rule[] = []
  for (const x of UP.filter((s) => s !== M))
    rules.push({ call: bid(4, x), shows: { len: { [x]: [5, 13] }, quality: { [x]: 'rebiddable' } }, when: (h) => /^(AK|AQ|KQ)/.test(h.ranks[x]) })
  for (const x of UP.filter((s) => s !== M)) rules.push({ call: bid(3, x), shows: { len: { [x]: [0, 1] }, notes: [{ key: 'shortIn', strain: x }], forcing: 'game' }, when: (h) => h.len[x] <= 1 })
  rules.push(
    { call: bid(3, M), shows: { hcp: plus(18), notes: [{ key: 'noShortness' }, { key: 'maximum' }], forcing: 'game' } },
    { call: '3N', shows: { hcp: [15, 17], notes: [{ key: 'noShortness' }], forcing: 'game' } },
    { call: bid(4, M), shows: { hcp: upTo(14), notes: [{ key: 'noShortness' }, { key: 'minimum' }] } },
  )
  return rules
}

// ── After a two-level new suit ───────────────────────────────────────────────────────────────

/** Opener after a two-level response: the same ladder, with every rebid forcing because responder promised to bid again */
function afterTwoLevel(o: Suit, x: Suit, responderPassed: boolean): Rule[] {
  const force = responderPassed ? {} : { forcing: 'oneRound' as const }
  const others = UP.filter((z) => z !== o && z !== x)
  const support = isMajor(x) ? 3 : 4
  const rules: Rule[] = []
  for (const z of others) rules.push({ call: bid(above(z, x) ? 3 : 4, z), shows: { len: { [z]: [4, 13] }, hcp: MAX, forcing: 'game' } })
  rules.push(
    { call: '3N', shows: { hcp: [18, 19], balanced: true } },
    { call: bid(4, x), shows: { len: { [x]: [support + 1, 13] }, hcp: MEDIUM, forcing: isMajor(x) ? undefined : 'game' } },
    { call: bid(3, o), shows: { len: { [o]: [6, 13] }, hcp: MEDIUM, ...force } },
  )
  for (const z of others.filter((z) => above(z, o))) rules.push({ call: bid(above(z, x) ? 2 : 3, z), shows: { name: 'reverse', len: { [z]: [4, 13], [o]: [5, 13] }, hcp: MEDIUM, ...force }, when: (h) => h.len[o] > h.len[z] })
  rules.push({ call: bid(3, x), shows: { len: { [x]: [support, 13] }, hcp: MIN, ...force } })
  for (const z of others.filter((z) => !above(z, o))) rules.push({ call: bid(above(z, x) ? 2 : 3, z), shows: { len: { [z]: [4, 13] }, hcp: [11, 18], ...force } })
  rules.push(
    { call: '2N', shows: { hcp: MIN_NT, balanced: true, ...force } },
    { call: bid(2, o), shows: { len: { [o]: [isMajor(o) ? 5 : 4, 13] }, hcp: MIN, ...force } },
  )
  return rules
}

/**
 * Responder's second call after a two-level new suit: two of our suit is a preference that may be
 * passed, 2NT and three of a bid suit invite, a jump to three of opener's first suit or a new suit
 * forces to game. `again` is three of opener's suit when it is not a jump: an invitation
 */
function afterTwoLevelRebid(o: Suit, x: Suit, z: Suit | null, again: boolean): Rule[] {
  const fit = lengthToRaise(o)
  const rules: Rule[] = [
    ...(isMajor(o) ? [{ call: bid(4, o), shows: { len: { [o]: [again ? 2 : 3, 13] }, hcp: GAME, notes: [{ key: 'game' as const }] } }] : []),
    { call: '3N', shows: { hcp: GAME, notes: [{ key: 'signoff' }] }, when: (h) => h.balanced },
    again
      ? { call: bid(3, o), shows: { len: { [o]: [2, 13] }, hcp: INVITE, notes: [{ key: 'invite' }] }, when: (h) => h.len[o] >= 2 }
      : { call: bid(3, o), shows: { len: { [o]: [fit, 13] }, hcp: GAME, forcing: 'game' }, when: (h) => h.len[o] >= fit },
  ]
  if (z && isMajor(z)) rules.push({ call: bid(4, z), shows: { len: { [z]: [4, 13] }, hcp: GAME, notes: [{ key: 'game' }] } })
  for (const w of UP.filter((s) => s !== o && s !== x && s !== z))
    rules.push({
      call: (ctx: Ctx) => cheapest(ctx, w),
      shows: { hcp: GAME, forcing: 'game', ...(z ? { name: 'fourthSuit' as const, artificial: true } : { len: { [w]: [4, 13] } }) },
    })
  if (z) rules.push({ call: bid(3, z), shows: { len: { [z]: [4, 13] }, hcp: INVITE, notes: [{ key: 'invite' }] } })
  rules.push(
    { call: bid(3, x), shows: { len: { [x]: [isMinor(x) ? 6 : 5, 13] }, hcp: INVITE, notes: [{ key: 'invite' }] } },
    { call: '2N', shows: { hcp: INVITE, notes: [{ key: 'invite' }] } },
  )
  if (!again) rules.push({ call: bid(2, o), shows: { len: { [o]: [2, 2] }, hcp: [10, 12], notes: [{ key: 'preference', strain: o }] } })
  return rules
}

// ── Responder's second call after a one-level response ───────────────────────────────────────

/** After 1x–1y–1NT: a new suit at the two level below y may be passed; a jump shift or a reverse forces to game */
function responderAfterRebidNotrump(o: Suit, y: Suit): Rule[] {
  const rules: Rule[] = []
  if (isMajor(y)) rules.push({ call: bid(4, y), shows: { len: { [y]: [6, 13] }, hcp: GAME, notes: [{ key: 'game' }] } })
  rules.push({ call: '3N', shows: { hcp: GAME, notes: [{ key: 'signoff' }] }, when: (h) => !isMajor(y) || h.len[y] <= 5 })
  for (const z of UP.filter((s) => s !== o && s !== y)) {
    const reverse = above(z, y)
    const call = bid(reverse ? 2 : 3, z)
    rules.push({ call, shows: { len: { [z]: [4, 13], [y]: reverse ? [5, 13] : [4, 13] }, hcp: GAME, forcing: 'game' }, when: (h) => h.len[z] >= 4 && (!reverse || h.len[y] >= 5) })
  }
  rules.push(
    { call: bid(3, y), shows: { len: { [y]: [6, 13] }, hcp: INVITE, notes: [{ key: 'invite' }] } },
    { call: bid(3, o), shows: { len: { [o]: [lengthToRaise(o), 13] }, hcp: INVITE, notes: [{ key: 'invite' }] } },
    { call: '2N', shows: { hcp: INVITE, notes: [{ key: 'invite' }] } },
    { call: bid(2, y), shows: { len: { [y]: [5, 13] }, hcp: WEAK, notes: [{ key: 'signoff' }] }, when: (h) => h.len[y] >= 5 },
    { call: bid(2, o), shows: { len: { [o]: [lengthToRaise(o), 13] }, hcp: WEAK, notes: [{ key: 'signoff' }] } },
  )
  for (const z of UP.filter((s) => s !== o && s !== y && !above(s, y))) rules.push({ call: bid(2, z), shows: { len: { [z]: [4, 13] }, hcp: WEAK }, when: (h) => h.len[z] >= 5 || h.len[y] >= 5 })
  rules.push({ call: 'P', shows: { hcp: WEAK } })
  return rules
}

/**
 * After a suit rebid (`z` opener's second suit, or null when opener rebid a suit already bid): to
 * sign off pass or bid two of a bid suit, to invite 2NT or three of a bid suit, to force a new suit;
 * the fourth suit may be artificial and forces one round only
 */
function responderAfterRebidSuit(o: Suit, y: Suit, z: Suit | null): Rule[] {
  const fit = lengthToRaise(o)
  const rules: Rule[] = []
  if (z && isMajor(z)) rules.push({ call: bid(4, z), shows: { len: { [z]: [4, 13] }, hcp: GAME, notes: [{ key: 'game' }] } })
  if (isMajor(o)) rules.push({ call: bid(4, o), shows: { len: { [o]: [3, 13] }, hcp: GAME, notes: [{ key: 'game' }] } })
  if (isMajor(y)) rules.push({ call: bid(4, y), shows: { len: { [y]: [6, 13] }, hcp: GAME, notes: [{ key: 'game' }] } })
  rules.push({ call: '3N', shows: { hcp: GAME, notes: [{ key: 'signoff' }] }, when: (h) => h.balanced })
  for (const w of UP.filter((s) => s !== o && s !== y && s !== z))
    rules.push({
      call: (ctx: Ctx) => cheapest(ctx, w),
      shows: z ? { name: 'fourthSuit', hcp: GAME, forcing: 'oneRound', artificial: true } : { len: { [w]: [4, 13] }, hcp: plus(10), forcing: 'oneRound' },
    })
  if (z) rules.push({ call: bid(3, z), shows: { len: { [z]: [4, 13] }, hcp: INVITE, notes: [{ key: 'invite' }] } })
  rules.push(
    { call: bid(3, o), shows: { len: { [o]: [fit, 13] }, hcp: INVITE, notes: [{ key: 'invite' }] }, when: (h) => h.len[o] >= fit },
    { call: bid(3, y), shows: { len: { [y]: [6, 13] }, hcp: INVITE, notes: [{ key: 'invite' }] } },
    { call: '2N', shows: { hcp: INVITE, notes: [{ key: 'invite' }] } },
  )
  if (z) rules.push({ call: bid(2, z), shows: { len: { [z]: [4, 13] }, hcp: WEAK, notes: [{ key: 'signoff' }] }, when: (h) => h.len[z] >= 4 })
  rules.push(
    { call: '1N', shows: { hcp: WEAK } },
    { call: bid(2, y), shows: { len: { [y]: [5, 13] }, hcp: WEAK, notes: [{ key: 'signoff' }] }, when: (h) => h.len[y] >= 5 },
    { call: bid(2, o), shows: { len: { [o]: [isMajor(o) ? 2 : 3, 13] }, hcp: WEAK, notes: [{ key: 'preference', strain: o }] }, when: (h) => h.len[o] >= (isMajor(o) ? 2 : 3) },
    { call: 'P', shows: { hcp: WEAK } },
  )
  return rules
}

/** After opener raised responder: pass, invite or game */
function responderAfterRaise(y: Suit): Rule[] {
  return [
    ...(isMajor(y) ? [{ call: bid(4, y), shows: { hcp: GAME, notes: [{ key: 'game' as const }] } }] : [{ call: '3N', shows: { hcp: GAME, notes: [{ key: 'signoff' as const }] } }]),
    { call: bid(3, y), shows: { hcp: INVITE, notes: [{ key: 'invite' }] } },
    { call: '2N', shows: { hcp: INVITE, notes: [{ key: 'invite' }] } },
    { call: 'P', shows: { hcp: WEAK } },
  ]
}

/** Opener answers a fourth-suit force at the cheapest level: support, a stopper for notrump, five in the second suit, else the first */
function answersFourthSuit(o: Suit, y: Suit, z: Suit, w: Suit): Rule[] {
  const at = (s: Suit | 'N') => (ctx: Ctx) => cheapest(ctx, s)
  const fit = isMajor(y) ? 3 : 4
  return [
    { call: at(y), shows: { len: { [y]: [fit, 13] }, notes: [{ key: 'support', strain: y }] }, when: (h) => h.len[y] >= fit },
    { call: at('N'), shows: { stop: { [w]: 'likely' } }, when: (h) => h.stop[w] !== null && h.stop[w] !== 'partial' },
    { call: at(z), shows: { len: { [z]: [5, 13] } }, when: (h) => h.len[z] >= 5 },
    { call: at(o), shows: { len: { [o]: [isMajor(o) ? 5 : 3, 13] } } },
  ]
}

// ── The books ─────────────────────────────────────────────────────────────────────────────────

const books: Book[] = []
for (const o of UP) {
  const responses = isMajor(o) ? majorResponses : minorResponses
  books.push(
    { after: `1${o} (P)`, only: (ctx) => !ctx.passed, rules: responses(o, false), more: true },
    { after: `1${o} (P)`, only: (ctx) => ctx.passed, rules: responses(o, true), more: true },
    { after: `1${o} (P) 1N (P)`, rules: openerAfterNotrump(o), more: true },
  )
  for (const z of UP.filter((z) => z !== o && !above(z, o))) books.push({ after: `1${o} (P) 1N (P) 2${z} (P)`, rules: responderAfterNotrump(o, z), more: true })

  // One-level responses
  for (const y of UP.filter((y) => above(y, o))) {
    const start = `1${o} (P) 1${y} (P)`
    books.push(
      { after: start, rules: openerRebids(o, y), more: true },
      { after: `${start} 1N (P)`, rules: responderAfterRebidNotrump(o, y), more: true },
      { after: `${start} 2${o} (P)`, rules: responderAfterRebidSuit(o, y, null), more: true },
      { after: `${start} 2${y} (P)`, rules: responderAfterRaise(y), more: true },
    )
    for (const z of UP.filter((z) => z !== o && z !== y)) {
      const rebid = above(z, y) ? `1${z}` : `2${z}`
      // A reverse forces, so those go to the fallback, which bids on
      if (!above(z, y) && above(z, o)) continue
      books.push({ after: `${start} ${rebid} (P)`, rules: responderAfterRebidSuit(o, y, z), more: true })
      const w = UP.find((s) => s !== o && s !== y && s !== z)!
      const fourth = above(w, z) && rebid[0] === '1' ? `1${w}` : above(w, z) ? `2${w}` : rebid[0] === '1' ? `2${w}` : `3${w}`
      books.push({ after: `${start} ${rebid} (P) ${fourth} (P)`, rules: answersFourthSuit(o, y, z, w), more: true })
    }
  }

  // Two-level new suits
  for (const x of UP.filter((x) => x !== o && !above(x, o))) {
    books.push(
      { after: `1${o} (P) 2${x} (P)`, only: (ctx) => !ctx.partnerPassed, rules: afterTwoLevel(o, x, false), more: true },
      { after: `1${o} (P) 2${x} (P)`, only: (ctx) => ctx.partnerPassed, rules: afterTwoLevel(o, x, true), more: true },
      { after: `1${o} (P) 2${x} (P) 2${o} (P)`, only: (ctx) => !ctx.passed, rules: afterTwoLevelRebid(o, x, null, true), more: true },
      { after: `1${o} (P) 2${x} (P) 2N (P)`, only: (ctx) => !ctx.passed, rules: afterTwoLevelRebid(o, x, null, false), more: true },
    )
    for (const z of UP.filter((z) => z !== o && z !== x && !above(z, o) && above(z, x)))
      books.push({ after: `1${o} (P) 2${x} (P) 2${z} (P)`, only: (ctx) => !ctx.passed, rules: afterTwoLevelRebid(o, x, z, false), more: true })
  }
}
for (const M of MAJORS) {
  books.push(
    { after: `1${M} (P) 2${M} (P)`, rules: afterMajorRaise(M), more: true },
    { after: `1${M} (P) 2${M} (P) 3${M} (P)`, rules: answerTry(M, null), more: true },
    { after: `1${M} (P) 2N (P)`, only: (ctx) => !ctx.partnerPassed, rules: afterJacoby(M), more: true },
  )
  for (const x of UP.filter((s) => s !== M)) books.push({ after: `1${M} (P) 2${M} (P) ${above(x, M) ? `2${x}` : `3${x}`} (P)`, rules: answerTry(M, x), more: true })
}

export const suits: readonly Book[] = books
