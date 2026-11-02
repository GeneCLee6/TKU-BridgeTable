// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { taiwanMonth } from '../../shared/points.ts'
import type { ClientMessage, ServerMessage } from '../../shared/protocol.ts'
import { matchEvent } from '../../worker/ranking-events.ts'
import type { ClubService, Connections, ScheduleKind } from '../../worker/service.ts'
import type { MemoryStore } from '../../worker/store.ts'
import type { TeamMatch } from '../../worker/team-matches.ts'
import { memoryStore } from './sqlite.ts'
import { clubService, writeChallenge } from './event-mode.ts'

/**
 * Club points and ratings (J2: e9-t04, e9-t05, e9-t06, e9-t08) from finished challenges, on both
 * paths of `EVENT_OBJECTS` (the file matches the `challenge*` tests in vite.config.ts)
 */

class FakeConnections implements Connections {
  online = new Set<string>()
  onlineUserIds() {
    return [...this.online]
  }
  send(_userId: string, _message: ServerMessage) {}
  disconnect(userId: string) {
    this.online.delete(userId)
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

beforeEach(async () => {
  store = memoryStore()
  connections = new FakeConnections()
  queue = []
  // 2026-11-10 in Taiwan
  time = Date.UTC(2026, 10, 10)
  club = newClub()
  await club.load()
  const result = await club.register('boss', 'club-secret-1', '')
  boss = 'user' in result ? result.user.id : ''
})

async function member(name: string) {
  const result = await club.register(name, 'club-secret-1', '')
  const user =
    'user' in result ? result.user : await club.adminApprove(club.adminApplications().find((a) => a.username === name)!.id)
  connections.online.add(user.id)
  club.connected(user.id)
  await tick()
  return user.id
}

const send = (userId: string, message: ClientMessage) => club.handle(userId, message)

async function challenge(names: string[], scores: Record<string, number[]>) {
  const ids: Record<string, string> = {}
  for (const name of ['amy', ...names]) ids[name] = (await club.adminUsers()).find((u) => u.username === name)?.id ?? (await member(name))
  const amy = ids.amy
  for (const name of names) await send(amy, { type: 'setFriend', userId: ids[name], friend: true })
  const before = new Set(club.challengeList(amy).map((c) => c.id))
  await send(amy, { type: 'createChallenge', invitees: names.map((n) => ids[n]), boards: 2, settings: { scoring: 'total' } })
  const id = club.challengeList(amy).find((c) => !before.has(c.id))!.id
  for (const name of names) await send(ids[name], { type: 'answerChallenge', challengeId: id, accept: true })
  for (const [name, row] of Object.entries(scores))
    for (const [i, scoreNS] of row.entries())
      writeChallenge(club, id, (s) => s.addResult(id, { userId: ids[name], seq: i + 1, boardId: `b-${id}-${name}-${i + 1}`, scoreNS, playedAt: time }))
  return { ids, id }
}

async function toDeadline(id: string) {
  time = club.challenges.get(id)!.deadline
  const due = queue.filter((job) => job.kind === 'challenge')
  queue = queue.filter((job) => job.kind !== 'challenge')
  for (const job of due) job.run()
  await tick(10)
}

const month = () => new URLSearchParams({ month: taiwanMonth(time) })
const board = (userId = boss) => club.rankings.leaderboard(userId, month()).rows.map((r) => [r.user?.username, r.rank, r.points, r.events])

describe('points from a finished challenge (e9-t05)', () => {
  it('gives each finisher points by place, once, and traces each to its challenge', async () => {
    const { ids, id } = await challenge(['ben', 'cat'], { amy: [620, 420], ben: [420, 420], cat: [-100, 50] })
    await toDeadline(id)
    // challenge rule: 0 + 1 per player beaten, three needed
    expect(board()).toEqual([
      ['amy', 1, 2, 1],
      ['ben', 2, 1, 1],
      ['cat', 3, 0, 1],
    ])
    const entries = club.rankings.memberLedger(boss, new URLSearchParams({ month: taiwanMonth(time), user: ids.amy }))
    expect(entries).toEqual([
      { eventId: id, kind: 'challenge', at: club.challenges.get(id)!.deadline - 1, rank: 1, field: 3, base: 2, points: 2, adjustments: [] },
    ])

    // Heard of again (a reload settles everything again): nothing doubles
    club = newClub()
    await club.load()
    await tick(10)
    expect(club.rankings.ledger.recorded(id)).toBe(true)
    expect(board()).toEqual([
      ['amy', 1, 2, 1],
      ['ben', 2, 1, 1],
      ['cat', 3, 0, 1],
    ])
    club.rankings.challengeFinished(club.challenges.get(id)!)
    expect(club.rankings.ledger.ledger(ids.amy, { from: 0, to: Infinity })).toHaveLength(1)
  })

  it('a head-to-head challenge gives no points by default, but still rates', async () => {
    await club.adminSetFeature({ flag: 'rankings', state: 'on', usernames: [] })
    const { ids, id } = await challenge(['ben'], { amy: [620, 420], ben: [420, 420] })
    await toDeadline(id)
    expect(board()).toEqual([])
    const amy = club.rankings.rating(ids.amy, ids.amy)
    const ben = club.rankings.rating(ids.ben, ids.ben)
    expect(amy.rating).toBeGreaterThan(1500)
    expect(ben.rating).toBeLessThan(1500)
    expect(amy.history).toEqual([{ eventId: id, kind: 'challenge', at: expect.any(Number), rating: amy.rating, rd: amy.rd }])
    expect(amy.provisional).toBe(true)
  })

  it('an admin sets the rules; only events that end afterwards use them', async () => {
    const first = await challenge(['ben'], { amy: [620, 420], ben: [420, 420] })
    await toDeadline(first.id)
    await club.rankings.adminSetRules(boss, { kinds: { challenge: { minSides: 2, participation: 1 } } })
    expect(club.rankings.pointsRules.kinds.challenge).toMatchObject({ minSides: 2, participation: 1, perBeaten: 1 })
    time += 1
    const second = await challenge(['ben'], { amy: [620, 420], ben: [420, 420] })
    await toDeadline(second.id)
    expect(board()).toEqual([
      ['amy', 1, 2, 1],
      ['ben', 2, 1, 1],
    ])
    // Kept over a reload
    club = newClub()
    await club.load()
    expect(club.rankings.pointsRules.kinds.challenge.minSides).toBe(2)
    await expect(club.rankings.adminSetRules(first.ids.amy, {})).rejects.toMatchObject({ code: 'adminOnly' })
    await expect(club.rankings.adminSetRules(boss, { kinds: { daily: { minSides: 0 } } })).rejects.toMatchObject({
      code: 'badPointsRules',
      params: { field: 'daily' },
    })
  })

  it('an admin corrects an entry with a reason; the board counts it and the entry keeps both', async () => {
    const { ids, id } = await challenge(['ben', 'cat'], { amy: [620, 420], ben: [420, 420], cat: [-100, 50] })
    await toDeadline(id)
    expect(() => club.rankings.adminAdjust(boss, { eventId: id, userId: ids.cat, points: 5, reason: '' })).toThrow(
      expect.objectContaining({ code: 'pointsReason' }),
    )
    expect(() => club.rankings.adminAdjust(ids.amy, { eventId: id, userId: ids.cat, points: 5, reason: 'x' })).toThrow(
      expect.objectContaining({ code: 'adminOnly' }),
    )
    expect(() => club.rankings.adminAdjust(boss, { eventId: 'nope', userId: ids.cat, points: 5, reason: 'x' })).toThrow(
      expect.objectContaining({ code: 'pointsEntryMissing' }),
    )
    const entry = club.rankings.adminAdjust(boss, { eventId: id, userId: ids.cat, points: 5, reason: '裁判改判' })
    expect(entry).toMatchObject({ base: 0, points: 5, adjustments: [{ delta: 5, reason: '裁判改判', by: boss }] })
    expect(board()[0]).toEqual(['cat', 1, 5, 1])
    // Corrected again: a second line, the points as set
    expect(club.rankings.adminAdjust(boss, { eventId: id, userId: ids.cat, points: 1, reason: '再更正' })).toMatchObject({
      points: 1,
      adjustments: [{ delta: 5 }, { delta: -4 }],
    })
  })
})

describe('who sees the boards and ratings (flag, 不公開)', () => {
  it('members need the rankings flag; admins reach the page to set the rules first', async () => {
    const ben = await member('ben')
    expect(() => club.rankings.leaderboard(ben, month())).toThrow(expect.objectContaining({ code: 'rankingsOff' }))
    expect(() => club.rankings.rating(ben, ben)).toThrow(expect.objectContaining({ code: 'rankingsOff' }))
    expect(club.rankings.leaderboard(boss, month()).rows).toEqual([])
    await club.adminSetFeature({ flag: 'rankings', state: 'on', usernames: [] })
    expect(club.rankings.leaderboard(ben, month()).period).toMatchObject({ kind: 'month', key: '2026-11' })
    expect(() => club.rankings.leaderboard(ben, new URLSearchParams({ season: 'none' }))).toThrow(
      expect.objectContaining({ code: 'badPeriod' }),
    )
  })

  it('a hidden rating is the member’s own: others only learn it is hidden', async () => {
    await club.adminSetFeature({ flag: 'rankings', state: 'on', usernames: [] })
    const { ids, id } = await challenge(['ben'], { amy: [620, 420], ben: [420, 420] })
    await toDeadline(id)
    expect(club.rankings.rating(ids.ben, ids.amy).rating).toBeGreaterThan(1500)
    const mine = club.rankings.setHidden(ids.amy, true)
    expect(mine).toMatchObject({ hidden: true, events: 1 })
    expect(mine.rating).toBeGreaterThan(1500)
    expect(club.rankings.rating(ids.ben, ids.amy)).toEqual({
      userId: ids.amy,
      rating: null,
      rd: null,
      provisional: true,
      events: 0,
      hidden: true,
      history: [],
    })
    expect(club.rankings.rating(boss, ids.amy).rating).toBeNull()
    // Hidden before a first event, and still hidden after it
    const cat = await member('cat')
    expect(club.rankings.setHidden(cat, true)).toMatchObject({ rating: null, hidden: true })
  })

  it('a deleted account takes its points and rating with it, and they are in the account export', async () => {
    const { ids, id } = await challenge(['ben', 'cat'], { amy: [620, 420], ben: [420, 420], cat: [-100, 50] })
    await toDeadline(id)
    const exported = await club.exportAccount(ids.ben, null)
    expect(exported.points).toHaveLength(1)
    expect(exported.rating.events).toBe(1)
    await club.deleteOwnAccount(ids.ben, 'club-secret-1')
    expect(board().map((r) => r[0])).toEqual(['amy', 'cat'])
    expect(club.rankings.ledger.rating(ids.ben).events).toBe(0)
  })
})

describe('team matches (matchEvent)', () => {
  const seat = (room: 'open' | 'closed', s: 'N' | 'E' | 'S' | 'W', userId?: string) =>
    ({ room, seat: s, status: 'seated', robot: !userId, ...(userId && { userId }) }) as TeamMatch['seats'][number]

  it('places the two teams by the score, members only; robots count for the ratings', () => {
    const match = {
      id: 'm1',
      status: 'finished',
      endedAt: 5,
      settings: { scoring: 'imp', boards: 1 },
      // Team A: N-S open, E-W closed
      seats: [seat('open', 'N', 'a1'), seat('open', 'E', 'b1'), seat('open', 'S', 'a2'), seat('open', 'W'), seat('closed', 'N', 'b2'), seat('closed', 'E', 'a3'), seat('closed', 'S'), seat('closed', 'W')],
      boards: [{ seq: 1, open: { boardId: 'x', scoreNS: 620, playedAt: 1 }, closed: { boardId: 'y', scoreNS: 170, playedAt: 1 } }],
    } as unknown as TeamMatch
    const event = matchEvent(match, () => undefined, 9)!
    expect(event).toEqual({
      id: 'm1',
      kind: 'match',
      at: 5,
      sides: [
        { userIds: ['a1', 'a2', 'a3'], robots: 1, rank: 1 },
        { userIds: ['b1', 'b2'], robots: 2, rank: 2 },
      ],
    })
    expect(matchEvent({ ...match, status: 'abandoned' } as TeamMatch, () => undefined, 9)).toBeNull()
  })
})
