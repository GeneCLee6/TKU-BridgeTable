// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { SUBSTITUTE_MS, type BoardRecord, type ClientMessage, type ServerMessage, type TableView } from '../../shared/protocol.ts'
import { ClubError, ClubService, type Connections, type ScheduleKind } from '../../worker/service.ts'
import type { MemoryStore } from '../../worker/store.ts'
import type { Table } from '../../worker/views.ts'
import { memoryStore } from './sqlite.ts'

/**
 * TKB in the club's system is private (社長 2026-10-26, ROBOT.md §7): only members given
 * `tkuSystem` (and admins) seat it or set it up; everyone else's TKB is the 2/1 one, and the server
 * turns down their asking for the club's. Whoever sets the robots up counts: others at that table
 * play with them as usual. Tables saved before keep the club's robots
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
  last<T extends ServerMessage['type']>(userId: string, type: T) {
    return (this.inbox.get(userId) ?? []).findLast((m) => m.type === type) as Extract<ServerMessage, { type: T }> | undefined
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
/** The founder: an admin, who has every permission */
let boss: string

const newClub = () =>
  new ClubService(store, connections, { maxUsers: 40, now: () => time, schedule: (run, ms, kind) => queue.push({ run, ms, kind }) })

beforeEach(async () => {
  store = memoryStore()
  connections = new FakeConnections()
  queue = []
  time = 1_000_000
  club = newClub()
  await club.load()
  boss = await member('boss')
})

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

async function member(name: string) {
  const result = await club.register(name, 'secret1', '')
  const user = 'user' in result ? result.user : await club.adminApprove(club.adminApplications().find((a) => a.username === name)!.id)
  connections.online.add(user.id)
  club.connected(user.id)
  await tick()
  return user.id
}

const send = (userId: string, message: ClientMessage) => club.handle(userId, message)
const tableFor = (userId: string) => connections.table(userId)!

/** The error code a member got for a message, if any */
async function refused(userId: string, message: ClientMessage) {
  const before = (connections.inbox.get(userId) ?? []).length
  await send(userId, message)
  const fresh = (connections.inbox.get(userId) ?? []).slice(before)
  return (fresh.findLast((m) => m.type === 'error') as Extract<ServerMessage, { type: 'error' }> | undefined)?.code
}

async function run(kind: ScheduleKind, limit = 400) {
  for (let i = 0; i < limit; i++) {
    const index = queue.findIndex((job) => job.kind === kind)
    if (index < 0) return
    queue.splice(index, 1)[0].run()
    await tick()
  }
}

/** Plays the board on: robots move, and each member given passes or plays their first legal card */
async function playOut(people: string[]) {
  for (let i = 0; i < 400 && tableFor(people[0]).board?.phase !== 'finished'; i++) {
    await run('robot')
    for (const person of people) {
      const board = tableFor(person).board!
      if (board.legalCalls.length) await send(person, { type: 'call', call: 'P' })
      else if (board.legalCards.length) await send(person, { type: 'play', card: board.legalCards[0] })
    }
  }
}

describe('the permission', () => {
  it('is granted and taken away on the admin page like the others; admins have it', async () => {
    const amy = await member('amy')
    const permissionsOf = async (id: string) => (await club.adminUsers()).find((u) => u.id === id)!.permissions
    expect(club.requirePermission(boss, 'tkuSystem').permissions).toContain('tkuSystem')
    expect(await permissionsOf(amy)).toEqual([])
    expect(() => club.requirePermission(amy, 'tkuSystem')).toThrow(ClubError)
    await club.adminSetPermissions(amy, ['tkuSystem'])
    expect(club.requirePermission(amy, 'tkuSystem').permissions).toEqual(['tkuSystem'])
    await club.adminSetPermissions(amy, [])
    expect(await permissionsOf(amy)).toEqual([])
  })
})

describe('seating TKB at a table', () => {
  it('gives a host without it the 2/1 TKB, and turns down the club’s', async () => {
    const amy = await member('amy')
    await send(amy, { type: 'createTable' })
    await send(amy, { type: 'addRobot', seat: 'N' })
    expect(tableFor(amy).seats.N).toMatchObject({ id: 'robot:gib:N', robotKind: 'gib' })
    expect(await refused(amy, { type: 'addRobot', seat: 'E', kind: 'tku' })).toBe('tkuSystemOnly')
    expect(tableFor(amy).seats.E).toBeNull()
    expect(await refused(amy, { type: 'addRobot', seat: 'E', kind: 'gib' })).toBeUndefined()
    expect(tableFor(amy).seats.E).toMatchObject({ id: 'robot:gib:E' })
  })

  it('lets a host with it (or an admin) choose, the club’s system by default', async () => {
    const amy = await member('amy')
    await club.adminSetPermissions(amy, ['tkuSystem'])
    await send(amy, { type: 'createTable' })
    await send(amy, { type: 'addRobot', seat: 'N' })
    await send(amy, { type: 'addRobot', seat: 'E', kind: 'gib' })
    expect(tableFor(amy).seats.N).toMatchObject({ id: 'robot:tku:N', robotKind: 'tku' })
    expect(tableFor(amy).seats.E).toMatchObject({ id: 'robot:gib:E', robotKind: 'gib' })
    await send(boss, { type: 'createTable' })
    await send(boss, { type: 'addRobot', seat: 'N' })
    expect(tableFor(boss).seats.N).toMatchObject({ id: 'robot:tku:N' })
  })

  it('counts the host only: a member without it plays with and against the club’s robots at their table', async () => {
    const amy = await member('amy')
    await send(boss, { type: 'createTable' })
    const tableId = tableFor(boss).id
    await send(amy, { type: 'sit', tableId, seat: 'N' })
    for (const seat of ['E', 'W'] as const) await send(boss, { type: 'addRobot', seat })
    expect(tableFor(amy).seats.E).toMatchObject({ robot: true, robotKind: 'tku' })
    const before = connections.inbox.get(amy)!.length
    await playOut([boss, amy])
    expect(connections.inbox.get(amy)!.slice(before).some((m) => m.type === 'error')).toBe(false)
    const record = (await store.get<BoardRecord>(`board:${tableFor(amy).board!.recordId}`))!
    expect(record.players.E).toMatchObject({ robot: true, robotKind: 'tku' })
  })
})

describe('a robot sitting in (代打)', () => {
  /** `host` opens a table, amy sits North; two robots of the host's own system; amy drops offline long enough */
  async function sitIn(host: string, amy: string) {
    await send(host, { type: 'createTable' })
    const tableId = tableFor(host).id
    await send(amy, { type: 'sit', tableId, seat: 'N' })
    for (const seat of ['E', 'W'] as const) await send(host, { type: 'addRobot', seat })
    return tableId
  }
  const goOffline = async (userId: string) => {
    connections.online.delete(userId)
    await club.disconnected(userId)
    time += SUBSTITUTE_MS
    await run('substitute', queue.filter((j) => j.kind === 'substitute').length)
  }

  it('is the 2/1 TKB at a table whose host has no permission, the club’s for one who has', async () => {
    const amy = await member('amy')
    const cat = await member('cat')
    await sitIn(cat, amy)
    await goOffline(amy)
    expect(tableFor(cat).seats.N).toMatchObject({ id: 'robot:gib:N', substituteFor: 'amy' })

    const ben = await member('ben')
    await sitIn(boss, ben)
    await goOffline(ben)
    expect(tableFor(boss).seats.N).toMatchObject({ id: 'robot:tku:N', substituteFor: 'ben' })
  })

  it('keeps the club’s system at a table saved before the permission', async () => {
    const amy = await member('amy')
    const cat = await member('cat')
    const tableId = await sitIn(cat, amy)
    // As saved before: no `robotKind` on the table
    const saved = (await store.get<Table>(`table:${tableId}`))!
    expect(saved.robotKind).toBe('gib')
    delete saved.robotKind
    await store.put(`table:${tableId}`, saved)
    queue = []
    club = newClub()
    await club.load()
    for (const id of [amy, cat]) club.connected(id)
    await goOffline(amy)
    expect(tableFor(cat).seats.N).toMatchObject({ id: 'robot:tku:N', substituteFor: 'amy' })
  })
})

describe('practice tables', () => {
  it('seat the 2/1 TKB for a member without it, and turn down the club’s', async () => {
    const amy = await member('amy')
    expect(await refused(amy, { type: 'createPractice', settings: { robotKind: 'tku' } } as ClientMessage)).toBe('tkuSystemOnly')
    expect(club.lobbyView(amy).myTableId).toBeNull()
    await send(amy, { type: 'createPractice', settings: {} } as ClientMessage)
    expect(tableFor(amy).seats.N).toMatchObject({ id: 'robot:gib:N' })
    expect(tableFor(amy).practice?.robotKind).toBe('gib')
  })

  it('seat the club’s system by default for a member with it', async () => {
    const amy = await member('amy')
    await club.adminSetPermissions(amy, ['tkuSystem'])
    await send(amy, { type: 'createPractice', settings: {} } as ClientMessage)
    expect(tableFor(amy).seats.N).toMatchObject({ id: 'robot:tku:N' })
  })
})

describe('team matches', () => {
  it('are set up with the club’s robots only by a host with it; one set up so keeps them', async () => {
    const amy = await member('amy')
    const code = (run: () => unknown) => {
      try {
        run()
      } catch (e) {
        return (e as ClubError).code
      }
    }
    expect(code(() => club.matches.create(amy, { settings: { robotKind: 'tku' } }))).toBe('tkuSystemOnly')
    const { id } = club.matches.create(amy, {})
    expect(club.matches.get(id, amy)!.settings.robotKind).toBe('gib')
    expect(code(() => club.matches.update(amy, id, { robotKind: 'tku' }))).toBe('tkuSystemOnly')
    await club.adminSetPermissions(amy, ['tkuSystem'])
    expect(club.matches.update(amy, id, { robotKind: 'tku' }).settings.robotKind).toBe('tku')
    // Taken away later: the match keeps its robots and its other settings still change
    await club.adminSetPermissions(amy, [])
    expect(club.matches.update(amy, id, { boards: 8 }).settings).toMatchObject({ boards: 8, robotKind: 'tku' })
  })
})
