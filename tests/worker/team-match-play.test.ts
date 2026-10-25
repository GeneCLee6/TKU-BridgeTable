// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_HISTORY_QUERY } from '../../shared/history-query.ts'
import type { BoardRecord, ClientMessage, ServerMessage, TableView } from '../../shared/protocol.ts'
import { MATCH_SEATS, type MatchSeat, type Room } from '../../shared/team-match.ts'
import { teamBoardResult } from '../../shared/team-scoring.ts'
import { ClubService, type Connections, type ScheduleKind } from '../../worker/service.ts'
import type { MemoryStore } from '../../worker/store.ts'
import { HELD_BACK } from '../../worker/team-mode.ts'
import { memoryStore } from './sqlite.ts'

/**
 * A team match being played (F4, ARCHITECTURE.md §5.8): starting it (e8-t07), the two rooms each at
 * their own pace (e8-t08), what nobody may see of the other room (e8-t09), the live score (e8-t10),
 * the end (e8-t11) and its boards in the history (e8-t13). The tables run in the club's object here
 * (`LocalTables`); `table-objects.test.ts` runs the same in two table objects
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
  /** The table as the member's browser holds it */
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
  /** Every card a member's browser was ever sent, by seat */
  cardsSeen(userId: string): Set<string> {
    const seen = new Set<string>()
    for (const m of this.inbox.get(userId) ?? [])
      if (m.type === 'table' && m.table?.board)
        for (const cards of Object.values(m.table.board.hands)) for (const card of cards ?? []) seen.add(`${m.table.board.boardNo}:${card}`)
    return seen
  }
}

let store: MemoryStore
let connections: FakeConnections
let club: ClubService
let queue: { run: () => void; ms: number; kind: ScheduleKind }[]
let time: number
/** The founder, an admin */
let boss: string

beforeEach(async () => {
  store = memoryStore()
  connections = new FakeConnections()
  queue = []
  time = 1_000_000
  club = new ClubService(store, connections, { maxUsers: 40, now: () => time, schedule: (run, ms, kind) => queue.push({ run, ms, kind }) })
  await club.load()
  const founder = await club.register('boss', 'secret1', '')
  boss = 'user' in founder ? founder.user.id : ''
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
const view = (userId: string) => connections.table(userId)
const at = (room: Room, seat: MatchSeat['seat']): MatchSeat => ({ room, seat })

async function refused(userId: string, message: ClientMessage) {
  connections.inbox.set(userId, [])
  await send(userId, message)
  return connections.last(userId, 'error')?.code
}

/**
 * Amy hosts (team A, open room South) a match of `boards` boards; each member given takes the seat
 * given, the other seats get robots
 */
async function match({ boards = 4, seats = {} as Record<string, MatchSeat>, scoring = 'imp' as 'imp' | 'bam' } = {}) {
  const amy = await member('amy')
  const { id } = club.matches.create(amy, { settings: { boards, scoring } })
  const people: Record<string, string> = { amy }
  for (const [name, seat] of Object.entries(seats)) {
    const userId = await member(name)
    people[name] = userId
    await club.matches.act(amy, { type: 'matchInvite', matchId: id, ...seat, userId })
    await club.matches.act(userId, { type: 'matchAnswer', matchId: id, accept: true })
  }
  const taken = [at('open', 'S'), ...Object.values(seats)]
  for (const s of MATCH_SEATS)
    if (!taken.some((t) => t.room === s.room && t.seat === s.seat)) await club.matches.act(amy, { type: 'matchRobot', matchId: id, ...s })
  return { id, amy, people }
}

const matchOf = (id: string, userId: string) => club.matches.get(id, userId)!
const tableIdOf = (id: string, room: Room) => club.matches.store.get(id)!.tables![room]
const tableState = (tableId: string) => club.localTable(tableId)?.state ?? null

/**
 * Plays on until `done`: the members given pass when it is their call and play their first legal
 * card (dummy's too when declaring), robots move, and the next board is dealt when its time comes
 */
async function playUntil(people: string[], done: () => boolean, limit = 6000) {
  for (let i = 0; i < limit; i++) {
    if (done()) return
    let acted = false
    for (const userId of people) {
      const board = view(userId)?.board
      if (!board || board.phase === 'finished') continue
      if (board.legalCalls.length) await send(userId, { type: 'call', call: 'P' })
      else if (board.legalCards.length) await send(userId, { type: 'play', card: board.legalCards[0] })
      else continue
      acted = true
    }
    if (acted) continue
    const index = queue.findIndex((job) => job.kind === 'robot')
    if (index >= 0) {
      queue.splice(index, 1)[0].run()
      await tick()
      continue
    }
    const deals = queue.filter((job) => job.kind === 'deal')
    if (!deals.length) throw new Error('nothing left to run')
    queue = queue.filter((job) => job.kind !== 'deal')
    time += Math.max(0, ...deals.map((job) => job.ms))
    for (const job of deals) job.run()
    await tick()
  }
  throw new Error('did not get there')
}

const played = (tableId: string) => tableState(tableId)?.boardsPlayed ?? 0

describe('starting a team match (e8-t07)', () => {
  it('lets only the host start, only when ready, and opens both rooms on the same boards at once', async () => {
    const { id, amy, people } = await match({ seats: { ben: at('closed', 'S') } })
    const { ben } = people
    expect(await refused(ben, { type: 'startMatch', matchId: id })).toBe('matchHostOnly')
    connections.online.delete(ben)
    expect(await refused(amy, { type: 'startMatch', matchId: id })).toBe('matchNotReady')
    connections.online.add(ben)

    // Amy was at a casual table: starting takes her from it
    await send(amy, { type: 'createTable' })
    const casual = club.lobbyView(amy).myTableId!
    await send(amy, { type: 'startMatch', matchId: id })
    expect(club.localTable(casual)).toBeUndefined()

    const started = matchOf(id, amy)
    expect(started.status).toBe('playing')
    expect(started.startedAt).toBe(time)
    const open = tableIdOf(id, 'open')
    const closed = tableIdOf(id, 'closed')
    expect(club.lobbyView(amy).myTableId).toBe(open)
    expect(club.lobbyView(ben).myTableId).toBe(closed)
    // Both rooms deal board 1 of the same set: the same hands, dealer and vulnerability
    const a = tableState(open)!
    const b = tableState(closed)!
    expect(a.board?.boardNo).toBe(1)
    expect(b.board?.boardNo).toBe(1)
    expect(a.board?.hands).toEqual(b.board?.hands)
    expect([a.board?.dealer, a.board?.vul]).toEqual([b.board?.dealer, b.board?.vul])
    // Seats as the match has them: team A North-South in the open room, East-West in the closed room
    expect(a.seats.S).toBe(amy)
    expect(b.seats.S).toBe(ben)
    expect(a.seats.N).toBe('robot:gib:N')
    // The table says which match, room and board; nobody can take anything back
    expect(view(amy)?.match).toEqual({ id, room: 'open', seq: 1, boards: 4, played: 0, over: false })
    expect(view(ben)?.match?.room).toBe('closed')
    expect(view(amy)?.board?.canUndo).toBe(false)
    expect((await club.notifications.view(ben)).items[0]).toMatchObject({ kind: 'matchStarted', params: { matchId: id, username: 'amy' } })
    // Not twice
    expect(await refused(amy, { type: 'startMatch', matchId: id })).toBe('matchStarted')
  })

  it('starts over HTTP too, and keeps anyone from playing two matches at once', async () => {
    const { id, amy, people } = await match({ seats: { ben: at('closed', 'S') } })
    const { id: second } = club.matches.create(people.ben, {})
    for (const s of MATCH_SEATS)
      if (!(s.room === 'open' && s.seat === 'S')) await club.matches.act(people.ben, { type: 'matchRobot', matchId: second, ...s })
    const started = await club.startMatchRequest(amy, id)
    expect(started?.status).toBe('playing')
    // Ben is playing in Amy's match: his own cannot start until it ends
    expect(await refused(people.ben, { type: 'startMatch', matchId: second })).toBe('matchPlayerBusy')
    expect(club.matches.get(second, people.ben)?.status).toBe('setup')
  })

  it('lists the match in the lobby, not its tables, and shows the tables as rooms with no number', async () => {
    const { id, amy, people } = await match({ seats: { ben: at('closed', 'S') } })
    const cat = await member('cat')
    await send(amy, { type: 'startMatch', matchId: id })
    const lobby = club.lobbyView(cat)
    expect(lobby.tables).toEqual([])
    expect(lobby.matches).toEqual([{ id, teamNames: ['', ''], tables: { open: tableIdOf(id, 'open'), closed: tableIdOf(id, 'closed') } }])
    expect(lobby.members.find((m) => m.id === people.ben)?.tableNumber).toBeNull()
  })
})

describe('the two rooms (e8-t08) and what nobody may see of the other (e8-t09)', () => {
  it('keeps each player in their own room: no other table, no watching the other room, no leaving the seat', async () => {
    const { id, amy, people } = await match({ seats: { ben: at('closed', 'S'), bea: at('closed', 'E') } })
    const { ben, bea } = people
    await send(amy, { type: 'startMatch', matchId: id })
    const open = tableIdOf(id, 'open')
    const closed = tableIdOf(id, 'closed')
    // Bea is team A in the closed room: not even her own team's open room
    expect(await refused(bea, { type: 'joinTable', tableId: open })).toBe('matchOtherRoom')
    expect(await refused(ben, { type: 'joinTable', tableId: open })).toBe('matchOtherRoom')
    expect(await refused(ben, { type: 'sit', tableId: open, seat: 'N' })).toBe('matchOtherRoom')
    expect(await refused(ben, { type: 'createTable' })).toBe('inMatch')
    expect(await refused(ben, { type: 'quickSeat' })).toBe('inMatch')
    expect(await refused(ben, { type: 'createPractice', settings: {} } as unknown as ClientMessage)).toBe('inMatch')
    // The table checks it again on its own, whatever the club let through
    await expect(club.localTable(open)!.join({ id: ben, username: 'ben', blocked: [] })).rejects.toMatchObject({ code: 'matchOtherRoom' })
    await expect(club.localTable(open)!.sit({ id: bea, username: 'bea', blocked: [] }, 'N')).rejects.toMatchObject({
      code: 'matchOtherRoom',
    })
    // Seats are the match's
    expect(await refused(ben, { type: 'sit', tableId: closed, seat: 'N' })).toBe('matchTableFixed')
    expect(await refused(ben, { type: 'stand' })).toBe('matchTableFixed')
    expect(await refused(ben, { type: 'addRobot', seat: 'N' })).toBe('matchTableFixed')
    expect(await refused(ben, { type: 'undoRequest' })).toBe('matchNoUndo')
    // Going to another page keeps the seat
    await send(ben, { type: 'leaveTable' })
    expect(tableState(closed)?.seats.S).toBe(ben)
    expect(club.lobbyView(ben).myTableId).toBe(closed)
    // Nobody else may take a seat either
    const cat = await member('cat')
    expect(await refused(cat, { type: 'sit', tableId: closed, seat: 'N' })).toBe('matchTableFixed')
  })

  it('lets others watch both rooms, and keeps the watchers’ chat from the players', async () => {
    const { id, amy, people } = await match({ seats: { ben: at('closed', 'S') } })
    const cat = await member('cat')
    const dan = await member('dan')
    await send(amy, { type: 'startMatch', matchId: id })
    const open = tableIdOf(id, 'open')
    await send(cat, { type: 'joinTable', tableId: open })
    await send(dan, { type: 'joinTable', tableId: open })
    // Watchers see all four hands, as kibitzers do; the player only their own
    expect(Object.keys(view(cat)!.board!.hands)).toHaveLength(4)
    expect(Object.keys(view(amy)!.board!.hands)).toEqual(['S'])
    await send(cat, { type: 'chat', text: 'they went down in the other room' })
    await send(amy, { type: 'chat', text: 'good luck' })
    expect(view(amy)!.chat.map((c) => c.text)).toEqual(['good luck'])
    expect(view(dan)!.chat.map((c) => c.text)).toEqual(['they went down in the other room', 'good luck'])
    expect(view(dan)!.chat[0].kibitz).toBe(true)
    // Not filtered in the browser: the players' sockets never carry it
    expect(JSON.stringify(connections.inbox.get(amy))).not.toContain('they went down')
    // A watcher may follow the other room too
    await send(cat, { type: 'joinTable', tableId: tableIdOf(id, 'closed') })
    expect(club.lobbyView(cat).myTableId).toBe(tableIdOf(id, 'closed'))
    expect(club.localTable(tableIdOf(id, 'closed'))!.state!.seats.S).toBe(people.ben)
  })

  it('plays each room at its own pace, and holds a board back until both rooms played it', async () => {
    const { id, amy, people } = await match({ boards: 4, seats: { ben: at('closed', 'S') } })
    const { ben } = people
    const cat = await member('cat')
    await send(amy, { type: 'startMatch', matchId: id })
    const open = tableIdOf(id, 'open')
    const closed = tableIdOf(id, 'closed')

    // The open room plays board 1 and goes on to board 2 without waiting
    await playUntil([amy], () => played(open) === 1)
    const first = tableState(open)!.recent![0]
    const record = (await store.get<BoardRecord>(`board:${first.id}`))!
    expect(record).toMatchObject({ mode: 'team', eventId: id, room: 'open', revealAt: HELD_BACK })
    expect(record.board.boardNo).toBe(1)
    await playUntil([amy], () => tableState(open)?.board?.boardNo === 2)

    // Nobody but its four players sees the board yet: not the other room, not a club member
    expect(await club.record(first.id, amy)).not.toBeNull()
    expect(await club.record(first.id, ben)).toBeNull()
    expect(await club.record(first.id, cat)).toBeNull()
    const all = { ...DEFAULT_HISTORY_QUERY, scope: 'all' as const }
    expect((await club.search(ben, all)).boards.map((b) => b.id)).not.toContain(first.id)
    expect((await club.search(cat, all)).boards.map((b) => b.id)).not.toContain(first.id)
    expect((await club.history(ben, true)).boards.map((b) => b.id)).not.toContain(first.id)
    // The match shows no score for a board one room played, to anyone
    for (const userId of [amy, ben, cat]) expect(matchOf(id, userId).boards).toEqual([])
    expect(connections.last(ben, 'match')?.match?.boards).toEqual([])
    // Ben's browser never got a card of board 1 beyond his own hand
    const benTable = view(ben)!
    expect(Object.keys(benTable.board!.hands)).toEqual(['S'])
    expect(benTable.recent).toEqual([])
    const southOfBoard1 = tableState(closed)!.board!.hands.S
    expect([...connections.cardsSeen(ben)].filter((c) => c.startsWith('1:')).sort()).toEqual(southOfBoard1.map((c) => `1:${c}`).sort())

    // The closed room plays board 1: both records are shown to everyone, and the score goes out
    await playUntil([ben], () => played(closed) === 1)
    const second = tableState(closed)!.recent![0]
    for (const boardId of [first.id, second.id]) {
      expect(await club.record(boardId, cat)).toMatchObject({ revealAt: time })
      expect((await club.search(cat, all)).boards.map((b) => b.id)).toContain(boardId)
    }
    const scored = matchOf(id, cat)
    expect(scored.boards).toHaveLength(1)
    expect(scored.boards[0]).toMatchObject({
      seq: 1,
      open: { boardId: first.id, scoreNS: first.result.scoreNS },
      closed: { boardId: second.id, scoreNS: second.result.scoreNS },
    })
    const expected = teamBoardResult('imp', { open: first.result.scoreNS, closed: second.result.scoreNS })!
    expect(scored.boards[0].result).toEqual(expected)
    expect(scored.totals).toEqual({ A: expected.A, B: expected.B })
    // Pushed live to both players and to whoever watches a table
    expect(connections.last(amy, 'match')?.match?.boards).toHaveLength(1)
    expect(connections.last(ben, 'match')?.match?.boards).toHaveLength(1)
  })

  it('keeps a board one room played out of favourites and profiles, and its traveller from everyone', async () => {
    const { id, amy, people } = await match({ boards: 4, seats: { ben: at('closed', 'S') } })
    const { ben } = people
    const cat = await member('cat')
    await send(amy, { type: 'startMatch', matchId: id })
    const open = tableIdOf(id, 'open')
    await playUntil([amy], () => played(open) === 1)
    const held = tableState(open)!.recent![0].id
    for (const userId of [ben, cat]) {
      await expect(club.favorite(userId, held)).rejects.toMatchObject({ code: 'boardGone' })
      expect((await club.memberProfile(userId, amy)).recent.map((b) => b.id)).not.toContain(held)
      expect(await club.traveller(held, userId)).toBeNull()
    }
    // Its own player may keep it
    expect((await club.favorite(amy, held)).favorite).toBeNull()
    // The other room's table never lists it, to its player or its watchers
    await send(cat, { type: 'joinTable', tableId: tableIdOf(id, 'closed') })
    for (const userId of [ben, cat]) expect(view(userId)!.recent).toEqual([])
    expect(JSON.stringify(connections.inbox.get(ben))).not.toContain(held)
  })

  it('pushes the score to the watchers of either room', async () => {
    const { id, amy, people } = await match({ boards: 4, seats: { ben: at('closed', 'S') } })
    const cat = await member('cat')
    await send(amy, { type: 'startMatch', matchId: id })
    await send(cat, { type: 'joinTable', tableId: tableIdOf(id, 'closed') })
    await playUntil([amy, people.ben], () => played(tableIdOf(id, 'open')) >= 1 && played(tableIdOf(id, 'closed')) >= 1)
    expect(connections.last(cat, 'match')?.match?.boards.length).toBeGreaterThanOrEqual(1)
  })
})

describe('the end of a match (e8-t11) and its boards in the history (e8-t13)', () => {
  it('waits at the last board for the other room, then finishes, tells everyone and shows every board', async () => {
    const { id, amy, people } = await match({ boards: 4, seats: { ben: at('closed', 'S') } })
    const { ben } = people
    const cat = await member('cat')
    await send(amy, { type: 'startMatch', matchId: id })
    const open = tableIdOf(id, 'open')
    const closed = tableIdOf(id, 'closed')

    // The open room plays all four: its last result stays on the table, nothing more is dealt
    await playUntil([amy], () => played(open) === 4)
    await tick()
    expect(view(amy)?.match).toMatchObject({ seq: 4, played: 4, over: true })
    expect(view(amy)?.dealAt).toBeNull()
    expect(queue.some((job) => job.kind === 'deal' && tableState(open)?.board?.boardNo !== 4)).toBe(false)
    expect(matchOf(id, amy).status).toBe('playing')

    // The closed room catches up: the match is over
    await playUntil([ben], () => played(closed) === 4)
    const done = matchOf(id, cat)
    expect(done.status).toBe('finished')
    expect(done.endedAt).toBe(time)
    expect(done.boards.map((b) => b.seq)).toEqual([1, 2, 3, 4])
    expect(done.totals.A + done.totals.B).toBe(done.boards.reduce((sum, b) => sum + b.result.A + b.result.B, 0))
    for (const userId of [amy, ben])
      expect((await club.notifications.view(userId)).items[0]).toMatchObject({ kind: 'matchFinished', params: { matchId: id } })
    expect(club.lobbyView(cat).matches).toEqual([])

    // Every board is in the history, as a team match board with its room, for anyone to filter
    const team = await club.search(cat, { ...DEFAULT_HISTORY_QUERY, scope: 'all', mode: 'team' })
    expect(team.boards).toHaveLength(8)
    expect(team.boards.every((b) => b.mode === 'team' && b.eventId === id)).toBe(true)
    expect(team.boards.filter((b) => b.room === 'open')).toHaveLength(4)
    expect((await club.search(cat, { ...DEFAULT_HISTORY_QUERY, scope: 'all', mode: 'casual' })).boards).toEqual([])

    // The tables are ordinary from now on: Amy may leave, and her table closes with her
    await send(amy, { type: 'leaveTable' })
    expect(club.lobbyView(amy).myTableId).toBeNull()
    expect(club.localTable(open)).toBeUndefined()
    await send(ben, { type: 'createTable' })
    expect(club.lobbyView(ben).myTableId).not.toBe(closed)
  })

  it('plays a room of robots alone, and closes it when the match ends', async () => {
    const { id, amy } = await match({ boards: 4, seats: {} })
    await send(amy, { type: 'startMatch', matchId: id })
    const open = tableIdOf(id, 'open')
    const closed = tableIdOf(id, 'closed')
    expect(tableState(closed)?.board?.boardNo).toBe(1)
    await playUntil([amy], () => matchOf(id, amy).status === 'finished')
    expect(club.localTable(closed)).toBeUndefined()
    expect(club.localTable(open)).toBeDefined()
    expect(matchOf(id, amy).boards).toHaveLength(4)
  })

  it('writes each room’s result once, and ignores one for a match no longer played', async () => {
    const { id, amy } = await match({ boards: 4, seats: {} })
    await send(amy, { type: 'startMatch', matchId: id })
    const result = { boardId: 'x1', scoreNS: 420, playedAt: time }
    expect(club.matches.addResult(id, 1, 'open', result)).toEqual({ reveal: [], finished: false })
    expect(club.matches.addResult(id, 1, 'open', { ...result, boardId: 'x2' })).toBeNull()
    expect(club.matches.addResult(id, 9, 'open', result)).toBeNull()
    expect(club.matches.addResult(id, 1, 'closed', { ...result, boardId: 'y1' })).toEqual({ reveal: ['x1', 'y1'], finished: false })
    expect(club.matches.store.get(id)!.boards[0]).toMatchObject({ open: { boardId: 'x1' }, closed: { boardId: 'y1' } })
  })

  it('hands a deleted player’s seat to a robot, and the room plays on', async () => {
    const { id, amy, people } = await match({ boards: 4, seats: { ben: at('closed', 'S') } })
    await send(amy, { type: 'startMatch', matchId: id })
    const closed = tableIdOf(id, 'closed')
    await club.adminDeleteUser(boss, people.ben)
    expect(tableState(closed)?.seats.S).toBe('robot:gib:S')
    await playUntil([amy], () => matchOf(id, amy).status === 'finished')
  })
})
