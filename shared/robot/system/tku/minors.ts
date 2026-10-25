import { levelOf, strainOf, type Call } from '../../../auction.ts'
import type { Suit } from '../../../cards.ts'
import type { Ctx } from '../context.ts'
import type { Hand } from '../evaluate.ts'
import type { Book, Rule, Spec } from '../spec.ts'
import { twoClubs } from './twoclubs.ts'
import { aces, answer, answerIs, bid, contested, isMajor, isSuit, length, MAJORS, MAXIMUM, MEDIUM, MINIMUM, onlyIf, ORDER, opened, ours, partnerOpened, pass, plus, rule, topThree } from './util.ts'

/**
 * 5542 自然制 (淡江橋譜「答叫：1♣ ?」「答叫：1♦ ?」 from the club's old handbook, 5542 where it says
 * nothing): the answers to 1♣/1♦ and opener's rebid, the answers to 2NT and to a preempt; 2♣ strong
 * is in `twoclubs.ts`.
 */

// ── 1♣ / 1♦ ──────────────────────────────────────────────────────────────────────────────────

/**
 * 低花反序 (inverted minor raises): the handbook has them as an option (新生請先忽略這段). The club's
 * robot does not use them until the club decides (docs/PRD/e5-robot-bidding-brain.md, 未決問題);
 * `minorResponses(s, true)` is the book with them.
 */
export const INVERTED_MINORS = false

/**
 * A weak jump shift (答叫 2♦/♥/♠、3♣ 等「5點以下，6或7張牌組之弱叫」): five points or less, a
 * six-card suit (over 1♣ seven cards jump to the three level), one of the top three honours, and
 * no ace with five points
 */
const weakSuit = (h: Hand, t: Suit, min: number, max: number) =>
  h.hcp <= 5 && h.len[t] >= min && h.len[t] <= max && topThree(h, t) >= 1 && !(h.hcp === 5 && aces(h) > 0)

/** The cheapest level for a new suit after one of a minor */
const newSuitLevel = (mine: Suit, t: Suit) => (ORDER.indexOf(t) > ORDER.indexOf(mine) ? 1 : 2)

/** A four-card major: 4-4 bids hearts first (up the line), otherwise the longer, 5-5 spades */
const majorFirst = (h: Hand): Suit | null => {
  if (h.len.H < 4 && h.len.S < 4) return null
  return h.len.S > h.len.H || (h.len.S === h.len.H && h.len.S >= 5) ? 'S' : 'H'
}

/**
 * The answers to 1♣/1♦ (淡江橋譜「答叫：1♣ ?」「答叫：1♦ ?」): weak jump shifts, a new major at the
 * one level (up the line with 4-4), 1♦ over 1♣, 2NT 10–12 and 3NT 13–15 balanced without a major,
 * 2♣ over 1♦ a game force (2 蓋 1), the raise 6–9 and the limit raise 10–12 (or inverted), 1NT 6–9.
 */
export function minorResponses(s: Suit, inverted = INVERTED_MINORS): Book {
  // 1♣ may be two cards, so raising it takes five
  const need = s === 'C' ? 5 : 4
  const support = (h: Hand) => h.len[s] >= need
  const noMajor = (h: Hand) => h.len.H < 4 && h.len.S < 4
  const rules: Rule[] = []

  // Weak jump shifts: over 1♣ six cards at the two level and seven at the three level; over 1♦ six or seven
  for (const t of ORDER.filter((x) => x !== s)) {
    const level = newSuitLevel(s, t) + 1
    const max = s === 'C' && level === 2 ? 6 : 7
    rules.push(rule(bid(level, t), { name: 'weakJumpShift', len: length(t, 6, max), hcp: [0, 5] }, (h) => weakSuit(h, t, 6, max)))
    if (s === 'C' && level === 2) rules.push(rule(bid(3, t), { name: 'weakJumpShift', len: length(t, 7), hcp: [0, 5] }, (h) => weakSuit(h, t, 7, 13)))
  }
  // 1♦–4♦: six diamonds, 9 points or less, to obstruct (with game values elsewhere it would bid more slowly)
  if (s === 'D')
    rules.push(rule('4D', { name: 'preemptiveRaise', len: length('D', 6), hcp: [0, 9] }, (h) => h.len.D >= 6 && h.hcp <= 9 && noMajor(h) && (h.hcp <= 5 || h.shape[3] <= 1)))

  rules.push(
    rule('P', { hcp: [0, 5] }, (h) => h.hcp < 6),
    rule('1H', { len: length('H', 4), hcp: plus(6), forcing: 'oneRound' }, (h) => majorFirst(h) === 'H'),
    rule('1S', { len: length('S', 4), hcp: plus(6), forcing: 'oneRound' }, (h) => majorFirst(h) === 'S'),
  )
  const oneDiamond = rule('1D', { len: { H: [0, 3], S: [0, 3], D: [4, 13] }, hcp: plus(6), forcing: 'oneRound' }, (h) => h.len.D >= 4)
  const twoClubs = rule('2C', { len: length('C', 4), hcp: plus(12), forcing: 'game' }, (h) => h.hcp >= 12 && h.len.C >= 4)
  // Over 1♣ four diamonds come first (up the line)
  if (s === 'C') rules.push(oneDiamond)
  rules.push(
    rule('3N', { hcp: [13, 15], balanced: true, notes: [{ key: 'noMajor' }] }, (h) => h.balanced && h.hcp >= 13 && h.hcp <= 15),
    rule('2N', { hcp: [10, 12], balanced: true, notes: [{ key: 'noMajor' }, { key: 'invite' }] }, (h) => h.balanced && h.hcp >= 10 && h.hcp <= 12),
  )
  if (s === 'D') rules.push(twoClubs)
  if (inverted)
    rules.push(
      rule(bid(2, s), { name: 'invertedMinor', len: length(s, need), hcp: plus(10), notes: [{ key: 'noMajor' }], forcing: 'oneRound' }, (h) => support(h) && h.hcp >= 10),
      rule(bid(3, s), { name: 'preemptiveRaise', len: length(s, 5), hcp: [6, 9] }, (h) => h.len[s] >= 5 && h.hcp <= 9),
    )
  else
    rules.push(
      rule(bid(3, s), { name: 'limitRaise', len: length(s, need), hcp: [10, 12], notes: [{ key: 'invite' }] }, (h) => support(h) && h.hcp >= 10 && h.hcp <= 12),
      rule(bid(2, s), { len: length(s, need), hcp: [6, 9] }, (h) => support(h) && h.hcp <= 9),
    )
  const oneNotrump = { hcp: [6, 9], notes: [{ key: 'noMajor' }] } as const satisfies Spec
  rules.push(rule('1N', oneNotrump, (h) => h.hcp <= 9))
  // Anything else: the forcing new suit with game values (1♦ over 1♣, 2♣ over 1♦), else 1NT
  rules.push(s === 'C' ? { ...oneDiamond, when: (h) => h.hcp >= 10 } : { ...twoClubs, when: (h) => h.hcp >= 12 }, rule('1N', oneNotrump))
  return { after: `1${s} (P)`, rules }
}

/** The answer to our minor was a weak jump shift */
const weakJump = (mine: Suit, call: Call) => {
  const t = strainOf(call)
  return isSuit(t) && t !== mine && levelOf(call) > newSuitLevel(mine, t)
}

/** The first side suit (not `a` or `b`) with at most one card, from ♣ up */
const shortBesides = (h: Hand, a: Suit, b: Suit): Suit | undefined => ORDER.find((x) => x !== a && x !== b && h.len[x] <= 1)

/** The cheapest level for suit `x` over a one-level answer in `s` */
const levelOver = (s: Suit, x: Suit) => (ORDER.indexOf(x) > ORDER.indexOf(s) ? 1 : 2)

/**
 * Opener's rebid after partner's answer to 1♣/1♦ (淡江橋譜「開叫1♣之後續發展」「開叫1♦之後續發展」):
 * 12–15 minimum, 16–18 invitational (the reverse, the jump rebid, the jump raise), 19–21 game
 * forcing (the jump shift, splinter, the raise to game, 3NT).
 */
function minorRebids(mine: Suit, inverted = INVERTED_MINORS): Book {
  const level = (ctx: Ctx) => levelOf(answer(ctx))
  const strain = (ctx: Ctx) => strainOf(answer(ctx))
  const raised = (ctx: Ctx) => strain(ctx) === mine
  const notrump = (ctx: Ctx) => strain(ctx) === 'N'
  const at = (test: (ctx: Ctx) => boolean, call: Call | ((ctx: Ctx) => Call | null)) => onlyIf(test, call)
  const invertedRaise = (ctx: Ctx) => inverted && answer(ctx) === bid(2, mine)
  const clubs = mine === 'C'
  const higher = ORDER.filter((x) => ORDER.indexOf(x) > ORDER.indexOf(mine))
  const five = (h: Hand) => h.len[mine] >= 5
  const rules: Rule[] = [
    // A weak jump shift: partner has five points at most, so opener passes
    rule(at((ctx) => weakJump(mine, answer(ctx)), 'P')),
    // 低花反序 (1♣ 2♣ ?): 3NT 18–19 balanced, 2NT 12–14 balanced, a four-card suit with extras, 3♣ minimum
    ...(inverted
      ? [
          rule(at(invertedRaise, '3N'), { hcp: [18, 19], balanced: true }, (h) => h.balanced && h.hcp >= 18),
          rule(at(invertedRaise, '2N'), { hcp: [12, 14], balanced: true, notes: [{ key: 'minimum' }] }, (h) => h.balanced && h.hcp <= 14),
          ...higher.map((x) => rule(at(invertedRaise, bid(2, x)), { len: length(x, 4), hcp: plus(15) }, (h) => h.hcp >= 15 && h.len[x] >= 4)),
          rule(at(invertedRaise, bid(3, mine)), { notes: [{ key: 'minimum' }] }),
        ]
      : []),
    // Partner raised
    rule(at((ctx) => raised(ctx) && level(ctx) >= 3, '3N'), { hcp: plus(15), balanced: true }, (h) => h.hcp >= 15 && h.balanced),
    rule(at((ctx) => raised(ctx) && level(ctx) >= 3, 'P')),
    rule(at(raised, '3N'), { hcp: plus(18) }, (h) => h.hcp >= 18),
    rule(at(raised, bid(3, mine)), { hcp: [16, 17], notes: [{ key: 'invite' }] }, (h) => h.hcp >= 16),
    rule(at(raised, 'P')),
  ]

  // 1NT (6–9) and 2NT (10–12): 「1♣ 1NT ?」「1♦ 1NT ?」「1♣ 2NT ?」
  const isN = (n: number) => (ctx: Ctx) => notrump(ctx) && level(ctx) === n
  rules.push(rule(at((ctx) => notrump(ctx) && level(ctx) >= 3, 'P')))
  for (const x of ORDER.filter((y) => y !== mine))
    rules.push(
      rule(at(isN(2), bid(3, x)), { len: { [mine]: [5, 13], [x]: [4, 13] }, hcp: plus(16), notes: [{ key: 'slamInterest' }] }, (h) => !h.balanced && five(h) && h.len[x] >= 4 && h.hcp >= 16),
    )
  rules.push(
    rule(at(isN(2), '3N'), { hcp: plus(13), notes: [{ key: 'accept' }] }, (h) => h.hcp >= 14 || (h.hcp >= 13 && h.balanced)),
    rule(at(isN(2), bid(3, mine)), { len: length(mine, 5), notes: [{ key: 'minimum' }] }, (h) => !h.balanced && five(h)),
    rule(at(isN(2), 'P')),
    // Over 1NT: 3NT and jump shifts 19–21, reverses and 2NT 16–18
    ...ORDER.filter((x) => x !== mine && (clubs || x === 'C')).map((x) =>
      rule(at(isN(1), bid(3, x)), { len: length(x, 4), hcp: MAXIMUM, forcing: 'game' }, (h) => h.hcp >= 19 && five(h) && h.len[x] >= 4),
    ),
    rule(at(isN(1), '3N'), { hcp: MAXIMUM }, (h) => h.hcp >= 19),
    ...higher.map((x) => rule(at(isN(1), bid(2, x)), { name: 'reverse', len: { [mine]: [5, 13], [x]: [4, 13] }, hcp: clubs ? MEDIUM : [16, 21], forcing: 'oneRound' }, (h) => h.hcp >= 16 && five(h) && h.len[x] >= 4)),
    rule(at(isN(1), '2N'), { hcp: MEDIUM, balanced: true, notes: [{ key: 'invite' }] }, (h) => h.hcp >= 16 && h.balanced),
    rule(at(isN(1), bid(3, mine)), { len: length(mine, 6), hcp: MEDIUM, notes: [{ key: 'invite' }] }, (h) => h.hcp >= 16 && h.len[mine] >= 6),
  )
  if (!clubs) rules.push(rule(at(isN(1), '2C'), { len: { D: [5, 13], C: [4, 13] }, hcp: [12, 18] }, (h) => five(h) && h.len.C >= 4))
  rules.push(
    rule(at(isN(1), bid(2, mine)), { len: length(mine, clubs ? 5 : 6), hcp: MINIMUM }, (h) => !h.balanced && h.len[mine] >= (clubs ? 5 : 6)),
    rule(at(isN(1), 'P')),
  )

  // 1♦–2♣, a 2/1 game force: 「1♦ 2♣ ?」
  if (!clubs) {
    const gf = answerIs('2C')
    rules.push(
      ...MAJORS.map((x) => rule(at(gf, bid(2, x)), { name: 'reverse', len: { D: [5, 13], [x]: [4, 13] }, hcp: [16, 21] }, (h) => h.hcp >= 16 && five(h) && h.len[x] >= 4)),
      rule(at(gf, '3D'), { len: length('D', 6), hcp: plus(16) }, (h) => h.hcp >= 16 && h.len.D >= 6),
      rule(at(gf, '3C'), { len: length('C', 4), hcp: plus(16), notes: [{ key: 'support', strain: 'C' }] }, (h) => h.hcp >= 16 && h.len.C >= 4),
      rule(at(gf, '2N'), { hcp: MINIMUM, balanced: true }, (h) => h.balanced && h.hcp <= 15),
      rule(at(gf, '2D'), { len: length('D', 4), notes: [{ key: 'minimum' }] }),
    )
  }

  // A new suit at the one level: 「1♣ 1♦／1♥／1♠ ?」「1♦ 1♥／1♠ ?」
  for (const s of higher) {
    const here = (ctx: Ctx) => strain(ctx) === s && level(ctx) === 1
    const four = (h: Hand) => h.len[s] >= 4
    const support: Rule[] = []
    // Raises: splinter or game 19–21, the jump raise 16–18, the single raise 12–15
    for (const x of ORDER.filter((y) => y !== s && y !== mine))
      support.push(
        rule(
          at(here, bid(levelOver(s, x) + 2, x)),
          { name: 'splinter', len: length(s, 4), hcp: MAXIMUM, notes: [{ key: 'shortIn', strain: x }] },
          (h) => four(h) && h.hcp >= 19 && shortBesides(h, s, mine) === x,
        ),
      )
    if (isMajor(s)) support.push(rule(at(here, bid(4, s)), { len: length(s, 4), hcp: MAXIMUM, notes: [{ key: 'noShortness' }, { key: 'game' }] }, (h) => four(h) && h.hcp >= 19))
    support.push(
      rule(at(here, bid(3, s)), { len: length(s, 4), hcp: isMajor(s) ? MEDIUM : plus(16), notes: [{ key: 'invite' }] }, (h) => four(h) && h.hcp >= 16),
      rule(at(here, bid(2, s)), { len: length(s, 4), hcp: MINIMUM }, four),
    )
    const majors: Rule[] = []
    for (const x of higher.filter((y) => isMajor(y) && ORDER.indexOf(y) > ORDER.indexOf(s))) {
      // The jump shift 19–21 (five of our minor), otherwise the major at the one level (4-4: hearts)
      const first = (h: Hand) => (h.len.H >= 4 && s !== 'H' && x === 'S' ? false : h.len[x] >= 4)
      majors.push(
        rule(at(here, bid(2, x)), { len: { [mine]: [5, 13], [x]: [4, 13] }, hcp: MAXIMUM, forcing: 'game' }, (h) => h.hcp >= 19 && five(h) && first(h)),
        rule(at(here, bid(1, x)), { len: length(x, 4), hcp: [12, 18], forcing: 'oneRound' }, first),
      )
    }
    // Over a major the raise comes first; over 1♦ (1♣ 1♦) the majors at the one level do
    rules.push(...(isMajor(s) ? [...support, ...majors] : [...majors, ...support]))
    rules.push(rule(at(here, '2N'), { hcp: [18, 19], balanced: true }, (h) => h.balanced && h.hcp >= 18))
    // 1♣: 3NT with a solid six-card club suit
    if (clubs) rules.push(rule(at(here, '3N'), { len: length('C', 6), quality: { C: 'solid' }, hcp: [12, 18] }, (h) => h.len.C >= 6 && topThree(h, 'C') === 3 && h.hcp <= 18))
    // Jump shifts at the three level (19–21) and reverses (16+)
    for (const x of ORDER.filter((y) => y !== s && y !== mine && levelOver(s, y) === 2)) {
      if (clubs || x === 'C')
        rules.push(rule(at(here, bid(3, x)), { len: { [mine]: [5, 13], [x]: [4, 13] }, hcp: MAXIMUM, forcing: 'game' }, (h) => h.hcp >= 19 && five(h) && h.len[x] >= 4))
      if (ORDER.indexOf(x) > ORDER.indexOf(mine))
        rules.push(
          rule(at(here, bid(2, x)), { name: 'reverse', len: { [mine]: [5, 13], [x]: [4, 13] }, hcp: clubs ? MEDIUM : [16, 21], forcing: 'oneRound' }, (h) => h.hcp >= 16 && five(h) && h.len[x] >= 4),
        )
    }
    rules.push(rule(at(here, bid(3, mine)), { len: length(mine, 6), hcp: MEDIUM, notes: [{ key: 'invite' }] }, (h) => h.hcp >= 16 && h.len[mine] >= 6))
    if (!clubs) rules.push(rule(at(here, '2C'), { len: length('C', 4), hcp: [12, 18] }, (h) => h.len.C >= 4 && h.hcp <= 18))
    rules.push(
      rule(at(here, '1N'), { hcp: [12, 14], balanced: true }, (h) => h.balanced && h.hcp <= 14),
      rule(at(here, '3N'), { hcp: MAXIMUM, notes: [{ key: 'toPlay' }] }, (h) => h.hcp >= 19),
      rule(at(here, bid(2, mine)), { len: length(mine, clubs ? 5 : 6), hcp: MINIMUM }, (h) => h.len[mine] >= (clubs ? 5 : 6)),
      rule(at(here, '1N'), { hcp: [12, 15] }),
    )
  }
  return { after: `1${mine} (P) * (P)`, only: (ctx) => answer(ctx) !== 'P', rules }
}

// ── 2NT ──────────────────────────────────────────────────────────────────────────────────────

const twoNotrumpResponses: Book = {
  after: '2N (P)',
  rules: [
    rule('3S', { len: length('S', 5), hcp: plus(4), forcing: 'oneRound' }, (h) => h.hcp >= 4 && h.len.S >= 5),
    rule('3H', { len: length('H', 5), hcp: plus(4), forcing: 'oneRound' }, (h) => h.hcp >= 4 && h.len.H >= 5),
    rule('6N', { hcp: plus(12), notes: [{ key: 'smallSlam' }] }, (h) => h.hcp >= 12),
    rule('3N', { hcp: [4, 11], notes: [{ key: 'toPlay' }] }, (h) => h.hcp >= 4),
    pass({ hcp: [0, 3] }),
  ],
}

// ── Partner preempted ────────────────────────────────────────────────────────────────────────

/** Partner opened at the three level or higher and the next player passed */
const preempted = (ctx: Ctx) => partnerOpened(ctx) && ours(ctx).length === 1 && !contested(ctx) && levelOf(opened(ctx)) >= 3
const preemptSuit = (ctx: Ctx) => strainOf(opened(ctx))

const preemptResponses: Book = {
  only: preempted,
  rules: [
    ...MAJORS.map((m) => rule(onlyIf((ctx) => preemptSuit(ctx) === m, bid(4, m)), { len: length(m, 2), hcp: plus(16), notes: [{ key: 'game' }] }, (h) => h.len[m] >= 2 && h.hcp >= 16)),
    ...(['D', 'C'] as const).flatMap((m): Rule[] => [
      rule(onlyIf((ctx) => preemptSuit(ctx) === m, '3N'), { hcp: plus(16), balanced: true, notes: [{ key: 'game' }] }, (h) => h.len[m] >= 2 && h.hcp >= 16 && h.balanced),
      rule(onlyIf((ctx) => preemptSuit(ctx) === m, bid(5, m)), { len: length(m, 2), hcp: plus(16), notes: [{ key: 'game' }] }, (h) => h.len[m] >= 2 && h.hcp >= 16),
    ]),
    pass(),
  ],
}

export const minors: Book[] = [minorResponses('C'), minorResponses('D'), minorRebids('C'), minorRebids('D')]
export const strong: Book[] = [...twoClubs, twoNotrumpResponses, preemptResponses]

