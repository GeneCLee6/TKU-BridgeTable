import type { Suit } from '../../../cards.ts'
import { cheapest, type Ctx } from '../context.ts'
import type { Hand } from '../evaluate.ts'
import { ANY, QUALITIES, type Book, type Quality, type Rule } from '../spec.ts'
import { shortness } from './majors.ts'
import { above, bid, plus, UP } from './util.ts'

/**
 * Soloway jump shifts, docs/BBO GIB/gib-2over1.md §9 (GIB System Notes): by an unpassed hand in an
 * uncontested auction, a jump from the one level to a higher suit at the two level (1♣–2♦/2♥/2♠,
 * 1♦–2♥/2♠, 1♥–2♠)
 */

const atLeast = (h: Hand, s: Suit, q: Quality) => h.quality[s] !== null && QUALITIES.indexOf(h.quality[s]!) >= QUALITIES.indexOf(q)
const controls = (h: Hand) => h.controls >= 4

/** Which of the four Soloway hands this is with suit x, opposite an opening in o (0 for none) */
export function solowayType(h: Hand, o: Suit, x: Suit): 0 | 1 | 2 | 3 | 4 {
  if (!controls(h) || !atLeast(h, x, 'rebiddable')) return 0
  const sideFour = UP.some((s) => s !== x && h.len[s] >= 4)
  if (h.tp >= 17 && h.len[o] >= 4) return 4
  if (h.tp >= 17 && atLeast(h, x, 'solid')) return 2
  if (h.tp >= 17 && atLeast(h, x, 'strongRebiddable') && !sideFour) return 1
  if (h.hcp >= 18 && (h.shape.join('') === '5332' || h.shape.join('') === '6322')) return 3
  return 0
}

function jumpShifts(o: Suit): Rule[] {
  return UP.filter((x) => above(x, o)).map(
    (x): Rule => ({
      call: bid(2, x),
      shows: { name: 'soloway', quality: { [x]: 'rebiddable' }, tp: [17, ANY], controls: [4, ANY], forcing: 'game' },
      when: (h) => solowayType(h, o, x) > 0 && UP.every((s) => s === x || solowayType(h, o, s) === 0 || h.len[s] <= h.len[x]),
    }),
  )
}

/** Opener: raise with three or more, rebid a six-card suit, show a side suit with at least KQ, else notrump */
function openerAfterJump(o: Suit, x: Suit): Rule[] {
  const rules: Rule[] = [
    { call: bid(3, x), shows: { len: { [x]: [3, 13] }, notes: [{ key: 'support', strain: x }] }, when: (h) => h.len[x] >= 3 },
    { call: (ctx: Ctx) => cheapest(ctx, o), shows: { len: { [o]: [6, 13] } }, when: (h) => h.len[o] >= 6 },
  ]
  for (const z of UP.filter((z) => z !== o && z !== x))
    rules.push({
      call: (ctx) => cheapest(ctx, z),
      shows: { len: { [x]: [0, 2], [z]: [4, 13] }, notes: [{ key: 'honourIn', strain: z }] },
      when: (h) => h.len[z] >= 4 && /^(A|KQ)/.test(h.ranks[z]),
    })
  rules.push({ call: (ctx) => cheapest(ctx, 'N'), shows: { len: { [x]: [0, 2] } } })
  return rules
}

/**
 * The jump shifter shows the type: a fit raises opener's suit (or bids its shortness as a
 * splinter), the balanced hand bids notrump, the one-suiters rebid the suit (game when minimum
 * with a solid suit)
 */
function jumperRebid(o: Suit, x: Suit): Rule[] {
  const rules: Rule[] = []
  for (const s of UP.filter((s) => s !== o && s !== x))
    rules.push({
      call: (ctx) => cheapest(ctx, s),
      shows: { name: 'splinter', len: { [o]: [4, 13], [s]: [0, 1] }, notes: [{ key: 'shortIn', strain: s }], forcing: 'game' },
      when: (h) => solowayType(h, o, x) === 4 && shortness(h, o) === s,
    })
  rules.push(
    { call: (ctx) => cheapest(ctx, o), shows: { len: { [o]: [4, 13] }, notes: [{ key: 'noShortness' }], forcing: 'game' }, when: (h) => solowayType(h, o, x) === 4 },
    { call: (ctx) => cheapest(ctx, 'N'), shows: { hcp: plus(18), notes: [{ key: 'noShortness' }] }, when: (h) => solowayType(h, o, x) === 3 },
    {
      call: bid(4, x),
      shows: { len: { [x]: [6, 13] }, quality: { [x]: 'solid' }, notes: [{ key: 'minimum' }] },
      when: (h) => h.tp <= 18 && (x === 'H' || x === 'S'),
    },
    { call: (ctx) => cheapest(ctx, x), shows: { len: { [x]: [6, 13] }, quality: { [x]: 'strongRebiddable' } } },
  )
  return rules
}

const books: Book[] = []
for (const o of ['C', 'D', 'H'] as Suit[]) {
  books.push({ after: `1${o} (P)`, only: (ctx) => !ctx.passed, rules: jumpShifts(o), more: true })
  for (const x of UP.filter((x) => above(x, o))) {
    books.push(
      { after: `1${o} (P) 2${x} (P)`, only: (ctx) => !ctx.partnerPassed, rules: openerAfterJump(o, x), more: true },
      { after: `1${o} (P) 2${x} (P) * (P)`, only: (ctx) => !ctx.passed, rules: jumperRebid(o, x), more: true },
    )
  }
}

export const soloway: readonly Book[] = books
