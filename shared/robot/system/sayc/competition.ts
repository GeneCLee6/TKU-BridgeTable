import { bidIndex, isBid, levelOf, strainOf, type Call } from '../../../auction.ts'
import type { Suit } from '../../../cards.ts'
import { cheapest, type Ctx } from '../context.ts'
import type { Hand } from '../evaluate.ts'
import { neverFits, type Book, type Rule, type Spec } from '../spec.ts'
import { above, bid, isMajor, isMinor, longest, MAJORS, other, plus, UP } from '../gib/util.ts'

/** When the opponents open or come in, docs/systems/sayc.md §8 and §9 */

const stopped = (h: Hand, s: Suit) => h.stop[s] === 'stop' || h.stop[s] === 'double'
const others = (x: Suit) => UP.filter((s) => s !== x)
const levelOver = (y: Suit, x: Suit, level: number) => (above(y, x) ? level : level + 1)
/** Cards to raise in competition: one fewer in a minor than without it */
const supportFor = (y: Suit) => (isMajor(y) ? 3 : y === 'D' ? 3 : 4)

/** The suit to overcall or advance in: a major of four or more first, else the longest */
function bestSuit(h: Hand, among: readonly Suit[]): Suit {
  const majors = among.filter((s) => isMajor(s) && h.len[s] >= 4)
  return majors.length ? longest(h, majors) : longest(h, among)
}

/** The opponents' suit bid `at` turns after the opening */
function theirBid(ctx: Ctx, at: number): { suit: Suit; level: number; call: Call } | null {
  const turn = ctx.turns[at]
  if (!turn || turn.ours || !isBid(turn.call) || strainOf(turn.call) === 'N') return null
  return { suit: strainOf(turn.call) as Suit, level: levelOf(turn.call), call: turn.call }
}

// ── Our opening, their overcall ──────────────────────────────────────────────────────────────

/** What a negative double shows: the unbid majors, or both minors when no major is left */
function negativeShows(y: Suit, z: Suit, level: number): Spec {
  const unbid = UP.filter((s) => s !== y && s !== z)
  const majors = unbid.filter(isMajor)
  const suits = majors.length ? majors : unbid.filter(isMinor)
  const len: Spec['len'] = {}
  // Exactly four when the major could have been bid at the one level, which would promise five
  for (const s of suits) len[s] = suits.length === 1 && level === 1 && above(s, z) ? [4, 4] : [4, 13]
  return { name: 'negative', len, hcp: plus(level === 1 ? 6 : 8), forcing: 'oneRound' }
}

/** Responder after an overcall: bids mean what they meant without it; their suit raises to game; negative doubles through 2♠ */
function afterOvercall(y: Suit): Rule[] {
  const z = (ctx: Ctx) => theirBid(ctx, 1)
  const n = supportFor(y)
  const rules: Rule[] = [
    {
      call: (ctx) => {
        const theirs = z(ctx)
        return theirs ? cheapest(ctx, theirs.suit) : null
      },
      shows: { name: 'cueRaise', len: { [y]: [n, 13] }, hcp: plus(12), forcing: 'game', artificial: true },
    },
  ]
  if (isMajor(y))
    rules.push(
      { call: bid(4, y), shows: { name: 'preemptiveRaise', len: { [y]: [5, 13] }, hcp: [0, 9] }, when: (h) => h.shape[3] <= 1 },
    )
  const raise = (extra: number) => (ctx: Ctx) => {
    const base = cheapest(ctx, y)
    if (!base) return null
    const level = levelOf(base) + extra
    return level <= 4 ? bid(level, y) : null
  }
  // A minor is raised only without four cards in an unbid major: the double or the major comes first
  const noMajorToShow = (h: Hand, ctx: Ctx) => isMajor(y) || MAJORS.every((M) => M === z(ctx)?.suit || h.len[M] < 4)
  const limit = isMajor(y) ? 3 : y === 'D' ? 4 : 5
  rules.push(
    { call: raise(1), shows: { name: 'limitRaise', len: { [y]: [limit, 13] }, tp: [10, 11], notes: [{ key: 'invite' }] }, when: noMajorToShow },
    { call: raise(0), shows: { len: { [y]: [n, 13] }, tp: [6, 9] }, when: noMajorToShow },
  )
  // A major at the two level or higher promises five and 11+; a minor 5+ and 10+
  for (const s of UP.filter((s) => s !== y))
    rules.push({
      call: (ctx) => {
        const theirs = z(ctx)
        if (!theirs || theirs.suit === s) return null
        const call = cheapest(ctx, s)
        return call && levelOf(call) >= 2 && levelOf(call) <= 3 ? call : null
      },
      shows: { len: { [s]: [5, 13] }, hcp: plus(isMajor(s) ? 11 : 10), forcing: 'oneRound' },
      when: (h) => longest(h, UP.filter((t) => t !== y)) === s,
    })
  rules.push({
    call: (ctx) => {
      const theirs = z(ctx)
      return theirs && bidIndex(theirs.call) <= bidIndex('2S') ? 'X' : null
    },
    shows: (ctx) => {
      const theirs = z(ctx)!
      return negativeShows(y, theirs.suit, theirs.level)
    },
  })
  // Over 2♠: the double is for penalty
  rules.push({
    call: (ctx) => {
      const theirs = z(ctx)
      return theirs && bidIndex(theirs.call) > bidIndex('2S') ? 'X' : null
    },
    shows: (ctx) => ({ name: 'penalty', len: { [z(ctx)!.suit]: [4, 13] }, hcp: plus(10) }),
    when: (h, ctx) => h.len[z(ctx)!.suit] >= 4,
  })
  // A major bid at the one level over a suit that a double could show promises five; else four
  for (const s of UP.filter((s) => s !== y))
    rules.push({
      call: (ctx) => {
        const theirs = z(ctx)
        if (!theirs || theirs.suit === s) return null
        const call = cheapest(ctx, s)
        return call && levelOf(call) === 1 ? call : null
      },
      shows: (ctx) => ({ len: { [s]: [theirBid(ctx, 1)?.suit === 'C' || theirBid(ctx, 1)?.suit === 'D' ? 4 : 5, 13] }, hcp: plus(6), forcing: 'oneRound' }),
      when: (h) => longest(h, UP.filter((t) => t !== y)) === s,
    })
  const nt = (level: number, hcp: readonly [number, number]): Rule => ({
    call: (ctx) => {
      const theirs = z(ctx)
      const call = cheapest(ctx, 'N')
      return theirs && call && levelOf(call) <= level ? bid(level, 'N') : null
    },
    shows: (ctx) => ({ hcp, stop: { [z(ctx)!.suit]: 'stop' } }),
  })
  rules.push(
    nt(3, plus(15)),
    nt(2, [12, 14]),
    nt(1, [6, 9]),
    // Game values and no clear direction: their suit again, without a fit
    {
      call: (ctx) => {
        const theirs = z(ctx)
        return theirs ? cheapest(ctx, theirs.suit) : null
      },
      shows: { name: 'cueRaise', hcp: plus(12), forcing: 'game', artificial: true },
      when: (h) => h.hcp >= 13,
    },
    { call: 'P', shows: {} },
  )
  return rules
}

/** Opener's rebid after a negative double */
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
      { call: jumpOrNot(1), shows: { len: { [M]: [4, 13] }, hcp: [16, 18], notes: [{ key: 'invite' }] } },
      { call: jumpOrNot(0), shows: { len: { [M]: [4, 13] }, hcp: [11, 15] } },
    )
  }
  rules.push(
    {
      call: (ctx) => {
        const call = cheapest(ctx, 'N')
        return call && levelOf(call) <= 2 ? call : null
      },
      shows: (ctx) => ({ hcp: [11, 15], stop: { [z(ctx)!.suit]: 'stop' } }),
    },
    { call: (ctx) => cheapest(ctx, y), shows: { len: { [y]: [isMajor(y) ? 6 : 5, 13] }, hcp: [11, 15] } },
    {
      call: 'P',
      shows: (ctx) => ({ name: 'penalty', len: { [z(ctx)!.suit]: [4, 13] } }),
      when: (h, ctx) => h.len[z(ctx)!.suit] >= 4 && stopped(h, z(ctx)!.suit),
    },
  )
  return rules
}

/** They doubled for takeout: new suits at the one level force, a jump shift is to play, 2NT is a raise */
function afterDouble(y: Suit): Rule[] {
  const n = isMajor(y) ? 3 : y === 'D' ? 4 : 5
  const rules: Rule[] = [{ call: '2N', shows: { name: 'truscott', len: { [y]: [n, 13] }, tp: plus(10), forcing: 'oneRound', artificial: true } }]
  if (isMajor(y)) rules.push({ call: bid(4, y), shows: { name: 'preemptiveRaise', len: { [y]: [5, 13] }, hcp: [0, 9] }, when: (h) => h.shape[3] <= 1 })
  rules.push(
    { call: bid(3, y), shows: { name: 'preemptiveRaise', len: { [y]: [n + 1, 13] }, hcp: [0, 9] } },
    { call: bid(2, y), shows: { len: { [y]: [n, 13] }, tp: [6, 9] } },
  )
  const unbid = UP.filter((s) => s !== y)
  // A jump shift: six cards, like a weak two or a preempt
  for (const s of unbid) {
    const jump = levelOver(s, y, 1) + 1
    if (jump <= 3)
      rules.push({
        call: bid(jump, s),
        shows: { name: 'weakJumpShift', len: { [s]: [6, 13] }, hcp: [3, 9], notes: [{ key: 'toPlay' }] },
        when: (h) => longest(h, unbid) === s,
      })
  }
  for (const s of unbid.filter((s) => above(s, y))) rules.push({ call: bid(1, s), shows: { len: { [s]: [4, 13] }, hcp: plus(6), forcing: 'oneRound' }, when: (h) => longest(h, unbid) === s })
  rules.push({ call: 'XX', shows: { hcp: plus(10) }, when: (h) => h.hcp >= 10 })
  for (const s of unbid.filter((s) => !above(s, y))) rules.push({ call: bid(2, s), shows: { len: { [s]: [5, 13] }, hcp: [6, 10] }, when: (h) => longest(h, unbid) === s })
  rules.push({ call: '1N', shows: { hcp: [6, 9] } }, { call: 'P', shows: {} })
  return rules
}

/** They showed two suits with a convention: a double shows 10+, one of their suits forces to game */
function overTheirConvention(y: Suit, shown: readonly Suit[]): Rule[] {
  const n = supportFor(y)
  const rules: Rule[] = [
    ...shown.map((s): Rule => ({ call: (ctx) => cheapest(ctx, s), shows: { name: 'cue', hcp: plus(12), forcing: 'game', artificial: true } })),
    { call: 'X', shows: { hcp: plus(10) }, when: (h) => h.hcp >= 10 && h.balanced },
  ]
  if (isMajor(y)) rules.push({ call: bid(4, y), shows: { len: { [y]: [4, 13] }, notes: [{ key: 'toPlay' }] }, when: (h) => h.len[y] >= 4 })
  rules.push({ call: (ctx) => cheapest(ctx, y), shows: { len: { [y]: [n, 13] }, tp: [6, 11] } })
  for (const s of UP.filter((s) => s !== y && !shown.includes(s))) rules.push({ call: (ctx) => cheapest(ctx, s), shows: { len: { [s]: [5, 13] }, hcp: plus(8) } })
  rules.push({ call: 'P', shows: {} })
  return rules
}

// ── Their opening ────────────────────────────────────────────────────────────────────────────

/** A takeout double: short in their suit with three or more in the others, or any strong hand */
function takeout(theirs: readonly Suit[], min: number, strong: number): Rule[] {
  const len: Spec['len'] = {}
  for (const s of UP) len[s] = theirs.includes(s) ? [0, 2] : [3, 13]
  return [
    { call: 'X', shows: { name: 'takeout', hcp: plus(min), len, forcing: 'oneRound' } },
    { call: 'X', shows: { name: 'takeout', hcp: plus(strong), forcing: 'oneRound' } },
  ]
}

const michaels = (x: Suit, level: number, least: number): Rule =>
  isMinor(x)
    ? { call: bid(level, x), shows: { name: 'michaels', len: { H: [5, 13], S: [5, 13] }, hcp: plus(least), notes: [{ key: 'bothMajors' }], forcing: 'oneRound', artificial: true } }
    : {
        call: bid(level, x),
        shows: { name: 'michaels', len: { [other(x)]: [5, 13] }, hcp: plus(least + 2), notes: [{ key: 'withMinor' }], forcing: 'oneRound', artificial: true },
        when: (h) => h.len.C >= 5 || h.len.D >= 5,
      }

/** Over a one-level opening; reopening means the same, a little lighter */
function overcalls(x: Suit, balancing: boolean): Rule[] {
  const unbid = others(x)
  const [a, b] = unbid
  const rules: Rule[] = [
    michaels(x, 2, balancing ? 7 : 8),
    {
      call: '2N',
      shows: { name: 'unusual2N', len: { [a]: [5, 13], [b]: [5, 13] }, hcp: plus(8), ...(isMajor(x) ? { notes: [{ key: 'bothMinors' as const }] } : {}), forcing: 'oneRound', artificial: true },
    },
    { call: '1N', shows: balancing ? { hcp: [10, 15], balanced: true } : { hcp: [15, 18], balanced: true, stop: { [x]: 'stop' } } },
    ...takeout([x], balancing ? 9 : 12, 17),
  ]
  if (!balancing)
    for (const y of unbid) {
      const jump = levelOver(y, x, 1) + 1
      if (jump > 3) continue
      rules.push({
        call: bid(jump, y),
        shows: { name: 'weakJumpOvercall', len: { [y]: [jump === 2 ? 6 : 7, 13] }, hcp: [5, 11] },
        when: (h) => bestSuit(h, unbid) === y,
      })
    }
  for (const y of unbid) {
    const level = levelOver(y, x, 1)
    rules.push({
      call: bid(level, y),
      shows: { name: 'overcall', len: { [y]: [5, 13] }, hcp: balancing ? [7, 16] : [8, 16] },
      when: (h) => bestSuit(h, unbid) === y && (level === 1 || h.hcp >= 10 || h.len[y] >= 6),
    })
  }
  rules.push({ call: 'P', shows: {} })
  return rules
}

/** They have bid two suits: a takeout of the other two; a bid in either of theirs is natural */
function overTwoSuits(x: Suit, y: Suit): Rule[] {
  const two = UP.filter((s) => s !== x && s !== y)
  const rules: Rule[] = [
    { call: '1N', shows: { hcp: [15, 18], balanced: true, stop: { [x]: 'stop', [y]: 'stop' } } },
    { call: 'X', shows: { name: 'takeout', len: { [two[0]]: [4, 13], [two[1]]: [4, 13] }, hcp: plus(11), forcing: 'oneRound' } },
    ...[x, y].map((s): Rule => ({ call: (ctx) => cheapest(ctx, s), shows: { len: { [s]: [6, 13] }, hcp: [10, 16] } })),
  ]
  for (const z of two) rules.push({ call: (ctx) => cheapest(ctx, z), shows: { name: 'overcall', len: { [z]: [5, 13] }, hcp: [8, 16] }, when: (h) => bestSuit(h, two) === z })
  rules.push({ call: 'P', shows: {} })
  return rules
}

/** Over an opening preempt: a suit or notrump is natural, their suit is Michaels; a double is for takeout through 4♦, for penalty higher */
function overPreempt(x: Suit, level: number): Rule[] {
  const rules: Rule[] = []
  if (level === 4 && isMajor(x) || level === 5) {
    rules.push({ call: 'X', shows: { name: 'penalty', hcp: plus(15) }, when: (h) => h.hcp >= 15 })
  } else {
    rules.push(...takeout([x], level === 2 ? 13 : level === 3 ? 13 : 15, 18), michaels(x, level + 1, 12))
    if (level <= 3) rules.push({ call: '3N', shows: { hcp: [16, 21], stop: { [x]: 'stop' }, notes: [{ key: 'toPlay' }] }, when: (h) => stopped(h, x) })
    if (level === 2) rules.push({ call: '2N', shows: { hcp: [15, 18], balanced: true, stop: { [x]: 'stop' } } })
    for (const y of others(x)) {
      const at = levelOver(y, x, level)
      if (at <= 4) rules.push({ call: bid(at, y), shows: { name: 'overcall', len: { [y]: [level === 2 ? 5 : 6, 13] }, hcp: [12, 18] }, when: (h) => bestSuit(h, others(x)) === y })
    }
  }
  rules.push({ call: 'P', shows: {} })
  return rules
}

/** Over 1NT nothing is conventional: a suit is natural, a double for penalty, 2NT both minors, a jump preemptive */
function overNotrump(balancing: boolean): Rule[] {
  const rules: Rule[] = [
    { call: 'X', shows: { name: 'penalty', hcp: plus(15) } },
    { call: '2N', shows: { name: 'unusual2N', len: { C: [5, 13], D: [5, 13] }, hcp: plus(8), notes: [{ key: 'bothMinors' }], artificial: true } },
  ]
  if (!balancing) for (const y of UP) rules.push({ call: bid(3, y), shows: { name: 'weakJumpOvercall', len: { [y]: [7, 13] }, hcp: [5, 11] }, when: (h) => h.len[y] >= 7 })
  for (const y of UP) rules.push({ call: bid(2, y), shows: { name: 'overcall', len: { [y]: [5, 13] }, hcp: balancing ? [7, 16] : [8, 16] }, when: (h) => bestSuit(h, UP) === y && h.len[y] >= 5 })
  rules.push({ call: 'P', shows: {} })
  return rules
}

// ── Advancing ────────────────────────────────────────────────────────────────────────────────

/** Partner doubled for takeout: below game a jump invites, their suit forces */
function advanceDouble(x: Suit, level: number): Rule[] {
  const unbid = others(x)
  const cue = bid(level + 1, x)
  const nt = (ctx: Ctx) => cheapest(ctx, 'N')
  const rules: Rule[] = [
    { call: cue, shows: { name: 'cue', hcp: plus(12), forcing: 'oneRound', artificial: true } },
    { call: '3N', shows: { hcp: plus(level === 1 ? 13 : 10), stop: { [x]: 'stop' } }, when: (h) => stopped(h, x) },
    ...MAJORS.filter((M) => M !== x).map((M): Rule => ({ call: bid(4, M), shows: { len: { [M]: [5, 13] }, hcp: [10, 13], notes: [{ key: 'game' }] } })),
  ]
  if (level === 1) rules.push({ call: '2N', shows: { hcp: [11, 12], stop: { [x]: 'stop' }, notes: [{ key: 'invite' }] }, when: (h) => stopped(h, x) })
  for (const y of unbid) {
    const at = levelOver(y, x, level) + 1
    if (at <= 3)
      rules.push({
        call: bid(at, y),
        shows: { len: { [y]: [4, 13] }, hcp: [9, 11], notes: [{ key: 'invite' }] },
        when: (h) => bestSuit(h, unbid) === y,
      })
  }
  if (level === 1) rules.push({ call: (ctx) => nt(ctx), shows: { hcp: [6, 10], stop: { [x]: 'stop' } }, when: (h) => stopped(h, x) && !MAJORS.some((M) => M !== x && h.len[M] >= 4) })
  for (const y of unbid) rules.push({ call: bid(levelOver(y, x, level), y), shows: { len: { [y]: [3, 13] }, hcp: [0, 8] }, when: (h) => bestSuit(h, unbid) === y })
  rules.push({ call: 'P', shows: { name: 'penalty', len: { [x]: [5, 13] }, hcp: plus(6) }, when: (h) => h.len[x] >= 5 && h.quality[x] !== null && h.quality[x] !== 'biddable' })
  return rules
}

/** Partner overcalled: the only force is their suit, which asks about the overcall; raises, notrump and new suits are not forcing */
function advanceOvercall(x: Suit, y: Suit, level: number): Rule[] {
  const rules: Rule[] = [{ call: bid(levelOver(x, y, level), x), shows: { name: 'cue', tp: plus(11), forcing: 'oneRound', artificial: true }, when: (h) => h.tp >= 11 && h.len[y] >= 2 }]
  if (isMajor(y) && level < 4) rules.push({ call: bid(4, y), shows: { len: { [y]: [3, 13] }, tp: plus(13), notes: [{ key: 'game' }] }, when: (h) => h.len[y] >= 3 })
  if (level + 2 <= 3) rules.push({ call: bid(level + 2, y), shows: { name: 'preemptiveRaise', len: { [y]: [4, 13] }, hcp: [0, 8] } })
  if (level + 1 <= 3) rules.push({ call: bid(level + 1, y), shows: { len: { [y]: [3, 13] }, tp: [6, 10] } })
  if (level === 1)
    rules.push(
      { call: '3N', shows: { hcp: plus(15), stop: { [x]: 'stop' } } },
      { call: '2N', shows: { hcp: [12, 14], stop: { [x]: 'stop' }, notes: [{ key: 'invite' }] } },
      { call: '1N', shows: { hcp: [8, 11], stop: { [x]: 'stop' } } },
    )
  for (const z of UP.filter((s) => s !== x && s !== y)) {
    const at = above(z, y) ? level : level + 1
    if (at <= 3) rules.push({ call: bid(at, z), shows: { len: { [z]: [5, 13] }, hcp: plus(8) }, when: (h) => h.len[y] <= 1 && longest(h) === z })
  }
  rules.push({ call: 'P', shows: {} })
  return rules
}

/** Their suit was asked: two of ours is a minimum, anything else shows 11 or 12 at least */
function overcallerAnswers(y: Suit, level: number): Rule[] {
  const again = levelOver(y, y, level) + 1
  return [
    { call: (ctx) => cheapest(ctx, y), shows: { hcp: [8, 10], notes: [{ key: 'minimum' }] }, when: (h) => h.hcp <= 10 },
    { call: (ctx) => cheapest(ctx, 'N'), shows: { hcp: plus(11) } },
    { call: bid(again, y), shows: { hcp: plus(11) } },
  ]
}

/** Partner bid Michaels: pick the major, or 2NT asks for the minor over a major */
function advanceMichaels(x: Suit): Rule[] {
  if (isMinor(x)) {
    const pick = (h: Hand): Suit => (h.len.S > h.len.H ? 'S' : 'H')
    return [
      ...MAJORS.map((M): Rule => ({ call: bid(4, M), shows: { len: { [M]: [4, 13] }, tp: plus(11), notes: [{ key: 'game' }] }, when: (h) => pick(h) === M })),
      ...MAJORS.map((M): Rule => ({ call: (ctx) => cheapest(ctx, M), shows: { len: { [M]: [3, 13] }, notes: [{ key: 'preference', strain: M }] }, when: (h) => pick(h) === M })),
    ]
  }
  const o = other(x)
  return [
    { call: bid(4, o), shows: { len: { [o]: [3, 13] }, tp: plus(11), notes: [{ key: 'game' }] }, when: (h) => h.len[o] >= 3 },
    { call: (ctx) => cheapest(ctx, o), shows: { len: { [o]: [3, 13] }, notes: [{ key: 'preference', strain: o }] }, when: (h) => h.len[o] >= 3 },
    { call: '2N', shows: { name: 'relay', artificial: true, forcing: 'oneRound' } },
  ]
}

const michaelsMinor: Rule[] = [
  { call: '3D', shows: { len: { D: [5, 13] } }, when: (h) => h.len.D >= h.len.C },
  { call: '3C', shows: { len: { C: [5, 13] } } },
]

/** Partner bid 2NT: the better of the two suits shown */
function advanceUnusual(a: Suit, b: Suit): Rule[] {
  const pick = (h: Hand): Suit => (h.len[b] > h.len[a] ? b : a)
  return [a, b].flatMap((s): Rule[] => [
    { call: bid(isMinor(s) ? 5 : 4, s), shows: { len: { [s]: [4, 13] }, tp: plus(12), notes: [{ key: 'game' }] }, when: (h) => pick(h) === s },
    { call: bid(3, s), shows: { len: { [s]: [2, 13] }, notes: [{ key: 'preference', strain: s }] }, when: (h) => pick(h) === s },
  ])
}

// ── Redoubles ────────────────────────────────────────────────────────────────────────────────

/** Doubled for penalty at the three level or lower, redouble asks partner for another suit */
const sosRedouble: Book = {
  only: (ctx) => {
    const last = ctx.last
    const n = ctx.turns.length
    if (!last?.ours || levelOf(last.call) > 3 || n < 3) return false
    const [a, b, c] = ctx.turns.slice(-3)
    return a.call === 'X' && b.call === 'P' && c.call === 'P' && !ctx.turns.slice(0, -3).some((t) => !t.ours && t.call !== 'P')
  },
  rules: [
    {
      call: 'XX',
      shows: { name: 'sos', artificial: true, forcing: 'oneRound' },
      when: (h, ctx) => {
        const s = strainOf(ctx.last!.call)
        return s !== 'N' && h.len[s as Suit] <= 1 && UP.filter((x) => x !== s && h.len[x] >= 3).length >= 2
      },
    },
  ],
  more: true,
}

/** A redouble at the four level or higher, or of a double of an artificial bid, is to play: read when a person makes it */
const penaltyRedouble: Book = {
  only: (ctx) => ctx.turns.at(-1)?.call === 'X' && !!ctx.last?.ours && levelOf(ctx.last.call) >= 4,
  rules: [{ call: 'XX', shows: { notes: [{ key: 'toPlay' }] }, when: neverFits }],
  more: true,
}

// ── The books ─────────────────────────────────────────────────────────────────────────────────

const suitOvercall = (ctx: Ctx) => {
  const theirs = theirBid(ctx, 1)
  return !!theirs && theirs.suit !== strainOf(ctx.turns[0].call)
}

const books: Book[] = [sosRedouble, penaltyRedouble]
for (const y of UP) {
  const [a, b] = others(y)
  books.push(
    { after: `1${y} (X)`, rules: afterDouble(y), more: true },
    { after: `1${y} (2N)`, rules: overTheirConvention(y, [a, b]), more: true },
    { after: `1${y} (2${y})`, rules: overTheirConvention(y, isMinor(y) ? MAJORS : [other(y)]), more: true },
    { after: `1${y} (1N)`, rules: [{ call: 'X', shows: { name: 'penalty', hcp: plus(9) } }], more: true },
    { after: `1${y} (+)`, only: suitOvercall, rules: afterOvercall(y), more: true },
    { after: `1${y} (+) X (P)`, only: suitOvercall, rules: afterNegative(y), more: true },
  )
}
for (const x of UP) {
  const [a, b] = others(x)
  books.push(
    { after: `(1${x})`, rules: overcalls(x, false), more: true },
    { after: `(1${x}) P (P)`, rules: overcalls(x, true), more: true },
    { after: [`(1${x}) X (P)`, `(1${x}) P (P) X (P)`], rules: advanceDouble(x, 1), more: true },
    { after: `(1${x}) 2${x} (P)`, rules: advanceMichaels(x), more: true },
    { after: `(1${x}) 2N (P)`, rules: advanceUnusual(a, b), more: true },
  )
  if (isMajor(x)) books.push({ after: `(1${x}) 2${x} (P) 2N (P)`, rules: michaelsMinor, more: true })
  for (const y of others(x)) {
    const level = levelOver(y, x, 1)
    books.push(
      { after: `(1${x}) ${bid(level, y)} (P)`, rules: advanceOvercall(x, y, level), more: true },
      { after: `(1${x}) ${bid(level, y)} (P) ${bid(levelOver(x, y, level), x)} (P)`, rules: overcallerAnswers(y, level), more: true },
    )
    if (above(y, x)) books.push({ after: `(1${x}) P (1${y})`, rules: overTwoSuits(x, y), more: true })
  }
}
for (const x of ['D', 'H', 'S'] as Suit[])
  books.push(
    { after: [`(2${x})`, `(2${x}) P (P)`], rules: overPreempt(x, 2), more: true },
    { after: [`(2${x}) X (P)`, `(2${x}) P (P) X (P)`], rules: advanceDouble(x, 2), more: true },
  )
for (const x of UP) {
  books.push({ after: [`(3${x})`, `(3${x}) P (P)`], rules: overPreempt(x, 3), more: true })
  books.push({ after: [`(4${x})`, `(4${x}) P (P)`], rules: overPreempt(x, 4), more: true })
  if (isMinor(x)) books.push({ after: [`(5${x})`, `(5${x}) P (P)`], rules: overPreempt(x, 5), more: true })
}
books.push({ after: '(1N)', rules: overNotrump(false), more: true }, { after: '(1N) P (P)', rules: overNotrump(true), more: true })

export const competition: readonly Book[] = books
