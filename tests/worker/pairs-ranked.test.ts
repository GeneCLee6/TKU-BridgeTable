// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { makeDealSet } from '../../shared/deal-set.ts'
import { mitchell } from '../../shared/movement.ts'
import type { PairsResult } from '../../shared/pairs.ts'
import type { PairsEvent } from '../../worker/pairs-flow.ts'
import { pairsRanked } from '../../worker/pairs-service.ts'

/** A finished pairs event as the points ledger takes it (J3 → J2's `RankingsService.record`) */
describe('pairsRanked', () => {
  const movement = mitchell(6, 1)!
  const result = (boardNo: number, ns: number, ew: number, scoreNS: number): PairsResult => ({
    round: 1,
    table: ns + 1,
    boardNo,
    ns,
    ew,
    boardId: `b${boardNo}${ns}`,
    scoreNS,
    contract: null,
    declarerTricks: null,
    playedAt: 5,
  })
  const event: PairsEvent = {
    id: 'e1',
    directorId: 'a1',
    createdAt: 1,
    status: 'finished',
    settings: { title: '', boardsPerRound: 1, boardMinutes: 0 },
    pairs: Array.from({ length: 6 }, (_, i) => ({ players: [`a${i}`, `b${i}`] as [string, string], at: 1 })),
    movement,
    deals: makeDealSet({ kind: 'random', count: 3 })!,
    startedAt: 2,
    round: 3,
    roundTables: [],
    results: [result(1, 0, 3, 420), result(1, 1, 4, 100), result(1, 2, 5, -50)],
    finishedAt: 9,
  }

  it('ranks every pair across both fields by percentage, ties sharing a place', () => {
    const ranked = pairsRanked(event)!
    expect(ranked).toMatchObject({ id: 'e1', kind: 'pairs', at: 9 })
    const rankOf = (pair: number) => ranked.sides.find((s) => s.userIds[0] === `a${pair}`)!.rank
    // NS 0 and EW 5 both have 100%; NS 1 and EW 4 50%; NS 2 and EW 3 0%
    expect([0, 5, 1, 4, 2, 3].map(rankOf)).toEqual([1, 1, 3, 3, 5, 5])
    expect(ranked.sides.every((s) => s.robots === 0 && s.userIds.length === 2)).toBe(true)
  })

  it('is nothing before the end', () => {
    expect(pairsRanked({ ...event, status: 'playing' })).toBeNull()
  })
})
