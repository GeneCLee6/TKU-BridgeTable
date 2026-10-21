import { describe, expect, it } from 'vitest'
import type { Contract } from '../../shared/auction.ts'
import { duplicateScore, resultLabel } from '../../shared/scoring.ts'

const c = (text: string): Contract => {
  const [, level, strain, doubled] = text.match(/^(\d)([CDHSN])(X{0,2})$/)!
  return { level: Number(level), strain: strain as Contract['strain'], doubled: doubled as Contract['doubled'], declarer: 'S' }
}

describe('duplicateScore', () => {
  it.each([
    // contract, tricks, vulnerable, score
    ['1N', 7, false, 90],
    ['2S', 9, false, 140],
    ['3N', 9, false, 400],
    ['3N', 10, true, 630],
    ['4S', 10, true, 620],
    ['4H', 10, false, 420],
    ['5D', 11, false, 400],
    ['3C', 9, false, 110],
    ['6S', 12, false, 980],
    ['6N', 12, true, 1440],
    ['7N', 13, true, 2220],
    ['7C', 13, false, 1440],
    ['1NX', 7, false, 180],
    ['2SX', 8, false, 470],
    ['2SX', 9, true, 870],
    ['1CXX', 7, false, 230],
    ['4SXX', 10, true, 1080],
  ])('%s with %i tricks (vul %s) scores %i', (contract, tricks, vul, score) => {
    expect(duplicateScore(c(contract), tricks, vul)).toBe(score)
  })

  it.each([
    ['4S', 9, false, -50],
    ['4S', 8, true, -200],
    ['3NX', 8, false, -100],
    ['3NX', 7, false, -300],
    ['3NX', 6, false, -500],
    ['3NX', 5, false, -800],
    ['3NX', 8, true, -200],
    ['3NX', 6, true, -800],
    ['3NX', 5, true, -1100],
    ['3NXX', 7, false, -600],
    ['7NXX', 0, true, -7600],
  ])('%s with %i tricks (vul %s) scores %i', (contract, tricks, vul, score) => {
    expect(duplicateScore(c(contract), tricks, vul)).toBe(score)
  })
})

describe('resultLabel', () => {
  it('shows made, overtricks and undertricks', () => {
    expect(resultLabel(c('4S'), 10)).toBe('=')
    expect(resultLabel(c('4S'), 12)).toBe('+2')
    expect(resultLabel(c('4S'), 7)).toBe('-3')
  })
})
