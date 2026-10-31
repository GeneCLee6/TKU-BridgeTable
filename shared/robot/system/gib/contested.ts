import { bidIndex, isBid, levelOf, strainOf, type Call } from '../../../auction.ts'
import type { Suit } from '../../../cards.ts'
import { cheapest, type Ctx } from '../context.ts'
import type { Hand } from '../evaluate.ts'
import type { Book, Range, Rule, Spec } from '../spec.ts'
import { above, bid, isMajor, isMinor, longest, MAJORS, plus, UP } from './util.ts'

/** When our opening is doubled or overcalled, docs/BBO GIB/gib-2over1.md §8 */

/** Cards needed to raise: three in a major, four in diamonds, five in clubs */
const supportFor = (y: Suit) => (isMajor(y) ? 3 : y === 'D' ? 4 : 5)
const stopped = (h: Hand, s: Suit) => h.stop[s] === 'stop' || h.stop[s] === 'double'

/** The opponents' call `at` turns after the opening, when it is a suit bid */
function theirBid(ctx: Ctx, at: number): { suit: Suit; level: number; call: Call } | null {
  const turn = ctx.turns[at]
  if (!turn || turn.ours || !isBid(turn.call) || strainOf(turn.call) === 'N') return null
  return { suit: strainOf(turn.call) as Suit, level: levelOf(turn.call), call: turn.call }
}

/** What a negative double shows: the unbid majors, or both minors when no major is left */
function negativeSuits(y: Suit, z: Suit): Suit[] {
  const unbid = UP.filter((s) => s !== y && s !== z)
  const majors = unbid.filter(isMajor)
  return majors.length ? majors : unbid.filter(isMinor)
}

function negativeShows(y: Suit, z: Suit, level: number): Spec {
  const suits = negativeSuits(y, z)
  const len: Spec['len'] = {}
  // One major left that we could bid at the one level: the double shows exactly four
  for (const s of suits) len[s] = suits.length === 1 && level === 1 && above(s, z) ? [4, 4] : [4, 13]
  return { name: 'negative', len, hcp: plus(level === 1 ? 6 : level === 2 ? 8 : 10), forcing: 'oneRound' }
}

const raiseRules = (y: Suit, cueFor: (ctx: Ctx) => Call | null): Rule[] => {
  const n = supportFor(y)
  const raise = (extra: number) => (ctx: Ctx) => {
    const base = cheapest(ctx, y)
    if (!base) return null
    const level = levelOf(base) + extra
    return level <= 4 ? bid(level, y) : null
  }
  const rules: Rule[] = [{ call: cueFor, shows: { name: 'cueRaise', len: { [y]: [n, 13] }, tp: plus(10), forcing: 'oneRound', artificial: true } }]
  if (isMajor(y))
    rules.push(
      { call: bid(4, y), shows: { name: 'preemptiveRaise', len: { [y]: [5, 13] }, hcp: [0, 9] }, when: (h) => h.shape[3] <= 1 || h.len[y] >= 6 },
      { call: bid(4, y), shows: { len: { [y]: [4, 13] }, tp: plus(13), notes: [{ key: 'game' }] } },
    )
  rules.push(
    { call: raise(1), shows: { name: 'preemptiveRaise', len: { [y]: [n + 1, 13] }, hcp: [0, 9] } },
    { call: raise(0), shows: { len: { [y]: [n, 13] }, tp: [6, 10] } },
  )
  return rules
}

// ── Responder after an overcall ──────────────────────────────────────────────────────────────

function afterOvercall(y: Suit): Rule[] {
  const z = (ctx: Ctx) => theirBid(ctx, 1)
  const rules: Rule[] = raiseRules(y, (ctx) => {
    const theirs = z(ctx)
    return theirs ? cheapest(ctx, theirs.suit) : null
  })
  // A new suit, forcing: at the two or three level 5+ and 10+ (before the double), at the one
  // level 4+. The three-level bid is the cheapest one over a two-level overcall (1♣ (2♥) 3♦);
  // without it TKB passed with a long minor and opening values (V4a)
  const newSuit = (s: Suit, level: 1 | 2 | 3): Rule => ({
    call: (ctx) => {
      const theirs = z(ctx)
      if (!theirs || theirs.suit === s) return null
      const call = cheapest(ctx, s)
      return call && levelOf(call) === level ? call : null
    },
    shows: level === 1 ? { len: { [s]: [4, 13] }, hcp: plus(6), forcing: 'oneRound' } : { len: { [s]: [5, 13] }, hcp: plus(10), forcing: 'oneRound' },
    when: (h) => longest(h, UP.filter((t) => t !== y)) === s,
  })
  for (const s of UP.filter((s) => s !== y)) rules.push(newSuit(s, 2), newSuit(s, 3))
  // Negative double up to 3♠
  rules.push({
    call: (ctx) => {
      const theirs = z(ctx)
      return theirs && bidIndex(theirs.call) <= bidIndex('3S') ? 'X' : null
    },
    shows: (ctx) => {
      const theirs = z(ctx)!
      return negativeShows(y, theirs.suit, theirs.level)
    },
  })
  for (const s of UP.filter((s) => s !== y)) rules.push(newSuit(s, 1))
  // Notrump with their suit stopped; 3NT has no top (TKB passed 1♦ (2♠) with AJ92 A85 A93 AT8, V4a)
  const nt = (level: number, hcp: Range): Rule => ({
    call: (ctx) => {
      const theirs = z(ctx)
      const call = cheapest(ctx, 'N')
      return theirs && call && levelOf(call) <= level ? bid(level, 'N') : null
    },
    shows: (ctx) => ({ hcp, stop: { [z(ctx)!.suit]: 'stop' } }),
  })
  rules.push(nt(3, plus(13)), nt(2, [11, 12]), nt(1, [8, 10]), { call: 'P', shows: {} })
  return rules
}

// ── Responder after a double (Truscott 2NT) ──────────────────────────────────────────────────

function afterDouble(y: Suit): Rule[] {
  const n = supportFor(y)
  const rules: Rule[] = [
    { call: 'XX', shows: { hcp: plus(10), len: { [y]: [0, n - 1] } } },
    { call: '2N', shows: { name: 'truscott', len: { [y]: [n, 13] }, tp: plus(10), forcing: 'oneRound', artificial: true } },
  ]
  if (isMajor(y))
    rules.push({ call: bid(4, y), shows: { name: 'preemptiveRaise', len: { [y]: [5, 13] }, hcp: [0, 9] }, when: (h) => h.shape[3] <= 1 || h.len[y] >= 6 })
  rules.push(
    { call: bid(3, y), shows: { name: 'preemptiveRaise', len: { [y]: [n + 1, 13] }, hcp: [0, 9] } },
    { call: bid(2, y), shows: { len: { [y]: [n, 13] }, tp: [6, 9] } },
  )
  for (const s of UP.filter((s) => s !== y)) {
    const level = above(s, y) ? 1 : 2
    rules.push(
      level === 1
        ? { call: bid(1, s), shows: { len: { [s]: [4, 13] }, hcp: plus(6), forcing: 'oneRound' }, when: (h) => longest(h, UP.filter((t) => t !== y)) === s }
        : { call: bid(2, s), shows: { len: { [s]: [5, 13] }, hcp: [5, 9], notes: [{ key: 'toPlay' }] }, when: (h) => longest(h, UP.filter((t) => t !== y)) === s },
    )
  }
  rules.push({ call: '1N', shows: { hcp: [7, 9] } }, { call: 'P', shows: {} })
  return rules
}

// ── Unusual vs. Unusual ──────────────────────────────────────────────────────────────────────

function unusualVsUnusual(y: Suit): Rule[] {
  const [low, high] = UP.filter((s) => s !== y)
  const fourth = UP.find((s) => s !== y && s !== low && s !== high)!
  const n = supportFor(y)
  const rules: Rule[] = [
    { call: bid(3, low), shows: { name: 'unusualVsUnusual', len: { [y]: [n, 13] }, tp: plus(10), forcing: 'oneRound', artificial: true } },
    { call: bid(3, high), shows: { name: 'unusualVsUnusual', len: { [fourth]: [5, 13] }, hcp: plus(12), forcing: 'game', artificial: true } },
  ]
  if (isMajor(y))
    rules.push(
      { call: bid(4, y), shows: { name: 'preemptiveRaise', len: { [y]: [4, 13] }, hcp: [0, 9] }, when: (h) => h.shape[3] <= 1 },
      { call: bid(4, y), shows: { len: { [y]: [3, 13] }, tp: plus(13), notes: [{ key: 'game' }] } },
    )
  rules.push(
    { call: bid(3, y), shows: { len: { [y]: [n, 13] }, tp: [6, 9] } },
    { call: bid(3, fourth), shows: { len: { [fourth]: [5, 13] }, hcp: [8, 11] }, when: () => above(fourth, high) },
    { call: 'X', shows: { name: 'penalty', hcp: plus(10) }, when: (h) => h.len[low] >= 4 || h.len[high] >= 4 },
    { call: 'P', shows: {} },
  )
  return rules
}

// ── Opener's rebid after a negative double, and the support double ───────────────────────────

function afterNegative(y: Suit): Rule[] {
  const z = (ctx: Ctx) => theirBid(ctx, 1)
  const rules: Rule[] = []
  for (const M of MAJORS.filter((M) => M !== y)) {
    const jumpOrNot = (extra: number) => (ctx: Ctx) => {
      const theirs = z(ctx)
      if (!theirs || theirs.suit === M) return null
      const base = cheapest(ctx, M)
      return base ? bid(levelOf(base) + extra, M) : null
    }
    rules.push(
      { call: jumpOrNot(1), shows: { len: { [M]: [4, 13] }, hcp: [15, 17], notes: [{ key: 'invite' }] } },
      { call: jumpOrNot(0), shows: { len: { [M]: [4, 13] }, hcp: [11, 14] } },
    )
  }
  rules.push(
    {
      call: (ctx) => {
        const call = cheapest(ctx, 'N')
        return call && levelOf(call) <= 2 ? call : null
      },
      shows: (ctx) => ({ hcp: [11, 14], stop: { [z(ctx)!.suit]: 'stop' } }),
    },
    { call: (ctx) => cheapest(ctx, y), shows: { len: { [y]: [isMajor(y) ? 6 : 5, 13] }, hcp: [11, 16] } },
    {
      call: 'P',
      shows: (ctx) => ({ name: 'penalty', len: { [z(ctx)!.suit]: [4, 13] } }),
      when: (h, ctx) => {
        const theirs = z(ctx)!
        return h.len[theirs.suit] >= 4 && stopped(h, theirs.suit)
      },
    },
  )
  return rules
}

/** Opener's support double: exactly three cards in responder's suit (GIB may use it with Kx) */
function supportDouble(y: Suit): Rule[] {
  return [
    {
      call: 'X',
      shows: { name: 'support', len: { [y]: [2, 3] }, forcing: 'oneRound' },
      when: (h) => h.len[y] === 3 || (h.len[y] === 2 && /^[AK]/.test(h.ranks[y])),
    },
    { call: (ctx) => cheapest(ctx, y), shows: { len: { [y]: [4, 13] } }, when: (h) => h.len[y] >= 4 },
  ]
}

// ── Opener's reopening double and responder's answer (W3) ────────────────────────────────────

/**
 * The overcall was passed round to opener (1♦ (2♠) P (P)): short in their suit with extra values,
 * double for takeout (迫伴賭倍; the club's president, 2026-10-31). Partner may have passed with
 * their suit (a negative double would have been for takeout), so the double lets partner pass it
 * for penalty. Extra values by how short (chosen by measurement, ROBOT.md §6.11): 14+ high-card
 * points with a doubleton in their suit, 13+ with a singleton, 12+ with a void; no seven-card suit.
 */
const REOPEN_POINTS = [12, 13, 14]

function reopeningDouble(): Rule[] {
  const z = (ctx: Ctx) => theirBid(ctx, 1)!
  return [
    {
      call: 'X',
      shows: (ctx) => ({ name: 'takeout', len: { [z(ctx).suit]: [0, 2] }, hcp: plus(REOPEN_POINTS[0]), forcing: 'oneRound' }),
      when: (h, ctx) => {
        const n = h.len[z(ctx).suit]
        return n <= 2 && h.hcp >= REOPEN_POINTS[n] && h.shape[0] <= 6
      },
    },
  ]
}

/** Partner reopened with a takeout double: pass for penalty with their suit, otherwise bid */
function afterReopening(y: Suit): Rule[] {
  const z = (ctx: Ctx) => theirBid(ctx, 1)!.suit
  const unbid = (ctx: Ctx) => UP.filter((s) => s !== y && s !== z(ctx))
  const nt = (ctx: Ctx) => cheapest(ctx, 'N')
  const best = (h: Hand, ctx: Ctx, s: Suit) => {
    const among = unbid(ctx)
    const majors = among.filter((t) => isMajor(t) && h.len[t] >= 4)
    return (majors.length ? longest(h, majors) : longest(h, among)) === s
  }
  const rules: Rule[] = [
    {
      call: 'P',
      shows: (ctx) => ({ name: 'penalty', len: { [z(ctx)]: [4, 13] } }),
      when: (h, ctx) => h.len[z(ctx)] >= 5 || (h.len[z(ctx)] >= 4 && stopped(h, z(ctx))),
    },
    { call: '3N', shows: (ctx) => ({ hcp: plus(11), stop: { [z(ctx)]: 'stop' } }) },
    {
      call: (ctx) => {
        const call = nt(ctx)
        return call && levelOf(call) <= 2 ? call : null
      },
      shows: (ctx) => ({ hcp: [8, 10], stop: { [z(ctx)]: 'stop' } }),
    },
  ]
  for (const M of MAJORS.filter((M) => M !== y))
    rules.push({
      call: (ctx) => (z(ctx) !== M ? bid(4, M) : null),
      shows: { len: { [M]: [4, 13] }, hcp: plus(9), notes: [{ key: 'game' }] },
      when: (h, ctx) => best(h, ctx, M),
    })
  for (const s of UP.filter((s) => s !== y))
    rules.push({
      call: (ctx) => (z(ctx) !== s ? cheapest(ctx, s) : null),
      shows: { len: { [s]: [4, 13] }, hcp: [0, 8] },
      when: (h, ctx) => best(h, ctx, s) && (isMajor(s) || h.len[s] >= 5 || h.len[y] < 3),
    })
  rules.push({ call: (ctx) => cheapest(ctx, y), shows: { len: { [y]: [2, 13] }, hcp: [0, 8], notes: [{ key: 'preference', strain: y }] } })
  for (const s of UP.filter((s) => s !== y)) rules.push({ call: (ctx) => (z(ctx) !== s ? cheapest(ctx, s) : null), shows: {}, when: (h, ctx) => best(h, ctx, s) })
  return rules
}

/** The overcall at the one or two level was passed round to opener */
const reopeningSeat = (ctx: Ctx) => {
  const theirs = theirBid(ctx, 1)
  return !!theirs && theirs.suit !== strainOf(ctx.turns[0].call) && theirs.level <= 2
}

// ── The books ─────────────────────────────────────────────────────────────────────────────────

const suitOvercall = (at: number) => (ctx: Ctx) => {
  const theirs = theirBid(ctx, at)
  return !!theirs && theirs.suit !== strainOf(ctx.turns[0].call)
}

const books: Book[] = []
for (const y of UP) {
  books.push(
    { after: `1${y} (X)`, rules: afterDouble(y), more: true },
    { after: `1${y} (2N)`, rules: unusualVsUnusual(y), more: true },
    { after: `1${y} (1N)`, rules: [{ call: 'X', shows: { name: 'penalty', hcp: plus(9) } }], more: true },
    { after: `1${y} (+)`, only: suitOvercall(1), rules: afterOvercall(y), more: true },
    { after: `1${y} (+) X (P)`, only: suitOvercall(1), rules: afterNegative(y), more: true },
    { after: `1${y} (+) P (P)`, only: reopeningSeat, rules: reopeningDouble(), more: true },
    { after: `1${y} (+) P (P) X (P)`, only: reopeningSeat, rules: afterReopening(y), more: true },
  )
  // Support doubles up to 2♥, after a one-level response
  for (const r of UP.filter((r) => above(r, y)))
    books.push({
      after: `1${y} (P) 1${r} (+)`,
      only: (ctx) => {
        const theirs = theirBid(ctx, 3)
        return !!theirs && theirs.suit !== r && bidIndex(theirs.call) <= bidIndex('2H')
      },
      rules: supportDouble(r),
      more: true,
    })
}

export const contested: readonly Book[] = books
