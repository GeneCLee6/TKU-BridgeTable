import { describe, expect, it } from 'vitest'
import type { Card } from '../../shared/cards.ts'
import { evaluate, revalue } from '../../shared/robot/system/evaluate.ts'

/** A hand from text like 'AKQ2 KJ3 Q54 32' (♠ ♥ ♦ ♣; '-' for a void) */
function hand(text: string): Card[] {
  return text.split(' ').flatMap((ranks, i) => [...ranks.replace('-', '')].map((r) => 'SHDC'[i] + r))
}

describe('hand evaluation (e5-t39)', () => {
  it('counts high cards, length, shortness, losers, quick tricks and controls', () => {
    const flat = evaluate(hand('AK32 K32 Q32 J32'))
    expect(flat).toMatchObject({ hcp: 13, lengthPoints: 0, shortPoints: 0, losers: 8, quickTricks: 2.5, controls: 4 })
    expect(flat).toMatchObject({ honours: 0, adjusted: 13, rule20: 20 })

    const shapely = evaluate(hand('AKJ32 KQ32 K 432'))
    expect(shapely).toMatchObject({ hcp: 16, lengthPoints: 1, shortPoints: 2, losers: 6, quickTricks: 3, controls: 5 })
    // +1 for the strong spades, −1 for the singleton king
    expect(shapely).toMatchObject({ honours: 0, adjusted: 17, rule20: 25 })
    expect(evaluate(hand('AKQJ32 - 5432 432')).shortPoints).toBe(3)
  })

  it('scores quick tricks suit by suit', () => {
    const qt = (text: string) => evaluate(hand(text)).quickTricks
    expect(qt('AK2 432 5432 432')).toBe(2)
    expect(qt('AQ2 432 5432 432')).toBe(1.5)
    expect(qt('A32 432 5432 432')).toBe(1)
    expect(qt('KQ2 432 5432 432')).toBe(1)
    expect(qt('K32 432 5432 432')).toBe(0.5)
    expect(qt('K 5432 5432 5432')).toBe(0)
  })

  it('adds for honours in long suits and takes off for short honours', () => {
    const honours = (text: string) => evaluate(hand(text)).honours
    expect(honours('KQJ32 432 432 32')).toBe(1)
    expect(honours('K5432 432 432 32')).toBe(0)
    expect(honours('Q A5432 QJ 65432')).toBe(-2)
    expect(honours('J2 A5432 432 432')).toBe(-1)
    expect(honours('AJ KQ 5432 65432')).toBe(0)
    expect(honours('A 5432 5432 5432')).toBe(0)
    const h = evaluate(hand('Q A5432 QJ 65432'))
    expect(h.adjusted).toBe(9 + 2 - 2)
  })

  it('gives the Rule of 20 total for an 11-point two-suiter', () => {
    const h = evaluate(hand('AK432 KJ432 32 2'))
    expect(h.hcp).toBe(11)
    expect(h.rule20).toBe(21)
  })
})

describe('re-evaluation after the auction (e5-t40)', () => {
  it('moves kings and queens by where the bidder sits', () => {
    const h = evaluate(hand('AK32 K32 Q32 J32'))
    expect(revalue(h, {}).points).toBe(13)
    expect(revalue(h, { rho: ['D'] })).toMatchObject({ points: 14, position: 1 })
    expect(revalue(h, { lho: ['H'] })).toMatchObject({ points: 12, position: -1 })
    expect(revalue(h, { rho: ['C'] }).position).toBe(0)
    expect(revalue(h, { rho: ['D'], lho: ['D'] }).position).toBe(0)
  })

  it('counts a four-trump dummy’s void, promoted trump honours and the ninth trump', () => {
    const h = evaluate(hand('A432 Q654 - K5432'))
    expect(h.adjusted).toBe(10)
    expect(revalue(h, { trump: 'H', partnerTrumps: 5 })).toEqual({
      points: 9 + 5 + 1 + 1,
      fit: 9,
      shortness: 5,
      trumpHonours: 1,
      extraTrumps: 1,
      position: 0,
    })
  })

  it('counts less for a three-trump dummy and for a singleton honour', () => {
    const h = evaluate(hand('K Q32 A5432 5432'))
    expect(h.adjusted).toBe(9)
    expect(revalue(h, { trump: 'H', partnerTrumps: 5 })).toMatchObject({ points: 10, fit: 8, shortness: 1 })
  })

  it('gives back the short-honour deduction for a queen in trumps', () => {
    const h = evaluate(hand('A5432 Q2 K432 32'))
    expect(revalue(h, { trump: 'H', partnerTrumps: 6 })).toMatchObject({ points: 10, shortness: 0, trumpHonours: 2 })
  })

  it('revalues the long-trump hand with fewer shortness points', () => {
    const h = evaluate(hand('AKJ32 KQ32 K 432'))
    expect(revalue(h, { trump: 'S', partnerTrumps: 3 })).toMatchObject({ points: 18, shortness: 0, trumpHonours: 1 })
    expect(revalue(h, { trump: 'S', partnerTrumps: 4 })).toMatchObject({ points: 19, extraTrumps: 1 })
    expect(revalue(evaluate(hand('AKJ32 KQ32 - 5432')), { trump: 'S', partnerTrumps: 3 }).shortness).toBe(2)
  })

  it('does not count shortness without an eight-card fit', () => {
    const h = evaluate(hand('AKJ32 KQ32 K 432'))
    expect(revalue(h, { trump: 'S', partnerTrumps: 2 })).toMatchObject({ points: 17, fit: 7, shortness: 0 })
  })
})
