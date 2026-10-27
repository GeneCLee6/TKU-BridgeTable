// @vitest-environment node
import { Dds, loadDds } from 'bridge-dds'
import { beforeAll, describe, expect, it } from 'vitest'
import { deal } from '../../shared/board.ts'
import type { Card, Hands } from '../../shared/cards.ts'
import { legalCards, makeCall, newBoard, playCard, turnOf, type BoardState } from '../../shared/game.ts'
import {
  cardOutcomes,
  cardScores,
  ddPosition,
  ddRequest,
  isCompleteDeal,
  outcomeLabel,
  parseParContract,
  pbnDeal,
  positionKey,
  toAnalysis,
} from '../../src/lib/doubleDummy.ts'
import { solveDeal, solvePosition } from '../../src/lib/ddsSolve.ts'
import { canAnalyse } from '../../src/lib/useDoubleDummy.ts'

/** A hand from text like 'AKQ2 KJ3 Q54 32' (♠ ♥ ♦ ♣; '-' for a void) */
function hand(text: string): Card[] {
  return text.split(' ').flatMap((ranks, i) => [...ranks.replace('-', '')].map((r) => 'SHDC'[i] + r))
}

/** Each seat holds one whole suit: N spades, E hearts, S diamonds, W clubs */
const suitPerSeat: Hands = {
  N: hand('AKQJT98765432 - - -'),
  E: hand('- AKQJT98765432 - -'),
  S: hand('- - AKQJT98765432 -'),
  W: hand('- - - AKQJT98765432'),
}

describe('DDS input and output', () => {
  it('writes the deal in PBN, North first, high cards first', () => {
    const hands = { ...suitPerSeat, N: [...suitPerSeat.N].reverse() }
    expect(pbnDeal(hands)).toBe('N:AKQJT98765432... .AKQJT98765432.. ..AKQJT98765432. ...AKQJT98765432')
  })

  it('maps dealer and vulnerability to DDS numbers', () => {
    expect(ddRequest(suitPerSeat, 'E', 'NS')).toMatchObject({ dealer: 1, vulnerable: 2 })
    expect(ddRequest(suitPerSeat, 'W', 'Both')).toMatchObject({ dealer: 3, vulnerable: 1 })
  })

  it('only takes a whole deal of 52 different cards', () => {
    expect(isCompleteDeal(suitPerSeat)).toBe(true)
    expect(isCompleteDeal({ ...suitPerSeat, W: suitPerSeat.W.slice(1) })).toBe(false)
    expect(isCompleteDeal({ ...suitPerSeat, W: [...suitPerSeat.W.slice(1), 'SA'] })).toBe(false)
  })

  it('reads par contracts', () => {
    expect(parseParContract('4H-EW+1')).toEqual({ level: 4, strain: 'H', doubled: false, by: 'EW', overtricks: 1 })
    expect(parseParContract('5D*-NS-2')).toEqual({ level: 5, strain: 'D', doubled: true, by: 'NS', overtricks: -2 })
    expect(parseParContract('3N-S')).toEqual({ level: 3, strain: 'N', doubled: false, by: 'S', overtricks: 0 })
    expect(parseParContract('pass')).toBeNull()
  })

  it('analyses only finished boards', () => {
    globalThis.Worker ??= class {} as unknown as typeof Worker
    const board = newBoard(1, suitPerSeat)
    expect(canAnalyse(board)).toBe(false)
    expect(canAnalyse({ ...board, phase: 'finished' })).toBe(true)
  })
})

/** Board 1 (North deals) bid to `calls` (passes before and after filled in) with the first `cards` played (lowest legal first) */
function played(hands: Hands, calls: string[], cards = 0): BoardState {
  let board: BoardState = newBoard(1, hands)
  for (const call of [...calls, 'P', 'P', 'P']) board = makeCall(board, turnOf(board)!, call)
  for (let i = 0; i < cards; i++) {
    const seat = turnOf(board)!
    board = playCard(board, seat, legalCards(board, seat).at(-1)!)
  }
  return board
}

/** North leads against West's 3NT: North has the four top doubletons */
const tops: Hands = {
  N: hand('AK32 AK2 AK2 AK2'),
  E: hand('QJT9 QJT QJT QJT'),
  S: hand('8765 987 987 987'),
  W: hand('4 6543 6543 6543'),
}

describe('double-dummy mode: a point of the play as DDS input', () => {
  // South declares 7♦ (N P, E P, S 7♦): West leads
  const grand = () => played(suitPerSeat, ['P', 'P', '7D'])

  it('starts with the opening lead: West on lead, diamonds trumps, every card still held', () => {
    const position = ddPosition(grand(), [])!
    expect(position.turn).toBe('W')
    expect(position.legal).toHaveLength(13)
    expect(position.request).toEqual({
      trump: 2,
      first: 3,
      currentTrickSuit: [0, 0, 0],
      currentTrickRank: [0, 0, 0],
      remainCards: pbnDeal(suitPerSeat),
    })
    expect(position).toMatchObject({ declarerTricks: 0, tricksLeft: 13, declarerSide: false })
  })

  it('puts the cards already in the trick on the table and takes them out of the hands', () => {
    const board = grand()
    // West leads ♣2 (the lowest), North has no club and throws ♠2
    const play = [
      { seat: 'W' as const, card: 'C2' },
      { seat: 'N' as const, card: 'S2' },
    ]
    const position = ddPosition(board, play)!
    expect(position.turn).toBe('E')
    expect(position.request.first).toBe(3)
    expect(position.request.currentTrickSuit).toEqual([3, 0, 0])
    expect(position.request.currentTrickRank).toEqual([2, 2, 0])
    expect(position.request.remainCards).toBe('N:AKQJT9876543... .AKQJT98765432.. ..AKQJT98765432. ...AKQJT9876543')
    expect(position.declarerSide).toBe(false)
  })

  it('counts the tricks already won and starts the next trick with its winner', () => {
    const board = played(suitPerSeat, ['P', 'P', '7D'], 4)
    const position = ddPosition(board, board.play)!
    // South ruffs the first club and leads to the second trick
    expect(position.turn).toBe('S')
    expect(position.request.first).toBe(2)
    expect(position.request.currentTrickRank).toEqual([0, 0, 0])
    expect(position).toMatchObject({ declarerTricks: 1, tricksLeft: 12, declarerSide: true })
  })

  it('has nothing to solve once every card is played or without a contract', () => {
    const board = played(suitPerSeat, ['P', 'P', '7D'], 52)
    expect(ddPosition(board, board.play)).toBeNull()
    expect(ddPosition(newBoard(1, suitPerSeat), [])).toBeNull()
  })

  it('tells positions apart by the cards left and the trick', () => {
    const board = grand()
    const a = positionKey(ddPosition(board, [])!.request)
    const b = positionKey(ddPosition(board, [{ seat: 'W', card: 'C2' }])!.request)
    expect(a).not.toBe(b)
    expect(positionKey(ddPosition(board, [])!.request)).toBe(a)
  })

  it('spells out the equivalent cards DDS folds together', () => {
    // ♠A worth 5, and ♠K ♠Q with it; ♥3 worth 4
    const scores = cardScores({ suit: [0, 1], rank: [14, 3], equals: [(1 << 13) | (1 << 12), 0], score: [5, 4] })
    expect(Object.fromEntries(scores)).toEqual({ SA: 5, SK: 5, SQ: 5, H3: 4 })
  })

  it('turns the side to play’s tricks into declarer’s result against the contract', () => {
    const position = ddPosition(played(tops, ['P', 'P', 'P', '3N']), [])!
    expect(position.turn).toBe('N')
    // A defender to play: declarer gets the tricks the defence does not
    const outcomes = cardOutcomes(position, new Map([['SA', 8], ['S2', 7]]), 3)
    expect(outcomes.get('SA')).toEqual({ tricks: 5, diff: -4, best: true })
    expect(outcomes.get('S2')).toEqual({ tricks: 6, diff: -3, best: false })
    // Cards DDS did not score are left out
    expect(outcomes.has('HA')).toBe(false)
  })

  it('writes the result as BBO does', () => {
    expect(outcomeLabel(0)).toBe('=')
    expect(outcomeLabel(2)).toBe('2')
    expect(outcomeLabel(-1)).toBe('1')
  })
})

describe('DDS (WASM) in the browser worker', () => {
  let dds: Dds
  beforeAll(async () => {
    dds = new Dds(await loadDds())
  })

  it('solves a deal where each seat holds one suit', () => {
    const { table, par } = toAnalysis(solveDeal(dds, ddRequest(suitPerSeat, 'N', 'None')))
    expect(table.S).toEqual({ N: 13, E: 0, S: 13, W: 0 })
    expect(table.H).toEqual({ N: 0, E: 13, S: 0, W: 13 })
    expect(table.N).toEqual({ N: 0, E: 0, S: 0, W: 0 })
    // Both sides have a grand slam; NS, the dealer's side, gets in first
    expect(par.scoreNS).toBe(1510)
    expect(par.contracts[0]).toMatchObject({ level: 7, strain: 'S', by: 'NS' })
  })

  it('gives par from North-South’s point of view', () => {
    const hands: Hands = { N: suitPerSeat.E, E: suitPerSeat.N, S: suitPerSeat.W, W: suitPerSeat.S }
    const { par } = toAnalysis(solveDeal(dds, ddRequest(hands, 'E', 'Both')))
    expect(par.scoreNS).toBe(-2210)
    expect(par.contracts[0]).toMatchObject({ level: 7, strain: 'S', by: 'EW' })
  })

  it('solves a random deal', () => {
    const { table } = toAnalysis(solveDeal(dds, ddRequest(deal(), 'S', 'EW')))
    for (const strain of ['N', 'S', 'H', 'D', 'C'] as const)
      for (const tricks of Object.values(table[strain])) expect(tricks).toBeGreaterThanOrEqual(0)
  })

  it('scores every card of a position, the opening lead or in the middle of a trick', () => {
    const board = played(tops, ['P', 'P', 'P', '3N'])
    const lead = ddPosition(board, [])!
    const outcomes = cardOutcomes(lead, cardScores(solvePosition(dds, lead.request)), 3)
    // North cashes eight tricks whatever he leads
    expect([...outcomes.keys()].sort()).toEqual([...board.hands.N].sort())
    for (const outcome of outcomes.values()) expect(outcome).toEqual({ tricks: 5, diff: -4, best: true })

    const middle = ddPosition(board, [{ seat: 'N', card: 'SA' }])!
    expect(middle.turn).toBe('E')
    const after = cardOutcomes(middle, cardScores(solvePosition(dds, middle.request)), 3)
    expect([...after.keys()].sort()).toEqual(['SJ', 'SQ', 'ST', 'S9'].sort())
    for (const outcome of after.values()) expect(outcome.tricks).toBe(5)
  })

  it('solves the last trick with a hand already empty', () => {
    const board = played(suitPerSeat, ['P', 'P', '7D'], 49)
    const position = ddPosition(board, board.play)!
    const outcomes = cardOutcomes(position, cardScores(solvePosition(dds, position.request)), 7)
    expect([...outcomes.values()]).toEqual([{ tricks: 13, diff: 0, best: true }])
  })
})
