// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { deal } from '../../shared/board.ts'
import { partnerOf } from '../../shared/cards.ts'
import { newBoard, makeCall, playCard, legalCards, turnOf } from '../../shared/game.ts'
import { lobbyOrder, missingSeats, quickSeatChoice } from '../../shared/lobby.ts'
import { parseClientMessage } from '../../shared/message-guard.ts'
import {
  LIMITS,
  SLOW_TURN_MS,
  SUBSTITUTE_MS,
  type BoardRecord,
  type ClientMessage,
  type ServerMessage,
  type TableView,
} from '../../shared/protocol.ts'
import { ClubService, type Connections, type ScheduleKind } from '../../worker/service.ts'
import type { MemoryStore } from '../../worker/store.ts'
import { boardView } from '../../worker/views.ts'
import { memoryStore } from './sqlite.ts'

/** How hosts run their tables (F1): invitations, no kibitzers, time limits, slow players, the lobby's order, quick seat and robot substitutes */

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

/** A repeatable shuffle (mulberry32), so the boards played out are the same every run */
const seeded = (seed: number) => {
  let a = seed
  return (n: number) => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n)
  }
}

beforeEach(async () => {
  store = memoryStore()
  connections = new FakeConnections()
  queue = []
  time = 1_000_000
  club = new ClubService(store, connections, {
    maxUsers: 40,
    random: seeded(7),
    now: () => time,
    schedule: (run, ms, kind) => queue.push({ run, ms, kind }),
  })
  await club.load()
})

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

async function member(name: string) {
  const result = await club.register(name, 'secret1', '')
  let id: string
  if ('user' in result) id = result.user.id
  else id = (await club.adminApprove(club.adminApplications().find((a) => a.username === name)!.id)).id
  connections.online.add(id)
  club.connected(id)
  await tick()
  return id
}

const send = (userId: string, message: ClientMessage) => club.handle(userId, message)
const tableFor = (userId: string) => connections.table(userId)!
const lastError = (userId: string) => connections.last(userId, 'error')?.code
const lobbyOf = (userId: string) => club.lobbyView(userId)

/** Runs the jobs of one kind that are waiting, one at a time (a substitute job only once: it may put itself back) */
async function run(kind: ScheduleKind, limit = kind === 'substitute' ? queue.filter((j) => j.kind === kind).length : 400) {
  for (let i = 0; i < limit; i++) {
    const index = queue.findIndex((job) => job.kind === kind)
    if (index < 0) return
    queue.splice(index, 1)[0].run()
    await tick()
  }
}

/** Plays the board on: robots move, and `person` passes or plays their first legal card */
async function playOut(person: string) {
  for (let i = 0; i < 300 && tableFor(person).board?.phase !== 'finished'; i++) {
    await run('robot')
    const board = tableFor(person).board!
    if (board.legalCalls.length) await send(person, { type: 'call', call: 'P' })
    else if (board.legalCards.length) await send(person, { type: 'play', card: board.legalCards[0] })
    else if (board.phase === 'finished') break
  }
}

describe('invite-only tables (e2-t25)', () => {
  it('are listed for everyone, but only the invited may sit or watch, and they are told', async () => {
    const gene = await member('gene')
    const amy = await member('amy')
    const bob = await member('bob')
    await send(gene, { type: 'createTable', settings: { visibility: 'invite' }, invitees: [amy] })
    const tableId = tableFor(gene).id

    const invitation = connections.last(amy, 'notifications')!.notifications.items[0]
    expect(invitation).toMatchObject({ kind: 'tableInvited', params: { tableId, number: 1, username: 'gene' } })
    expect(lobbyOf(bob).tables[0]).toMatchObject({ id: tableId, welcome: false })
    expect(lobbyOf(amy).tables[0].welcome).toBe(true)

    await send(bob, { type: 'sit', tableId, seat: 'N' })
    expect(lastError(bob)).toBe('notInvited')
    await send(bob, { type: 'joinTable', tableId })
    expect(lastError(bob)).toBe('notInvited')
    expect(lobbyOf(bob).myTableId).toBeNull()

    await send(amy, { type: 'sit', tableId, seat: 'N' })
    expect(tableFor(amy).mySeat).toBe('N')
    // Only the host sees the list
    expect(tableFor(gene).invited?.map((u) => u.username)).toEqual(['amy'])
    expect(tableFor(amy).invited).toBeUndefined()

    // Inviting bob as well tells only him
    const amyNotes = connections.last(amy, 'notifications')!.notifications.items.length
    await send(gene, { type: 'updateTableSettings', settings: {}, invitees: [amy, bob] })
    expect(connections.last(bob, 'notifications')!.notifications.items[0].kind).toBe('tableInvited')
    expect(connections.last(amy, 'notifications')!.notifications.items).toHaveLength(amyNotes)
    await send(bob, { type: 'joinTable', tableId })
    expect(tableFor(bob).id).toBe(tableId)
  })

  it('turn down a bad invitation list', async () => {
    const gene = await member('gene')
    const amy = await member('amy')
    await send(gene, { type: 'createTable', invitees: [gene] })
    expect(lastError(gene)).toBe('notSelf')
    await send(gene, { type: 'createTable', invitees: ['nobody'] })
    expect(lastError(gene)).toBe('userGone')
    await send(gene, { type: 'createTable', invitees: [amy, amy] })
    expect(lastError(gene)).toBe('badTableSettings')
    await send(gene, { type: 'createTable', invitees: Array.from({ length: LIMITS.tableInvitesMax + 1 }, () => amy) })
    expect(lastError(gene)).toBe('badTableSettings')
    expect(lobbyOf(gene).tables).toHaveLength(0)
  })

  it('refuse an invitation when either side blocked the other (AC-1.6), without telling a blocked host why', async () => {
    const gene = await member('gene')
    const amy = await member('amy')
    const cleo = await member('cleo')
    // cleo blocked gene: gene only hears that cleo cannot be invited, the same words as for any refusal
    await send(cleo, { type: 'setBlocked', userId: gene, blocked: true })
    await send(gene, { type: 'createTable', settings: { visibility: 'invite' }, invitees: [cleo] })
    expect(connections.last(gene, 'error')).toMatchObject({ code: 'cannotInvite', params: { name: 'cleo' } })
    expect(lobbyOf(gene).tables).toHaveLength(0)
    expect(connections.last(cleo, 'notifications')!.notifications.items.some((n) => n.kind === 'tableInvited')).toBe(false)

    // gene blocked amy: gene is asked to unblock first, also when changing the list later
    await send(gene, { type: 'setBlocked', userId: amy, blocked: true })
    await send(gene, { type: 'createTable', settings: { visibility: 'invite' } })
    await send(gene, { type: 'updateTableSettings', settings: {}, invitees: [amy] })
    expect(lastError(gene)).toBe('unblockFirst')
    expect(tableFor(gene).invited).toEqual([])
    expect(connections.last(amy, 'notifications')!.notifications.items.some((n) => n.kind === 'tableInvited')).toBe(false)
  })

  it('let in whoever is already at the table when it turns invite only', async () => {
    const gene = await member('gene')
    const amy = await member('amy')
    await send(gene, { type: 'createTable' })
    const tableId = tableFor(gene).id
    await send(amy, { type: 'joinTable', tableId })
    await send(gene, { type: 'updateTableSettings', settings: { visibility: 'invite' } })
    await send(amy, { type: 'sit', tableId, seat: 'E' })
    expect(tableFor(amy).mySeat).toBe('E')
  })
})

describe('tables without kibitzers (e2-t26)', () => {
  it('take people only into their seats', async () => {
    const gene = await member('gene')
    const amy = await member('amy')
    await send(gene, { type: 'createTable', settings: { allowKibitz: false } })
    const tableId = tableFor(gene).id
    await send(amy, { type: 'joinTable', tableId })
    expect(lastError(amy)).toBe('noKibitzing')
    expect(lobbyOf(amy).myTableId).toBeNull()
    await send(amy, { type: 'sit', tableId, seat: 'N' })
    expect(tableFor(amy).mySeat).toBe('N')
  })

  it('show someone there without a seat only what is face up for everyone', async () => {
    const gene = await member('gene')
    const amy = await member('amy')
    await send(gene, { type: 'createTable', settings: { allowKibitz: false } })
    const tableId = tableFor(gene).id
    await send(amy, { type: 'sit', tableId, seat: 'N' })
    for (const seat of ['E', 'W'] as const) await send(gene, { type: 'addRobot', seat })
    expect(tableFor(amy).board?.phase).toBe('auction')
    // Between boards would be the usual time, but the host may ask anyone to leave the seat at once
    await send(gene, { type: 'kick', seat: 'N' })
    expect(tableFor(amy).mySeat).toBeNull()
    expect(tableFor(amy).board!.hands).toEqual({})

    // Kibitzers see every hand at an ordinary table
    await send(gene, { type: 'updateTableSettings', settings: { allowKibitz: true } })
    expect(Object.keys(tableFor(amy).board!.hands)).toHaveLength(4)
  })

  it('are a views rule: dummy after the lead and the finished board, nothing else', () => {
    let board = newBoard(1, deal())
    for (const call of ['1C', 'P', 'P', 'P'] as const) board = makeCall(board, turnOf(board)!, call)
    const closed = (b: typeof board) => Object.keys(boardView(b, null, { kibitz: false }).hands).sort()
    expect(closed(board)).toEqual([])
    expect(Object.keys(boardView(board, null).hands)).toHaveLength(4)
    const leader = turnOf(board)!
    board = playCard(board, leader, legalCards(board, leader)[0])
    expect(closed(board)).toEqual([partnerOf(board.contract!.declarer)])
    while (board.phase !== 'finished') {
      const seat = turnOf(board)!
      board = playCard(board, seat, legalCards(board, seat)[0])
    }
    expect(closed(board)).toHaveLength(4)
  })
})

describe('time limit per board (e2-t27)', () => {
  it('is a setting the server times from the deal, shown while the board is played', async () => {
    const gene = await member('gene')
    await send(gene, { type: 'createTable', settings: { boardMinutes: 6 } })
    expect(lastError(gene)).toBe('badTableSettings')
    await send(gene, { type: 'createTable', settings: { boardMinutes: 7 } })
    expect(tableFor(gene).settings.boardMinutes).toBe(7)
    expect(tableFor(gene).boardEndsAt).toBeNull()
    const dealt = time
    for (const seat of ['N', 'E', 'W'] as const) await send(gene, { type: 'addRobot', seat })
    expect(tableFor(gene).boardEndsAt).toBe(dealt + 7 * 60_000)
    expect(lobbyOf(gene).tables[0].settings.boardMinutes).toBe(7)

    // Turned off, it is gone; the guard knows the setting too
    await send(gene, { type: 'updateTableSettings', settings: { boardMinutes: 0 } })
    expect(tableFor(gene).boardEndsAt).toBeNull()
    expect(parseClientMessage(JSON.stringify({ type: 'createTable', invitees: [1] }))).toEqual({ error: 'badMessage' })
  })
})

describe('taking too long (e2-t28)', () => {
  it('tells who is waited on, and after a minute lets the host seat a robot instead', async () => {
    const gene = await member('gene')
    const amy = await member('amy')
    const bob = await member('bob')
    await send(gene, { type: 'createTable' })
    const tableId = tableFor(gene).id
    await send(amy, { type: 'sit', tableId, seat: 'W' })
    await send(bob, { type: 'sit', tableId, seat: 'E' })
    await send(gene, { type: 'addRobot', seat: 'N' })
    // Robots act until a person is to call
    await run('robot')
    const waiting = tableFor(gene).waiting!
    expect(waiting.since).toBe(time)
    const slow = waiting.seat
    const slowId = { S: gene, W: amy, E: bob, N: '' }[slow]
    const other = slow === 'W' ? 'E' : 'W'

    if (slow !== 'S') {
      await send(gene, { type: 'replaceWithRobot', seat: slow })
      expect(lastError(gene)).toBe('notSlow')
      time += SLOW_TURN_MS
      await send(slowId === amy ? bob : amy, { type: 'replaceWithRobot', seat: slow })
      expect(lastError(slowId === amy ? bob : amy)).toBe('hostOnly')
      await send(gene, { type: 'replaceWithRobot', seat: other })
      expect(lastError(gene)).toBe('notSlow')
      await send(gene, { type: 'replaceWithRobot', seat: slow, kind: 'gib' })
      expect(tableFor(gene).seats[slow]).toMatchObject({ robot: true, robotKind: 'gib' })
      expect(tableFor(slowId).mySeat).toBeNull()
    } else {
      // The host cannot replace themselves
      time += SLOW_TURN_MS
      await send(gene, { type: 'replaceWithRobot', seat: 'S' })
      expect(lastError(gene)).toBe('notSelf')
    }
  })
})

describe('the lobby (e2-t29, e2-t30)', () => {
  const t = (number: number, taken: number) => ({
    number,
    seats: { N: taken > 0 ? 'x' : null, E: taken > 1 ? 'x' : null, S: taken > 2 ? 'x' : null, W: taken > 3 ? 'x' : null },
  })

  it('puts tables short of players first, the closest to starting on top', () => {
    const tables = [t(1, 4), t(2, 1), t(3, 3), t(4, 3), t(5, 0)]
    expect(tables.sort(lobbyOrder).map((x) => [x.number, missingSeats(x)])).toEqual([
      [3, 1],
      [4, 1],
      [2, 3],
      [5, 4],
      [1, 0],
    ])
    expect(quickSeatChoice([t(1, 4), t(2, 2)])).toMatchObject({ table: { number: 2 }, seat: 'S' })
    expect(quickSeatChoice([t(1, 4)])).toBeNull()
  })

  it('sends the order to the browser', async () => {
    const gene = await member('gene')
    const amy = await member('amy')
    await send(gene, { type: 'createTable' })
    await send(amy, { type: 'createTable' })
    await send(amy, { type: 'addRobot', seat: 'N' })
    expect(lobbyOf(gene).tables.map((x) => x.number)).toEqual([2, 1])
  })

  it('quick seat sits at the table that most needs a player, or opens one', async () => {
    const gene = await member('gene')
    const amy = await member('amy')
    const bob = await member('bob')
    const cleo = await member('cleo')
    await send(gene, { type: 'createTable' })
    const lonely = tableFor(gene).id
    await send(amy, { type: 'createTable' })
    const nearly = tableFor(amy).id
    await send(amy, { type: 'addRobot', seat: 'N' })
    await send(amy, { type: 'addRobot', seat: 'E' })
    // An invite table never takes people who are not invited
    await send(cleo, { type: 'createTable', settings: { visibility: 'invite' } })
    await send(cleo, { type: 'addRobot', seat: 'N' })
    await send(cleo, { type: 'addRobot', seat: 'E' })

    await send(bob, { type: 'quickSeat' })
    expect(tableFor(bob)).toMatchObject({ id: nearly, mySeat: 'W' })
    // Seated at a full table now, quick seat moves them on to the table that still needs players
    await send(bob, { type: 'quickSeat' })
    expect(tableFor(bob).id).toBe(lonely)

    const dan = await member('dan')
    await send(gene, { type: 'addRobot', seat: 'E' })
    await send(gene, { type: 'addRobot', seat: 'W' })
    await send(dan, { type: 'quickSeat' })
    expect(tableFor(dan).id).toBe(nearly)
    const eve = await member('eve')
    await send(eve, { type: 'quickSeat' })
    expect(tableFor(eve).mySeat).toBe('S')
    expect(lobbyOf(eve).tables.find((x) => x.id === tableFor(eve).id)!.hostName).toBe('eve')
  })
})

describe('robot substitutes (e2-t31)', () => {
  async function tableOfTwo() {
    const gene = await member('gene')
    const amy = await member('amy')
    await send(gene, { type: 'createTable' })
    const tableId = tableFor(gene).id
    await send(amy, { type: 'sit', tableId, seat: 'N' })
    for (const seat of ['E', 'W'] as const) await send(gene, { type: 'addRobot', seat })
    return { gene, amy, tableId }
  }

  const goOffline = async (userId: string) => {
    connections.online.delete(userId)
    await club.disconnected(userId)
  }

  it('seat TKB for someone offline three minutes, marked, and hand the seat back when they return', async () => {
    const { gene, amy } = await tableOfTwo()
    await goOffline(amy)
    const job = queue.find((j) => j.kind === 'substitute')!
    expect(job.ms).toBe(SUBSTITUTE_MS)
    time += SUBSTITUTE_MS - 1000
    await run('substitute')
    // Too early: it waits for the rest
    expect(tableFor(gene).seats.N).toMatchObject({ id: amy })
    expect(queue.find((j) => j.kind === 'substitute')!.ms).toBe(1000)
    time += 1000
    await run('substitute')
    expect(tableFor(gene).seats.N).toMatchObject({ robot: true, substituteFor: 'amy' })

    await playOut(gene)
    const record = (await store.get<BoardRecord>(`board:${tableFor(gene).board!.recordId}`))!
    expect(Object.values(record.substitutes ?? {}).map((u) => u.username)).toEqual(['amy'])

    connections.online.add(amy)
    club.connected(amy)
    await tick()
    const seat = (['N', 'S'] as const).find((s) => tableFor(gene).seats[s]?.id === amy)
    expect(seat).toBeDefined()
    expect(tableFor(gene).seats.N?.substituteFor ?? tableFor(gene).seats.S?.substituteFor).toBeUndefined()
  })

  it('wait for nobody who came back in time, and sit in only while someone else seated is online', async () => {
    const { gene, amy } = await tableOfTwo()
    await goOffline(amy)
    connections.online.add(amy)
    club.connected(amy)
    time += SUBSTITUTE_MS
    await run('substitute')
    expect(tableFor(gene).seats.N).toMatchObject({ id: amy })

    await goOffline(amy)
    await goOffline(gene)
    time += SUBSTITUTE_MS
    await run('substitute')
    expect(club.tables.local(club.lobbyView(gene).tables[0].id)!.view(gene)!.seats.N).toMatchObject({ id: amy })
  })

  it('give the seat up for good when a person takes it', async () => {
    const { gene, amy, tableId } = await tableOfTwo()
    await goOffline(amy)
    time += SUBSTITUTE_MS
    await run('substitute')
    await playOut(gene)
    const bob = await member('bob')
    const robotSeat = (['N', 'S'] as const).find((s) => tableFor(gene).seats[s]?.substituteFor)!
    await send(bob, { type: 'sit', tableId, seat: robotSeat })
    connections.online.add(amy)
    club.connected(amy)
    await tick()
    expect(tableFor(gene).seats[robotSeat]).toMatchObject({ id: bob })
    expect(lobbyOf(amy).myTableId).toBeNull()
  })
})
