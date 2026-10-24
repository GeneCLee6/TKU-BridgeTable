// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import type { ChallengeView } from '../../shared/challenge.ts'
import { DEFAULT_HISTORY_QUERY } from '../../shared/history-query.ts'
import type { ClientMessage, ServerMessage, TableView } from '../../shared/protocol.ts'
import { REMINDER_MS } from '../../worker/challenge-flow.ts'
import { ClubService, type Connections, type ScheduleKind } from '../../worker/service.ts'
import type { MemoryStore } from '../../worker/store.ts'
import { memoryStore } from './sqlite.ts'

/** Deadlines, settlement and who sees which results (C5: e7-t13, e7-t14, e7-t20) */

const DAY = 86_400_000

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
  last<T extends ServerMessage['type']>(userId: string, type: T) {
    return (this.inbox.get(userId) ?? []).findLast((m) => m.type === type) as
      | Extract<ServerMessage, { type: T }>
      | undefined
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

const newClub = () =>
  new ClubService(store, connections, {
    maxUsers: 40,
    now: () => time,
    schedule: (run, ms, kind) => queue.push({ run, ms, kind }),
  })

beforeEach(async () => {
  store = memoryStore()
  connections = new FakeConnections()
  queue = []
  time = 1_000_000
  club = newClub()
  await club.load()
  await club.register('boss', 'secret1', '')
})

const tick = async (times = 1) => {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

async function runRobots(limit = 400) {
  for (let i = 0; i < limit; i++) {
    const index = queue.findIndex((job) => job.kind === 'robot')
    if (index < 0) return
    queue.splice(index, 1)[0].run()
    await tick()
  }
}

async function dealNext() {
  const deals = queue.filter((job) => job.kind === 'deal')
  queue = queue.filter((job) => job.kind !== 'deal')
  time += Math.max(0, ...deals.map((job) => job.ms))
  for (const job of deals) job.run()
  await tick()
}

/** The challenge jobs waiting now */
const challengeJobs = () => queue.filter((job) => job.kind === 'challenge')

/** Runs the challenge jobs waiting now (not the ones they put back) and lets them finish */
async function fireChallengeJobs() {
  const jobs = challengeJobs()
  queue = queue.filter((job) => job.kind !== 'challenge')
  for (const job of jobs) job.run()
  await tick(10)
}

async function member(name: string) {
  const result = await club.register(name, 'secret1', '')
  const user =
    'user' in result ? result.user : await club.adminApprove(club.adminApplications().find((a) => a.username === name)!.id)
  connections.online.add(user.id)
  club.connected(user.id)
  await tick()
  return user.id
}

const send = (userId: string, message: ClientMessage) => club.handle(userId, message)
const tableOf = (userId: string) => connections.table(userId)
const bell = (userId: string) => connections.last(userId, 'notifications')?.notifications.items.map((n) => n.kind) ?? []
const challengeOf = (id: string) => club.challenges.get(id)!
const seen = (id: string, userId: string) => club.challengeFor(id, userId)
/** The tables kept in the store */
const tables = () => [...store.data.keys()].filter((k) => k.startsWith('table:'))

/**
 * amy challenges the others; `accept` says who accepts (the rest are left unanswered unless in
 * `decline`)
 */
async function setup(
  names: string[],
  { boards = 4, settings = {}, accept = names, decline = [] as string[] }: {
    boards?: number
    settings?: Record<string, unknown>
    accept?: string[]
    decline?: string[]
  } = {},
) {
  const amy = await member('amy')
  const ids: Record<string, string> = { amy }
  for (const name of names) ids[name] = await member(name)
  for (const name of names) await send(amy, { type: 'setFriend', userId: ids[name], friend: true })
  await send(amy, { type: 'createChallenge', invitees: names.map((n) => ids[n]), boards, settings })
  const id = club.challengeList(amy)[0].id
  for (const name of accept) await send(ids[name], { type: 'answerChallenge', challengeId: id, accept: true })
  for (const name of decline) await send(ids[name], { type: 'answerChallenge', challengeId: id, accept: false })
  return { ...ids, id } as Record<string, string>
}

/** Writes results straight into the store, as if the boards had been played */
function results(id: string, userId: string, scores: number[]) {
  for (const [i, scoreNS] of scores.entries())
    club.challenges.addResult(id, { userId, seq: i + 1, boardId: `b-${userId}-${i + 1}`, scoreNS, playedAt: time })
}

async function toDeadline(id: string) {
  time = challengeOf(id).deadline
  await fireChallengeJobs()
}

async function playBoard(userId: string) {
  for (let i = 0; i < 400; i++) {
    await runRobots()
    const board = tableOf(userId)?.board
    if (!board) throw new Error('no board')
    if (board.phase === 'finished') return
    if (board.legalCalls.length) await send(userId, { type: 'call', call: 'P' })
    else if (board.legalCards.length) await send(userId, { type: 'play', card: board.legalCards[0] })
    else throw new Error(`stuck: ${board.phase}, turn ${board.turn}`)
  }
}

async function playAll(userId: string, challengeId: string) {
  await send(userId, { type: 'playChallenge', challengeId })
  for (;;) {
    await playBoard(userId)
    const c = tableOf(userId)!.challenge!
    if (c.played >= c.boards) return
    await dealNext()
  }
}

const ranked = (view: ChallengeView | null) => view?.standings?.ranked.map((s) => [s.userId, s.rank, s.total])

describe('the challenge job (e7-t13)', () => {
  it('waits for the reminder 12 hours before the deadline, then for the deadline', async () => {
    const { id } = await setup(['ben'])
    const deadline = challengeOf(id).deadline
    expect(deadline).toBe(time + 3 * DAY)
    expect(challengeJobs().map((j) => j.ms)).toEqual([3 * DAY - REMINDER_MS])

    // Run early, it only puts itself back
    await fireChallengeJobs()
    expect(challengeOf(id).remindedAt).toBeUndefined()
    expect(challengeJobs().map((j) => j.ms)).toEqual([3 * DAY - REMINDER_MS])

    time = deadline - REMINDER_MS
    await fireChallengeJobs()
    expect(challengeOf(id).remindedAt).toBe(time)
    expect(challengeJobs().map((j) => j.ms)).toEqual([REMINDER_MS])
  })

  it('reminds those who accepted and have boards left, once', async () => {
    const { id, amy, ben, cat, dan } = await setup(['ben', 'cat', 'dan'], { accept: ['ben', 'cat'] })
    results(id, cat, [1, 2, 3, 4])
    time = challengeOf(id).deadline - REMINDER_MS + 1
    await fireChallengeJobs()
    expect(bell(amy)).toContain('challengeReminder')
    expect(bell(ben)).toContain('challengeReminder')
    // cat is done and dan never answered
    expect(bell(cat)).not.toContain('challengeReminder')
    expect(bell(dan)).not.toContain('challengeReminder')
    const sent = connections.last(ben, 'notifications')!.notifications.items.find((n) => n.kind === 'challengeReminder')
    expect(sent!.params).toEqual({ challengeId: id })

    // Run again (an early wake-up), nothing is sent twice
    await fireChallengeJobs()
    expect(bell(ben).filter((k) => k === 'challengeReminder')).toHaveLength(1)
  })

  it('is scheduled again after the object is evicted, and the reminder is not sent again', async () => {
    const { id, ben } = await setup(['ben'])
    time = challengeOf(id).deadline - REMINDER_MS
    await fireChallengeJobs()
    queue = []
    time += 1000
    club = newClub()
    await club.load()
    expect(challengeJobs().map((j) => j.ms)).toEqual([REMINDER_MS - 1000])
    await fireChallengeJobs()
    expect(bell(ben).filter((k) => k === 'challengeReminder')).toHaveLength(1)
  })

  it('sends a reminder that came due while the object slept', async () => {
    const { id, ben } = await setup(['ben'])
    queue = []
    time = challengeOf(id).deadline - 60_000
    club = newClub()
    await club.load()
    expect(challengeJobs().map((j) => j.ms)).toEqual([0])
    await fireChallengeJobs()
    expect(bell(ben)).toContain('challengeReminder')
    expect(challengeJobs().map((j) => j.ms)).toEqual([60_000])
  })

  it('settles a reloaded challenge whose deadline passed while the object slept, without a late reminder', async () => {
    const { id, ben } = await setup(['ben'])
    queue = []
    time += 4 * DAY
    club = newClub()
    await club.load()
    expect(challengeJobs().map((j) => j.ms)).toEqual([0])
    await fireChallengeJobs()
    expect(challengeOf(id).status).toBe('finished')
    expect(bell(ben)).not.toContain('challengeReminder')
    expect(bell(ben)).toContain('challengeResults')
    expect(challengeJobs()).toHaveLength(0)
  })

  it('schedules nothing for a challenge that ended', async () => {
    const { id, amy } = await setup(['ben'], { accept: [] })
    await send(amy, { type: 'cancelChallenge', challengeId: id })
    queue = []
    club = newClub()
    await club.load()
    expect(challengeJobs()).toHaveLength(0)
  })
})

describe('the deadline (e7-t13)', () => {
  it('counts the unanswered as declined and expires a challenge nobody but the creator accepted', async () => {
    const { id, amy, ben } = await setup(['ben', 'cat'], { accept: [], decline: ['cat'] })
    await toDeadline(id)
    const c = challengeOf(id)
    expect(c.status).toBe('expired')
    expect(c.endedAt).toBe(time)
    expect(c.players.find((p) => p.userId === ben)).toMatchObject({ status: 'declined', answeredAt: time })
    expect(bell(amy)).not.toContain('challengeResults')
  })

  it('finishes one someone accepted, and tells everyone who accepted', async () => {
    const { id, amy, ben, cat } = await setup(['ben', 'cat'], { accept: ['ben'] })
    await toDeadline(id)
    const c = challengeOf(id)
    expect(c.status).toBe('finished')
    expect(c.endedAt).toBe(time)
    expect(c.players.find((p) => p.userId === cat)!.status).toBe('declined')
    expect(bell(amy)).toContain('challengeResults')
    expect(bell(ben)).toContain('challengeResults')
    expect(bell(cat)).not.toContain('challengeResults')
    // Nothing more happens to it
    await fireChallengeJobs()
    expect(challengeJobs()).toHaveLength(0)
  })

  it('closes every table of it: a board being played is dropped, a parked table goes too', async () => {
    const { id, amy, ben } = await setup(['ben'])
    await send(ben, { type: 'playChallenge', challengeId: id })
    await runRobots()
    expect(tableOf(ben)!.board!.phase).toBe('auction')
    await send(amy, { type: 'playChallenge', challengeId: id })
    await runRobots()
    await send(amy, { type: 'leaveTable' })
    expect(tables()).toHaveLength(2)

    await toDeadline(id)
    expect(tables()).toHaveLength(0)
    expect(tableOf(ben)).toBeNull()
    expect(challengeOf(id).results).toHaveLength(0)
  })
})

describe('the standings (社長, 2026-10-24)', () => {
  it('ranks only those who played every board; the others are listed as unfinished', async () => {
    const { id, amy, ben, cat, dan } = await setup(['ben', 'cat', 'dan'], { settings: { scoring: 'mp' } })
    results(id, amy, [420, 100, -50, 600])
    results(id, ben, [420, 50, -100, 600])
    results(id, cat, [170, 100, -50, 650])
    // dan would change everyone's matchpoints on the first two boards; he is not counted
    results(id, dan, [1000, 1000])
    await toDeadline(id)
    const view = seen(id, amy)!
    expect(view.standings).toMatchObject({ final: true, scoring: 'mp', unfinished: [{ userId: dan, played: 2 }] })
    // By hand: amy 75, 75, 75, 25; ben 75, 0, 0, 25; cat 0, 75, 75, 100
    expect(ranked(view)).toEqual([
      [amy, 1, 62.5],
      [cat, 1, 62.5],
      [ben, 3, 25],
    ])
    expect(view.standings!.ranked[0].boards).toEqual([75, 75, 75, 25])
  })

  it('gives a lone finisher the only place, with their total score', async () => {
    const { id, amy, ben } = await setup(['ben'], { settings: { scoring: 'imp' } })
    results(id, ben, [420, -100, 0, 50])
    results(id, amy, [100])
    await toDeadline(id)
    expect(seen(id, amy)!.standings).toMatchObject({
      scoring: 'total',
      ranked: [{ userId: ben, rank: 1, total: 370, boards: [420, -100, 0, 50] }],
      unfinished: [{ userId: amy, played: 1 }],
    })
  })

  it('ranks nobody when nobody finished', async () => {
    const { id, amy, ben } = await setup(['ben'])
    results(id, ben, [1, 2])
    await toDeadline(id)
    expect(challengeOf(id).status).toBe('finished')
    expect(seen(id, amy)!.standings).toMatchObject({
      ranked: [],
      unfinished: [
        { userId: amy, played: 0 },
        { userId: ben, played: 2 },
      ],
    })
  })

  it('compares two finishers head to head by IMPs', async () => {
    const { id, amy, ben } = await setup(['ben'], { settings: { scoring: 'imp' } })
    results(id, amy, [420, 0, 0, 0])
    results(id, ben, [-100, 0, 0, 0])
    await toDeadline(id)
    expect(ranked(seen(id, ben))).toEqual([
      [amy, 1, 11],
      [ben, 2, -11],
    ])
  })
})

describe('finishing early (e7-t13)', () => {
  it('finishes once everyone answered and everyone who accepted played every board', async () => {
    const { id, amy, ben, cat } = await setup(['ben', 'cat'], { accept: ['ben'] })
    await playAll(amy, id)
    await send(amy, { type: 'leaveTable' })
    await playAll(ben, id)
    // cat has not answered yet
    expect(challengeOf(id).status).toBe('active')
    await send(cat, { type: 'answerChallenge', challengeId: id, accept: false })
    const c = challengeOf(id)
    expect(c.status).toBe('finished')
    expect(c.endedAt).toBe(time)
    expect(bell(amy)).toContain('challengeResults')
    expect(bell(ben)).toContain('challengeResults')
    expect(seen(id, amy)!.standings!.ranked.map((s) => s.userId).sort()).toEqual([amy, ben].sort())
    // ben still sits at his table after the last board, and it closes when he leaves
    expect(tableOf(ben)!.board!.phase).toBe('finished')
    await send(ben, { type: 'leaveTable' })
    expect(tables()).toHaveLength(0)
    // The job finds nothing left to do
    await fireChallengeJobs()
    expect(challengeJobs()).toHaveLength(0)
  })

  it('finishes when the last participant plays their last board', async () => {
    const { id, amy, ben } = await setup(['ben'])
    await playAll(amy, id)
    expect(challengeOf(id).status).toBe('active')
    await playAll(ben, id)
    expect(challengeOf(id).status).toBe('finished')
  })
})

describe('the boards in the history (e7-t20)', () => {
  it('keeps them back until the end, then shows them from the end on', async () => {
    const { id, amy, ben } = await setup(['ben'])
    const zoe = await member('zoe')
    const deadline = challengeOf(id).deadline
    await playAll(amy, id)
    const boardIds = challengeOf(id).results.map((r) => r.boardId)
    const search = (userId: string) =>
      club.search(userId, { ...DEFAULT_HISTORY_QUERY, scope: 'all', mode: 'challenge' }).then((p) => p.total)
    expect(await search(amy)).toBe(4)
    expect(await search(zoe)).toBe(0)
    expect(await club.record(boardIds[0], zoe)).toBeNull()
    expect((await club.record(boardIds[0], amy))!.revealAt).toBe(deadline)

    time += DAY
    await playAll(ben, id)
    const end = challengeOf(id).endedAt!
    expect(end).toBe(time)
    expect(end).toBeLessThan(deadline)
    expect(await search(zoe)).toBe(8)
    expect(await club.search(zoe, { ...DEFAULT_HISTORY_QUERY, scope: 'all', mode: 'casual' }).then((p) => p.total)).toBe(0)
    const record = await club.record(boardIds[0], zoe)
    expect(record).toMatchObject({ mode: 'challenge', eventId: id, revealAt: end })
    const rows = store.sql.exec<{ reveal_at: number }>('SELECT reveal_at FROM boards_index WHERE event_id = ?', id)
    expect(rows.map((r) => r.reveal_at)).toEqual(new Array(8).fill(end))
    // The key-value summaries follow too
    for (const [key, summary] of await store.list<{ eventId?: string; revealAt?: number }>('hist:'))
      if (summary.eventId === id) expect([key, summary.revealAt]).toEqual([key, end])
  })

  it('shows the boards of a cancelled challenge once it is cancelled', async () => {
    const { id, amy } = await setup(['ben'], { accept: [] })
    const zoe = await member('zoe')
    await send(amy, { type: 'playChallenge', challengeId: id })
    await playBoard(amy)
    const boardId = challengeOf(id).results[0].boardId
    expect(await club.record(boardId, zoe)).toBeNull()
    await send(amy, { type: 'cancelChallenge', challengeId: id })
    expect(challengeOf(id).status).toBe('cancelled')
    expect(await club.record(boardId, zoe)).not.toBeNull()
    // Its table is gone
    expect(tableOf(amy)).toBeNull()
  })
})

describe('who sees which results (e7-t14, §4)', () => {
  async function started(settings: Record<string, unknown> = {}) {
    const ids = await setup(['ben', 'cat'], { accept: ['ben'], settings })
    const zoe = await member('zoe')
    results(ids.id, ids.amy, [420, 100, -50, 600])
    results(ids.id, ids.ben, [170, 100])
    return { ...ids, zoe } as Record<string, string>
  }

  it('an unfinished participant sees progress only, not even the boards they played (社長)', async () => {
    const { id, amy, ben } = await started()
    const view = seen(id, ben)!
    expect(view.players.map((p) => p.played)).toEqual([4, 2, 0])
    expect(view.standings).toBeUndefined()
    // Knowing whether they are ahead would change how they play the rest
    expect(view.travellers).toBeUndefined()
    const json = JSON.stringify(view)
    for (const hidden of ['b-' + amy + '-1', '420', '170', '600', 'hands']) expect(json).not.toContain(hidden)
  })

  it('a participant who has not played sees statuses and progress only', async () => {
    const { id, cat } = await started()
    const view = seen(id, cat)!
    expect(view.standings).toBeUndefined()
    expect(view.travellers).toBeUndefined()
    expect(JSON.stringify(view)).not.toContain('420')
  })

  it('a participant who finished sees the live standings of those finished, the matrix and every traveller', async () => {
    const { id, amy, ben } = await started()
    const view = seen(id, amy)!
    expect(view.standings).toMatchObject({
      final: false,
      scoring: 'total',
      ranked: [{ userId: amy, rank: 1, total: 1070, boards: [420, 100, -50, 600] }],
      unfinished: [{ userId: ben, played: 2 }],
    })
    expect(view.travellers!.map((t) => [t.seq, t.entries.length])).toEqual([
      [1, 2],
      [2, 2],
      [3, 1],
      [4, 1],
    ])
  })

  it('a non-participant sees nothing before the end, and after it only a club ranking', async () => {
    const { id, zoe } = await started({ ranking: 'club' })
    expect(seen(id, zoe)).toBeNull()
    await toDeadline(id)
    const view = seen(id, zoe)!
    expect(view.standings!.ranked).toEqual([{ userId: expect.any(String), rank: 1, total: 1070 }])
    expect(view.travellers).toBeUndefined()
    expect(club.challengeList(zoe)).toEqual([])
  })

  it('a non-participant sees nothing of a players-only ranking, even after the end', async () => {
    const { id, zoe } = await started()
    await toDeadline(id)
    expect(seen(id, zoe)).toBeNull()
  })

  it('after the end every participant sees everything', async () => {
    const { id, ben, cat } = await started()
    await toDeadline(id)
    for (const userId of [ben, cat]) {
      const view = seen(id, userId)!
      expect(view.standings!.final).toBe(true)
      expect(view.standings!.ranked[0].boards).toEqual([420, 100, -50, 600])
      expect(view.travellers!.map((t) => t.seq)).toEqual([1, 2, 3, 4])
    }
  })

  it('the list leaves the travellers out', async () => {
    const { amy } = await started()
    const [listed] = club.challengeList(amy)
    expect(listed.travellers).toBeUndefined()
    expect(listed.standings).toBeDefined()
  })

  it('opens another participant’s record of a board only to those who played every board', async () => {
    const { id, amy, ben, cat } = await setup(['ben', 'cat'], { accept: ['ben', 'cat'] })
    await send(amy, { type: 'playChallenge', challengeId: id })
    await playBoard(amy)
    const amyBoard = challengeOf(id).results[0].boardId
    expect(await club.record(amyBoard, ben)).toBeNull()

    await send(ben, { type: 'playChallenge', challengeId: id })
    await playBoard(ben)
    // ben played the same board but not the others yet
    expect(await club.record(amyBoard, ben)).toBeNull()
    await dealNext()
    await playAll(ben, id)
    expect((await club.record(amyBoard, ben))!.id).toBe(amyBoard)
    expect(await club.record(amyBoard, cat)).toBeNull()
    const view = seen(id, ben)!
    expect(view.travellers![0].entries.map((e) => e.boardId)).toContain(amyBoard)
    // The traveller has the contract and tricks from the history index
    const record = (await club.record(amyBoard, amy))!
    const entry = view.travellers![0].entries.find((e) => e.boardId === amyBoard)!
    expect(entry.contract).toEqual(record.board.contract)
    expect(entry.declarerTricks).toBe(record.board.contract ? record.board.result!.declarerTricks : null)
    expect(entry.scoreNS).toBe(record.board.result!.scoreNS)
  })
})
