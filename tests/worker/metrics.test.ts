// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { alertsOf, METRICS_WINDOW_MS, Metrics, RECONNECT_WINDOW_MS, TableCounters } from '../../worker/metrics.ts'

/** The status page's numbers (e11-t22, ARCHITECTURE.md §5.13) */

describe('metrics', () => {
  it('counts actions, refusals, bugs and requests, with the 95th percentile of an action', () => {
    let time = 1_000_000
    const metrics = new Metrics(() => time)
    for (let i = 0; i < 95; i++) metrics.observe({ event: 'action', type: 'call', user: 'u', ms: 3 })
    for (let i = 0; i < 5; i++) metrics.observe({ event: 'action', type: 'play', user: 'u', ms: 400, code: 'notYourTurn' })
    metrics.observe({ event: 'crash', where: 'call', error: 'x' })
    metrics.observe({ event: 'rejected', user: 'u', code: 'slowDown' })
    metrics.observe({ event: 'http', method: 'GET', path: '/api/me', status: 200, ms: 1 })
    metrics.observe({ event: 'http', method: 'GET', path: '/api/me', status: 500, ms: 1 })
    time += 60_000
    const view = metrics.view()
    expect(view).toMatchObject({ actions: 100, refused: 5, crashes: 1, rejected: 1, requests: 2, serverErrors: 1, actionP95Ms: 5 })
    expect(view.errorRate).toBeCloseTo(2 / 102, 4)
    expect(alertsOf(view)).toEqual(['errorRate'])
  })

  it('tells a reconnect from a new visit, and keeps the peak online', () => {
    let time = 1_000_000
    const metrics = new Metrics(() => time)
    metrics.connected('a', 1)
    metrics.connected('b', 2)
    metrics.disconnected('a')
    time += RECONNECT_WINDOW_MS / 2
    metrics.connected('a', 2)
    metrics.disconnected('b')
    time += RECONNECT_WINDOW_MS * 2
    metrics.connected('b', 2)
    expect(metrics.view()).toMatchObject({ connects: 4, reconnects: 1, reconnectRate: 0.25, peakOnline: 2 })
  })

  it('adds what the tables report with their boards, and forgets what is older than an hour', () => {
    let time = 1_000_000
    const metrics = new Metrics(() => time)
    const counters = new TableCounters()
    counters.observe({ event: 'action', type: 'play', user: 'u', ms: 0 })
    counters.observe({ event: 'action', type: 'play', user: 'u', ms: 0, code: 'notYourTurn' })
    for (const ms of [1, 3, 800]) counters.think(ms)
    const stats = counters.take()
    metrics.board(stats)
    metrics.think(4)
    expect(metrics.view()).toMatchObject({ boards: 1, robot: { moves: 4, avgMs: 202, maxMs: 800 } })
    // What did not reach the club is sent again with the next board
    counters.think(2)
    counters.putBack({ ...stats, thinkMaxMs: 10 })
    expect(counters.take()).toMatchObject({ actions: 2, robotMoves: 4, thinkMaxMs: 10 })
    time += METRICS_WINDOW_MS + 10 * 60_000
    expect(metrics.view()).toMatchObject({ boards: 0, actions: 0, robot: { moves: 0, avgMs: null }, minutes: 60 })
  })

  it('warns about slow actions, slow robots and many reconnects only over enough of them', () => {
    const metrics = new Metrics(() => 0)
    for (let i = 0; i < 10; i++) metrics.observe({ event: 'action', type: 'call', user: 'u', ms: 3000 })
    expect(alertsOf(metrics.view())).toEqual([])
    for (let i = 0; i < 60; i++) metrics.observe({ event: 'action', type: 'call', user: 'u', ms: 3000 })
    for (let i = 0; i < 30; i++) {
      metrics.think(900)
      metrics.connected(`m${i}`, 1)
      metrics.disconnected(`m${i}`)
      metrics.connected(`m${i}`, 1)
    }
    expect(alertsOf(metrics.view())).toEqual(['reconnectRate', 'actionSlow', 'robotSlow'])
  })
})
