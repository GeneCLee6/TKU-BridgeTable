import { levelOf, strainOf } from '../../../auction.ts'
import type { Strain, Suit } from '../../../cards.ts'
import { cheapest, jump, type Ctx } from '../context.ts'
import type { Hand } from '../evaluate.ts'
import { ANY, type Book, type Rule, type Spec } from '../spec.ts'
import {
  actions,
  bid,
  cheapestIn,
  isMajor,
  isSuit,
  length,
  longest,
  MAJORS,
  onlyIf,
  opened,
  ORDER,
  other,
  pass,
  plus,
  rule,
  shownLength,
  stopper,
  theyOpened,
  topThree,
} from './util.ts'

/**
 * The opponents opened and our side has only passed (淡江橋譜「競叫篇與技光」蓋叫、平衡叫、如何對抗技光,
 * 「賭倍性叫品」迫伴賭倍, 「開叫1NT/2NT」敵方開叫1NT後的防禦叫（CAPP）; 5542 自然制 where the handbook is
 * silent): overcalls, weak jump overcalls, Michaels, the Unusual 2NT, 1NT and the takeout double
 * over one of a suit (e5-t30); the same in the pass-out seat (平衡叫); Cappelletti over 1NT
 * (e5-t38); against weak twos and preempts (e5-t34); competing again when the opponents stop in
 * two of their agreed suit (再平衡, e5-t33).
 */

// ── The auction ──────────────────────────────────────────────────────────────────────────────

/** Our side has made no call but pass */
export const silent = (ctx: Ctx) => theyOpened(ctx) && actions(ctx, 'me').length === 0 && actions(ctx, 'partner').length === 0

/** Their opening strain */
export const theirOpening = (ctx: Ctx): Strain => strainOf(opened(ctx))
const lastLevel = (ctx: Ctx) => levelOf(ctx.last!.call)

/** Right after the opening */
const direct = (ctx: Ctx) => ctx.turns.length === 1
/** The opening passed round to us (1♥ P P ?): the pass-out seat */
export const reopening = (ctx: Ctx) => ctx.turns.length === 3 && ctx.turns[1].call === 'P' && ctx.turns[2].call === 'P'

/** What the opening is, as our side reads it */
export type OpeningKind = 'one' | 'notrump' | 'weak' | 'oneMajor' | 'three' | 'four' | 'other'

export function openingKind(ctx: Ctx): OpeningKind {
  const call = opened(ctx)
  const level = levelOf(call)
  const s = strainOf(call)
  if (call === '1N') return 'notrump'
  if (level === 1) return 'one'
  const spec = ctx.shown[ctx.opening!.role]
  const weak = (spec.hcp?.[1] ?? ANY) <= 12
  if (!weak || !isSuit(s)) return 'other'
  if (level === 2) return s === 'C' ? 'other' : s === 'D' && shownLength(spec, 'D') < 5 ? 'oneMajor' : 'weak'
  return level === 3 ? 'three' : 'four'
}

/** Suits other than theirs */
const unbid = (ctx: Ctx) => ORDER.filter((s) => s !== theirOpening(ctx))

// ── The hand ─────────────────────────────────────────────────────────────────────────────────

/** A suit to bid at the two level or higher: two of the top three honours, or six cards with one */
const goodSuit = (h: Hand, s: Suit) => topThree(h, s) >= 2 || (h.len[s] >= 6 && topThree(h, s) >= 1)

/**
 * Takeout shape (迫伴賭倍「牌型要對」): at most two cards in their suit, three or more in every other
 * suit, and four in an unbid major unless the hand is good (「除非持很好的牌，否則未叫高花要有長度」)
 */
function takeoutShape(h: Hand, ctx: Ctx, good = 15): boolean {
  const o = theirOpening(ctx)
  if (!isSuit(o) || h.len[o] > 2 || !unbid(ctx).every((s) => h.len[s] >= 3)) return false
  return h.hcp >= good || MAJORS.some((s) => s !== o && h.len[s] >= 4)
}

const takeoutSpec = (min: number) => (ctx: Ctx): Spec => {
  const o = theirOpening(ctx)
  const len: Spec['len'] = {}
  if (isSuit(o)) for (const s of ORDER) len[s] = s === o ? [0, 2] : [3, 13]
  return { name: 'takeout', len, hcp: plus(min) }
}

/** Strong enough to double first and bid again (強力型) */
const strongDouble = (min: number): Rule => rule('X', { name: 'takeout', hcp: plus(min) }, (h, ctx) => h.hcp >= min && ctx.legal.has('X'))

// ── Over one of a suit (e5-t30) ──────────────────────────────────────────────────────────────

/** Unusual 2NT: both minors 5-5 over a major, 8–10 vulnerable, 6–8 not (如何對抗弱跳叫2NT兩低) */
const unusual2N: Rule = rule(
  onlyIf((ctx) => (opened(ctx) === '1H' || opened(ctx) === '1S') && ctx.last === ctx.opening, '2N'),
  (ctx) => ({ name: 'unusual2N', len: { D: [5, 13], C: [5, 13] }, hcp: ctx.weVul ? [8, 10] : [6, 8], notes: [{ key: 'bothMinors' }] }),
  (h, ctx) => {
    const [lo, hi] = ctx.weVul ? [8, 10] : [6, 8]
    return h.len.C >= 5 && h.len.D >= 5 && h.hcp >= lo && h.hcp <= hi
  },
)

/** Michaels points: as an overcall, from 8 vulnerable and 6 not (5542 自然制; the handbook has no Michaels) */
const michaelsPoints = (ctx: Ctx): readonly [number, number] => [ctx.weVul ? 8 : 6, 15]

/** Michaels: two of their suit, both majors over a minor, the other major and a minor over a major */
const michaels: Rule = rule(
  onlyIf((ctx) => isSuit(theirOpening(ctx)), (ctx) => (cheapest(ctx, theirOpening(ctx)) === bid(2, theirOpening(ctx)) ? bid(2, theirOpening(ctx)) : null)),
  (ctx): Spec => {
    const o = theirOpening(ctx) as Suit
    return isMajor(o)
      ? { name: 'michaels', len: length(other(o), 5), hcp: michaelsPoints(ctx), notes: [{ key: 'withMinor' }] }
      : { name: 'michaels', len: { S: [5, 13], H: [5, 13] }, hcp: michaelsPoints(ctx), notes: [{ key: 'bothMajors' }] }
  },
  (h, ctx) => {
    const o = theirOpening(ctx) as Suit
    const [lo, hi] = michaelsPoints(ctx)
    if (h.hcp < lo || h.hcp > hi) return false
    return isMajor(o) ? h.len[other(o)] >= 5 && (h.len.C >= 5 || h.len.D >= 5) : h.len.S >= 5 && h.len.H >= 5
  },
)

/** 1NT overcall 15–18 with their suit stopped (蓋叫 1NT「視同1NT開叫」; the handbook's 16–18 待確認) */
const notrumpOvercall: Rule = rule(
  onlyIf((ctx) => lastLevel(ctx) === 1 && isSuit(theirOpening(ctx)), '1N'),
  (ctx) => ({ hcp: [15, 18], balanced: true, stop: { [theirOpening(ctx)]: 'stop' } }),
  (h, ctx) => h.balanced && h.hcp >= 15 && h.hcp <= 18 && stopper(h, theirOpening(ctx) as Suit),
)

/** A jump overcall is a weak two (蓋叫「2H/S 視同WEAK TWO」): six cards at the two level, seven at three */
const weakJumps: Rule[] = ORDER.map((x) =>
  rule(
    onlyIf((ctx) => x !== theirOpening(ctx), (ctx) => jump(ctx, x)),
    (ctx) => ({ name: 'weakJumpOvercall', len: length(x, levelOf(jump(ctx, x)!) === 2 ? 6 : 7), hcp: [5, 10] }),
    (h, ctx) => {
      const level = levelOf(jump(ctx, x)!)
      return (
        level <= 3 &&
        longest(h, unbid(ctx)) === x &&
        h.len[x] >= (level === 2 ? 6 : 7) &&
        h.hcp >= 5 &&
        h.hcp <= 10 &&
        (!ctx.weVul || topThree(h, x) >= 1)
      )
    },
  ),
)

/** A suit overcall (蓋叫「8-15點，5張↑牌組」): 8–15 at the one level, 10–15 with a good suit at the two level */
const suitOvercalls: Rule[] = ORDER.map((x) =>
  rule(
    onlyIf((ctx) => x !== theirOpening(ctx), cheapestIn(x)),
    (ctx) => ({ name: 'overcall', len: length(x, 5), hcp: levelOf(cheapest(ctx, x) ?? '2C') === 1 ? [8, 15] : [10, 15] }),
    (h, ctx) => {
      const call = cheapest(ctx, x)
      if (!call || levelOf(call) > 2 || longest(h, unbid(ctx)) !== x || h.len[x] < 5 || h.hcp > 15) return false
      return levelOf(call) === 1 ? h.hcp >= 8 : h.hcp >= 10 && goodSuit(h, x)
    },
  ),
)

const overOne: Book = {
  only: (ctx) => silent(ctx) && direct(ctx) && openingKind(ctx) === 'one',
  rules: [
    unusual2N,
    michaels,
    notrumpOvercall,
    strongDouble(16),
    ...weakJumps,
    ...suitOvercalls,
    // 迫伴賭倍「11點↑」: the general type
    rule('X', takeoutSpec(11), (h, ctx) => h.hcp >= 11 && takeoutShape(h, ctx)),
    pass(),
  ],
}

// ── The pass-out seat (平衡叫) ────────────────────────────────────────────────────────────────

/** 1♥ P P ?: 1NT 12–15, a jump 13–15 with six, double 11+, a suit 6–10 (the handbook's table over 1♥) */
const reopen: Book = {
  only: (ctx) => silent(ctx) && reopening(ctx) && openingKind(ctx) === 'one',
  rules: [
    rule('1N', (ctx) => ({ hcp: [12, 15], balanced: true, stop: { [theirOpening(ctx)]: 'stop' } }), (h, ctx) => h.balanced && h.hcp >= 12 && h.hcp <= 15 && stopper(h, theirOpening(ctx) as Suit)),
    ...ORDER.map((x) =>
      rule(
        onlyIf((ctx) => x !== theirOpening(ctx), (ctx) => jump(ctx, x)),
        { len: length(x, 6), hcp: [13, 15] },
        (h, ctx) => longest(h, unbid(ctx)) === x && h.len[x] >= 6 && h.hcp >= 13 && h.hcp <= 15 && levelOf(jump(ctx, x)!) <= 3,
      ),
    ),
    rule('X', (ctx) => ({ name: 'takeout', len: { [theirOpening(ctx)]: [0, 3] }, hcp: plus(11) }), (h, ctx) => h.hcp >= 11 && h.len[theirOpening(ctx) as Suit] <= 3),
    ...ORDER.map((x) =>
      rule(
        onlyIf((ctx) => x !== theirOpening(ctx), cheapestIn(x)),
        (ctx) => ({ len: length(x, levelOf(cheapest(ctx, x)!) === 1 ? 4 : 5), hcp: [6, 10] }),
        (h, ctx) => {
          const call = cheapest(ctx, x)
          return !!call && levelOf(call) <= 2 && longest(h, unbid(ctx)) === x && h.len[x] >= (levelOf(call) === 1 ? 4 : 5) && h.hcp >= 6
        },
      ),
    ),
    pass(),
  ],
}

// ── Over 1NT: Cappelletti (e5-t38) ───────────────────────────────────────────────────────────

/** Points for a Cappelletti two-level call: from 8, from 10 vulnerable, up to 14 (15+ doubles) */
const cappPoints = (ctx: Ctx): readonly [number, number] => [ctx.weVul ? 10 : 8, 14]
const capp = (h: Hand, ctx: Ctx) => h.hcp >= cappPoints(ctx)[0] && h.hcp <= cappPoints(ctx)[1]

const overNotrump: Book = {
  only: (ctx) => silent(ctx) && (direct(ctx) || reopening(ctx)) && openingKind(ctx) === 'notrump',
  rules: [
    // 「力量與開叫1NT者相若或更高，強烈暗示處罰」
    rule('X', { name: 'penalty', hcp: plus(15) }, (h) => h.hcp >= 15),
    rule('2N', { name: 'cappelletti', len: { C: [5, 13], D: [5, 13] }, hcp: [10, 13], notes: [{ key: 'bothMinors' }] }, (h) => h.len.C >= 5 && h.len.D >= 5 && h.hcp >= 10 && h.hcp <= 13),
    rule(
      '2D',
      (ctx) => ({ name: 'cappelletti', len: { S: [4, 13], H: [4, 13] }, hcp: cappPoints(ctx), artificial: true, notes: [{ key: 'bothMajors' }] }),
      (h, ctx) => capp(h, ctx) && h.len.S >= 4 && h.len.H >= 4 && (h.len.S >= 5 || h.len.H >= 5),
    ),
    ...MAJORS.map((m) =>
      rule(
        bid(2, m),
        (ctx) => ({ name: 'cappelletti', len: length(m, 5), hcp: cappPoints(ctx), notes: [{ key: 'withMinor' }] }),
        (h, ctx) => capp(h, ctx) && h.len[m] >= 5 && (h.len.C >= 4 || h.len.D >= 4),
      ),
    ),
    rule(
      '2C',
      (ctx) => ({ name: 'cappelletti', hcp: cappPoints(ctx), artificial: true, notes: [{ key: 'oneSuiter' }, { key: 'relayTo', calls: ['2D'] }] }),
      (h, ctx) => capp(h, ctx) && ORDER.some((s) => h.len[s] >= 6),
    ),
    pass(),
  ],
}

// ── Against weak twos and preempts (e5-t34) ──────────────────────────────────────────────────

/** A natural suit bid over a preempt: a good five-card suit up to the three level from `min` points, a good six at the four level from 15 (17+ doubles first) */
function preemptOvercall(x: Suit, min: number): Rule {
  const high = (ctx: Ctx) => levelOf(cheapest(ctx, x)!) === 4
  return rule(
    onlyIf((ctx) => x !== theirOpening(ctx), cheapestIn(x)),
    (ctx) => ({ len: length(x, high(ctx) ? 6 : 5), hcp: [high(ctx) ? 15 : min, 16] }),
    (h, ctx) => {
      const call = cheapest(ctx, x)
      if (!call || levelOf(call) > 4 || longest(h, unbid(ctx)) !== x || !goodSuit(h, x)) return false
      return high(ctx) ? h.len[x] >= 6 && h.hcp >= 15 : h.len[x] >= 5 && h.hcp >= min
    },
  )
}

/**
 * A light suit bid over a preempt in the direct seat (社長 2026-10-27, from the bidding study): 8–11
 * points, the longest suit, five cards not vulnerable up to the four level, six vulnerable up to the
 * three level. Over the 一高弱二 2♦ any suit may be bid (`anySuit`), diamonds included.
 */
function lightOvercall(x: Suit, anySuit = false): Rule {
  const minLength = (ctx: Ctx) => (ctx.weVul ? 6 : 5)
  return rule(
    onlyIf((ctx) => direct(ctx) && (anySuit || x !== theirOpening(ctx)), cheapestIn(x)),
    (ctx) => ({ len: length(x, minLength(ctx)), hcp: [8, 11] }),
    (h, ctx) => {
      const call = cheapest(ctx, x)
      if (!call || levelOf(call) > (ctx.weVul ? 3 : 4)) return false
      return longest(h, anySuit ? undefined : unbid(ctx)) === x && h.len[x] >= minLength(ctx) && h.hcp >= 8 && h.hcp <= 11
    },
  )
}

const theirStop = (ctx: Ctx) => (isSuit(theirOpening(ctx)) ? { stop: { [theirOpening(ctx)]: 'stop' as const } } : {})
const stops = (h: Hand, ctx: Ctx) => isSuit(theirOpening(ctx)) && stopper(h, theirOpening(ctx) as Suit)

/** A natural weak two (2♦ with diamonds, 2♥, 2♠): 對抗技光 for the numbers, from 12 points (待社團確認); lighter in the direct seat */
const overWeakTwo: Book = {
  only: (ctx) => silent(ctx) && (direct(ctx) || reopening(ctx)) && openingKind(ctx) === 'weak',
  rules: [
    rule('2N', (ctx) => ({ hcp: [16, 19], balanced: true, ...theirStop(ctx) }), (h, ctx) => h.balanced && h.hcp >= 16 && h.hcp <= 19 && stops(h, ctx)),
    rule('3N', (ctx) => ({ hcp: plus(20), balanced: true, ...theirStop(ctx) }), (h, ctx) => h.balanced && h.hcp >= 20 && stops(h, ctx)),
    // 「敵方為弱二，我則是強跳叫 16點↑，6張↑」
    ...MAJORS.map((x) =>
      rule(
        onlyIf((ctx) => x !== theirOpening(ctx) && levelOf(jump(ctx, x) ?? '7N') === 3, (ctx) => jump(ctx, x)),
        { len: length(x, 6), hcp: plus(16) },
        (h, ctx) => h.len[x] >= 6 && h.hcp >= 16 && longest(h, unbid(ctx)) === x,
      ),
    ),
    strongDouble(17),
    ...ORDER.map((x) => preemptOvercall(x, 12)),
    ...ORDER.map((x) => lightOvercall(x)),
    rule('X', takeoutSpec(12), (h, ctx) => h.hcp >= 12 && takeoutShape(h, ctx)),
    pass(),
  ],
}

/** 一高弱二 (2♦ with six cards in one major): 對抗技光「2♦」 — 12–15 balanced doubles, 2NT 16–19, 3NT 20+ */
const overOneMajor: Book = {
  only: (ctx) => silent(ctx) && (direct(ctx) || reopening(ctx)) && openingKind(ctx) === 'oneMajor',
  rules: [
    rule('2N', { hcp: [16, 19], balanced: true }, (h) => h.balanced && h.hcp >= 16 && h.hcp <= 19),
    rule('3N', { hcp: plus(20), balanced: true }, (h) => h.balanced && h.hcp >= 20),
    rule('X', { name: 'takeout', hcp: [12, 15], balanced: true }, (h) => h.balanced && h.hcp >= 12 && h.hcp <= 15),
    strongDouble(17),
    ...ORDER.map((x) =>
      rule(
        cheapestIn(x),
        { len: length(x, 5), hcp: [12, 16] },
        (h, ctx) => !!cheapest(ctx, x) && levelOf(cheapest(ctx, x)!) <= 3 && longest(h) === x && h.len[x] >= 5 && h.hcp >= 12 && goodSuit(h, x),
      ),
    ),
    ...ORDER.map((x) => lightOvercall(x, true)),
    pass(),
  ],
}

/** Three of a suit: takeout from 13 (17+ any shape), 3NT 16–21 with a stopper, a good suit from 13 (the four level a good six from 15), 8–11 in the direct seat */
const overThree: Book = {
  only: (ctx) => silent(ctx) && (direct(ctx) || reopening(ctx)) && openingKind(ctx) === 'three',
  rules: [
    rule('3N', (ctx) => ({ hcp: [16, 21], ...theirStop(ctx) }), (h, ctx) => h.hcp >= 16 && h.hcp <= 21 && stops(h, ctx) && h.shape[0] <= 6),
    strongDouble(17),
    ...ORDER.map((x) => preemptOvercall(x, 13)),
    ...ORDER.map((x) => lightOvercall(x)),
    rule('X', takeoutSpec(13), (h, ctx) => h.hcp >= 13 && takeoutShape(h, ctx)),
    pass(),
  ],
}

/** Four of a suit: double shows strength (「X表示力量 處罰」) */
const overFour: Book = {
  only: (ctx) => silent(ctx) && (direct(ctx) || reopening(ctx)) && openingKind(ctx) === 'four',
  rules: [rule('X', { name: 'penalty', hcp: plus(16) }, (h) => h.hcp >= 16), pass()],
}

// ── Competing again (再平衡理論, e5-t33) ──────────────────────────────────────────────────────

/** 1♥ P 2♥ P P ?: they found a fit and stopped at two, so we have one too (總墩數定律) */
const raisedToTwo = (ctx: Ctx) => {
  const [open, , raise, p1, p2] = ctx.turns
  return (
    ctx.turns.length === 5 &&
    levelOf(open.call) === 1 &&
    isSuit(strainOf(open.call)) &&
    raise.call === bid(2, strainOf(open.call)) &&
    ctx.turns[1].call === 'P' &&
    p1.call === 'P' &&
    p2.call === 'P'
  )
}

const balanceRaise: Book = {
  only: (ctx) => silent(ctx) && raisedToTwo(ctx),
  rules: [
    ...ORDER.map((x) =>
      rule(
        onlyIf((ctx) => x !== theirOpening(ctx), cheapestIn(x)),
        { len: length(x, 5), hcp: [8, 15] },
        (h, ctx) => !!cheapest(ctx, x) && levelOf(cheapest(ctx, x)!) <= 3 && longest(h, unbid(ctx)) === x && h.len[x] >= (levelOf(cheapest(ctx, x)!) === 2 ? 5 : 6) && h.hcp >= 8,
      ),
    ),
    // 「X：3或4張」 in the unbid suits
    rule('X', (ctx) => ({ name: 'takeout', len: { [theirOpening(ctx)]: [0, 2] }, hcp: plus(8) }), (h, ctx) => h.hcp >= 8 && h.len[theirOpening(ctx) as Suit] <= 2 && unbid(ctx).every((s) => h.len[s] >= 3)),
    pass(),
  ],
}

// ── Anything else: they opened and bid again, or an artificial opening ─────────────────────────

const overcallPoints = (ctx: Ctx) => (lastLevel(ctx) === 1 ? 8 : lastLevel(ctx) === 2 ? 11 : 15)

const general: Book = {
  only: silent,
  rules: [
    unusual2N,
    rule(
      onlyIf((ctx) => lastLevel(ctx) === 1 && isSuit(theirOpening(ctx)), '1N'),
      (ctx) => ({ hcp: [15, 18], balanced: true, stop: { [theirOpening(ctx)]: 'stop' } }),
      (h, ctx) => h.balanced && h.hcp >= 15 && h.hcp <= 18 && stopper(h, theirOpening(ctx) as Suit),
    ),
    rule('X', takeoutSpec(12), (h, ctx) => h.hcp >= 12 && takeoutShape(h, ctx, 12) && ctx.legal.has('X')),
    ...ORDER.map((x) =>
      rule(
        onlyIf((ctx) => x !== theirOpening(ctx), cheapestIn(x)),
        (ctx) => ({ name: 'overcall', len: length(x, 5), hcp: [overcallPoints(ctx), 18] }),
        (h, ctx) => {
          const call = cheapest(ctx, x)
          return (
            longest(h, unbid(ctx)) === x &&
            h.len[x] >= 5 &&
            h.hcp >= overcallPoints(ctx) &&
            h.hcp <= 18 &&
            !!call &&
            levelOf(call) <= Math.max(2, lastLevel(ctx))
          )
        },
      ),
    ),
    rule('X', { name: 'takeout', hcp: plus(17) }, (h, ctx) => h.hcp >= 17 && ctx.legal.has('X')),
    pass(),
  ],
}

export const overcalls: Book[] = [overNotrump, overOne, reopen, overWeakTwo, overOneMajor, overThree, overFour, balanceRaise, general]
