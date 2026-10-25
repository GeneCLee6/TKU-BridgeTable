// @vitest-environment node
import { Dds, loadDds } from 'bridge-dds'
import { beforeAll, describe, expect, it } from 'vitest'
import { deal } from '../../shared/board.ts'
import type { Card, Hands } from '../../shared/cards.ts'
import { newBoard } from '../../shared/game.ts'
import { ddRequest, isCompleteDeal, parseParContract, pbnDeal, toAnalysis } from '../../src/lib/doubleDummy.ts'
import { solveDeal } from '../../src/lib/ddsSolve.ts'
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
})
