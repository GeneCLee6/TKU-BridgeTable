// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { deal } from '../../shared/board.ts'
import { SEATS, type Seat } from '../../shared/cards.ts'
import { DEAL_COUNTDOWN_MS, LAST_TRICK_MS, type ClientMessage, type ServerMessage, type TableView } from '../../shared/protocol.ts'
import { ClubError, ClubService, type Connections, type ScheduleKind } from '../../worker/service.ts'
import type { MemoryStore } from '../../worker/store.ts'
import { memoryStore } from './sqlite.ts'
import type { Table } from '../../worker/views.ts'

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
  /** The table as the browser holds it: chat and recent boards carry over when left out */
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
/** Robot moves and the next deal wait here until a test runs them */
let queue: { run: () => void; ms: number; kind: ScheduleKind }[]
let time: number

async function setup(config: { maxUsers?: number; inviteCode?: string } = {}) {
  store = memoryStore()
  connections = new FakeConnections()
  queue = []
  time = 1_000_000
  club = new ClubService(store, connections, {
    maxUsers: config.maxUsers ?? 10,
    inviteCode: config.inviteCode,
    now: () => time,
    schedule: (run, ms, kind) => queue.push({ run, ms, kind }),
  })
  await club.load()
}

const isDeal = (job: { kind: ScheduleKind }) => job.kind === 'deal'

/** Runs scheduled robot moves until none are left (or a person has to act) */
async function runRobots(limit = 400) {
  for (let i = 0; i < limit; i++) {
    const index = queue.findIndex((job) => !isDeal(job))
    if (index < 0) return
    queue.splice(index, 1)[0].run()
    // Each move is async; let it finish before the next
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

/** Lets the pause after a finished board run out, so the next board is dealt */
async function dealNext() {
  const deals = queue.filter(isDeal)
  queue = queue.filter((job) => !isDeal(job))
  time += Math.max(0, ...deals.map((job) => job.ms))
  for (const job of deals) job.run()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/** The first account, which becomes the admin and signs in at once */
async function founder(name = 'gene', inviteCode = '') {
  const result = await club.register(name, 'secret1', inviteCode)
  if (!('user' in result)) throw new Error('the first account should sign in at once')
  return result
}

/** Registers and, past the first account, approves the application as an admin would */
async function join(name: string, inviteCode = '') {
  const result = await club.register(name, 'secret1', inviteCode)
  if ('user' in result) return result.user
  const application = club.adminApplications().find((a) => a.username === name)!
  return club.adminApprove(application.id)
}

async function member(name: string) {
  const user = await join(name)
  connections.online.add(user.id)
  club.connected(user.id)
  return user.id
}

const send = (userId: string, message: ClientMessage) => club.handle(userId, message)
const tableFor = (userId: string) => connections.table(userId)!

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
    const { user, token } = await founder('Gene')
    expect(await club.userForToken(token)).toEqual(user)
    const again = await club.login('gene', 'secret1')
    expect(again.user).toEqual(user)
    await expect(club.login('gene', 'wrong')).rejects.toThrow('帳號或密碼錯誤')
    await club.logout(token)
    expect(await club.userForToken(token)).toBeNull()
  })

  it('stores a hash, never the password', async () => {
    await club.register('gene', 'secret1', '')
    // Applications too
    await club.register('amy', 'secret1', '')
    expect(JSON.stringify([...store.data.values()])).not.toContain('secret1')
  })

  it('rejects duplicate names, bad names and short passwords', async () => {
    await founder('gene')
    await expect(club.register('GENE', 'secret1', '')).rejects.toThrow('已經有人使用')
    await expect(club.register('a', 'secret1', '')).rejects.toThrow(ClubError)
    await expect(club.register('has space', 'secret1', '')).rejects.toThrow(ClubError)
    await expect(club.register('amy', '123', '')).rejects.toThrow('密碼至少')
    // A name waiting for approval is taken too
    await club.register('amy', 'secret1', '')
    await expect(club.register('Amy', 'secret1', '')).rejects.toThrow('已經有人使用')
  })

  it('caps the number of accounts and checks the invite code', async () => {
    await setup({ maxUsers: 2, inviteCode: 'tku' })
    await expect(club.register('amy', 'secret1', 'nope')).rejects.toThrow('邀請碼不正確')
    await founder('amy', 'tku')
    await join('ben', 'tku')
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

  it('lets only the host ask a player to leave a seat or add robots', async () => {
    const { bySeat } = await fullTable()
    // South opened the table
    expect(tableFor(bySeat.N).hostId).toBe(bySeat.S)
    await send(bySeat.N, { type: 'kick', seat: 'E' })
    expect(connections.last(bySeat.N, 'error')?.message).toBe('只有房主可以這樣做')
    await send(bySeat.S, { type: 'kick', seat: 'E' })
    const view = tableFor(bySeat.E)
    expect(view.seats.E).toBeNull()
    expect(view.mySeat).toBeNull()
    expect(view.spectators.map((u) => u.username)).toEqual(['east'])
    await send(bySeat.N, { type: 'addRobot', seat: 'E' })
    expect(connections.last(bySeat.N, 'error')?.message).toBe('只有房主可以這樣做')
    await send(bySeat.S, { type: 'addRobot', seat: 'E' })
    expect(tableFor(bySeat.N).seats.E?.robot).toBe(true)
  })

  it('hands the table to someone else when the host leaves or drops offline', async () => {
    const { bySeat } = await fullTable()
    connections.online.delete(bySeat.S)
    await club.disconnected(bySeat.S)
    expect(tableFor(bySeat.N).hostId).toBe(bySeat.N)
    await send(bySeat.N, { type: 'leaveTable' })
    expect(tableFor(bySeat.E).hostId).toBe(bySeat.E)
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

  it('records a finished board in everyone’s history and deals the next by itself', async () => {
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

    // Nobody presses anything: the result shows for a moment, then the next board is dealt
    expect(queue.filter(isDeal)).toHaveLength(1)
    expect(tableFor(bySeat.N).board?.boardNo).toBe(1)
    await dealNext()
    const next = tableFor(bySeat.N)
    expect(next.board?.boardNo).toBe(2)
    expect(next.board?.dealer).toBe('E')
    expect(next.boardsPlayed).toBe(1)
  })

  it('waits for an empty seat to be filled before dealing again', async () => {
    const { tableId, bySeat } = await fullTable()
    await playPassedOut(bySeat)
    await send(bySeat.W, { type: 'stand' })
    await dealNext()
    expect(tableFor(bySeat.N).board?.phase).toBe('finished')
    await send(bySeat.W, { type: 'sit', tableId, seat: 'W' })
    await dealNext()
    expect(tableFor(bySeat.N).board?.boardNo).toBe(2)
  })

  it('undoes a call when an opponent agrees', async () => {
    const { bySeat } = await fullTable()
    await send(bySeat.N, { type: 'call', call: '1H' })
    expect(tableFor(bySeat.E).board!.canUndo).toBe(false)
    await send(bySeat.E, { type: 'undoRequest' })
    expect(connections.last(bySeat.E, 'error')?.message).toBe('沒有可以撤回的動作')
    expect(tableFor(bySeat.N).board!.canUndo).toBe(true)
    await send(bySeat.N, { type: 'undoRequest' })
    expect(tableFor(bySeat.E).board!.undo).toEqual({ seat: 'N' })
    await send(bySeat.S, { type: 'undoRespond', accept: true })
    expect(connections.last(bySeat.S, 'error')?.message).toBe('要由對手回應撤回')
    await send(bySeat.W, { type: 'undoRespond', accept: true })
    const view = tableFor(bySeat.N).board!
    expect(view.auction).toHaveLength(0)
    expect(view.turn).toBe('N')
  })

  it('takes back everything since your own last call, as on BBO', async () => {
    const { bySeat } = await fullTable()
    for (const [seat, call] of [['N', '1H'], ['E', 'P'], ['S', '2H']] as const) await send(bySeat[seat], { type: 'call', call })
    // North may still undo after the others have called
    expect(tableFor(bySeat.N).board!.canUndo).toBe(true)
    await send(bySeat.N, { type: 'undoRequest' })
    await send(bySeat.E, { type: 'undoRespond', accept: true })
    expect(tableFor(bySeat.N).board!.auction).toHaveLength(0)
    expect(tableFor(bySeat.N).board!.turn).toBe('N')
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
    const history = (await club.history(gene, false)).boards
    expect(history).toHaveLength(1)
    // Gene sat South, or North if moved into a robot partner's declaring seat
    const players = Object.values(history[0].players)
    expect(players.filter((p) => p.robot)).toHaveLength(3)
    expect(players.filter((p) => p.username === 'gene')).toHaveLength(1)
    expect(['N', 'S']).toContain(SEATS.find((s) => history[0].players[s].username === 'gene'))

    // The next board comes by itself
    await dealNext()
    expect(tableFor(gene).board?.boardNo).toBe(2)
  })

  it('accept a person’s claim the cards allow, such as a concession', async () => {
    const gene = await member('gene')
    await send(gene, { type: 'createTable' })
    for (const seat of ['N', 'E', 'W'] as const) await send(gene, { type: 'addRobot', seat })
    for (let i = 0; i < 40 && tableFor(gene).board?.phase !== 'play'; i++) {
      await runRobots()
      const board = tableFor(gene).board!
      if (board.legalCalls.length) await send(gene, { type: 'call', call: 'P' })
      else if (board.phase === 'finished') await dealNext()
    }
    expect(tableFor(gene).board!.canClaim).toBe(true)
    await send(gene, { type: 'claim', tricks: 0 })
    await runRobots()
    expect(tableFor(gene).board!.phase).toBe('finished')
    expect(tableFor(gene).board!.result?.claimed).toBe(true)
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
    expect(connections.last(amy, 'error')?.code).toBe('hostOnly')
    await send(gene, { type: 'removeRobot', seat: 'E' })
    expect(tableFor(amy).seats.E).toBeNull()

    await send(gene, { type: 'addRobot', seat: 'E' })
    await send(amy, { type: 'leaveTable' })
    await send(gene, { type: 'leaveTable' })
    expect(connections.last(gene, 'lobby')!.lobby.tables).toHaveLength(0)
  })

  it('come in two kinds: the club’s robot by default, or the 2/1 robot (GIB-compatible)', async () => {
    const gene = await member('gene')
    await send(gene, { type: 'createTable' })
    await send(gene, { type: 'addRobot', seat: 'N', kind: 'gib' })
    await send(gene, { type: 'addRobot', seat: 'E' })
    await send(gene, { type: 'addRobot', seat: 'W', kind: 'nobody' as never })
    expect(connections.last(gene, 'error')?.code).toBe('unknownRobot')
    await send(gene, { type: 'addRobot', seat: 'W', kind: 'gib' })
    const view = tableFor(gene)
    expect(view.seats.N).toMatchObject({ robot: true, robotKind: 'gib' })
    expect(view.seats.E).toMatchObject({ robot: true, robotKind: 'tku' })

    // The 2/1 robots' calls carry what they show; the club's robot has its own words only
    for (let i = 0; i < 200 && tableFor(gene).board?.phase === 'auction'; i++) {
      await runRobots()
      if (tableFor(gene).board!.legalCalls.length) await send(gene, { type: 'call', call: 'P' })
    }
    const auction = tableFor(gene).board!.auction
    for (const entry of auction) {
      if (entry.call === 'P' || !entry.robot) continue
      if (entry.seat === 'E') expect(entry.meaning).toBeUndefined()
      else if (entry.seat === 'N' || entry.seat === 'W') expect(entry.meaning).toBeDefined()
    }
  })

  it('opens with the settings chosen, and only the host may change them', async () => {
    const gene = await member('gene')
    const amy = await member('amy')
    await send(gene, { type: 'createTable' })
    expect(tableFor(gene).settings).toEqual({ visibility: 'public', allowKibitz: true })
    await send(gene, { type: 'leaveTable' })

    await send(gene, { type: 'createTable', settings: { visibility: 'invite' } })
    const tableId = tableFor(gene).id
    expect(tableFor(gene).settings).toEqual({ visibility: 'invite', allowKibitz: true })
    expect(connections.last(amy, 'lobby')!.lobby.tables[0].settings.visibility).toBe('invite')

    await send(amy, { type: 'joinTable', tableId })
    await send(amy, { type: 'updateTableSettings', settings: { allowKibitz: false } })
    expect(connections.last(amy, 'error')?.code).toBe('hostOnly')
    await send(gene, { type: 'updateTableSettings', settings: { allowKibitz: false } })
    expect(tableFor(amy).settings).toEqual({ visibility: 'invite', allowKibitz: false })
    await send(gene, { type: 'updateTableSettings', settings: { visibility: 'public' } })
    expect(tableFor(amy).settings).toEqual({ visibility: 'public', allowKibitz: false })
  })

  it('turn down settings they do not know', async () => {
    const gene = await member('gene')
    await send(gene, { type: 'createTable', settings: { visibility: 'secret' } as never })
    expect(connections.last(gene, 'error')?.code).toBe('badTableSettings')
    expect(connections.last(gene, 'lobby')?.lobby.tables ?? []).toHaveLength(0)
    await send(gene, { type: 'createTable' })
    for (const settings of [{ allowKibitz: 'yes' }, { colour: 'red' }, null, []])
      await send(gene, { type: 'updateTableSettings', settings: settings as never })
    expect(connections.inbox.get(gene)!.filter((m) => m.type === 'error' && m.code === 'badTableSettings')).toHaveLength(5)
    expect(tableFor(gene).settings).toEqual({ visibility: 'public', allowKibitz: true })
  })

  it('keep the default settings for tables saved before settings', async () => {
    const gene = await member('gene')
    await send(gene, { type: 'createTable' })
    const tableId = tableFor(gene).id
    const saved = (await store.get<Table>(`table:${tableId}`))!
    delete saved.settings
    await store.put(`table:${tableId}`, saved)
    const reloaded = new ClubService(store, connections, { maxUsers: 10 })
    await reloaded.load()
    expect(reloaded.lobbyView(gene).tables[0].settings).toEqual({ visibility: 'public', allowKibitz: true })
  })

  it('only the host may add robots, and only to empty seats', async () => {
    const { tableId, bySeat } = await fullTable()
    const watcher = await member('watcher')
    await send(watcher, { type: 'joinTable', tableId })
    await send(watcher, { type: 'addRobot', seat: 'N' })
    expect(connections.last(watcher, 'error')?.code).toBe('hostOnly')
    await send(bySeat.S, { type: 'addRobot', seat: 'N' })
    expect(connections.last(bySeat.S, 'error')?.code).toBe('seatTaken')
  })
})

describe('claims', () => {
  it('leaves the declarer’s hand face up after a rejected claim: defenders see all four hands', async () => {
    const { bySeat } = await fullTable()
    for (const [seat, call] of [['N', '1S'], ['E', 'P'], ['S', 'P'], ['W', 'P']] as const)
      await send(bySeat[seat], { type: 'call', call })
    // North declares, South is dummy; North claims before the lead and East rejects
    await send(bySeat.N, { type: 'claim', tricks: 13 })
    expect(Object.keys(tableFor(bySeat.E).board!.hands).sort()).toEqual(['E', 'N', 'S', 'W'])
    await send(bySeat.E, { type: 'claimRespond', accept: false })
    expect(tableFor(bySeat.E).board!.claim).toBeUndefined()
    expect(Object.keys(tableFor(bySeat.E).board!.hands).sort()).toEqual(['E', 'N', 'S', 'W'])
    expect(Object.keys(tableFor(bySeat.W).board!.hands).sort()).toEqual(['E', 'N', 'S', 'W'])
    // The declarer still sees only their own hand (dummy is not down yet)
    expect(Object.keys(tableFor(bySeat.N).board!.hands)).toEqual(['N'])
  })

  it('may be made at any point of the play and says who turned it down', async () => {
    const { bySeat } = await fullTable()
    for (const [seat, call] of [['N', '1S'], ['E', 'P'], ['S', 'P'], ['W', 'P']] as const)
      await send(bySeat[seat], { type: 'call', call })
    expect(tableFor(bySeat.N).board!.canClaim).toBe(true)
    expect(tableFor(bySeat.S).board!.canClaim).toBe(false)
    // East leads; North claims in the middle of the trick, and West turns it down
    await send(bySeat.E, { type: 'play', card: tableFor(bySeat.E).board!.legalCards[0] })
    await send(bySeat.N, { type: 'claim', tricks: 13 })
    await send(bySeat.W, { type: 'claimRespond', accept: false })
    expect(tableFor(bySeat.E).board!.rejectedClaim).toEqual({ seat: 'N', tricks: 13, by: 'W' })
    // The note goes with the next card
    await send(bySeat.N, { type: 'play', card: tableFor(bySeat.N).board!.legalCards[0] })
    expect(tableFor(bySeat.E).board!.rejectedClaim).toBeUndefined()
  })

  it('shows a defender’s claimed hand to everyone', async () => {
    const { bySeat } = await fullTable()
    for (const [seat, call] of [['N', '1S'], ['E', 'P'], ['S', 'P'], ['W', 'P']] as const)
      await send(bySeat[seat], { type: 'call', call })
    await send(bySeat.E, { type: 'claim', tricks: 0 })
    await send(bySeat.N, { type: 'claimRespond', accept: false })
    expect(Object.keys(tableFor(bySeat.N).board!.hands).sort()).toEqual(['E', 'N'])
    expect(Object.keys(tableFor(bySeat.W).board!.hands).sort()).toEqual(['E', 'W'])
  })
})

describe('the pause before the next deal', () => {
  it('counts down three seconds after a passed-out board, and waits for the last trick after a played one', async () => {
    const { bySeat } = await fullTable()
    for (let i = 0; i < 4; i++) await send(bySeat[tableFor(bySeat.N).board!.turn!], { type: 'call', call: 'P' })
    expect(tableFor(bySeat.N).dealAt).toBe(time + DEAL_COUNTDOWN_MS)
    expect(queue.find(isDeal)?.ms).toBe(DEAL_COUNTDOWN_MS)
    await dealNext()
    expect(tableFor(bySeat.N).dealAt).toBeNull()

    // Board 2: everyone plays the first legal card until the end
    for (const [seat, call] of [['E', '1C'], ['S', 'P'], ['W', 'P'], ['N', 'P']] as const)
      await send(bySeat[seat], { type: 'call', call })
    for (let i = 0; i < 60 && tableFor(bySeat.N).board!.phase === 'play'; i++) {
      const board = tableFor(bySeat.N).board!
      const controller = board.turn === board.dummy ? board.contract!.declarer : board.turn!
      const cards = tableFor(bySeat[controller]).board!.legalCards
      await send(bySeat[controller], { type: 'play', card: cards[0] })
    }
    expect(tableFor(bySeat.N).dealAt).toBe(time + LAST_TRICK_MS + DEAL_COUNTDOWN_MS)
  })
})

describe('updates', () => {
  it('sends a member only what changed for them', async () => {
    const { bySeat } = await fullTable()
    const lounger = await member('lounger')
    const before = connections.inbox.get(lounger)!.length
    const tableMessages = () => connections.inbox.get(bySeat.E)!.filter((m) => m.type === 'table')
    const sentToEast = tableMessages().length
    await send(bySeat.N, { type: 'call', call: 'P' })
    // Someone in the lobby hears nothing about a call at a table
    expect(connections.inbox.get(lounger)!.length).toBe(before)
    // The table goes out again, but without the unchanged chat and recent boards
    const latest = tableMessages().at(-1)!
    expect(tableMessages().length).toBe(sentToEast + 1)
    expect(latest.type === 'table' && latest.table && 'chat' in latest.table).toBe(false)
    await send(bySeat.N, { type: 'chat', text: 'hi' })
    expect(tableFor(bySeat.E).chat.map((m) => m.text)).toEqual(['hi'])
  })
})

describe('admin', () => {
  it('makes the first account admin, and only admins pass requireAdmin', async () => {
    const first = (await founder('first')).user
    const second = await join('second')
    expect(first.admin).toBe(true)
    expect(second.admin).toBe(false)
    expect(() => club.requireAdmin(second.id)).toThrow(ClubError)
    expect(() => club.requireAdmin(first.id)).not.toThrow()
  })

  it('lists, creates, resets, promotes and deletes members', async () => {
    const admin = (await founder('admin')).user
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
    await founder('admin', 'env-code')
    await club.adminUpdateSettings({ maxUsers: 2, inviteCode: 'new-code' })
    expect(club.clubSettings).toEqual({ maxUsers: 2, inviteCode: 'new-code' })
    await expect(club.register('amy', 'secret1', 'env-code')).rejects.toThrow('邀請碼不正確')
    await join('amy', 'new-code')
    await expect(club.register('ben', 'secret1', 'new-code')).rejects.toThrow('上限')
    await expect(club.adminUpdateSettings({ maxUsers: 1 })).rejects.toThrow(ClubError)
    // Settings survive a reload
    const reloaded = new ClubService(store, connections, { maxUsers: 10 })
    await reloaded.load()
    expect(reloaded.clubSettings.maxUsers).toBe(2)
  })

  it('lets members change their own password', async () => {
    const { user } = await founder('gene')
    await expect(club.changePassword(user.id, 'wrong', 'newpass1')).rejects.toThrow('目前的密碼不正確')
    await club.changePassword(user.id, 'secret1', 'newpass1')
    await club.login('gene', 'newpass1')
  })
})

describe('registration approval', () => {
  it('holds later registrations until an admin approves them', async () => {
    await founder('admin')
    expect(await club.register('amy', 'secret1', '', '  王小美 資工二  ', 'book')).toEqual({ pending: true, username: 'amy' })
    await expect(club.login('amy', 'secret1')).rejects.toThrow('等管理員核准')
    await expect(club.login('amy', 'wrong')).rejects.toThrow('帳號或密碼錯誤')
    expect((await club.login('admin', 'secret1')).user.applications).toBe(1)
    const [application] = club.adminApplications()
    expect(application).toMatchObject({ username: 'amy', note: '王小美 資工二', site: 'book' })
    expect(application).not.toHaveProperty('passwordHash')

    const amy = await club.adminApprove(application.id)
    expect(amy).toMatchObject({ username: 'amy', admin: false, permissions: [] })
    expect((await club.login('amy', 'secret1')).user.id).toBe(amy.id)
    expect(club.adminApplications()).toEqual([])
    expect((await club.userForToken((await club.login('admin', 'secret1')).token))!.applications).toBe(0)
    await expect(club.adminApprove(application.id)).rejects.toThrow('找不到這筆申請')
  })

  it('frees the name of a rejected application, and keeps waiting ones across a reload', async () => {
    await founder('admin')
    await club.register('amy', 'secret1', '')
    await club.adminReject(club.adminApplications()[0].id)
    await expect(club.login('amy', 'secret1')).rejects.toThrow('帳號或密碼錯誤')
    await club.register('amy', 'secret2', '')
    const reloaded = new ClubService(store, connections, { maxUsers: 10 })
    await reloaded.load()
    expect(reloaded.adminApplications().map((a) => a.username)).toEqual(['amy'])
    await expect(reloaded.login('amy', 'secret2')).rejects.toThrow('等管理員核准')
  })

  it('does not approve past the member limit', async () => {
    await setup({ maxUsers: 2 })
    await founder('admin')
    await club.register('amy', 'secret1', '')
    await club.register('ben', 'secret1', '')
    const [amy, ben] = club.adminApplications()
    await club.adminApprove(amy.id)
    await expect(club.adminApprove(ben.id)).rejects.toThrow('上限')
    await club.adminUpdateSettings({ maxUsers: 3 })
    await club.adminApprove(ben.id)
    expect((await club.adminUsers()).map((u) => u.username)).toEqual(['admin', 'amy', 'ben'])
  })
})

describe('forgotten passwords', () => {
  beforeEach(() => setup({ inviteCode: 'tku' }))

  it('lets a member set a new password with the invite code, and signs them out', async () => {
    await founder('admin', 'tku')
    const amy = await join('amy', 'tku')
    const { token } = await club.login('amy', 'secret1')
    await expect(club.resetForgottenPassword('amy', 'nope', 'newpass1')).rejects.toThrow('邀請碼不正確')
    await expect(club.resetForgottenPassword('amy', 'tku', '123')).rejects.toThrow('密碼至少')
    await expect(club.resetForgottenPassword('nobody', 'tku', 'newpass1')).rejects.toThrow('找不到這個帳號')
    time += 60_000
    await club.resetForgottenPassword('AMY', 'tku', 'newpass1')
    expect(await club.userForToken(token)).toBeNull()
    await expect(club.login('amy', 'secret1')).rejects.toThrow('帳號或密碼錯誤')
    expect((await club.login('amy', 'newpass1')).user.id).toBe(amy.id)
    expect((await club.adminUsers()).find((u) => u.id === amy.id)!.passwordResetAt).toBe(time)
  })

  it('leaves admin accounts to other admins, and lets a waiting applicant change theirs', async () => {
    await founder('admin', 'tku')
    await expect(club.resetForgottenPassword('admin', 'tku', 'newpass1')).rejects.toThrow('其他管理員')
    await club.register('amy', 'secret1', 'tku')
    await club.resetForgottenPassword('amy', 'tku', 'newpass1')
    await expect(club.login('amy', 'newpass1')).rejects.toThrow('等管理員核准')
    await club.adminApprove(club.adminApplications()[0].id)
    await club.login('amy', 'newpass1')
  })
})

describe('permissions', () => {
  it('lets admins grant TKU BridgeBook editing and import; admins have both', async () => {
    const admin = (await founder('admin')).user
    expect(admin.permissions).toEqual(['bookEdit', 'bookImport'])
    const amy = await join('amy')
    expect(() => club.requirePermission(amy.id, 'bookEdit')).toThrow('沒有這項權限')
    await club.adminSetPermissions(amy.id, ['bookImport', 'bookEdit', 'bookEdit'])
    expect(club.requirePermission(amy.id, 'bookEdit').permissions).toEqual(['bookEdit', 'bookImport'])
    await club.adminSetPermissions(amy.id, ['bookEdit'])
    expect(() => club.requirePermission(amy.id, 'bookImport')).toThrow(ClubError)
    await expect(club.adminSetPermissions(amy.id, ['everything'])).rejects.toThrow('不明的權限')
    expect((await club.adminUsers()).map((u) => [u.username, u.permissions])).toEqual([
      ['admin', ['bookEdit', 'bookImport']],
      ['amy', ['bookEdit']],
    ])
    expect(() => club.requirePermission(admin.id, 'bookImport')).not.toThrow()
  })
})

describe('history pages', () => {
  it('reads numbered pages of a chosen size, newest first, with the total', async () => {
    const { bySeat } = await fullTable()
    for (let board = 0; board < 55; board++) {
      time += 1000
      for (let i = 0; i < 4; i++) {
        const turn = tableFor(bySeat.N).board!.turn!
        await send(bySeat[turn], { type: 'call', call: 'P' })
      }
      await dealNext()
    }
    const first = await club.history(bySeat.N, false, 1, 50)
    expect(first).toMatchObject({ total: 55, page: 1, size: 50 })
    expect(first.boards).toHaveLength(50)
    expect(first.boards[0].finishedAt).toBeGreaterThan(first.boards[49].finishedAt)
    const second = await club.history(bySeat.N, false, 2, 50)
    expect(second.boards).toHaveLength(5)
    expect(new Set([...first.boards, ...second.boards].map((b) => b.id)).size).toBe(55)

    // An unknown size falls back to 20; a page past the end shows the last one
    const odd = await club.history(bySeat.N, true, 9, 7)
    expect(odd).toMatchObject({ total: 55, page: 3, size: 20 })
    expect(odd.boards).toHaveLength(15)
  })

  it('moves version-1 history into the new indexes', async () => {
    store = memoryStore()
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

describe('the SQL history index', () => {
  const count = (table: string) => store.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)[0].n

  async function passOut(bySeat: Record<Seat, string>) {
    for (let i = 0; i < 4; i++) {
      const turn = tableFor(bySeat.N).board!.turn!
      await send(bySeat[turn], { type: 'call', call: 'P' })
    }
  }

  it('gets every finished board with its four players', async () => {
    const { bySeat } = await fullTable()
    await passOut(bySeat)
    const id = tableFor(bySeat.N).board!.recordId!
    expect(store.sql.exec('SELECT board_id, level FROM boards_index')).toEqual([{ board_id: id, level: null }])
    expect(store.sql.exec('SELECT seat, user_id FROM board_players ORDER BY seat')).toEqual(
      (['E', 'N', 'S', 'W'] as const).map((seat) => ({ seat, user_id: bySeat[seat] })),
    )
    expect(await store.get('meta:schema')).toBe(3)
  })

  it('fills in boards saved before it, a batch at a time, and can carry on or run again', async () => {
    const seats = { N: 'u1', E: 'u2', S: 'u3', W: 'robot:gib:W' }
    const players = Object.fromEntries(Object.entries(seats).map(([s, id]) => [s, { id, username: id }]))
    const board = { boardNo: 1, dealer: 'N', vul: 'None', contract: null, result: { declarerTricks: 0, scoreNS: 0, claimed: false } }
    for (let i = 0; i < 250; i++) {
      const id = `r${String(i).padStart(3, '0')}`
      await store.put(`board:${id}`, { id, tableNumber: 1, finishedAt: i, players, board })
    }
    await store.put('meta:schema', 2)
    // An earlier load stopped after the first 120 boards
    await store.put('meta:backfill', 'board:r119')
    await new ClubService(store, connections, { maxUsers: 10 }).load()
    expect(count('boards_index')).toBe(130)
    expect(await store.get('meta:schema')).toBe(3)
    expect(await store.get('meta:backfill')).toBeUndefined()

    await store.put('meta:schema', 2)
    await new ClubService(store, connections, { maxUsers: 10 }).load()
    expect(count('boards_index')).toBe(250)
    expect(count('board_players')).toBe(1000)
    expect(store.sql.exec("SELECT COUNT(*) AS n FROM board_players WHERE user_id IS NULL")).toEqual([{ n: 250 }])
  })

  it('never keeps half a board when the index fails', async () => {
    const { bySeat } = await fullTable()
    const sql = store.sql as { exec: typeof store.sql.exec }
    const exec = sql.exec
    sql.exec = (query, ...params) => {
      if (query.startsWith('INSERT OR REPLACE INTO boards_index')) throw new Error('SQL down')
      return exec(query, ...params)
    }
    await expect(passOut(bySeat)).rejects.toThrow('SQL down')
    expect((await store.list('board:')).size).toBe(0)
    expect((await store.list('hist:')).size).toBe(0)
  })

  it('never keeps half a board when a key-value write fails after the index', async () => {
    const { bySeat } = await fullTable()
    const put = store.put.bind(store)
    store.put = async (key, value) => {
      if (key.startsWith('hist:')) throw new Error('KV down')
      return put(key, value)
    }
    await expect(passOut(bySeat)).rejects.toThrow('KV down')
    expect(count('boards_index')).toBe(0)
    expect(count('board_players')).toBe(0)
    expect((await store.list('board:')).size).toBe(0)
  })
})

describe('side panel data', () => {
  it('lists every member with where they are, online first', async () => {
    const { bySeat } = await fullTable()
    await join('away')
    club.broadcast()
    const members = connections.last(bySeat.N, 'lobby')!.lobby.members
    expect(members.at(-1)).toMatchObject({ username: 'away', online: false, tableNumber: null, seat: null })
    expect(members.find((m) => m.username === 'east')).toMatchObject({ online: true, tableNumber: 1, seat: 'E' })
  })

  it('keeps the boards finished at a table, newest first', async () => {
    const { bySeat } = await fullTable()
    for (let board = 0; board < 2; board++) {
      for (let i = 0; i < 4; i++) {
        const turn = tableFor(bySeat.N).board!.turn!
        await send(bySeat[turn], { type: 'call', call: 'P' })
      }
      await dealNext()
    }
    const recent = tableFor(bySeat.W).recent
    expect(recent.map((b) => b.boardNo)).toEqual([2, 1])
    expect(await club.record(recent[0].id)).not.toBeNull()
  })
})

describe('a robot partner as declarer', () => {
  /** A repeatable shuffle (mulberry32), so a test can find a deal it needs */
  const seeded = (seed: number) => {
    let a = seed
    return (n: number) => {
      a = (a + 0x6d2b79f5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n)
    }
  }

  it('moves the person into the declarer’s seat, and back if the auction is reopened', async () => {
    for (let seed = 1; seed < 300; seed++) {
      store = memoryStore()
      connections = new FakeConnections()
      queue = []
      club = new ClubService(store, connections, {
        maxUsers: 10,
        now: () => time,
        random: seeded(seed),
        schedule: (run, ms, kind) => queue.push({ run, ms, kind }),
      })
      await club.load()
      const gene = await member('gene')
      const east = await member('east')
      const west = await member('west')
      await send(gene, { type: 'createTable' })
      const tableId = tableFor(gene).id
      // A 2/1 robot: it must stay one when the seats are swapped
      await send(gene, { type: 'addRobot', seat: 'N', kind: 'gib' })
      await send(east, { type: 'sit', tableId, seat: 'E' })
      await send(west, { type: 'sit', tableId, seat: 'W' })
      // Board 1: the robot in North deals and calls first; we need it to open
      await runRobots()
      if (tableFor(gene).board!.auction[0]?.call === 'P') continue
      const southHand = tableFor(gene).board!.hands.S
      for (const person of [east, gene, west]) await send(person, { type: 'call', call: 'P' })

      const view = tableFor(gene)
      expect(view.board!.contract?.declarer).toBe('N')
      expect(view.mySeat).toBe('N')
      expect(view.seats.S).toMatchObject({ robot: true, robotKind: 'gib' })
      expect(view.board!.dummy).toBe('S')
      // Gene's own cards are now dummy's
      expect(view.board!.hands.S ?? southHand).toEqual(southHand)

      // West takes back the last pass; the auction is open again and Gene is back in South
      await send(west, { type: 'undoRequest' })
      await runRobots()
      if (tableFor(gene).board!.undo) await send(gene, { type: 'undoRespond', accept: true })
      expect(tableFor(gene).board!.phase).toBe('auction')
      expect(tableFor(gene).mySeat).toBe('S')
      expect(tableFor(gene).seats.N).toMatchObject({ robot: true, robotKind: 'gib' })
      return
    }
    throw new Error('no deal where the robot opens')
  })
})

describe('table modes and deal sources', () => {
  /** Starts the club again from the same store, as after the Durable Object was evicted */
  async function reload(online: string[]) {
    club = new ClubService(store, connections, {
      maxUsers: 10,
      now: () => time,
      schedule: (run, ms, kind) => queue.push({ run, ms, kind }),
    })
    await club.load()
    for (const id of online) club.connected(id)
  }

  it('deals a fixed set board by board, shows each hand only to its seat, and stops after the last', async () => {
    const people = await Promise.all(['north', 'east', 'south', 'west'].map(member))
    const bySeat = Object.fromEntries(SEATS.map((s, i) => [s, people[i]])) as Record<Seat, string>
    const deals = [deal(), deal()]
    const table: Table = {
      id: 'fixed',
      number: 1,
      hostId: bySeat.S,
      seats: { N: null, E: null, S: null, W: null },
      spectators: [],
      boardsPlayed: 0,
      board: null,
      chat: [],
      createdAt: time,
      mode: 'casual',
      dealSource: { kind: 'fixed', deals },
    }
    await store.put('table:fixed', table)
    await reload(people)
    for (const seat of SEATS) await send(bySeat[seat], { type: 'sit', tableId: 'fixed', seat })

    const first = tableFor(bySeat.S).board!
    expect(first.boardNo).toBe(1)
    expect(first.hands.S).toEqual(deals[0].S)
    expect(Object.keys(tableFor(bySeat.E).board!.hands)).toEqual(['E'])
    for (const seat of SEATS) await send(bySeat[seat], { type: 'call', call: 'P' })
    await dealNext()
    expect(tableFor(bySeat.S).board!.boardNo).toBe(2)
    expect(tableFor(bySeat.W).board!.hands.W).toEqual(deals[1].W)

    // East deals board 2
    for (const seat of ['E', 'S', 'W', 'N'] as const) await send(bySeat[seat], { type: 'call', call: 'P' })
    await dealNext()
    const last = tableFor(bySeat.S)
    expect(last.board!.boardNo).toBe(2)
    expect(last.board!.phase).toBe('finished')
    expect(last.boardsPlayed).toBe(2)
    expect(queue.filter(isDeal)).toHaveLength(0)
  })

  it('treats a table saved before modes existed as a casual table', async () => {
    const { tableId, bySeat } = await fullTable()
    const saved = (await store.get<Table>(`table:${tableId}`))!
    expect(saved.mode).toBe('casual')
    delete saved.mode
    saved.board = null
    await store.put(`table:${tableId}`, saved)
    await reload(Object.values(bySeat))
    await send(bySeat.S, { type: 'stand' })
    await send(bySeat.S, { type: 'sit', tableId, seat: 'S' })
    expect(tableFor(bySeat.N).board!.boardNo).toBe(1)
  })
})

describe('the alarm queue in the club', () => {
  it('wakes the club for robot moves, which run only once they are due', async () => {
    const wakes: number[] = []
    club = new ClubService(store, connections, { maxUsers: 10, now: () => time, wake: (at) => wakes.push(at) })
    await club.load()
    const gene = await member('gene')
    await send(gene, { type: 'createTable' })
    for (const seat of ['N', 'E', 'W'] as const) await send(gene, { type: 'addRobot', seat })
    // Board 1 is North's deal: the robot there calls first, after a pause
    expect(wakes).toHaveLength(1)
    expect(wakes[0]).toBeGreaterThan(time)
    await club.runDue()
    expect(tableFor(gene).board!.auction).toHaveLength(0)
    time = wakes.at(-1)!
    await club.runDue()
    expect(tableFor(gene).board!.auction.length).toBeGreaterThan(0)
  })
})
