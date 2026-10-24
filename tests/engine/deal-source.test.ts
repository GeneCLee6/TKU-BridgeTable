import { describe, expect, it } from 'vitest'
import { deal } from '../../shared/board.ts'
import { SEATS } from '../../shared/cards.ts'
import { dealFrom, RANDOM_DEALS } from '../../shared/deal-source.ts'

describe('deal sources', () => {
  it('shuffles a full deck every board when random', () => {
    const hands = dealFrom(RANDOM_DEALS, 7, () => 0)!
    expect(SEATS.flatMap((s) => hands[s])).toHaveLength(52)
    expect(new Set(SEATS.flatMap((s) => hands[s])).size).toBe(52)
  })

  it('deals the fixed hands board by board, and nothing after the last', () => {
    const deals = [deal(), deal()]
    const source = { kind: 'fixed', deals } as const
    expect(dealFrom(source, 1, () => 0)).toEqual(deals[0])
    expect(dealFrom(source, 2, () => 0)).toEqual(deals[1])
    expect(dealFrom(source, 3, () => 0)).toBeNull()
  })

  it('hands out a copy, so playing a board cannot change the set', () => {
    const deals = [deal()]
    const hands = dealFrom({ kind: 'fixed', deals }, 1, () => 0)!
    hands.N.pop()
    expect(deals[0].N).toHaveLength(13)
  })
})
