// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { notificationLink } from '../../shared/notification-link.ts'
import type { Notification, ServerMessage } from '../../shared/protocol.ts'
import { PUSH_GROUPS } from '../../shared/push.ts'
import { ALERT_CHECK_MS, ALERTS_KEY, AlertWatch, type AlertState } from '../../worker/alerts.ts'
import { METRICS_WINDOW_MS, Metrics } from '../../worker/metrics.ts'
import type { JobKind } from '../../worker/scheduler.ts'
import { manualScheduler } from '../../worker/scheduler.ts'
import { ClubService, type Connections } from '../../worker/service.ts'
import { MemoryStore } from '../../worker/store.ts'
import { memoryStore } from './sqlite.ts'

/**
 * AC-11.5's alerts reaching the admins (worker/alerts.ts, ARCHITECTURE.md §5.13): told once when an
 * alert appears, once when all are gone, never again after an eviction; looked at only after
 * activity or while an alert is on. And the robots measured by how late their moves went out
 */

interface Job {
  run: () => void
  ms: number
  kind: JobKind
}

class Sockets implements Connections {
  onlineUserIds() {
    return []
  }
  send(_userId: string, _message: ServerMessage) {}
  disconnect() {}
}

let time: number
let queue: Job[]

const settle = () => new Promise((resolve) => setImmediate(resolve))

/** Runs the waiting jobs of one kind, the clock moved to the latest of them first */
async function run(kind: JobKind) {
  const due = queue.filter((job) => job.kind === kind)
  queue = queue.filter((job) => job.kind !== kind)
  time += Math.max(0, ...due.map((job) => job.ms))
  for (const job of due) job.run()
  await settle()
  await settle()
}

const waiting = (kind: JobKind) => queue.filter((job) => job.kind === kind)

/** Half the requests answered 500: well over the 1% the error rate allows */
function failRequests(club: ClubService, n = 60) {
  for (let i = 0; i < n; i++) club.logEntry({ event: 'http', method: 'GET', path: '/api/me', status: i % 2 ? 500 : 200, ms: 1 })
}

describe('AlertWatch', () => {
  beforeEach(() => {
    time = 1_000_000
    queue = []
  })

  function watch(store = new MemoryStore()) {
    const told: [string[], boolean][] = []
    const scheduler = manualScheduler((runJob, ms, kind) => queue.push({ run: runJob, ms, kind }))
    let alerts: AlertWatch | undefined = undefined
    const metrics = new Metrics(() => time, undefined, () => alerts?.activity())
    alerts = new AlertWatch({
      store,
      scheduler,
      now: () => time,
      view: () => metrics.view(),
      tell: async (list, recovered) => void told.push([list, recovered]),
    })
    return { metrics, alerts, told, store }
  }

  it('looks only after something was counted, once per five minutes, and never when only read', async () => {
    const { metrics } = watch()
    metrics.view()
    expect(waiting('alerts')).toHaveLength(0)
    metrics.observe({ event: 'push', sent: 1 } as never)
    expect(waiting('alerts')).toHaveLength(0)
    metrics.observe({ event: 'action', type: 'call', user: 'u', ms: 1 })
    metrics.connected('u', 1)
    metrics.observe({ event: 'action', type: 'call', user: 'u', ms: 1 })
    expect(waiting('alerts')).toEqual([expect.objectContaining({ ms: ALERT_CHECK_MS })])
    // Nothing on: the look asks for no other, so a quiet club is not woken again
    await run('alerts')
    expect(waiting('alerts')).toHaveLength(0)
  })

  it('tells once while an alert lasts, again only after it cleared and came back, and when all are gone', async () => {
    const { metrics, told } = watch()
    for (let i = 0; i < 60; i++) metrics.observe({ event: 'http', method: 'GET', path: '/', status: 500, ms: 1 })
    await run('alerts')
    expect(told).toEqual([[['errorRate'], false]])
    // Still on: looked at again every five minutes, nobody told twice
    for (let i = 0; i < 3; i++) {
      expect(waiting('alerts')).toHaveLength(1)
      await run('alerts')
    }
    expect(told).toHaveLength(1)
    // The bad minutes slide out of the hour with nobody about: noticed by the looks it keeps asking for
    for (let i = 0; i < 20 && waiting('alerts').length; i++) await run('alerts')
    expect(told).toEqual([
      [['errorRate'], false],
      [[], true],
    ])
    expect(waiting('alerts')).toHaveLength(0)
    // Back again: told again
    for (let i = 0; i < 60; i++) metrics.observe({ event: 'http', method: 'GET', path: '/', status: 500, ms: 1 })
    await run('alerts')
    expect(told.at(-1)).toEqual([['errorRate'], false])
  })

  it('tells about a second alert joining one already on, but not about one of two clearing', async () => {
    const { metrics, told } = watch()
    for (let i = 0; i < 60; i++) metrics.observe({ event: 'http', method: 'GET', path: '/', status: 500, ms: 1 })
    await run('alerts')
    time += METRICS_WINDOW_MS - 4 * ALERT_CHECK_MS
    for (let i = 0; i < 30; i++) {
      metrics.connected(`m${i}`, 1)
      metrics.disconnected(`m${i}`)
      metrics.connected(`m${i}`, 1)
    }
    await run('alerts')
    expect(told).toEqual([
      [['errorRate'], false],
      [['reconnectRate'], false],
    ])
    // The errors leave the hour first: one of two cleared, nobody told
    await run('alerts')
    await run('alerts')
    expect(told).toHaveLength(2)
  })

  it('remembers what it told across an eviction, and looks again after waking while one is on', async () => {
    const store = new MemoryStore()
    const first = watch(store)
    for (let i = 0; i < 60; i++) first.metrics.observe({ event: 'http', method: 'GET', path: '/', status: 500, ms: 1 })
    await run('alerts')
    expect(await store.get<AlertState>(ALERTS_KEY)).toEqual({ active: ['errorRate'], at: time })
    // Evicted: its jobs are gone, the counts too in this test (the real club reads them back)
    queue = []
    const woken = watch(store)
    await woken.alerts.load()
    expect(waiting('alerts')).toHaveLength(1)
    for (let i = 0; i < 60; i++) woken.metrics.observe({ event: 'http', method: 'GET', path: '/', status: 500, ms: 1 })
    await run('alerts')
    expect(woken.told).toEqual([])
    // A store that never had an alert asks for nothing on waking
    queue = []
    await watch().alerts.load()
    expect(waiting('alerts')).toHaveLength(0)
  })
})

describe('the club tells its admins (AC-11.5)', () => {
  beforeEach(() => {
    time = 1_000_000
    queue = []
  })

  async function makeClub(store = memoryStore()) {
    const club = new ClubService(store, new Sockets(), {
      maxUsers: 10,
      now: () => time,
      schedule: (runJob, ms, kind) => queue.push({ run: runJob, ms, kind }),
    })
    await club.load()
    return club
  }

  const inbox = async (club: ClubService, userId: string): Promise<Notification[]> => (await club.notifications.view(userId)).items

  it('puts the alert and the recovery in the admins’ notifications, not the members’', async () => {
    const store = memoryStore()
    const club = await makeClub(store)
    const first = await club.register('gene', 'club-secret-1', '')
    if (!('user' in first)) throw new Error('the first account should sign in')
    const admin = first.user.id
    const member = (await club.adminCreateUser('amy', 'club-secret-1')).id
    time += 61_000
    failRequests(club)
    expect(club.status().alerts).toEqual(['errorRate'])
    await run('alerts')
    const told = await inbox(club, admin)
    expect(told[0]).toMatchObject({ kind: 'systemAlert', params: { alerts: 'errorRate' }, read: false })
    expect(notificationLink(told[0])).toBe('/admin#admin-status')
    expect(await inbox(club, member)).toEqual([])
    // Still on after an eviction: the new object does not tell again
    queue = []
    const woken = await makeClub(store)
    expect(woken.status().alerts).toEqual(['errorRate'])
    await run('alerts')
    expect((await inbox(woken, admin)).filter((n) => n.kind === 'systemAlert')).toHaveLength(1)
    // An hour later the errors are gone
    time += METRICS_WINDOW_MS
    await run('alerts')
    expect((await inbox(woken, admin))[0]).toMatchObject({ kind: 'systemRecovered', params: {} })
    expect(waiting('alerts')).toHaveLength(0)
  })

  it('pushes both with the admins’ other news', () => {
    expect(PUSH_GROUPS.admin).toEqual(expect.arrayContaining(['systemAlert', 'systemRecovered']))
  })

  it('measures a robot by how late its move went out, not by its thinking', async () => {
    const club = await makeClub()
    const first = await club.register('gene', 'club-secret-1', '')
    if (!('user' in first)) throw new Error('the first account should sign in')
    const gene = first.user.id
    const send = (message: unknown) => club.handleRaw(gene, JSON.stringify(message))
    await send({ type: 'createTable' })
    for (const seat of ['N', 'E', 'W'] as const) await send({ type: 'addRobot', seat })
    // Each robot move runs 1.5 s after it was due (an alarm firing late)
    let moves = 0
    for (let i = 0; i < 10 && waiting('robot').length; i++) {
      time += 1500
      await run('robot')
      moves++
    }
    const robot = club.status().metrics.robot
    expect(robot.moves).toBeGreaterThan(0)
    expect(robot.moves).toBeLessThanOrEqual(moves)
    expect(robot.lateAvgMs).toBe(1500)
    expect(robot.lateMaxMs).toBe(1500)
  })
})
