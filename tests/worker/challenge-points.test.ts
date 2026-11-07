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
import { adminWithTwoFactor } from './admin-two-factor.ts'

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
  // The founder turns two-step sign-in on so that it acts as an admin (社長 2026-11-02)
  await adminWithTwoFactor(club, boss)
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

describe('points from the daily event (AC-9.2)', () => {
  /** The day's event, Amy and Ben accepting it and each playing all its boards, Amy ahead on every one; run to its deadline */
  async function playDaily() {
    const amy = await member('amy')
    const ben = await member('ben')
    await club.adminSetDailyEvent(boss, { enabled: true })
    // 2026-11-10 08:00 in Taiwan: the next midnight is 16 hours on
    time += 16 * 3_600_000
    const due = queue.filter((job) => job.kind === 'daily')
    queue = queue.filter((job) => job.kind !== 'daily')
    for (const job of due) job.run()
    await tick(10)
    const { id, boards } = club.dailyEvent(amy).today!
    for (const userId of [amy, ben]) {
      await send(userId, { type: 'answerChallenge', challengeId: id, accept: true })
      for (let seq = 1; seq <= boards; seq++)
        writeChallenge(club, id, (s) =>
          s.addResult(id, { userId, seq, boardId: `b-${id}-${userId}-${seq}`, scoreNS: userId === amy ? 420 : 100, playedAt: time }),
        )
    }
    await toDeadline(id)
    return { id, amy, ben }
  }

  it('goes by the daily rule, not the challenge rule, and each entry traces back to the day’s event', async () => {
    const { id, amy, ben } = await playDaily()
    // The daily rule: 1 for taking part + 1 per player beaten, two needed. The same two in a
    // challenge get nothing (its rule needs three, 'a head-to-head challenge gives no points')
    expect(board()).toEqual([
      ['amy', 1, 2, 1],
      ['ben', 2, 1, 1],
    ])
    const entries = (userId: string) => club.rankings.memberLedger(boss, new URLSearchParams({ month: taiwanMonth(time), user: userId }))
    const at = club.challenges.get(id)!.deadline - 1
    expect(entries(amy)).toEqual([{ eventId: id, kind: 'daily', at, rank: 1, field: 2, base: 2, points: 2, adjustments: [] }])
    expect(entries(ben)).toEqual([{ eventId: id, kind: 'daily', at, rank: 2, field: 2, base: 1, points: 1, adjustments: [] }])
  })

  it('takes the rule an admin set for daily events, and that rule only for them', async () => {
    await club.rankings.adminSetRules(boss, { kinds: { daily: { participation: 5 } } })
    expect(club.rankings.pointsRules.kinds.challenge.participation).toBe(0)
    await playDaily()
    expect(board()).toEqual([
      ['amy', 1, 6, 1],
      ['ben', 2, 5, 1],
    ])
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

describe("the director's penalty on a challenge (e9-t17)", () => {
  it('only admins give one; it counts in the standings and the points, and its note goes with them', async () => {
    const { ids, id } = await challenge(['ben', 'cat'], { amy: [620, 420], ben: [420, 420], cat: [-100, 50] })
    const act = (userId: string, body: unknown) => club.refereeAct(userId, 'challenge', id, body)
    const refused = async (run: () => Promise<unknown>) => run().then(() => undefined, (e: { code?: string }) => e.code)
    // The creator plays in it: not theirs to direct
    expect(await refused(() => act(ids.amy, { action: 'penalty', target: ids.ben, amount: 300, reason: '慢打' }))).toBe('refereeOnly')
    expect(await refused(() => act(boss, { action: 'penalty', target: 'nobody', amount: 300, reason: '慢打' }))).toBe('refereeBadTarget')
    expect(await refused(() => act(boss, { action: 'restart', table: 1, reason: '慢打' }))).toBe('refereeNotHere')
    await act(boss, { action: 'penalty', target: ids.amy, amount: 300, reason: '場外資訊' })
    const view = club.challengeFor(id, ids.ben)!
    expect(view.standings!.ranked.map((r) => [r.userId, r.rank, r.total, r.penalty])).toEqual([
      [ids.ben, 1, 840, undefined],
      [ids.amy, 2, 740, 300],
      [ids.cat, 3, -50, undefined],
    ])
    expect(view.referee).toEqual([expect.objectContaining({ action: 'penalty', target: ids.amy, amount: 300, reason: '場外資訊' })])
    await toDeadline(id)
    expect(board()).toEqual([
      ['ben', 1, 2, 1],
      ['amy', 2, 1, 1],
      ['cat', 3, 0, 1],
    ])
  })
})

describe("re-crediting a finished challenge's points after a director's change (e9-t17 follow-up)", () => {
  it('works the points out again, writes each difference once, and takes it back with the penalty', async () => {
    const { ids, id } = await challenge(['ben', 'cat'], { amy: [620, 420], ben: [420, 420], cat: [-100, 50] })
    await toDeadline(id)
    expect(board()).toEqual([
      ['amy', 1, 2, 1],
      ['ben', 2, 1, 1],
      ['cat', 3, 0, 1],
    ])
    const act = (body: unknown) => club.refereeAct(boss, 'challenge', id, body)
    await act({ action: 'penalty', target: ids.amy, amount: 300, reason: '場外資訊' })
    expect(board()).toEqual([
      ['ben', 1, 2, 1],
      ['amy', 2, 1, 1],
      ['cat', 3, 0, 1],
    ])
    const ledger = (userId: string) => club.rankings.ledger.ledger(userId, { from: 0, to: Infinity })
    expect(ledger(ids.amy)).toEqual([
      expect.objectContaining({ eventId: id, rank: 2, base: 2, points: 1, adjustments: [{ delta: -1, reason: '場外資訊', by: boss, at: time, auto: true }] }),
    ])
    expect(ledger(ids.ben)[0]).toMatchObject({ rank: 1, base: 1, points: 2 })
    // Nothing changed since: working it out again writes nothing (idempotent), and neither does a reload
    const penalties = new Map([[ids.amy, 300]])
    expect(club.rankings.recredit(club.rankings.challengeNow(club.challenges.get(id)!, penalties), boss, '再算一次')).toEqual([])
    club = newClub()
    await club.load()
    await tick(10)
    expect(ledger(ids.amy)[0].adjustments).toHaveLength(1)

    // An admin's own correction stays on top of the re-credit
    club.rankings.adminAdjust(boss, { eventId: id, userId: ids.cat, points: 0.5, reason: '鼓勵' })
    // Taking the penalty back puts the places and the points back
    const penaltyId = club.challengeFor(id, ids.ben)!.referee![0].id
    await act({ action: 'withdraw', of: penaltyId, reason: '誤判' })
    expect(board()).toEqual([
      ['amy', 1, 2, 1],
      ['ben', 2, 1, 1],
      ['cat', 3, 0.5, 1],
    ])
    expect(ledger(ids.amy)[0].adjustments.map((a) => [a.delta, a.reason, a.auto])).toEqual([
      [-1, '場外資訊', true],
      [1, '誤判', true],
    ])
    expect(ledger(ids.cat)[0].adjustments).toEqual([expect.objectContaining({ delta: 0.5, reason: '鼓勵' })])
    const { AuditLog } = await import('../../worker/audit.ts')
    const audit = (await new AuditLog(store).list()).filter((a) => a.action === 'points:recredit')
    expect(audit).toHaveLength(2)
    expect(audit.every((a) => a.by === 'boss' && a.target === `challenge:${id}`)).toBe(true)
    expect(audit.map((a) => a.note).sort()).toEqual(['amy +1 = 2, ben -1 = 1 · 誤判', 'amy -1 = 1, ben +1 = 2 · 場外資訊'].sort())
  })

  it('leaves a challenge not credited yet to its settlement', async () => {
    const { ids, id } = await challenge(['ben', 'cat'], { amy: [620, 420], ben: [420, 420], cat: [-100, 50] })
    await club.refereeAct(boss, 'challenge', id, { action: 'penalty', target: ids.amy, amount: 300, reason: '場外資訊' })
    expect(club.rankings.ledger.recorded(id)).toBe(false)
    await toDeadline(id)
    expect(board()).toEqual([
      ['ben', 1, 2, 1],
      ['amy', 2, 1, 1],
      ['cat', 3, 0, 1],
    ])
    expect(club.rankings.ledger.ledger(ids.amy, { from: 0, to: Infinity })[0].adjustments).toEqual([])
  })
})
