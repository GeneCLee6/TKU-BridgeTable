import { describe, expect, it } from 'vitest'
import { challengeStats, type StatsChallenge } from '../../shared/challenge-stats.ts'
import type { ScoreRuling } from '../../shared/ruling-scoring.ts'

/** A member's challenge record (e7-t29), worked by hand */

const head: StatsChallenge = {
  id: 'c1',
  at: 100,
  scoring: 'imp',
  scores: { amy: [420, 100], ben: [170, 100] },
  ranks: { amy: 1, ben: 2 },
}
const three: StatsChallenge = {
  id: 'c2',
  at: 200,
  scoring: 'mp',
  scores: { amy: [100], ben: [200], cat: [100] },
  ranks: { ben: 1, amy: 2, cat: 2 },
}
const alone: StatsChallenge = { id: 'c3', at: 300, scoring: 'total', scores: { amy: [620] }, ranks: { amy: 1 } }

describe('challenge stats (e7-t29)', () => {
  it('counts meetings by the challenge scoring and IMPs per board compared', () => {
    const stats = challengeStats('amy', [head, three, alone])
    // c1: +6 IMPs, a win; c2: lost to ben (0%), drew with cat (50%); c3 had nobody to meet
    expect(stats).toMatchObject({ challenges: 2, firsts: 1, wins: 1, losses: 1, draws: 1, winRate: 0.5 })
    // IMPs: +6, 0 against ben in c1; −3 against ben and 0 against cat in c2
    expect(stats.boards).toBe(4)
    expect(stats.averageImps).toBe(0.75)
    expect(stats.opponents).toEqual([
      { opponent: 'ben', wins: 1, losses: 1, draws: 0, challenges: 2, boards: 3, imps: 3, lastAt: 200 },
      { opponent: 'cat', wins: 0, losses: 0, draws: 1, challenges: 1, boards: 1, imps: 0, lastAt: 200 },
    ])
  })

  it('is empty for someone never ranked against anyone', () => {
    expect(challengeStats('dan', [head, three])).toEqual({
      wins: 0,
      losses: 0,
      draws: 0,
      challenges: 0,
      firsts: 0,
      winRate: null,
      boards: 0,
      averageImps: null,
      opponents: [],
    })
  })

  it('leaves out a board given an artificial score', () => {
    const ruled: StatsChallenge = { ...head, rulings: { ben: [{ kind: 'avg' } as ScoreRuling, null] } }
    const stats = challengeStats('amy', [ruled])
    // Only board 2 is compared: 0 IMPs, a draw
    expect(stats).toMatchObject({ wins: 0, draws: 1, boards: 1, averageImps: 0 })
  })
})
