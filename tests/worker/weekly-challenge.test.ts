// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import type { ServerMessage } from '../../shared/protocol.ts'
import {
  DEFAULT_WEEKLY_SCHEDULE,
  latestWeeklySlot,
  parseWeeklySchedule,
  weeklySlotAfter,
} from '../../shared/weekly-challenge.ts'
import { ClubService, type Connections, type ScheduleKind } from '../../worker/service.ts'
import type { MemoryStore } from '../../worker/store.ts'
import { memoryStore } from './sqlite.ts'
import { clubService } from './event-mode.ts'

/** The weekly club challenge (C9, e7-t23) */

const HOUR = 3_600_000
const DAY = 24 * HOUR
const WEEK = 7 * DAY
/** Monday 2026-10-26 08:00 in Taiwan (00:00 UTC) */
const MONDAY_8AM = Date.UTC(2026, 9, 26)

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

const weeklyJobs = () => queue.filter((job) => job.kind === 'weekly')

/** Runs the weekly jobs waiting now (not the ones they put back) and lets them finish */
async function fireWeekly() {
  const jobs = weeklyJobs()
  queue = queue.filter((job) => job.kind !== 'weekly')
  for (const job of jobs) job.run()
  await tick(10)
}

const weeklyChallenges = (userId: string) => club.challengeList(userId).filter((c) => c.settings.weekly)

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

describe('the schedule (shared/weekly-challenge.ts)', () => {
  const monday8pm = { ...DEFAULT_WEEKLY_SCHEDULE, weekday: 1, hour: 20 }

  it('counts weekdays and hours in Taiwan time', () => {
    // Monday 08:00 in Taiwan: the last Monday 20:00 was a week ago less 12 hours
    expect(weeklySlotAfter(monday8pm, MONDAY_8AM)).toBe(MONDAY_8AM + 12 * HOUR)
    expect(latestWeeklySlot(monday8pm, MONDAY_8AM)).toBe(MONDAY_8AM + 12 * HOUR - WEEK)
    // Exactly at the time: that is the latest, the next is a week on
    expect(latestWeeklySlot(monday8pm, MONDAY_8AM + 12 * HOUR)).toBe(MONDAY_8AM + 12 * HOUR)
    expect(weeklySlotAfter(monday8pm, MONDAY_8AM + 12 * HOUR)).toBe(MONDAY_8AM + 12 * HOUR + WEEK)
    // Sunday 00:00 in Taiwan is Saturday 16:00 UTC
    const sunday = { ...monday8pm, weekday: 0, hour: 0 }
    expect(new Date(weeklySlotAfter(sunday, MONDAY_8AM)).toISOString()).toBe('2026-10-31T16:00:00.000Z')
  })

  it('checks what an admin sends, keeping what was not sent', () => {
    expect(parseWeeklySchedule({ weekday: 3 })).toEqual({ schedule: { ...DEFAULT_WEEKLY_SCHEDULE, weekday: 3 } })
    expect(parseWeeklySchedule({ hour: 24 })).toEqual({ field: 'hour' })
    expect(parseWeeklySchedule({ weekday: 7 })).toEqual({ field: 'weekday' })
    expect(parseWeeklySchedule({ boards: 0 })).toEqual({ field: 'boards' })
    expect(parseWeeklySchedule({ boards: 17 })).toEqual({ field: 'boards' })
    expect(parseWeeklySchedule({ scoring: 'imp' })).toEqual({ field: 'scoring' })
    expect(parseWeeklySchedule({ robotKind: 'bbo' })).toEqual({ field: 'robotKind' })
    expect(parseWeeklySchedule({ days: 8 })).toEqual({ field: 'days' })
    expect(parseWeeklySchedule({ enabled: 'yes' })).toEqual({ field: 'enabled' })
    expect(parseWeeklySchedule({ ranking: 'club' })).toEqual({ field: 'ranking' })
    expect(parseWeeklySchedule([])).toEqual({ field: 'schedule' })
  })
})

describe('the weekly club challenge (e7-t23)', () => {
  it('is off until an admin turns it on', async () => {
    expect(club.weeklyChallenge()).toEqual({ schedule: DEFAULT_WEEKLY_SCHEDULE, next: null })
    expect(weeklyJobs()).toHaveLength(0)
    await expect(club.adminSetWeeklyChallenge(boss, { hour: 25 })).rejects.toMatchObject({
      code: 'badChallengeSettings',
      params: { field: 'hour' },
    })
  })

  it('creates the challenge at the set time, invites every member and waits for the next week', async () => {
    const amy = await member('amy')
    const ben = await member('ben')
    const view = await club.adminSetWeeklyChallenge(boss, { enabled: true, weekday: 1, hour: 20, boards: 4 })
    expect(view.next).toBe(MONDAY_8AM + 12 * HOUR)
    expect(weeklyJobs().map((j) => j.ms)).toEqual([12 * HOUR])

    // Run early, it only puts itself back
    await fireWeekly()
    expect(weeklyChallenges(amy)).toHaveLength(0)
    expect(weeklyJobs().map((j) => j.ms)).toEqual([12 * HOUR])

    time = MONDAY_8AM + 12 * HOUR
    await fireWeekly()
    const [c] = weeklyChallenges(amy)
    expect(c).toBeDefined()
    // Not friends of anyone, and still invited: the club invites
    expect(c.creatorId).toBe(boss)
    expect(c.players.map((p) => [p.userId, p.status])).toEqual([
      [boss, 'accepted'],
      [amy, 'invited'],
      [ben, 'invited'],
    ])
    expect(c.boards).toBe(4)
    expect(c.settings).toEqual({
      scoring: 'mp',
      robotKind: 'gib',
      bestHand: false,
      justDeclare: false,
      days: 7,
      ranking: 'club',
      weekly: true,
    })
    expect(c.deadline).toBe(time + 7 * DAY)
    for (const id of [boss, amy, ben])
      expect(connections.bell(id).find((n) => n.kind === 'challengeWeekly')?.params).toEqual({ challengeId: c.id })
    expect(club.weeklyChallenge()).toMatchObject({ lastRunAt: time, lastChallengeId: c.id, next: time + WEEK })
    expect(weeklyJobs().map((j) => j.ms)).toEqual([WEEK])

    // Answers do not pile up in the admin's bell
    await club.handle(amy, { type: 'answerChallenge', challengeId: c.id, accept: true })
    expect(connections.bell(boss).map((n) => n.kind)).not.toContain('challengeAccepted')
  })

  it('has no rematch', async () => {
    const amy = await member('amy')
    await club.adminSetWeeklyChallenge(boss, { enabled: true, hour: 20 })
    time = MONDAY_8AM + 12 * HOUR
    await fireWeekly()
    const [c] = weeklyChallenges(amy)
    await club.handle(boss, { type: 'cancelChallenge', challengeId: c.id })
    await expect(club.challengeRequest(boss, { type: 'rematchChallenge', challengeId: c.id })).rejects.toMatchObject({
      code: 'weeklyNoRematch',
    })
  })

  it('creates one challenge, not one a week, after sleeping through several weeks', async () => {
    const amy = await member('amy')
    await club.adminSetWeeklyChallenge(boss, { enabled: true, hour: 20 })
    queue = []
    time = MONDAY_8AM + 12 * HOUR + 3 * WEEK + DAY
    club = newClub()
    await club.load()
    expect(weeklyJobs().map((j) => j.ms)).toEqual([0])
    await fireWeekly()
    expect(weeklyChallenges(amy)).toHaveLength(1)
    // The week counts from the time the schedule names, not from when the job ran
    expect(club.weeklyChallenge().lastRunAt).toBe(MONDAY_8AM + 12 * HOUR + 3 * WEEK)
    expect(weeklyJobs().map((j) => j.ms)).toEqual([WEEK - DAY])
  })

  it('a changed schedule drops the old job; turning it off stops it', async () => {
    const amy = await member('amy')
    await club.adminSetWeeklyChallenge(boss, { enabled: true, hour: 20 })
    time += HOUR
    const view = await club.adminSetWeeklyChallenge(boss, { hour: 22 })
    expect(view.next).toBe(MONDAY_8AM + 14 * HOUR)
    expect(weeklyJobs().map((j) => j.ms)).toEqual([12 * HOUR, 13 * HOUR])

    // The old job, at 20:00, finds the schedule changed and does nothing
    time = MONDAY_8AM + 12 * HOUR
    const [old] = weeklyJobs()
    queue = queue.filter((j) => j !== old)
    old.run()
    await tick(10)
    expect(weeklyChallenges(amy)).toHaveLength(0)

    await club.adminSetWeeklyChallenge(boss, { enabled: false })
    expect(club.weeklyChallenge().next).toBeNull()
    time = MONDAY_8AM + 14 * HOUR
    await fireWeekly()
    expect(weeklyChallenges(amy)).toHaveLength(0)
  })

  it('creates nothing for a club with nobody to invite', async () => {
    await club.adminSetWeeklyChallenge(boss, { enabled: true, hour: 20 })
    time = MONDAY_8AM + 12 * HOUR
    await fireWeekly()
    expect(club.challengeList(boss)).toHaveLength(0)
    expect(weeklyJobs().map((j) => j.ms)).toEqual([WEEK])
  })

  it('is created by the oldest admin when the one who set it is no longer an admin', async () => {
    const amy = await member('amy')
    await club.adminSetAdmin(boss, amy, true)
    await club.adminSetWeeklyChallenge(amy, { enabled: true, hour: 20 })
    await club.adminSetAdmin(boss, amy, false)
    time = MONDAY_8AM + 12 * HOUR
    await fireWeekly()
    expect(weeklyChallenges(amy)[0].creatorId).toBe(boss)
  })
})
