import { bidIndex, isBid, levelOf, STRAINS, strainOf, type Call } from '../../../auction.ts'
import { SUITS, type Suit } from '../../../cards.ts'
import { cheapest, lastOf, type Ctx } from '../context.ts'
import { keycards, type Hand } from '../evaluate.ts'
import type { Book, Rule, Spec } from '../spec.ts'
import { aim } from './target.ts'
import { aces, bid, isMajor, ORDER, ours, reads, rule, shownLength } from './util.ts'

/**
 * Slam conventions (e5-t35): RKCB 1430 with the trump queen ask and the 5NT king ask (淡江橋譜
 * 「開叫高花之滿貫詢問叫（J2N）」answers RKCB in steps, 1430; the old handbook's 「開叫1♥/1♠」
 * table is 0314: ROBOT.md §2), Blackwood for aces when no suit is agreed, Gerber over 1NT/2NT
 * (「1NT的答叫」「開叫1NT/2NT」) and the 5NT grand slam force. The answers come before every other
 * book; the robot asks RKCB itself when the fallback wants a slam in an agreed major.
 */

const BIDS: Call[] = [1, 2, 3, 4, 5, 6, 7].flatMap((level) => STRAINS.map((s) => bid(level, s)))

/** The bid `n` steps above `call` (1 is the next bid up), if there is one */
export function step(call: Call, n: number): Call | null {
  return BIDS[bidIndex(call) + n] ?? null
}

/** How many steps `call` is above `base` */
export const stepsAbove = (call: Call, base: Call) => bidIndex(call) - bidIndex(base)

/**
 * The agreed trump suit: the suit our side bid most recently among those where we have shown eight
 * cards or more between us (majors first); never the opponents' suit
 */
export function agreedTrump(ctx: Ctx): Suit | null {
  const shown = (s: Suit) => shownLength(ctx.shown.me, s) + shownLength(ctx.shown.partner, s)
  const theirs = ctx.turns.filter((t) => !t.ours && isBid(t.call)).map((t) => strainOf(t.call))
  const ours = ctx.turns.filter((t) => t.ours && isBid(t.call) && strainOf(t.call) !== 'N' && !theirs.includes(strainOf(t.call))).map((t) => strainOf(t.call) as Suit)
  for (let i = ours.length - 1; i >= 0; i--) if (shown(ours[i]) >= 8) return ours[i]
  return null
}

const hasQueen = (h: Hand, t: Suit) => h.ranks[t].includes('Q')
const rhoPassed = (ctx: Ctx) => ctx.turns.at(-1)?.call === 'P'
const partnerSaid = (name: Spec['name']) => (ctx: Ctx) => ctx.said.partner?.name === name
const iSaid = (name: Spec['name']) => (ctx: Ctx) => ctx.said.me?.name === name

/** What RKCB asks about: the trump suit */
export const rkcb = (trump: Suit): Spec => ({ name: 'rkcb1430', trump, artificial: true, forcing: 'oneRound', notes: [{ key: 'slamInterest' }] })

// ── Answering RKCB 1430: 1 or 4, 0 or 3, 2 without the queen, 2 with it ────────────────────────

const askedTrump = (ctx: Ctx): Suit => ctx.said.partner!.trump!

/** Keycards for partner's ask; exclusion keycard (EKB) leaves out the ace of partner's void */
function keycardsFor(h: Hand, ctx: Ctx): number {
  const said = ctx.said.partner!
  const excluded = said.name === 'ekb' ? said.notes?.find((n) => n.key === 'voidIn')?.strain : undefined
  return keycards(h, said.trump!) - (excluded && excluded !== 'N' && h.ranks[excluded].includes('A') ? 1 : 0)
}

function keycardAnswers(): Rule[] {
  const at = (n: number) => (ctx: Ctx) => step(lastOf(ctx, 'partner')!, n)
  const answer = (n: number, counts: number[], queen?: boolean): Rule =>
    rule(
      at(n),
      (ctx) => ({ name: 'keycards', trump: askedTrump(ctx), keycards: counts, artificial: true, ...(queen === undefined ? {} : { trumpQueen: queen }) }),
      (h, ctx) => counts.includes(keycardsFor(h, ctx)) && (queen === undefined || hasQueen(h, askedTrump(ctx)) === queen),
    )
  return [answer(1, [1, 4]), answer(2, [0, 3]), answer(3, [2, 5], false), answer(4, [2, 5], true)]
}

// ── The asker after the answer: sign off, ask for the queen or the kings, bid the slam ─────────

/** Partner's keycards from an ambiguous answer: the higher count when the lower one leaves us with two or fewer */
function partnerKeycards(ctx: Ctx, mine: number): number {
  const counts = ctx.said.partner?.keycards ?? [0]
  const [low, high] = [Math.min(...counts), Math.max(...counts)]
  return mine + low <= 2 && mine + high <= 5 ? high : low
}

/** Our points as the asker counts them: mine and two above the fewest partner has shown */
const combined = (h: Hand, ctx: Ctx) => h.hcp + Math.min(ctx.shown.partner.hcp?.[1] ?? 37, (ctx.shown.partner.hcp?.[0] ?? 0) + 2)

function afterAnswer(): Rule[] {
  const trump = (ctx: Ctx) => ctx.said.me!.trump!
  const total = (h: Hand, ctx: Ctx) => keycards(h, trump(ctx)) + partnerKeycards(ctx, keycards(h, trump(ctx)))
  const queenKnown = (h: Hand, ctx: Ctx) => hasQueen(h, trump(ctx)) || ctx.said.partner?.trumpQueen === true || h.len[trump(ctx)] + shownLength(ctx.shown.partner, trump(ctx)) >= 10
  const queenAsk = (ctx: Ctx) => {
    if (ctx.said.partner?.trumpQueen !== undefined) return null
    let call = step(lastOf(ctx, 'partner')!, 1)
    if (call && strainOf(call) === trump(ctx)) call = step(call, 1)
    // Only below five of the trump suit, so that the answer can still stop there
    return call && bidIndex(call) < bidIndex(bid(5, trump(ctx))) ? call : null
  }
  const signoff = (ctx: Ctx) => {
    const call = cheapest(ctx, trump(ctx))
    return call && levelOf(call) <= 5 ? call : null
  }
  const answered = (ctx: Ctx) => strainOf(lastOf(ctx, 'partner')!) === trump(ctx) && levelOf(lastOf(ctx, 'partner')!) === 5
  return [
    // Two keycards missing: stop at five (or pass partner's five of the trump suit)
    rule('P', { notes: [{ key: 'signoff' }] }, (h, ctx) => total(h, ctx) <= 3 && answered(ctx)),
    rule(signoff, { notes: [{ key: 'signoff' }] }, (h, ctx) => total(h, ctx) <= 3),
    rule(
      (ctx) => (queenAsk(ctx) ? queenAsk(ctx) : null),
      (ctx) => ({ name: 'queenAsk', trump: trump(ctx), artificial: true, forcing: 'oneRound' }),
      (h, ctx) => total(h, ctx) >= 4 && !queenKnown(h, ctx),
    ),
    rule(
      '5N',
      (ctx) => ({ name: 'kingAsk', trump: trump(ctx), keycards: [5], trumpQueen: true, artificial: true, forcing: 'oneRound' }),
      (h, ctx) => total(h, ctx) === 5 && queenKnown(h, ctx) && combined(h, ctx) >= 33,
    ),
    rule((ctx) => bid(6, trump(ctx)), { notes: [{ key: 'smallSlam' }] }, (h, ctx) => total(h, ctx) >= 4),
    // Bid the small slam anyway when five of the trump suit has gone by
    rule((ctx) => bid(6, trump(ctx)), { notes: [{ key: 'smallSlam' }] }),
  ]
}

/** Answering the queen ask: without it back to five of the trump suit, with it the small slam */
function queenAnswers(): Rule[] {
  const t = (ctx: Ctx) => ctx.said.partner!.trump!
  return [
    rule((ctx) => bid(6, t(ctx)), (ctx) => ({ name: 'keycards', trump: t(ctx), trumpQueen: true, notes: [{ key: 'smallSlam' }] }), (h, ctx) => hasQueen(h, t(ctx))),
    rule((ctx) => cheapest(ctx, t(ctx)), (ctx) => ({ name: 'keycards', trump: t(ctx), trumpQueen: false })),
  ]
}

/** Answering the king ask: the cheapest side king below six of the trump suit, otherwise six */
function kingAnswers(): Rule[] {
  const t = (ctx: Ctx) => ctx.said.partner!.trump!
  const below = (x: Suit, trump: Suit) => ORDER.indexOf(x) < ORDER.indexOf(trump)
  return [
    ...ORDER.map(
      (x): Rule =>
        rule(
          (ctx) => (below(x, t(ctx)) ? bid(6, x) : null),
          { name: 'keycards', notes: [{ key: 'kingIn', strain: x }] },
          (h, ctx) => h.ranks[x].includes('K') && ORDER.every((y) => y === x || y === t(ctx) || !h.ranks[y].includes('K') || ORDER.indexOf(y) > ORDER.indexOf(x)),
        ),
    ),
    rule((ctx) => bid(6, t(ctx)), { name: 'keycards', notes: [{ key: 'noKing' }] }),
  ]
}

/** After the queen or king answer: the grand slam with everything there, otherwise the small slam */
function finish(): Rule[] {
  const trump = (ctx: Ctx) => ctx.said.me!.trump!
  const showedKing = (ctx: Ctx) => ctx.said.partner?.notes?.some((n) => n.key === 'kingIn') ?? false
  return [
    rule('P', { notes: [{ key: 'signoff' }] }, (_, ctx) => {
      const answer = lastOf(ctx, 'partner')!
      return ctx.said.partner?.trumpQueen === false || (!iSaid('kingAsk')(ctx) && levelOf(answer) >= 6 && strainOf(answer) === trump(ctx))
    }),
    rule((ctx) => bid(7, trump(ctx)), { notes: [{ key: 'grandSlam' }] }, (h, ctx) => iSaid('kingAsk')(ctx) && combined(h, ctx) >= (showedKing(ctx) ? 34 : 36)),
    rule((ctx) => cheapest(ctx, trump(ctx)), { notes: [{ key: 'smallSlam' }] }),
  ]
}

// ── The 5NT grand slam force: seven with two of the top three trump honours ─────────────────

function grandSlamForceAnswers(): Rule[] {
  const t = (ctx: Ctx) => ctx.said.partner!.trump!
  const top = (h: Hand, s: Suit) => [...h.ranks[s].slice(0, 3)].filter((r) => 'AKQ'.includes(r)).length
  return [
    rule((ctx) => bid(7, t(ctx)), { notes: [{ key: 'grandSlam' }] }, (h, ctx) => top(h, t(ctx)) >= 2),
    rule((ctx) => bid(6, t(ctx)), { notes: [{ key: 'smallSlam' }] }),
  ]
}

/** 5NT straight after agreeing a suit (not after our 4NT): the grand slam force */
const grandSlamForce = (trump: Suit): Spec => ({ name: 'grandSlamForce', trump, artificial: true, forcing: 'oneRound' })

// ── Blackwood (no agreed suit) and Gerber: 0 or 4 aces, 1, 2, 3 ──────────────────────────────

const aceAnswers = (calls: readonly Call[]): Rule[] =>
  [[0, 4], [1], [2], [3]].map((counts, i) => rule(calls[i], { notes: [{ key: 'aces', counts }] }, (h) => counts.includes(aces(h))))

const kingCount = (h: Hand) => SUITS.filter((s) => h.ranks[s].includes('K')).length
const kingCountAnswers = (calls: readonly Call[]): Rule[] =>
  [[0, 4], [1], [2], [3]].map((counts, i) => rule(calls[i], { notes: [{ key: 'kings', counts }] }, (h) => counts.includes(kingCount(h))))

const NOTRUMP_OPENINGS = ['1N', '2N']
const answeredAces = (ctx: Ctx) => ctx.said.me?.notes?.some((n) => n.key === 'aces') ?? false

/** Blackwood: 4NT with no suit agreed, after both of us bid suits and neither bid notrump */
export function blackwoodHere(ctx: Ctx): boolean {
  const calls = ours(ctx).filter(isBid)
  return (
    !NOTRUMP_OPENINGS.includes(calls[0] ?? '') &&
    calls.every((c) => strainOf(c) !== 'N') &&
    new Set(calls.map(strainOf)).size >= 2 &&
    !agreedTrump(ctx) &&
    !ctx.turns.some((t) => !t.ours && t.call !== 'P') &&
    ctx.legal.has('4N')
  )
}

// ── The books ─────────────────────────────────────────────────────────────────────────────────

/** Answers to the slam conventions and the asker's next call: tried before every other book */
export const slamAnswers: Book[] = [
  { only: (ctx) => (partnerSaid('rkcb1430')(ctx) || partnerSaid('ekb')(ctx)) && rhoPassed(ctx), rules: keycardAnswers() },
  { only: (ctx) => iSaid('rkcb1430')(ctx) && partnerSaid('keycards')(ctx) && rhoPassed(ctx), rules: afterAnswer() },
  { only: (ctx) => partnerSaid('queenAsk')(ctx) && rhoPassed(ctx), rules: queenAnswers() },
  { only: (ctx) => partnerSaid('kingAsk')(ctx) && rhoPassed(ctx), rules: kingAnswers() },
  { only: (ctx) => partnerSaid('grandSlamForce')(ctx) && rhoPassed(ctx), rules: grandSlamForceAnswers() },
  { only: (ctx) => (iSaid('queenAsk')(ctx) || iSaid('kingAsk')(ctx)) && rhoPassed(ctx), rules: finish() },
  // Blackwood and Gerber: the asker decides; the answers to a later king ask
  { only: (ctx) => partnerSaid('blackwood')(ctx) && rhoPassed(ctx), rules: aceAnswers(['5C', '5D', '5H', '5S']) },
  { after: ['1N (P) 4C (P)', '2N (P) 4C (P)'], rules: aceAnswers(['4D', '4H', '4S', '4N']) },
  { after: ['1N (P) 4C (P) * (P) 4N (P)', '2N (P) 4C (P) * (P) 4N (P)'], rules: kingCountAnswers(['5C', '5D', '5H', '5S']) },
  // The Gerber asker: 4NT asks for kings (the robot does not ask Gerber, but reads it)
  { after: ['1N (P) 4C (P) * (P)', '2N (P) 4C (P) * (P)'], more: true, rules: [reads('4N', { name: 'kingAsk', artificial: true, forcing: 'oneRound' })] },
  // Having answered, leave the decision to the asker
  { only: (ctx) => (iSaid('keycards')(ctx) || answeredAces(ctx)) && rhoPassed(ctx) && !ctx.forced, rules: [rule('P')] },
]

/**
 * Asking: RKCB when the fallback wants a slam in an agreed major (the robot leaves minors to the
 * point count: five of a minor may be gone by the time the answer comes); how a person's 4NT
 * without an agreed suit (Blackwood) and 5NT after agreeing a suit (the grand slam force) read.
 * After the other books, before the fallback.
 */
export const slamAsks: Book = {
  only: (ctx) => !!ctx.opening && ctx.opening.ours,
  more: true,
  rules: [
    rule(
      (ctx) => {
        const t = agreedTrump(ctx)
        return t && isMajor(t) && ctx.legal.has('4N') && !ctx.turns.some((x) => x.ours && x.call === '4N') ? '4N' : null
      },
      (ctx) => rkcb(agreedTrump(ctx)!),
      (h, ctx) => {
        const goal = aim(h, ctx)
        return isBid(goal) && levelOf(goal) >= 6 && strainOf(goal) === agreedTrump(ctx)
      },
    ),
    {
      call: (ctx) => (blackwoodHere(ctx) ? '4N' : null),
      shows: { name: 'blackwood', artificial: true, forcing: 'oneRound', notes: [{ key: 'slamInterest' }] },
      needs: {},
      when: () => false,
    },
    {
      call: (ctx) => {
        const t = agreedTrump(ctx)
        return t && ctx.legal.has('5N') && lastOf(ctx, 'me') !== '4N' && !ctx.turns.some((x) => x.ours && (x.call === '4N' || x.call === '5N')) ? '5N' : null
      },
      shows: (ctx) => grandSlamForce(agreedTrump(ctx)!),
      needs: {},
      when: () => false,
    },
  ],
}
