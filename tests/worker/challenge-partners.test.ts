// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import type { ClientMessage, ServerMessage, TableView } from '../../shared/protocol.ts'
import { challengeEvent } from '../../worker/ranking-events.ts'
import type { ClubService, Connections, ScheduleKind } from '../../worker/service.ts'
import type { MemoryStore } from '../../worker/store.ts'
import { memoryStore } from './sqlite.ts'
import { clubService, writeChallenge } from './event-mode.ts'

/**
 * Partner challenges (e7-t28, AC-7.9) on both paths of `EVENT_OBJECTS` (the file matches the
 * `challenge*` tests in vite.config.ts): two members sit North-South at one table against two
 * robots and compare with other partnerships on the same boards. Invitations come in pairs, a
 * board is dealt only once both are seated, a partner away stops the table, and the partnership
 * is one entry in the standings and travellers, both members credited.
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
  lastError(userId: string) {
    const found = (this.inbox.get(userId) ?? []).findLast((m) => m.type === 'error')
    return found?.type === 'error' ? found.code : undefined
  }
  bell(userId: string) {
    const last = (this.inbox.get(userId) ?? []).findLast((m) => m.type === 'notifications')
    return last?.type === 'notifications' ? last.notifications.items.map((n) => n.kind) : []
  }
}

let store: MemoryStore
let connections: FakeConnections
let club: ClubService
let queue: { run: () => void; ms: number; kind: ScheduleKind }[]
let time: number
let boss: string
const ids: Record<string, string> = {}

const tick = async (times = 1) => {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setImmediate(resolve))
}

beforeEach(async () => {
  store = memoryStore()
  connections = new FakeConnections()
  queue = []
  time = Date.UTC(2026, 10, 10)
  club = clubService(store, connections, {
    maxUsers: 40,
    now: () => time,
    schedule: (run, ms, kind) => queue.push({ run, ms, kind }),
  })
  await club.load()
  const result = await club.register('boss', 'club-secret-1', '')
  boss = 'user' in result ? result.user.id : ''
  for (const name of ['amy', 'ben', 'cat', 'dan', 'eve', 'fay']) ids[name] = await member(name)
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

async function refused(userId: string, message: ClientMessage) {
  connections.inbox.set(userId, [])
  await send(userId, message)
  return connections.lastError(userId)
}

/** amy and ben against the other pairs (cat-dan by default); `accept` answers for everyone invited */
async function partnerChallenge(pairs: string[][] = [['cat', 'dan']], settings: Record<string, unknown> = {}, accept = true) {
  const invitees = [ids.ben, ...pairs.flat().map((n) => ids[n])]
  const view = await club.challengeRequest(ids.amy, {
    type: 'createChallenge',
    invitees,
    boards: 2,
    settings: { partners: true, ...settings },
  })
  const id = view!.id
  if (accept)
    for (const userId of invitees) await club.challengeRequest(userId, { type: 'answerChallenge', challengeId: id, accept: true })
  return id
}

const runRobots = async () => {
  for (let i = 0; i < 400; i++) {
    const index = queue.findIndex((job) => job.kind === 'robot')
    if (index < 0) return
    queue.splice(index, 1)[0].run()
    await tick()
  }
}

const dealNext = async () => {
  const deals = queue.filter((job) => job.kind === 'deal')
  queue = queue.filter((job) => job.kind !== 'deal')
  time += Math.max(0, ...deals.map((job) => job.ms))
  for (const job of deals) job.run()
  await tick()
}

/** One move of whichever partner is to act (passes; plays their first legal card); false when nobody of the two is */
async function step(people: string[]): Promise<boolean> {
  await runRobots()
  for (const userId of people) {
    const board = connections.table(userId)?.board
    if (!board || board.phase === 'finished') continue
    if (board.legalCalls.length) {
      await send(userId, { type: 'call', call: 'P' })
      return true
    }
    if (board.legalCards.length) {
      await send(userId, { type: 'play', card: board.legalCards[0] })
      return true
    }
  }
  return false
}

/** Plays the board on the partnership's table to its end */
async function playBoard(people: string[]) {
  for (let i = 0; i < 400; i++) {
    const board = connections.table(people[0])?.board
    if (board?.phase === 'finished') return
    if (await step(people)) continue
    // The robots may have finished it (a pass-out)
    const now = connections.table(people[0])?.board
    if (now?.phase !== 'finished') throw new Error(`stuck: ${now?.phase}, turn ${now?.turn}`)
  }
}

/** Both sit down and play until `upTo` boards are done */
async function playPair(people: string[], id: string, upTo: number) {
  for (const userId of people) await send(userId, { type: 'playChallenge', challengeId: id })
  for (let i = 0; i < 20; i++) {
    const view = connections.table(people[0])!
    if (view.board?.phase === 'finished') {
      if (view.challenge!.played >= upTo) return
      await dealNext()
    } else await playBoard(people)
  }
  throw new Error('too many boards')
}

describe('creating a partner challenge (e7-t28)', () => {
  it('pairs the creator with the first invitee and the others two by two', async () => {
    const id = await partnerChallenge([['cat', 'dan'], ['eve', 'fay']], {}, false)
    const c = club.challenges.get(id)!
    expect(c.settings.partners).toBe(true)
    // Two opposing partnerships: matchpoints by default, as for more than one opponent
    expect(c.settings.scoring).toBe('mp')
    const partner = Object.fromEntries(c.players.map((p) => [p.userId, p.partnerId]))
    expect(partner).toEqual({
      [ids.amy]: ids.ben,
      [ids.ben]: ids.amy,
      [ids.cat]: ids.dan,
      [ids.dan]: ids.cat,
      [ids.eve]: ids.fay,
      [ids.fay]: ids.eve,
    })
    expect(club.challengeFor(id, ids.cat)!.players.find((p) => p.userId === ids.cat)?.partnerId).toBe(ids.dan)
  })

  it('refuses invitees that do not pair up, too many pairs, scorings for the pairs, and boards played alone', async () => {
    const create = (invitees: string[], settings: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      refused(ids.amy, { type: 'createChallenge', invitees, boards: 2, settings: { partners: true, ...settings }, ...extra })
    expect(await create([ids.ben, ids.cat, ids.dan, ids.eve], {})).toBe('badChallengeSettings')
    expect(await create([ids.ben, ids.cat], {})).toBe('challengeInvitees')
    expect(await create([ids.ben], {})).toBe('challengeInvitees')
    // One opposing partnership is a head to head: IMPs or total points only
    expect(await create([ids.ben, ids.cat, ids.dan], { scoring: 'mp' })).toBe('badChallengeSettings')
    expect(await create([ids.ben, ids.cat, ids.dan], { partners: 'yes' })).toBe('badChallengeSettings')
    expect(await create([ids.ben, ids.cat, ids.dan], {}, { fromBoards: ['x'] })).toBe('badChallengeSettings')
  })
})

describe('answers (e7-t28)', () => {
  it('turns active once an opposing partnership both accepted', async () => {
    const id = await partnerChallenge([['cat', 'dan']], {}, false)
    await club.challengeRequest(ids.ben, { type: 'answerChallenge', challengeId: id, accept: true })
    await club.challengeRequest(ids.cat, { type: 'answerChallenge', challengeId: id, accept: true })
    expect(club.challenges.get(id)!.status).toBe('pending')
    await club.challengeRequest(ids.dan, { type: 'answerChallenge', challengeId: id, accept: true })
    expect(club.challenges.get(id)!.status).toBe('active')
  })

  it('declines the whole partnership when one says no, and tells the partner', async () => {
    const id = await partnerChallenge([['cat', 'dan'], ['eve', 'fay']], {}, false)
    await club.challengeRequest(ids.cat, { type: 'answerChallenge', challengeId: id, accept: true })
    await club.challengeRequest(ids.dan, { type: 'answerChallenge', challengeId: id, accept: false })
    const status = (name: string) => club.challenges.get(id)!.players.find((p) => p.userId === ids[name])!.status
    expect(status('cat')).toBe('declined')
    expect(status('dan')).toBe('declined')
    expect(connections.bell(ids.cat)).toContain('challengePartnerDeclined')
    // The other pair declining too leaves nobody to play against
    await club.challengeRequest(ids.eve, { type: 'answerChallenge', challengeId: id, accept: false })
    expect(status('fay')).toBe('declined')
    expect(club.challenges.get(id)!.status).toBe('expired')
  })

  it('does not let anyone play before their partner accepted', async () => {
    const id = await partnerChallenge([['cat', 'dan']], {}, false)
    // The creator has accepted; their partner not yet
    expect(await refused(ids.amy, { type: 'playChallenge', challengeId: id })).toBe('challengePartnerWaiting')
    await club.challengeRequest(ids.cat, { type: 'answerChallenge', challengeId: id, accept: true })
    expect(await refused(ids.cat, { type: 'playChallenge', challengeId: id })).toBe('challengePartnerWaiting')
  })

  it('declines a member whose partner never answered, at the deadline', async () => {
    const id = await partnerChallenge([['cat', 'dan'], ['eve', 'fay']], {}, false)
    for (const name of ['ben', 'cat', 'dan', 'eve'])
      await club.challengeRequest(ids[name], { type: 'answerChallenge', challengeId: id, accept: true })
    time = club.challenges.get(id)!.deadline
    const due = queue.filter((job) => job.kind === 'challenge')
    queue = queue.filter((job) => job.kind !== 'challenge')
    for (const job of due) job.run()
    await tick(10)
    const c = club.challenges.get(id)!
    expect(c.status).toBe('finished')
    expect(c.players.find((p) => p.userId === ids.eve)!.status).toBe('declined')
    expect(c.players.find((p) => p.userId === ids.fay)!.status).toBe('declined')
  })
})

describe('the partnership table (e7-t28)', () => {
  it('deals only once both sit, stands still while one is away, and scores the pair as one entry', async () => {
    const id = await partnerChallenge([['cat', 'dan']], { scoring: 'imp' })
    // amy comes first: South, the robots East-West, North waits for ben
    await send(ids.amy, { type: 'playChallenge', challengeId: id })
    let view = connections.table(ids.amy)!
    expect(view.seats.S?.id).toBe(ids.amy)
    expect(view.seats.N).toBeNull()
    expect(view.seats.E?.robot && view.seats.W?.robot).toBe(true)
    expect(view.board).toBeNull()
    expect(view.challenge?.partnerAway).toBe(true)
    // ben sits North and the first board is dealt
    await send(ids.ben, { type: 'playChallenge', challengeId: id })
    view = connections.table(ids.amy)!
    expect(view.seats.N?.id).toBe(ids.ben)
    expect(view.board).not.toBeNull()
    expect(view.challenge?.partnerAway).toBeUndefined()
    await playBoard([ids.amy, ids.ben])
    await dealNext()
    // Halfway through board 2, ben leaves: the table waits, robots too, and amy cannot play on alone
    await step([ids.amy, ids.ben])
    expect(connections.table(ids.amy)!.board!.phase).not.toBe('finished')
    await send(ids.ben, { type: 'leaveTable' })
    expect(connections.table(ids.amy)!.seats.N).toBeNull()
    await runRobots()
    const frozen = JSON.stringify(connections.table(ids.amy)!.board)
    expect(connections.table(ids.amy)!.challenge?.partnerAway).toBe(true)
    const board = connections.table(ids.amy)!.board!
    const move: ClientMessage = { type: 'call', call: 'P' }
    if (board.turn === 'S') expect(await refused(ids.amy, move)).toBe('challengePartnerAway')
    await runRobots()
    expect(JSON.stringify(connections.table(ids.amy)!.board)).toBe(frozen)
    // ben comes back to North and the board goes on as it was
    await send(ids.ben, { type: 'playChallenge', challengeId: id })
    expect(connections.table(ids.ben)!.seats.N?.id).toBe(ids.ben)
    await playBoard([ids.amy, ids.ben])
    expect(connections.table(ids.amy)!.challenge?.played).toBe(2)

    await playPair([ids.cat, ids.dan], id, 2)
    const c = club.challenges.get(id)!
    expect(c.status).toBe('finished')
    // Each member has the partnership's results: the same boards and scores
    const results = (name: string) => c.results.filter((r) => r.userId === ids[name]).map((r) => [r.seq, r.boardId, r.scoreNS])
    expect(results('ben')).toEqual(results('amy'))
    expect(results('dan')).toEqual(results('cat'))
    expect(results('amy')).toHaveLength(2)

    for (const name of ['amy', 'ben', 'cat', 'dan']) {
      const seen = club.challengeFor(id, ids[name])!
      expect(seen.standings!.ranked.map((r) => [r.userId, r.partnerId]).sort()).toEqual(
        [
          [ids.amy, ids.ben],
          [ids.cat, ids.dan],
        ].sort(),
      )
      expect(seen.travellers!.map((x) => x.entries.map((e) => [e.userId, e.partnerId]))).toEqual([
        [
          [ids.amy, ids.ben],
          [ids.cat, ids.dan],
        ],
        [
          [ids.amy, ids.ben],
          [ids.cat, ids.dan],
        ],
      ])
    }
    // The traveller of a record names the partnership; ben, who sat North, sees his own board's
    const traveller = await club.traveller(c.results[0].boardId, ids.ben)
    expect(traveller!.entries.map((e) => [e.user?.username, e.partner?.username])).toEqual([
      ['amy', 'ben'],
      ['cat', 'dan'],
    ])
    // Club points and ratings: the partnership is one side, both members credited
    const ranked = challengeEvent(c, () => undefined, time)!
    expect(ranked.sides.map((s) => s.userIds)).toEqual(
      expect.arrayContaining([
        [ids.amy, ids.ben],
        [ids.cat, ids.dan],
      ]),
    )
    // Personal challenge records leave partnerships out
    expect(club.challengeExtras.stats(ids.amy).challenges).toBe(0)
    // Both leaving after the last board closes the table
    for (const name of ['amy', 'ben', 'cat', 'dan']) await send(ids[name], { type: 'leaveTable' })
    expect([...store.data.keys()].filter((k) => k.startsWith('table:'))).toHaveLength(0)
  })

  it('at the deadline drops a board half played and lists the partnership as unfinished', async () => {
    const id = await partnerChallenge([['cat', 'dan']], { scoring: 'imp' })
    await playPair([ids.amy, ids.ben], id, 2)
    await playPair([ids.cat, ids.dan], id, 1)
    await dealNext()
    await step([ids.cat, ids.dan])
    time = club.challenges.get(id)!.deadline
    const due = queue.filter((job) => job.kind === 'challenge')
    queue = queue.filter((job) => job.kind !== 'challenge')
    for (const job of due) job.run()
    await tick(10)
    const view = club.challengeFor(id, ids.dan)!
    expect(view.status).toBe('finished')
    expect(view.standings!.ranked.map((r) => r.userId)).toEqual([ids.amy])
    expect(view.standings!.unfinished).toEqual([{ userId: ids.cat, played: 1, partnerId: ids.dan }])
    // Their table closed with the half-played board
    expect(connections.table(ids.cat)).toBeNull()
  })
})

describe('leaving the club and rematches (e7-t28)', () => {
  it('declines the partner of a deleted member and cancels when one partnership is left', async () => {
    const id = await partnerChallenge([['cat', 'dan'], ['eve', 'fay']])
    writeChallenge(club, id, (s) => s.addResult(id, { userId: ids.dan, seq: 1, boardId: 'b-dan', scoreNS: 50, playedAt: time }))
    await club.adminDeleteUser(boss, ids.cat)
    let c = club.challenges.get(id)!
    expect(c.status).toBe('active')
    expect(c.players.find((p) => p.userId === ids.dan)!.status).toBe('declined')
    expect(c.results.some((r) => r.userId === ids.dan)).toBe(false)
    await club.adminDeleteUser(boss, ids.fay)
    c = club.challenges.get(id)!
    expect(c.status).toBe('cancelled')
  })

  it('rematches with the same partnerships, the one asking with their partner first', async () => {
    const id = await partnerChallenge([['cat', 'dan']], { scoring: 'total' })
    for (const name of ['amy', 'ben', 'cat', 'dan'])
      for (const seq of [1, 2])
        writeChallenge(club, id, (s) =>
          s.addResult(id, { userId: ids[name], seq, boardId: `b-${name}-${seq}`, scoreNS: 100, playedAt: time }),
        )
    time = club.challenges.get(id)!.deadline
    for (const job of queue.filter((j) => j.kind === 'challenge')) job.run()
    await tick(10)
    const next = await club.challengeRequest(ids.dan, { type: 'rematchChallenge', challengeId: id })
    const c = club.challenges.get(next!.id)!
    expect(c.settings.partners).toBe(true)
    expect(c.settings.scoring).toBe('total')
    expect(c.creatorId).toBe(ids.dan)
    expect(c.players.map((p) => [p.userId, p.partnerId])).toEqual([
      [ids.dan, ids.cat],
      [ids.cat, ids.dan],
      [ids.amy, ids.ben],
      [ids.ben, ids.amy],
    ])
  })
})
