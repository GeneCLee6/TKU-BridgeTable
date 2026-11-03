import { describe, expect, it } from 'vitest'
import {
  BYE_VP,
  eventStandings,
  formatFor,
  nextPairing,
  roundRobinRounds,
  roundRobinSchedule,
  swissPairing,
  teamStandings,
  type EventMatchScore,
  type RoundPairing,
  type TeamEvent,
  type TeamEventMatchScore,
} from '../../shared/team-event.ts'
import { matchVictoryPoints } from '../../shared/vp.ts'

/** The pairings and standings of multi-team events (`e9-t14`, AC-9.5, ARCHITECTURE.md §5.26) */

const key = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`)

describe('round robin (e9-t14)', () => {
  for (let n = 3; n <= 16; n++)
    it(`${n} teams: everyone meets everyone once, one match each a round, byes only with an odd number`, () => {
      const rounds = roundRobinSchedule(n)
      expect(rounds).toHaveLength(roundRobinRounds(n))
      const met = new Map<string, number>()
      const byes = new Map<number, number>()
      const hosted = new Map<number, number>()
      for (const r of rounds) {
        const inRound = [...r.pairs.flat(), ...(r.bye === undefined ? [] : [r.bye])]
        // Every team exactly once a round
        expect([...inRound].sort((a, b) => a - b)).toEqual(Array.from({ length: n }, (_, i) => i))
        expect(r.bye === undefined).toBe(n % 2 === 0)
        for (const [a, b] of r.pairs) {
          expect(a).not.toBe(b)
          met.set(key(a, b), (met.get(key(a, b)) ?? 0) + 1)
          hosted.set(a, (hosted.get(a) ?? 0) + 1)
        }
        if (r.bye !== undefined) byes.set(r.bye, (byes.get(r.bye) ?? 0) + 1)
      }
      expect(met.size).toBe((n * (n - 1)) / 2)
      expect([...met.values()].every((c) => c === 1)).toBe(true)
      if (n % 2) expect([...byes.values()]).toEqual(Array(n).fill(1))
      // Hosting is spread: with four or more teams nobody hosts every one of their n − 1 matches
      if (n >= 4) for (let t = 0; t < n; t++) expect(hosted.get(t) ?? 0).toBeLessThan(n - 1)
    })

  it('is chosen when everyone can meet within the rounds allowed; Swiss otherwise', () => {
    expect(formatFor(4, 5)).toEqual({ format: 'roundRobin', rounds: 3 })
    expect(formatFor(5, 5)).toEqual({ format: 'roundRobin', rounds: 5 })
    expect(formatFor(6, 5)).toEqual({ format: 'roundRobin', rounds: 5 })
    expect(formatFor(7, 5)).toEqual({ format: 'swiss', rounds: 5 })
    expect(formatFor(12, 7)).toEqual({ format: 'swiss', rounds: 7 })
    expect(formatFor(3, 3)).toEqual({ format: 'roundRobin', rounds: 3 })
    // Never more Swiss rounds than there are other teams
    expect(formatFor(4, 2)).toEqual({ format: 'swiss', rounds: 2 })
  })
})

describe('Swiss pairing (e9-t14)', () => {
  it('pairs top down by the standings in the first round', () => {
    expect(swissPairing([0, 1, 2, 3, 4, 5], [])).toEqual({ pairs: [[0, 1], [2, 3], [4, 5]] })
  })

  it('gives the bye to the lowest placed team without one', () => {
    expect(swissPairing([0, 1, 2, 3, 4], [])).toEqual({ pairs: [[0, 1], [2, 3]], bye: 4 })
    const history: RoundPairing[] = [{ pairs: [[0, 1], [2, 3]], bye: 4 }]
    // 4 is last again but had its bye: 3 sits out
    const next = swissPairing([0, 2, 1, 4, 3], history)
    expect(next.bye).toBe(3)
    expect(next.pairs).toEqual([[0, 2], [1, 4]])
  })

  it('never repeats an opponent while a pairing without repeats exists', () => {
    // 8 teams, 7 rounds with the standings shuffled each round: every round finds new opponents
    let seed = 7
    const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647
    for (let trial = 0; trial < 20; trial++) {
      const history: RoundPairing[] = []
      for (let round = 0; round < 7; round++) {
        const order = Array.from({ length: 8 }, (_, i) => i).sort(() => random() - 0.5)
        const pairing = swissPairing(order, history)
        expect(pairing.pairs).toHaveLength(4)
        const met = new Set(history.flatMap((r) => r.pairs.map(([a, b]) => key(a, b))))
        // With seven rounds of eight a complete set may be cornered late: then and only then a repeat
        const repeats = pairing.pairs.filter(([a, b]) => met.has(key(a, b)))
        if (round < 4) expect(repeats).toEqual([])
        history.push(pairing)
      }
    }
  })

  it('goes back to avoid a repeat the greedy pairing would make', () => {
    // 0–1 and 2–3 met; greedy 0–2 would leave 1–3 (fine), so make 1–3 met too: 0–2 then 1–? forces going back
    const history: RoundPairing[] = [{ pairs: [[0, 1], [2, 3]] }, { pairs: [[0, 3], [1, 2]] }]
    expect(swissPairing([0, 1, 2, 3], history)).toEqual({ pairs: [[0, 2], [1, 3]] })
    // Every pairing is a repeat (4 teams, 3 rounds played): it still pairs everyone
    const all: RoundPairing[] = [...history, { pairs: [[0, 2], [1, 3]] }]
    expect(swissPairing([0, 1, 2, 3], all).pairs).toHaveLength(2)
  })

  it('with an odd field gives each team at most one bye while it can, and no repeats', () => {
    const history: RoundPairing[] = []
    const byes: number[] = []
    for (let round = 0; round < 5; round++) {
      const order = [0, 1, 2, 3, 4].map((x) => (x + round) % 5)
      const p = swissPairing(order, history)
      byes.push(p.bye!)
      const met = new Set(history.flatMap((r) => r.pairs.map(([a, b]) => key(a, b))))
      expect(p.pairs.filter(([a, b]) => met.has(key(a, b)))).toEqual([])
      history.push(p)
    }
    expect(new Set(byes).size).toBe(5)
  })
})

describe('VP standings (e9-t14)', () => {
  const m = (a: number, b: number, A: number, B: number, boards = 8): TeamEventMatchScore => ({
    a,
    b,
    imps: { A, B },
    vp: matchVictoryPoints({ A, B }, boards),
  })

  it('adds up each match\'s VP and the byes', () => {
    const matches = [m(0, 1, 30, 10), m(2, 0, 12, 12)]
    const s = teamStandings(3, matches, [2])
    const vp = (t: number) => s.find((x) => x.team === t)!.vp
    const won = matchVictoryPoints({ A: 30, B: 10 }, 8)
    expect(vp(0)).toBe(Math.round((won.A + 10) * 100) / 100)
    expect(vp(1)).toBe(won.B)
    expect(vp(2)).toBe(10 + BYE_VP)
    // Every match gives out 20
    expect(vp(0) + vp(1) + vp(2)).toBeCloseTo(40 + BYE_VP, 6)
    expect(s.map((x) => x.team)).toEqual([0, 2, 1])
    expect(s.find((x) => x.team === 2)).toMatchObject({ played: 1, byes: 1, impsFor: 12, impsAgainst: 12, rank: 2 })
  })

  it('breaks a tie of two by their own match, then by the IMP quotient; still level they share the place', () => {
    // 0 beat 1 by a little; both beat 2 and 3 so that 0 and 1 end level on VP
    const head = m(0, 1, 11, 10)
    const h = head.vp
    // Pick the other results so that both totals are the same
    const matches = [head, { a: 0, b: 2, imps: { A: 5, B: 5 }, vp: { A: 20 - h.A + 5, B: h.A - 5 } }, { a: 1, b: 3, imps: { A: 50, B: 0 }, vp: { A: 20 - h.B + 5, B: h.B - 5 } }]
    const s = teamStandings(4, matches, [])
    expect(s[0].vp).toBe(s[1].vp)
    // 1 has the better quotient, but 0 won their match
    expect(s.slice(0, 2).map((x) => [x.team, x.rank])).toEqual([[0, 1], [1, 2]])

    // Level and never met: the quotient decides
    const q = teamStandings(4, [m(0, 2, 30, 10), m(1, 3, 40, 20)], [])
    expect(q[0].vp).toBe(q[1].vp)
    expect(q.slice(0, 2).map((x) => x.team)).toEqual([0, 1])
    expect(q[0].rank).toBe(1)
    expect(q[1].rank).toBe(2)

    // Level everywhere: shared place, entry order on the list
    const same = teamStandings(4, [m(0, 2, 20, 10), m(1, 3, 20, 10)], [])
    expect(same.map((x) => [x.team, x.rank])).toEqual([[0, 1], [1, 1], [2, 3], [3, 3]])
  })

  it('a three-way tie goes straight to the quotient', () => {
    // Round robin of three, each won one by the same margin
    const s = teamStandings(3, [m(0, 1, 20, 10), m(1, 2, 25, 15), m(2, 0, 30, 20)], [])
    expect(new Set(s.map((x) => x.vp)).size).toBe(1)
    // Quotients: 0 = 40/40, 1 = 35/35, 2 = 45/45: all 1, so they share first
    expect(s.every((x) => x.rank === 1)).toBe(true)
  })
})

describe('the event as kept (e9-t14)', () => {
  const event = (over: Partial<TeamEvent> = {}): TeamEvent => ({
    id: 'e1',
    directorId: 'boss',
    createdAt: 0,
    settings: { title: '盃', boards: 4, boardMinutes: 10, rounds: 5 },
    format: 'swiss',
    roundsTotal: 3,
    teams: Array.from({ length: 5 }, (_, i) => ({ id: `t${i + 1}`, name: '', players: [], lineup: [] })),
    played: [],
    status: 'playing',
    ...over,
  })

  it('counts finished and abandoned matches, and a bye once its round is over', () => {
    const scores: Record<string, EventMatchScore> = {
      m1: { status: 'finished', imps: { A: 20, B: 0 }, boards: 4 },
      m2: { status: 'playing', imps: { A: 3, B: 0 }, boards: 4 },
    }
    const e = event({ played: [{ n: 1, matches: [{ a: 0, b: 1, matchId: 'm1' }, { a: 2, b: 3, matchId: 'm2' }], bye: 4, at: 0 }] })
    const scoreOf = (id: string) => scores[id] ?? null
    let s = eventStandings(e, scoreOf)
    expect(s.find((x) => x.team === 4)!.vp).toBe(0)
    expect(s.find((x) => x.team === 2)!.played).toBe(0)
    scores.m2 = { status: 'abandoned', imps: { A: 3, B: 0 }, boards: 4 }
    s = eventStandings(e, scoreOf)
    expect(s.find((x) => x.team === 4)!.vp).toBe(BYE_VP)
    expect(s.find((x) => x.team === 2)!.vp).toBe(matchVictoryPoints({ A: 3, B: 0 }, 4).A)
    // 20 IMPs over 4 boards is past the blitz (30): not quite 20
    expect(s.find((x) => x.team === 0)!.vp).toBe(matchVictoryPoints({ A: 20, B: 0 }, 4).A)
  })

  it('pairs the next Swiss round from the standings, and a round robin from its schedule', () => {
    const scores: Record<string, EventMatchScore> = {
      m1: { status: 'finished', imps: { A: 0, B: 40 }, boards: 4 },
      m2: { status: 'finished', imps: { A: 40, B: 0 }, boards: 4 },
    }
    const e = event({ played: [{ n: 1, matches: [{ a: 0, b: 1, matchId: 'm1' }, { a: 2, b: 3, matchId: 'm2' }], bye: 4, at: 0 }] })
    const next = nextPairing(e, (id) => scores[id] ?? null)
    // Standings: 1 and 2 (20 VP), 4 (bye 12), 0 and 3 (0): the bye goes to 3, the lowest without one
    expect(next.bye).toBe(3)
    expect(next.pairs).toEqual([[1, 2], [4, 0]])
    const rr = event({ format: 'roundRobin', roundsTotal: 5 })
    expect(nextPairing(rr, () => null)).toEqual(roundRobinSchedule(5)[0])
  })
})
