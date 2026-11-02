// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import {
  dailySlotAfter,
  DEFAULT_DAILY_SETTINGS,
  latestDailySlot,
  parseDailySettings,
  taiwanDay,
} from '../../shared/daily-event.ts'
import type { ServerMessage } from '../../shared/protocol.ts'
import type { ClubService, Connections, ScheduleKind } from '../../worker/service.ts'
import type { MemoryStore } from '../../worker/store.ts'
import { memoryStore } from './sqlite.ts'
import { clubService } from './event-mode.ts'

/** The daily club event (J1, e9-t02, e9-t03), on both paths of `EVENT_OBJECTS` (vite.config.ts) */

const HOUR = 3_600_000
const DAY = 24 * HOUR
/** Monday 2026-10-26 08:00 in Taiwan (00:00 UTC) */
const MONDAY_8AM = Date.UTC(2026, 9, 26)
/** Tuesday 2026-10-27 00:00 in Taiwan */
const TUESDAY = MONDAY_8AM + 16 * HOUR

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
  bell(userId: string) {
    const last = (this.inbox.get(userId) ?? []).findLast((m) => m.type === 'notifications')
    return last?.type === 'notifications' ? last.notifications.items : []
  }
}

let store: MemoryStore
let connections: FakeConnections
let club: ClubService
let queue: { run: () => void; ms: number; kind: ScheduleKind }[]
let time: number
let boss: string

const newClub = () =>
  clubService(store, connections, {
    maxUsers: 40,
    now: () => time,
    schedule: (run, ms, kind) => queue.push({ run, ms, kind }),
  })

const tick = async (times = 1) => {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setImmediate(resolve))
}

async function member(name: string) {
  await club.register(name, 'secret1', '')
  const user = await club.adminApprove(club.adminApplications().find((a) => a.username === name)!.id)
  connections.online.add(user.id)
  club.connected(user.id)
  await tick()
  return user.id
}

const jobs = (kind: ScheduleKind) => queue.filter((job) => job.kind === kind)

/** Runs the jobs of one kind waiting now (not the ones they put back) and lets them finish */
async function fire(kind: ScheduleKind) {
  const due = jobs(kind)
  queue = queue.filter((job) => job.kind !== kind)
  for (const job of due) job.run()
  await tick(10)
}

beforeEach(async () => {
  store = memoryStore()
  connections = new FakeConnections()
  queue = []
  time = MONDAY_8AM
  club = newClub()
  await club.load()
  const founder = await club.register('boss', 'secret1', '')
  if (!('user' in founder)) throw new Error('the first account signs in at once')
  boss = founder.user.id
  connections.online.add(boss)
  club.connected(boss)
})

describe('the schedule (shared/daily-event.ts)', () => {
  it('counts days from midnight in Taiwan time', () => {
    expect(dailySlotAfter(MONDAY_8AM)).toBe(TUESDAY)
    expect(latestDailySlot(MONDAY_8AM)).toBe(TUESDAY - DAY)
    // Exactly at midnight: that is the latest, the next is a day on
    expect(latestDailySlot(TUESDAY)).toBe(TUESDAY)
    expect(dailySlotAfter(TUESDAY)).toBe(TUESDAY + DAY)
    expect(new Date(TUESDAY).toISOString()).toBe('2026-10-26T16:00:00.000Z')
    expect(taiwanDay(MONDAY_8AM)).toBe('2026-10-26')
    expect(taiwanDay(TUESDAY - 1)).toBe('2026-10-26')
    expect(taiwanDay(TUESDAY)).toBe('2026-10-27')
  })

  it('checks what an admin sends, keeping what was not sent', () => {
    expect(parseDailySettings({ enabled: true })).toEqual({ settings: { ...DEFAULT_DAILY_SETTINGS, enabled: true } })
    expect(parseDailySettings({ robotKind: 'tku' }, { enabled: true, robotKind: 'gib' })).toEqual({
      settings: { enabled: true, robotKind: 'tku' },
    })
    expect(parseDailySettings({ enabled: 'yes' })).toEqual({ field: 'enabled' })
    expect(parseDailySettings({ robotKind: 'bbo' })).toEqual({ field: 'robotKind' })
    expect(parseDailySettings({ boards: 4 })).toEqual({ field: 'boards' })
    expect(parseDailySettings([])).toEqual({ field: 'settings' })
  })
})

describe('the daily club event (e9-t02)', () => {
  it('is off until an admin turns it on', async () => {
    expect(club.dailyEvent(boss)).toEqual({
      settings: DEFAULT_DAILY_SETTINGS,
      next: null,
      today: null,
      yesterday: null,
      history: [],
    })
    expect(jobs('daily')).toHaveLength(0)
    await expect(club.adminSetDailyEvent(boss, { robotKind: 'bbo' })).rejects.toMatchObject({
      code: 'badChallengeSettings',
      params: { field: 'robotKind' },
    })
  })

  it('creates 8 boards of matchpoints for every member at midnight, until the next midnight', async () => {
    const amy = await member('amy')
    const ben = await member('ben')
    const view = await club.adminSetDailyEvent(boss, { enabled: true })
    expect(view.next).toBe(TUESDAY)
    expect(jobs('daily').map((j) => j.ms)).toEqual([16 * HOUR])

    // Run early, it only puts itself back
    await fire('daily')
    expect(club.dailyEvent(amy).today).toBeNull()
    expect(jobs('daily').map((j) => j.ms)).toEqual([16 * HOUR])

    // The job runs a little late: the event still counts from midnight
    time = TUESDAY + 5_000
    await fire('daily')
    const daily = club.dailyEvent(amy)
    const c = daily.today!
    expect(c).not.toBeNull()
    expect(c.creatorId).toBe(boss)
    expect(c.players.map((p) => [p.userId, p.status])).toEqual([
      [boss, 'accepted'],
      [amy, 'invited'],
      [ben, 'invited'],
    ])
    expect(c.boards).toBe(8)
    expect(c.settings).toEqual({
      scoring: 'mp',
      robotKind: 'gib',
      bestHand: false,
      justDeclare: false,
      days: 1,
      ranking: 'club',
      daily: true,
    })
    expect(c.createdAt).toBe(TUESDAY)
    expect(c.deadline).toBe(TUESDAY + DAY)
    expect(daily.next).toBe(TUESDAY + DAY)
    expect(jobs('daily').map((j) => j.ms)).toEqual([DAY - 5_000])
    // Not in the challenge lobby, and nobody's bell rings: the daily page shows it
    expect(club.challengeList(amy)).toHaveLength(0)
    for (const id of [boss, amy, ben])
      expect(connections.bell(id).filter((n) => n.kind.startsWith('challenge'))).toEqual([])

    // Answers do not pile up in the admin's bell
    await club.handle(amy, { type: 'answerChallenge', challengeId: c.id, accept: true })
    expect(connections.bell(boss).map((n) => n.kind)).not.toContain('challengeAccepted')

    // Twelve hours before the end nobody is reminded
    time = TUESDAY + 12 * HOUR
    await fire('challenge')
    expect(connections.bell(ben).map((n) => n.kind)).not.toContain('challengeReminder')
  })

  it('keeps yesterday and the earlier days', async () => {
    const amy = await member('amy')
    await member('ben')
    await club.adminSetDailyEvent(boss, { enabled: true, robotKind: 'tku' })
    time = TUESDAY
    await fire('daily')
    const first = club.dailyEvent(amy).today!
    expect(first.settings.robotKind).toBe('tku')

    // The next midnight: the first one ends and the second one starts
    time = TUESDAY + DAY
    await fire('challenge')
    await fire('daily')
    const daily = club.dailyEvent(amy)
    expect(daily.today?.id).not.toBe(first.id)
    expect(daily.yesterday?.id).toBe(first.id)
    expect(daily.yesterday?.status).toBe('expired')
    expect(daily.history).toEqual([{ day: '2026-10-27', challengeId: first.id, status: 'expired', finished: 0 }])
  })

  it('has no rematch', async () => {
    const amy = await member('amy')
    await club.adminSetDailyEvent(boss, { enabled: true })
    time = TUESDAY
    await fire('daily')
    const c = club.dailyEvent(amy).today!
    await club.handle(boss, { type: 'cancelChallenge', challengeId: c.id })
    await expect(club.challengeRequest(boss, { type: 'rematchChallenge', challengeId: c.id })).rejects.toMatchObject({
      code: 'dailyNoRematch',
    })
  })

  it('creates one event, today’s, after sleeping through several days', async () => {
    const amy = await member('amy')
    await club.adminSetDailyEvent(boss, { enabled: true })
    queue = []
    time = TUESDAY + 3 * DAY + 10 * HOUR
    club = newClub()
    await club.load()
    expect(jobs('daily').map((j) => j.ms)).toEqual([0])
    await fire('daily')
    const daily = club.dailyEvent(amy)
    expect(daily.today?.createdAt).toBe(TUESDAY + 3 * DAY)
    expect(daily.history).toEqual([])
    expect(jobs('daily').map((j) => j.ms)).toEqual([14 * HOUR])
  })

  it('a member who joined after midnight is not in today’s event', async () => {
    await member('amy')
    await club.adminSetDailyEvent(boss, { enabled: true })
    time = TUESDAY
    await fire('daily')
    const cid = await member('cid')
    expect(club.dailyEvent(cid).today).toBeNull()
  })

  it('turning it off stops it; nothing for a club with nobody to invite', async () => {
    await club.adminSetDailyEvent(boss, { enabled: true })
    time = TUESDAY
    await fire('daily')
    expect(club.dailyEvent(boss).today).toBeNull()
    expect(jobs('daily').map((j) => j.ms)).toEqual([DAY])

    const amy = await member('amy')
    expect((await club.adminSetDailyEvent(boss, { enabled: false })).next).toBeNull()
    time = TUESDAY + DAY
    await fire('daily')
    expect(club.dailyEvent(amy).today).toBeNull()
  })
})
