/**
 * The WBF continuous Victory Point scale (2013, the 20-point scale): how a match's IMP margin turns
 * into Victory Points, for team matches (`e8-t22`) and the multi-team events built on them (E9).
 *
 * With N boards the blitz is B = 15 × √N IMPs: a margin of B or more wins 20–0. Below it the winner
 * gets 10 + 10 × (1 − τ^(3M/B)) / (1 − τ³), τ = (√5 − 1) / 2 the golden ratio's inverse, rounded
 * to two decimals; the loser gets 20 minus that, so every match gives out 20 VP. A tie is 10–10.
 */

const TAU = (Math.sqrt(5) - 1) / 2
export const VP_TOTAL = 20

/** The margin at which the winner gets all 20 VP: 15 × √boards */
export const vpBlitz = (boards: number): number => 15 * Math.sqrt(boards)

/** Victory Points for a side that won (or, negative, lost) by `margin` IMPs in a match of `boards` boards */
export function victoryPoints(margin: number, boards: number): number {
  const size = Math.abs(margin)
  const blitz = vpBlitz(Math.max(1, boards))
  const winner = size >= blitz ? VP_TOTAL : Math.round((10 + (10 * (1 - TAU ** ((3 * size) / blitz))) / (1 - TAU ** 3)) * 100) / 100
  // The loser's share is what the winner leaves, so the two always add up to 20 (no rounding apart)
  return margin < 0 ? Math.round((VP_TOTAL - winner) * 100) / 100 : winner
}

/** Both sides' Victory Points for a match's IMP totals */
export function matchVictoryPoints(imps: { A: number; B: number }, boards: number): { A: number; B: number } {
  const a = victoryPoints(imps.A - imps.B, boards)
  return { A: a, B: Math.round((VP_TOTAL - a) * 100) / 100 }
}
