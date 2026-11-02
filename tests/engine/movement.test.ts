// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { mitchell, MOVEMENT_PAIRS, pairPlace, plannedPlays, tableOfPair } from '../../shared/movement.ts'

/** `shared/movement.ts` (e9-t09): the Mitchell movement for 3–10 tables, with a phantom pair for an odd number */
describe('Mitchell movement', () => {
  const sizes = Array.from({ length: MOVEMENT_PAIRS.max - MOVEMENT_PAIRS.min + 1 }, (_, i) => MOVEMENT_PAIRS.min + i)

  it('takes 5 to 20 pairs only', () => {
    expect(mitchell(4, 2)).toBeNull()
    expect(mitchell(21, 2)).toBeNull()
    expect(mitchell(10, 0)).toBeNull()
    expect(mitchell(5, 2)?.tables).toBe(3)
    expect(mitchell(20, 2)?.tables).toBe(10)
  })

  it.each(sizes)('%i pairs: nobody plays a board twice, and every pair meets its opponents once', (pairs) => {
    const m = mitchell(pairs, 2)!
    expect(m.rounds).toBe(m.tables % 2 ? m.tables : m.tables - 1)
    const boardsOf = new Map<number, number[]>()
    const opponentsOf = new Map<number, number[]>()
    for (const round of m.schedule) {
      // Each round every set is at one table at most, and every pair at one table at most
      const sets = round.tables.map((t) => t.set)
      expect(new Set(sets).size).toBe(sets.length)
      const seated = round.tables.flatMap((t) => [t.ns, t.ew])
      expect(new Set(seated).size).toBe(seated.length)
      // Pairs that do not play this round are exactly those sitting out
      expect([...seated, ...round.sitOut].sort((a, b) => a - b)).toEqual(Array.from({ length: pairs }, (_, i) => i))
      for (const t of round.tables) {
        // NS stays at its table; NS meets EW (never one of its own field)
        expect(t.ns).toBe(t.table - 1)
        expect(pairPlace(t.ns, m.tables).dir).toBe('NS')
        expect(pairPlace(t.ew, m.tables).dir).toBe('EW')
        for (const pair of [t.ns, t.ew]) boardsOf.set(pair, [...(boardsOf.get(pair) ?? []), ...t.boards])
        opponentsOf.set(t.ns, [...(opponentsOf.get(t.ns) ?? []), t.ew])
        opponentsOf.set(t.ew, [...(opponentsOf.get(t.ew) ?? []), t.ns])
      }
    }
    for (let pair = 0; pair < pairs; pair++) {
      const boards = boardsOf.get(pair) ?? []
      expect(new Set(boards).size).toBe(boards.length)
      const opponents = opponentsOf.get(pair) ?? []
      expect(new Set(opponents).size).toBe(opponents.length)
      // Everyone plays every round but the ones they sit out
      const sitOut = m.schedule.filter((r) => r.sitOut.includes(pair)).length
      expect(opponents.length).toBe(m.rounds - sitOut)
    }
    // With an odd number of tables every EW pair meets every NS pair
    if (m.tables % 2 && !m.phantom)
      for (let ew = m.tables; ew < pairs; ew++) expect(opponentsOf.get(ew)!.sort((a, b) => a - b)).toEqual([...Array(m.tables).keys()])
  })

  it('moves EW up one table and the boards down one, skipping a table halfway with an even number', () => {
    const odd = mitchell(10, 2)!
    expect(tableOfPair(odd, 1, 5)?.table).toBe(1)
    expect(tableOfPair(odd, 2, 5)?.table).toBe(2)
    expect(odd.schedule[0].tables[1].set).toBe(1)
    expect(odd.schedule[1].tables[0].set).toBe(1)
    const even = mitchell(8, 1)!
    expect(even.rounds).toBe(3)
    // EW pair 1 (index 4) at tables 1, 2, then 4: the skip after round 2
    expect([1, 2, 3].map((r) => tableOfPair(even, r, 4)?.table)).toEqual([1, 2, 4])
  })

  it('leaves the phantom pair out: the table it would be at sits out', () => {
    const m = mitchell(5, 2)!
    expect(m.phantom).toBe(true)
    expect(m.schedule.every((r) => r.tables.length === 2 && r.sitOut.length === 1)).toBe(true)
    // Each NS pair sits out once, at the round the phantom comes to its table
    expect(m.schedule.map((r) => r.sitOut[0]).sort()).toEqual([0, 1, 2])
  })

  it('numbers the boards by set, and keeps the event within 32 boards', () => {
    const m = mitchell(6, 3)!
    expect(m.boards).toBe(9)
    expect(m.schedule[0].tables.map((t) => t.boards)).toEqual([[1, 2, 3], [4, 5, 6], [7, 8, 9]])
    expect(mitchell(20, 4)!.boardsPerRound).toBe(3)
    expect(mitchell(20, 4)!.boards).toBe(30)
    // Every board is played as often (once fewer where the phantom would have been)
    const plays = plannedPlays(mitchell(7, 1)!).slice(1)
    expect(Math.max(...plays) - Math.min(...plays)).toBeLessThanOrEqual(1)
  })
})
