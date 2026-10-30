import { bidIndex, isBid, levelOf, strainOf, type Call } from '../../../auction.ts'
import { SUITS, type Strain, type Suit } from '../../../cards.ts'
import { bidStrains, callsOf, cheapest, gameLevel, type Ctx } from '../context.ts'
import type { Hand } from '../evaluate.ts'
import { ANY, type Book, type Note, type Range, type Rule, type Spec } from '../spec.ts'
import { bid, isMajor, isMinor } from './util.ts'

/**
 * When no book covers the auction (docs/BBO GIB/gib-2over1.md §11): aim for a contract from this
 * hand and what partner has shown. A fit of eight cards picks the suit, otherwise notrump; about
 * 25 points between the hands make game, 33 a small slam, 37 a grand slam. The robot bids up to
 * the contract and stops there, so two robots always settle; against opponents it competes by the
 * Law of Total Tricks.
 *
 * GIB explains a call before it is made, without seeing the hand, so every call this book can make
 * is a rule of its own (the cheapest bid in each strain, a jump, game, slam) with what it shows
 * worked out from the auction; the hand only decides which of them it is.
 */

const STRAINS: readonly Strain[] = ['S', 'H', 'D', 'C', 'N']

type Level = 'part' | 'invite' | 'game' | 'slam' | 'grand'

/** Combined points for each kind of contract (total points in a suit, high-card points in notrump) */
const POINTS: Record<Level, Range> = {
  part: [19, 22],
  invite: [23, 24],
  game: [25, 32],
  slam: [33, 36],
  grand: [37, ANY],
}

/**
 * Partner's strength as we count it: a third of the way up the range they have shown. In a suit
 * the total points, unless a later call narrowed the high cards more: after 1♣ (1♦) X (P) 1♠ the
 * 11–14 of the 1♠ counts, not the 12–22 total points of the opening (V4a)
 */
export function partnerPoints(ctx: Ctx, notrump: boolean): number {
  const p = ctx.shown.partner
  const asTp = shift(p.hcp, 1)
  const width = (r: Range) => (r[1] >= ANY - 5 ? ANY : r[1] - r[0])
  const range = notrump ? (p.hcp ?? shift(p.tp, -1)) : p.tp && asTp && width(asTp) < width(p.tp) ? asTp : (p.tp ?? asTp)
  if (!range) return 0
  const [min, max] = range
  return max >= ANY - 5 ? min : Math.round(min + (max - min) / 3)
}

const shift = (r: Range | undefined, by: number): Range | undefined => r && [Math.max(0, r[0] + by), r[1] >= ANY ? ANY : r[1] + by]

/** The fewest cards partner has shown in a suit */
const partnerLength = (ctx: Ctx, s: Suit) => ctx.shown.partner.len?.[s]?.[0] ?? 0
const myLength = (ctx: Ctx, s: Suit) => ctx.shown.me.len?.[s]?.[0] ?? 0

/** What kind of contract a bid is, for its strain */
function levelKind(strain: Strain, level: number): Level {
  if (level === 7) return 'grand'
  if (level === 6) return 'slam'
  const game = gameLevel(strain)
  if (level >= game) return 'game'
  if (level === game - 1 && level >= 2) return 'invite'
  return 'part'
}

/** Our side has opened or made a call other than pass: this book has something to say */
const weAreBidding = (ctx: Ctx) => !!ctx.opening && (ctx.opening.ours || ctx.turns.some((t) => t.ours && t.call !== 'P'))

/** Suits the opponents bid (naturally or not): notrump wants a stopper there */
const theirSuits = (ctx: Ctx) => bidStrains(ctx, 'theirs').filter((s): s is Suit => s !== 'N')

// ── What each bid shows (from the auction only) ─────────────────────────────────────────────────

function showsFor(ctx: Ctx, call: Call): Spec {
  if (call === 'X') return { name: 'penalty' }
  const strain = strainOf(call)
  // Their suit, not shown naturally by us: a cue bid, strength and nothing about the suit
  if (strain !== 'N' && theirSuits(ctx).includes(strain) && partnerLength(ctx, strain) < 3 && myLength(ctx, strain) < 4) {
    const points = partnerPoints(ctx, false)
    return { name: 'cue', tp: [Math.max(0, POINTS.game[0] - points), ANY], forcing: 'oneRound', artificial: true }
  }
  const kind = levelKind(strain, levelOf(call))
  const notrump = strain === 'N'
  const partner = partnerPoints(ctx, notrump)
  const [lo, hi] = POINTS[kind]
  const min = kind === 'part' && ctx.forced ? 0 : Math.max(0, lo - partner)
  const points: Range = [min, hi >= ANY ? ANY : Math.max(min, hi - partner)]
  const notes: Note[] = []
  const spec: Spec = notrump ? { hcp: points } : { tp: points }
  if (notrump) {
    const stop: Spec['stop'] = {}
    for (const s of theirSuits(ctx)) stop[s] = 'likely'
    if (Object.keys(stop).length) spec.stop = stop
  } else if (partnerLength(ctx, strain) >= 3) {
    spec.len = { [strain]: [Math.max(2, 8 - partnerLength(ctx, strain)), 13] }
    notes.push({ key: 'support', strain })
  } else if (callsOf(ctx, 'me').some((c) => isBid(c) && strainOf(c) === strain)) {
    // Rebidding our own suit shows one more card
    spec.len = { [strain]: [Math.min(7, Math.max(5, myLength(ctx, strain)) + 1), 13] }
  } else if (kind === 'part' && levelOf(call) === levelOf(cheapest(ctx, strain) ?? call)) {
    spec.len = { [strain]: [4, 13] }
    spec.forcing = 'oneRound'
  } else {
    // A jump or a game bid in a new suit: a long suit of our own
    spec.len = { [strain]: [6, 13] }
  }
  if (kind === 'invite') notes.push({ key: 'invite' })
  if (kind === 'game') notes.push({ key: 'game' })
  if (kind === 'slam') notes.push({ key: 'smallSlam' })
  if (kind === 'grand') notes.push({ key: 'grandSlam' })
  if (notes.length) spec.notes = notes
  return spec
}

// ── What this hand does ──────────────────────────────────────────────────────────────────────────

interface Goal {
  strain: Strain
  level: number
  kind: Level
}

/** No singleton or void, and a likely stopper in every suit the opponents bid */
function notrumpOk(h: Hand, ctx: Ctx): boolean {
  if (h.shape[3] < 2) return false
  return theirSuits(ctx).every((s) => (h.stop[s] && h.stop[s] !== 'partial') || ctx.shown.partner.stop?.[s])
}

/** The contract this hand aims for, or null when there is not enough to bid on */
export function goalFor(h: Hand, ctx: Ctx): Goal | null {
  const total = (s: Suit) => h.len[s] + partnerLength(ctx, s)
  const fits = SUITS.filter((s) => total(s) >= 8).sort((a, b) => total(b) - total(a) || SUITS.indexOf(a) - SUITS.indexOf(b))
  const majorFit = fits.find(isMajor)
  const minorFit = fits.find(isMinor)
  const theirs = theirSuits(ctx)
  const ownSuit = SUITS.find((s) => !theirs.includes(s) && h.len[s] >= 6 && h.quality[s] !== null && h.quality[s] !== 'biddable')

  let strain: Strain = majorFit ?? (notrumpOk(h, ctx) ? 'N' : (minorFit ?? ownSuit ?? 'N'))
  const pointsIn = (st: Strain) => (st === 'N' ? h.hcp : h.tp) + partnerPoints(ctx, st === 'N')
  let points = pointsIn(strain)
  // A minor-suit game takes more: with 25–27 prefer 3NT when it can be played
  if (isMinor(strain) && points >= 25 && points < 33 && notrumpOk(h, ctx)) {
    strain = 'N'
    points = pointsIn('N')
  }
  // Slams also need the high cards: both hands count their short suits in total points, so shape
  // alone must not carry the partnership to slam
  const highCards = h.hcp + partnerPoints(ctx, true)
  let kind: Level | null =
    points >= 37 && highCards >= 35
      ? 'grand'
      : points >= 33 && highCards >= 31
        ? 'slam'
        : points >= (isMinor(strain) ? 28 : 25)
          ? 'game'
          : points >= 23
            ? 'invite'
            : points >= 19
              ? 'part'
              : null
  if (!kind) return null
  // No four-level invitations in a minor: compete for a part score instead
  if (kind === 'invite' && isMinor(strain)) kind = 'part'
  const game = gameLevel(strain)
  const level = kind === 'grand' ? 7 : kind === 'slam' ? 6 : kind === 'game' ? game : kind === 'invite' ? Math.max(2, game - 1) : 0
  return { strain, level, kind }
}

const decisions = new WeakMap<Ctx, WeakMap<Hand, Call>>()

/** The call this hand makes here (memoised: every rule of the book asks) */
export function decide(h: Hand, ctx: Ctx): Call {
  let byHand = decisions.get(ctx)
  if (!byHand) decisions.set(ctx, (byHand = new WeakMap()))
  let call = byHand.get(h)
  if (call === undefined) {
    call = work(h, ctx)
    if (!ctx.legal.has(call)) call = ctx.forced ? forcedCall(h, ctx) : 'P'
    byHand.set(h, call)
  }
  return call
}

function work(h: Hand, ctx: Ctx): Call {
  const last = ctx.last
  // Partner has only passed: nothing more to say unless the opponents bid over us
  const partnerBid = callsOf(ctx, 'partner').some((c) => c !== 'P')
  if (!partnerBid && !ctx.forced && (!last || last.ours)) return 'P'
  const goal = goalFor(h, ctx)
  if (!goal) return ctx.forced ? forcedCall(h, ctx) : 'P'
  const target = goal.level ? bid(goal.level, goal.strain) : null
  const cheap = cheapest(ctx, goal.strain)

  if (!last) return 'P'
  if (!last.ours) {
    // They bid last: bid to our goal, compete by the Law of Total Tricks, or double them when they
    // have taken our game away
    if (target && bidIndex(target) > bidIndex(last.call) && goal.kind !== 'part') return target
    if (goal.strain !== 'N' && cheap) {
      const trumps = h.len[goal.strain as Suit] + partnerLength(ctx, goal.strain as Suit)
      if (trumps >= 8 && levelOf(cheap) <= trumps - 6) return cheap
    }
    const ourGame = goal.kind === 'game' || goal.kind === 'slam' || goal.kind === 'grand'
    if (ourGame && ctx.legal.has('X') && levelOf(last.call) >= 4) return 'X'
    return 'P'
  }
  // We bid last: go on only if we are below the goal
  const stay = ctx.forced ? forcedCall(h, ctx) : 'P'
  if (goal.kind === 'part' || !target) {
    if (strainOf(last.call) === goal.strain && !ctx.forced) return 'P'
    // A part score only at a part-score level: the cheapest bid may already invite
    return cheap && levelKind(goal.strain, levelOf(cheap)) === 'part' ? cheap : stay
  }
  // Already in a game: do not move to another one
  const lastKind = levelKind(strainOf(last.call), levelOf(last.call))
  if (goal.kind === 'game' && lastKind !== 'part' && lastKind !== 'invite') return stay
  if (bidIndex(target) <= bidIndex(last.call)) return stay
  return target
}

/** Pass is not allowed: the cheapest sensible bid (also the system's emergency call) */
export function forcedCall(h: Hand, ctx: Ctx): Call {
  const partnerSuits = SUITS.filter((s) => partnerLength(ctx, s) >= 4).sort((a, b) => partnerLength(ctx, b) - partnerLength(ctx, a))
  const tries: Strain[] = [
    ...partnerSuits.filter((s) => h.len[s] >= 3),
    ...(notrumpOk(h, ctx) ? (['N'] as const) : []),
    // Our own suits, never theirs
    ...SUITS.filter((s) => !theirSuits(ctx).includes(s)).sort((a, b) => h.len[b] - h.len[a]),
    'N',
  ]
  for (const strain of tries) {
    const call = cheapest(ctx, strain)
    if (call && levelOf(call) <= Math.max(3, gameLevel(strain))) return call
  }
  return cheapest(ctx, 'N') ?? 'P'
}

// ── The book ─────────────────────────────────────────────────────────────────────────────────────

const bidLists = new WeakMap<Ctx, Call[]>()

/** Every bid this book may make here: in each strain the cheapest, a jump, game and the slams */
function bidsFor(ctx: Ctx): Call[] {
  let list = bidLists.get(ctx)
  if (list) return list
  const calls = new Set<Call>()
  for (const strain of STRAINS) {
    const base = cheapest(ctx, strain)
    if (!base) continue
    const from = levelOf(base)
    for (const level of [from, from + 1, gameLevel(strain), 6, 7]) if (level >= from && level <= 7) calls.add(bid(level, strain))
  }
  list = [...calls].sort((a, b) => bidIndex(a) - bidIndex(b))
  bidLists.set(ctx, list)
  return list
}

/** Rule n of the book stands for the n-th bid of `bidsFor` (at most 25: five strains, five levels) */
const nth = (n: number): Rule => ({
  call: (ctx) => bidsFor(ctx)[n] ?? null,
  shows: (ctx) => {
    const call = bidsFor(ctx)[n]
    return call && isBid(call) ? showsFor(ctx, call) : {}
  },
  needs: {},
  when: (h, ctx) => decide(h, ctx) === bidsFor(ctx)[n],
})

export const fallback: Book = {
  only: weAreBidding,
  rules: [
    ...Array.from({ length: 25 }, (_, n) => nth(n)),
    { call: 'X', shows: { name: 'penalty' }, needs: {}, when: (h, ctx) => decide(h, ctx) === 'X' },
    { call: 'P', when: (h, ctx) => decide(h, ctx) === 'P' },
  ],
}

/** The opponents opened and we have said nothing: the competition books (§7) decide; here, pass */
export const silent: Book = {
  only: (ctx) => !!ctx.opening && !weAreBidding(ctx),
  rules: [{ call: 'P' }],
}
