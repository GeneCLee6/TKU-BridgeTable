import { levelOf, strainOf, type Call } from '../../../auction.ts'
import type { Suit } from '../../../cards.ts'
import type { Ctx } from '../context.ts'
import type { Hand } from '../evaluate.ts'
import type { Book, Rule } from '../spec.ts'
import { answer, bid, cheapestOr, contested, isMajor, isSuit, length, longest, MAJORS, onlyIf, ORDER, opened, ours, partnerOpened, pass, plus, rule } from './util.ts'

/**
 * 5542 自然制 where the handbook says nothing: the answers to 1♣/1♦ and opener's rebid, 2♣ strong
 * with the 2♦ waiting bid, the answers to 2NT and to a preempt.
 */

// ── 1♣ / 1♦ ──────────────────────────────────────────────────────────────────────────────────

function minorResponses(s: Suit): Book {
  // 1♣ may be two cards, so raising it takes five
  const need = s === 'C' ? 5 : 4
  const support = (h: Hand) => h.len[s] >= need
  const newMajor = (t: Suit, when: (h: Hand) => boolean) => rule(bid(1, t), { len: length(t, 4), hcp: plus(6), forcing: 'oneRound' }, when)
  const rules: Rule[] = [
    rule('P', { hcp: [0, 5] }, (h) => h.hcp < 6),
    newMajor('H', (h) => h.len.H >= 4 && h.len.H >= h.len.S),
    newMajor('S', (h) => h.len.S >= 4),
  ]
  if (s === 'C') rules.push(rule('1D', { len: { H: [0, 3], S: [0, 3], D: [4, 13] }, hcp: plus(6), forcing: 'oneRound' }, (h) => h.len.D >= 4))
  if (s === 'D') rules.push(rule('2C', { len: length('C', 4), hcp: plus(11), forcing: 'oneRound' }, (h) => h.hcp >= 11 && h.len.C >= 4))
  rules.push(
    rule(bid(3, s), { len: length(s, need), hcp: [10, 10], notes: [{ key: 'invite' }] }, (h) => support(h) && h.hcp === 10),
    rule(bid(2, s), { len: length(s, need), hcp: [6, 9] }, (h) => support(h) && h.hcp <= 9),
    rule('3N', { hcp: plus(13), balanced: true, notes: [{ key: 'noMajor' }] }, (h) => h.balanced && h.hcp >= 13),
    rule('2N', { hcp: [11, 12], balanced: true, notes: [{ key: 'noMajor' }, { key: 'invite' }] }, (h) => h.balanced && h.hcp >= 11),
    rule(bid(3, s), { len: length(s, need), hcp: plus(11) }, (h) => support(h) && h.hcp >= 11),
    rule(bid(3, s), { hcp: plus(11), notes: [{ key: 'noMajor' }] }, (h) => h.hcp >= 11),
    rule('1N', { hcp: [6, 10], notes: [{ key: 'noMajor' }] }),
  )
  return { after: `1${s} (P)`, rules }
}

/** Opener's rebid after partner's answer to 1♣/1♦ */
function minorRebids(mine: Suit): Book {
  const level = (ctx: Ctx) => levelOf(answer(ctx))
  const strain = (ctx: Ctx) => strainOf(answer(ctx))
  const raised = (ctx: Ctx) => strain(ctx) === mine
  const notrump = (ctx: Ctx) => strain(ctx) === 'N'
  const newSuit = (ctx: Ctx) => isSuit(strain(ctx)) && strain(ctx) !== mine
  const at = (test: (ctx: Ctx) => boolean, call: Call | ((ctx: Ctx) => Call | null)) => onlyIf(test, call)
  const rules: Rule[] = [
    // Partner raised
    rule(at((ctx) => raised(ctx) && level(ctx) >= 3, '3N'), { hcp: plus(15), balanced: true }, (h) => h.hcp >= 15 && h.balanced),
    rule(at((ctx) => raised(ctx) && level(ctx) >= 3, 'P')),
    rule(at(raised, '3N'), { hcp: plus(18) }, (h) => h.hcp >= 18),
    rule(at(raised, bid(3, mine)), { hcp: [16, 17], notes: [{ key: 'invite' }] }, (h) => h.hcp >= 16),
    rule(at(raised, 'P')),
    // Partner bid notrump
    rule(at((ctx) => notrump(ctx) && level(ctx) >= 3, 'P')),
    rule(at((ctx) => notrump(ctx) && level(ctx) === 2, '3N'), { hcp: plus(13), notes: [{ key: 'accept' }] }, (h) => h.hcp >= 13),
    rule(at((ctx) => notrump(ctx) && level(ctx) === 2, 'P')),
    rule(at(notrump, '3N'), { hcp: plus(18) }, (h) => h.hcp >= 18),
    rule(at(notrump, '2N'), { hcp: [16, 17], balanced: true, notes: [{ key: 'invite' }] }, (h) => h.hcp >= 16 && h.balanced),
    rule(at(notrump, bid(2, mine)), { len: length(mine, 6), notes: [{ key: 'minimum' }] }, (h) => h.len[mine] >= 6),
    rule(at(notrump, 'P')),
  ]
  // Partner bid a new suit: raise with four
  for (const s of ORDER.filter((x) => x !== mine)) {
    const isS = (ctx: Ctx) => strain(ctx) === s
    const four = (h: Hand) => h.len[s] >= 4
    if (isMajor(s)) rules.push(rule(at(isS, bid(4, s)), { len: length(s, 4), hcp: [18, 21] }, (h) => four(h) && h.hcp >= 18))
    rules.push(
      rule(at(isS, (ctx) => bid(level(ctx) + 1, s)), { len: length(s, 4), hcp: [15, 17], notes: [{ key: 'invite' }] }, (h) => four(h) && h.hcp >= 15),
      // After a two-level answer this is partner's own call: the robot passes (it is not legal)
      rule(at(isS, (ctx) => bid(level(ctx) === 1 ? 2 : level(ctx), s)), { len: length(s, 4), hcp: [12, 14] }, four),
    )
  }
  rules.push(
    rule(at((ctx) => strain(ctx) === 'H', '1S'), { len: { H: [0, 3], S: [4, 13] } }, (h) => h.len.S >= 4),
    rule(at(newSuit, '2N'), { hcp: [18, 19], balanced: true }, (h) => h.balanced && h.hcp >= 18),
    rule(at((ctx) => newSuit(ctx) && level(ctx) === 1, '1N'), { hcp: [12, 14], balanced: true }, (h) => h.balanced),
    rule(at((ctx) => newSuit(ctx) && level(ctx) !== 1, '2N'), { balanced: true }, (h) => h.balanced),
    rule(at(newSuit, (ctx) => cheapestOr(ctx, mine)), { len: length(mine, 6) }, (h) => h.len[mine] >= 6),
  )
  // A lower four-card suit (clubs after 1♦)
  for (const x of ORDER.filter((y) => ORDER.indexOf(y) < ORDER.indexOf(mine)))
    rules.push(
      rule(at((ctx) => newSuit(ctx) && strain(ctx) !== x, (ctx) => cheapestOr(ctx, x)), { len: length(x, 4) }, (h, ctx) =>
        ORDER.find((y) => y !== mine && y !== strain(ctx) && h.len[y] >= 4 && ORDER.indexOf(y) < ORDER.indexOf(mine)) === x,
      ),
    )
  rules.push(rule(at(newSuit, (ctx) => cheapestOr(ctx, mine, '1N')), { len: length(mine, 4) }))
  return { after: `1${mine} (P) * (P)`, only: (ctx) => answer(ctx) !== 'P', rules }
}

// ── 2♣ strong ────────────────────────────────────────────────────────────────────────────────

const twoClubResponses: Book = {
  after: '2C (P)',
  rules: [
    ...(['S', 'H', 'D', 'C'] as const).map((s) =>
      rule(isMajor(s) ? bid(2, s) : bid(3, s), { len: length(s, 5), hcp: plus(8), notes: [{ key: 'positive' }] }, (h) => h.hcp >= 8 && longest(h) === s && h.len[s] >= 5),
    ),
    rule('2N', { hcp: plus(8), notes: [{ key: 'positive' }] }, (h) => h.hcp >= 8),
    rule('2D', { name: 'waiting', hcp: [0, 7], artificial: true }),
  ],
}

const twoClubRebids: Book = {
  after: '2C (P) 2D (P)',
  rules: [
    rule('3N', { hcp: plus(25), balanced: true }, (h) => h.balanced && h.hcp >= 25),
    rule('2N', { hcp: [22, 24], balanced: true }, (h) => h.balanced),
    ...(['S', 'H', 'D', 'C'] as const).map((s) =>
      rule(isMajor(s) ? bid(2, s) : bid(3, s), { len: length(s, 5), hcp: plus(22), forcing: 'oneRound' }, (h) => longest(h) === s),
    ),
  ],
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
export const strong: Book[] = [twoClubResponses, twoClubRebids, twoNotrumpResponses, preemptResponses]

