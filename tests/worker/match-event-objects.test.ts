// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { defaultTeamMatchSettings, MATCH_SEATS } from '../../shared/team-match.ts'
import type { ServerMessage } from '../../shared/protocol.ts'
import { newTeamMatch } from '../../worker/team-match-flow.ts'
import { TeamMatchStore, type TeamMatch } from '../../worker/team-matches.ts'
import type { LogEntry } from '../../worker/log.ts'
import type { ClubService, Connections, ScheduleKind } from '../../worker/service.ts'
import type { MemoryStore } from '../../worker/store.ts'
import { clubService, evictEventObject, eventObject, eventObjects, failEventObject, matchKey } from './event-mode.ts'
import { memoryStore } from './sqlite.ts'

/**
 * Each team match in its own `EventObject` (H2c, ARCHITECTURE.md §5.12), run in Node as the
 * challenges are (`event-objects.test.ts`): every object is an `EventHost` with its own storage
 * and SQLite database behind a structured clone (`event-mode.ts`). The switch, moving the matches
 * out and back, an object evicted or unreachable, an answer lost on the way, and matches that
 * ended before H2c. The match rules themselves run in both modes in the `team-match*` tests.
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
}

let store: MemoryStore
let connections: FakeConnections
let club: ClubService
let queue: { run: () => void; ms: number; kind: ScheduleKind }[]
let time: number
let logs: LogEntry[]

/** A club on the same store: `on` is the switch (the objects are there either way) */
async function open(on: boolean) {
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

const tick = async (times = 1) => {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setImmediate(resolve))
}

async function run(kind: ScheduleKind) {
  const jobs = queue.filter((job) => job.kind === kind)
  queue = queue.filter((job) => job.kind !== kind)
  for (const job of jobs) job.run()
  await tick(10)
}

beforeEach(async () => {
  store = memoryStore()
  connections = new FakeConnections()
  time = 1_000_000
  logs = []
  await open(true)
  await club.register('boss', 'club-secret-1', '')
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

const kinds = (userId: string) =>
  (connections.inbox.get(userId)?.findLast((m) => m.type === 'notifications') as Extract<ServerMessage, { type: 'notifications' }> | undefined)
    ?.notifications.items.map((n) => n.kind) ?? []

/** Amy hosts a match of `boards` boards (open room South), ben is invited to the closed room's South and accepts; robots elsewhere */
async function setUp(boards = 4) {
  const amy = await member('amy')
  const ben = await member('ben')
  const { id } = await club.matches.create(amy, { settings: { boards } })
  await club.matches.act(amy, { type: 'matchInvite', matchId: id, room: 'closed', seat: 'S', userId: ben })
  await club.matches.act(ben, { type: 'matchAnswer', matchId: id, accept: true })
  for (const s of MATCH_SEATS)
    if (!(s.seat === 'S')) await club.matches.act(amy, { type: 'matchRobot', matchId: id, ...s })
  return { amy, ben, id }
}

/** The match set up and started: both rooms open */
async function playing(boards = 4) {
  const found = await setUp(boards)
  await club.handle(found.amy, { type: 'startMatch', matchId: found.id })
  expect(club.matches.store.get(found.id)?.status).toBe('playing')
  return found
}

/** The match as its own object holds it (null when it holds none) */
const inObject = (id: string): TeamMatch | null => eventObject(club, matchKey(id))?.host.teamMatch ?? null
const result = (boardId: string) => ({ boardId, scoreNS: 420, playedAt: time })

describe('each team match in its own object', () => {
  it('keeps the match in its object and the same copy in the club', async () => {
    const { amy, id } = await setUp()
    expect(inObject(id)).toEqual(club.matches.store.get(id))
    expect(inObject(id)?.seats.filter((s) => s.robot)).toHaveLength(6)
    expect(club.health().matchEvents).toEqual({ objects: 1, unconfirmed: 0 })
    // A challenge's object is another one: the match is named apart (`match:<id>`)
    expect(eventObject(club, id)).toBeUndefined()
    // Turned down with the code the pages know, the copy unchanged
    await expect(club.matches.update(amy, id, { boards: 99 })).rejects.toMatchObject({ code: 'badMatchSettings' })
    expect(inObject(id)?.settings.boards).toBe(4)
  })

  it('writes the results, finishes the match there, and closes it up once', async () => {
    const { amy, ben, id } = await playing()
    for (const seq of [1, 2, 3]) {
      await club.matches.addResult(id, seq, 'open', result(`x${seq}`))
      await club.matches.addResult(id, seq, 'closed', result(`y${seq}`))
    }
    expect(await club.matches.addResult(id, 4, 'open', result('x4'))).toEqual({ reveal: [], finished: false })
    expect(kinds(ben)).not.toContain('matchFinished')
    expect(await club.matches.addResult(id, 4, 'closed', result('y4'))).toEqual({ reveal: ['x4', 'y4'], finished: true })
    expect(inObject(id)?.status).toBe('finished')
    expect(club.matches.store.get(id)).toEqual(inObject(id))
    // The table reports the board again (its outbox): nothing changes
    expect(await club.matches.addResult(id, 4, 'closed', result('y4'))).toBeNull()
    // The club closes it up from the state it hears of, however often: here the object tells it
    // twice more (as when the answer that carried the change was lost); announced once
    await run('outbox')
    const finished = inObject(id)!
    await club.eventLink.matchChanged({ match: finished, rev: Number.MAX_SAFE_INTEGER - 1 })
    await club.eventLink.matchChanged({ match: finished, rev: Number.MAX_SAFE_INTEGER })
    for (const userId of [amy, ben]) expect(kinds(userId).filter((k) => k === 'matchFinished')).toHaveLength(1)
    expect(store.sql.exec('SELECT ended FROM match_settled WHERE match_id = ?', id)).toEqual([{ ended: 1 }])
  })

  it('offers a board again while its object does not answer, and counts it once', async () => {
    const { id } = await playing()
    failEventObject(club, matchKey(id), true)
    await expect(club.matches.addResult(id, 1, 'open', result('x1'))).rejects.toThrow()
    expect(club.matches.store.get(id)?.boards).toEqual([])
    failEventObject(club, matchKey(id), false)
    expect(await club.matches.addResult(id, 1, 'open', result('x1'))).toEqual({ reveal: [], finished: false })
    expect(await club.matches.addResult(id, 1, 'open', result('x1'))).toBeNull()
    expect(inObject(id)?.boards).toHaveLength(1)
  })

  it('catches up when an answer is lost: the object tells the change again', async () => {
    const { amy, id } = await setUp()
    // The object takes a change whose answer never reaches the club
    const host = eventObject(club, matchKey(id))!.host
    await host.stepMatch({ kind: 'settings', userId: amy, settings: { boards: 8 } })
    expect(club.matches.store.get(id)?.settings.boards).toBe(4)
    await run('outbox')
    expect(club.matches.store.get(id)?.settings.boards).toBe(8)
    // A late or repeated report changes nothing
    const old = structuredClone(club.matches.store.get(id)!)
    await club.eventLink.matchChanged({ match: { ...old, settings: { ...old.settings, boards: 4 } }, rev: 1 })
    expect(club.matches.store.get(id)?.settings.boards).toBe(8)
  })

  it('keeps everything when its object is evicted', async () => {
    const { amy, id } = await playing()
    await club.matches.addResult(id, 1, 'open', result('x1'))
    await evictEventObject(club, matchKey(id))
    expect(inObject(id)?.boards).toHaveLength(1)
    await club.handle(amy, { type: 'matchPause', matchId: id, paused: true })
    expect(inObject(id)?.pausedAt).toBe(time)
    expect(club.matches.store.get(id)?.pausedAt).toBe(time)
  })

  it('gives the object the club’s copy when it never took the match', async () => {
    const amy = await member('amy')
    const { id } = await club.matches.create(amy, {})
    expect(inObject(id)?.status).toBe('setup')
    // The object lost it (as if its adopt had never arrived): the next write hands it the copy
    await eventObject(club, matchKey(id))!.host.release()
    expect(inObject(id)).toBeNull()
    await club.matches.act(amy, { type: 'matchRobot', matchId: id, room: 'open', seat: 'N' })
    expect(inObject(id)?.seats.find((s) => s.room === 'open' && s.seat === 'N')?.robot).toBe(true)
  })
})

/** A club that never had the switch on, as production is when this is deployed */
async function switchedOff() {
  store = memoryStore()
  await open(false)
  await club.register('boss', 'club-secret-1', '')
}

/** A match that ended before H2c, written straight into the club's tables */
function oldMatch(id: string, hostId: string, status: TeamMatch['status']): TeamMatch {
  return { ...newTeamMatch({ id, hostId, now: time, settings: defaultTeamMatchSettings(), seat: { room: 'open', seat: 'S' } }), status }
}

describe('moving the team matches out and back', () => {
  it('leaves everything in the club with the switch off', async () => {
    await switchedOff()
    const { id } = await setUp()
    expect([...eventObjects(club).keys()].filter((k) => k.startsWith('match:'))).toEqual([])
    expect(club.health().matchEvents).toEqual({ objects: 0, unconfirmed: 0 })
    expect(club.matches.store.get(id)?.seats.filter((s) => s.robot)).toHaveLength(6)
    expect(await store.get('meta:matches')).toBeUndefined()
  })

  it('moves the open matches out when switched on, and leaves the ended ones', async () => {
    await switchedOff()
    const { amy, id } = await setUp()
    new TeamMatchStore(store.sql).create(oldMatch('done', amy, 'finished'))
    await open(true)
    expect(inObject(id)).toEqual(club.matches.store.get(id))
    expect(inObject('done')).toBeNull()
    expect(club.health().matchEvents).toEqual({ objects: 1, unconfirmed: 0 })
    expect(await store.get('meta:matches')).toBe(2)
    expect(logs).toContainEqual({ event: 'eventsMoved', kind: 'matches', to: 'objects', moved: 1, failed: 0 })
    // It goes on there
    await club.matches.cancel(amy, id)
    expect(inObject(id)?.status).toBe('cancelled')
    expect(club.matches.store.get(id)?.status).toBe('cancelled')
  })

  it('tries a match whose object failed again later', async () => {
    await switchedOff()
    const { id } = await setUp()
    failEventObject(club, matchKey(id), true)
    await open(true)
    expect(club.health().matchEvents).toEqual({ objects: 1, unconfirmed: 1 })
    expect(await store.get('meta:matches')).toBeUndefined()
    failEventObject(club, matchKey(id), false)
    await run('migrate')
    expect(club.health().matchEvents).toEqual({ objects: 1, unconfirmed: 0 })
    expect(await store.get('meta:matches')).toBe(2)
    expect(inObject(id)).toEqual(club.matches.store.get(id))
  })

  it('brings every match back when switched off, and moves them out again when switched on', async () => {
    const { amy, id } = await playing()
    await club.matches.addResult(id, 1, 'open', result('x1'))
    await open(false)
    expect(club.health().matchEvents).toEqual({ objects: 0, unconfirmed: 0 })
    expect(eventObject(club, matchKey(id))!.storage.size).toBe(0)
    expect(club.matches.store.get(id)?.boards).toHaveLength(1)
    expect(logs).toContainEqual({ event: 'eventsMoved', kind: 'matches', to: 'club', moved: 1, failed: 0 })
    expect(await store.get('meta:matches')).toBe(1)
    // It lives in the club again
    await club.handle(amy, { type: 'matchPause', matchId: id, paused: true })
    expect(club.matches.store.get(id)?.pausedAt).toBe(time)
    expect(inObject(id)).toBeNull()
    await open(true)
    expect(inObject(id)?.pausedAt).toBe(time)
    expect(inObject(id)?.boards).toHaveLength(1)
  })

  it('keeps a match in its object while it cannot be brought back, and drops its reports once it is', async () => {
    const { amy, id } = await setUp()
    failEventObject(club, matchKey(id), true)
    await open(false)
    expect(club.health().matchEvents).toEqual({ objects: 1, unconfirmed: 0 })
    failEventObject(club, matchKey(id), false)
    // Still reached in its object meanwhile
    await club.matches.update(amy, id, { boards: 8 })
    expect(inObject(id)?.settings.boards).toBe(8)
    await run('migrate')
    expect(club.health().matchEvents).toEqual({ objects: 0, unconfirmed: 0 })
    expect(club.matches.store.get(id)?.settings.boards).toBe(8)
    const late = structuredClone(club.matches.store.get(id)!)
    await club.eventLink.matchChanged({ match: { ...late, status: 'cancelled' }, rev: Date.now() })
    expect(club.matches.store.get(id)?.status).toBe('setup')
  })

  it('announces nothing again for matches that ended before H2c', async () => {
    const fresh = memoryStore()
    const old = new TeamMatchStore(fresh.sql)
    old.createTables()
    old.create(oldMatch('won', 'amy', 'finished'))
    old.create(oldMatch('gone', 'amy', 'abandoned'))
    old.create(oldMatch('off', 'amy', 'cancelled'))
    old.create(oldMatch('open', 'amy', 'setup'))
    store = fresh
    await open(true)
    expect(store.sql.exec('SELECT * FROM match_settled ORDER BY match_id')).toEqual([
      { match_id: 'gone', ended: 1 },
      { match_id: 'off', ended: 1 },
      { match_id: 'won', ended: 1 },
    ])
    // The open one moved out; the ended ones stay in the club
    expect(inObject('open')?.status).toBe('setup')
    expect(inObject('won')).toBeNull()
  })
})
