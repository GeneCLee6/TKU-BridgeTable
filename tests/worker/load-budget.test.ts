// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { estimate, RUN_SHARE, worstShare, type Plan } from '../../scripts/load/budget.ts'
import { decide } from '../../scripts/load/player.ts'
import { summarize } from '../../scripts/load/stats.ts'

/** The load tool's guard on the shared free allowance, and its simulated player (docs/LOAD.md) */

const smoke: Plan = {
  users: 30,
  humanTables: 3,
  robotTables: 2,
  watchers: 6,
  minutes: 5,
  thinkMs: 2000,
  lobbyEverySeconds: 60,
  churn: 0,
  challengePlayers: 3,
}

describe('load test budget', () => {
  it('lets the preview smoke test run and refuses a full-size run against a remote site', () => {
    expect(worstShare(estimate(smoke))).toBeLessThan(0.05)
    const full = { ...smoke, users: 200, humanTables: 25, robotTables: 5, watchers: 45, minutes: 60 }
    expect(worstShare(estimate(full))).toBeGreaterThan(RUN_SHARE)
  })

  it('grows with the minutes and the robot tables', () => {
    const base = estimate(smoke)
    expect(estimate({ ...smoke, minutes: 10 }).doRequests).toBeGreaterThan(base.doRequests * 1.5)
    expect(estimate({ ...smoke, robotTables: 4, humanTables: 1 }).doGbSeconds).toBeGreaterThan(base.doGbSeconds)
  })
})

describe('the simulated player', () => {
  const board = (extra: object) => ({ board: { phase: 'auction', legalCards: [], legalCalls: [], auction: [], tricks: [], boardNo: 1, ...extra } }) as never

  it('plays only what the server allows, and opens the bidding', () => {
    expect(decide(board({ phase: 'play', legalCards: ['SA'] }))).toEqual({ type: 'play', card: 'SA' })
    expect(decide(board({ legalCalls: ['P', '1C', '1D'] }), () => 0)).toEqual({ type: 'call', call: '1C' })
    expect(decide(board({ legalCalls: ['P', '2C'], auction: [{ seat: 'N', call: '1S' }] }), () => 0.9)).toEqual({ type: 'call', call: 'P' })
    expect(decide(board({}))).toBeNull()
    expect(decide(null)).toBeNull()
  })

  it('summarizes latencies', () => {
    expect(summarize([5, 1, 3, 2, 4])).toEqual({ count: 5, p50: 3, p95: 5, p99: 5, max: 5 })
  })
})
