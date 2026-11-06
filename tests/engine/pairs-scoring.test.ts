// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { mitchell } from '../../shared/movement.ts'
import { parsePairsSettings, scorePairs, type PairsResult } from '../../shared/pairs.ts'

/** `shared/pairs.ts` (e9-t12): matchpoints with the Neuberg adjustment, NS and EW ranked apart */
const result = (boardNo: number, ns: number, ew: number, scoreNS: number, round = 1, table = ns + 1): PairsResult => ({
  round,
  table,
  boardNo,
  ns,
  ew,
  boardId: `b${boardNo}-${ns}`,
  scoreNS,
  contract: null,
  declarerTricks: null,
  playedAt: 0,
})

describe('pairs scoring', () => {
  // 6 pairs, 3 tables, 3 rounds: every board played 3 times (top 4)
  const movement = mitchell(6, 1)!

  it('gives 2 a beat and 1 a tie, out of a top of 2 × (N − 1)', () => {
    const { scored } = scorePairs(movement, [result(1, 0, 3, 420), result(1, 1, 4, 420), result(1, 2, 5, -50)])
    expect(scored.map((s) => [s.mpNS, s.top])).toEqual([
      [3, 4],
      [3, 4],
      [0, 4],
    ])
    expect(scored[2].percentEW).toBe(100)
  })

  it('adjusts a board played fewer times (Neuberg)', () => {
    // Played twice of 3: the better NS gets (2 + 1) × 3/2 − 1 = 3.5 of 4
    const { scored } = scorePairs(movement, [result(1, 0, 3, 420), result(1, 1, 4, 100)])
    expect(scored[0].mpNS).toBeCloseTo(3.5)
    expect(scored[1].mpNS).toBeCloseTo(0.5)
    // Played once: 50%
    expect(scorePairs(movement, [result(2, 0, 3, 100)]).scored[0].percentNS).toBe(50)
  })

  it('ranks each field by its share of the tops, ties sharing a place', () => {
    const { standings } = scorePairs(movement, [result(1, 0, 3, 420), result(1, 1, 4, 420), result(1, 2, 5, -50)])
    const ns = standings.filter((s) => s.dir === 'NS')
    const ew = standings.filter((s) => s.dir === 'EW')
    expect(ns.map((s) => [s.pair, s.rank, s.percent])).toEqual([
      [0, 1, 75],
      [1, 1, 75],
      [2, 3, 0],
    ])
    expect(ew[0]).toMatchObject({ pair: 5, rank: 1, percent: 100 })
  })

  it('reads its settings', () => {
    expect(parsePairsSettings({})).toEqual({ title: '', boardsPerRound: 3, boardMinutes: 8 })
    expect(parsePairsSettings({ title: '  週五雙人賽 ', boardsPerRound: 2 })).toMatchObject({ title: '週五雙人賽', boardsPerRound: 2 })
    expect(parsePairsSettings({ boardsPerRound: 5 })).toBeNull()
    expect(parsePairsSettings({ boardMinutes: -1 })).toBeNull()
    expect(parsePairsSettings({ title: 'x'.repeat(41) })).toBeNull()
  })
})
