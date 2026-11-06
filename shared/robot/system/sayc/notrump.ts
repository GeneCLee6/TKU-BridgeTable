import { isBid, levelOf, strainOf, type Call } from '../../../auction.ts'
import type { Suit } from '../../../cards.ts'
import { cheapest, type Ctx } from '../context.ts'
import type { Hand } from '../evaluate.ts'
import { neverFits, type Book, type Range, type Rule } from '../spec.ts'
import { bid, MAJORS, other, plus, UP } from '../gib/util.ts'

/** After a notrump opening or rebid, docs/systems/sayc.md §4 and §5 */

/** Responder's ranges facing each opening, and how far up its relays sit */
export interface Ranges {
  /** 0 after 1NT; 1 after 2NT, where Stayman, transfers and their answers are a level higher */
  up: 0 | 1
  weak: Range
  /** Inviting game (1NT only) */
  invite: Range | null
  game: Range
  quant: Range
  slam: Range
  grand: number
  /** Opener's top: the jump accepting a transfer, and accepting invitations from one below */
  top: number
}

export const ONE_NT: Ranges = { up: 0, weak: [0, 7], invite: [8, 9], game: [10, 15], quant: [16, 17], slam: [18, 19], grand: 20, top: 17 }
export const TWO_NT: Ranges = { up: 1, weak: [0, 3], invite: null, game: [4, 10], quant: [11, 12], slam: [13, 15], grand: 16, top: 21 }
/** After 2♣–2♦–2NT (22–24): the 2NT responses, a few points lower */
export const STRONG_NT: Ranges = { up: 1, weak: [0, 1], invite: null, game: [2, 8], quant: [9, 10], slam: [11, 13], grand: 14, top: 24 }

const fourMajor = (h: Hand) => h.len.H === 4 || h.len.S === 4
const fiveFive = (h: Hand) => h.len.H >= 5 && h.len.S >= 5
const fiveMajor = (h: Hand): Suit | null => (h.len.H >= 5 && h.len.H > h.len.S ? 'H' : h.len.S >= 5 && h.len.S > h.len.H ? 'S' : null)
const within = (n: number, [lo, hi]: Range) => n >= lo && n <= hi
const stopped = (h: Hand, s: Suit) => h.stop[s] === 'stop' || h.stop[s] === 'double'
const quantitative = (hcp: Range) => ({ name: 'quantitative' as const, hcp, notes: [{ key: 'invite' as const }, { key: 'smallSlam' as const }] })

// ── Responses ─────────────────────────────────────────────────────────────────────────────────

function responses(r: Ranges): Rule[] {
  const stayman = bid(2 + r.up, 'C')
  const rules: Rule[] = []
  // Six cards in a major and slam interest, in one go; otherwise the transfer
  if (r.up === 0)
    for (const M of MAJORS)
      rules.push({
        call: bid(3, M),
        shows: { len: { [M]: [6, 13] }, hcp: plus(14), notes: [{ key: 'slamInterest' }], forcing: 'game' },
        when: (h) => h.len[M] > h.len[other(M)],
      })
  // Gerber with a suit to play in; a balanced hand raises notrump instead
  rules.push({
    call: '4C',
    shows: { name: 'gerber', artificial: true, forcing: 'oneRound' },
    needs: { hcp: plus(r.quant[0]) },
    when: (h) => h.shape[0] >= 6,
  })
  rules.push(
    { call: '7N', shows: { hcp: plus(r.grand), notes: [{ key: 'toPlay' }] } },
    { call: '6N', shows: { hcp: [r.slam[0], r.grand - 1], notes: [{ key: 'toPlay' }] } },
    { call: '4N', shows: quantitative(r.quant) },
  )
  // Stayman: game values or an invitation with a four-card major; non-forcing, so a weak hand short
  // in clubs may also stop in opener's answer
  const least = r.invite ? r.invite[0] : r.game[0]
  rules.push(
    {
      call: stayman,
      shows: { name: 'stayman', forcing: 'oneRound', artificial: true, notes: [{ key: 'asksMajor' }] },
      needs: { hcp: plus(least) },
      when: (h) => fourMajor(h) && !fiveFive(h) && h.len.H + h.len.S <= 9,
    },
    ...(r.up === 0
      ? [
          {
            call: stayman,
            shows: { name: 'stayman' as const, forcing: 'oneRound' as const, artificial: true, notes: [{ key: 'asksMajor' as const }] },
            needs: { hcp: r.weak, len: { C: [0, 1], S: [3, 5], H: [3, 5], D: [3, 6] } as const },
          },
        ]
      : []),
  )
  // Transfers: five or more; 5-5 through hearts when weak or inviting, spades with game values
  for (const M of MAJORS)
    rules.push({
      call: bid(2 + r.up, M === 'H' ? 'D' : 'H'),
      shows: { name: 'transfer', len: { [M]: [5, 13] }, notes: [{ key: 'transferTo', strain: M }], forcing: 'oneRound', artificial: true },
      when: (h) => (fiveFive(h) ? M === (within(h.hcp, r.game) ? 'S' : 'H') : fiveMajor(h) === M),
    })
  if (r.up === 0) {
    const longMinor = (h: Hand) => h.len.C >= 6 || h.len.D >= 6
    rules.push(
      ...(['C', 'D'] as Suit[]).map((m): Rule => ({ call: bid(3, m), shows: { len: { [m]: [6, 13] }, hcp: [6, 9], notes: [{ key: 'invite' }] }, when: (h) => h.len[m] >= h.len[other(m)] })),
      { call: '2S', shows: { name: 'relay', hcp: [0, 5], notes: [{ key: 'relayTo', calls: ['3C'] }], forcing: 'oneRound', artificial: true }, when: longMinor },
    )
  }
  rules.push({ call: '3N', shows: { hcp: r.game, notes: [{ key: 'toPlay' }] } })
  if (r.invite) rules.push({ call: '2N', shows: { hcp: r.invite, notes: [{ key: 'invite' }] } })
  rules.push({ call: 'P', shows: { hcp: r.weak } })
  return rules
}

/** Opener answers Stayman: hearts first with both majors */
const staymanAnswers = (r: Ranges): Rule[] => [
  { call: bid(2 + r.up, 'H'), shows: { len: { H: [4, 5] } } },
  { call: bid(2 + r.up, 'S'), shows: { len: { S: [4, 5], H: [0, 3] } } },
  { call: bid(2 + r.up, 'D'), shows: { len: { S: [0, 3], H: [0, 3] }, notes: [{ key: 'noMajor' }], artificial: true } },
]

/** Opener accepts a transfer; a jump shows 17 (the top) and four trumps */
const transferAnswers = (r: Ranges, M: Suit): Rule[] => [
  { call: bid(3 + r.up, M), shows: { name: 'superAccept', len: { [M]: [4, 5] }, hcp: [r.top, r.top], notes: [{ key: 'maximum' }] } },
  { call: bid(2 + r.up, M), shows: { len: { [M]: [2, 5] }, notes: [{ key: 'completes' }] } },
]

/** Responder after opener's answer to Stayman */
function afterStayman(r: Ranges, answer: Suit): Rule[] {
  const rules: Rule[] = []
  const slam = plus(r.quant[0] - 2)
  // Three of a minor, or four over 2NT: five or more and slam interest
  for (const m of ['C', 'D'] as Suit[]) rules.push({ call: bid(3 + r.up, m), shows: { len: { [m]: [5, 13] }, hcp: slam, notes: [{ key: 'slamInterest' }], forcing: 'game' } })
  rules.push({ call: '4N', shows: quantitative(r.quant) })
  if (answer !== 'D') {
    const o = other(answer)
    rules.push({ call: bid(4, answer), shows: { len: { [answer]: [4, 13] }, hcp: r.game, notes: [{ key: 'game' }] }, when: (h) => h.len[answer] >= 4 })
    if (r.invite) {
      rules.push({ call: bid(3, answer), shows: { len: { [answer]: [4, 13] }, hcp: r.invite, notes: [{ key: 'invite' }] }, when: (h) => h.len[answer] >= 4 })
      if (answer === 'H') rules.push({ call: '2S', shows: { len: { S: [4, 5], H: [0, 3] }, hcp: r.invite, notes: [{ key: 'invite' }] }, when: (h) => h.len.S >= 4 })
    }
    rules.push({ call: '3N', shows: { len: { [answer]: [0, 3], [o]: [4, 5] }, hcp: r.game, notes: [{ key: 'toPlay' }] }, when: (h) => h.len[answer] < 4 })
  } else {
    for (const M of MAJORS)
      rules.push({ call: bid(3, M), shows: { len: { [M]: [5, 13] }, hcp: plus(r.game[0]), forcing: 'game' }, when: (h) => h.len[M] >= 5 })
    if (r.invite) for (const M of MAJORS) rules.push({ call: bid(2, M), shows: { len: { [M]: [5, 13] }, hcp: r.invite, notes: [{ key: 'invite' }] }, when: (h) => h.len[M] >= 5 })
    rules.push({ call: '3N', shows: { hcp: r.game, notes: [{ key: 'toPlay' }] } })
  }
  if (r.invite) rules.push({ call: '2N', shows: { hcp: r.invite, notes: [{ key: 'invite' }] } })
  rules.push({ call: 'P', shows: { hcp: r.weak } })
  return rules
}

/** Responder after a completed transfer */
function afterTransfer(r: Ranges, M: Suit): Rule[] {
  const rules: Rule[] = [
    { call: '4N', shows: { ...quantitative(r.quant), len: { [M]: [5, 5] } }, when: (h) => h.len[M] === 5 },
    { call: bid(4, M), shows: { len: { [M]: [6, 13] }, hcp: plus(r.game[0]), notes: [{ key: 'toPlay' }] } },
  ]
  // A new suit is natural and game forcing
  for (const x of UP.filter((s) => s !== M))
    rules.push({
      call: (ctx: Ctx) => cheapest(ctx, x),
      shows: { len: { [M]: [5, 13], [x]: [4, 13] }, hcp: plus(r.game[0]), forcing: 'game' },
      when: (h) => h.len[x] >= 4,
    })
  rules.push({ call: '3N', shows: { len: { [M]: [5, 5] }, hcp: r.game, notes: [{ key: 'choiceOf', calls: [bid(4, M), '3N'] }] } })
  if (r.invite)
    rules.push(
      { call: bid(3, M), shows: { len: { [M]: [6, 13] }, hcp: r.invite, notes: [{ key: 'invite' }] } },
      { call: '2N', shows: { len: { [M]: [5, 5] }, hcp: r.invite, notes: [{ key: 'invite' }] } },
    )
  rules.push({ call: 'P', shows: { hcp: r.weak } })
  return rules
}

/** Opener answers a notrump-range invitation: game with the top two points, else stop */
const acceptInvite = (r: Ranges, game: Call, stop: Call): Rule[] => [
  { call: game, shows: { hcp: [r.top - 1, r.top], notes: [{ key: 'accept' }] } },
  { call: stop, shows: { hcp: [r.top - 2, r.top - 2], notes: [{ key: 'decline' }] } },
]

/** Opener after 2NT with five trumps opposite: pass or three of the major with a minimum, 3NT or four with a maximum */
const afterTransferInvite = (r: Ranges, M: Suit): Rule[] => {
  const max: Range = [r.top - 1, r.top]
  const min: Range = [r.top - 2, r.top - 2]
  return [
    { call: bid(4, M), shows: { len: { [M]: [3, 5] }, hcp: max, notes: [{ key: 'maximum' }] } },
    { call: bid(3, M), shows: { len: { [M]: [3, 5] }, hcp: min, notes: [{ key: 'minimum' }] } },
    { call: '3N', shows: { len: { [M]: [2, 2] }, hcp: max, notes: [{ key: 'maximum' }] } },
    { call: 'P', shows: { len: { [M]: [2, 2] }, hcp: min, notes: [{ key: 'minimum' }] } },
  ]
}

/** Opener with a choice of 3NT and four of the major */
const choiceAnswers = (M: Suit): Rule[] => [
  { call: bid(4, M), shows: { len: { [M]: [3, 5] } } },
  { call: 'P', shows: { len: { [M]: [2, 2] } } },
]

/** Opener after a natural two of a major over 2♦, an invitation with five: pass with less */
const afterStaymanFive = (r: Ranges, M: Suit): Rule[] => [
  { call: bid(4, M), shows: { len: { [M]: [3, 3] }, hcp: [r.top - 1, r.top], notes: [{ key: 'accept' }] }, when: (h) => h.len[M] === 3 },
  { call: '3N', shows: { hcp: [r.top - 1, r.top], notes: [{ key: 'accept' }] } },
  { call: 'P', shows: { hcp: [r.top - 2, r.top - 2], notes: [{ key: 'decline' }] } },
]

/** Opener after three of a major over 2♦, or a jump to three: game in the major with three, else notrump */
const fitOrNotrump = (M: Suit): Rule[] => [
  { call: bid(4, M), shows: { len: { [M]: [3, 5] } }, when: (h) => h.len[M] >= 3 },
  { call: '3N', shows: { len: { [M]: [2, 2] } } },
]

// ── The books ─────────────────────────────────────────────────────────────────────────────────

/**
 * The books after a notrump bid: `open` is the auction up to it, `theirs` their call after it. Over
 * a double everything stays on, so the same books come again with (X)
 */
export function notrumpBooks(r: Ranges, open: string, theirs = '(P)'): Book[] {
  const start = `${open} ${theirs}`
  const stayman = bid(2 + r.up, 'C')
  const asked = `${start} ${stayman} (P)`
  const books: Book[] = [
    { after: start, rules: responses(r), more: true },
    { after: asked, rules: staymanAnswers(r), more: true },
  ]
  for (const answer of ['D', 'H', 'S'] as Suit[]) {
    const answered = `${asked} ${bid(2 + r.up, answer)} (P)`
    books.push({ after: answered, rules: afterStayman(r, answer), more: true })
    if (r.invite) {
      books.push({ after: `${answered} 2N (P)`, rules: acceptInvite(r, '3N', 'P'), more: true })
      if (answer !== 'D') books.push({ after: `${answered} 3${answer} (P)`, rules: acceptInvite(r, bid(4, answer), 'P'), more: true })
      else for (const M of MAJORS) books.push({ after: `${answered} 2${M} (P)`, rules: afterStaymanFive(r, M), more: true }, { after: `${answered} 3${M} (P)`, rules: fitOrNotrump(M), more: true })
    }
  }
  for (const M of MAJORS) {
    const transfer = bid(2 + r.up, M === 'H' ? 'D' : 'H')
    const done = bid(2 + r.up, M)
    books.push(
      { after: `${start} ${transfer} (P)`, rules: transferAnswers(r, M), more: true },
      { after: `${start} ${transfer} (P) ${done} (P)`, rules: afterTransfer(r, M), more: true },
      { after: `${start} ${transfer} (P) ${done} (P) 3N (P)`, rules: choiceAnswers(M), more: true },
    )
    if (r.invite)
      books.push(
        { after: `${start} ${transfer} (P) ${done} (P) 2N (P)`, rules: afterTransferInvite(r, M), more: true },
        { after: `${start} ${transfer} (P) ${done} (P) 2N (P) 3${M} (P)`, rules: [{ call: 'P', shows: { notes: [{ key: 'signoff' }] } }] },
        { after: `${start} ${transfer} (P) ${done} (P) 3${M} (P)`, rules: acceptInvite(r, bid(4, M), 'P'), more: true },
        { after: `${start} ${bid(3, M)} (P)`, rules: fitOrNotrump(M), more: true },
      )
  }
  if (r.invite)
    books.push(
      { after: `${start} 2N (P)`, rules: acceptInvite(r, '3N', 'P'), more: true },
      // 2♠ asks for 3♣: pass with clubs, 3♦ with diamonds, which opener passes
      { after: `${start} 2S (P)`, rules: [{ call: '3C', shows: { notes: [{ key: 'completes' }], artificial: true } }], more: true },
      {
        after: `${start} 2S (P) 3C (P)`,
        rules: [
          { call: '3D', shows: { len: { D: [6, 13] }, notes: [{ key: 'signoff' }] }, when: (h) => h.len.D > h.len.C },
          { call: 'P', shows: { len: { C: [6, 13] }, notes: [{ key: 'toPlay' }] } },
        ],
      },
      { after: `${start} 2S (P) 3C (P) 3D (P)`, rules: [{ call: 'P', shows: { notes: [{ key: 'toPlay' }] } }] },
      ...(['C', 'D'] as Suit[]).map(
        (m): Book => ({
          after: `${start} 3${m} (P)`,
          rules: [
            { call: '3N', shows: { len: { [m]: [2, 5] }, notes: [{ key: 'accept' }] }, when: (h) => h.len[m] >= 2 && /[AKQ]/.test(h.ranks[m]) },
            { call: 'P', shows: { notes: [{ key: 'decline' }] } },
          ],
          more: true,
        }),
      ),
    )
  return books
}

// ── Interference ──────────────────────────────────────────────────────────────────────────────

const theirSuit = (ctx: Ctx, at: number): Suit | null => {
  const call = ctx.turns[at]?.call
  if (!call || !isBid(call) || strainOf(call) === 'N') return null
  return strainOf(call) as Suit
}

/** They bid over 1NT: everything is natural but their suit, which forces to game and asks for a major */
function overTheirBid(): Rule[] {
  const z = (ctx: Ctx) => theirSuit(ctx, 1)!
  const rules: Rule[] = [
    { call: 'X', shows: (ctx) => ({ name: 'penalty', len: { [z(ctx)]: [4, 13] }, hcp: plus(8) }), when: (h, ctx) => h.len[z(ctx)] >= 4 },
    {
      call: (ctx) => cheapest(ctx, z(ctx)),
      shows: { name: 'stayman', hcp: plus(10), notes: [{ key: 'asksMajor' }], forcing: 'game', artificial: true },
      when: (h, ctx) => MAJORS.some((M) => M !== z(ctx) && h.len[M] === 4),
    },
  ]
  for (const M of MAJORS)
    rules.push({
      call: (ctx) => (z(ctx) === M ? null : bid(4, M)),
      shows: { len: { [M]: [5, 13] }, hcp: plus(10), notes: [{ key: 'game' }] },
      when: (h) => h.len[M] >= 6,
    })
  rules.push({ call: '3N', shows: (ctx) => ({ hcp: plus(10), stop: { [z(ctx)]: 'stop' } }), when: (h, ctx) => stopped(h, z(ctx)) })
  for (const x of UP) {
    const at = (ctx: Ctx, level: number) => {
      const call = z(ctx) === x ? null : cheapest(ctx, x)
      return call && levelOf(call) === level ? call : null
    }
    rules.push({ call: (ctx) => at(ctx, 3), shows: { len: { [x]: [5, 13] }, hcp: plus(10), forcing: 'game' } })
    rules.push({ call: (ctx) => at(ctx, 2), shows: { len: { [x]: [5, 13] }, hcp: [0, 9] } })
  }
  rules.push({ call: (ctx) => (cheapest(ctx, 'N') === '2N' ? '2N' : null), shows: (ctx) => ({ hcp: [8, 9], stop: { [z(ctx)]: 'stop' }, notes: [{ key: 'invite' }] }) }, { call: 'P', shows: {} })
  return rules
}

/**
 * They doubled or bid over a conventional response: bids keep their meaning, and bidding voluntarily
 * shows a real fit, so opener passes with two; a redouble of a doubled response is to play
 */
function afterInterference(M: Suit | null, responded: Suit, doubled: boolean): Rule[] {
  const rules: Rule[] = []
  if (doubled) rules.push({ call: 'XX', shows: { len: { [responded]: [5, 5] }, notes: [{ key: 'toPlay' }] }, when: (h) => h.len[responded] >= 5 })
  if (M) {
    rules.push({ call: (ctx) => cheapest(ctx, M), shows: { len: { [M]: [3, 5] }, notes: [{ key: 'support', strain: M }] }, when: (h) => h.len[M] >= 3 })
    rules.push({ call: 'P', shows: { len: { [M]: [2, 2] } } })
    return rules
  }
  rules.push(...MAJORS.map((x): Rule => ({ call: (ctx) => cheapest(ctx, x), shows: { len: { [x]: [4, 5] } }, when: (h) => h.len[x] >= 4 })), { call: 'P', shows: { len: { S: [0, 3], H: [0, 3] } } })
  return rules
}

/** Partner overcalled 1NT (15–18): only 2♣ is conventional */
function overcallResponses(theirs: Suit): Rule[] {
  const suit = (x: Suit): Rule => ({ call: bid(2, x), shows: { len: { [x]: [5, 13] }, hcp: [0, 7], notes: [{ key: 'toPlay' }] }, when: (h) => h.len[x] >= 5 })
  return [
    { call: '2C', shows: { name: 'stayman', hcp: plus(8), notes: [{ key: 'asksMajor' }], forcing: 'oneRound', artificial: true }, when: fourMajor },
    ...MAJORS.map((M): Rule => ({ call: bid(4, M), shows: { len: { [M]: [6, 13] }, hcp: plus(8), notes: [{ key: 'game' }] }, when: (h) => h.len[M] >= 6 })),
    ...UP.filter((x) => x !== theirs && x !== 'C').map(suit),
    { call: '3N', shows: { hcp: plus(9), notes: [{ key: 'toPlay' }] } },
    { call: '2N', shows: { hcp: [7, 8], notes: [{ key: 'invite' }] } },
    { call: 'P', shows: { hcp: [0, 8] } },
  ]
}

// ── Gerber and 3NT ────────────────────────────────────────────────────────────────────────────

/** 4♣ asks for aces after any notrump bid of 1NT or 2NT by partner, a rebid included */
const gerberAnywhere: Book = {
  only: (ctx) => {
    const last = ctx.turns.findLast((t) => t.ours && t.call !== 'P')
    // A natural 1NT or 2NT only: Jacoby's and the unusual 2NT carry a name
    return !!last && last.role === 'partner' && (last.call === '1N' || last.call === '2N') && !ctx.said.partner?.name && ctx.turns.at(-1)?.call === 'P'
  },
  rules: [{ call: '4C', shows: { name: 'gerber', artificial: true, forcing: 'oneRound' }, when: neverFits }],
  more: true,
}

/** Over 3NT: Stayman and transfers at the four level; slam with enough, otherwise leave it */
const overThreeNotrump: Book[] = [
  {
    after: '3N (P)',
    rules: [
      { call: '4C', shows: { name: 'stayman', hcp: plus(6), notes: [{ key: 'asksMajor' }], forcing: 'oneRound', artificial: true }, when: (h) => h.hcp >= 6 && fourMajor(h) },
      ...MAJORS.map(
        (M): Rule => ({
          call: M === 'H' ? '4D' : '4H',
          shows: { name: 'transfer', len: { [M]: [5, 13] }, notes: [{ key: 'transferTo', strain: M }], forcing: 'oneRound', artificial: true },
          when: (h) => h.len[M] >= 5 && h.len[M] >= h.len[other(M)],
        }),
      ),
      { call: '6N', shows: { hcp: plus(6), notes: [{ key: 'toPlay' }] } },
      { call: 'P', shows: { hcp: [0, 5] } },
    ],
    more: true,
  },
  {
    after: '3N (P) 4C (P)',
    rules: [
      { call: '4H', shows: { len: { H: [4, 5] } } },
      { call: '4S', shows: { len: { S: [4, 5], H: [0, 3] } } },
      { call: '4D', shows: { len: { S: [0, 3], H: [0, 3] }, notes: [{ key: 'noMajor' }], artificial: true } },
    ],
    more: true,
  },
  { after: '3N (P) 4D (P)', rules: [{ call: '4H', shows: { len: { H: [2, 5] }, notes: [{ key: 'completes' }] } }], more: true },
  { after: '3N (P) 4H (P)', rules: [{ call: '4S', shows: { len: { S: [2, 5] }, notes: [{ key: 'completes' }] } }], more: true },
]

// Gerber's book comes after the openings' own, whose rule for 4♣ is the one the robot bids with
const books: Book[] = [...notrumpBooks(ONE_NT, '1N'), ...notrumpBooks(TWO_NT, '2N'), ...notrumpBooks(STRONG_NT, '2C (P) 2D (P) 2N'), ...overThreeNotrump, gerberAnywhere]
books.push({ after: '1N (X)', rules: [{ call: 'XX', shows: { hcp: plus(10), notes: [{ key: 'toPlay' }] }, when: (h) => h.hcp >= 10 && h.balanced }], more: true }, ...notrumpBooks(ONE_NT, '1N', '(X)'))
books.push({
  after: '1N (+)',
  only: (ctx) => !!theirSuit(ctx, 1),
  rules: overTheirBid(),
  more: true,
})
for (const [call, M] of [
  ['2D', 'H'],
  ['2H', 'S'],
] as const) {
  books.push(
    { after: `1N (P) ${call} (X)`, rules: afterInterference(M, strainOf(call) as Suit, true), more: true },
    { after: `1N (P) ${call} (+)`, only: (ctx) => ctx.turns.at(-1)?.call !== 'X', rules: afterInterference(M, strainOf(call) as Suit, false), more: true },
  )
}
books.push({ after: '1N (P) 2C (X)', rules: afterInterference(null, 'C', true), more: true })
for (const x of UP) books.push({ after: `(1${x}) 1N (P)`, rules: overcallResponses(x), more: true }, { after: `(1${x}) 1N (P) 2C (P)`, rules: staymanAnswers(ONE_NT), more: true })

export const notrump: readonly Book[] = books
