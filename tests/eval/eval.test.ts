import { describe, expect, it } from 'vitest'
import type { Contract } from '../../shared/auction.ts'
import { SEATS } from '../../shared/cards.ts'
import { EVAL_SEED, evalBoard, evalBoards, fingerprint, FULL_SET_SIZE, QUICK_SET_SIZE } from '../../eval/deals.ts'
import { playMatch, type RobotConfig } from '../../eval/match.ts'
import { parseConfig } from '../../eval/config.ts'
import { brainWithErrorRate } from '../../eval/rates.ts'
import { matchReport } from '../../eval/report.ts'
import { paramsOf } from '../../shared/robot/levels.ts'
import { boardImps, meanAndError, regressed, summarize, type BoardOutcome, type TableResult } from '../../eval/stats.ts'

const contract = (text: string, declarer: Contract['declarer'], doubled: Contract['doubled'] = ''): Contract => ({
  level: Number(text[0]),
  strain: text[1] as Contract['strain'],
  doubled,
  declarer,
})
const table = (c: Contract | null, declarerTricks: number, scoreNS: number): TableResult => ({ contract: c, declarerTricks, scoreNS })
const board = (boardNo: number, table1: TableResult, table2: TableResult): BoardOutcome => ({ boardNo, table1, table2 })

describe('evaluation: scoring a match', () => {
  // A bids 4♠ making at table 1 (+420); B stops in 2♠ at table 2 (+170 to B, North-South)
  const game = board(1, table(contract('4S', 'N'), 10, 420), table(contract('2S', 'S'), 10, 170))
  // Both tables 3NT by North, +400 and +430: A loses 30 points (1 IMP) and the board on matchpoints
  const overtrick = board(2, table(contract('3N', 'N'), 9, 400), table(contract('3N', 'N'), 10, 430))
  // The same result: a tie
  const flat = board(3, table(contract('1N', 'E'), 7, -90), table(contract('1N', 'E'), 7, -90))
  // A, East-West at table 2, defeats 4♥ doubled by North (+300 to A); at table 1 A goes down in 3♥ (−100)
  const sacrifice = board(4, table(contract('3H', 'S'), 8, -100), table(contract('4H', 'N', 'X'), 8, -300))

  it('scores IMPs from table 1 minus table 2 North-South', () => {
    expect(boardImps(game)).toBe(6)
    expect(boardImps(overtrick)).toBe(-1)
    expect(boardImps(flat)).toBe(0)
    expect(boardImps(sacrifice)).toBe(5)
  })

  it('averages IMPs per board with the sample standard error', () => {
    const s = summarize([game, overtrick, flat, sacrifice])
    expect(s.imps).toBe(10)
    expect(s.impsPerBoard).toBe(2.5)
    // Deviations 3.5, −3.5, −2.5, 2.5: variance 37 / 3, error sqrt(37 / 12)
    expect(s.standardError).toBeCloseTo(Math.sqrt(37 / 12), 10)
    expect(s.ci95[0]).toBeCloseTo(2.5 - 1.96 * Math.sqrt(37 / 12), 10)
    expect(s.ci95[1]).toBeCloseTo(2.5 + 1.96 * Math.sqrt(37 / 12), 10)
  })

  it('scores matchpoints on any difference, ties half', () => {
    const s = summarize([game, overtrick, flat, sacrifice])
    expect([s.won, s.lost, s.tied]).toEqual([2, 1, 1])
    expect(s.mpPercent).toBe(62.5)
  })

  it('counts contracts for the side that declared', () => {
    const s = summarize([game, overtrick, flat, sacrifice])
    expect(s.sameContract).toBe(2)
    // A declares 4♠ (table 1), 3NT (table 1), 3♥ (table 1) and 1NT by East at table 2
    expect(s.a).toEqual({ declared: 4, made: 3, down: 1, partscores: 2, games: 2, slams: 0, doubled: 0 })
    expect(s.b).toEqual({ declared: 4, made: 3, down: 1, partscores: 2, games: 2, slams: 0, doubled: 1 })
  })

  it('handles passed-out boards and a single board', () => {
    const s = summarize([board(1, table(null, 0, 0), table(contract('1C', 'W'), 7, -70))])
    expect(s.passedOut).toBe(1)
    expect(s.impsPerBoard).toBe(2)
    expect(s.standardError).toBe(0)
    expect(meanAndError([]).mean).toBe(0)
  })

  it('fails the gate only beyond two standard errors and the floor', () => {
    const at = (impsPerBoard: number, standardError: number) => regressed({ ...summarize([]), impsPerBoard, standardError })
    expect(at(-0.5, 0.2)).toBe(true)
    // Within two standard errors: could be chance
    expect(at(-0.5, 0.3)).toBe(false)
    // Beyond two standard errors but under the floor of 0.25 IMP/board
    expect(at(-0.2, 0.05)).toBe(false)
    expect(at(0.5, 0.1)).toBe(false)
  })

  it('writes a report', () => {
    const report = matchReport({ a: 'tku:college', b: 'tku:beginner', boards: 'boards 1–4' }, summarize([game, overtrick, flat, sacrifice]))
    expect(report).toContain('**+2.50**')
    expect(report).toContain('62.5%')
  })
})

describe('evaluation: deal sets', () => {
  it('deals the same boards from the same seed, other boards from another', () => {
    expect(evalBoards(20)).toEqual(evalBoards(20))
    expect(evalBoards(20, 'other')).not.toEqual(evalBoards(20))
    // A board does not depend on the others: board 4,001 alone is board 4,001 of the run
    expect(evalBoards(3, EVAL_SEED, 4001)[0]).toEqual(evalBoard(4001))
    expect(evalBoards(QUICK_SET_SIZE)).toEqual(evalBoards(FULL_SET_SIZE).slice(0, QUICK_SET_SIZE))
  })

  it('deals 13 different cards to each seat', () => {
    for (const { hands } of evalBoards(50)) {
      expect(SEATS.map((seat) => hands[seat].length)).toEqual([13, 13, 13, 13])
      expect(new Set(SEATS.flatMap((seat) => hands[seat])).size).toBe(52)
    }
  })

  it('keeps the sets the platform measured on (a changed fingerprint means a new set: change EVAL_SEED)', () => {
    expect(evalBoard(1).hands.N).toEqual(['SQ', 'ST', 'S3', 'HK', 'HQ', 'HT', 'H9', 'DJ', 'D4', 'C9', 'C5', 'C3', 'C2'])
    expect(fingerprint(evalBoards(QUICK_SET_SIZE))).toBe('161ffaa1')
    expect(fingerprint(evalBoards(FULL_SET_SIZE))).toBe('d086c36a')
  })
})

describe('evaluation: robot matches', () => {
  const config = (kind: RobotConfig['kind'], level: RobotConfig['level']): RobotConfig => ({ name: `${kind}:${level}`, kind, level })

  it('scores exactly 0 on every board when a configuration plays itself, with mistakes', async () => {
    for (const robot of [config('tku', 'college'), config('gib', 'beginner')]) {
      const outcomes = await playMatch({ a: robot, b: { ...robot }, boards: evalBoards(16) })
      expect(outcomes.map(boardImps)).toEqual(Array(16).fill(0))
      expect(outcomes.every((o) => o.table1.scoreNS === o.table2.scoreNS)).toBe(true)
    }
  })

  it('seats A North-South at table 1 and East-West at table 2, reproducibly', async () => {
    const boards = evalBoards(8)
    const a = config('tku', 'college')
    const b = config('tku', 'beginner')
    const first = await playMatch({ a, b, boards })
    expect(await playMatch({ a, b, boards })).toEqual(first)
    // Swapping A and B swaps the tables: B's IMPs are A's negated
    const swapped = await playMatch({ a: b, b: a, boards })
    expect(swapped.map((o) => o.table1)).toEqual(first.map((o) => o.table2))
    expect(swapped.map(boardImps)).toEqual(first.map((o) => -boardImps(o) || 0))
  })

  it('overrides a level error rate for the calibration (err=), the level rate unchanged', async () => {
    const boards = evalBoards(12)
    // The level's own rate through the override plays exactly like the level
    const beginner = config('gib', 'beginner')
    const same = await playMatch({ a: beginner, b: { ...beginner, brain: brainWithErrorRate(0.15) }, boards })
    expect(same.map(boardImps)).toEqual(Array(12).fill(0))
    // 大專 at another rate is another robot; at 0 it is 大專 itself
    const college = config('tku', 'college')
    const erring = await playMatch({ a: college, b: { ...college, brain: brainWithErrorRate(0.3) }, boards })
    expect(erring.some((o) => o.table1.scoreNS !== o.table2.scoreNS)).toBe(true)
    const zero = await playMatch({ a: college, b: { ...college, brain: brainWithErrorRate(0) }, boards })
    expect(zero.map(boardImps)).toEqual(Array(12).fill(0))
    expect(paramsOf('college').errorRate).toBe(0)
    expect(() => brainWithErrorRate(1.5)).toThrow()
    expect((await parseConfig('tku:college,err=0.05')).brain).toBeDefined()
    await expect(parseConfig('tku:college,err=x')).rejects.toThrow()
  })
})
