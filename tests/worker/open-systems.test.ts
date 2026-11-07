// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { OPEN_ROBOT_KINDS, type ClientMessage, type ServerMessage, type TableView } from '../../shared/protocol.ts'
import { ClubService, type Connections, type ScheduleKind } from '../../worker/service.ts'
import type { MemoryStore } from '../../worker/store.ts'
import { memoryStore } from './sqlite.ts'
import { clubService } from './event-mode.ts'
import { adminWithTwoFactor } from './admin-two-factor.ts'

/**
 * Every public bidding system, through the real service (AC-5.11): driven by `OPEN_ROBOT_KINDS`, so
 * a new system is covered the day it is added. A member without `tkuSystem` seats TKB in it and plays
 * a whole board with it, and the daily and weekly events can be set up in it. The club's system stays
 * refused.
 */

class FakeConnections implements Connections {
  online = new Set<string>()
  inbox = new Map<string, ServerMessage[]>()
  onlineUserIds() {
    return [...this.online]
  }
  send(userId: string, message: ServerMessage) {
    this.inbox.set(userId, [...(this.inbox.get(userId) ?? []), message])
  }
  disconnect(userId: string) {
    this.online.delete(userId)
  }
  table(userId: string): TableView | null {
    let view = null as TableView | null
    for (const m of this.inbox.get(userId) ?? []) {
      if (m.type !== 'table') continue
      const wire = m.table
      if (!wire) {
        view = null
        continue
      }
      const keep = view?.id === wire.id ? view : null
      view = { ...wire, chat: wire.chat ?? keep?.chat ?? [], recent: wire.recent ?? keep?.recent ?? [] }
    }
    return view
  }
}

let store: MemoryStore
let connections: FakeConnections
let club: ClubService
let queue: { run: () => void; ms: number; kind: ScheduleKind }[]
let time: number
let boss: string

const tick = () => new Promise((resolve) => setImmediate(resolve))

async function member(name: string) {
  const result = await club.register(name, 'club-secret-1', '')
  const user = 'user' in result ? result.user : await club.adminApprove(club.adminApplications().find((a) => a.username === name)!.id)
  if ('user' in result) await adminWithTwoFactor(club, user.id)
  connections.online.add(user.id)
  club.connected(user.id)
  await tick()
  return user.id
}

const send = (userId: string, message: ClientMessage) => club.handle(userId, message)
const tableFor = (userId: string) => connections.table(userId)!

async function refused(userId: string, message: ClientMessage) {
  const before = (connections.inbox.get(userId) ?? []).length
  await send(userId, message)
  const fresh = (connections.inbox.get(userId) ?? []).slice(before)
  return (fresh.findLast((m) => m.type === 'error') as Extract<ServerMessage, { type: 'error' }> | undefined)?.code
}

async function runRobots() {
  for (let i = 0; i < 400; i++) {
    const index = queue.findIndex((job) => job.kind === 'robot')
    if (index < 0) return
    queue.splice(index, 1)[0].run()
    await tick()
  }
}

async function fire(kind: ScheduleKind) {
  const due = queue.filter((job) => job.kind === kind)
  queue = queue.filter((job) => job.kind !== kind)
  for (const job of due) job.run()
  for (let i = 0; i < 10; i++) await tick()
}

beforeEach(async () => {
  store = memoryStore()
  connections = new FakeConnections()
  queue = []
  time = Date.UTC(2026, 9, 26, 0)
  club = clubService(store, connections, { maxUsers: 40, now: () => time, schedule: (run, ms, kind) => queue.push({ run, ms, kind }) })
  await club.load()
  boss = await member('boss')
})

describe.each(OPEN_ROBOT_KINDS)('TKB in %s', (kind) => {
  it('is seated by a member without `tkuSystem`, who is still refused the club’s', async () => {
    const amy = await member('amy')
    await send(amy, { type: 'createTable' })
    expect(await refused(amy, { type: 'addRobot', seat: 'N', kind })).toBeUndefined()
    expect(tableFor(amy).seats.N).toMatchObject({ id: `robot:${kind}:N`, robot: true, robotKind: kind })
    expect(await refused(amy, { type: 'addRobot', seat: 'E', kind: 'tku' })).toBe('tkuSystemOnly')
    expect(tableFor(amy).seats.E).toBeNull()
  })

  it('bids and plays a whole board, alerting with what each call shows, in its system', async () => {
    const amy = await member('amy')
    await send(amy, { type: 'createTable' })
    for (const seat of ['N', 'E', 'W'] as const) await send(amy, { type: 'addRobot', seat, kind })
    for (let i = 0; i < 600 && tableFor(amy).board?.phase !== 'finished'; i++) {
      await runRobots()
      const board = tableFor(amy).board!
      if (board.phase === 'finished') break
      if (board.legalCalls.length) await send(amy, { type: 'call', call: 'P' })
      else if (board.legalCards.length) await send(amy, { type: 'play', card: board.legalCards[0] })
    }
    const board = tableFor(amy).board!
    expect(board.phase).toBe('finished')
    const robotCalls = board.auction.filter((entry) => entry.robot)
    expect(robotCalls.length).toBeGreaterThan(0)
    for (const entry of robotCalls) {
      expect(entry.system, `${entry.seat} ${entry.call}`).toBe(kind)
      if (entry.call !== 'P') expect(entry.meaning, `${entry.seat} ${entry.call}`).toBeDefined()
    }
  })

  it('runs the daily event', async () => {
    const amy = await member('amy')
    const view = await club.adminSetDailyEvent(boss, { enabled: true, robotKind: kind })
    expect(view.settings.robotKind).toBe(kind)
    time = view.next!
    await fire('daily')
    expect(club.dailyEvent(amy).today?.settings.robotKind).toBe(kind)
  })

  it('runs the weekly challenge', async () => {
    const amy = await member('amy')
    const view = await club.adminSetWeeklyChallenge(boss, { enabled: true, robotKind: kind })
    expect(view.schedule.robotKind).toBe(kind)
    time = view.next!
    await fire('weekly')
    const made = club.challengeList(amy).filter((c) => c.settings.weekly)
    expect(made.map((c) => c.settings.robotKind)).toEqual([kind])
  })
})
