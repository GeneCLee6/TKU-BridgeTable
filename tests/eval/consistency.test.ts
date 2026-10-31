// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { auctionConflicts, consistencyCheck, contradictions } from '../../eval/consistency.ts'

/**
 * X2: a later call is never explained as something the player's earlier calls ruled out (eval/README.md
 * §consistency). A fixed sample, so the count can only go down: lower `MOST` when a fix lowers it.
 */

/** Conflicts allowed in the sample (a ratchet: never raise it) */
const MOST = { tku: 0, gib: 0 }

describe('contradictions', () => {
  it('flags ranges that do not overlap, and nothing else', () => {
    expect(contradictions({ hcp: [11, 40] }, { hcp: [7, 10] })).toEqual([{ feature: 'hcp', known: [11, 40], shown: [7, 10] }])
    expect(contradictions({ hcp: [11, 40] }, { hcp: [6, 40] })).toEqual([])
    expect(contradictions({ len: { S: [5, 13] } }, { len: { S: [0, 3] } })).toEqual([{ feature: 'len S', known: [5, 13], shown: [0, 3] }])
    expect(contradictions({ hcp: [12, 14] }, { tp: [0, 11] })).toEqual([{ feature: 'tp', known: [12, 14], shown: [0, 11] }])
    expect(contradictions({ len: { S: [5, 13], H: [5, 13] } }, { len: { D: [4, 13] } })).toEqual([{ feature: 'shape' }])
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

  it('finds no more conflicts than before in a fixed sample', () => {
    const { conflicts, calls } = consistencyCheck({ deals: 200 })
    expect(calls['tku deal']).toBeGreaterThan(1000)
    expect(calls['gib quiz']).toBeGreaterThan(100)
    for (const system of ['tku', 'gib'] as const) {
      const mine = conflicts.filter((c) => c.system === system)
      expect(mine.length, mine.map((c) => `${c.source} ${c.id}: ${c.pattern} ${c.feature}`).join('\n')).toBeLessThanOrEqual(MOST[system])
    }
  }, 120_000)
})
