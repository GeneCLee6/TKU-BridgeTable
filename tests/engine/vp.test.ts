import { describe, expect, it } from 'vitest'
import { matchVictoryPoints, victoryPoints, vpBlitz } from '../../shared/vp.ts'

describe('the WBF continuous VP scale (e8-t22)', () => {
  it('gives the published 16-board values', () => {
    // WBF's 16-board table: the blitz is 60 IMPs, a third of it is exactly 15 VP
    expect(vpBlitz(16)).toBe(60)
    expect([0, 1, 2, 3, 4, 5, 10, 20, 30].map((m) => victoryPoints(m, 16))).toEqual([10, 10.31, 10.61, 10.91, 11.2, 11.48, 12.8, 15, 16.73])
    expect(victoryPoints(59, 16)).toBe(19.92)
    expect(victoryPoints(60, 16)).toBe(20)
    expect(victoryPoints(95, 16)).toBe(20)
  })

  it('gives the 8-board values, whose blitz is 15 × √8', () => {
    expect([1, 2, 3, 10].map((m) => victoryPoints(m, 8))).toEqual([10.44, 10.86, 11.27, 13.78])
    expect(victoryPoints(43, 8)).toBe(20)
  })

  it('gives the loser what the winner leaves of 20', () => {
    for (const boards of [4, 8, 12, 16, 24, 32])
      for (let margin = 0; margin <= 100; margin++) {
        const won = matchVictoryPoints({ A: 10 + margin, B: 10 }, boards)
        expect(Math.round((won.A + won.B) * 100)).toBe(2000)
        expect(victoryPoints(-margin, boards)).toBe(won.B)
        // Never less for a bigger margin
        if (margin > 0) expect(won.A).toBeGreaterThanOrEqual(victoryPoints(margin - 1, boards))
      }
    expect(matchVictoryPoints({ A: 12, B: 30 }, 16)).toEqual({ A: 5.4, B: 14.6 })
    expect(matchVictoryPoints({ A: 7, B: 7 }, 16)).toEqual({ A: 10, B: 10 })
  })
})
