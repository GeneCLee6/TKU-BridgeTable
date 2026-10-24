import { describe, expect, it } from 'vitest'
import { imps } from '../../shared/imp.ts'

describe('the WBF IMP scale', () => {
  it('gives every step at its lowest and highest difference', () => {
    const steps: [number, number, number][] = [
      [0, 10, 0], [20, 40, 1], [50, 80, 2], [90, 120, 3], [130, 160, 4], [170, 210, 5], [220, 260, 6],
      [270, 310, 7], [320, 360, 8], [370, 420, 9], [430, 490, 10], [500, 590, 11], [600, 740, 12],
      [750, 890, 13], [900, 1090, 14], [1100, 1290, 15], [1300, 1490, 16], [1500, 1740, 17], [1750, 1990, 18],
      [2000, 2240, 19], [2250, 2490, 20], [2500, 2990, 21], [3000, 3490, 22], [3500, 3990, 23], [4000, 7600, 24],
    ]
    for (const [low, high, won] of steps) {
      expect(imps(low)).toBe(won)
      expect(imps(high)).toBe(won)
      expect(imps(-high)).toBe(won ? -won : 0)
    }
  })

  it('scores the usual swings', () => {
    // 4♠ made against 4♠ one down, not vulnerable
    expect(imps(420 - -50)).toBe(10)
    // 3NT vulnerable made against a part score
    expect(imps(600 - 170)).toBe(10)
    expect(imps(1430 - 680)).toBe(13)
    expect(Object.is(imps(-10), 0)).toBe(true)
  })
})
