import { describe, expect, it } from 'vitest'
import { hcp, SEATS, SUITS, type Hands } from '../../shared/cards.ts'
import { DEAL_PRESET_IDS, DEAL_PRESETS } from '../../shared/deal-presets.ts'
import { conditionsProblem, dealWith, meetsConditions, type DealConditions } from '../../shared/dealer.ts'

/** mulberry32: a small seeded generator with good low bits */
function seeded(seed: number) {
  return (n: number) => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n)
  }
}

const shape = (cards: string[]) =>
  SUITS.map((s) => cards.filter((c) => c[0] === s).length)
    .sort((a, b) => b - a)
    .join('')
function many(conditions: DealConditions | DealConditions[], count: number, seed = 1): Hands[] {
  const random = seeded(seed)
  return Array.from({ length: count }, () => {
    const result = dealWith(conditions, random)
    if (!result.ok) throw new Error('no deal')
    return result.hands
  })
}
const share = (hands: Hands[], test: (h: Hands) => boolean) => hands.filter(test).length / hands.length
const near = (actual: number, expected: number, within: number) => expect(Math.abs(actual - expected)).toBeLessThan(within)

describe('the constrained dealer', () => {
  it('deals 52 different cards, 13 to a hand', () => {
    for (const hands of many({}, 50)) {
      expect(new Set(SEATS.flatMap((s) => hands[s])).size).toBe(52)
      for (const seat of SEATS) expect(hands[seat]).toHaveLength(13)
    }
  })

  it('with no conditions, deals shapes and points at the odds of a random deal', () => {
    const deals = many({}, 20_000)
    // 4-4-3-2 21.55%, 5-3-3-2 15.52%, 5-4-3-1 12.93%, 4-3-3-3 10.54%
    near(share(deals, (h) => shape(h.S) === '4432'), 0.2155, 0.015)
    near(share(deals, (h) => shape(h.S) === '5332'), 0.1552, 0.015)
    near(share(deals, (h) => shape(h.S) === '5431'), 0.1293, 0.015)
    near(share(deals, (h) => shape(h.S) === '4333'), 0.1054, 0.015)
    near(deals.reduce((sum, h) => sum + hcp(h.S), 0) / deals.length, 10, 0.1)
  })

  it('keeps the odds among the deals that meet the conditions', () => {
    // Among balanced hands: 4-4-3-2 45.3%, 5-3-3-2 32.6%, 4-3-3-3 22.1%
    const balanced = many({ seats: { S: { balanced: true } } }, 8000, 2)
    near(share(balanced, (h) => shape(h.S) === '4432'), 0.453, 0.02)
    near(share(balanced, (h) => shape(h.S) === '5332'), 0.326, 0.02)
    // Among 15–17 hands: 15 is 43.7%, 16 32.9%, 17 23.4%
    const strong = many({ seats: { S: { hcp: [15, 17] } } }, 8000, 3)
    near(share(strong, (h) => hcp(h.S) === 15), 0.437, 0.02)
    near(share(strong, (h) => hcp(h.S) === 17), 0.234, 0.02)
  })

  it('meets every kind of condition at once', () => {
    const conditions: DealConditions = {
      seats: { N: { hcp: [0, 5] }, W: { lengths: { S: [6, 13], H: [0, 1] } } },
      sides: { NS: { hcp: [20, 24] } },
    }
    for (const hands of many(conditions, 200, 4)) {
      expect(hcp(hands.N)).toBeLessThanOrEqual(5)
      expect(hcp(hands.N) + hcp(hands.S)).toBeGreaterThanOrEqual(20)
      expect(hands.W.filter((c) => c[0] === 'S').length).toBeGreaterThanOrEqual(6)
      expect(meetsConditions(conditions, hands)).toBe(true)
    }
  })

  it('accepts any one of a list of alternatives, each about as often', () => {
    const spades: DealConditions = { seats: { S: { lengths: { S: [7, 13] } } } }
    const hearts: DealConditions = { seats: { S: { lengths: { H: [7, 13] } } } }
    const deals = many([spades, hearts], 400, 5)
    expect(deals.every((h) => meetsConditions([spades, hearts], h))).toBe(true)
    near(share(deals, (h) => meetsConditions(spades, h)), 0.5, 0.1)
  })

  it('gives up after its attempts, and says which condition can never be met', () => {
    const random = seeded(6)
    expect(dealWith({ seats: { S: { hcp: [36, 37] } } }, random, 2000)).toEqual({ ok: false, attempts: 2000 })
    expect(dealWith({ seats: { S: { hcp: [20, 10] } } }, random)).toEqual({ ok: false, attempts: 0 })
    expect(conditionsProblem({ seats: { S: { hcp: [20, 10] } } })).toBe('S.hcp')
    expect(conditionsProblem({ seats: { E: { lengths: { S: [7, 13], H: [7, 13] } } } })).toBe('E.lengths')
    expect(conditionsProblem({ seats: { N: { lengths: { C: [7, 13] } }, S: { lengths: { C: [7, 13] } } } })).toBe('lengths.C')
    expect(conditionsProblem({ sides: { EW: { hcp: [0, 41] } } })).toBe('EW.hcp')
    expect(conditionsProblem(DEAL_PRESETS.slam[0])).toBeNull()
  })

  it('has presets that deal quickly and meet their own conditions', () => {
    const random = seeded(7)
    for (const id of DEAL_PRESET_IDS) {
      for (let i = 0; i < 30; i++) {
        const result = dealWith(DEAL_PRESETS[id], random)
        expect(result.ok, id).toBe(true)
        if (!result.ok) continue
        expect(meetsConditions(DEAL_PRESETS[id], result.hands), id).toBe(true)
        expect(result.attempts, id).toBeLessThan(20_000)
      }
    }
  })
})
