import type { Dds } from 'bridge-dds'
import type { DdPositionRaw, DdPositionRequest, DdRawResult, DdRequest } from './doubleDummy.ts'

/** The DD table (every strain, every declarer) and the par for the board's dealer and vulnerability */
export function solveDeal(dds: Dds, request: DdRequest): DdRawResult {
  const table = dds.CalcDDTablePBN({ cards: request.deal })
  const par = dds.DealerPar(table, request.dealer, request.vulnerable)
  return { resTable: table.resTable, par: { score: par.score, contracts: par.contracts } }
}

/**
 * Every legal card of the hand to play at one point of the play, with the tricks its side then
 * takes (SolveBoard with target -1 and solutions 3: all cards, each scored; mode 1 scores even a
 * forced card)
 */
export function solvePosition(dds: Dds, request: DdPositionRequest): DdPositionRaw {
  const { suit, rank, equals, score } = dds.SolveBoardPBN(request, -1, 3, 1)
  return { suit, rank, equals, score }
}
