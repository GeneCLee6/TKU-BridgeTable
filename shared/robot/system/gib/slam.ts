import { isBid, levelOf, strainOf, type Call } from '../../../auction.ts'
import { SUITS, type Suit } from '../../../cards.ts'
import { callsOf, cheapest, lastOf, type Ctx } from '../context.ts'
import { keycards, type Hand } from '../evaluate.ts'
import type { Book, Rule, Spec } from '../spec.ts'
import { goalFor } from './fallback.ts'
import { above, bid, isMajor, UP } from './util.ts'

/** Slam bidding, docs/BBO GIB/gib-2over1.md §10 (GIB System Notes): RKCB 0314, DOPI, Gerber */

/**
 * The trump suit for keycards: the suit we have most recently bid among those where we have shown
 * eight cards between us; with no agreed suit, the last suit our side bid (GIB System Notes)
 */
export function trumpOf(ctx: Ctx): Suit | null {
  const shown = (s: Suit) => (ctx.shown.me.len?.[s]?.[0] ?? 0) + (ctx.shown.partner.len?.[s]?.[0] ?? 0)
  // Their suits are cue bids for us, never trumps
  const theirs = ctx.turns.filter((t) => !t.ours && isBid(t.call)).map((t) => strainOf(t.call))
  const ours = ctx.turns
    .filter((t) => t.ours && isBid(t.call) && strainOf(t.call) !== 'N' && !theirs.includes(strainOf(t.call)))
    .map((t) => strainOf(t.call) as Suit)
  for (let i = ours.length - 1; i >= 0; i--) if (shown(ours[i]) >= 8) return ours[i]
  const fits = SUITS.filter((s) => shown(s) >= 8).sort((a, b) => Number(isMajor(b)) - Number(isMajor(a)))
  return fits[0] ?? ours.at(-1) ?? null
}

const weBid = (ctx: Ctx) => ctx.turns.some((t) => t.ours && t.call !== 'P')
const asked = (ctx: Ctx) => [...callsOf(ctx, 'me'), ...callsOf(ctx, 'partner')].includes('4N')
const aces = (h: Hand) => SUITS.filter((s) => h.ranks[s].includes('A')).length
const hasQueen = (h: Hand, t: Suit) => h.ranks[t].includes('Q')

/** This hand wants a slam in the trump suit (the fallback's judgement) */
function wantsSlam(h: Hand, ctx: Ctx): boolean {
  const goal = goalFor(h, ctx)
  return !!goal && (goal.kind === 'slam' || goal.kind === 'grand') && goal.strain === trumpOf(ctx)
}

// ── Asking ───────────────────────────────────────────────────────────────────────────────────

const askRkcb: Book = {
  only: (ctx) => weBid(ctx) && !!trumpOf(ctx) && !asked(ctx) && (levelOf(cheapest(ctx, 'N') ?? '5N') <= 4),
  rules: [
    {
      call: '4N',
      minLevel: 'college',
      shows: (ctx) => ({ name: 'rkcb', trump: trumpOf(ctx)!, notes: [{ key: 'slamInterest' }], forcing: 'oneRound', artificial: true }),
      when: wantsSlam,
    },
  ],
  more: true,
}

// ── Answering 4NT ────────────────────────────────────────────────────────────────────────────

/** The trump of partner's RKCB */
const askedTrump = (ctx: Ctx): Suit | undefined => ctx.said.partner?.trump

function keycardAnswers(): Rule[] {
  const answer = (call: Call, counts: number[], queen?: boolean): Rule => ({
    call,
    shows: (ctx): Spec => ({ name: 'keycards', trump: askedTrump(ctx), keycards: counts, ...(queen === undefined ? {} : { trumpQueen: queen }) }),
  })
  const voidIn = (h: Hand, t: Suit) => UP.find((s) => s !== t && h.len[s] === 0) ?? null
  return [
    // A void: 5NT with an even number of keycards, six of the void suit (or of trumps) with an odd one
    {
      call: '5N',
      shows: (ctx) => ({ name: 'keycards', trump: askedTrump(ctx), keycards: [2, 4], notes: [{ key: 'void' }] }),
      needs: {},
      when: (h, ctx) => {
        const t = askedTrump(ctx)!
        return !!voidIn(h, t) && [2, 4].includes(keycards(h, t))
      },
    },
    ...UP.map(
      (x): Rule => ({
        call: (ctx) => {
          const t = askedTrump(ctx)
          return t && (x === t || !above(x, t)) ? bid(6, x) : null
        },
        shows: (ctx) => {
          const t = askedTrump(ctx)!
          return { name: 'keycards', trump: t, keycards: [1, 3], notes: [{ key: 'void' }, ...(x === t ? [] : [{ key: 'shortIn' as const, strain: x }])] }
        },
        needs: {},
        when: (h, ctx) => {
          const t = askedTrump(ctx)!
          const v = voidIn(h, t)
          return !!v && [1, 3].includes(keycards(h, t)) && (x === t ? above(v, t) : v === x)
        },
      }),
    ),
    answer('5C', [0, 3]),
    answer('5D', [1, 4]),
    answer('5S', [2, 5], true),
    answer('5H', [2, 5], false),
  ]
}

/** DOPI: an opponent bid over our 4NT; double with 0 keycards, pass with 1, then the steps */
function dopi(): Rule[] {
  const t = (ctx: Ctx) => askedTrump(ctx)!
  const step = (n: number) => (ctx: Ctx) => {
    const last = ctx.last!.call
    const strains: Call[] = []
    for (let level = levelOf(last); level <= 7 && strains.length < n + 1; level++)
      for (const s of ['C', 'D', 'H', 'S', 'N'] as const) {
        const call = bid(level, s)
        if (ctx.legal.has(call)) strains.push(call)
      }
    return strains[n] ?? null
  }
  return [
    { call: 'X', shows: (ctx) => ({ name: 'dopi', trump: t(ctx), keycards: [0, 3] }) },
    // Over a double of 4NT: redouble with 0 (ROPI)
    { call: 'XX', shows: (ctx) => ({ name: 'dopi', trump: t(ctx), keycards: [0, 3] }) },
    { call: 'P', shows: (ctx) => ({ name: 'dopi', trump: t(ctx), keycards: [1, 4] }) },
    { call: step(0), shows: (ctx) => ({ name: 'dopi', trump: t(ctx), keycards: [2, 5] }) },
  ]
}

// ── After the answer: sign off, bid slam, or ask for the queen or kings ─────────────────────

/**
 * Partner's keycards from an ambiguous answer (0 or 3, 1 or 4): the higher count when partner has
 * shown a good hand, or when the lower one would leave us with almost none
 */
function partnerKeycards(ctx: Ctx, mine: number): number {
  const counts = ctx.said.partner?.keycards ?? [0]
  const [low, high] = [Math.min(...counts), Math.max(...counts)]
  const shown = ctx.shown.partner
  const strength = Math.max(shown.hcp?.[0] ?? 0, (shown.tp?.[0] ?? 0) - 2)
  return mine + high <= 5 && (strength >= 13 || mine + low <= 1) ? high : low
}

function afterAnswer(): Rule[] {
  const trump = (ctx: Ctx) => ctx.said.me!.trump!
  const total = (h: Hand, ctx: Ctx) => keycards(h, trump(ctx)) + partnerKeycards(ctx, keycards(h, trump(ctx)))
  const queen = (h: Hand, ctx: Ctx) => hasQueen(h, trump(ctx)) || ctx.said.partner?.trumpQueen === true
  const grand = (h: Hand, ctx: Ctx) => goalFor(h, ctx)?.kind === 'grand'
  const signoff = (ctx: Ctx) => {
    const call = cheapest(ctx, trump(ctx))
    return call && levelOf(call) <= 5 ? call : null
  }
  return [
    { call: (ctx) => bid(7, trump(ctx)), shows: { notes: [{ key: 'grandSlam' }] }, when: (h, ctx) => total(h, ctx) === 5 && queen(h, ctx) && grand(h, ctx) },
    {
      call: '5N',
      shows: (ctx) => ({ name: 'kingAsk', trump: trump(ctx), keycards: [5], trumpQueen: true, artificial: true, forcing: 'oneRound' }),
      needs: {},
      when: (h, ctx) => total(h, ctx) === 5 && queen(h, ctx) && (h.hcp + (ctx.shown.partner.hcp?.[0] ?? 0) >= 33),
    },
    // The queen ask: the next step after 5♣/5♦ that is not five of the trump suit
    {
      call: (ctx) => {
        const answer = lastOf(ctx, 'partner')
        if (answer !== '5C' && answer !== '5D') return null
        const next = answer === '5C' ? '5D' : '5H'
        return strainOf(next) === trump(ctx) ? (next === '5D' ? '5H' : '5S') : next
      },
      shows: (ctx) => ({ name: 'queenAsk', trump: trump(ctx), artificial: true, forcing: 'oneRound' }),
      needs: {},
      when: (h, ctx) => total(h, ctx) >= 4 && !queen(h, ctx),
    },
    { call: (ctx) => bid(6, trump(ctx)), shows: { notes: [{ key: 'smallSlam' }] }, when: (h, ctx) => total(h, ctx) >= 4 },
    { call: signoff, shows: { notes: [{ key: 'signoff' }] } },
    { call: 'P', shows: { notes: [{ key: 'signoff' }] } },
  ]
}

/** Answering the queen ask: no queen bids the trump suit, the queen shows a side king or bids 5NT */
function queenAnswers(): Rule[] {
  const t = (ctx: Ctx) => askedTrump(ctx)!
  return [
    ...UP.map(
      (x): Rule => ({
        call: (ctx) => {
          const call = cheapest(ctx, x)
          return x !== t(ctx) && call && levelOf(call) <= 6 && (levelOf(call) < 6 || !above(x, t(ctx))) ? call : null
        },
        shows: (ctx) => ({ name: 'keycards', trump: t(ctx), trumpQueen: true, notes: [{ key: 'kingIn', strain: x }] }),
        when: (h, ctx) => hasQueen(h, t(ctx)) && h.ranks[x].includes('K'),
      }),
    ),
    { call: '5N', shows: (ctx) => ({ name: 'keycards', trump: t(ctx), trumpQueen: true, notes: [{ key: 'noKing' }] }), when: (h, ctx) => hasQueen(h, t(ctx)) },
    { call: (ctx) => cheapest(ctx, t(ctx)), shows: (ctx) => ({ name: 'keycards', trump: t(ctx), trumpQueen: false }) },
  ]
}

/** Answering 5NT: bid a grand with thirteen tricks, the lowest side king below the trump suit, or six */
function kingAnswers(): Rule[] {
  const t = (ctx: Ctx) => askedTrump(ctx)!
  return [
    ...UP.map(
      (x): Rule => ({
        call: (ctx) => (x !== t(ctx) && !above(x, t(ctx)) ? bid(6, x) : null),
        shows: { name: 'keycards', notes: [{ key: 'kingIn', strain: x }] },
        when: (h) => h.ranks[x].includes('K') && UP.every((y) => y === x || !h.ranks[y].includes('K') || above(y, x)),
      }),
    ),
    { call: (ctx) => bid(6, t(ctx)), shows: { name: 'keycards', notes: [{ key: 'noKing' }] } },
  ]
}

/** After the queen or king answers: slam, or the grand when everything is there */
function finish(): Rule[] {
  const trump = (ctx: Ctx) => ctx.said.me!.trump!
  return [
    {
      call: (ctx) => bid(7, trump(ctx)),
      shows: { notes: [{ key: 'grandSlam' }] },
      when: (h, ctx) => goalFor(h, ctx)?.kind === 'grand' && ctx.said.partner?.trumpQueen !== false,
    },
    { call: (ctx) => bid(6, trump(ctx)), shows: { notes: [{ key: 'smallSlam' }] }, when: (_, ctx) => ctx.said.partner?.trumpQueen !== false },
    // No queen: stay in five of the trump suit
    { call: 'P', shows: { notes: [{ key: 'signoff' }] } },
  ]
}

// ── Gerber over notrump: 4♦ 0 or 4 aces, 4♥ 1, 4♠ 2, 4NT 3 ─────────────────────────────────

const gerberAnswers: Rule[] = [
  { call: '4D', shows: { name: 'keycards', notes: [{ key: 'aces', counts: [0, 4] }] }, needs: {}, when: (h) => aces(h) % 4 === 0 },
  { call: '4H', shows: { name: 'keycards', notes: [{ key: 'aces', counts: [1] }] }, needs: {}, when: (h) => aces(h) === 1 },
  { call: '4S', shows: { name: 'keycards', notes: [{ key: 'aces', counts: [2] }] }, needs: {}, when: (h) => aces(h) === 2 },
  { call: '4N', shows: { name: 'keycards', notes: [{ key: 'aces', counts: [3] }] }, needs: {}, when: (h) => aces(h) === 3 },
]

// ── The books ─────────────────────────────────────────────────────────────────────────────────

const partnerSaid = (name: Spec['name']) => (ctx: Ctx) => ctx.said.partner?.name === name
const iSaid = (name: Spec['name']) => (ctx: Ctx) => ctx.said.me?.name === name
const rhoPassed = (ctx: Ctx) => ctx.turns.at(-1)?.call === 'P'

/** Answers to the slam conventions: tried first, whatever the auction */
export const slamAnswers: readonly Book[] = [
  { only: (ctx) => partnerSaid('rkcb')(ctx) && lastOf(ctx, 'partner') === '4N' && rhoPassed(ctx), rules: keycardAnswers() },
  { only: (ctx) => partnerSaid('rkcb')(ctx) && lastOf(ctx, 'partner') === '4N' && !rhoPassed(ctx), rules: dopi() },
  { only: (ctx) => iSaid('rkcb')(ctx) && (partnerSaid('keycards')(ctx) || partnerSaid('dopi')(ctx)), rules: afterAnswer() },
  { only: (ctx) => partnerSaid('queenAsk')(ctx), rules: queenAnswers() },
  { only: (ctx) => partnerSaid('kingAsk')(ctx), rules: kingAnswers() },
  { only: (ctx) => iSaid('queenAsk')(ctx) || iSaid('kingAsk')(ctx), rules: finish() },
  // Having answered, leave the decision to the asker
  { only: (ctx) => iSaid('keycards')(ctx) || iSaid('dopi')(ctx), rules: [{ call: 'P', shows: {} }] },
  { after: ['1N (P) 4C (P)', '2N (P) 4C (P)', '2C (P) 2D (P) 2N (P) 4C (P)'], rules: gerberAnswers },
]

/** Asking with RKCB: after the other books, before the fallback */
export const slamAsks: readonly Book[] = [askRkcb]
