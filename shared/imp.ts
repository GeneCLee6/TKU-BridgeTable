/**
 * The WBF IMP scale: how many International Match Points a difference in score is worth. Shared by
 * challenges (E7) and team matches (E8).
 */

/** The lowest difference worth each IMP: 20–40 is 1 IMP, 50–80 is 2, …, 4000 and more is 24 */
const STEPS = [20, 50, 90, 130, 170, 220, 270, 320, 370, 430, 500, 600, 750, 900, 1100, 1300, 1500, 1750, 2000, 2250, 2500, 3000, 3500, 4000]

/** IMPs for a difference in score, with its sign: imps(420 - 170) is 6, imps(-250) is -6 */
export function imps(difference: number): number {
  const size = Math.abs(difference)
  let won = 0
  while (won < STEPS.length && size >= STEPS[won]) won++
  return difference < 0 && won ? -won : won
}
