import type { Dds } from 'bridge-dds'
import type { DdRawResult, DdRequest } from './doubleDummy.ts'

/** The DD table (every strain, every declarer) and the par for the board's dealer and vulnerability */
export function solveDeal(dds: Dds, request: DdRequest): DdRawResult {
  const table = dds.CalcDDTablePBN({ cards: request.deal })
  const par = dds.DealerPar(table, request.dealer, request.vulnerable)
  return { resTable: table.resTable, par: { score: par.score, contracts: par.contracts } }
}
