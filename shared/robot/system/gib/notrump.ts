import type { Call } from '../../../auction.ts'
import type { Suit } from '../../../cards.ts'
import type { Hand } from '../evaluate.ts'
import type { Book, Range, Rule } from '../spec.ts'
import { shortness } from './majors.ts'
import { above, bid, MAJORS, other, plus, UP } from './util.ts'

/** After a 1NT or 2NT opening, docs/BBO GIB/gib-2over1.md §4 and §5 (GIB System Notes) */

/** Responder's ranges facing each opening, and how far up its relays sit */
export interface Ranges {
  /** 0 after 1NT; 1 after 2NT, where Stayman, transfers and their answers are a level higher */
  up: 0 | 1
  weak: Range
  /** Inviting game (1NT only) */
  invite: Range | null
  game: Range
  slamTry: Range
  quant: Range
  slam: Range
  grand: Range
  /** Opener's top: super-accepts, and accepting invitations from one below */
  top: number
}

const ONE_NT: Ranges = { up: 0, weak: [0, 7], invite: [8, 9], game: [10, 15], slamTry: [14, 15], quant: [16, 17], slam: [18, 19], grand: [20, 21], top: 17 }
const TWO_NT: Ranges = { up: 1, weak: [0, 3], invite: null, game: [4, 10], slamTry: [9, 10], quant: [11, 12], slam: [13, 15], grand: [16, 17], top: 21 }

const fourMajor = (h: Hand) => h.len.H === 4 || h.len.S === 4
const fiveFive = (h: Hand) => h.len.H >= 5 && h.len.S >= 5
/** The longer five-card major (5-5 is decided by strength) */
const fiveMajor = (h: Hand): Suit | null => (h.len.H >= 5 && h.len.H > h.len.S ? 'H' : h.len.S >= 5 && h.len.S > h.len.H ? 'S' : null)
const within = (n: number, [lo, hi]: Range) => n >= lo && n <= hi
const stopped = (h: Hand, s: Suit) => h.stop[s] === 'stop' || h.stop[s] === 'double'
const quantitative = (hcp: Range, slam: 'smallSlam' | 'grandSlam') => ({ name: 'quantitative' as const, hcp, notes: [{ key: 'invite' as const }, { key: slam }] })

// ── Responses ─────────────────────────────────────────────────────────────────────────────────

/**
 * Responses to 1NT or 2NT. `stayman` is the Stayman call (2♣, 3♣ over 2NT, or a double over a
 * 2♣ overcall); with `runout` a redouble rescues a weak hand into a minor (1NT doubled)
 */
function responses(r: Ranges, stayman: Call, runout = false): Rule[] {
  const rules: Rule[] = []
  if (runout)
    rules.push({
      call: 'XX',
      shows: { hcp: r.weak, notes: [{ key: 'relayTo', calls: ['2C'] }], artificial: true, forcing: 'oneRound' },
      when: (h) => (h.len.C >= 5 || h.len.D >= 5) && !fiveMajor(h) && !fiveFive(h),
    })
  // Texas: six or more in a major with game values (4♦/4♥ over both openings)
  for (const M of MAJORS)
    rules.push({
      call: bid(4, M === 'H' ? 'D' : 'H'),
      shows: { name: 'texas', len: { [M]: [6, 13] }, hcp: r.game, notes: [{ key: 'transferTo', strain: M }], artificial: true, forcing: 'oneRound' },
      when: (h) => h.len[M] >= 6 && h.len[M] > h.len[other(M)],
    })
  // 3♦/3♥/3♠ over 1NT: short there, four or more in each other suit, no five-card major
  if (r.up === 0)
    for (const x of ['D', 'H', 'S'] as Suit[])
      rules.push({
        call: bid(3, x),
        shows: { len: { [x]: [0, 1] }, hcp: plus(10), notes: [{ key: 'shortIn', strain: x }], forcing: 'game' },
        when: (h) => UP.every((s) => s === x || h.len[s] >= 4) && h.len.H < 5 && h.len.S < 5,
      })
  rules.push({
    call: bid(2 + r.up, 'S'),
    shows: { name: 'minorStayman', hcp: plus(r.game[0]), forcing: 'game', artificial: true },
    when: (h) => !fourMajor(h) && h.len.H < 5 && h.len.S < 5 && Math.min(h.len.C, h.len.D) >= 4 && h.len.C + h.len.D >= 9,
  })
  // Stayman: a four-card major (5-4 majors too, with values); over 1NT also inviting without one
  const asks = { name: 'stayman' as const, notes: [{ key: 'asksMajor' as const }], forcing: 'oneRound' as const, artificial: true }
  rules.push({
    call: stayman,
    shows: { ...asks, hcp: plus(r.invite ? r.invite[0] : r.game[0]) },
    when: (h) => fourMajor(h) && !(h.len.H >= 5 && h.len.S >= 5) && h.len.H + h.len.S <= 9,
  })
  // Transfers: 5-5 majors go through hearts with a weak or invitational hand, spades with game
  for (const M of MAJORS)
    rules.push({
      call: bid(2 + r.up, M === 'H' ? 'D' : 'H'),
      shows: { name: 'transfer', len: { [M]: [5, 13] }, notes: [{ key: 'transferTo', strain: M }], forcing: 'oneRound', artificial: true },
      when: (h) => (fiveFive(h) ? M === (within(h.hcp, r.game) ? 'S' : 'H') : fiveMajor(h) === M),
    })
  if (r.up === 0) {
    // Minor transfers: weak to play, or game values with a short suit
    const minorTransfer = (h: Hand, m: Suit) => h.len[m] >= 6 && (h.hcp <= r.weak[1] || (h.hcp >= 10 && shortness(h, m) !== null))
    for (const [call, m] of [
      ['2N', 'C'],
      ['3C', 'D'],
    ] as const)
      rules.push({
        call,
        shows: { name: 'transfer', len: { [m]: [6, 13] }, notes: [{ key: 'transferTo', strain: m }], forcing: 'oneRound', artificial: true },
        when: (h) => minorTransfer(h, m),
      })
  }
  rules.push(
    { call: '6N', shows: { hcp: r.slam, notes: [{ key: 'toPlay' }] } },
    { call: '5N', shows: quantitative(r.grand, 'grandSlam') },
    { call: '4N', shows: quantitative(r.quant, 'smallSlam') },
    { call: '3N', shows: { hcp: r.game, notes: [{ key: 'signoff' }] } },
    // GIB does not like Gerber, but knows what it means
    { call: '4C', shows: { name: 'gerber', artificial: true }, when: () => false },
  )
  if (r.invite) rules.push({ call: stayman, shows: { ...asks, hcp: r.invite } })
  rules.push({ call: 'P', shows: { hcp: r.weak } })
  return rules
}

/** Opener answers Stayman: hearts first with both majors */
function staymanAnswers(r: Ranges): Rule[] {
  return [
    { call: bid(2 + r.up, 'H'), shows: { len: { H: [4, 5] } } },
    { call: bid(2 + r.up, 'S'), shows: { len: { S: [4, 5], H: [0, 3] } } },
    { call: bid(2 + r.up, 'D'), shows: { len: { S: [0, 3], H: [0, 3] }, notes: [{ key: 'noMajor' }], artificial: true } },
  ]
}

/** Opener completes a transfer, super-accepting with a maximum and four trumps */
function transferAnswers(r: Ranges, M: Suit): Rule[] {
  return [
    {
      call: bid(3 + r.up, M),
      shows: { name: 'superAccept', len: { [M]: [4, 5] }, hcp: [r.top, r.top], notes: [{ key: 'maximum' }] },
    },
    { call: bid(2 + r.up, M), shows: { len: { [M]: [2, 5] }, notes: [{ key: 'completes' }] } },
  ]
}

// ── Responder after Stayman (GIB System Notes) ────────────────────────────────────────────────

function afterStayman(r: Ranges, answer: Suit): Rule[] {
  const rules: Rule[] = []
  const gf = { forcing: 'game' as const }
  if (answer !== 'D') {
    const fit = answer
    const o = other(fit)
    // Splinters (1NT only), the artificial slam try, game in the fit
    if (r.up === 0)
      for (const x of UP.filter((s) => s !== fit && !(fit === 'H' && s === 'S')))
        rules.push({
          call: bid(4, x),
          shows: { name: 'splinter', len: { [fit]: [4, 13], [x]: [0, 1] }, hcp: r.slamTry, notes: [{ key: 'shortIn', strain: x }, { key: 'slamInterest' }], ...gf },
          when: (h) => h.len[fit] >= 4 && h.len[x] <= 1,
        })
    rules.push(
      {
        call: fit === 'H' ? '3S' : r.up ? '4H' : '3H',
        shows: { len: { [fit]: [4, 13] }, hcp: plus(r.quant[0]), notes: [{ key: 'slamTry' }], artificial: true, ...gf },
        when: (h) => h.len[fit] >= 4,
      },
      { call: bid(4, fit), shows: { len: { [fit]: [4, 13] }, hcp: r.game, notes: [{ key: 'game' }] }, when: (h) => h.len[fit] >= 4 },
    )
    if (r.invite) {
      rules.push({ call: bid(3, fit), shows: { len: { [fit]: [4, 13] }, hcp: r.invite, notes: [{ key: 'invite' }] }, when: (h) => h.len[fit] >= 4 })
      if (fit === 'H') rules.push({ call: '2S', shows: { len: { S: [4, 4], H: [0, 3] }, hcp: r.invite, notes: [{ key: 'invite' }] }, when: (h) => h.len.S >= 4 })
    }
    // 3NT without a fit shows the other major; opener may correct
    rules.push({ call: '3N', shows: { len: { [fit]: [0, 3], [o]: [4, 4] }, hcp: r.game }, when: (h) => h.len[fit] < 4 })
  } else {
    // Smolen: four in the major bid, five in the other, game forcing
    for (const M of MAJORS)
      rules.push({
        call: bid(3, other(M)),
        shows: { name: 'smolen', len: { [M]: [5, 5], [other(M)]: [4, 4] }, hcp: plus(r.game[0]), ...gf },
        when: (h) => h.len[M] === 5 && h.len[other(M)] === 4,
      })
    if (r.invite)
      for (const M of MAJORS)
        rules.push({
          call: bid(2, M),
          shows: { len: { [M]: [5, 5], [other(M)]: [4, 4] }, hcp: r.invite, notes: [{ key: 'invite' }] },
          when: (h) => h.len[M] === 5 && h.len[other(M)] === 4,
        })
    rules.push({ call: '3N', shows: { hcp: r.game, notes: [{ key: 'signoff' }] } })
  }
  // A five-card minor: game forcing over 1NT, slam interest over 2NT
  for (const m of ['C', 'D'] as Suit[])
    rules.push({ call: bid(3 + r.up, m), shows: { len: { [m]: [5, 13] }, hcp: plus(r.game[0]), ...(r.up ? { notes: [{ key: 'slamInterest' as const }] } : {}), ...gf } })
  rules.push({ call: '4N', shows: quantitative(r.quant, 'smallSlam') })
  if (r.invite) rules.push({ call: '2N', shows: { hcp: r.invite, notes: [{ key: 'invite' }] } })
  rules.push({ call: 'P', shows: { hcp: r.weak } })
  return rules
}

// ── Responder after a transfer (GIB System Notes) ────────────────────────────────────────────

function afterTransfer(r: Ranges, M: Suit): Rule[] {
  const rules: Rule[] = []
  // 5-5 majors: over 1NT 2♠ invites after hearts and 3♥ forces after spades; over 2NT 3♠ shows
  // slam interest after hearts and 4♥ offers a choice after spades
  if (M === 'H')
    rules.push(
      r.up === 0
        ? { call: '2S', shows: { len: { H: [5, 13], S: [5, 13] }, hcp: r.invite!, notes: [{ key: 'invite' }] }, when: (h) => h.len.S >= 5 }
        : { call: '3S', shows: { len: { H: [5, 13], S: [5, 13] }, notes: [{ key: 'slamInterest' }], forcing: 'game' }, when: (h) => h.len.S >= 5 },
    )
  else
    rules.push(
      r.up === 0
        ? { call: '3H', shows: { len: { S: [5, 13], H: [5, 13] }, hcp: plus(r.game[0]), forcing: 'game' }, when: (h) => h.len.H >= 5 }
        : { call: '4H', shows: { len: { S: [5, 13], H: [5, 13] }, hcp: r.game, notes: [{ key: 'choiceOf', calls: ['4H', '4S'] }] }, when: (h) => h.len.H >= 5 },
    )
  // Splinters with six trumps (1NT only): 3♠, 4♣, 4♦ after hearts; 4♣, 4♦, 4♥ after spades
  if (r.up === 0)
    for (const x of UP.filter((s) => s !== M))
      rules.push({
        call: M === 'H' && x === 'S' ? '3S' : bid(4, x),
        shows: { name: 'splinter', len: { [M]: [6, 13], [x]: [0, 1] }, hcp: r.slamTry, notes: [{ key: 'shortIn', strain: x }, { key: 'slamInterest' }], forcing: 'game' },
        when: (h) => h.len[x] <= 1,
      })
  rules.push(
    { call: '5N', shows: { hcp: r.slam, notes: [{ key: 'choiceOf', calls: [bid(6, M), '6N'] }] } },
    { call: '4N', shows: { ...quantitative(r.quant, 'smallSlam'), len: { [M]: [5, 5] } }, when: (h) => h.len[M] === 5 },
    { call: bid(4, M), shows: { len: { [M]: [6, 13] }, hcp: r.slamTry, notes: [{ key: 'noShortness' }, { key: 'slamInterest' }] } },
    // A second suit, game forcing (3♣/3♦ over 1NT, 4♣/4♦ over 2NT)
    ...(['C', 'D'] as Suit[]).map(
      (x): Rule => ({ call: bid(3 + r.up, x), shows: { len: { [M]: [5, 13], [x]: [4, 13] }, hcp: plus(r.game[0]), forcing: 'game' } }),
    ),
    { call: '3N', shows: { len: { [M]: [5, 5] }, hcp: r.game, notes: [{ key: 'choiceOf', calls: [bid(4, M), '3N'] }] } },
  )
  if (r.invite)
    rules.push(
      { call: bid(3, M), shows: { len: { [M]: [6, 13] }, hcp: r.invite, notes: [{ key: 'invite' }] } },
      { call: '2N', shows: { len: { [M]: [5, 5] }, hcp: r.invite, notes: [{ key: 'invite' }] } },
    )
  // Game with six trumps and no slam interest went through Texas; a weak hand passes
  rules.push({ call: 'P', shows: { hcp: r.weak } })
  return rules
}

/** Opener answers a choice of games, or an invitation, with five trumps opposite */
function choiceAnswers(r: Ranges, M: Suit, invite: boolean): Rule[] {
  if (!invite)
    return [
      { call: bid(4, M), shows: { len: { [M]: [3, 5] } } },
      { call: 'P', shows: { len: { [M]: [2, 2] } } },
    ]
  // Accept with the top two points of the range, decline with the bottom one
  const max: Range = [r.top - 1, r.top]
  const min: Range = [r.top - 2, r.top - 2]
  return [
    { call: bid(4, M), shows: { len: { [M]: [3, 5] }, hcp: max, notes: [{ key: 'maximum' }] } },
    { call: bid(3, M), shows: { len: { [M]: [3, 5] }, hcp: min, notes: [{ key: 'minimum' }] } },
    { call: '3N', shows: { len: { [M]: [2, 2] }, hcp: max, notes: [{ key: 'maximum' }] } },
    { call: 'P', shows: { len: { [M]: [2, 2] }, hcp: min, notes: [{ key: 'minimum' }] } },
  ]
}

// ── Minor-suit Stayman and minor transfers ────────────────────────────────────────────────────

function minorStaymanAnswers(r: Ranges): Rule[] {
  // 4333 with the four in a minor still bids notrump (3343, 3334)
  const flat = (h: Hand) => h.shape.join('') === '4333'
  return [
    { call: bid(3 + r.up, 'D'), shows: { len: { D: [4, 5] } }, when: (h) => !flat(h) && h.len.D >= h.len.C },
    { call: bid(3 + r.up, 'C'), shows: { len: { C: [4, 5] } }, when: (h) => !flat(h) },
    { call: r.up ? '3N' : '2N', shows: { notes: [{ key: 'noMinor' }] } },
  ]
}

/** After a minor answer to minor-suit Stayman: three (four over 2NT) of a major is shortness */
function shortMajor(r: Ranges): Rule[] {
  return MAJORS.map(
    (M): Rule => ({ call: bid(3 + r.up, M), shows: { len: { [M]: [0, 1] }, notes: [{ key: 'shortIn', strain: M }], forcing: 'game' } }),
  )
}

/** After a completed minor transfer: pass to play, a new suit is shortness, 3NT a mild slam try */
function afterMinorTransfer(m: Suit): Rule[] {
  return [
    { call: 'P', shows: { hcp: [0, 7], notes: [{ key: 'signoff' }] }, when: (h) => h.hcp <= 7 },
    ...UP.filter((s) => s !== m && s !== 'C').map(
      (x): Rule => ({ call: bid(3, x), shows: { len: { [m]: [6, 13], [x]: [0, 1] }, notes: [{ key: 'shortIn', strain: x }], forcing: 'game' } }),
    ),
    { call: '3N', shows: { len: { [m]: [6, 13] }, hcp: [14, 15], notes: [{ key: 'slamTry' }] } },
  ]
}

// ── Lebensohl after an overcall of 1NT at the two level ──────────────────────────────────────

function lebensohl(theirs: Suit): Rule[] {
  const unbidMajor = (h: Hand) => MAJORS.some((M) => M !== theirs && h.len[M] >= 4)
  const rules: Rule[] = [
    { call: 'X', shows: { name: 'penalty', len: { [theirs]: [4, 13] }, hcp: plus(8) } },
    // Fast denies: the cue bid or 3NT at once have no stopper
    {
      call: bid(3, theirs),
      shows: { name: 'stayman', hcp: plus(10), notes: [{ key: 'asksMajor' }], forcing: 'game', artificial: true },
      when: (h) => !stopped(h, theirs) && unbidMajor(h),
    },
    // A new suit at the three level forces to game
    ...UP.filter((s) => s !== theirs).map((x): Rule => ({ call: bid(3, x), shows: { len: { [x]: [5, 13] }, hcp: plus(10), forcing: 'game' } })),
    { call: '3N', shows: { hcp: plus(10), notes: [{ key: 'game' }] }, when: (h) => !stopped(h, theirs) },
    // At the two level it is to play
    ...UP.filter((s) => above(s, theirs)).map((x): Rule => ({ call: bid(2, x), shows: { len: { [x]: [5, 13] }, hcp: [0, 9], notes: [{ key: 'toPlay' }] } })),
    {
      call: '2N',
      shows: { name: 'lebensohl', notes: [{ key: 'relayTo', calls: ['3C'] }], forcing: 'oneRound', artificial: true },
      when: (h) => (h.hcp >= 10 && stopped(h, theirs)) || (h.hcp <= 9 && UP.some((s) => !above(s, theirs) && s !== theirs && h.len[s] >= 6)),
    },
    { call: 'P', shows: { hcp: [0, 9] } },
  ]
  return rules
}

function afterLebensohlRelay(theirs: Suit): Rule[] {
  return [
    // Slow shows: the cue bid or 3NT after the relay promise a stopper
    {
      call: bid(3, theirs),
      shows: { name: 'stayman', hcp: plus(10), stop: { [theirs]: 'stop' }, forcing: 'game', artificial: true },
      when: (h) => h.hcp >= 10 && MAJORS.some((M) => M !== theirs && h.len[M] >= 4),
    },
    { call: '3N', shows: { hcp: plus(10), stop: { [theirs]: 'stop' } }, when: (h) => h.hcp >= 10 },
    ...UP.filter((s) => s !== 'C' && !above(s, theirs) && s !== theirs).map(
      (x): Rule => ({ call: bid(3, x), shows: { len: { [x]: [6, 13] }, hcp: [0, 9], notes: [{ key: 'signoff' }] } }),
    ),
    { call: 'P', shows: { len: { C: [6, 13] }, hcp: [0, 9], notes: [{ key: 'toPlay' }] } },
  ]
}

// ── The books ─────────────────────────────────────────────────────────────────────────────────

const completes = (call: Call): Rule[] => [{ call, shows: { notes: [{ key: 'completes' }] } }]

/**
 * The books for a notrump opening or rebid: `open` is the auction up to it ('1N', '2N', or
 * '2C (P) 2D (P) 2N' for the strong 2♣ rebid of 22–24)
 */
export function notrumpBooks(r: Ranges, open: string): Book[] {
  const books: Book[] = []
  const stayman = bid(2 + r.up, 'C')
  const mss = bid(2 + r.up, 'S')
  books.push(
    { after: `${open} (P)`, rules: responses(r, stayman), more: true },
    { after: `${open} (P) ${stayman} (P)`, rules: staymanAnswers(r), more: true },
    { after: `${open} (P) ${mss} (P)`, rules: minorStaymanAnswers(r), more: true },
  )
  for (const answer of ['D', 'H', 'S'] as Suit[])
    books.push({ after: `${open} (P) ${stayman} (P) ${bid(2 + r.up, answer)} (P)`, rules: afterStayman(r, answer), more: true })
  for (const M of MAJORS) {
    const transfer = bid(2 + r.up, M === 'H' ? 'D' : 'H')
    const done = bid(2 + r.up, M)
    books.push(
      { after: `${open} (P) ${transfer} (P)`, rules: transferAnswers(r, M), more: true },
      { after: `${open} (P) ${transfer} (P) ${done} (P)`, rules: afterTransfer(r, M), more: true },
      { after: `${open} (P) ${transfer} (P) ${done} (P) 3N (P)`, rules: choiceAnswers(r, M, false), more: true },
      { after: `${open} (P) 4${M === 'H' ? 'D' : 'H'} (P)`, rules: completes(bid(4, M)), more: true },
    )
    if (r.invite)
      books.push(
        { after: `${open} (P) ${transfer} (P) ${done} (P) 2N (P)`, rules: choiceAnswers(r, M, true), more: true },
        // Opener declined the invitation: responder has said everything
        { after: `${open} (P) ${transfer} (P) ${done} (P) 2N (P) 3${M} (P)`, rules: [{ call: 'P', shows: { notes: [{ key: 'signoff' }] } }] },
        {
          after: `${open} (P) ${transfer} (P) ${done} (P) 3${M} (P)`,
          rules: [
            { call: bid(4, M), shows: { hcp: [r.top - 1, r.top], notes: [{ key: 'accept' }] } },
            { call: 'P', shows: { hcp: [r.top - 2, r.top - 2], notes: [{ key: 'decline' }] } },
          ],
          more: true,
        },
      )
  }
  for (const m of ['C', 'D'] as Suit[]) books.push({ after: `${open} (P) ${mss} (P) ${bid(3 + r.up, m)} (P)`, rules: shortMajor(r), more: true })
  return books
}

const books: Book[] = [...notrumpBooks(ONE_NT, '1N'), ...notrumpBooks(TWO_NT, '2N')]
// Minor transfers over 1NT: opener must accept
books.push(
  { after: '1N (P) 2N (P)', rules: completes('3C'), more: true },
  { after: '1N (P) 3C (P)', rules: completes('3D'), more: true },
  { after: '1N (P) 2N (P) 3C (P)', rules: afterMinorTransfer('C'), more: true },
  { after: '1N (P) 3C (P) 3D (P)', rules: afterMinorTransfer('D'), more: true },
)
// Interference: over a 2♣ overcall (one-suited) double is Stayman and the rest stays on; over a
// double the system stays on and redouble rescues into a minor; other two-level overcalls: Lebensohl
books.push(
  { after: '1N (2C)', rules: responses(ONE_NT, 'X').filter((rule) => rule.call !== '2C'), more: true },
  { after: '1N (2C) X (P)', rules: staymanAnswers(ONE_NT), more: true },
  { after: '1N (X)', rules: responses(ONE_NT, '2C', true), more: true },
  { after: '1N (X) 2C (P)', rules: staymanAnswers(ONE_NT), more: true },
  // Transfers over a 2♣ overcall or a double: opener completes them as usual
  ...MAJORS.flatMap((M): Book[] =>
    ['1N (2C)', '1N (X)'].map((start) => ({ after: `${start} ${M === 'H' ? '2D' : '2H'} (P)`, rules: transferAnswers(ONE_NT, M), more: true })),
  ),
  { after: '1N (X) XX (P)', rules: [{ call: '2C', shows: { notes: [{ key: 'completes' }], artificial: true } }], more: true },
  {
    after: '1N (X) XX (P) 2C (P)',
    rules: [
      { call: '2D', shows: { len: { D: [5, 13] }, notes: [{ key: 'signoff' }] }, when: (h) => h.len.D > h.len.C },
      { call: 'P', shows: { len: { C: [5, 13] }, notes: [{ key: 'toPlay' }] } },
    ],
    more: true,
  },
)
for (const theirs of ['D', 'H', 'S'] as Suit[])
  books.push(
    { after: `1N (2${theirs})`, rules: lebensohl(theirs), more: true },
    { after: `1N (2${theirs}) 2N (P)`, rules: [{ call: '3C', shows: { notes: [{ key: 'completes' }], artificial: true } }], more: true },
    { after: `1N (2${theirs}) 2N (P) 3C (P)`, rules: afterLebensohlRelay(theirs), more: true },
  )

export const notrump: readonly Book[] = books
