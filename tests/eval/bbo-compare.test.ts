// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Call } from '../../shared/auction.ts'
import type { Card, Seat } from '../../shared/cards.ts'
import { dummyOf, makeCall, newBoard, playCard, remainingCards, turnOf, type BoardState } from '../../shared/game.ts'
import { parseLin, type LinBoard } from '../../shared/lin-import.ts'
import { toLin } from '../../shared/lin.ts'
import { parseDeal } from '../../shared/pbn.ts'
import type { BoardRecord, RobotKind } from '../../shared/protocol.ts'
import { ruleBrain, type RobotBrain } from '../../shared/robot/brain.ts'
import {
  bidCategory,
  compareBoard,
  compareFiles,
  compareReport,
  compareTexts,
  extremes,
  GIB_NAMES,
  linFiles,
  playGain,
  playType,
  positionAt,
  summarize,
  type BidDifference,
  type CompareOptions,
  type PlayDifference,
} from '../../eval/bbo-compare.ts'
import { evalBoards } from '../../eval/deals.ts'
import { expandEquals, loadSolver, type Solver } from '../../eval/sim/dds.ts'

const SESSION = readFileSync('tests/eval/fixtures/bbo-session.lin', 'utf8')
const parsed = parseLin(SESSION)
const boardOf = (no: number): LinBoard => parsed.boards.find((b) => b.boardNo === no)!

/** A brain that answers what the file did, except where `calls` or `cards` says otherwise (by position in the auction or the play) */
function scripted(board: LinBoard, change: { calls?: Record<number, Call>; cards?: Record<number, Card> } = {}): RobotBrain {
  return {
    bid: (_kind, state) => ({ call: change.calls?.[state.auction.length] ?? board.calls[state.auction.length]?.call ?? 'P' }),
    play: (_kind, state) => change.cards?.[state.play.length] ?? board.play[state.play.length],
    acceptsClaim: () => true,
  }
}

const options = (brain: RobotBrain, more: Partial<CompareOptions> = {}): CompareOptions => ({ kind: 'gib', brain, solver: null, ...more })

/** Four TKBs bid and play a board out, as a LIN file writes it */
async function tkbLin(hands: BoardState['hands'], boardNo: number, kind: RobotKind): Promise<string> {
  let state = newBoard(boardNo, hands)
  while (state.phase === 'auction') {
    const seat = turnOf(state)!
    const { call, alert } = await ruleBrain.bid(kind, state, seat)
    state = makeCall(state, seat, call, alert)
  }
  while (state.phase === 'play') {
    const seat = turnOf(state)!
    state = playCard(state, seat, await ruleBrain.play(kind, state, seat))
  }
  const player = (username: string) => ({ id: username, username })
  const record = { id: 'x', tableNumber: 1, finishedAt: 0, board: state, players: { N: player('n'), E: player('e'), S: player('s'), W: player('w') } } as BoardRecord
  return toLin(record)
}

describe('bbo-compare: the decisions of a board', () => {
  it('counts every call, and every card with a choice, in its row', async () => {
    const record = (await compareBoard(boardOf(1), 'f', options(scripted(boardOf(1)))))!
    expect(record.contract).toBe('1N S')
    expect(record.tricks).toBe(7)
    expect(record.claimed).toBe(true)
    expect(record.differences).toEqual([])
    expect(record.decisions).toEqual({
      'bid:opening': 1,
      'bid:overcall': 3,
      'bid:response': 1,
      'bid:rebid': 1,
      'play:defence:openingLead': 1,
      'play:declarer:follow': 2,
      'play:defence:follow': 1,
    })
  })

  it('reads the row of a call from the calls before it', () => {
    const calls = (...list: [Seat, Call][]) => list.map(([seat, call]) => ({ seat, call }))
    expect(bidCategory(calls(['N', 'P'], ['E', 'P']), 'S')).toBe('opening')
    expect(bidCategory(calls(['N', '1C'], ['E', 'P']), 'S')).toBe('response')
    expect(bidCategory(calls(['N', '1C'], ['E', 'P'], ['S', '1H'], ['W', 'P']), 'N')).toBe('rebid')
    expect(bidCategory(calls(['N', '1C']), 'E')).toBe('overcall')
    expect(bidCategory(calls(['N', '1C'], ['E', 'X']), 'S')).toBe('competitive')
    expect(bidCategory(calls(['N', '1C'], ['E', '1H'], ['S', 'P']), 'W')).toBe('competitive')
  })

  it('tells a lead, a card that follows and a discard apart', () => {
    const state = { ...newBoard(1, { N: ['SA', 'H2'], E: ['S2', 'H3'], S: ['S3', 'H4'], W: ['H5', 'H6'] }), contract: { level: 1, strain: 'N', doubled: '', declarer: 'S' }, phase: 'play' } as BoardState
    expect(playType(state, 'W')).toBe('openingLead')
    const led = playCard(state, 'W', 'H5')
    expect(playType(led, 'N')).toBe('follow')
    const voided = { ...state, hands: { N: ['SA', 'SK'], E: ['S2', 'H3'], S: ['S3', 'H4'], W: ['H5', 'H6'] } } as BoardState
    expect(playType(playCard(voided, 'W', 'H5'), 'N')).toBe('discard')
    const nextTrick = ['H5', 'H2', 'H3', 'H4'].reduce((s, card) => playCard(s, turnOf(s)!, card), state)
    expect(playType(nextTrick, 'S')).toBe('lead')
  })

  it('shows a board passed out its four calls and no cards', async () => {
    const record = (await compareBoard(boardOf(6), 'f', options(scripted(boardOf(6)))))!
    expect(record.contract).toBe('Passed out')
    expect(record.tricks).toBeNull()
    expect(Object.values(record.decisions).reduce((a, b) => a + b, 0)).toBe(4)
  })

  it('asks about the seat in turn, from before its call or card, with no one’s alerts', async () => {
    const seen: { auction: BoardState['auction']; play: number; seat: Seat; turn: Seat | null; phase: string }[] = []
    const script = scripted(boardOf(1))
    const brain: RobotBrain = {
      ...script,
      bid: (kind, state, seat) => {
        seen.push({ auction: state.auction, play: 0, seat, turn: turnOf(state), phase: state.phase })
        return script.bid(kind, state, seat)
      },
      play: (kind, state, seat) => {
        seen.push({ auction: state.auction, play: state.play.length, seat, turn: turnOf(state), phase: state.phase })
        return script.play(kind, state, seat)
      },
    }
    await compareBoard(boardOf(1), 'f', options(brain))
    expect(seen).toHaveLength(10)
    for (const s of seen) expect(s.seat).toBe(s.turn)
    expect(seen.map((s) => s.phase)).toEqual([...Array(6).fill('auction'), ...Array(4).fill('play')])
    expect(seen[1].auction).toEqual([{ seat: 'N', call: '1C' }])
    expect(seen.at(-1)!.play).toBe(3)
    expect(boardOf(1).calls[0].alert).toBe('better minor')
  })

  it('finds no differences when four TKBs played the file (alerts and all)', async () => {
    for (const kind of ['gib', 'tku', 'sayc', 'precision'] as const) {
      for (const board of evalBoards(4)) {
        const lin = await tkbLin(board.hands, board.boardNo, kind)
        const { boards, problems } = parseLin(lin)
        expect(problems).toEqual([])
        const record = (await compareBoard(boards[0], 'f', { kind, brain: ruleBrain, solver: null }))!
        expect(record.differences).toEqual([])
        expect(record.robotErrors).toBe(0)
        expect(Object.keys(record.decisions).length).toBeGreaterThan(0)
      }
    }
  })

  it('finds TKB’s call differs where the file opened otherwise', async () => {
    const record = (await compareBoard(boardOf(1), 'f', options(ruleBrain, { filter: { only: 'bidding' } })))!
    const opening = record.differences.find((d) => d.kind === 'bid' && d.auction === '') as BidDifference
    expect(opening).toMatchObject({ group: 'bid:opening', seat: 'N', player: 'Nora', actual: '1C', tkb: '1N', hand: 'AK3.QJ2.KQ4.J432' })
  })

  it('counts a robot that fails and goes on', async () => {
    const script = scripted(boardOf(1))
    const brain: RobotBrain = {
      ...script,
      bid: (kind, state, seat) => {
        if (state.auction.length === 2) throw new Error('no rule')
        return script.bid(kind, state, seat)
      },
    }
    const record = (await compareBoard(boardOf(1), 'f', options(brain)))!
    expect(record.robotErrors).toBe(1)
    // Sam's only call failed; the two cards Sam decided are still there
    expect(record.players.Sam.decisions).toBe(2)
  })
})

/** The same position with the cards the seat cannot see dealt differently */
function hideAndRedeal(state: BoardState, seat: Seat): BoardState {
  const dummy = dummyOf(state)
  const exposed = state.phase === 'play' && state.play.length > 0
  const visible = new Set<Seat>([seat])
  if (exposed && dummy) visible.add(dummy)
  if (exposed && seat === dummy) visible.add(state.contract!.declarer)
  const hidden = (['N', 'E', 'S', 'W'] as Seat[]).filter((s) => !visible.has(s))
  const pool = hidden.flatMap((s) => remainingCards(state, s)).reverse()
  const hands = { ...state.hands }
  let next = 0
  for (const s of hidden) {
    const count = remainingCards(state, s).length
    hands[s] = [...state.hands[s].filter((c) => !remainingCards(state, s).includes(c)), ...pool.slice(next, next + count)]
    next += count
  }
  return { ...state, hands }
}

describe('bbo-compare: the robot sees only what its seat sees', () => {
  it('answers the same at each decision with the unseen cards dealt another way', async () => {
    let checked = 0
    const brain: RobotBrain = {
      ...ruleBrain,
      bid: (kind, state, seat) => {
        const answer = ruleBrain.bid(kind, state, seat) as { call: Call }
        expect((ruleBrain.bid(kind, hideAndRedeal(state, seat), seat) as { call: Call }).call).toBe(answer.call)
        checked++
        return answer
      },
      play: (kind, state, seat) => {
        const answer = ruleBrain.play(kind, state, seat)
        expect(ruleBrain.play(kind, hideAndRedeal(state, seat), seat)).toBe(answer)
        checked++
        return answer
      },
    }
    const [one, two] = evalBoards(2)
    for (const board of [one, two]) {
      const lin = await tkbLin(board.hands, board.boardNo, 'gib')
      await compareBoard(parseLin(lin).boards[0], 'f', options(brain))
    }
    expect(checked).toBeGreaterThan(50)
  })
})

describe('bbo-compare: filters', () => {
  const groups = (decisions: object) => Object.keys(decisions)

  it('takes one player’s decisions, the declarer’s for dummy’s cards', async () => {
    const record = (await compareBoard(boardOf(1), 'f', options(scripted(boardOf(1)), { filter: { players: new Set(['sam']) } })))!
    // Sam (South) made one call and is the declarer: South's card and North's (dummy's)
    expect(record.players).toEqual({ Sam: { decisions: 3, different: 0 } })
    expect(record.decisions['play:declarer:follow']).toBe(2)
  })

  it('takes the names that look like robots', async () => {
    expect(GIB_NAMES.test('GIB')).toBe(true)
    expect(GIB_NAMES.test('~~M001')).toBe(true)
    expect(GIB_NAMES.test('Robot')).toBe(true)
    expect(GIB_NAMES.test('Robotnik')).toBe(false)
    expect(GIB_NAMES.test('Sam')).toBe(false)
    const record = (await compareBoard(boardOf(1), 'f', options(scripted(boardOf(1)), { filter: { names: GIB_NAMES } })))!
    expect(Object.keys(record.players).sort()).toEqual(['GIB', '~~M001'])
  })

  it('takes the declaring side’s cards or the defenders’, and no calls', async () => {
    const script = scripted(boardOf(1))
    const declaring = (await compareBoard(boardOf(1), 'f', options(script, { filter: { side: 'declarer' } })))!
    expect(groups(declaring.decisions)).toEqual(['play:declarer:follow'])
    const defending = (await compareBoard(boardOf(1), 'f', options(script, { filter: { side: 'defence' } })))!
    expect(groups(defending.decisions).sort()).toEqual(['play:defence:follow', 'play:defence:openingLead'])
  })

  it('takes only the calls or only the cards', async () => {
    const script = scripted(boardOf(1))
    const bids = (await compareBoard(boardOf(1), 'f', options(script, { filter: { only: 'bidding' } })))!
    expect(groups(bids.decisions).every((g) => g.startsWith('bid:'))).toBe(true)
    const cards = (await compareBoard(boardOf(1), 'f', options(script, { filter: { only: 'play' } })))!
    expect(groups(cards.decisions).every((g) => g.startsWith('play:'))).toBe(true)
  })
})

describe('bbo-compare: what is skipped', () => {
  it('counts boards it cannot use, and does not stop', async () => {
    const run = await compareTexts([['a.lin', SESSION], ['garbage.lin', 'this is not a LIN file | at all'], ['again.lin', SESSION]], options(ruleBrain))
    expect(run.boards.map((b) => b.board)).toEqual([1, 2, 6])
    expect(run.skipped.filter((s) => s.file === 'a.lin').map((s) => [s.board, s.code])).toEqual([
      [3, 'importUnfinished'],
      [4, 'importBadDeal'],
      [5, 'importBadAuction'],
    ])
    expect(run.duplicates).toBe(3)
  })

  it('reports a file it cannot read, and reads the others', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bbo-'))
    try {
      const good = join(dir, 'good.lin')
      writeFileSync(good, SESSION)
      const run = await compareFiles([join(dir, 'missing.lin'), good], options(scripted(boardOf(1)), { filter: { only: 'bidding' } }))
      expect(run.unreadable.map((u) => u.file)).toEqual([join(dir, 'missing.lin')])
      expect(run.boards).toHaveLength(3)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('finds the .lin files in a folder at any depth', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bbo-'))
    try {
      mkdirSync(join(dir, 'sub'))
      writeFileSync(join(dir, 'b.lin'), '')
      writeFileSync(join(dir, 'notes.txt'), '')
      writeFileSync(join(dir, 'sub', 'a.LIN'), '')
      expect(linFiles([dir])).toEqual([join(dir, 'b.lin'), join(dir, 'sub', 'a.LIN')])
      // A file named outright counts whatever it is called, and a missing one is left for reading to report
      expect(linFiles([join(dir, 'notes.txt'), join(dir, 'gone.lin')])).toEqual([join(dir, 'notes.txt'), join(dir, 'gone.lin')])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('bbo-compare: double dummy', () => {
  let solver: Solver
  beforeAll(async () => {
    solver = await loadSolver()
  })
  afterAll(() => {
    solver = undefined as unknown as Solver
  })

  /**
   * Board 2: North ♠KQJT98765432 ♥A, East ♠A ♥KQJT98765432, South all the diamonds, West all the
   * clubs; 7NT by North, East to lead. ♥K knocks out North's only entry to nothing: North must then
   * lead a spade, East takes ♠A and runs the hearts (East–West 12). ♠A at once lets ♥A in with the
   * spades good (East–West 1).
   */
  const play = async (tkb: Card) => {
    const record = (await compareBoard(boardOf(2), 'f', options(scripted(boardOf(2), { cards: { 0: tkb } }), { solver, filter: { only: 'play' } })))!
    return { record, difference: record.differences[0] as PlayDifference }
  }

  it('rates two cards from the side of the seat that plays', async () => {
    const { difference } = await play('SA')
    expect(difference).toMatchObject({ group: 'play:defence:openingLead', seat: 'E', player: 'GIB', trick: 1, position: 1, actual: 'HK', tkb: 'SA', contract: '7N N' })
    // Undoubled and not vulnerable: 12 down is 600, 1 down is 50, so TKB's card gives up 550 (11 IMP)
    expect(difference.dd).toEqual({ actualTricks: 12, tkbTricks: 1, bestTricks: 12, gainTricks: -11, gainScore: -550, gainImps: -11 })
  })

  it('counts a different card worth the same as a difference with no gain', async () => {
    const { difference, record } = await play('HQ')
    expect(difference.dd).toEqual({ actualTricks: 12, tkbTricks: 12, bestTricks: 12, gainTricks: 0, gainScore: 0, gainImps: 0 })
    const [row] = summarize({ boards: [record] }).groups
    expect(row).toMatchObject({ different: 1, ddSame: 1, tkbBetter: 0, actualBetter: 0, tricks: 0, imps: 0 })
  })

  /** Board 1 (1NT by South, not vulnerable) with South's ♥A having won trick 1 and ♠Q, ♠8 on the table, then `more` */
  const secondTrick = (more: Card[]) => {
    const board = boardOf(1)
    let state: BoardState = { boardNo: 1, dealer: board.dealer, vul: board.vul, hands: parseDeal(board.hands)!, auction: [], contract: null, play: [], phase: 'auction' }
    for (const { call } of board.calls) state = makeCall(state, turnOf(state)!, call)
    for (const card of [...board.play, 'SQ', 'S8', ...more]) state = playCard(state, turnOf(state)!, card)
    return state
  }
  /** A solver that says how many tricks the side to play takes after each card */
  const saying = (tricks: Record<Card, number>) =>
    ({ solve: () => Object.entries(tricks).map(([card, n]) => ({ card, equals: [], tricks: n })) }) as unknown as Solver

  it('counts the tricks already won when it scores a card for the declaring side', () => {
    // One won and 12 to play: 6 more is seven, 1NT making, +90; 5 more is six, one down, -50
    const gain = playGain(secondTrick([]), 'N', 'S3', 'SA', saying({ S3: 5, SA: 6, SK: 6 }))
    expect(gain).toEqual({ actualTricks: 5, tkbTricks: 6, bestTricks: 6, gainTricks: 1, gainScore: 140, gainImps: 4 })
  })

  it('counts from the defenders’ side when a defender plays', () => {
    // East's side taking 7 of the 12 leaves the declarer six in all, one down; taking 6 leaves seven
    const gain = playGain(secondTrick(['S3']), 'E', 'S4', 'S7', saying({ S4: 6, S7: 7 }))
    expect(gain).toEqual({ actualTricks: 6, tkbTricks: 7, bestTricks: 7, gainTricks: 1, gainScore: 140, gainImps: 4 })
  })

  it('gives DDS the real position in the middle of a trick', async () => {
    const position = positionAt(secondTrick([]))
    expect(position).toMatchObject({ trump: null, leader: 'S', trick: ['SQ', 'S8'] })
    expect(position.hands.N).toHaveLength(12)
    expect(position.hands.S).toHaveLength(11)
    expect(position.hands.W).toHaveLength(11)
    expect(position.hands.E).toHaveLength(12)
    const tricks = expandEquals(solver.solve(position))
    expect([...tricks.keys()].sort()).toEqual(['S3', 'SA', 'SK'])
  })

  it('rates a card that would lose the trick against one that wins it', async () => {
    const record = (await compareBoard(boardOf(1), 'f', options(scripted(boardOf(1), { cards: { 3: 'H3' } }), { solver, filter: { only: 'play' } })))!
    const d = record.differences[0] as PlayDifference
    expect(d).toMatchObject({ group: 'play:declarer:follow', seat: 'S', player: 'Sam', trick: 1, position: 4, actual: 'HA', tkb: 'H3' })
    expect(d.dd!.gainTricks).toBe(d.dd!.tkbTricks - d.dd!.actualTricks)
    expect(d.dd!.bestTricks).toBeGreaterThanOrEqual(Math.max(d.dd!.tkbTricks, d.dd!.actualTricks))
    expect(Math.sign(d.dd!.gainScore)).toBe(Math.sign(d.dd!.gainTricks))
  })

  it('scores a call by where the auction ends after it, and the contract against par', async () => {
    const brain: RobotBrain = { ...scripted(boardOf(2)), bid: () => ({ call: 'P' }) }
    const record = (await compareBoard(boardOf(2), 'f', options(brain, { solver, filter: { only: 'bidding' } })))!
    expect(record.differences).toHaveLength(1)
    const d = record.differences[0] as BidDifference
    // 7NT by North is one trick, 12 down, -600; passing it out is 0: TKB's pass gains 600 for North–South
    expect(d.dd).toEqual({ actualContract: '7N N', tkbContract: 'Passed out', actualNS: -600, tkbNS: 0, gainScore: 600, gainImps: 12 })
    expect(record.dd).toMatchObject({ tricks: 1, scoreNS: -600 })
    // 7♦ by South makes; East–West save in 7♥X, one down for 100 (DealerPar: North–South's point of view)
    expect(record.dd!.parNS).toBe(100)
    // 700 apart on the WBF scale
    expect(record.dd!.gapImps).toBe(12)
  })

  it('looks from East–West when they made the call', async () => {
    // East doubles where the file passed: both lines end in 7NT, doubled the second time
    const script = scripted(boardOf(2))
    const brain: RobotBrain = { ...script, bid: (_kind, state) => ({ call: state.auction.length === 1 ? 'X' : state.auction.length === 0 ? '7N' : 'P' }) }
    const record = (await compareBoard(boardOf(2), 'f', options(brain, { solver, filter: { only: 'bidding' } })))!
    const d = record.differences[0] as BidDifference
    expect(d).toMatchObject({ seat: 'E', actual: 'P', tkb: 'X' })
    // 12 down undoubled is 600; doubled and not vulnerable it is 100 + 2·200 + 9·300 = 3,200
    expect(d.dd).toMatchObject({ actualContract: '7N N', tkbContract: '7NX N', actualNS: -600, tkbNS: -3200, gainScore: 2600 })
  })

  it('adds the gains up by row and lists the biggest', async () => {
    const lost = await play('SA')
    const same = await play('HQ')
    const boards = [lost.record, same.record]
    const summary = summarize({ boards })
    expect(summary.play).toEqual({ decisions: 2, different: 2, tricks: -11, imps: -11 })
    expect(summary.groups).toHaveLength(1)
    expect(summary.groups[0]).toMatchObject({ decisions: 2, different: 2, actualBetter: 1, ddSame: 1 })
    expect(summary.players).toEqual([{ player: 'GIB', decisions: 2, different: 2 }])
    expect(extremes({ boards }, -1, 5)).toEqual([lost.difference])
    expect(extremes({ boards }, 1, 5)).toEqual([])
  })

  it('writes a report of what it found', async () => {
    const script = scripted(boardOf(2), { cards: { 0: 'SA' } })
    const run = await compareTexts([['tests/a.lin', SESSION]], { kind: 'gib', brain: { ...script, bid: () => ({ call: 'P' }) }, solver })
    const report = compareReport(run, { top: 5, filterText: '全部決策', dd: true })
    expect(report).toContain('TKB（gib）')
    expect(report).toContain('## 彙總')
    expect(report).toContain('首攻')
    expect(report).toContain('| a.lin | 2 | 7N N 第 1 墩第 1 張 | E（GIB）')
    expect(report).toContain('`importUnfinished`：1 副')
    expect(report).toContain('最後合約對 par')
  })
})
