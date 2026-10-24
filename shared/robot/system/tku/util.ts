import { isBid, levelOf, strainOf, type Call } from '../../../auction.ts'
import { rankOf, SUITS, type Strain, type Suit } from '../../../cards.ts'
import { stopper as holds, suitCards } from '../../hand.ts'
import { cheapest, type Ctx } from '../context.ts'
import type { Hand } from '../evaluate.ts'
import { ANY, fromLevel, type Dynamic, type Note, type Range, type Rule, type Spec } from '../spec.ts'

/**
 * Helpers the club's books share. The club's system is a first-fit system (`System.firstFit`): in
 * each book the rules keep the order of the handbook's decisions, `when` is everything the hand
 * must have, and `shows` is what the call tells partner (the alert, the bidding box hints and what
 * the other robots read from it).
 */

export const MAJORS: readonly Suit[] = ['S', 'H']
/** Suits from the bottom: ♣ ♦ ♥ ♠ */
export const ORDER: readonly Suit[] = ['C', 'D', 'H', 'S']

export const bid = (level: number, strain: Strain): Call => `${level}${strain}`
export const isSuit = (strain: Strain | undefined): strain is Suit => !!strain && strain !== 'N'
export const isMajor = (s: Strain | undefined): s is Suit => s === 'S' || s === 'H'
/** The other major */
export const other = (major: Suit): Suit => (major === 'S' ? 'H' : 'S')

export const plus = (min: number): Range => [min, ANY]
export const length = (s: Suit, min: number, max = 13): Partial<Record<Suit, Range>> => ({ [s]: [min, max] })

/** A rule: `when` decides (the specification only describes); no `when` always fits */
export const rule = (call: Dynamic<Call | null>, shows?: Dynamic<Spec>, when?: (h: Hand, ctx: Ctx) => boolean): Rule =>
  when ? { call, shows, needs: {}, when } : { call, shows, needs: {} }

/** A call the club's robot never makes here but reads when a person makes it */
export const reads = (call: Call, shows: Spec): Rule => ({ call, shows, needs: {}, when: () => false })

/** Pass, whatever the hand */
export const pass = (shows?: Spec): Rule => rule('P', shows)

/** A convention the beginner robot leaves out (from 大專 up, ROBOT.md §7) */
export const convention = (r: Rule): Rule => fromLevel('college', r)

// ── The hand ─────────────────────────────────────────────────────────────────────────────────

/** The longest suit, majors first on ties (♠ ♥ ♦ ♣) */
export const longest = (h: Hand, among: readonly Suit[] = SUITS): Suit =>
  [...among].sort((a, b) => h.len[b] - h.len[a] || SUITS.indexOf(a) - SUITS.indexOf(b))[0]

/** A, Kx, Qxx or Jxxx */
export const stopper = (h: Hand, s: Suit) => holds(h.cards, s)

/** Support points: high cards plus shortness, used with four-card support (Bergen counts 牌值) */
export function supportPoints(h: Hand, trump: Suit) {
  let points = h.hcp
  for (const s of ORDER) if (s !== trump) points += h.len[s] === 0 ? 3 : h.len[s] === 1 ? 2 : h.len[s] === 2 ? 1 : 0
  return points
}

/** The first side suit (from ♣ up) with at most one card */
export const shortSuit = (h: Hand, trump: Suit): Suit | null => ORDER.find((s) => s !== trump && h.len[s] <= 1) ?? null

/** Whether one of the top two cards of a suit is the ace, king or queen */
export const topHonour = (h: Hand, s: Suit) => suitCards(h.cards, s).slice(0, 2).some((c) => 'AKQ'.includes(rankOf(c)))

/** Aces and kings in a suit */
export const aceKings = (h: Hand, s: Suit) => suitCards(h.cards, s).filter((c) => 'AK'.includes(rankOf(c))).length

/** The longest suit of five or more besides `not`, the lowest of equal ones (♣ first) */
export const fiveCard = (h: Hand, not: readonly (Strain | undefined)[], min = 5): Suit | undefined =>
  ORDER.filter((s) => !not.includes(s) && h.len[s] >= min).sort((a, b) => h.len[b] - h.len[a])[0]

// ── The auction ──────────────────────────────────────────────────────────────────────────────

/** Our side's calls from the opening bid on, passes included */
export const ours = (ctx: Ctx): Call[] => ctx.turns.filter((t) => t.ours).map((t) => t.call)

/** The opponents of the opening side made a call other than pass after the opening */
export const contested = (ctx: Ctx) => !!ctx.opening && ctx.turns.some((t) => t.ours !== ctx.opening!.ours && t.call !== 'P')

/** The first call other than pass by the opening side's opponents */
export const overcallOf = (ctx: Ctx): Call | undefined =>
  ctx.opening ? ctx.turns.find((t) => t.ours !== ctx.opening!.ours && t.call !== 'P')?.call : undefined

/** The suit of that call, when it is a suit bid */
export function overcallSuit(ctx: Ctx): Suit | null {
  const call = overcallOf(ctx)
  const s = call && isBid(call) ? strainOf(call) : undefined
  return isSuit(s) ? s : null
}

export const partnerOpened = (ctx: Ctx) => ctx.opening?.role === 'partner'
export const iOpened = (ctx: Ctx) => ctx.opening?.role === 'me'
export const theyOpened = (ctx: Ctx) => !!ctx.opening && !ctx.opening.ours

/** The opening bid */
export const opened = (ctx: Ctx): Call => ctx.opening!.call

/** The cheapest bid in a strain, or pass when there is none */
export const cheapestOr = (ctx: Ctx, strain: Strain, otherwise: Call = 'P'): Call => cheapest(ctx, strain) ?? otherwise

/** Non-pass calls by a player, in the whole auction */
export const actions = (ctx: Ctx, role: 'me' | 'partner'): Call[] => ctx.turns.filter((t) => t.role === role && t.call !== 'P').map((t) => t.call)

// ── What a natural call shows ────────────────────────────────────────────────────────────────

const isGame = (strain: Strain, level: number) => (strain === 'N' && level >= 3) || (isMajor(strain) && level >= 4) || level >= 5

/** The fewest cards a player has shown in a suit */
export const shownLength = (spec: Spec, s: Suit) => spec.len?.[s]?.[0] ?? 0

/**
 * What a natural call shows when no rule says more (later rounds, the fallback): support for
 * partner's suit (three cards), one more card in a suit we bid before, otherwise four; our points
 * so far; game or slam
 */
export function natural(ctx: Ctx, call: Call): Spec {
  if (call === 'X') return { name: 'penalty' }
  if (!isBid(call)) return {}
  const strain = strainOf(call)
  const level = levelOf(call)
  const spec: Spec = {}
  const notes: Note[] = []
  if (!isSuit(strain)) notes.push({ key: 'notrump' })
  else {
    const bidBy = (role: 'me' | 'partner') => ctx.turns.some((t) => t.role === role && isBid(t.call) && strainOf(t.call) === strain)
    const known = shownLength(ctx.shown.me, strain)
    const raise = bidBy('partner')
    if (raise) notes.push({ key: 'support', strain })
    spec.len = length(strain, Math.max(known, raise ? 3 : 4, bidBy('me') ? known + 1 : 0))
  }
  if (level >= 6) notes.push({ key: level === 7 ? 'grandSlam' : 'smallSlam' })
  else if (isGame(strain, level)) notes.push({ key: 'game' })
  const hcp = ctx.shown.me.hcp
  if (hcp && (hcp[0] > 0 || hcp[1] < ANY)) spec.hcp = hcp
  if (notes.length) spec.notes = notes
  return spec
}

/** A rule for a natural call, explained by `natural` */
export const plain = (call: Dynamic<Call | null>, when?: (h: Hand, ctx: Ctx) => boolean): Rule =>
  rule(
    call,
    (ctx) => {
      const c = typeof call === 'function' ? call(ctx) : call
      return c ? natural(ctx, c) : {}
    },
    when,
  )

/** The cheapest bid in a strain as a dynamic call */
export const cheapestIn = (strain: Strain) => (ctx: Ctx) => cheapest(ctx, strain)

/** A call only in auctions that pass `test` (elsewhere the rule does not exist) */
export const onlyIf =
  (test: (ctx: Ctx) => boolean, call: Dynamic<Call | null>) =>
  (ctx: Ctx): Call | null =>
    test(ctx) ? (typeof call === 'function' ? call(ctx) : call) : null

/** Partner's answer to our opening (our side's second call) */
export const answer = (ctx: Ctx): Call => ours(ctx)[1]
export const answerIs = (call: Call) => (ctx: Ctx) => answer(ctx) === call
