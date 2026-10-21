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
  last<T extends ServerMessage['type']>(userId: string, type: T) {
    return (this.inbox.get(userId) ?? []).findLast((m) => m.type === type) as
      | Extract<ServerMessage, { type: T }>
      | undefined
  }
}

let store: MemoryStore
let connections: FakeConnections
let club: ClubService

async function setup(config: { maxUsers?: number; inviteCode?: string } = {}) {
  store = new MemoryStore()
  connections = new FakeConnections()
  club = new ClubService(store, connections, { maxUsers: config.maxUsers ?? 10, inviteCode: config.inviteCode })
  await club.load()
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

    const history = await club.history(bySeat.E, false)
    expect(history).toHaveLength(1)
    expect(history[0].players.S.username).toBe('south')
    const record = await club.record(history[0].id)
    expect(record?.board.hands.N).toHaveLength(13)
    expect(await club.history(await member('other'), false)).toHaveLength(0)
    expect(await club.history('other', true)).toHaveLength(1)

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
