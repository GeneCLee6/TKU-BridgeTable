import { levelOf } from '../../../auction.ts'
import type { Suit } from '../../../cards.ts'
import { cheapest, type Ctx } from '../context.ts'
import type { Hand } from '../evaluate.ts'
import type { Book, Rule } from '../spec.ts'
import { openerRebids } from './rebids.ts'
import { above, bid, isMinor, MAJORS, plus, UP, upTo } from './util.ts'

/** After 1♥ or 1♠, docs/BBO GIB/gib-2over1.md §3 */

/** A side suit with at most one card, if any */
export const shortness = (h: Hand, trump: Suit): Suit | null => UP.find((s) => s !== trump && h.len[s] <= 1) ?? null

/** The suit for a 2/1 game force: five hearts over 1♠, else the longer minor (2♣ may be three cards) */
function twoOverOne(h: Hand, M: Suit): Suit {
  if (M === 'S' && h.len.H >= 5 && h.len.H >= Math.max(h.len.D, h.len.C)) return 'H'
  return h.len.D > h.len.C && h.len.D >= 4 ? 'D' : 'C'
}

/** Splinters: a double jump in a side suit (1♥–3♠, 4♣, 4♦; 1♠–4♣, 4♦, 4♥) */
const splinterCall = (M: Suit, x: Suit) => (M === 'H' && x === 'S' ? '3S' : bid(4, x))

// ── Responses ─────────────────────────────────────────────────────────────────────────────────

function responses(M: Suit): Rule[] {
  const rules: Rule[] = []
  for (const x of UP.filter((s) => s !== M))
    rules.push({
      call: splinterCall(M, x),
      shows: { name: 'splinter', len: { [M]: [4, 13], [x]: [0, 1] }, tp: [13, 16], forcing: 'game', notes: [{ key: 'shortIn', strain: x }] },
    })
  rules.push(
    { call: '2N', shows: { name: 'jacoby2N', len: { [M]: [4, 13] }, tp: plus(13), forcing: 'game' } },
    {
      call: bid(4, M),
      shows: { name: 'preemptiveRaise', len: { [M]: [5, 13] }, hcp: [0, 9] },
      when: (h) => h.shape[3] <= 1 || h.len[M] >= 6,
    },
    { call: bid(3, M), shows: { name: 'limitRaise', len: { [M]: [4, 13] }, tp: [10, 12], notes: [{ key: 'invite' }] } },
  )
  // 1♥–1♠ comes before a 2/1 with four spades
  if (M === 'H') rules.push({ call: '1S', shows: { len: { S: [4, 13] }, hcp: plus(6), forcing: 'oneRound' }, when: (h) => h.len.H < 3 || h.tp > 10 })
  if (M === 'S') rules.push({ call: '2H', shows: { len: { H: [5, 13] }, hcp: plus(12), forcing: 'game' }, when: (h) => twoOverOne(h, M) === 'H' })
  rules.push(
    { call: '2D', shows: { len: { D: [4, 13] }, hcp: plus(12), forcing: 'game' }, when: (h) => twoOverOne(h, M) === 'D' },
    { call: '2C', shows: { len: { C: [3, 13] }, hcp: plus(12), forcing: 'game' }, when: (h) => twoOverOne(h, M) === 'C' },
    { call: bid(2, M), shows: { len: { [M]: [3, 13] }, tp: [7, 10] } },
  )
  // Jumps to a lower suit at the three level are natural and invitational
  for (const x of UP.filter((s) => !above(s, M) && s !== M))
    rules.push({
      call: bid(3, x),
      shows: { len: { [x]: [6, 13] }, quality: { [x]: 'twiceRebiddable' }, hcp: [9, 11], notes: [{ key: 'invite' }] },
      when: (h) => h.len[M] <= 2,
    })
  rules.push({ call: '1N', shows: { hcp: [6, 12], forcing: 'oneRound' } }, { call: 'P', shows: { hcp: upTo(5) } })
  return rules
}

/** A passed hand: Reverse Drury, fit jumps, nothing game forcing */
function passedResponses(M: Suit): Rule[] {
  const rules: Rule[] = [
    { call: '2C', shows: { name: 'drury', len: { [M]: [3, 13] }, tp: [11, 12], forcing: 'oneRound', artificial: true } },
    { call: bid(4, M), shows: { name: 'preemptiveRaise', len: { [M]: [5, 13] }, hcp: [0, 9] }, when: (h) => h.shape[3] <= 1 || h.len[M] >= 6 },
  ]
  // Fit jumps: a five-card suit and four trumps (a jump to 3♣ stays natural)
  for (const x of UP.filter((s) => s !== M && s !== 'C')) {
    const call = M === 'H' && x === 'S' ? '2S' : bid(3, x)
    rules.push({ call, shows: { name: 'fitJump', len: { [x]: [5, 13], [M]: [4, 13] }, tp: [10, 12] } })
  }
  rules.push({ call: '3C', shows: { len: { C: [6, 13] }, hcp: [9, 11], notes: [{ key: 'invite' }] }, when: (h) => h.len[M] <= 2 })
  if (M === 'H') rules.push({ call: '1S', shows: { len: { S: [4, 13] }, hcp: plus(6), forcing: 'oneRound' }, when: (h) => h.len.H < 3 })
  rules.push({ call: bid(2, M), shows: { len: { [M]: [3, 13] }, tp: [7, 10] } })
  // A new suit at the two level is natural and not forcing (2♣ is Drury)
  for (const x of UP.filter((s) => s !== M && s !== 'C' && !(M === 'H' && s === 'S')))
    rules.push({ call: bid(2, x), shows: { len: { [x]: [5, 13] }, hcp: [10, 11] }, when: (h) => h.len[M] <= 2 })
  rules.push({ call: '1N', shows: { hcp: [6, 11] } }, { call: 'P', shows: { hcp: upTo(5) } })
  return rules
}

// ── Reverse Drury: opener's rebid (GIB System Notes) ─────────────────────────────────────────

function afterDrury(M: Suit): Rule[] {
  const rules: Rule[] = [{ call: bid(3, M), shows: { tp: plus(18), balanced: true } }]
  for (const x of UP.filter((s) => s !== M)) {
    // The cheapest bid in the suit: 2♦ is taken by the artificial rebid, clubs start at 3♣
    const cheap = x === 'C' || x === 'D' ? 3 : 2
    const single = x === 'D' ? 3 : cheap + 1
    if (single + 1 <= 4)
      rules.push({ call: bid(single + 1, x), shows: { tp: plus(18), len: { [x]: [0, 0] }, notes: [{ key: 'void' }] }, when: (h) => h.len[x] === 0 })
    rules.push({ call: bid(single, x), shows: { tp: plus(18), len: { [x]: [1, 1] }, notes: [{ key: 'shortIn', strain: x }] }, when: (h) => h.len[x] === 1 })
  }
  rules.push(
    { call: '2N', shows: { tp: [13, 17], balanced: true, forcing: 'oneRound' }, when: (h) => h.shape.join('') === '5332' },
    { call: '3N', shows: { tp: [13, 17], len: { [M]: [6, 6] }, forcing: 'oneRound' }, when: (h) => h.shape.join('') === '6322' },
    // A new suit without jumping: four or more, less than 18
    ...UP.filter((s) => s !== M && s !== 'D').map(
      (x): Rule => ({ call: bid(x === 'C' ? 3 : 2, x), shows: { len: { [x]: [4, 13] }, tp: [13, 17] }, when: (h) => h.len[x] >= 4 }),
    ),
    { call: bid(4, M), shows: { tp: [15, 17], notes: [{ key: 'toPlay' }] } },
    { call: '2D', shows: { name: 'drury', tp: [13, 14], notes: [{ key: 'invite' }], artificial: true } },
    { call: bid(2, M), shows: { tp: upTo(12), notes: [{ key: 'minimum' }, { key: 'signoff' }] } },
  )
  return rules
}

// ── After a single raise: two-way game tries ─────────────────────────────────────────────────

/** The next step is a short-suit try; responder's next step asks where */
const steps = (M: Suit) => (M === 'H' ? { short: '2S', ask: '2N' } : { short: '2N', ask: '3C' })

/** A suit worth a long-suit try: three or more cards with some honours and losers */
const helpWanted = (h: Hand, x: Suit) => h.len[x] >= 3 && /[AKQ]/.test(h.ranks[x]) && !h.ranks[x].startsWith('AKQ') && !h.ranks[x].startsWith('AK')

function gameTries(M: Suit): Rule[] {
  const { short } = steps(M)
  const rules: Rule[] = [
    { call: bid(4, M), shows: { tp: plus(19), notes: [{ key: 'game' }] } },
    {
      call: short,
      shows: { name: 'shortSuitTry', tp: [16, 18], notes: [{ key: 'shortSomewhere' }], forcing: 'oneRound', artificial: true },
      when: (h) => shortness(h, M) !== null,
    },
  ]
  // Long-suit tries: any other bid below three of the major (after 1♥–2♥, 2NT is the spade try)
  for (const x of UP.filter((s) => s !== M)) {
    const call = M === 'H' && x === 'S' ? '2N' : bid(3, x)
    if (call === short || (M === 'H' && x === 'H')) continue
    if (!above(M, x) && !(M === 'H' && x === 'S')) continue
    rules.push({
      call,
      shows: { name: 'longSuitTry', len: { [x]: [3, 13] }, tp: [16, 18], notes: [{ key: 'tryIn', strain: x }], forcing: 'oneRound' },
      when: (h) => helpWanted(h, x),
    })
  }
  rules.push(
    { call: bid(3, M), shows: { name: 'generalTry', tp: [16, 18], notes: [{ key: 'noShortness' }] } },
    { call: 'P', shows: { tp: upTo(15) } },
  )
  return rules
}

/** Responder answers a short-suit try: ask, sign off or bid game */
function answerShortTry(M: Suit): Rule[] {
  const { ask } = steps(M)
  return [
    { call: bid(4, M), shows: { tp: [9, 10], notes: [{ key: 'accept' }] } },
    { call: ask, shows: { name: 'askShortness', tp: [8, 8], forcing: 'oneRound', artificial: true } },
    { call: bid(3, M), shows: { tp: upTo(8), notes: [{ key: 'decline' }] } },
  ]
}

/** Opener shows the short suit; a short suit among the step suits is shown by bidding the major */
function showShortness(M: Suit): Rule[] {
  const stepSuit: Suit = M === 'H' ? 'S' : 'C'
  const rules: Rule[] = UP.filter((s) => s !== M && s !== stepSuit).map(
    (x): Rule => ({ call: bid(3, x), shows: { len: { [x]: [0, 1] }, notes: [{ key: 'shortIn', strain: x }] }, when: (h) => shortness(h, M) === x }),
  )
  rules.push({ call: bid(3, M), shows: { len: { [stepSuit]: [0, 1] }, notes: [{ key: 'shortIn', strain: stepSuit }] } })
  return rules
}

/** Responder after the shortness is known: honours facing it are wasted */
function afterShortness(M: Suit, short: Suit | null): Rule[] {
  const useful = (h: Hand) => h.tp - (short ? h.points[short] : 0)
  return [
    { call: bid(4, M), shows: { notes: [{ key: 'accept' }] }, when: (h) => useful(h) >= 8 },
    { call: bid(3, M), shows: { notes: [{ key: 'decline' }] } },
    { call: 'P', shows: { notes: [{ key: 'decline' }] } },
  ]
}

/** Responder answers a long-suit or general try: game with a maximum or help in the suit */
function answerTry(M: Suit, x: Suit | null): Rule[] {
  const help = (h: Hand) => !!x && (h.len[x] <= 1 || /[AKQ]/.test(h.ranks[x]))
  return [
    { call: bid(4, M), shows: { notes: [{ key: 'accept' }] }, when: (h) => h.tp >= 9 || (h.tp >= 8 && help(h)) },
    { call: bid(3, M), shows: { notes: [{ key: 'decline' }] } },
    { call: 'P', shows: { notes: [{ key: 'decline' }] } },
  ]
}

// ── After 1NT forcing ────────────────────────────────────────────────────────────────────────

function afterNotrump(M: Suit): Rule[] {
  const rules: Rule[] = [{ call: bid(4, M), shows: { len: { [M]: [6, 13] }, tp: plus(19), notes: [{ key: 'game' }] } }]
  for (const x of UP.filter((s) => s !== M)) {
    const level = above(x, M) ? 2 : 3
    if (level === 3) rules.push({ call: bid(3, x), shows: { len: { [x]: [4, 13] }, hcp: [19, 21], forcing: 'game' } })
  }
  rules.push(
    { call: '2N', shows: { hcp: [18, 19], balanced: true } },
    { call: bid(3, M), shows: { len: { [M]: [6, 13] }, hcp: [15, 17], notes: [{ key: 'invite' }] } },
  )
  if (M === 'H') rules.push({ call: '2S', shows: { name: 'reverse', len: { S: [4, 13], H: [5, 13] }, hcp: [17, 21], forcing: 'oneRound' } })
  if (M === 'S') rules.push({ call: '2H', shows: { len: { H: [4, 13] }, hcp: [11, 17] } })
  rules.push(
    { call: bid(2, M), shows: { len: { [M]: [6, 13] }, hcp: [11, 14] } },
    // A minor, possibly only three cards: the longer one, clubs with 3-3
    { call: '2D', shows: { len: { D: [3, 13] }, hcp: [11, 17] }, when: (h) => h.len.D > h.len.C },
    { call: '2C', shows: { len: { C: [3, 13] }, hcp: [11, 17] }, when: (h) => h.len.C >= 3 },
    { call: '2D', shows: { len: { D: [3, 13] }, hcp: [11, 17] } },
    { call: 'P', shows: { hcp: [11, 14], balanced: true } },
  )
  return rules
}

/** Responder after 1M–1NT–2x: the delayed limit raise, preference, or passing a fit */
function afterNotrumpRebid(M: Suit, x: Suit): Rule[] {
  return [
    { call: bid(3, M), shows: { len: { [M]: [3, 3] }, tp: [10, 12], name: 'limitRaise', notes: [{ key: 'invite' }] }, when: (h) => h.len[M] === 3 },
    { call: bid(3, x), shows: { len: { [x]: [isMinor(x) ? 5 : 4, 13] }, hcp: [10, 12], notes: [{ key: 'invite' }] } },
    { call: '2N', shows: { hcp: [10, 12], notes: [{ key: 'invite' }] }, when: (h) => h.len[M] <= 2 },
    { call: bid(2, M), shows: { len: { [M]: [2, 3] }, hcp: [6, 9], notes: [{ key: 'preference', strain: M }] }, when: (h) => h.len[M] >= h.len[x] - 1 || h.len[M] === 3 },
    { call: 'P', shows: { len: { [x]: [3, 13] }, hcp: [6, 9] } },
  ]
}

// ── After Jacoby 2NT, splinters and a 2/1 ─────────────────────────────────────────────────────

function afterJacoby(M: Suit): Rule[] {
  const rules: Rule[] = []
  // A good five-card second suit first (a 5-5 hand always has a short suit too), then shortness
  for (const x of UP.filter((s) => s !== M))
    rules.push({
      call: bid(4, x),
      shows: { len: { [x]: [5, 13] }, quality: { [x]: 'rebiddable' } },
      when: (h) => /^(AK|AQ|KQ)/.test(h.ranks[x]),
    })
  for (const x of UP.filter((s) => s !== M))
    rules.push({ call: bid(3, x), shows: { len: { [x]: [0, 1] }, notes: [{ key: 'shortIn', strain: x }], forcing: 'game' }, when: (h) => shortness(h, M) === x })
  rules.push(
    { call: bid(3, M), shows: { tp: plus(18), notes: [{ key: 'noShortness' }, { key: 'slamInterest' }], forcing: 'game' } },
    { call: '3N', shows: { tp: [15, 17], notes: [{ key: 'noShortness' }], forcing: 'game' } },
    { call: bid(4, M), shows: { tp: upTo(14), notes: [{ key: 'noShortness' }, { key: 'minimum' }] } },
  )
  return rules
}

/** Opener after a 2/1: raise with four (or three hearts), a new suit, notrump, or the major again */
function afterTwoOverOne(M: Suit, x: Suit): Rule[] {
  const rules: Rule[] = [
    { call: bid(3, M), shows: { len: { [M]: [6, 13] }, quality: { [M]: 'twiceRebiddable' }, hcp: plus(15), forcing: 'game' } },
    { call: bid(3, x), shows: { len: { [x]: [x === 'H' ? 3 : 4, 13] }, forcing: 'game' } },
  ]
  for (const z of UP.filter((s) => s !== M && s !== x)) {
    const level = above(z, x) ? 2 : 3
    if (level === 2) rules.push({ call: bid(2, z), shows: { len: { [z]: [4, 13] }, forcing: 'game' } })
  }
  rules.push(
    { call: '3N', shows: { hcp: [15, 17], balanced: true, forcing: 'game' } },
    { call: '2N', shows: { hcp: [11, 14], balanced: true, forcing: 'game' } },
    { call: bid(2, M), shows: { len: { [M]: [5, 13] }, forcing: 'game' } },
  )
  return rules
}

/**
 * Responder's second call after a 2/1 (一般: the principle of fast arrival). With three or more
 * of opener's major, game at once is a minimum; the cheapest raise below game is forcing (the
 * auction is a game force) and shows extra values with slam interest. Everything else is the
 * fallback's
 */
function afterTwoOverOneRebid(M: Suit): Rule[] {
  const slow = (ctx: Ctx) => {
    const call = cheapest(ctx, M)
    return call && levelOf(call) <= 3 ? call : null
  }
  return [
    {
      call: slow,
      shows: { len: { [M]: [3, 13] }, hcp: plus(15), notes: [{ key: 'support', strain: M }, { key: 'slamInterest' }], forcing: 'game' },
      when: (h) => h.len[M] >= 3,
    },
    {
      call: bid(4, M),
      shows: { len: { [M]: [3, 13] }, hcp: [12, 14], notes: [{ key: 'support', strain: M }, { key: 'minimum' }] },
      when: (h) => h.len[M] >= 3,
    },
  ]
}

// ── The books ─────────────────────────────────────────────────────────────────────────────────

const notPassed = (ctx: Ctx) => !ctx.partnerPassed
const books: Book[] = []
for (const M of MAJORS) {
  const { short, ask } = steps(M)
  books.push(
    { after: `1${M} (P)`, only: (ctx) => !ctx.passed, rules: responses(M), more: true },
    { after: `1${M} (P)`, only: (ctx) => ctx.passed, rules: passedResponses(M), more: true },
    { after: `1${M} (P) 2C (P)`, only: (ctx) => ctx.partnerPassed, rules: afterDrury(M), more: true },
    { after: `1${M} (P) 2${M} (P)`, rules: gameTries(M), more: true },
    { after: `1${M} (P) 2${M} (P) ${short} (P)`, rules: answerShortTry(M), more: true },
    { after: `1${M} (P) 2${M} (P) ${short} (P) ${ask} (P)`, rules: showShortness(M), more: true },
    { after: `1${M} (P) 1N (P)`, rules: afterNotrump(M), more: true },
    { after: `1${M} (P) 2N (P)`, only: notPassed, rules: afterJacoby(M), more: true },
  )
  // After the shortness is shown
  for (const x of UP.filter((s) => s !== M))
    books.push({ after: `1${M} (P) 2${M} (P) ${short} (P) ${ask} (P) 3${x} (P)`, rules: afterShortness(M, x), more: true })
  books.push({ after: `1${M} (P) 2${M} (P) ${short} (P) ${ask} (P) 3${M} (P)`, rules: afterShortness(M, M === 'H' ? 'S' : 'C'), more: true })
  // Long-suit and general tries
  for (const x of UP.filter((s) => s !== M)) {
    const call = M === 'H' && x === 'S' ? '2N' : `3${x}`
    if (call !== short) books.push({ after: `1${M} (P) 2${M} (P) ${call} (P)`, rules: answerTry(M, x), more: true })
  }
  books.push({ after: `1${M} (P) 2${M} (P) 3${M} (P)`, rules: answerTry(M, null), more: true })
  // After 1NT forcing and opener's new suit
  for (const x of UP.filter((s) => s !== M && !(M === 'H' && s === 'S')))
    books.push({ after: `1${M} (P) 1N (P) 2${x} (P)`, rules: afterNotrumpRebid(M, x), more: true })
  // After a 2/1 by an unpassed hand
  for (const x of M === 'S' ? (['C', 'D', 'H'] as Suit[]) : (['C', 'D'] as Suit[]))
    books.push(
      { after: `1${M} (P) 2${x} (P)`, only: notPassed, rules: afterTwoOverOne(M, x), more: true },
      { after: `1${M} (P) 2${x} (P) * (P)`, only: (ctx) => !ctx.passed, rules: afterTwoOverOneRebid(M), more: true },
    )
}
books.push({ after: '1H (P) 1S (P)', rules: openerRebids('H', 'S'), more: true })

export const majors: readonly Book[] = books
