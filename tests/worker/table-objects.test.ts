// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { secureRandomInt } from '../../shared/board.ts'
import { TABLE_SOCKET_REFUSED, type ClientMessage, type ServerMessage, type TableView } from '../../shared/protocol.ts'
import { noLog, type LogEntry } from '../../worker/log.ts'
import { manualScheduler, type JobKind } from '../../worker/scheduler.ts'
import { ClubService, type Connections } from '../../worker/service.ts'
import type { MemoryStore } from '../../worker/store.ts'
import { TableHost } from '../../worker/table-host.ts'
import { RemoteTables, type TableEntry, type TableRpc } from '../../worker/tables.ts'
import type { Table } from '../../worker/views.ts'
import { memoryStore } from './sqlite.ts'

/**
 * The tables in their own Durable Objects (H1b, ARCHITECTURE.md §5.10), run in Node: each object is
 * a `TableHost` with its own storage and connections, reached through `RemoteTables` behind a
 * structured clone (as RPC copies everything), and reporting back through the club's `link`
 */

class ClubSockets implements Connections {
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

/** One table's object: its storage, who holds a connection to it, and the host (dropped on eviction) */
interface FakeObject {
  storage: Map<string, unknown>
  online: Set<string>
  host: TableHost
}

let store: MemoryStore
let sockets: ClubSockets
let club: ClubService
let objects: Map<string, FakeObject>
let queue: { run: () => void; ms: number; kind: JobKind }[]
let time: number
/** Every message any member got, from the club or a table, in order */
let inbox: Map<string, ServerMessage[]>
/** Connections a table let go: which table, whom, with what code */
let dismissed: { tableId: string; userId: string; code: number }[]
/** Objects that fail every call (RPC down), and calls held until a gate opens */
let failing: Set<string>
let gates: Map<string, Promise<void>>
let logs: LogEntry[]

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const clone = <T>(value: T): T => (value === undefined ? value : structuredClone(value))

function makeHost(tableId: string, object: Omit<FakeObject, 'host'>): TableHost {
  return new TableHost({
    storage: {
      get: async (key) => clone(object.storage.get(key)) as never,
      put: async (key, value) => void object.storage.set(key, clone(value)),
      clear: async () => object.storage.clear(),
    },
    sockets: {
      onlineUserIds: () => [...object.online],
      send: (userId, message) => void inbox.set(userId, [...(inbox.get(userId) ?? []), clone(message)]),
      dismiss: (userId, code) => {
        object.online.delete(userId)
        dismissed.push({ tableId, userId, code })
      },
    },
    club: {
      changed: (entry) => club.link.changed(clone(entry)),
      closed: (id) => club.link.closed(id),
      boardFinished: (record, event) => club.link.boardFinished(clone(record), clone(event)),
    },
    config: { now: () => time, random: secureRandomInt, scheduler: manualScheduler((run, ms, kind) => queue.push({ run, ms, kind })) },
    log: noLog,
  })
}

function object(tableId: string): FakeObject {
  let found = objects.get(tableId)
  if (!found) {
    const parts = { storage: new Map<string, unknown>(), online: new Set<string>() }
    found = { ...parts, host: makeHost(tableId, parts) }
    objects.set(tableId, found)
  }
  return found
}

/** The object is evicted: a new host loads from the same storage (nobody's connection survives in this fake) */
async function evict(tableId: string) {
  const found = object(tableId)
  found.host = makeHost(tableId, found)
  await found.host.load()
}

/** A table object's stub: every call copied both ways, as RPC does */
function stub(tableId: string): TableRpc {
  return new Proxy({} as TableRpc, {
    get:
      (_, name: string) =>
      async (...args: unknown[]) => {
        await gates.get(tableId)
        if (failing.has(tableId)) throw new Error('object unavailable')
        const host = object(tableId).host as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
        return clone(await host[name](...clone(args)))
      },
  })
}

async function makeClub(options: { objects?: boolean; inClub?: boolean } = {}) {
  sockets = new ClubSockets()
  sockets.send = (userId, message) => void inbox.set(userId, [...(inbox.get(userId) ?? []), message])
  club = new ClubService(store, sockets, {
    maxUsers: 20,
    now: () => time,
    schedule: (run, ms, kind) => queue.push({ run, ms, kind }),
    log: (entry) => void logs.push(entry),
    ...(options.objects !== false && { tableObjects: new RemoteTables(stub), tablesInClub: options.inClub }),
  })
  await club.load()
}

beforeEach(async () => {
  store = memoryStore()
  objects = new Map()
  queue = []
  time = 1_000_000
  inbox = new Map()
  dismissed = []
  failing = new Set()
  gates = new Map()
  logs = []
  await makeClub()
})

async function member(name: string) {
  const result = await club.register(name, 'secret1', '')
  const user = 'user' in result ? result.user : await club.adminApprove(club.adminApplications().find((a) => a.username === name)!.id)
  sockets.online.add(user.id)
  club.connected(user.id)
  await tick()
  return user.id
}

const send = (userId: string, message: ClientMessage) => club.handle(userId, message)
const lobby = (userId: string) => club.lobbyView(userId)
const last = <T extends ServerMessage['type']>(userId: string, type: T) =>
  (inbox.get(userId) ?? []).findLast((m) => m.type === type) as Extract<ServerMessage, { type: T }> | undefined

/** Opens the member's connection to a table (what the Worker forwards to `/ws/table/<id>`) */
async function connectTable(userId: string, tableId: string) {
  object(tableId).online.add(userId)
  await object(tableId).host.connected(userId)
}

async function closeTable(userId: string, tableId: string) {
  object(tableId).online.delete(userId)
  await object(tableId).host.disconnected(userId)
}

/** A message on the member's table connection */
const tableSend = (userId: string, tableId: string, message: ClientMessage | string) =>
  object(tableId).host.message(userId, typeof message === 'string' ? message : JSON.stringify(message))

/** The table as the browser holds it, from every `table` message on either connection */
function tableOf(userId: string): TableView | null {
  let view = null as TableView | null
  for (const m of inbox.get(userId) ?? []) {
    if (m.type !== 'table') continue
    const wire = m.table
    if (!wire) {
      view = null
      continue
    }
    const keep: TableView | null = view?.id === wire.id ? view : null
    view = { ...wire, chat: wire.chat ?? keep?.chat ?? [], recent: wire.recent ?? keep?.recent ?? [] }
  }
  return view
}

async function runRobots(limit = 400) {
  for (let i = 0; i < limit; i++) {
    const index = queue.findIndex((job) => job.kind === 'robot')
    if (index < 0) return
    queue.splice(index, 1)[0].run()
    await tick()
  }
}

/** Amy alone with three robots at a new table, connected to it */
async function robotTable(amy: string) {
  await send(amy, { type: 'createTable' })
  const tableId = lobby(amy).myTableId!
  await connectTable(amy, tableId)
  for (const seat of ['N', 'E', 'W'] as const) await tableSend(amy, tableId, { type: 'addRobot', seat })
  return tableId
}

/** Amy passes or plays her first legal card (over the table's connection) until the board is over */
async function playOut(amy: string, tableId: string) {
  for (let i = 0; i < 400; i++) {
    await runRobots()
    // A robot's move still under way (several hops between the objects) gets a turn to finish
    await tick()
    const board = tableOf(amy)!.board!
    if (board.phase === 'finished') return
    if (board.legalCalls.length) await tableSend(amy, tableId, { type: 'call', call: 'P' })
    else if (board.legalCards.length) await tableSend(amy, tableId, { type: 'play', card: board.legalCards[0] })
  }
  throw new Error(`the board did not finish: ${JSON.stringify(tableOf(amy)?.board?.phase)}`)
}

const clubKeys = (prefix: string) => [...store.data.keys()].filter((key) => key.startsWith(prefix))

describe('tables in their own objects', () => {
  it('keeps the table in its object and only its directory entry in the club', async () => {
    const amy = await member('amy')
    const tableId = await robotTable(amy)
    expect(clubKeys('table:')).toEqual([])
    expect(clubKeys('tabledir:')).toEqual([`tabledir:${tableId}`])
    expect((object(tableId).storage.get('table') as Table).seats.S).toBe(amy)
    // The lobby comes from the directory; the table's view from the table's connection
    expect(lobby(amy).tables[0]).toMatchObject({ id: tableId, boardNo: 1 })
    expect(tableOf(amy)!.board!.boardNo).toBe(1)
  })

  it('plays a board over the table connection and the club keeps its record', async () => {
    const amy = await member('amy')
    const tableId = await robotTable(amy)
    await playOut(amy, tableId)
    await tick()
    const history = await club.history(amy, false)
    expect(history.total).toBe(1)
    expect(lobby(amy).tables[0].boardsPlayed).toBe(1)
    expect((object(tableId).storage.get('table') as Table).outbox).toBeUndefined()
  })

  it('picks up where it was after its object is evicted', async () => {
    const amy = await member('amy')
    const tableId = await robotTable(amy)
    await runRobots()
    const before = (object(tableId).storage.get('table') as Table).board
    await evict(tableId)
    expect(object(tableId).host.table!.board).toEqual(before)
    await connectTable(amy, tableId)
    expect(tableOf(amy)!.board!.boardNo).toBe(before!.boardNo)
  })

  it('brings a table error back to the member as the same code', async () => {
    const [amy, bob] = [await member('amy'), await member('bob')]
    const tableId = await robotTable(amy)
    await send(bob, { type: 'joinTable', tableId })
    // Through the club (a page whose table connection is not open yet): the table says no
    await send(bob, { type: 'kick', seat: 'S' })
    expect(last(bob, 'error')).toMatchObject({ code: 'hostOnly' })
    // And on the table's own connection
    await connectTable(bob, tableId)
    await tableSend(bob, tableId, { type: 'removeRobot', seat: 'N' })
    expect(last(bob, 'error')).toMatchObject({ code: 'hostOnly' })
  })

  it('drops a table from the directory when its object no longer has it', async () => {
    const [amy, bob] = [await member('amy'), await member('bob')]
    const tableId = await robotTable(amy)
    // The table closed but the club never heard (its report was lost)
    object(tableId).storage.clear()
    await evict(tableId)
    await send(bob, { type: 'joinTable', tableId })
    expect(last(bob, 'error')).toMatchObject({ code: 'tableGone' })
    expect(lobby(bob).tables).toEqual([])
    expect(clubKeys('tabledir:')).toEqual([])
  })

  it('runs one member’s actions one at a time while a table answers', async () => {
    const [amy, bob, cat] = [await member('amy'), await member('bob'), await member('cat')]
    await send(bob, { type: 'createTable' })
    await send(cat, { type: 'createTable' })
    const [a, b] = [lobby(bob).myTableId!, lobby(cat).myTableId!]
    let open!: () => void
    gates.set(a, new Promise((resolve) => (open = resolve)))
    // Two tabs: sit at A (its object is slow), then at B
    const first = send(amy, { type: 'sit', tableId: a, seat: 'N' })
    const second = send(amy, { type: 'sit', tableId: b, seat: 'N' })
    await tick()
    open()
    await Promise.all([first, second])
    const at = club.lobbyView(amy).tables.filter((t) => Object.values(t.seats).some((s) => s?.id === amy))
    expect(at.map((t) => t.id)).toEqual([b])
    expect((object(a).storage.get('table') as Table).seats.N).toBeNull()
  })
})

describe('a table’s own connection', () => {
  it('only takes people at the table', async () => {
    const [amy, bob] = [await member('amy'), await member('bob')]
    const tableId = await robotTable(amy)
    await connectTable(bob, tableId)
    expect(dismissed).toEqual([{ tableId, userId: bob, code: TABLE_SOCKET_REFUSED }])
    // A spectator is let go once they leave through the club
    await send(bob, { type: 'joinTable', tableId })
    await connectTable(bob, tableId)
    expect(object(tableId).online.has(bob)).toBe(true)
    await send(bob, { type: 'leaveTable' })
    expect(object(tableId).online.has(bob)).toBe(false)
    expect(dismissed).toHaveLength(2)
  })

  it('checks every message and takes table actions only', async () => {
    const amy = await member('amy')
    const tableId = await robotTable(amy)
    await tableSend(amy, tableId, 'not json')
    expect(last(amy, 'error')).toMatchObject({ code: 'badMessage' })
    await tableSend(amy, tableId, 'x'.repeat(9000))
    expect(last(amy, 'error')).toMatchObject({ code: 'messageTooLarge' })
    await tableSend(amy, tableId, { type: 'call', call: 7 } as never)
    expect(last(amy, 'error')).toMatchObject({ code: 'badMessage' })
    // Lobby actions go to the club's connection
    await tableSend(amy, tableId, { type: 'createTable' })
    expect(last(amy, 'error')).toMatchObject({ code: 'unknownCommand' })
  })

  it('limits chat and actions per member', async () => {
    const amy = await member('amy')
    const tableId = await robotTable(amy)
    for (let i = 0; i < 6; i++) await tableSend(amy, tableId, { type: 'chat', text: `hi ${i}` })
    expect(last(amy, 'error')).toMatchObject({ code: 'chatTooFast' })
    expect(tableOf(amy)!.chat).toHaveLength(5)
    for (let i = 0; i < 30; i++) await tableSend(amy, tableId, { type: 'undoRespond', accept: true })
    expect(last(amy, 'error')).toMatchObject({ code: 'slowDown' })
  })

  it('goes by its own connections for who is there', async () => {
    const [amy, bob] = [await member('amy'), await member('bob')]
    const tableId = await robotTable(amy)
    await send(bob, { type: 'joinTable', tableId })
    await connectTable(bob, tableId)
    // The club's connection dropping does not take him from the table: his table connection is open
    sockets.online.delete(bob)
    await club.disconnected(bob)
    expect(lobby(amy).tables[0].spectators).toBe(1)
    // His table connection closing does: a spectator leaves
    await closeTable(bob, tableId)
    await tick()
    expect(lobby(amy).tables[0].spectators).toBe(0)
  })
})

describe('access modes at a table in its own object', () => {
  it('runs requests to join through the object: the host sees them on the table connection', async () => {
    const [amy, bob, cleo] = [await member('amy'), await member('bob'), await member('cleo')]
    await send(amy, { type: 'createTable', settings: { access: 'request' } })
    const tableId = lobby(amy).myTableId!
    await connectTable(amy, tableId)
    await send(bob, { type: 'requestJoin', tableId })
    await tick()
    expect(tableOf(amy)!.requests).toEqual([{ user: { id: bob, username: 'bob' }, at: time }])
    expect(lobby(bob).tables[0].requested).toBe(true)
    await send(amy, { type: 'answerRequest', userId: bob, accept: true })
    await tick()
    expect(tableOf(amy)!.requests).toEqual([])
    expect(store.data.get(`tabledir:${tableId}`)).toMatchObject({ approved: [bob], requests: [] })
    await send(bob, { type: 'joinTable', tableId })
    expect(lobby(bob).myTableId).toBe(tableId)

    // The object checks on its own too, with the same codes as the club
    const host = object(tableId).host
    expect(await host.join({ id: cleo, username: 'cleo', blocked: [] })).toMatchObject({ error: { code: 'requestFirst' } })
    await send(amy, { type: 'updateTableSettings', settings: { access: 'closed' } })
    expect(await host.sit({ id: cleo, username: 'cleo', blocked: [] }, 'N')).toMatchObject({ error: { code: 'tableClosed' } })
    expect(await host.request({ id: cleo, username: 'cleo', blocked: [] }, false)).toMatchObject({ error: { code: 'tableClosed' } })
    await send(amy, { type: 'updateTableSettings', settings: { access: 'hidden' } })
    expect(await host.join({ id: cleo, username: 'cleo', blocked: [] })).toMatchObject({ error: { code: 'tableGone' } })
  })

  it('reads a directory entry and a table saved before the access modes', async () => {
    const [amy, bob, cleo] = [await member('amy'), await member('bob'), await member('cleo')]
    await send(amy, { type: 'createTable', settings: { access: 'hidden' }, invitees: [bob] })
    const tableId = lobby(amy).myTableId!
    // As saved by the version before: `visibility: 'invite'`, no request lists
    const entry = store.data.get(`tabledir:${tableId}`) as Record<string, unknown>
    const { approved: _a, requests: _r, ...rest } = entry
    store.data.set(`tabledir:${tableId}`, { ...rest, settings: { visibility: 'invite', allowKibitz: true, boardMinutes: 0 } })
    const saved = object(tableId).storage.get('table') as Table
    object(tableId).storage.set('table', { ...saved, settings: { visibility: 'invite', allowKibitz: true, boardMinutes: 0 } })
    await evict(tableId)
    await makeClub()

    expect(lobby(cleo).tables).toEqual([])
    expect(lobby(bob).tables[0]).toMatchObject({ id: tableId, welcome: true, settings: { access: 'hidden' } })
    await send(cleo, { type: 'joinTable', tableId })
    expect(last(cleo, 'error')).toMatchObject({ code: 'tableGone' })
    await send(bob, { type: 'joinTable', tableId })
    expect(lobby(bob).myTableId).toBe(tableId)
    expect((object(tableId).storage.get('table') as Table).settings).toEqual({ access: 'hidden', allowKibitz: true, boardMinutes: 0 })
  })
})

describe('moving the tables (schema 3 ↔ 4)', () => {
  /** A club as deployed before H1b: tables kept as `table:<id>` in its own storage */
  async function oldClub() {
    store = memoryStore()
    await makeClub({ objects: false })
    const amy = await member('amy')
    await send(amy, { type: 'createTable' })
    const tableId = lobby(amy).myTableId!
    for (const seat of ['N', 'E', 'W'] as const) await send(amy, { type: 'addRobot', seat })
    await runRobots()
    queue = []
    expect(await store.get('meta:schema')).toBe(3)
    return { amy, tableId, saved: (await store.get<Table>(`table:${tableId}`))! }
  }

  it('moves every stored table into its object', async () => {
    const { amy, tableId, saved } = await oldClub()
    await makeClub()
    expect(clubKeys('table:')).toEqual([])
    expect(await store.get('meta:schema')).toBe(4)
    expect(await store.get<TableEntry>(`tabledir:${tableId}`)).toMatchObject({ id: tableId, hostId: amy })
    expect(object(tableId).host.table!.board).toEqual(saved.board)
    expect(lobby(amy).tables.map((t) => t.id)).toEqual([tableId])
    expect(logs).toContainEqual({ event: 'tablesMoved', to: 'objects', moved: 1, failed: 0 })
    // Loading again changes nothing
    await makeClub()
    expect(lobby(amy).tables.map((t) => t.id)).toEqual([tableId])
  })

  it('leaves a table whose object fails and tries it again later', async () => {
    const { amy, tableId } = await oldClub()
    failing.add(tableId)
    await makeClub()
    expect(clubKeys('table:')).toEqual([`table:${tableId}`])
    expect(await store.get('meta:schema')).toBe(3)
    expect(lobby(amy).tables).toEqual([])
    failing.clear()
    const retry = queue.find((job) => job.kind === 'migrate')!
    retry.run()
    await tick()
    await tick()
    expect(clubKeys('table:')).toEqual([])
    expect(await store.get('meta:schema')).toBe(4)
    expect(lobby(amy).tables.map((t) => t.id)).toEqual([tableId])
  })

  it('keeps what the object has when the move is done again after an eviction halfway', async () => {
    const { amy, tableId, saved } = await oldClub()
    // The object adopted the table and played on, then the club was evicted before deleting `table:`
    await object(tableId).host.adopt(saved)
    await connectTable(amy, tableId)
    await tableSend(amy, tableId, { type: 'chat', text: 'still here' })
    await makeClub()
    expect(clubKeys('table:')).toEqual([])
    expect(object(tableId).host.table!.chat.map((line) => line.text)).toEqual(['still here'])
  })

  it('drops a stored table whose object closed it meanwhile', async () => {
    const { amy, tableId, saved } = await oldClub()
    await object(tableId).host.adopt(saved)
    await object(tableId).host.close()
    await makeClub()
    expect(clubKeys('table:')).toEqual([])
    expect(clubKeys('tabledir:')).toEqual([])
    expect(lobby(amy).tables).toEqual([])
  })

  it('switches back: TABLE_OBJECTS=off brings every table into the club again', async () => {
    const amy = await member('amy')
    const tableId = await robotTable(amy)
    await runRobots()
    const board = object(tableId).host.table!.board
    queue = []
    await makeClub({ inClub: true })
    expect(clubKeys('tabledir:')).toEqual([])
    expect((await store.get<Table>(`table:${tableId}`))!.board).toEqual(board)
    expect(object(tableId).storage.size).toBe(0)
    expect(await store.get('meta:schema')).toBe(3)
    expect(club.localTable(tableId)!.state!.board).toEqual(board)
    expect(lobby(amy).tables.map((t) => t.id)).toEqual([tableId])
    // And forward again
    await makeClub()
    expect(clubKeys('table:')).toEqual([])
    expect(object(tableId).host.table!.board).toEqual(board)
  })

  it('keeps still once handed over, so nothing is played twice', async () => {
    const amy = await member('amy')
    const tableId = await robotTable(amy)
    const host = object(tableId).host
    const handed = await host.handOver()
    expect('ok' in handed && handed.ok?.id).toBe(tableId)
    expect(object(tableId).online.has(amy)).toBe(false)
    expect(await host.sit({ id: amy, username: 'amy', blocked: [] }, 'N')).toEqual({ gone: true })
    // Its robots' jobs save nothing more
    const saved = structuredClone(object(tableId).storage.get('table'))
    await runRobots()
    expect(object(tableId).storage.get('table')).toEqual(saved)
  })
})
