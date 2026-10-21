// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { SEATS, type Seat } from '../../shared/cards.ts'
import type { ClientMessage, ServerMessage, TableView } from '../../shared/protocol.ts'
import { ClubError, ClubService, type Connections } from '../../worker/service.ts'
import { MemoryStore } from '../../worker/store.ts'

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
}

let store: MemoryStore
let connections: FakeConnections
let club: ClubService
/** Robot moves wait here until a test runs them */
let robotQueue: (() => void)[]

async function setup(config: { maxUsers?: number; inviteCode?: string } = {}) {
  store = new MemoryStore()
  connections = new FakeConnections()
  robotQueue = []
  club = new ClubService(store, connections, {
    maxUsers: config.maxUsers ?? 10,
    inviteCode: config.inviteCode,
    schedule: (run) => robotQueue.push(run),
  })
  await club.load()
}

/** Runs scheduled robot moves until none are left (or a person has to act) */
async function runRobots(limit = 400) {
  for (let i = 0; i < limit && robotQueue.length; i++) {
    robotQueue.shift()!()
    // Each move is async; let it finish before the next
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

async function member(name: string) {
  const { user } = await club.register(name, 'secret1', '')
  connections.online.add(user.id)
  club.connected(user.id)
  return user.id
}

const send = (userId: string, message: ClientMessage) => club.handle(userId, message)
const tableFor = (userId: string) => connections.last(userId, 'table')!.table as TableView

/** Four members seated N E S W at one table */
async function fullTable() {
  const [n, e, s, w] = await Promise.all(['north', 'east', 'south', 'west'].map(member))
  await send(s, { type: 'createTable' })
  const tableId = tableFor(s).id
  await send(n, { type: 'sit', tableId, seat: 'N' })
  await send(e, { type: 'sit', tableId, seat: 'E' })
  await send(w, { type: 'sit', tableId, seat: 'W' })
  const bySeat: Record<Seat, string> = { N: n, E: e, S: s, W: w }
  return { tableId, bySeat }
}

beforeEach(() => setup())

describe('accounts', () => {
  it('registers, logs in and resolves sessions', async () => {
    const { user, token } = await club.register('Gene', 'secret1', '')
    expect(await club.userForToken(token)).toEqual(user)
    const again = await club.login('gene', 'secret1')
    expect(again.user).toEqual(user)
    await expect(club.login('gene', 'wrong')).rejects.toThrow('帳號或密碼錯誤')
    await club.logout(token)
    expect(await club.userForToken(token)).toBeNull()
  })

  it('stores a hash, never the password', async () => {
    await club.register('gene', 'secret1', '')
    expect(JSON.stringify([...store.data.values()])).not.toContain('secret1')
  })

  it('rejects duplicate names, bad names and short passwords', async () => {
    await club.register('gene', 'secret1', '')
    await expect(club.register('GENE', 'secret1', '')).rejects.toThrow('已經有人使用')
    await expect(club.register('a', 'secret1', '')).rejects.toThrow(ClubError)
    await expect(club.register('has space', 'secret1', '')).rejects.toThrow(ClubError)
    await expect(club.register('amy', '123', '')).rejects.toThrow('密碼至少')
  })

  it('caps the number of accounts and checks the invite code', async () => {
    await setup({ maxUsers: 2, inviteCode: 'tku' })
    await expect(club.register('amy', 'secret1', 'nope')).rejects.toThrow('邀請碼不正確')
    await club.register('amy', 'secret1', 'tku')
    await club.register('ben', 'secret1', 'tku')
    await expect(club.register('cat', 'secret1', 'tku')).rejects.toThrow('上限')
  })

  it('keeps accounts and tables across a reload', async () => {
    const { tableId } = await fullTable()
    const reloaded = new ClubService(store, connections, { maxUsers: 10 })
    await reloaded.load()
    expect((await reloaded.login('north', 'secret1')).user.username).toBe('north')
    expect(reloaded.lobbyView('x').tables.map((t) => t.id)).toEqual([tableId])
  })
})

describe('tables', () => {
  it('seats the creator in South and deals once four players sit', async () => {
    const gene = await member('gene')
    await send(gene, { type: 'createTable' })
    expect(tableFor(gene).mySeat).toBe('S')
    expect(tableFor(gene).board).toBeNull()

    await setup()
    const { bySeat } = await fullTable()
    const view = tableFor(bySeat.S)
    expect(view.board?.boardNo).toBe(1)
    expect(view.board?.turn).toBe('N')
  })

  it('shows lobby seats to everyone online', async () => {
    const { tableId } = await fullTable()
    const watcher = await member('watcher')
    const lobby = connections.last(watcher, 'lobby')!.lobby
    expect(lobby.tables).toHaveLength(1)
    expect(lobby.tables[0].id).toBe(tableId)
    expect(SEATS.map((s) => lobby.tables[0].seats[s]?.username)).toEqual(['north', 'east', 'south', 'west'])
  })

  it('refuses a taken seat', async () => {
    const { tableId } = await fullTable()
    const late = await member('late')
    await send(late, { type: 'sit', tableId, seat: 'N' })
    expect(connections.last(late, 'error')?.message).toBe('這個位子已經有人了')
  })

  it('closes a table when the last person leaves', async () => {
    const gene = await member('gene')
    await send(gene, { type: 'createTable' })
    await send(gene, { type: 'leaveTable' })
    expect(connections.last(gene, 'lobby')!.lobby.tables).toHaveLength(0)
    expect([...store.data.keys()].some((k) => k.startsWith('table:'))).toBe(false)
  })

  it('lets anyone free the seat of an offline player only', async () => {
    const { bySeat } = await fullTable()
    await send(bySeat.N, { type: 'freeSeat', seat: 'E' })
    expect(connections.last(bySeat.N, 'error')?.message).toBe('只能請離線的玩家離座')
    connections.online.delete(bySeat.E)
    await club.disconnected(bySeat.E)
    expect(tableFor(bySeat.N).seats.E?.online).toBe(false)
    await send(bySeat.N, { type: 'freeSeat', seat: 'E' })
    expect(tableFor(bySeat.N).seats.E).toBeNull()
  })
})

describe('what each player sees', () => {
  it('hides other hands until dummy goes down', async () => {
    const { bySeat } = await fullTable()
    const north = tableFor(bySeat.N).board!
    expect(Object.keys(north.hands)).toEqual(['N'])
    expect(north.handCounts).toEqual({ N: 13, E: 13, S: 13, W: 13 })
    expect(north.legalCalls).toContain('1C')
    expect(tableFor(bySeat.E).board!.legalCalls).toEqual([])

    // North opens 1♠ and South plays it: West leads, then everyone sees dummy (North)
    await send(bySeat.N, { type: 'call', call: '1S' })
    await send(bySeat.E, { type: 'call', call: 'P' })
    await send(bySeat.S, { type: 'call', call: 'P' })
    await send(bySeat.W, { type: 'call', call: 'P' })
    const lead = tableFor(bySeat.E).board!
    expect(lead.contract?.declarer).toBe('N')
    expect(lead.turn).toBe('E')
    await send(bySeat.E, { type: 'play', card: lead.legalCards[0] })
    expect(Object.keys(tableFor(bySeat.W).board!.hands).sort()).toEqual(['S', 'W'])
    expect(Object.keys(tableFor(bySeat.N).board!.hands).sort()).toEqual(['N', 'S'])
  })

  it('lets the declarer play dummy’s cards, and only then', async () => {
    const { bySeat } = await fullTable()
    for (const [seat, call] of [['N', 'P'], ['E', 'P'], ['S', '1N'], ['W', 'P'], ['N', 'P'], ['E', 'P']] as const)
      await send(bySeat[seat], { type: 'call', call })
    // South declares, West leads, North is dummy
    await send(bySeat.W, { type: 'play', card: tableFor(bySeat.W).board!.legalCards[0] })
    const south = tableFor(bySeat.S).board!
    expect(south.turn).toBe('N')
    expect(south.legalCards.length).toBeGreaterThan(0)
    expect(tableFor(bySeat.N).board!.legalCards).toEqual([])
    await send(bySeat.N, { type: 'play', card: south.legalCards[0] })
    expect(connections.last(bySeat.N, 'error')?.message).toBe('這不是你可以出的牌')
    await send(bySeat.S, { type: 'play', card: south.legalCards[0] })
    expect(tableFor(bySeat.S).board!.turn).toBe('E')
  })

  it('hides an alert from the alerter’s partner only', async () => {
    const { bySeat } = await fullTable()
    await send(bySeat.N, { type: 'call', call: '2C', alert: '強牌' })
    expect(tableFor(bySeat.E).board!.auction[0].alert).toBe('強牌')
    expect(tableFor(bySeat.S).board!.auction[0].alert).toBeUndefined()
  })
})

describe('finishing boards', () => {
  async function playPassedOut(bySeat: Record<Seat, string>) {
    for (const seat of ['N', 'E', 'S', 'W'] as const) await send(bySeat[seat], { type: 'call', call: 'P' })
  }

  it('records a finished board in everyone’s history and deals the next when all are ready', async () => {
    const { bySeat } = await fullTable()
    await playPassedOut(bySeat)
    const view = tableFor(bySeat.N)
    expect(view.board?.phase).toBe('finished')
    expect(view.board?.recordId).toBeTruthy()
    expect(Object.keys(view.board!.hands)).toHaveLength(4)

    const history = (await club.history(bySeat.E, false)).boards
    expect(history).toHaveLength(1)
    expect(history[0].players.S.username).toBe('south')
    const record = await club.record(history[0].id)
    expect(record?.board.hands.N).toHaveLength(13)
    expect((await club.history(await member('other'), false)).boards).toHaveLength(0)
    expect((await club.history('other', true)).boards).toHaveLength(1)

    for (const seat of ['N', 'E', 'S'] as const) await send(bySeat[seat], { type: 'ready' })
    expect(tableFor(bySeat.N).ready).toEqual(['N', 'E', 'S'])
    await send(bySeat.W, { type: 'ready' })
    const next = tableFor(bySeat.N)
    expect(next.board?.boardNo).toBe(2)
    expect(next.board?.dealer).toBe('E')
    expect(next.boardsPlayed).toBe(1)
  })

  it('undoes a call when an opponent agrees', async () => {
    const { bySeat } = await fullTable()
    await send(bySeat.N, { type: 'call', call: '1H' })
    await send(bySeat.E, { type: 'undoRequest' })
    expect(connections.last(bySeat.E, 'error')?.message).toBe('只能撤回自己剛做的動作')
    await send(bySeat.N, { type: 'undoRequest' })
    expect(tableFor(bySeat.E).board!.undo).toEqual({ seat: 'N' })
    await send(bySeat.S, { type: 'undoRespond', accept: true })
    expect(connections.last(bySeat.S, 'error')?.message).toBe('要由對手回應撤回')
    await send(bySeat.W, { type: 'undoRespond', accept: true })
    const view = tableFor(bySeat.N).board!
    expect(view.auction).toHaveLength(0)
    expect(view.turn).toBe('N')
  })

  it('keeps table chat', async () => {
    const { bySeat } = await fullTable()
    await send(bySeat.N, { type: 'chat', text: '  大家好  ' })
    expect(tableFor(bySeat.W).chat.map((m) => [m.username, m.text])).toEqual([['north', '大家好']])
  })
})

describe('dummy', () => {
  it('sees the declarer’s hand once the opening lead is made', async () => {
    const { bySeat } = await fullTable()
    for (const [seat, call] of [['N', '1S'], ['E', 'P'], ['S', 'P'], ['W', 'P']] as const)
      await send(bySeat[seat], { type: 'call', call })
    // North declares; South is dummy
    expect(Object.keys(tableFor(bySeat.S).board!.hands)).toEqual(['S'])
    await send(bySeat.E, { type: 'play', card: tableFor(bySeat.E).board!.legalCards[0] })
    expect(Object.keys(tableFor(bySeat.S).board!.hands).sort()).toEqual(['N', 'S'])
    // The defenders still see only their own hand and dummy
    expect(Object.keys(tableFor(bySeat.E).board!.hands).sort()).toEqual(['E', 'S'])
  })
})

describe('robots at the table', () => {
  it('fill empty seats and play a whole board with one person', async () => {
    const gene = await member('gene')
    await send(gene, { type: 'createTable' })
    for (const seat of ['N', 'E', 'W'] as const) await send(gene, { type: 'addRobot', seat })
    const view = tableFor(gene)
    expect(view.seats.N).toMatchObject({ username: 'Robot', robot: true, online: true })
    expect(view.board?.boardNo).toBe(1)

    // The person passes and plays the first legal card; robots do the rest
    for (let i = 0; i < 200 && tableFor(gene).board?.phase !== 'finished'; i++) {
      await runRobots()
      const board = tableFor(gene).board!
      if (board.legalCalls.length) await send(gene, { type: 'call', call: 'P' })
      else if (board.legalCards.length) await send(gene, { type: 'play', card: board.legalCards[0] })
      else if (board.claim || board.phase === 'finished') break
    }
    const done = tableFor(gene)
    expect(done.board?.phase).toBe('finished')
    expect(done.ready).toEqual(expect.arrayContaining(['N', 'E', 'W']))
    const history = (await club.history(gene, false)).boards
    expect(history).toHaveLength(1)
    expect(history[0].players.N).toMatchObject({ username: 'Robot', robot: true })

    // The person alone decides when to deal again
    await send(gene, { type: 'ready' })
    expect(tableFor(gene).board?.boardNo).toBe(2)
  })

  it('give their seat to a person who sits down, and close with the last person', async () => {
    const gene = await member('gene')
    const amy = await member('amy')
    await send(gene, { type: 'createTable' })
    const tableId = tableFor(gene).id
    await send(gene, { type: 'addRobot', seat: 'N' })
    await send(amy, { type: 'sit', tableId, seat: 'N' })
    expect(tableFor(amy).seats.N?.username).toBe('amy')
    await send(gene, { type: 'addRobot', seat: 'E' })
    await send(amy, { type: 'removeRobot', seat: 'E' })
    expect(tableFor(amy).seats.E).toBeNull()

    await send(gene, { type: 'addRobot', seat: 'E' })
    await send(amy, { type: 'leaveTable' })
    await send(gene, { type: 'leaveTable' })
    expect(connections.last(gene, 'lobby')!.lobby.tables).toHaveLength(0)
  })

  it('only seated players may add robots, and only to empty seats', async () => {
    const { tableId, bySeat } = await fullTable()
    const watcher = await member('watcher')
    await send(watcher, { type: 'joinTable', tableId })
    await send(watcher, { type: 'addRobot', seat: 'N' })
    expect(connections.last(watcher, 'error')?.code).toBe('notSeated')
    await send(bySeat.S, { type: 'addRobot', seat: 'N' })
    expect(connections.last(bySeat.S, 'error')?.code).toBe('seatTaken')
  })
})

describe('admin', () => {
  it('makes the first account admin, and only admins pass requireAdmin', async () => {
    const first = await club.register('first', 'secret1', '')
    const second = await club.register('second', 'secret1', '')
    expect(first.user.admin).toBe(true)
    expect(second.user.admin).toBe(false)
    expect(() => club.requireAdmin(second.user.id)).toThrow(ClubError)
    expect(() => club.requireAdmin(first.user.id)).not.toThrow()
  })

  it('lists, creates, resets, promotes and deletes members', async () => {
    const admin = (await club.register('admin', 'secret1', '')).user
    const amy = await club.adminCreateUser('amy', 'secret1')
    expect((await club.adminUsers()).map((u) => [u.username, u.admin])).toEqual([
      ['admin', true],
      ['amy', false],
    ])
    const { token } = await club.login('amy', 'secret1')
    await club.adminResetPassword(amy.id, 'newpass1')
    expect(await club.userForToken(token)).toBeNull()
    await expect(club.login('amy', 'secret1')).rejects.toThrow()
    await club.login('amy', 'newpass1')

    await club.adminSetAdmin(admin.id, amy.id, true)
    await club.adminSetAdmin(admin.id, amy.id, false)
    await expect(club.adminSetAdmin(admin.id, admin.id, false)).rejects.toThrow('至少要保留一位管理員')
    await expect(club.adminDeleteUser(admin.id, admin.id)).rejects.toThrow()
    await club.adminDeleteUser(admin.id, amy.id)
    expect((await club.adminUsers()).map((u) => u.username)).toEqual(['admin'])
  })

  it('changes the member limit and invite code at run time', async () => {
    await setup({ maxUsers: 10, inviteCode: 'env-code' })
    await club.register('admin', 'secret1', 'env-code')
    await club.adminUpdateSettings({ maxUsers: 2, inviteCode: 'new-code' })
    expect(club.clubSettings).toEqual({ maxUsers: 2, inviteCode: 'new-code' })
    await expect(club.register('amy', 'secret1', 'env-code')).rejects.toThrow('邀請碼不正確')
    await club.register('amy', 'secret1', 'new-code')
    await expect(club.register('ben', 'secret1', 'new-code')).rejects.toThrow('上限')
    await expect(club.adminUpdateSettings({ maxUsers: 1 })).rejects.toThrow(ClubError)
    // Settings survive a reload
    const reloaded = new ClubService(store, connections, { maxUsers: 10 })
    await reloaded.load()
    expect(reloaded.clubSettings.maxUsers).toBe(2)
  })

  it('lets members change their own password', async () => {
    const { user } = await club.register('gene', 'secret1', '')
    await expect(club.changePassword(user.id, 'wrong', 'newpass1')).rejects.toThrow('目前的密碼不正確')
    await club.changePassword(user.id, 'secret1', 'newpass1')
    await club.login('gene', 'newpass1')
  })
})

describe('history pages', () => {
  it('reads one page at a time, newest first, with a cursor', async () => {
    let time = 1_000
    const now = () => time
    store = new MemoryStore()
    connections = new FakeConnections()
    club = new ClubService(store, connections, { maxUsers: 10, now, schedule: () => undefined })
    await club.load()
    const { bySeat } = await fullTable()
    for (let board = 0; board < 55; board++) {
      time += 1000
      for (let i = 0; i < 4; i++) {
        const turn = tableFor(bySeat.N).board!.turn!
        await send(bySeat[turn], { type: 'call', call: 'P' })
      }
      for (const seat of ['N', 'E', 'S', 'W'] as const) await send(bySeat[seat], { type: 'ready' })
    }
    const first = await club.history(bySeat.N, false)
    expect(first.boards).toHaveLength(50)
    expect(first.boards[0].finishedAt).toBeGreaterThan(first.boards[49].finishedAt)
    const second = await club.history(bySeat.N, false, first.next!)
    expect(second.boards).toHaveLength(5)
    expect(second.next).toBeNull()
    expect(new Set([...first.boards, ...second.boards].map((b) => b.id)).size).toBe(55)
  })

  it('moves version-1 history into the new indexes', async () => {
    store = new MemoryStore()
    const old = { id: 'old1', tableNumber: 1, finishedAt: 5, players: {}, board: {} }
    for (const seat of ['N', 'E', 'S', 'W']) (old.players as Record<string, unknown>)[seat] = { id: 'u1', username: 'gene' }
    old.board = { boardNo: 1, dealer: 'N', vul: 'None', contract: null, result: { declarerTricks: 0, scoreNS: 0, claimed: false } }
    await store.put('board:00000000000005-old1', old)
    club = new ClubService(store, new FakeConnections(), { maxUsers: 10 })
    await club.load()
    expect((await club.record('old1'))?.id).toBe('old1')
    expect((await club.history('u1', false)).boards.map((b) => b.id)).toEqual(['old1'])
    expect(await store.get('board:00000000000005-old1')).toBeUndefined()
  })
})
