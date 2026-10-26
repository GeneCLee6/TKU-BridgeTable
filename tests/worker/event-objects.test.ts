// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { challengeDeadline, defaultChallengeSettings } from '../../shared/challenge.ts'
import { makeDealSet } from '../../shared/deal-set.ts'
import type { ClientMessage, ServerMessage, TableView } from '../../shared/protocol.ts'
import { REMINDER_MS } from '../../worker/challenge-flow.ts'
import { ChallengeStore, type Challenge } from '../../worker/challenges.ts'
import type { LogEntry } from '../../worker/log.ts'
import type { ClubService, Connections, ScheduleKind } from '../../worker/service.ts'
import type { MemoryStore } from '../../worker/store.ts'
import { clubService, evictEventObject, eventObject, eventObjects, failEventObject } from './event-mode.ts'
import { memoryStore } from './sqlite.ts'

/**
 * Each challenge in its own `EventObject` (H2b, ARCHITECTURE.md §5.12), run in Node: every object
 * is an `EventHost` with its own storage and SQLite database behind a structured clone
 * (`event-mode.ts`). The switch (`eventObjectsOn`), moving the challenges out and back, an
 * object evicted, reports that do not get through, and a board's result offered again.
 */

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
let logs: LogEntry[]

/** A club on the same store: `on` is the switch (the objects are there either way) */
async function open(on: boolean) {
  connections = connections ?? new FakeConnections()
  queue = []
  club = clubService(
    store,
    connections,
    {
      maxUsers: 40,
      now: () => time,
      schedule: (run, ms, kind) => queue.push({ run, ms, kind }),
      log: (entry) => void logs.push(entry),
      eventObjectsOn: on,
    },
    true,
  )
  await club.load()
}

beforeEach(async () => {
  store = memoryStore()
  connections = new FakeConnections()
  time = 1_000_000
  logs = []
  await open(true)
  await club.register('boss', 'secret1', '')
})

const tick = async (times = 1) => {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

async function run(kind: ScheduleKind) {
  const jobs = queue.filter((job) => job.kind === kind)
  queue = queue.filter((job) => job.kind !== kind)
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
const bell = (userId: string) => connections.inbox.get(userId)?.findLast((m) => m.type === 'notifications')
const kinds = (userId: string) =>
  (bell(userId) as Extract<ServerMessage, { type: 'notifications' }> | undefined)?.notifications.items.map((n) => n.kind) ?? []
const errors = (userId: string) => (connections.inbox.get(userId) ?? []).filter((m) => m.type === 'error')

/** amy challenges ben (4 boards); ben accepts unless told not to */
async function duel({ accept = true } = {}) {
  const amy = await member('amy')
  const ben = await member('ben')
  await send(amy, { type: 'setFriend', userId: ben, friend: true })
  await send(amy, { type: 'createChallenge', invitees: [ben], boards: 4, settings: {} })
  const id = club.challengeList(amy)[0].id
  if (accept) await send(ben, { type: 'answerChallenge', challengeId: id, accept: true })
  return { amy, ben, id }
}

/** The challenge as its object keeps it */
const inObject = (id: string): Challenge | null => {
  const object = eventObject(club, id)
  return object ? new ChallengeStore(object.sql).get(id) : null
}

async function playBoard(userId: string) {
  for (let i = 0; i < 400; i++) {
    const robots = queue.filter((job) => job.kind === 'robot')
    if (robots.length) {
      await run('robot')
      continue
    }
    const board = connections.table(userId)?.board
    if (!board) throw new Error('no board')
    if (board.phase === 'finished') return
    if (board.legalCalls.length) await send(userId, { type: 'call', call: 'P' })
    else if (board.legalCards.length) await send(userId, { type: 'play', card: board.legalCards[0] })
    else throw new Error(`stuck: ${board.phase}`)
  }
}

/** A challenge made the way the club made them before H2b, straight into its tables */
function oldChallenge(id: string, creator: string, invited: string[], status: Challenge['status'] = 'pending'): Challenge {
  const settings = defaultChallengeSettings(invited.length)
  return {
    id,
    creatorId: creator,
    createdAt: time,
    status,
    deadline: challengeDeadline(time, settings),
    settings,
    deals: makeDealSet({ kind: 'random', count: 4 })!,
    players: [
      { userId: creator, status: 'accepted', invitedAt: time, answeredAt: time, knownDeals: false },
      ...invited.map((userId) => ({ userId, status: 'accepted' as const, invitedAt: time, answeredAt: time, knownDeals: false })),
    ],
    results: [],
    ...(status !== 'pending' && { endedAt: time }),
  }
}

describe('each challenge in its own object (switch on)', () => {
  it('keeps the challenge in its object and a copy in the club, the same after every change', async () => {
    const { amy, ben, id } = await duel()
    expect(inObject(id)).toMatchObject({ status: 'active', players: [{ userId: amy }, { userId: ben, status: 'accepted' }] })
    expect(club.challenges.get(id)).toEqual(inObject(id))
    // Its job is the object's: the club's own queue would not be asked for it twice
    expect(queue.filter((j) => j.kind === 'challenge').map((j) => j.ms)).toEqual([3 * DAY - REMINDER_MS])
    expect(club.health().events).toEqual({ objects: 1, unconfirmed: 0 })
    expect(kinds(amy)).toContain('challengeAccepted')
  })

  it('answers with the codes the pages know, and catches its copy up with a refusal', async () => {
    const { amy, ben, id } = await duel()
    await send(ben, { type: 'answerChallenge', challengeId: id, accept: true })
    expect(errors(ben).at(-1)).toMatchObject({ code: 'alreadyAnswered' })
    await send(amy, { type: 'cancelChallenge', challengeId: id })
    expect(club.challenges.get(id)?.status).toBe('cancelled')
    expect(inObject(id)?.status).toBe('cancelled')
  })

  it('settles at the deadline in its object, and the club announces the results once', async () => {
    const { amy, ben, id } = await duel()
    time = club.challenges.get(id)!.deadline
    await run('challenge')
    expect(inObject(id)?.status).toBe('finished')
    expect(club.challenges.get(id)?.status).toBe('finished')
    const results = (userId: string) => kinds(userId).filter((k) => k === 'challengeResults')
    expect(results(amy)).toHaveLength(1)
    expect(results(ben)).toHaveLength(1)
    // The report again (the object tells every change once more) changes nothing
    await run('outbox')
    expect(results(amy)).toHaveLength(1)
  })

  it('carries on after its object is evicted: the job is scheduled again, the reminder not sent twice', async () => {
    const { ben, id } = await duel()
    time = club.challenges.get(id)!.deadline - REMINDER_MS
    await run('challenge')
    expect(kinds(ben).filter((k) => k === 'challengeReminder')).toHaveLength(1)
    queue = []
    await evictEventObject(club, id)
    expect(queue.filter((j) => j.kind === 'challenge').map((j) => j.ms)).toEqual([REMINDER_MS])
    await run('challenge')
    time += REMINDER_MS
    await run('challenge')
    expect(kinds(ben).filter((k) => k === 'challengeReminder')).toHaveLength(1)
    expect(club.challenges.get(id)?.status).toBe('finished')
  })

  it('tells the club again when a report does not get through, and the end is done once', async () => {
    const { amy, id } = await duel()
    // The club is away when the deadline comes: the report fails
    const changed = club.eventLink.changed
    club.eventLink.changed = async () => {
      throw new Error('club unavailable')
    }
    time = club.challenges.get(id)!.deadline
    await run('challenge')
    expect(inObject(id)?.status).toBe('finished')
    expect(club.challenges.get(id)?.status).toBe('active')
    expect(eventObject(club, id)!.storage.get('unreported')).toBeDefined()
    // The object tries again on its alarm
    club.eventLink.changed = changed
    await run('outbox')
    expect(club.challenges.get(id)?.status).toBe('finished')
    expect(eventObject(club, id)!.storage.get('unreported')).toBeUndefined()
    expect(kinds(amy).filter((k) => k === 'challengeResults')).toHaveLength(1)
    expect(errors(amy)).toEqual([])
  })

  it('reaches a challenge whose object did not take it at first: it adopts the club’s copy', async () => {
    const amy = await member('amy')
    const ben = await member('ben')
    await send(amy, { type: 'setFriend', userId: ben, friend: true })
    // The object of the next challenge is down when it is made
    const before = club.health().events!
    failEventObjectNext()
    await send(amy, { type: 'createChallenge', invitees: [ben], boards: 4, settings: {} })
    const id = club.challengeList(amy)[0].id
    expect(club.health().events).toEqual({ objects: before.objects + 1, unconfirmed: 1 })
    expect(logs.some((e) => e.event === 'crash' && e.where === 'adoptChallenge')).toBe(true)
    // The invitation went out all the same; the object is back and ben answers
    expect(kinds(ben)).toContain('challengeInvited')
    failEventObject(club, id, false)
    await send(ben, { type: 'answerChallenge', challengeId: id, accept: true })
    expect(inObject(id)?.status).toBe('active')
    expect(club.health().events).toEqual({ objects: 1, unconfirmed: 0 })
  })

  it('offers a board’s result again when the challenge’s object is down, and counts it once', async () => {
    const { amy, id } = await duel()
    await send(amy, { type: 'playChallenge', challengeId: id })
    failEventObject(club, id, true)
    await playBoard(amy)
    await tick(5)
    expect(inObject(id)?.results).toEqual([])
    // The table keeps the board in its outbox; once the object answers again it is counted
    failEventObject(club, id, false)
    await run('outbox')
    expect(inObject(id)?.results.map((r) => [r.userId, r.seq])).toEqual([[amy, 1]])
    expect(club.challenges.get(id)?.results).toHaveLength(1)
    await run('outbox')
    expect(club.challenges.get(id)?.results).toHaveLength(1)
  })
})

/** Makes the object of the next challenge (whatever its id) fail its first call */
function failEventObjectNext() {
  const remote = (club as unknown as { eventObjects: { get: (id: string) => unknown } }).eventObjects
  const get = remote.get.bind(remote)
  let first = true
  remote.get = (id: string) => {
    if (first) {
      first = false
      failEventObject(club, id, true)
    }
    return get(id)
  }
}

/** A club that never had the switch on, as production is when this is deployed */
async function switchedOff() {
  store = memoryStore()
  await open(false)
  await club.register('boss', 'secret1', '')
}

describe('moving the challenges out and back', () => {
  it('leaves everything in the club with the switch off', async () => {
    await switchedOff()
    const { id } = await duel()
    expect(eventObjects(club).size).toBe(0)
    expect(club.health().events).toEqual({ objects: 0, unconfirmed: 0 })
    expect(queue.filter((j) => j.kind === 'challenge')).toHaveLength(1)
    expect(club.challenges.get(id)?.status).toBe('active')
    expect(await store.get('meta:events')).toBeUndefined()
  })

  it('moves the open challenges out when switched on, and leaves the ended ones', async () => {
    await switchedOff()
    const { amy, ben, id } = await duel()
    const sql = new ChallengeStore(store.sql)
    sql.create(oldChallenge('done', amy, [ben], 'finished'))
    await open(true)
    expect(inObject(id)).toEqual(club.challenges.get(id))
    expect(inObject('done')).toBeNull()
    expect(club.health().events).toEqual({ objects: 1, unconfirmed: 0 })
    expect(await store.get('meta:events')).toBe(2)
    expect(logs).toContainEqual({ event: 'eventsMoved', to: 'objects', moved: 1, failed: 0 })
    // It goes on there: ben's job was the club's, now it is the object's
    await send(amy, { type: 'cancelChallenge', challengeId: id })
    expect(inObject(id)?.status).toBe('cancelled')
  })

  it('tries a challenge whose object failed again later, and moving twice changes nothing', async () => {
    await switchedOff()
    const { amy, id } = await duel()
    failEventObject(club, id, true)
    await open(true)
    expect(club.health().events).toEqual({ objects: 1, unconfirmed: 1 })
    expect(await store.get('meta:events')).toBeUndefined()
    // Its job in the club's queue does nothing any more: the challenge lives in its object now
    failEventObject(club, id, false)
    await run('migrate')
    expect(club.health().events).toEqual({ objects: 1, unconfirmed: 0 })
    expect(await store.get('meta:events')).toBe(2)
    // Evicted halfway and done again: the object keeps what it has
    await send(amy, { type: 'cancelChallenge', challengeId: id })
    await open(true)
    expect(inObject(id)?.status).toBe('cancelled')
    expect(club.challenges.get(id)?.status).toBe('cancelled')
  })

  it('brings every challenge back when switched off, and moves them out again when switched on', async () => {
    const { amy, ben, id } = await duel()
    await open(false)
    expect(club.health().events).toEqual({ objects: 0, unconfirmed: 0 })
    expect(eventObject(club, id)!.storage.size).toBe(0)
    expect(inObject(id)).toBeNull()
    expect(club.challenges.get(id)?.status).toBe('active')
    expect(logs).toContainEqual({ event: 'eventsMoved', to: 'club', moved: 1, failed: 0 })
    expect(await store.get('meta:events')).toBe(1)
    // It lives in the club again: its job is the club's
    time = club.challenges.get(id)!.deadline - REMINDER_MS
    await run('challenge')
    expect(kinds(ben)).toContain('challengeReminder')
    await open(true)
    expect(inObject(id)?.remindedAt).toBe(time)
    await send(amy, { type: 'cancelChallenge', challengeId: id })
    expect(inObject(id)?.status).toBe('cancelled')
    // The reminder was sent once, whichever object held the challenge
    expect(kinds(ben).filter((k) => k === 'challengeReminder')).toHaveLength(1)
  })

  it('keeps a challenge in its object while it cannot be brought back, and drops its reports once it is', async () => {
    const { id } = await duel()
    failEventObject(club, id, true)
    await open(false)
    expect(club.health().events).toEqual({ objects: 1, unconfirmed: 0 })
    failEventObject(club, id, false)
    await run('migrate')
    expect(club.health().events).toEqual({ objects: 0, unconfirmed: 0 })
    // A late report from the object it lived in changes nothing
    const late = structuredClone(club.challenges.get(id)!)
    await club.eventLink.changed({ challenge: { ...late, status: 'expired' }, rev: Date.now() })
    expect(club.challenges.get(id)?.status).toBe('active')
  })

  it('announces nothing again for challenges that ended before H2b', async () => {
    const fresh = memoryStore()
    const sql = new ChallengeStore(fresh.sql)
    sql.createTables()
    sql.create(oldChallenge('old', 'amy', ['ben'], 'finished'))
    sql.create(oldChallenge('reminded', 'amy', ['ben']))
    sql.setReminded('reminded', time)
    store = fresh
    await open(true)
    const settled = store.sql.exec<{ challenge_id: string; ended: number; reminded: number }>(
      'SELECT * FROM challenge_settled ORDER BY challenge_id',
    )
    expect(settled).toEqual([
      { challenge_id: 'old', ended: 1, reminded: 0 },
      { challenge_id: 'reminded', ended: 0, reminded: 1 },
    ])
    expect(connections.inbox.size).toBe(0)
  })
})
