import type { Contract } from './auction.ts'

/**
 * Duplicate bridge score for the declaring side (negative when the contract fails).
 * Laws of Duplicate Bridge 2017, Law 77.
 */
export function duplicateScore(contract: Contract, declarerTricks: number, vulnerable: boolean): number {
  const { level, strain, doubled } = contract
  const needed = level + 6
  const multiplier = doubled === 'XX' ? 4 : doubled === 'X' ? 2 : 1

  if (declarerTricks < needed) {
    const down = needed - declarerTricks
    if (!doubled) return -down * (vulnerable ? 100 : 50)
    let penalty = 0
    for (let i = 1; i <= down; i++) {
      if (i === 1) penalty += vulnerable ? 200 : 100
      else if (i <= 3) penalty += vulnerable ? 300 : 200
      else penalty += 300
    }
    return -penalty * (doubled === 'XX' ? 2 : 1)
  }

  const perTrick = strain === 'C' || strain === 'D' ? 20 : 30
  const trickScore = (level * perTrick + (strain === 'N' ? 10 : 0)) * multiplier
  let score = trickScore

  const over = declarerTricks - needed
  if (!doubled) score += over * perTrick
  else score += over * (vulnerable ? 200 : 100) * (doubled === 'XX' ? 2 : 1)

  score += trickScore >= 100 ? (vulnerable ? 500 : 300) : 50
  if (level === 6) score += vulnerable ? 750 : 500
  if (level === 7) score += vulnerable ? 1500 : 1000
  if (doubled === 'X') score += 50
  if (doubled === 'XX') score += 100
  return score
}

/** '=' when made exactly, '+2' for overtricks, '-1' for undertricks */
export function resultLabel(contract: Contract, declarerTricks: number): string {
  const diff = declarerTricks - (contract.level + 6)
  return diff === 0 ? '=' : diff > 0 ? `+${diff}` : `${diff}`
}
