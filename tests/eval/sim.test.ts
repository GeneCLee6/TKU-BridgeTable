// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Contract } from '../../shared/auction.ts'
import { fullDeck, hcp, nextSeat, SEATS, SUITS, suitOf, type Card, type Seat } from '../../shared/cards.ts'
import { legalCards, playCard, remainingCards, turnOf, type BoardState } from '../../shared/game.ts'
import { ruleBrain } from '../../shared/robot/brain.ts'
import { evalBoard, evalBoards } from '../../eval/deals.ts'
import { bidBoard } from '../../eval/sim/board.ts'
import { compareBoard, compareReport, compareStudy, type CompareRecord } from '../../eval/sim/compare.ts'
import { expandEquals, loadSolver, pbnOf, type Solver } from '../../eval/sim/dds.ts'
import type { TableRecord } from '../../eval/sim/jobs.ts'
import { CONCEPTS, conventionalLead, leadRecord, leadReport, leadStudy, leadType, type LeadRecord } from '../../eval/sim/leads.ts'
import { chunked, Pool } from '../../eval/sim/pool.ts'
import { seededRandom } from '../../eval/sim/random.ts'
import { knowledgeOf, positionOf, sampleLayout, sampleLayouts, type SamplingProblem } from '../../eval/sim/sampler.ts'
import { bestCard, scoreCards } from '../../eval/sim/score.ts'
import { JsonlStore } from '../../eval/sim/store.ts'

/** The first boards of the set that end in a contract, bid by the club's robots */
async function playedBoards(count: number): Promise<BoardState[]> {
  const states: BoardState[] = []
  for (const board of evalBoards(40)) {
    const state = await bidBoard(board, 'tku')
    if (state.contract) states.push(state)
    if (states.length === count) break
  }
  return states
}

/** TKB plays `cards` cards of the board */
async function playOn(state: BoardState, cards: number): Promise<BoardState> {
  for (let i = 0; i < cards && state.phase === 'play'; i++) {
    const seat = turnOf(state)!
    state = playCard(state, seat, await ruleBrain.play('tku', state, seat))
  }
  return state
}

/** The same board with the cards of the seats `seats` re-dealt among them (their played cards kept) */
function reshuffled(state: BoardState, seats: Seat[], seed: string): BoardState {
  const random = seededRandom(seed)
  const pool = seats.flatMap((s) => remainingCards(state, s))
  for (let i = pool.length - 1; i > 0; i--) {
    const j = random(i + 1)
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  const hands = { ...state.hands }
  let next = 0
  for (const s of seats) {
    const played = state.hands[s].filter((card) => state.play.some((p) => p.card === card))
    const count = 13 - played.length
    hands[s] = [...played, ...pool.slice(next, next + count)]
    next += count
  }
  return { ...state, hands }
}

const c3n = (declarer: Seat): Contract => ({ level: 3, strain: 'N', doubled: '', declarer })

describe('sim: sampling what a seat can see', () => {
  it('knows only the leader’s hand before the opening lead', async () => {
    const [state] = await playedBoards(1)
    const leader = nextSeat(state.contract!.declarer)
    const k = knowledgeOf(state, leader, 'tku')
    expect(Object.keys(k.visible)).toEqual([leader])
    expect(k.problem.unseen).toHaveLength(39)
    expect(k.problem.unseen.some((card) => state.hands[leader].includes(card))).toBe(false)
    expect(k.problem.seats.map((s) => s.seat).sort()).toEqual(SEATS.filter((s) => s !== leader).sort())
    expect(k.problem.seats.every((s) => s.count === 13)).toBe(true)
    expect(k.leader).toBe(leader)
    expect(k.trick).toEqual([])
  })

  it('deals every unseen card once, the right number to each seat, within the lengths and points read', async () => {
    const states = await playedBoards(3)
    for (const state of states) {
      const leader = nextSeat(state.contract!.declarer)
      const { problem } = knowledgeOf(state, leader, 'tku')
      const sampling = sampleLayouts(problem, 12, seededRandom('test'))
      expect(sampling.layouts).toHaveLength(12)
      expect(sampling.attempts).toBeGreaterThanOrEqual(12)
      for (const layout of sampling.layouts) {
        const dealt = problem.seats.flatMap((s) => layout[s.seat])
        expect([...dealt].sort()).toEqual([...problem.unseen].sort())
        for (const s of problem.seats) {
          expect(layout[s.seat]).toHaveLength(s.count)
          if (sampling.relaxed) continue
          for (const suit of SUITS) {
            const n = layout[s.seat].filter((card) => suitOf(card) === suit).length
            expect(n).toBeGreaterThanOrEqual(s.lengths[suit][0])
            expect(n).toBeLessThanOrEqual(s.lengths[suit][1])
          }
          expect(hcp(layout[s.seat])).toBeGreaterThanOrEqual(s.hcp[0])
          expect(hcp(layout[s.seat])).toBeLessThanOrEqual(s.hcp[1])
        }
      }
    }
  })

  it('honours tight constraints and reports when they had to be loosened', () => {
    const unseen = fullDeck().filter((card) => suitOf(card) !== 'S')
    const problem: SamplingProblem = {
      unseen,
      seats: [
        { seat: 'E', count: 13, lengths: { S: [0, 0], H: [5, 5], D: [0, 13], C: [0, 13] }, hcp: [10, 12] },
        { seat: 'S', count: 13, lengths: { S: [0, 0], H: [0, 13], D: [6, 13], C: [0, 13] }, hcp: [0, 40] },
        { seat: 'W', count: 13, lengths: { S: [0, 0], H: [0, 13], D: [0, 13], C: [0, 13] }, hcp: [0, 40] },
      ],
    }
    const found = sampleLayout(problem, seededRandom('tight'), 20_000)!
    expect(found).not.toBeNull()
    expect(found.hands.E.filter((card) => suitOf(card) === 'H')).toHaveLength(5)
    expect(hcp(found.hands.E)).toBeGreaterThanOrEqual(10)
    expect(hcp(found.hands.E)).toBeLessThanOrEqual(12)
    expect(found.hands.S.filter((card) => suitOf(card) === 'D').length).toBeGreaterThanOrEqual(6)

    // Impossible: 30 points in one hand when 30 are out, but hearts capped at 0 for everyone
    const impossible: SamplingProblem = { ...problem, seats: problem.seats.map((s) => ({ ...s, lengths: { ...s.lengths, H: [0, 0] } })) }
    expect(sampleLayout(impossible, seededRandom('x'), 200)).toBeNull()
    const relaxed = sampleLayouts(impossible, 2, seededRandom('x'), 200)
    expect(relaxed.layouts).toHaveLength(2)
    expect(relaxed.relaxed).toBe(2)
  })

  it('is the same whatever the hidden hands hold, before the lead and in the play', async () => {
    const [state] = await playedBoards(1)
    const leader = nextSeat(state.contract!.declarer)
    const hidden = SEATS.filter((s) => s !== leader)
    const other = reshuffled(state, hidden, 'hidden')
    expect(other.hands[leader]).toEqual(state.hands[leader])
    expect(other.hands).not.toEqual(state.hands)
    expect(knowledgeOf(other, leader, 'tku')).toEqual(knowledgeOf(state, leader, 'tku'))
    expect(sampleLayouts(knowledgeOf(other, leader, 'tku').problem, 5, seededRandom('s'))).toEqual(
      sampleLayouts(knowledgeOf(state, leader, 'tku').problem, 5, seededRandom('s')),
    )

    // Six cards in: the defender on play sees dummy; the declarer's and partner's remaining cards are hidden
    const played = await playOn(state, 6)
    const seat = turnOf(played)!
    const k = knowledgeOf(played, seat, 'tku')
    const unseen = k.problem.seats.map((s) => s.seat)
    expect(unseen).toHaveLength(2)
    const again = reshuffled(played, unseen, 'later')
    expect(knowledgeOf(again, seat, 'tku')).toEqual(k)
    expect(k.trick).toHaveLength(played.play.length % 4)
    for (const s of k.problem.seats) expect(s.count).toBe(remainingCards(played, s.seat).length)
    // The sampled position holds every card not yet played, once
    const layout = sampleLayouts(k.problem, 1, seededRandom('p')).layouts[0]
    const position = positionOf(k, layout)
    const all = [...SEATS.flatMap((s) => position.hands[s]), ...position.trick]
    expect(all).toHaveLength(52 - played.play.length + k.trick.length)
    expect(new Set(all).size).toBe(all.length)
  })

  it('draws the same layouts from the same seed', () => {
    const problem = knowledgeOf({ ...evalBoardState(1), phase: 'play' }, 'W', 'tku').problem
    expect(sampleLayouts(problem, 4, seededRandom('a'))).toEqual(sampleLayouts(problem, 4, seededRandom('a')))
    expect(sampleLayouts(problem, 4, seededRandom('b')).layouts).not.toEqual(sampleLayouts(problem, 4, seededRandom('a')).layouts)
  })
})

/** Board `n` with 3NT by South and no auction to read */
function evalBoardState(n: number): BoardState {
  const board = evalBoard(n)
  return { boardNo: n, dealer: 'N', vul: 'None', hands: board.hands, auction: [], contract: c3n('S'), play: [], phase: 'play' }
}

describe('sim: scoring the candidate cards', () => {
  // Defending 3NT by South, not vulnerable: three layouts, X takes 5, 5, 4 tricks, Y always 4
  const layouts = [new Map([['X', 5], ['Y', 4]]), new Map([['X', 5], ['Y', 4]]), new Map([['X', 4], ['Y', 4]])]
  const ctx = { contract: c3n('S'), declaring: false, vulnerable: false, won: 0 }

  it('averages tricks, counts contracts defeated and scores for the side to play', () => {
    const [x, y] = scoreCards(layouts, ctx)
    expect(x).toMatchObject({ card: 'X', n: 3, pSuccess: 2 / 3 })
    expect(x.meanTricks).toBeCloseTo(14 / 3, 10)
    expect(x.meanScore).toBeCloseTo((50 + 50 - 400) / 3, 10)
    expect(y).toMatchObject({ card: 'Y', n: 3, meanTricks: 4, pSuccess: 0, meanScore: -400 })
    for (const objective of ['tricks', 'contract', 'score'] as const) expect(bestCard([y, x], objective).card).toBe('X')
  })

  it('counts tricks already won and the declarer’s side', () => {
    const [x] = scoreCards([new Map([['X', 2]])], { contract: c3n('S'), declaring: true, vulnerable: true, won: 7 })
    expect(x).toMatchObject({ meanTricks: 9, pSuccess: 1, meanScore: 600 })
    const [short] = scoreCards([new Map([['X', 1]])], { contract: c3n('S'), declaring: true, vulnerable: true, won: 7 })
    expect(short).toMatchObject({ meanTricks: 8, pSuccess: 0, meanScore: -100 })
  })

  it('takes the double-dummy bias off the declarer, fractions mixing the two nearest', () => {
    const y = (bias: number) => scoreCards(layouts, ctx, bias).find((s) => s.card === 'Y')!
    expect(y(1).pSuccess).toBe(1)
    expect(y(1).meanScore).toBe(50)
    expect(y(0.5).pSuccess).toBeCloseTo(0.5, 10)
    expect(y(0.5).meanScore).toBeCloseTo(-175, 10)
    // Average tricks are the raw double-dummy ones
    expect(y(1).meanTricks).toBe(4)
  })
})

describe('sim: double dummy (WASM) in Node', () => {
  let solver: Solver
  beforeAll(async () => {
    solver = await loadSolver()
  })

  it('writes a deal in PBN, North first', () => {
    const hands = evalBoard(1).hands
    expect(pbnOf(hands)).toMatch(/^N:[AKQJT98765432]*\.[AKQJT98765432]*\.[AKQJT98765432]*\.[AKQJT98765432]*( [^ ]+){3}$/)
    expect(pbnOf(hands).startsWith('N:QT3.KQT9.J4.9532')).toBe(true)
  })

  it('gives the leader’s side the tricks the table leaves the declarer', () => {
    for (const n of [1, 2]) {
      const { hands } = evalBoard(n)
      const table = solver.table(hands)
      for (const [trump, strain] of [[null, 'N'], ['S', 'S']] as const) {
        const leads = solver.solve({ trump, leader: 'N', trick: [], hands })
        const best = Math.max(...leads.map((c) => c.tricks))
        // North leads against East: North-South's best plus East's tricks is 13
        expect(best + table[strain].E).toBe(13)
        const expanded = expandEquals(leads)
        expect(expanded.size).toBe(13)
        for (const entry of leads) for (const equal of entry.equals) expect(expanded.get(equal)).toBe(entry.tricks)
      }
    }
  })
})

describe('sim: opening leads', () => {
  const hand = (text: string) => text.split('.').flatMap((ranks, i) => [...ranks].map((r) => SUITS[i] + r))

  it('leads the club’s conventional card from a holding', () => {
    // The full table is in tests/engine/lead-card.test.ts; the concepts lead the same card as TKB
    expect(conventionalLead(['S5'], 'H')).toBe('S5')
    expect(conventionalLead(['SA', 'S8', 'S7', 'S2'], 'H')).toBe('SA')
    expect(conventionalLead(['SA', 'S8', 'S7', 'S2'], null)).toBe('S2')
    expect(conventionalLead(['SK', 'SQ', 'S7', 'S2'], 'H')).toBe('SQ')
    expect(conventionalLead(['SK', 'SQ', 'S7', 'S2'], null)).toBe('S2')
    expect(conventionalLead(['S9', 'S7', 'S6', 'S3'], null)).toBe('S7')
  })

  it('names the kind of lead', () => {
    const h = hand('AK4.KQ3.9.J8653')
    expect(leadType(h, 'SA', null, '')).toBe('aceKing')
    expect(leadType(h, 'H3', null, '')).toBe('fromHonour') // KQx is no sequence against notrump
    expect(leadType(h, 'HQ', 'S', '')).toBe('sequence')
    expect(leadType(h, 'D9', 'S', '')).toBe('singleton')
    expect(leadType(h, 'C5', null, '')).toBe('fromHonour')
    expect(leadType(h, 'C3', 'C', '')).toBe('trump')
    expect(leadType(h, 'H3', null, 'H')).toBe('partner')
    expect(leadType(hand('9743.A2.K5.QJ832'), 'S4', null, '')).toBe('smallFromNothing')
  })

  const record = (over: Partial<LeadRecord>): LeadRecord => ({
    board: 1,
    system: 'tku',
    dealer: 'N',
    vul: 'None',
    contract: '3N',
    declarer: 'S',
    leader: 'W',
    hand: 'KQJ4.T8.K762.953',
    auction: '1N-P-3N-P-P-P',
    partnerSuits: '',
    theirSuits: '',
    tkb: 'SK',
    dd: Object.fromEntries(hand('KQJ4.T8.K762.953').map((c) => [c, 4])),
    ...over,
  })

  it('finds the president’s situations and the two candidate leads', () => {
    const r = record({ partnerSuits: 'D' })
    const cases = CONCEPTS.flatMap((c) => c.cases(r, hand(r.hand), null))
    expect(cases).toContainEqual({ concept: 'ntPartnerVsOwn', split: '同伴花色 3 張以上', a: 'D2', b: 'SK' })
    expect(cases.find((c) => c.concept === 'sequenceVsAway')).toBeUndefined()
    const suit = record({ contract: '4H', hand: 'KQJ4.T8.K762.953', theirSuits: 'HS' })
    const suitCases = CONCEPTS.flatMap((c) => c.cases(suit, hand(suit.hand), 'H'))
    expect(suitCases).toContainEqual({ concept: 'sequenceVsAway', split: '王牌合約', a: 'SK', b: 'D2' })
    expect(suitCases).toContainEqual({ concept: 'trumpLead', split: '敵方叫過旁門・王牌小牌', a: 'H8', b: 'SK' })
    const short = record({ contract: '4S', hand: 'T8.KJ74.9.Q97532', theirSuits: 'S' })
    expect(CONCEPTS.flatMap((c) => c.cases(short, hand(short.hand), 'S'))).toContainEqual({ concept: 'shortSuit', split: '單張・沒有王牌控制', a: 'D9', b: 'C5' })
  })

  it('adds the study up: gains, contracts defeated, what TKB led, and its loss', () => {
    const dd = Object.fromEntries(hand('KQJ4.T8.K762.953').map((c) => [c, 4]))
    // A is partner's diamond (D2), B the top of the spade sequence (SK)
    const records = [
      record({ partnerSuits: 'D', dd: { ...dd, D2: 5, SK: 4 }, tkb: 'D2' }),
      record({ partnerSuits: 'D', dd: { ...dd, D2: 4, SK: 5 }, tkb: 'S4' }),
      record({ partnerSuits: 'D', dd: { ...dd, D2: 5, SK: 5 }, tkb: 'SK' }),
    ]
    const study = leadStudy(records)
    expect(study.boards).toBe(3)
    expect(study.notrump).toBe(3)
    const concept = study.concepts.find((c) => c.concept === 'ntPartnerVsOwn')!
    expect(concept).toMatchObject({ n: 3, trickGain: 0, defeatA: 2 / 3, defeatB: 2 / 3, aBest: 2 / 3, bBest: 2 / 3, tkbA: 1, tkbB: 1, tkbOther: 1 })
    expect(concept.tkbLoss).toBeCloseTo(1 / 3, 10)
    expect(study.tkbLoss.notrump).toBeCloseTo(1 / 3, 10)
    expect(study.tkbBest.notrump).toBeCloseTo(2 / 3, 10)
    // Board 2: TKB led the four from KQJ4 ('other' for the type), a trick worse than the king, which beats 3NT
    expect(study.types.notrump.find((t) => t.type === 'other')).toMatchObject({ n: 1, loss: 1, best: 0, costContract: 1 })
    expect(study.disagreements[0]).toMatchObject({ contract: 'NT', tkb: 'other', best: 'sequence', n: 1, loss: 1 })
    const report = leadReport(study, 'test')
    expect(report).toContain('## 首攻研究：test')
    expect(report).toContain('| 同伴花色 3 張以上 | 3 |')
  })

  it('records a real board’s lead decision from the leader’s seat', async () => {
    const solver = await loadSolver()
    const [state] = await playedBoards(1)
    const board = evalBoard(state.boardNo)
    const r = (await leadRecord(board, 'tku', solver, { samples: 3, seed: 'test' }))!
    expect(r.board).toBe(state.boardNo)
    expect(r.leader).toBe(nextSeat(state.contract!.declarer))
    expect(hand(r.hand).sort()).toEqual([...state.hands[r.leader]].sort())
    expect(Object.keys(r.dd)).toHaveLength(13)
    expect(r.dd[r.tkb]).toBeGreaterThanOrEqual(0)
    expect(r.sampled!.n).toBe(3)
    expect(Object.keys(r.sampled!.tricks)).toHaveLength(13)
    for (const p of Object.values(r.sampled!.defeat)) expect(p).toBeGreaterThanOrEqual(0)
  })
})

describe('sim: TKB against sampled double dummy', () => {
  it('compares the opening lead of a real board', async () => {
    const solver = await loadSolver()
    const [state] = await playedBoards(1)
    const r = (await compareBoard(evalBoard(state.boardNo), 'tku', solver, { samples: 3, seed: 'test', objective: 'score', ddBias: 0, points: 'lead' }))!
    const total = Object.values(r.decisions).reduce((a, b) => a + b, 0)
    expect(total).toBeLessThanOrEqual(1)
    expect(r.sampling.layouts).toBe(3 * r.sampling.decisions)
    expect(r.sampling.decisions).toBeLessThanOrEqual(1)
    expect(r.losses.length).toBeLessThanOrEqual(total)
    for (const d of r.losses) {
      expect(d.lossScore).toBeGreaterThan(0)
      expect(legalCards({ ...state }, nextSeat(state.contract!.declarer))).toContain(d.best)
    }
  })

  it('adds the comparison up by situation and keeps the worst decisions', () => {
    const score = (card: Card, meanScore: number) => ({ card, n: 3, meanTricks: 4, pSuccess: 0, meanScore })
    const loss = (board: number, situation: 'leadNT' | 'secondHand', lossScore: number) => ({
      board,
      contract: '3N',
      declarer: 'S' as const,
      seat: 'W' as const,
      trick: 1,
      situation,
      tkb: 'SK',
      best: 'D2',
      tkbScore: score('SK', -400),
      bestScore: score('D2', -400 + lossScore),
      lossTricks: 0.5,
      lossSuccess: 0.3,
      lossScore,
      samples: 3,
      attempts: 4,
      relaxed: 0,
    })
    const records: CompareRecord[] = [
      { board: 1, contract: '3N', decisions: { leadNT: 1, secondHand: 2 }, losses: [loss(1, 'leadNT', 150)], sampling: { decisions: 3, layouts: 9, attempts: 12, relaxed: 0 } },
      { board: 2, contract: '3N', decisions: { secondHand: 1 }, losses: [loss(2, 'secondHand', 300)], sampling: { decisions: 1, layouts: 3, attempts: 3, relaxed: 1 } },
    ]
    const study = compareStudy(records, 'score')
    expect(study.boards).toBe(2)
    expect(study.sampled).toBe(4)
    expect(study.acceptance).toBeCloseTo(12 / 15, 10)
    expect(study.situations.find((s) => s.situation === 'secondHand')).toMatchObject({ decisions: 3, losses: 1, meanScore: 100 })
    expect(study.situations.find((s) => s.situation === 'leadNT')).toMatchObject({ decisions: 1, losses: 1, meanScore: 150 })
    expect(study.worst.map((d) => d.board)).toEqual([2, 1])
    expect(compareReport(study, 'test', 'score')).toContain('| 防家第二家 | 3 | 1（33.3%） |')
  })
})

describe('sim: the thread pool and the result files', () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'tku-sim-'))
  })
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('solves the boards over two threads, the same tables as one solver', async () => {
    const pool = await Pool.start(2)
    try {
      expect(pool.size).toBe(2)
      const records: TableRecord[] = []
      let progress = 0
      await pool.run(
        chunked([1, 2, 3], 2).map((boards) => ({ kind: 'tables', seed: 'tku-eval-v1', boards })),
        (results) => records.push(...(results as TableRecord[])),
        (n) => (progress += n),
      )
      expect(progress).toBe(3)
      expect(records.map((r) => r.board).sort()).toEqual([1, 2, 3])
      const solver = await loadSolver()
      expect(records.find((r) => r.board === 2)!.table).toEqual(solver.table(evalBoard(2).hands))
    } finally {
      await pool.close()
    }
  })

  it('keeps results a line a board and resumes from them', async () => {
    const path = join(dir, 'results.jsonl')
    const store = await JsonlStore.open<TableRecord>(path)
    expect(store.done.size).toBe(0)
    const table = { N: { N: 1, E: 2, S: 3, W: 4 }, S: { N: 1, E: 2, S: 3, W: 4 }, H: { N: 1, E: 2, S: 3, W: 4 }, D: { N: 1, E: 2, S: 3, W: 4 }, C: { N: 1, E: 2, S: 3, W: 4 } }
    store.append([{ board: 5, table }, { board: 7, table }])
    store.append([])
    const again = await JsonlStore.open<TableRecord>(path)
    expect([...again.done]).toEqual([5, 7])
    const records: TableRecord[] = []
    for await (const r of again.records()) records.push(r)
    expect(records).toEqual([{ board: 5, table }, { board: 7, table }])
  })
})
