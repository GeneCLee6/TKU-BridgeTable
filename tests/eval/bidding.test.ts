// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { legalCalls, seatToCall, type AuctionCall, type Call } from '../../shared/auction.ts'
import { SUITS, type Card, type Hands, type Seat } from '../../shared/cards.ts'
import { imps } from '../../shared/imp.ts'
import { parsePracticeSet } from '../../shared/practice-sets/index.ts'
import { evalBoard } from '../../eval/deals.ts'
import {
  alternativesFor,
  classify,
  biddingRecord,
  biddingReport,
  biddingStudy,
  altKind,
  CATEGORIES,
  COMPETE_CATEGORIES,
  CONSTRUCTIVE,
  direction,
  hcpBucket,
  contractKey,
  practiceDeals,
  scoreOn,
  type BiddingPoint,
  type BiddingRecord,
  type PracticeDeal,
} from '../../eval/sim/bidding.ts'
import { loadSolver, pbnOf, type DdTable, type Solver } from '../../eval/sim/dds.ts'
import { chunked, Pool } from '../../eval/sim/pool.ts'
import { JsonlStore } from '../../eval/sim/store.ts'

/** The hands of a PBN deal, North first ('N:… … … …') */
const handsFromPbn = (pbn: string): Hands => {
  const parts = pbn.slice(2).split(' ')
  return Object.fromEntries((['N', 'E', 'S', 'W'] as const).map((seat, i) => [seat, hand(parts[i])])) as Hands
}

/** A practice set in the repository */
const practiceSet = (name: string): PracticeDeal[] => {
  const file = new URL(`../../shared/practice-sets/${name}.json`, import.meta.url)
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as PracticeDeal[]) : []
}

const hand = (text: string): Card[] => text.split('.').flatMap((ranks, i) => [...ranks].map((r) => SUITS[i] + r))

/** Calls from North as the dealer */
const auction = (...calls: Call[]): AuctionCall[] => calls.map((call, i) => ({ seat: seatToCall('N', i), call }))
const next = (calls: AuctionCall[]): Seat => seatToCall('N', calls.length)

const flat = (n: number) => ({ N: n, E: n, S: n, W: n })
const tableOf = (tricks: Partial<Record<keyof DdTable, Record<Seat, number>>>): DdTable => ({ S: flat(0), H: flat(0), D: flat(0), C: flat(0), N: flat(0), ...tricks })

describe('bidding: the kinds of decision', () => {
  const takeout = hand('KQ32.4.A982.KJ32') // 13, short in hearts
  const overcall = hand('KQJ93.A4.982.932') // 10, five spades

  it('sorts the first decision against a one-level opening by the hand and the seat', () => {
    const one = auction('1H')
    expect(classify(one, next(one), takeout)).toEqual({ category: 'takeout', level: 1 })
    expect(classify(one, next(one), overcall)).toEqual({ category: 'direct', level: 1 })
    const passed = auction('1H', 'P', 'P')
    expect(classify(passed, next(passed), overcall)).toEqual({ category: 'balancing', level: 1 })
    const raised = auction('1H', 'P', '2H', 'P', 'P')
    expect(classify(raised, next(raised), overcall)).toEqual({ category: 'balancing', level: 2 })
  })

  it('knows 1NT, preempts and the high level, and leaves out the rest', () => {
    const nt = auction('1N')
    expect(classify(nt, next(nt), takeout)?.category).toBe('notrump')
    const stayman = auction('1N', 'P', '2C')
    expect(classify(stayman, next(stayman), takeout)).toBeNull()
    const weak = auction('2S')
    expect(classify(weak, next(weak), takeout)).toEqual({ category: 'preempt', level: 2 })
    const strong = auction('2C')
    expect(classify(strong, next(strong), takeout)).toBeNull()
    const game = auction('1H', 'P', '4H')
    expect(classify(game, next(game), takeout)).toEqual({ category: 'high', level: 4 })
    const competed = auction('1H', '1S', '4H')
    expect(classify(competed, next(competed), overcall)).toEqual({ category: 'high', level: 4 })
    const partscore = auction('1H', '1S', '2H')
    expect(classify(partscore, next(partscore), overcall)).toBeNull()
    const asking = auction('1S', 'P', '4N')
    expect(classify(asking, next(asking), takeout)).toBeNull()
    const answer = auction('1S', 'P', '4S', 'P', '4N', 'P', '5H')
    expect(classify(answer, next(answer), takeout)).toBeNull()
  })

  it('sorts constructive decisions and ours after they come in', () => {
    expect(classify([], 'N', takeout)).toEqual({ category: 'opening', level: 0 })
    const passed = auction('P', 'P')
    expect(classify(passed, next(passed), takeout)?.category).toBe('opening')
    const response = auction('1H', 'P')
    expect(classify(response, next(response), takeout)).toEqual({ category: 'response', level: 1 })
    const rebid = auction('1H', 'P', '1S', 'P')
    expect(classify(rebid, next(rebid), takeout)).toEqual({ category: 'game', level: 1 })
    const invite = auction('1H', 'P', '2H', 'P', '3H', 'P')
    expect(classify(invite, next(invite), takeout)).toEqual({ category: 'game', level: 3 })
    const game = auction('1H', 'P', '4H', 'P')
    expect(classify(game, next(game), takeout)).toEqual({ category: 'slam', level: 4 })
    const contested = auction('1H', '2C')
    expect(classify(contested, next(contested), takeout)).toEqual({ category: 'contested', level: 2 })
  })
})

describe('bidding: what an alternative is', () => {
  it('names the alternative next to TKB’s call and which way it goes', () => {
    expect(altKind('2H', 'P')).toBe('pass')
    expect(altKind('3H', '2H')).toBe('lower')
    expect(altKind('3H', '4H')).toBe('higher')
    expect(altKind('3N', '4H')).toBe('strain')
    expect(altKind('P', 'X')).toBe('double')
    expect(altKind('P', '2S')).toBe('bid')
    expect(direction('3H', 'P')).toBe('conservative')
    expect(direction('3H', '4H')).toBe('aggressive')
    expect(direction('P', '3H')).toBe('aggressive')
    expect(direction('3N', '4H')).toBe('other')
    expect(['–17', '23–24', '33+'].map((b, i) => hcpBucket([12, 24, 35][i]) === b)).toEqual([true, true, true])
  })

  it('tries opening, responding, bidding on and slam from what the bidder knows', () => {
    const partner = (lo: number, len: Partial<Record<'S' | 'H' | 'D' | 'C', number>> = {}) => ({ hcp: [lo, lo + 3] as const, len: { S: 0, H: 0, D: 0, C: 0, ...len } })
    expect(alternativesFor([], 'N', 'N', hand('KQ32.4.A9832.K32'), 'opening', 'P')).toEqual(['1D'])
    expect(alternativesFor([], 'N', 'N', hand('KQ32.4.A9832.K32'), 'opening', '1D')).toEqual(['P'])
    expect(alternativesFor([], 'N', 'N', hand('J432.4.98632.K32'), 'opening', 'P')).toEqual([])
    const opened = auction('1H', 'P')
    expect(alternativesFor(opened, 'N', 'S', hand('K32.Q54.9863.J32'), 'response', 'P')).toEqual(['2H', '1N'])
    expect(alternativesFor(opened, 'N', 'S', { hand: hand('K32.Q54.9863.J32'), partner: partner(12, { H: 5 }) }, 'response', '2H')).toEqual(['P', '3H'])
    // 1♥ P 2♥ P ?: opener with 15 bids on, from partner's 6 points on
    const raised = auction('1H', 'P', '2H', 'P')
    const opener = { hand: hand('A2.AKJ54.K93.Q32'), partner: partner(6, { H: 3 }) }
    expect(alternativesFor(raised, 'N', 'N', opener, 'game', 'P')).toEqual(['3H', '4H'])
    expect(alternativesFor(raised, 'N', 'N', opener, 'game', '3H')).toEqual(['P', '4H'])
    const game = auction('1H', 'P', '4H', 'P')
    expect(alternativesFor(game, 'N', 'N', { hand: hand('A2.AKJ54.KQ3.AQ2'), partner: partner(10, { H: 4 }) }, 'slam', 'P')).toEqual(['6H'])
    expect(alternativesFor(game, 'N', 'N', { hand: hand('82.AKJ54.K93.Q32'), partner: partner(10, { H: 4 }) }, 'slam', 'P')).toEqual([])
  })

  it('does not pass partner’s forcing call or try anything against an artificial one', () => {
    const stayman = auction('1N', 'P', '2C', 'P')
    const meanings = [{ hcp: [15, 17] as const }, undefined, { name: 'stayman' as const, artificial: true, forcing: 'oneRound' as const }, undefined]
    const view = { hand: hand('AK2.KQ3.QJ54.K32'), partner: { hcp: [8, 37] as const, len: { S: 0, H: 0, D: 0, C: 0 } } }
    expect(alternativesFor(stayman, 'N', 'N', view, 'game', '2D', meanings, { artificial: true })).toEqual([])
    expect(alternativesFor(stayman, 'N', 'N', view, 'game', '2D', meanings)).not.toContain('P')
  })
})

describe('bidding: the alternatives', () => {
  it('tries a double and a bid against a pass, pass and a double against a bid', () => {
    const one = auction('1H')
    expect(alternativesFor(one, 'N', 'E', hand('KQ32.4.A982.KJ32'), 'takeout', 'P')).toEqual(['X'])
    expect(alternativesFor(one, 'N', 'E', hand('KQJ93.A4.982.932'), 'direct', 'P')).toEqual(['1S'])
    expect(alternativesFor(one, 'N', 'E', hand('KQJ93.A4.982.932'), 'direct', '1S')).toEqual(['P'])
    expect(alternativesFor(one, 'N', 'E', hand('AKJ93.A4.982.K32'), 'direct', '1S')).toEqual(['P', 'X'])
    expect(alternativesFor(one, 'N', 'E', hand('KQ32.4.A982.KJ32'), 'takeout', 'X')).toEqual(['P', '1S'])
  })

  it('competes in the side’s fit at the high level and leaves a weak hand alone', () => {
    const competed = auction('1H', '1S', '4H')
    expect(alternativesFor(competed, 'N', 'W', hand('Q873.2.K9873.932'), 'high', 'P')).toEqual(['4S'])
    expect(alternativesFor(competed, 'N', 'W', hand('Q873.2.K9873.932'), 'high', '4S')).toEqual(['P'])
    expect(alternativesFor(auction('1H'), 'N', 'E', hand('J8732.43.982.932'), 'direct', 'P')).toEqual([])
  })

  it('only ever offers legal calls that differ from TKB’s', () => {
    const calls = auction('1H', 'P', '2H', 'P', 'P')
    const legal = legalCalls(calls, 'N')
    for (const tkb of ['P', 'X', '2S', '3C']) {
      const alternatives = alternativesFor(calls, 'N', 'E', hand('AQ932.4.K982.Q32'), 'balancing', tkb)
      expect(alternatives.length).toBeGreaterThan(0)
      for (const call of alternatives) {
        expect(legal.has(call)).toBe(true)
        expect(call).not.toBe(tkb)
      }
    }
  })
})

describe('bidding: scores, IMPs and par', () => {
  let solver: Solver
  beforeAll(async () => {
    solver = await loadSolver()
  })

  it('scores the final contract on the DD table for either side', () => {
    const table = tableOf({ S: { N: 10, E: 3, S: 10, W: 3 } })
    const contract = { level: 4, strain: 'S' as const, doubled: '' as const, declarer: 'N' as Seat }
    expect(scoreOn(table, contract, 'None', 'NS')).toBe(420)
    expect(scoreOn(table, contract, 'None', 'EW')).toBe(-420)
    expect(scoreOn(table, { ...contract, doubled: 'X', level: 5 }, 'NS', 'EW')).toBe(200)
    expect(scoreOn(table, null, 'Both', 'NS')).toBe(0)
    expect(contractKey(contract)).toBe('4S-N')
    expect(contractKey(null)).toBe('P')
    // TKB's 4♠ made against defending 4♥X down one: 420 − 100
    expect(imps(420 - 100)).toBe(8)
  })

  it('gives par for North–South whoever deals', () => {
    const north = hand('AKQJ.AKQJ.AKQ.AK')
    const south = hand('T98.T98.JT9.QJT9')
    const east = hand('765.765.876.8765')
    const west = hand('432.432.5432.432')
    const strong: Hands = { N: north, S: south, E: east, W: west }
    const weak: Hands = { N: east, S: west, E: north, W: south }
    for (const dealer of ['N', 'E'] as const) {
      expect(solver.par(solver.table(strong), dealer, 'None')).toEqual({ ns: 1520, contracts: ['7N-NS'] })
      expect(solver.par(solver.table(weak), dealer, 'NS').ns).toBe(-1520)
    }
  })

  it('bids the alternatives out on a real board and scores them on its table', () => {
    let points = 0
    for (let board = 1; board <= 12; board++) {
      const deal = evalBoard(board)
      const record = biddingRecord(deal, 'tku', solver)
      expect(biddingRecord(deal, 'tku', solver)).toEqual(record)
      if (!record.points.length) continue
      const table = solver.table(deal.hands)
      expect(record.par).toBe(solver.par(table, record.dealer, record.vul).ns)
      const calls = record.auction.split('-')
      for (const p of record.points) {
        points++
        expect(calls[p.index]).toBe(p.tkb)
        expect(p.hand).toBe(pbnOf(deal.hands).slice(2).split(' ')['NESW'.indexOf(p.seat)])
        for (const a of p.alternatives) {
          expect(a.call).not.toBe(p.tkb)
          expect(a.auction.split('-')[0]).toBe(a.call)
        }
      }
    }
    expect(points).toBeGreaterThan(5)
  }, 120_000)
})

/** A point of a synthetic record: TKB's score against one alternative's */
const point = (category: BiddingPoint['category'], tkb: Call, score: number, alt: Call, altScore: number, par = 0): BiddingPoint => ({
  index: 1,
  seat: 'E',
  category,
  level: 1,
  hand: 'KQ32.4.A982.KJ32',
  pairHcp: 24,
  fit: 8,
  tkb,
  score,
  par,
  alternatives: [{ call: alt, contract: '1HX-N', score: altScore, auction: `${alt}-P-P-P` }],
})
const record = (board: number, points: BiddingPoint[]): BiddingRecord => ({ board, system: 'tku', dealer: 'N', vul: 'None', auction: '1H-P-P-P', contract: '1H-N', par: 0, points })

describe('bidding: the study and the practice deals', () => {
  it('adds up TKB against the alternatives and par, by kind and by kind of call', () => {
    const study = biddingStudy([
      record(1, [point('takeout', 'P', -80, 'X', 300, 140)]),
      record(2, [point('takeout', 'P', -80, 'X', -260, 140)]),
      record(3, [point('direct', '1S', 110, 'P', -140)]),
      record(4, []),
    ])
    expect(study.boards).toBe(4)
    expect(study.withPoints).toBe(3)
    const takeout = study.categories.find((c) => c.category === 'takeout')!
    expect(takeout.decisions).toBe(2)
    expect(takeout.vsAlternative.n).toBe(2)
    expect(takeout.vsAlternative.mean).toBeCloseTo((imps(-380) + imps(180)) / 2)
    expect(takeout.vsAlternative.altBetter).toBe(1)
    expect(takeout.vsPar.mean).toBeCloseTo(imps(-220))
    expect(takeout.transitions).toEqual([expect.objectContaining({ tkb: 'pass', alt: 'double', n: 2, altBetter: 1 })])
    expect(takeout.worst.map((e) => e.board)).toEqual([1])
    const report = biddingReport(study, 'test')
    expect(report).toContain('| 迫伴賭倍 | 2 | 2 |')
    expect(report).toContain('Pass → 賭倍')
    expect(report).toContain('迫伴賭倍：TKB 損失最大的牌例')
    expect(report).toContain('### 迫伴賭倍')
    expect(takeout.byPoints).toEqual([expect.objectContaining({ bucket: '23–24', decisions: 2, aggressive: expect.objectContaining({ n: 2 }) })])
  })

  it('picks the deals where the alternative won and wins on average, with a note', () => {
    const records = [
      record(1, [point('takeout', 'P', -80, 'X', 300)]),
      record(2, [point('takeout', 'P', -80, 'X', 200)]),
      record(3, [point('direct', '1S', 110, 'P', 500)]),
      record(4, [point('direct', '1S', 110, 'P', -500)]),
      record(5, [point('direct', '1S', 110, 'P', -500)]),
    ]
    const deals = practiceDeals(records, (board) => evalBoard(board).hands, biddingStudy(records), COMPETE_CATEGORIES, 40, 5, 2)
    // Direct: pass beat TKB once but loses on average, so only the takeout doubles
    expect(deals.map((d) => d.board)).toEqual([1, 2])
    expect(deals[0]).toMatchObject({ category: 'takeout', seat: 'E', auction: ['1H'], answer: 'X', tkb: 'P', imps: 9 })
    expect(deals[0].note).toContain('13 點 4-1-4-4')
    expect(Object.keys(deals[0]).slice(0, 6)).toEqual(['id', 'dealer', 'vulnerability', 'hands', 'category', 'note'])
    // The practice room reads it (shared/practice-sets, e10-t16)
    expect(parsePracticeSet('competitive', deals)).toHaveProperty('set')
    const hands = handsFromPbn(deals[0].hands)
    for (const [seat, cards] of Object.entries(evalBoard(1).hands)) expect([...hands[seat as Seat]].sort()).toEqual([...cards].sort())
  })

  it('keeps well-formed practice sets in the repository', () => {
    const sets = { bidding: practiceSet('bidding'), competitive: practiceSet('competitive') }
    const all = [...sets.bidding, ...sets.competitive]
    expect(new Set(all.map((d) => d.id)).size).toBe(all.length)
    for (const d of all) {
      expect(['None', 'NS', 'EW', 'All']).toContain(d.vulnerability)
      expect(d.note.length).toBeGreaterThan(10)
      const hands = handsFromPbn(d.hands)
      expect(new Set(Object.values(hands).flat()).size).toBe(52)
      expect(legalCalls(d.auction.map((call, i) => ({ seat: seatToCall(d.dealer, i), call })), d.dealer).has(d.answer)).toBe(true)
      expect(seatToCall(d.dealer, d.auction.length)).toBe(d.seat)
    }
    for (const d of sets.bidding) expect(CONSTRUCTIVE).toContain(d.category)
    for (const d of sets.competitive) expect([...COMPETE_CATEGORIES, 'contested']).toContain(d.category)
    for (const category of CATEGORIES) expect(all.filter((d) => d.category === category && d.system === 'gib').length).toBeLessThanOrEqual(40)
  })
})

describe('bidding: the thread pool and resuming', () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'tku-bidding-'))
  })
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('runs the study over threads, the same as one solver, and resumes from the file', async () => {
    const path = join(dir, 'bidding.jsonl')
    const store = await JsonlStore.open<BiddingRecord>(path)
    const pool = await Pool.start(2)
    try {
      await pool.run(
        chunked([1, 2, 3], 2).map((boards) => ({ kind: 'bidding', seed: 'tku-eval-v1', boards, system: 'gib', options: {} })),
        (results) => store.append(results as BiddingRecord[]),
      )
    } finally {
      await pool.close()
    }
    const again = await JsonlStore.open<BiddingRecord>(path)
    expect([...again.done].sort()).toEqual([1, 2, 3])
    const todo = [1, 2, 3, 4, 5].filter((n) => !again.done.has(n))
    expect(todo).toEqual([4, 5])
    const solver = await loadSolver()
    for await (const r of again.records()) expect(r).toEqual(biddingRecord(evalBoard(r.board), 'gib', solver))
  }, 120_000)
})
