import type { Suit } from '../../../cards.ts'
import type { Ctx } from '../context.ts'
import type { Hand } from '../evaluate.ts'
import { opens } from '../gib/openings.ts'
import type { Book, Rule, Spec } from '../spec.ts'
import { bid, goodSuit, isMinor, MAJORS, other, STRONG, SUITS_DOWN, upTo } from './util.ts'

/** Opening bids, docs/systems/precision.md §1 */

/** No more than 15, and worth opening in this seat (the same light openings as 2/1: Rule of 20, third and fourth seat) */
const limitedOpening = (h: Hand, ctx: Ctx) => h.hcp <= 15 && opens(h, ctx)
const light = (ctx: Ctx) => ctx.position === 3 || ctx.position === 4
const notFourth = (ctx: Ctx) => ctx.position <= 3
const hasFourMajor = (h: Hand) => h.len.S >= 4 || h.len.H >= 4

/** The major to open with five or more, ♠ with equal lengths */
const openingMajor = (h: Hand): Suit | null => (h.len.S >= 5 && h.len.S >= h.len.H ? 'S' : h.len.H >= 5 ? 'H' : null)

/** 2♦: at most one diamond, seven or more in the majors, four or five clubs (no five-card major) */
export const shortDiamondShape = (h: Hand) => h.len.D <= 1 && h.len.S <= 4 && h.len.H <= 4 && h.len.C <= 5 && h.len.S + h.len.H >= 7

/** 2♣: six or more clubs, or five with a four-card major (no five-card major) */
const longClubs = (h: Hand) => !openingMajor(h) && !shortDiamondShape(h) && (h.len.C >= 6 || (h.len.C === 5 && hasFourMajor(h)))

const oneMajor = (M: Suit): Rule => ({
  call: bid(1, M),
  shows: (ctx: Ctx): Spec => ({ len: { [M]: [5, 13] }, hcp: [light(ctx) ? 10 : 11, 15] }),
  needs: { hcp: [10, 15] },
  when: (h, ctx) => openingMajor(h) === M && limitedOpening(h, ctx),
})

const weakTwo = (M: Suit): Rule => ({
  call: bid(2, M),
  shows: { name: 'weakTwo', len: { [M]: [6, 6] }, hcp: [5, 10], quality: { [M]: 'twiceRebiddable' } },
  when: (h, ctx) => notFourth(ctx) && goodSuit(h, M) && h.len[other(M)] < 4,
})

const preempt = (level: number, s: Suit, length: number, longer = false): Rule => ({
  call: bid(level, s),
  shows: { name: 'preempt', len: { [s]: [length, longer ? 13 : length] }, hcp: [5, 10] },
  when: (h, ctx) => notFourth(ctx) && (isMinor(s) || h.len[other(s)] < 4),
})

/** A solid seven-card or longer minor headed by the AKQ, and no ace or king outside */
function gamblingMinor(h: Hand): Suit | null {
  const m = (['D', 'C'] as Suit[]).find((s) => h.len[s] >= 7 && h.ranks[s].startsWith('AKQ'))
  if (!m) return null
  return SUITS_DOWN.every((s) => s === m || !/[AK]/.test(h.ranks[s])) ? m : null
}

export const openings: Book = {
  after: '',
  rules: [
    { call: '2N', shows: { hcp: [22, 24], balanced: true } },
    { call: '1C', shows: { name: 'strongClub', hcp: STRONG, forcing: 'oneRound', artificial: true } },
    { call: '3N', shows: { name: 'gambling3N', hcp: [9, 12], artificial: true }, when: (h, ctx) => notFourth(ctx) && !!gamblingMinor(h) },
    { call: '1N', shows: { hcp: [13, 15], balanced: true }, when: (h) => !openingMajor(h) },
    weakTwo('S'),
    weakTwo('H'),
    preempt(4, 'S', 8, true),
    preempt(4, 'H', 8, true),
    preempt(5, 'D', 9, true),
    preempt(5, 'C', 9, true),
    preempt(4, 'D', 8),
    preempt(4, 'C', 8),
    preempt(3, 'S', 7),
    preempt(3, 'H', 7),
    preempt(3, 'D', 7),
    preempt(3, 'C', 7),
    ...MAJORS.map(oneMajor),
    {
      call: '2D',
      shows: { name: 'shortDiamonds', len: { D: [0, 1], S: [3, 4], H: [3, 4], C: [4, 5] }, hcp: [11, 15], artificial: true },
      when: (h, ctx) => shortDiamondShape(h) && limitedOpening(h, ctx),
    },
    {
      call: '2C',
      shows: { len: { C: [5, 13] }, hcp: [11, 15] },
      when: (h, ctx) => longClubs(h) && limitedOpening(h, ctx),
    },
    // Whatever is left: no five-card major, not a 1NT or 2♣ or 2♦ hand, so two or more diamonds
    {
      call: '1D',
      shows: (ctx: Ctx): Spec => ({ len: { D: [2, 13] }, hcp: [light(ctx) ? 10 : 11, 15] }),
      needs: { hcp: [10, 15] },
      when: limitedOpening,
    },
    { call: 'P', shows: (ctx: Ctx) => ({ hcp: upTo(ctx.position === 4 ? 14 : 11) }) },
  ],
}
