// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { hcp, SEATS } from '../../shared/cards.ts'
import { meetsConditions } from '../../shared/dealer.ts'
import { deckSeed, readArgs } from '../../eval/config.ts'
import { EVAL_SEED, evalBoard, SLAM_CONDITIONS } from '../../eval/deals.ts'
import { biddingReport, biddingStudy, slamCellOf, type BiddingRecord } from '../../eval/sim/bidding.ts'

describe('the slam-zone deal set (V4d)', () => {
  it('deals North–South 30–36, or 26–29 with a nine-card fit, the same board every time', () => {
    for (let n = 1; n <= 60; n++) {
      const board = evalBoard(n, 'slam:' + EVAL_SEED)
      expect(board).toEqual(evalBoard(n, 'slam:' + EVAL_SEED))
      expect(SEATS.flatMap((s) => board.hands[s]).sort()).toHaveLength(52)
      expect(new Set(SEATS.flatMap((s) => board.hands[s])).size).toBe(52)
      expect(meetsConditions(SLAM_CONDITIONS, board.hands)).toBe(true)
      const ns = hcp([...board.hands.N, ...board.hands.S])
      expect(ns).toBeGreaterThanOrEqual(26)
      expect(ns).toBeLessThanOrEqual(36)
    }
    // The usual set is untouched
    expect(evalBoard(1)).toEqual(evalBoard(1, EVAL_SEED))
  })

  it('reads --deck slam as the seed’s slam set', () => {
    expect(deckSeed(readArgs(['--deck', 'slam']))).toBe('slam:' + EVAL_SEED)
    expect(deckSeed(readArgs(['--deck', 'slam', '--seed', 'x']))).toBe('slam:x')
    expect(deckSeed(readArgs(['--seed', 'slam:x', '--deck', 'slam']))).toBe('slam:x')
    expect(deckSeed(readArgs([]))).toBe(EVAL_SEED)
    expect(() => deckSeed(readArgs(['--deck', 'grand']))).toThrow()
  })
})

const record = (board: number, contract: string, tricks: number, score: number, par: number, strongHcp = 31): BiddingRecord => ({
  board,
  system: 'tku',
  dealer: 'N',
  vul: 'None',
  auction: '1S-P-4S-P-P-P',
  contract,
  par,
  strong: { side: 'NS', hcp: strongHcp, tricks, score },
  points: [],
})

describe('the slam-zone summary of the bidding study (V4d)', () => {
  it('sorts the stronger side’s boards by tricks double dummy and how high TKB bid', () => {
    expect(slamCellOf(record(1, '4S-N', 12, 680, 1430))).toEqual({ tricks: '12', reached: 'below' })
    expect(slamCellOf(record(2, '6S-S', 11, -50, 650))).toEqual({ tricks: '≤11', reached: 'small' })
    expect(slamCellOf(record(3, '7N-N', 13, 1520, 1520))).toEqual({ tricks: '13', reached: 'grand' })
    // The other side's contract is not our slam
    expect(slamCellOf(record(4, '6HX-E', 12, 800, 1430))).toEqual({ tricks: '12', reached: 'below' })
    // Not the slam zone
    expect(slamCellOf(record(5, '4S-N', 10, 420, 420, 25))).toBeNull()
    const study = biddingStudy([record(1, '4S-N', 12, 680, 1430), record(6, '4S-N', 12, 680, 1430), record(3, '7N-N', 13, 1520, 1520)])
    expect(study.slam).toEqual([
      { tricks: '12', reached: 'below', boards: 2, vsPar: -13, error: 0 },
      { tricks: '13', reached: 'grand', boards: 1, vsPar: 0, error: 0 },
    ])
    expect(biddingReport(study, 'test')).toContain('## 滿貫區')
  })
})
