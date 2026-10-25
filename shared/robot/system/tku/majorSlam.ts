import { bidIndex, isBid, levelOf, type Call } from '../../../auction.ts'
import type { Suit } from '../../../cards.ts'
import { cheapest, lastOf, type Ctx } from '../context.ts'
import { revalue, type Hand } from '../evaluate.ts'
import type { Book, Range, Rule } from '../spec.ts'
import { rkcb, step, stepsAbove } from './slam.ts'
import { bid, length, MAJORS, ORDER, ours, plus, reads, rule } from './util.ts'

/**
 * Slam bidding after a major-suit raise (e5-t36, e5-t37), 淡江橋譜「開叫高花之滿貫詢問叫（J2N）」
 * 「Bergen加叫（松濤版）」: after J2N opener shows shape and strength and answers responder's
 * relay (加一詢問); after a Bergen raise opener asks (14+, 15+, 17+) where responder is short;
 * after a splinter opener judges the fit, cue-bids a control with a hand in between. The captain
 * judges the slam the handbook's way (短門滿貫的判斷原則: the points outside partner's short suit)
 * and asks with RKCB 1430 (`slam.ts`).
 */

// ── Judging the slam ─────────────────────────────────────────────────────────────────────────

/** Points that work opposite partner's short suit: none there, but an ace there still counts two */
function outside(h: Hand, x: Suit, isVoid: boolean): number {
  const ace = h.ranks[x].includes('A')
  return h.hcp - h.points[x] + (ace && !isVoid ? 2 : 0)
}

/**
 * 短門滿貫的判斷原則: with nine trumps or more the other three suits need 25 points opposite a
 * singleton, 23 opposite a void; with eight, 27 and 25 (the long-trump hand short). Without a short
 * suit, 32 points (淡江自然制總覽「小滿貫：32 pts」), 31 with nine trumps.
 */
export function slamNeeds(trumps: number, short: 'single' | 'void' | null): number {
  if (short === 'void') return trumps >= 9 ? 23 : 25
  if (short === 'single') return trumps >= 9 ? 25 : 27
  return trumps >= 9 ? 31 : 32
}

const middle = (r: Range) => Math.floor((r[0] + r[1]) / 2)

interface Partner {
  range: Range
  /** The suit partner is short in, if known */
  short?: Suit
  void?: boolean
  /** Partner's trumps */
  trumps: number
}

/** My points opposite partner's hand, against what the slam needs */
function slamMargin(h: Hand, m: Suit, p: Partner): number {
  const trumps = h.len[m] + p.trumps
  const short = p.short ? (p.void ? 'void' : 'single') : null
  const mine = p.short ? outside(h, p.short, !!p.void) : h.hcp
  return mine + middle(p.range) - slamNeeds(trumps, short)
}

/** RKCB in these auctions: 4NT, or for hearts after J2N 4♠ (「♥為王牌時，這時的RKCB為4♠」); past it, the next step */
function rkcbCall(ctx: Ctx, m: Suit, j2nHearts: boolean): Call | null {
  const base = j2nHearts && m === 'H' ? '4S' : '4N'
  if (ctx.legal.has(base)) return base
  const last = ctx.last?.call
  return last ? step(last, 1) : null
}

/** Game in the major, or five past it, or pass when partner is already there */
function signoff(ctx: Ctx, m: Suit): Call | null {
  const last = ctx.last?.call
  if (last === bid(4, m) || last === bid(5, m)) return 'P'
  const call = cheapest(ctx, m)
  return call && levelOf(call) <= 5 ? call : 'P'
}

/** The captain's rules: RKCB when the slam margin is there, otherwise game */
function captain(m: Suit, partner: (ctx: Ctx) => Partner | null, j2nHearts = false, extra: Rule[] = []): Rule[] {
  const known = (ctx: Ctx) => partner(ctx)
  return [
    rule(
      (ctx) => (known(ctx) ? rkcbCall(ctx, m, j2nHearts) : null),
      () => rkcb(m),
      (h, ctx) => slamMargin(h, m, known(ctx)!) >= 0,
    ),
    ...extra,
    rule((ctx) => (known(ctx) ? signoff(ctx, m) : null), { notes: [{ key: 'signoff' }] }),
  ]
}

// ── J2N: opener shows shape (1♠–2NT, 1♥–2♠) ──────────────────────────────────────────────────

type Shape = { kind: 'void'; x: Suit } | { kind: 'two' } | { kind: 'single'; x: Suit } | { kind: '5422' } | { kind: 'balanced' }

/** Opener's shape the way the J2N answers see it */
function shapeOf(h: Hand, m: Suit): Shape {
  const sides = ORDER.filter((x) => x !== m)
  const voidSuit = sides.find((x) => h.len[x] === 0)
  if (voidSuit) return { kind: 'void', x: voidSuit }
  const single = sides.find((x) => h.len[x] === 1)
  if (single && sides.some((x) => h.len[x] >= 5)) return { kind: 'two' }
  if (single) return { kind: 'single', x: single }
  if (sides.some((x) => h.len[x] === 4)) return { kind: '5422' }
  return { kind: 'balanced' }
}

/** Opener's strength for the answers: a sixth trump counts one (「15-17的5332或是14-16的6322」) */
const strength = (h: Hand, m: Suit) => h.hcp + (h.len[m] >= 6 ? 1 : 0)

const J2N = (m: Suit): Call => (m === 'S' ? '2N' : '2S')

/** The calls of opener's first answer, by major */
interface J2NAnswers {
  /** Short in the cheapest suit, or 12–14 balanced, or a two-suiter */
  low: Call
  /** Short in the middle suit, or 15–17 balanced */
  mid: Call
  /** Short in the top suit, or 18–19 balanced */
  high: Call
  /** The suits of `low`, `mid`, `high` */
  shortOf: [Suit, Suit, Suit]
  fiveFourLow: Call
  fiveFourHigh: Call
  /** A void: the call for each suit; the top suit has a maximum and a minimum call */
  voids: Partial<Record<Suit, Call>>
  topVoid: Suit
  topVoidHigh: Call
  topVoidLow: Call
}

const ANSWERS: Record<'S' | 'H', J2NAnswers> = {
  S: { low: '3C', mid: '3D', high: '3H', shortOf: ['C', 'D', 'H'], fiveFourLow: '3S', fiveFourHigh: '3N', voids: { C: '4C', D: '4D' }, topVoid: 'H', topVoidHigh: '4H', topVoidLow: '4S' },
  H: { low: '2N', mid: '3C', high: '3D', shortOf: ['S', 'C', 'D'], fiveFourLow: '3H', fiveFourHigh: '3S', voids: { S: '3N', C: '4C' }, topVoid: 'D', topVoidHigh: '4D', topVoidLow: '4H' },
}

/** Opener's exclusion keycard asks, by the void */
const EKB: Record<'S' | 'H', Partial<Record<Suit, Call>>> = {
  S: { H: '4N', C: '5C', D: '5D' },
  H: { S: '4S', D: '4N', C: '5C' },
}

const BALANCED: Range[] = [
  [12, 14],
  [15, 17],
  [18, 19],
]

function j2nAnswers(m: 'S' | 'H'): Book {
  const a = ANSWERS[m]
  const rungs = [a.low, a.mid, a.high]
  const rules: Rule[] = []
  for (const [x, call] of Object.entries(a.voids) as [Suit, Call][])
    rules.push(rule(call, { len: { ...length(m, 5), [x]: [0, 0] }, hcp: [12, 21], notes: [{ key: 'voidIn', strain: x }] }, (h) => shapeOf(h, m).kind === 'void' && (shapeOf(h, m) as { x: Suit }).x === x))
  const topVoid = (h: Hand) => {
    const s = shapeOf(h, m)
    return s.kind === 'void' && s.x === a.topVoid
  }
  rules.push(
    rule(a.topVoidHigh, { len: { ...length(m, 5), [a.topVoid]: [0, 0] }, hcp: [14, 21], notes: [{ key: 'voidIn', strain: a.topVoid }, { key: 'maximum' }] }, (h) => topVoid(h) && strength(h, m) >= 14),
    rule(a.topVoidLow, { len: { ...length(m, 5), [a.topVoid]: [0, 0] }, hcp: [12, 13], notes: [{ key: 'voidIn', strain: a.topVoid }, { key: 'minimum' }] }, topVoid),
    rule(a.low, { len: length(m, 5), hcp: [12, 21], notes: [{ key: 'shortSomewhere' }] }, (h) => shapeOf(h, m).kind === 'two'),
  )
  a.shortOf.forEach((x, i) =>
    rules.push(
      rule(rungs[i], { len: { ...length(m, 5), [x]: [0, 1] }, hcp: [11, 21], notes: [{ key: 'shortIn', strain: x }] }, (h) => {
        const s = shapeOf(h, m)
        return s.kind === 'single' && s.x === x
      }),
    ),
  )
  rules.push(
    rule(a.fiveFourLow, { len: length(m, 5, 5), hcp: [12, 15], notes: [{ key: 'noShortness' }, { key: 'minimum' }] }, (h) => shapeOf(h, m).kind === '5422' && strength(h, m) <= 15),
    rule(a.fiveFourHigh, { len: length(m, 5, 5), hcp: [16, 21], notes: [{ key: 'noShortness' }, { key: 'maximum' }] }, (h) => shapeOf(h, m).kind === '5422'),
  )
  BALANCED.forEach((range, i) =>
    rules.push(
      rule(rungs[i], { len: length(m, 5), hcp: [range[0] - 1, range[1]], notes: [{ key: 'noShortness' }] }, (h) => {
        const v = strength(h, m)
        return shapeOf(h, m).kind === 'balanced' && (i === 2 || v <= range[1]) && (i === 0 || v >= range[0])
      }),
    ),
  )
  // EKB above game (「4NT ♥ EKB」「5♣ EKB」…): the robot does not ask with a void, but reads it
  for (const [x, call] of Object.entries(EKB[m]) as [Suit, Call][]) rules.push(reads(call, { name: 'ekb', trump: m, artificial: true, forcing: 'oneRound', notes: [{ key: 'voidIn', strain: x }] }))
  return { after: `1${m} (P) ${J2N(m)} (P)`, rules, more: true }
}

// ── J2N: responder's relay (加一詢問) and opener's answers ─────────────────────────────────────

/** The six singleton answers after the relay: five or six trumps in each strength band */
const SINGLE_BANDS: { six: boolean; range: Range }[] = [
  { six: false, range: [12, 15] },
  { six: true, range: [11, 14] },
  { six: false, range: [16, 18] },
  { six: true, range: [15, 17] },
  { six: false, range: [19, 21] },
  { six: true, range: [18, 20] },
]

const band = (h: Hand, m: Suit) => {
  const v = strength(h, m)
  const level = v <= 15 ? 0 : v <= 18 ? 1 : 2
  return level * 2 + (h.len[m] >= 6 ? 1 : 0)
}

/** Opener's first answer and its rung (0 low, 1 mid, 2 high), when it can be relayed */
function rungOf(m: 'S' | 'H', call: Call | undefined): number {
  const a = ANSWERS[m]
  return call === a.low ? 0 : call === a.mid ? 1 : call === a.high ? 2 : -1
}

const isJ2N = (ctx: Ctx, m: Suit) => {
  const o = ours(ctx)
  return o[0] === bid(1, m) && o[1] === J2N(m)
}

function relayAnswers(m: 'S' | 'H'): Book {
  const a = ANSWERS[m]
  const first = (ctx: Ctx) => rungOf(m, ours(ctx)[2])
  const relay = (ctx: Ctx) => ours(ctx)[3]
  /** The steps start after the two-suiter (low rung only) and balanced answers */
  const offset = (ctx: Ctx) => (first(ctx) === 0 ? 2 : 1)
  const at = (n: (ctx: Ctx) => number) => (ctx: Ctx) => step(relay(ctx), n(ctx))
  return {
    after: `1${m} (P) ${J2N(m)} (P) * (P) * (P)`,
    only: (ctx) => first(ctx) >= 0 && relay(ctx) === step(ours(ctx)[2], 1),
    rules: [
      rule(
        (ctx) => (first(ctx) === 0 ? step(relay(ctx), 1) : null),
        { len: length(m, 5), notes: [{ key: 'shortSomewhere' }] },
        (h) => shapeOf(h, m).kind === 'two',
      ),
      rule(
        at((ctx) => offset(ctx)),
        (ctx) => ({ len: length(m, 5), hcp: BALANCED[first(ctx)], notes: [{ key: 'noShortness' }] }),
        (h) => shapeOf(h, m).kind === 'balanced',
      ),
      ...SINGLE_BANDS.map((b, i) =>
        rule(
          at((ctx) => offset(ctx) + 1 + i),
          (ctx) => ({ len: { ...length(m, b.six ? 6 : 5, b.six ? 13 : 5), [a.shortOf[first(ctx)]]: [0, 1] }, hcp: b.range, notes: [{ key: 'shortIn', strain: a.shortOf[first(ctx)] }] }),
          (h) => shapeOf(h, m).kind === 'single' && band(h, m) === i,
        ),
      ),
    ],
  }
}

/** What responder knows after opener's answers */
function j2nPartner(ctx: Ctx, m: 'S' | 'H'): Partner | null {
  const a = ANSWERS[m]
  const o = ours(ctx)
  const answer = o[2]
  if (o.length === 3) {
    for (const [x, call] of Object.entries(a.voids) as [Suit, Call][]) if (answer === call) return { range: [12, 17], short: x, void: true, trumps: 5 }
    if (answer === a.topVoidHigh) return { range: [14, 18], short: a.topVoid, void: true, trumps: 5 }
    if (answer === a.topVoidLow) return { range: [12, 13], short: a.topVoid, void: true, trumps: 5 }
    if (answer === a.fiveFourLow) return { range: [12, 15], trumps: 5 }
    if (answer === a.fiveFourHigh) return { range: [16, 21], trumps: 5 }
    return null
  }
  const first = rungOf(m, answer)
  if (o.length !== 5 || first < 0 || o[3] !== step(answer, 1) || !isBid(o[4])) return null
  const k = stepsAbove(o[4], o[3]) - (first === 0 ? 1 : 0)
  if (first === 0 && k === 0) return { range: [12, 18], trumps: 5 }
  if (k === 1) return { range: BALANCED[first], trumps: 5 }
  const b = SINGLE_BANDS[k - 2]
  return b ? { range: b.range, short: a.shortOf[first], trumps: b.six ? 6 : 5 } : null
}

/** Responder, the captain (「captain永遠是答叫者」): relay over the shortness answers, then RKCB or game */
function j2nCaptain(m: 'S' | 'H'): Book[] {
  const firstRound: Book = {
    after: `1${m} (P) ${J2N(m)} (P) * (P)`,
    rules: [
      rule((ctx) => (rungOf(m, ours(ctx)[2]) >= 0 ? step(ours(ctx)[2], 1) : null), { name: 'ask', artificial: true, forcing: 'oneRound', notes: [{ key: 'asksShortness' }] }),
      ...captain(m, (ctx) => j2nPartner(ctx, m), true),
    ],
    more: true,
  }
  const secondRound: Book = {
    after: `1${m} (P) ${J2N(m)} (P) * (P) * (P) * (P)`,
    only: (ctx) => !!j2nPartner(ctx, m),
    rules: captain(m, (ctx) => j2nPartner(ctx, m), true),
    more: true,
  }
  return [firstRound, secondRound]
}

/** Partner bid game or five in our major after the slam auction began */
const partnerStopped = (ctx: Ctx, m: Suit) => ours(ctx).length >= 3 && (lastOf(ctx, 'partner') === bid(4, m) || lastOf(ctx, 'partner') === bid(5, m)) && ctx.turns.at(-1)?.call === 'P'

/** Opener leaves the decision to responder after J2N, and to the splinter bidder after a control bid */
const openerPasses: Book = {
  only: (ctx) =>
    ctx.opening?.role === 'me' &&
    MAJORS.some((m) => partnerStopped(ctx, m) && (isJ2N(ctx, m) || (!!keyOf(BERGEN[m as 'S' | 'H'].splinters, ours(ctx)[1]) && ours(ctx).length >= 4))),
  rules: [rule('P')],
}

// ── Bergen: opener asks where responder is short ─────────────────────────────────────────────

interface BergenCalls {
  raises: [Call, Call, Call]
  asks: [Call, Call, Call]
  /** After the 10–11 and 8–9 raises: no shortness, a void somewhere, a singleton */
  none: Call
  someVoid: Call
  single: Partial<Record<Suit, Call>>
  /** After the 6–7 raise: shortness (a singleton or a void), or none */
  shortLow: Partial<Record<Suit, Call>>
  noneLow: Call
  /** Asking which void, and the answers */
  voidAsk: Call
  voids: Partial<Record<Suit, Call>>
  /** Splinters: the void one and the singletons */
  voidSplinter: Call
  splinters: Partial<Record<Suit, Call>>
}

const BERGEN: Record<'S' | 'H', BergenCalls> = {
  S: {
    raises: ['3C', '3D', '3H'],
    asks: ['3D', '3H', '3N'],
    none: '3S',
    someVoid: '3N',
    single: { C: '4C', D: '4D', H: '4H' },
    shortLow: { C: '4C', D: '4D', H: '4H' },
    noneLow: '4S',
    voidAsk: '4C',
    voids: { D: '4D', H: '4H', C: '4S' },
    voidSplinter: '3N',
    splinters: { C: '4C', D: '4D', H: '4H' },
  },
  H: {
    raises: ['2N', '3C', '3D'],
    asks: ['3C', '3D', '3S'],
    none: '3H',
    someVoid: '3S',
    single: { S: '3N', C: '4C', D: '4D' },
    shortLow: { S: '3N', C: '4C', D: '4D' },
    noneLow: '4H',
    voidAsk: '3N',
    voids: { C: '4C', D: '4D', S: '4H' },
    voidSplinter: '3S',
    splinters: { S: '3N', C: '4C', D: '4D' },
  },
}

const RAISE_RANGES: Range[] = [
  [10, 11],
  [8, 9],
  [6, 7],
]
/** Opener asks with this much (「14+」「15+」「17+」) */
const ASK_MIN = [14, 15, 17]

const keyOf = (calls: Partial<Record<Suit, Call>>, call: Call | undefined): Suit | undefined =>
  (Object.entries(calls) as [Suit, Call][]).find(([, c]) => c === call)?.[0]

/** The side suit with one card or none (♣ first) */
const shortest = (h: Hand, m: Suit): Suit | undefined => ORDER.find((x) => x !== m && h.len[x] <= 1)
const voidIn = (h: Hand, m: Suit): Suit | undefined => ORDER.find((x) => x !== m && h.len[x] === 0)

/**
 * Opener's value once partner has raised (e5-t41, 牌值): high cards, the short side suits as the
 * hand with more trumps counts them (`revalue`: a void 2, a singleton 1, less one with an honour
 * there) and one for each trump past the fifth
 */
export const fitValue = (h: Hand, m: Suit, partnerTrumps = 4) => h.hcp + revalue(h, { trump: m, partnerTrumps }).shortness + Math.max(0, h.len[m] - 5)

function bergenAsks(m: 'S' | 'H'): Book[] {
  const b = BERGEN[m]
  return b.raises.map(
    (raise, i): Book => ({
      after: `1${m} (P) ${raise} (P)`,
      rules: [
        rule(b.asks[i], { name: 'ask', hcp: plus(ASK_MIN[i]), artificial: true, forcing: 'oneRound', notes: [{ key: 'asksShortness' }] }, (h) => fitValue(h, m) >= ASK_MIN[i]),
        rule(bid(3, m), { notes: [{ key: 'decline' }, { key: 'signoff' }] }),
      ],
    }),
  )
}

/** Responder answers the ask */
function bergenAnswers(m: 'S' | 'H'): Book[] {
  const b = BERGEN[m]
  const books: Book[] = b.raises.slice(0, 2).map(
    (raise, i): Book => ({
      after: `1${m} (P) ${raise} (P) ${b.asks[i]} (P)`,
      rules: [
        rule(b.someVoid, { len: length(m, 4), hcp: RAISE_RANGES[i], notes: [{ key: 'void' }] }, (h) => !!voidIn(h, m)),
        ...(Object.entries(b.single) as [Suit, Call][]).map(([x, call]) =>
          rule(call, { len: { ...length(m, 4), [x]: [1, 1] }, hcp: RAISE_RANGES[i], notes: [{ key: 'shortIn', strain: x }] }, (h) => shortest(h, m) === x),
        ),
        rule(b.none, { len: length(m, 4), hcp: RAISE_RANGES[i], notes: [{ key: 'noShortness' }] }),
      ],
    }),
  )
  books.push({
    after: `1${m} (P) ${b.raises[2]} (P) ${b.asks[2]} (P)`,
    rules: [
      ...(Object.entries(b.shortLow) as [Suit, Call][]).map(([x, call]) =>
        rule(call, { len: { ...length(m, 4), [x]: [0, 1] }, hcp: RAISE_RANGES[2], notes: [{ key: 'shortIn', strain: x }] }, (h) => shortest(h, m) === x),
      ),
      rule(b.noneLow, { len: length(m, 4), hcp: RAISE_RANGES[2], notes: [{ key: 'noShortness' }] }),
    ],
  })
  // Which void (after the answer, or after the void splinter)
  books.push({
    after: [...b.raises.slice(0, 2).map((raise, i) => `1${m} (P) ${raise} (P) ${b.asks[i]} (P) ${b.someVoid} (P) ${b.voidAsk} (P)`), `1${m} (P) ${b.voidSplinter} (P) ${b.voidAsk} (P)`],
    rules: (Object.entries(b.voids) as [Suit, Call][]).map(([x, call]) => rule(call, { len: { [x]: [0, 0] }, notes: [{ key: 'voidIn', strain: x }] }, (h) => voidIn(h, m) === x)),
  })
  return books
}

/** What opener knows about responder after the Bergen ask or the splinter */
function bergenPartner(ctx: Ctx, m: 'S' | 'H'): Partner | null {
  const b = BERGEN[m]
  const o = ours(ctx)
  if (o[0] !== bid(1, m)) return null
  const raise = b.raises.indexOf(o[1] as never)
  // Splinters: 12–13
  if (o.length === 2) {
    const x = keyOf(b.splinters, o[1])
    return x ? { range: [12, 13], short: x, trumps: 4 } : null
  }
  if (o[1] === b.voidSplinter) {
    const x = o[2] === b.voidAsk ? keyOf(b.voids, o[3]) : undefined
    return o.length === 4 && x ? { range: [12, 13], short: x, void: true, trumps: 4 } : null
  }
  if (raise < 0 || o[2] !== b.asks[raise]) return null
  const range = RAISE_RANGES[raise]
  if (o.length === 4) {
    if (raise === 2) {
      const x = keyOf(b.shortLow, o[3])
      return x ? { range, short: x, trumps: 4 } : o[3] === b.noneLow ? { range, trumps: 4 } : null
    }
    const x = keyOf(b.single, o[3])
    return x ? { range, short: x, trumps: 4 } : o[3] === b.none ? { range, trumps: 4 } : null
  }
  if (o.length === 6 && raise < 2 && o[3] === b.someVoid && o[4] === b.voidAsk) {
    const x = keyOf(b.voids, o[5])
    return x ? { range, short: x, void: true, trumps: 4 } : null
  }
  return null
}

/** Ask which void when the slam is there with the void in the suit I waste least in */
function voidWorthAsking(h: Hand, m: Suit, range: Range): boolean {
  const best = Math.max(...ORDER.filter((x) => x !== m).map((x) => outside(h, x, true)))
  return best + middle(range) >= slamNeeds(h.len[m] + 4, 'void')
}

/** A control to cue-bid below game in the major (an ace or a void), not in partner's short suit */
function control(h: Hand, ctx: Ctx, m: Suit, short: Suit): Call | null {
  for (const x of ORDER) {
    if (x === m || x === short || (h.len[x] > 0 && !h.ranks[x].includes('A'))) continue
    const call = cheapest(ctx, x)
    if (call && bidIndex(call) < bidIndex(bid(4, m))) return call
  }
  return null
}

function bergenCaptain(m: 'S' | 'H'): Book[] {
  const b = BERGEN[m]
  const partner = (ctx: Ctx) => bergenPartner(ctx, m)
  const asked = (ctx: Ctx) => {
    const o = ours(ctx)
    const raise = b.raises.indexOf(o[1] as never)
    return (raise >= 0 && raise < 2 && o.length === 4 && o[2] === b.asks[raise] && o[3] === b.someVoid) || (o.length === 2 && o[1] === b.voidSplinter)
  }
  const voidAsk: Rule = rule(
    (ctx) => (asked(ctx) ? b.voidAsk : null),
    { name: 'ask', artificial: true, forcing: 'oneRound', notes: [{ key: 'asksShortness' }] },
    (h, ctx) => voidWorthAsking(h, m, ours(ctx).length === 2 ? [12, 13] : RAISE_RANGES[b.raises.indexOf(ours(ctx)[1] as never)]),
  )
  // A splinter with a hand in between: cue-bid a control below game (控制叫)
  const splinterShort = (ctx: Ctx) => {
    const p = partner(ctx)
    return p && ours(ctx).length === 2 && !p.void ? p.short : undefined
  }
  const controlBids: Rule[] = ORDER.filter((x) => x !== m).map((x) =>
    rule(
      (ctx) => {
        const call = cheapest(ctx, x)
        return splinterShort(ctx) && x !== splinterShort(ctx) && call && bidIndex(call) < bidIndex(bid(4, m)) ? call : null
      },
      { name: 'cue', notes: [{ key: 'control', strain: x }, { key: 'slamInterest' }] },
      (h, ctx) => {
        const margin = slamMargin(h, m, partner(ctx)!)
        return margin < 0 && margin >= -3 && control(h, ctx, m, splinterShort(ctx)!) === cheapest(ctx, x)
      },
    ),
  )
  return [
    {
      after: [...b.raises.slice(0, 2).map((raise, i) => `1${m} (P) ${raise} (P) ${b.asks[i]} (P) ${b.someVoid} (P)`), `1${m} (P) ${b.voidSplinter} (P)`],
      only: asked,
      rules: [voidAsk, rule(bid(4, m), { notes: [{ key: 'signoff' }] })],
    },
    {
      only: (ctx) => ctx.opening?.role === 'me' && ctx.turns.at(-1)?.call === 'P' && !!partner(ctx),
      more: true,
      rules: captain(m, partner, false, controlBids),
    },
  ]
}

/** Responder after opener's control bid over the splinter: RKCB with a maximum, otherwise game */
function splinterResponder(m: 'S' | 'H'): Book {
  const b = BERGEN[m]
  const splintered = (ctx: Ctx) => !!keyOf(b.splinters, ours(ctx)[1])
  return {
    after: `1${m} (P) * (P) * (P)`,
    only: (ctx) => ours(ctx)[0] === bid(1, m) && splintered(ctx) && ctx.said.partner?.name === 'cue',
    rules: [rule('4N', () => rkcb(m), (h) => h.hcp >= 13 || h.adjusted >= 14), rule(bid(4, m), { notes: [{ key: 'signoff' }] })],
  }
}

/** Responder leaves the slam to opener after a Bergen raise or a splinter: pass game */
const bergenResponderPasses: Book = {
  only: (ctx) => {
    if (ctx.opening?.role !== 'partner' || ctx.turns.at(-1)?.call !== 'P') return false
    const o = ours(ctx)
    return MAJORS.some((m) => {
      const b = BERGEN[m as 'S' | 'H']
      const raised = (b.raises as Call[]).includes(o[1]) || !!keyOf(b.splinters, o[1]) || o[1] === b.voidSplinter
      return o[0] === bid(1, m) && raised && o.length >= 3 && (lastOf(ctx, 'partner') === bid(4, m) || lastOf(ctx, 'partner') === bid(5, m))
    })
  },
  rules: [rule('P')],
}

export const majorSlam: Book[] = [
  ...(['S', 'H'] as const).flatMap((m) => [j2nAnswers(m), relayAnswers(m), ...j2nCaptain(m), ...bergenAsks(m), ...bergenAnswers(m), ...bergenCaptain(m), splinterResponder(m)]),
  openerPasses,
  bergenResponderPasses,
]
