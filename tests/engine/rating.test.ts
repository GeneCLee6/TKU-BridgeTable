import { describe, expect, it } from 'vitest'
import {
  eventGames,
  glicko2,
  idle,
  INITIAL_RATING,
  isProvisional,
  MAX_RD,
  ROBOT_RATINGS,
  sideRating,
  type Rating,
} from '../../shared/rating.ts'

/** Glicko-2 (`e9-t07`, AC-9.3): the numbers of Glickman's own worked example */

describe('glicko2', () => {
  it('matches the example in Glickman’s paper', () => {
    const player: Rating = { rating: 1500, rd: 200, vol: 0.06 }
    const next = glicko2(player, [
      { opponent: { rating: 1400, rd: 30 }, score: 1 },
      { opponent: { rating: 1550, rd: 100 }, score: 0 },
      { opponent: { rating: 1700, rd: 300 }, score: 0 },
    ])
    // "r′ = 1464.06, RD′ = 151.52, σ′ = 0.05999" (0.059996 before rounding)
    expect(next.rating).toBeCloseTo(1464.06, 1)
    expect(next.rd).toBeCloseTo(151.52, 1)
    expect(next.vol).toBeCloseTo(0.059996, 6)
  })

  it('only grows the RD for a period without games', () => {
    const player: Rating = { rating: 1500, rd: 200, vol: 0.06 }
    const next = glicko2(player, [])
    expect(next.rating).toBe(1500)
    expect(next.rd).toBeCloseTo(Math.sqrt(200 ** 2 + (0.06 * 173.7178) ** 2), 6)
  })

  it('a win raises and a loss lowers the rating; a weight below one moves it less', () => {
    const opponent = { rating: 1500, rd: 100 }
    const won = glicko2(INITIAL_RATING, [{ opponent, score: 1 }])
    const lost = glicko2(INITIAL_RATING, [{ opponent, score: 0 }])
    const half = glicko2(INITIAL_RATING, [{ opponent, score: 1, weight: 0.5 }])
    expect(won.rating).toBeGreaterThan(1500)
    expect(lost.rating).toBeLessThan(1500)
    expect(won.rating - 1500).toBeCloseTo(1500 - lost.rating, 6)
    expect(half.rating).toBeGreaterThan(1500)
    expect(half.rating).toBeLessThan(won.rating)
    expect(won.rd).toBeLessThan(INITIAL_RATING.rd)
  })

  it('a new player is provisional until the RD comes down', () => {
    expect(isProvisional(INITIAL_RATING)).toBe(true)
    expect(isProvisional({ rd: 80 })).toBe(false)
  })
})

describe('idle', () => {
  it('grows the RD once a period, never past the start', () => {
    const player: Rating = { rating: 1600, rd: 60, vol: 0.06 }
    expect(idle(player, 0)).toEqual(player)
    expect(idle(player, 1).rd).toBeCloseTo(Math.sqrt(60 ** 2 + (0.06 * 173.7178) ** 2), 6)
    expect(idle(player, 10_000).rd).toBe(MAX_RD)
    expect(idle(player, 3).rating).toBe(1600)
  })
})

describe('eventGames', () => {
  const ratings = new Map<string, Rating>([
    ['a', { rating: 1600, rd: 80, vol: 0.06 }],
    ['b', { rating: 1400, rd: 80, vol: 0.06 }],
  ])
  const ratingOf = (id: string) => ratings.get(id) ?? INITIAL_RATING

  it('plays every other side, scored by place: ties draw', () => {
    const games = eventGames(
      [
        { userIds: ['a'], robots: 0, rank: 1 },
        { userIds: ['b'], robots: 0, rank: 2 },
        { userIds: ['c'], robots: 0, rank: 2 },
      ],
      ratingOf,
    )
    expect(games.get('a')!.map((g) => g.score)).toEqual([1, 1])
    expect(games.get('b')!.map((g) => g.score)).toEqual([0, 0.5])
    expect(games.get('c')!.map((g) => g.score)).toEqual([0, 0.5])
    expect(games.get('a')![0].opponent).toEqual({ rating: 1400, rd: 80 })
  })

  it('shares the weight in a big field: at most three games’ worth', () => {
    const sides = Array.from({ length: 13 }, (_, i) => ({ userIds: [`p${i}`], robots: 0, rank: i + 1 }))
    const games = eventGames(sides, ratingOf)
    expect(games.get('p0')).toHaveLength(12)
    expect(games.get('p0')![0].weight).toBeCloseTo(0.25, 9)
    expect(eventGames(sides.slice(0, 3), ratingOf).get('p0')![0].weight).toBe(1)
  })

  it('gives no games with fewer than two sides', () => {
    expect(eventGames([{ userIds: ['a'], robots: 0, rank: 1 }], ratingOf).size).toBe(0)
  })

  it('counts robots in a side at their fixed rating', () => {
    const team = sideRating({ userIds: ['a'], robots: 3, rank: 1 }, ratingOf)
    expect(team.rating).toBeCloseTo((1600 + 3 * ROBOT_RATINGS.tkb.rating) / 4, 9)
    const robots = sideRating({ userIds: [], robots: 4, rank: 2 }, ratingOf)
    expect(robots).toEqual({ rating: ROBOT_RATINGS.tkb.rating, rd: ROBOT_RATINGS.tkb.rd })
  })
})
