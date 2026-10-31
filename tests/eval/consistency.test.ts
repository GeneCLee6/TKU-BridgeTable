// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { auctionCheck, auctionConflicts, consistencyCheck, contradictions, wider } from '../../eval/consistency.ts'

/**
 * X2: a later call is never explained as something the player's earlier calls ruled out (eval/README.md
 * §consistency). A fixed sample, so the count can only go down: lower `MOST` when a fix lowers it.
 */

/** Conflicts allowed in the sample (a ratchet: never raise it) */
const MOST = { tku: 0, gib: 0 }

/** Explanations wider than what the player had shown, allowed in the sample (Y2; a ratchet too) */
const MOST_WIDE = { tku: 0, gib: 0 }

describe('contradictions', () => {
  it('flags ranges that do not overlap, and nothing else', () => {
    expect(contradictions({ hcp: [11, 40] }, { hcp: [7, 10] })).toEqual([{ feature: 'hcp', known: [11, 40], shown: [7, 10] }])
    expect(contradictions({ hcp: [11, 40] }, { hcp: [6, 40] })).toEqual([])
    expect(contradictions({ len: { S: [5, 13] } }, { len: { S: [0, 3] } })).toEqual([{ feature: 'len S', known: [5, 13], shown: [0, 3] }])
    expect(contradictions({ hcp: [12, 14] }, { tp: [0, 11] })).toEqual([{ feature: 'tp', known: [12, 14], shown: [0, 11] }])
    expect(contradictions({ len: { S: [5, 13], H: [5, 13] } }, { len: { D: [4, 13] } })).toEqual([{ feature: 'shape' }])
  })
})

describe('wider', () => {
  it('flags a mentioned feature wider than its overlap with what was shown, and nothing else', () => {
    expect(wider({ hcp: [11, 15] }, { hcp: [6, 40] })).toEqual([{ feature: 'hcp', shown: [6, 40], narrowed: [11, 15] }])
    expect(wider({ len: { S: [5, 13] } }, { len: { S: [3, 13] } })).toEqual([{ feature: 'len S', shown: [3, 13], narrowed: [5, 13] }])
    // Features the call does not mention are not added, and a range inside what was shown is fine
    expect(wider({ hcp: [11, 15], len: { S: [5, 13] } }, { hcp: [12, 13] })).toEqual([])
    expect(wider({ quality: { S: 'solid' } }, { quality: { S: 'biddable' } })).toEqual([{ feature: 'quality S', shown: 'biddable', narrowed: 'solid' }])
  })
})

describe('the consistency check', () => {
  it('reads a TKU raise of a raise as the support already shown, not a fifth card', () => {
    // 1♣ 1♥ 2♥ (four hearts) 3♥ 4♥: opener still has four
    const calls = ['1C', 'P', '1H', 'P', '2H', 'P', '3H', 'P', '4H']
    const seats = ['N', 'E', 'S', 'W'] as const
    const auction = calls.map((call, i) => ({ seat: seats[i % 4], call }))
    expect(auctionConflicts({ system: 'tku', source: 'inference', id: 't', dealer: 'N', vul: 'None', auction })).toEqual([])
  })

  it('explains a responder who showed 6+ HCP as 6–8, not 5–8, when he later bids 2/1 lebensohl', () => {
    const calls = ['1C', 'P', '1S', 'P', '2D', 'P', '2N']
    const seats = ['N', 'E', 'S', 'W'] as const
    const auction = calls.map((call, i) => ({ seat: seats[i % 4], call }))
    expect(auctionCheck({ system: 'gib', source: 'inference', id: 't', dealer: 'N', vul: 'None', auction }).wide).toEqual([])
  })

  it('finds no more conflicts or over-wide explanations than before in a fixed sample', () => {
    const { conflicts, wide, calls } = consistencyCheck({ deals: 200 })
    expect(calls['tku deal']).toBeGreaterThan(1000)
    expect(calls['gib quiz']).toBeGreaterThan(100)
    for (const system of ['tku', 'gib'] as const) {
      const mine = conflicts.filter((c) => c.system === system)
      expect(mine.length, mine.map((c) => `${c.source} ${c.id}: ${c.pattern} ${c.feature}`).join('\n')).toBeLessThanOrEqual(MOST[system])
      const loose = wide.filter((w) => w.system === system)
      expect(loose.length, loose.map((w) => `${w.source} ${w.id}: ${w.pattern} ${w.feature}`).join('\n')).toBeLessThanOrEqual(MOST_WIDE[system])
    }
  }, 120_000)
})
