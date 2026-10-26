import type { Contract } from '../../shared/auction.ts'
import { isVulnerable, type Vulnerability } from '../../shared/board.ts'
import { sideOf } from '../../shared/cards.ts'
import { imps } from '../../shared/imp.ts'
import { duplicateScore } from '../../shared/scoring.ts'
import type { DdTable } from './doubleDummy.ts'

/**
 * The numbers of a bidding practice's review (`e10-t07`): where an auction ends, played double
 * dummy. The calls themselves (TKB's at each step, TKB's own auction) come from the server; this
 * only scores the contracts against the DD table the browser worked out
 */

export interface DdOutcome {
  /** The declarer's tricks double dummy; none when the board was passed out */
  tricks: number | null
  /** North-South's score */
  scoreNS: number
}

export function ddOutcome(contract: Contract | null, table: DdTable, vul: Vulnerability): DdOutcome {
  if (!contract) return { tricks: null, scoreNS: 0 }
  const tricks = table[contract.strain][contract.declarer]
  const score = duplicateScore(contract, tricks, isVulnerable(vul, contract.declarer))
  return { tricks, scoreNS: sideOf(contract.declarer) === 'NS' ? score : -score }
}

/** IMPs North-South (the member's side) would gain bidding as TKB did instead (negative: lose) */
export const robotGain = (actual: DdOutcome, robot: DdOutcome) => imps(robot.scoreNS - actual.scoreNS)
