// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  individual,
  individualRoundsFor,
  individualSizeFor,
  INDIVIDUAL_SIZES,
  plannedPlays,
  sidesAt,
  tableOfPair,
} from '../../shared/movement.ts'
import { scorePairs, type PairsResult } from '../../shared/pairs.ts'

/**
 * `shared/movement.ts` (e9-t15, AC-9.6): the individual movement, a Z-cyclic whist tournament for
 * 8, 12, 16 and 20 players. Every player plays every round, nobody sits at two seats, every two
 * players partner exactly once and play against each other exactly twice, and the scoring gives
 * each player their partnership's matchpoints
 */
describe('individual movement', () => {
  it('takes 8, 12, 16 or 20 players only', () => {
    for (const n of [0, 4, 7, 9, 10, 13, 24]) expect(individual(n, 2)).toBeNull()
    expect(individual(8, 0)).toBeNull()
    expect(INDIVIDUAL_SIZES.map((n) => individual(n, 1)?.tables)).toEqual([2, 3, 4, 5])
    expect(individualSizeFor(7)).toBe(0)
    expect(individualSizeFor(11)).toBe(8)
    expect(individualSizeFor(12)).toBe(12)
    expect(individualSizeFor(30)).toBe(20)
  })

  it.each(INDIVIDUAL_SIZES)('%i players: everyone plays every round, partners everyone once and opposes everyone twice', (n) => {
    const m = individual(n, 1)!
    expect(m.kind).toBe('individual')
    expect(m.rounds).toBe(n - 1)
    expect(m.tables).toBe(n / 4)
    const partners = new Map<string, number>()
    const opponents = new Map<string, number>()
    const key = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`)
    const seen = new Map<number, Set<string>>()
    for (const round of m.schedule) {
      expect(round.sitOut).toEqual([])
      expect(round.tables).toHaveLength(n / 4)
      // Every player at exactly one seat of one table: no seat conflicts, nobody sits out
      const seated = round.tables.flatMap((t) => t.seats!)
      expect([...seated].sort((a, b) => a - b)).toEqual([...Array(n).keys()])
      for (const t of round.tables) {
        const [north, south, east, west] = t.seats!
        // `ns` and `ew` name North and East (what the tables report back)
        expect([t.ns, t.ew]).toEqual([north, east])
        expect(sidesAt(t)).toEqual({ ns: [north, south], ew: [east, west] })
        for (const [a, b] of [[north, south], [east, west]]) partners.set(key(a, b), (partners.get(key(a, b)) ?? 0) + 1)
        for (const a of [north, south]) for (const b of [east, west]) opponents.set(key(a, b), (opponents.get(key(a, b)) ?? 0) + 1)
        // Each table of a round plays the round's boards
        expect(t.boards).toEqual([round.round])
        for (const p of t.seats!) seen.set(p, (seen.get(p) ?? new Set()).add(`${round.round}`))
      }
    }
    for (let a = 0; a < n; a++)
      for (let b = a + 1; b < n; b++) {
        expect(partners.get(key(a, b)), `partners ${a} ${b}`).toBe(1)
        expect(opponents.get(key(a, b)), `opponents ${a} ${b}`).toBe(2)
      }
    // Everyone played every round
    for (let p = 0; p < n; p++) expect(seen.get(p)?.size).toBe(n - 1)
    // Every board is played at every table
    expect(plannedPlays(m).slice(1)).toEqual(Array(m.boards).fill(n / 4))
  })

  it('keeps the event within 32 boards', () => {
    expect(individual(8, 4)).toMatchObject({ rounds: 7, boardsPerRound: 4, boards: 28 })
    expect(individual(12, 3)).toMatchObject({ rounds: 11, boardsPerRound: 2, boards: 22 })
    expect(individual(16, 4)).toMatchObject({ rounds: 15, boardsPerRound: 2, boards: 30 })
    expect(individual(20, 4)).toMatchObject({ rounds: 19, boardsPerRound: 1, boards: 19 })
    const m = individual(8, 2)!
    expect(m.schedule[1].tables.map((t) => t.boards)).toEqual([
      [3, 4],
      [3, 4],
    ])
    expect(tableOfPair(m, 1, m.schedule[0].tables[1].seats![3])?.table).toBe(2)
  })

  it('gives each player their partnership matchpoints, ranked in one field', () => {
    const m = individual(8, 1)!
    // Every board: table 1 makes +420 for NS, table 2 goes one down (-50)
    const results: PairsResult[] = m.schedule.flatMap((round) =>
      round.tables.map((t) => ({
        round: round.round,
        table: t.table,
        boardNo: round.round,
        ns: t.ns,
        ew: t.ew,
        boardId: `b${round.round}-${t.table}`,
        scoreNS: t.table === 1 ? 420 : -50,
        contract: null,
        declarerTricks: null,
        playedAt: 0,
      })),
    )
    const { scored, standings } = scorePairs(m, results)
    // Two tables: a top of 2, the winner takes it all
    expect(scored.every((s) => s.top === 2)).toBe(true)
    expect(standings).toHaveLength(8)
    expect(standings.every((s) => s.dir === undefined && s.boards === 7)).toBe(true)
    // A player's matchpoints are their side's on each board: NS at table 1 or EW at table 2 wins
    for (const s of standings) {
      let mp = 0
      for (const round of m.schedule)
        for (const t of round.tables) {
          const { ns, ew } = sidesAt(t)
          if (ns.includes(s.pair)) mp += t.table === 1 ? 2 : 0
          if (ew.includes(s.pair)) mp += t.table === 1 ? 0 : 2
        }
      expect(s.mp).toBeCloseTo(mp)
      expect(s.percent).toBeCloseTo((mp / 14) * 100)
    }
    // Places follow the percentages, best first
    for (let i = 1; i < standings.length; i++) expect(standings[i].percent).toBeLessThanOrEqual(standings[i - 1].percent + 1e-9)
    // A penalty comes off that player's matchpoints only
    const fined = scorePairs(m, results, { penalties: new Map([[0, 1]]) }).standings
    expect(fined.find((s) => s.pair === 0)!.mp).toBeCloseTo(standings.find((s) => s.pair === 0)!.mp - 1)
    expect(fined.find((s) => s.pair === 1)!.mp).toBeCloseTo(standings.find((s) => s.pair === 1)!.mp)
  })

  // "Only the first N rounds" (§5.25): the schedule's first rounds, boards a round as asked
  it.each(INDIVIDUAL_SIZES)('%i players cut short: no seat conflicts, nobody partners anyone twice, everyone plays every round', (n) => {
    const full = individual(n, 1)!
    for (const rounds of [1, 2, Math.ceil((n - 1) / 2), n - 2]) {
      const m = individual(n, 1, rounds)!
      expect(m.rounds).toBe(rounds)
      expect(m.schedule).toHaveLength(rounds)
      // The same first rounds as the full schedule
      expect(m.schedule).toEqual(full.schedule.slice(0, rounds))
      expect(m.boards).toBe(rounds)
      const partners = new Map<string, number>()
      const key = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`)
      const played = Array(n).fill(0)
      for (const round of m.schedule) {
        const seated = round.tables.flatMap((t) => t.seats!)
        expect([...seated].sort((a, b) => a - b)).toEqual([...Array(n).keys()])
        for (const t of round.tables) {
          const [north, south, east, west] = t.seats!
          for (const [a, b] of [[north, south], [east, west]]) partners.set(key(a, b), (partners.get(key(a, b)) ?? 0) + 1)
          for (const p of t.seats!) played[p]++
        }
      }
      expect(Math.max(...partners.values())).toBe(1)
      // Each player had `rounds` different partners
      for (let p = 0; p < n; p++) expect([...partners.keys()].filter((k) => k.split('-').map(Number).includes(p))).toHaveLength(rounds)
      expect(played).toEqual(Array(n).fill(rounds))
      expect(plannedPlays(m).slice(1)).toEqual(Array(m.boards).fill(n / 4))
    }
    // More than n − 1 plays them all; nothing below 1
    expect(individual(n, 1, n + 5)).toEqual(full)
    expect(individual(n, 1, n - 1)).toEqual(full)
    expect(individual(n, 1, 0)).toBeNull()
    expect(individual(n, 1, 1.5)).toBeNull()
    expect(individualRoundsFor(n)).toBe(n - 1)
    expect(individualRoundsFor(n, 3)).toBe(3)
    expect(individualRoundsFor(n, 99)).toBe(n - 1)
  })

  it('counts the 32-board cap over the rounds played', () => {
    expect(individual(16, 3, 8)).toMatchObject({ rounds: 8, boardsPerRound: 3, boards: 24 })
    expect(individual(20, 4, 6)).toMatchObject({ rounds: 6, boardsPerRound: 4, boards: 24 })
    expect(individual(20, 4, 10)).toMatchObject({ rounds: 10, boardsPerRound: 3, boards: 30 })
  })

  it('scores a cut-short event by each player’s percentage over the boards they played', () => {
    const m = individual(12, 2, 4)!
    const results: PairsResult[] = m.schedule.flatMap((round) =>
      round.tables.flatMap((t) =>
        t.boards.map((boardNo) => ({
          round: round.round,
          table: t.table,
          boardNo,
          ns: t.ns,
          ew: t.ew,
          boardId: `b${boardNo}-${t.table}`,
          scoreNS: [420, 140, -50][t.table - 1],
          contract: null,
          declarerTricks: null,
          playedAt: 0,
        })),
      ),
    )
    const { scored, standings } = scorePairs(m, results)
    // Three tables: top 4 (Neuberg's N is the 3 plays of each board, nobody missing)
    expect(scored.every((s) => s.top === 4)).toBe(true)
    expect(standings).toHaveLength(12)
    expect(standings.every((s) => s.boards === 8)).toBe(true)
    for (const s of standings) {
      let mp = 0
      for (const round of m.schedule)
        for (const t of round.tables) {
          const { ns, ew } = sidesAt(t)
          const nsMp = [4, 2, 0][t.table - 1] * t.boards.length
          if (ns.includes(s.pair)) mp += nsMp
          if (ew.includes(s.pair)) mp += 4 * t.boards.length - nsMp
        }
      expect(s.mp).toBeCloseTo(mp)
      expect(s.percent).toBeCloseTo((mp / (8 * 4)) * 100)
    }
    // A board missing at one table: Neuberg scales it, still out of the same top
    const missing = results.filter((r) => !(r.boardNo === 1 && r.table === 3))
    const adjusted = scorePairs(m, missing)
    // (mp + 1) × 3 / 2 − 1 on two results: 3.5 for the beat one's winner, 0.5 for the other
    const board1 = adjusted.scored.filter((s) => s.result.boardNo === 1).map((s) => s.mpNS)
    expect(board1[0]).toBeCloseTo(3.5)
    expect(board1[1]).toBeCloseTo(0.5)
    expect(adjusted.standings.filter((s) => s.boards === 7)).toHaveLength(4)
  })
})
