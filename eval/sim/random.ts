import type { RandomInt } from '../../shared/board.ts'
import { hashText } from '../deals.ts'

/**
 * Seeded random numbers for the simulations (eval/sim/README.md): the same generator as the
 * platform's deal sets (mulberry32 seeded from a text), so a sample drawn for a board and a
 * decision point is the same whichever thread draws it, and a run can be repeated exactly.
 */
export function seededRandom(seed: string): RandomInt {
  let state = hashText(seed) >>> 0
  return (n: number) => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4_294_967_296) * n)
  }
}
