// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import type { Call } from '../../shared/auction.ts'
import { hcp, sideOf } from '../../shared/cards.ts'
import { parseClientMessage } from '../../shared/message-guard.ts'
import { secureRandomInt } from '../../shared/board.ts'
import { DEAL_PRESETS } from '../../shared/deal-presets.ts'
import { meetsConditions } from '../../shared/dealer.ts'
import { parsePracticeSettings, practiceBoardNo, quickRandom } from '../../shared/practice.ts'
import { practiceBoard } from '../../worker/modes.ts'
import type { BoardRecord, ClientMessage, ServerMessage, TableView } from '../../shared/protocol.ts'
import { ClubService, type Connections, type ScheduleKind } from '../../worker/service.ts'
import type { MemoryStore } from '../../worker/store.ts'
import { memoryStore } from './sqlite.ts'

/** The practice table (E10: `e10-t03`, `e10-t05`): one member, three robots, conditions, new deals, undo */

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
let boss: string

beforeEach(async () => {
  store = memoryStore()
  connections = new FakeConnections()
  queue = []
  time = 1_000_000
  club = new ClubService(store, connections, {
    maxUsers: 40,
    now: () => time,
    schedule: (run, ms, kind) => queue.push({ run, ms, kind }),
  })
  await club.load()
  const founder = await club.register('boss', 'secret1', '')
  boss = 'user' in founder ? founder.user.id : ''
})

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

async function runRobots(limit = 400) {
  for (let i = 0; i < limit; i++) {
    const index = queue.findIndex((job) => job.kind === 'robot')
    if (index < 0) return
    queue.splice(index, 1)[0].run()
    await tick()
  }
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
const view = (userId: string) => connections.table(userId)

async function refused(userId: string, message: ClientMessage) {
  connections.inbox.set(userId, [])
  await send(userId, message)
  return connections.last(userId, 'error')
}

const practice = (userId: string, settings: Record<string, unknown> = {}) =>
  send(userId, { type: 'createPractice', settings } as unknown as ClientMessage)

/** Passes in the auction and plays the first legal card until the board is over */
async function playBoard(userId: string) {
  for (let i = 0; i < 400; i++) {
    await runRobots()
    const board = view(userId)?.board
    if (!board) throw new Error('no board')
    if (board.phase === 'finished') return
    if (board.legalCalls.length) await send(userId, { type: 'call', call: 'P' })
    else if (board.legalCards.length) await send(userId, { type: 'play', card: board.legalCards[0] })
    else throw new Error(`stuck: ${board.phase}, turn ${board.turn}`)
  }
}

describe('practice settings', () => {
  it('takes a preset, any deal or well-formed conditions, and names the field that is wrong', () => {
    // The robots are the member's by default: 2/1 unless they may use the club's system (ROBOT.md §7)
    expect(parsePracticeSettings({})).toEqual({ settings: { deal: 'random', robotKind: 'gib', justDeclare: false } })
    expect(parsePracticeSettings({}, 'tku')).toEqual({ settings: { deal: 'random', robotKind: 'tku', justDeclare: false } })
    expect(parsePracticeSettings({ deal: 'oneNotrump', robotKind: 'gib', justDeclare: true })).toEqual({
      settings: { deal: 'oneNotrump', robotKind: 'gib', justDeclare: true },
    })
    const conditions = { seats: { S: { hcp: [12, 14], lengths: { S: [5, 13] } }, N: { balanced: true } }, sides: { NS: { hcp: [24, 40] } } }
    expect(parsePracticeSettings({ deal: 'custom', conditions })).toEqual({
      settings: { deal: 'custom', conditions, robotKind: 'gib', justDeclare: false },
    })
    expect(parsePracticeSettings({ deal: 'nope' })).toEqual({ field: 'deal' })
    expect(parsePracticeSettings({ robotKind: 'gib2' })).toEqual({ field: 'robotKind' })
    expect(parsePracticeSettings({ justDeclare: 'yes' })).toEqual({ field: 'justDeclare' })
    expect(parsePracticeSettings({ deal: 'custom' })).toEqual({ field: 'conditions' })
    expect(parsePracticeSettings({ deal: 'slam', conditions })).toEqual({ field: 'conditions' })
    expect(parsePracticeSettings({ deal: 'custom', conditions: { seats: { S: { hcp: [15, 12] } } } })).toEqual({ field: 'conditions' })
    expect(parsePracticeSettings({ deal: 'custom', conditions: { seats: { S: { points: [1, 2] } } } })).toEqual({ field: 'conditions' })
    expect(parsePracticeSettings({ deal: 'custom', conditions: { seats: { S: { lengths: { S: [7, 13], H: [7, 13] } } } } })).toEqual({
      field: 'conditions',
    })
    expect(parsePracticeSettings({ extra: 1 })).toEqual({ field: 'settings' })
  })

  it('has South deal every board dealt to conditions, and goes round the table otherwise', () => {
    expect([0, 1, 2, 3].map((n) => practiceBoardNo({ deal: 'oneNotrump' }, n))).toEqual([3, 7, 11, 15])
    expect([0, 1, 2].map((n) => practiceBoardNo({ deal: 'random' }, n))).toEqual([1, 2, 3])
  })

  it('guards the new socket messages', () => {
    expect(parseClientMessage('{"type":"createPractice"}')).toEqual({ error: 'badMessage' })
    expect(parseClientMessage('{"type":"createPractice","settings":[]}')).toEqual({ error: 'badMessage' })
    expect(parseClientMessage('{"type":"createPractice","settings":{}}')).toEqual({ message: { type: 'createPractice', settings: {} } })
    expect(parseClientMessage('{"type":"redeal"}')).toEqual({ message: { type: 'redeal' } })
  })
})

describe('the practice table (e10-t03)', () => {
  it('seats the member South with three TKB of the chosen system, hidden from others (only the invited may watch)', async () => {
    const amy = await member('amy')
    const ben = await member('ben')
    await practice(amy, { robotKind: 'gib' })
    const table = view(amy)!
    expect(table.mySeat).toBe('S')
    expect(table.practice).toEqual({ deal: 'random', robotKind: 'gib', justDeclare: false, dealt: 1 })
    for (const seat of ['N', 'E', 'W'] as const) expect(table.seats[seat]).toMatchObject({ id: `robot:gib:${seat}`, robot: true })
    expect(table.board?.boardNo).toBe(1)
    expect(club.lobbyView(amy).tables).toMatchObject([{ id: table.id, practice: true, settings: { access: 'hidden' } }])
    expect(club.lobbyView(ben).tables).toEqual([])
    expect(club.lobbyView(amy)).toMatchObject({ myTableId: table.id, myTableMode: 'practice' })
    expect(club.lobbyView(ben).myTableMode).toBeUndefined()
    expect(club.lobbyView(ben).members.find((m) => m.id === amy)?.tableNumber).toBeNull()
    // Nobody else comes to it, and its seats and settings stay
    expect((await refused(ben, { type: 'joinTable', tableId: table.id }))?.code).toBe('tableGone')
    expect((await refused(ben, { type: 'sit', tableId: table.id, seat: 'N' }))?.code).toBe('tableGone')
    expect((await refused(amy, { type: 'sit', tableId: table.id, seat: 'N' }))?.code).toBe('practiceTableFixed')
    expect((await refused(amy, { type: 'updateTableSettings', settings: { allowKibitz: true } }))?.code).toBe('practiceTableFixed')
    expect((await refused(amy, { type: 'removeRobot', seat: 'N' }))?.code).toBe('practiceTableFixed')
    expect((await refused(amy, { type: 'stand' }))?.code).toBe('practiceTableFixed')
    await send(ben, { type: 'quickSeat' })
    expect(club.lobbyView(ben).tables).toHaveLength(1)
    expect(club.lobbyView(ben).tables[0].id).not.toBe(table.id)
  })

  it('deals every board to the preset, South dealing', async () => {
    const amy = await member('amy')
    await practice(amy, { deal: 'oneNotrump' })
    const seen = []
    for (let i = 0; i < 4; i++) {
      const board = view(amy)!.board!
      const south = board.hands.S!
      expect(hcp(south)).toBeGreaterThanOrEqual(15)
      expect(hcp(south)).toBeLessThanOrEqual(17)
      expect(board.dealer).toBe('S')
      seen.push(board.boardNo)
      await send(amy, { type: 'redeal' })
    }
    expect(seen).toEqual([3, 7, 11, 15])
  })

  it('deals the hardest preset (slam hands) well within the practice limit', () => {
    const random = quickRandom(secureRandomInt)
    for (let i = 0; i < 50; i++) {
      const dealt = practiceBoard({ deal: 'slam', robotKind: 'tku', justDeclare: false }, 3, random)
      expect(dealt).not.toBeNull()
      expect(meetsConditions(DEAL_PRESETS.slam, dealt!.hands)).toBe(true)
    }
  })

  it('turns down conditions that cannot be met, before the member leaves their table', async () => {
    const amy = await member('amy')
    await send(amy, { type: 'createTable' })
    const before = club.lobbyView(amy).myTableId
    const error = await refused(amy, { type: 'createPractice', settings: { deal: 'custom', conditions: { seats: { S: { hcp: [33, 37] } } } } } as unknown as ClientMessage)
    expect(error?.code).toBe('dealTooStrict')
    expect((await refused(amy, { type: 'createPractice', settings: { deal: 'hard' } } as unknown as ClientMessage))?.params).toEqual({ field: 'deal' })
    expect(club.lobbyView(amy).myTableId).toBe(before)
  })

  it('deals again at any time, keeping no record of the board put away; only at a practice table', async () => {
    const amy = await member('amy')
    await practice(amy)
    const first = view(amy)!.board!
    await send(amy, { type: 'call', call: '1C' })
    await runRobots()
    await send(amy, { type: 'redeal' })
    const table = view(amy)!
    expect(table.board!.boardNo).toBe(2)
    expect(table.board!.auction.length).toBeLessThan(2)
    expect(table.board!.hands.S).not.toEqual(first.hands.S)
    expect(table.boardsPlayed).toBe(0)
    expect(table.practice?.dealt).toBe(2)
    expect((await club.search(amy, { scope: 'mine', sort: 'date_desc', page: 1, size: 10 })).total).toBe(0)
    const ben = await member('ben')
    await send(ben, { type: 'createTable' })
    expect((await refused(ben, { type: 'redeal' }))?.code).toBe('practiceOnly')
  })

  it('takes back any call or card, as often as the member likes', async () => {
    const amy = await member('amy')
    await practice(amy)
    await runRobots()
    for (let round = 0; round < 3; round++) {
      const before = view(amy)!.board!.auction.length
      await send(amy, { type: 'call', call: 'P' })
      await runRobots()
      if (view(amy)!.board!.phase !== 'auction') break
      await send(amy, { type: 'undoRequest' })
      await runRobots()
      expect(view(amy)!.board!.auction.length).toBe(before)
    }
  })

  it('closes when the member leaves', async () => {
    const amy = await member('amy')
    await practice(amy)
    await send(amy, { type: 'leaveTable' })
    expect(club.lobbyView(amy).myTableId).toBeNull()
  })
})

describe('watching a practice table (the four access modes)', () => {
  it('lets the member open it up: watchers see what a kibitzer sees, never take a seat, and go when the member leaves', async () => {
    const amy = await member('amy')
    const ben = await member('ben')
    const cleo = await member('cleo')
    await practice(amy)
    const tableId = view(amy)!.id
    // Hidden: invited members find it and watch
    await send(amy, { type: 'updateTableSettings', settings: { access: 'hidden' }, invitees: [cleo] })
    expect(connections.last(cleo, 'notifications')!.notifications.items[0]).toMatchObject({ kind: 'tableInvited' })
    expect(club.lobbyView(cleo).tables.map((t) => t.id)).toEqual([tableId])
    expect((await refused(ben, { type: 'joinTable', tableId }))?.code).toBe('tableGone')
    await send(cleo, { type: 'joinTable', tableId })
    expect(view(cleo)!.mySeat).toBeNull()

    // Public: anyone may watch, nobody may sit; only who may watch changes
    await send(amy, { type: 'updateTableSettings', settings: { access: 'public' } })
    expect(view(amy)!.settings.access).toBe('public')
    expect(club.lobbyView(ben).tables[0]).toMatchObject({ id: tableId, practice: true, welcome: true })
    expect((await refused(ben, { type: 'sit', tableId, seat: 'N' }))?.code).toBe('practiceTableFixed')
    await send(ben, { type: 'joinTable', tableId })
    const watched = view(ben)!
    expect(watched.mySeat).toBeNull()
    expect(Object.keys(watched.board!.hands).sort()).toEqual(['E', 'N', 'S', 'W'])
    expect(watched.board!.legalCalls).toEqual([])
    expect((await refused(ben, { type: 'redeal' }))?.code).toBe('hostOnly')
    expect((await refused(amy, { type: 'updateTableSettings', settings: { boardMinutes: 5 } }))?.code).toBe('practiceTableFixed')
    // The member stays the host even while offline; watchers cannot take the table over
    connections.disconnect(amy)
    await club.disconnected(amy)
    expect((await refused(ben, { type: 'updateTableSettings', settings: { access: 'closed' } }))?.code).toBe('hostOnly')
    connections.online.add(amy)
    club.connected(amy)
    await tick()

    await send(amy, { type: 'leaveTable' })
    expect(view(ben)).toBeNull()
    expect(club.lobbyView(ben).tables).toEqual([])
  })

  it('opens with the access the member chose', async () => {
    const amy = await member('amy')
    const ben = await member('ben')
    await send(amy, { type: 'createPractice', settings: {}, access: 'request' } as unknown as ClientMessage)
    const tableId = view(amy)!.id
    expect(view(amy)!.settings).toEqual({ access: 'request', allowKibitz: true, boardMinutes: 0 })
    expect(club.lobbyView(ben).tables[0]).toMatchObject({ id: tableId, welcome: false, settings: { access: 'request' } })
    await send(ben, { type: 'requestJoin', tableId })
    await send(amy, { type: 'answerRequest', userId: ben, accept: true })
    await send(ben, { type: 'joinTable', tableId })
    expect(view(ben)!.id).toBe(tableId)
    expect((await refused(amy, { type: 'createPractice', settings: {}, access: 'secret' } as unknown as ClientMessage))?.code).toBe(
      'badTableSettings',
    )
  })
})

describe('practice records (AC-10.2)', () => {
  it('are marked practice, kept out of the club’s list unless asked for, and not featured or challenged with', async () => {
    const amy = await member('amy')
    const ben = await member('ben')
    await practice(amy)
    await playBoard(amy)
    const mine = await club.search(amy, { scope: 'mine', sort: 'date_desc', page: 1, size: 10 })
    expect(mine.total).toBe(1)
    const id = mine.boards[0].id
    const record = (await club.record(id, amy)) as BoardRecord
    expect(record.mode).toBe('practice')
    expect(record.tableNumber).toBe(0)
    expect((await club.search(ben, { scope: 'all', sort: 'date_desc', page: 1, size: 10 })).total).toBe(0)
    expect((await club.search(ben, { scope: 'all', mode: 'practice', sort: 'date_desc', page: 1, size: 10 })).total).toBe(1)
    expect((await club.memberProfile(ben, amy)).recent).toHaveLength(0)
    await expect(club.featured.set(boss, id, { title: 'x', category: 'other' })).rejects.toMatchObject({ code: 'practiceNotFeatured' })
    await send(amy, { type: 'setFriend', userId: ben, friend: true })
    expect((await refused(amy, { type: 'createChallenge', invitees: [ben], fromBoards: [id] }))?.code).toBe('practiceNoChallenge')
  })
})

describe('Just Declare practice (e10-t05)', () => {
  it('has the robots bid, and the member declare', async () => {
    const amy = await member('amy')
    await practice(amy, { justDeclare: true, deal: 'majorOpening' })
    for (let i = 0; i < 3; i++) {
      const board = view(amy)!.board!
      expect(board.phase).toBe('play')
      expect(sideOf(board.contract!.declarer)).toBe('NS')
      // A person never sits out as dummy: they declare from whichever seat won the contract
      expect(view(amy)!.mySeat).toBe(board.contract!.declarer)
      expect(board.auction.every((c) => c.robot)).toBe(true)
      await send(amy, { type: 'redeal' })
    }
  })
})

describe('bidding practice, one member bidding for several seats (e10-t15)', () => {
  /** Makes the member's calls for whichever of their seats is to call, robots in between, until the auction is over */
  async function bid(userId: string, calls: (n: number) => Call = () => 'P') {
    for (let n = 0; n < 60; n++) {
      await runRobots()
      const board = view(userId)!.board!
      if (board.phase !== 'auction') return
      if (!board.legalCalls.length) throw new Error(`stuck at ${board.turn}`)
      await send(userId, { type: 'call', call: calls(n), seat: board.turn! })
    }
    throw new Error('the auction did not end')
  }

  it('takes the bidding-only switch and the seats, South always among them and others only when bidding only', () => {
    expect(parsePracticeSettings({ biddingOnly: true, seats: ['N', 'S'] })).toEqual({
      settings: { deal: 'random', robotKind: 'gib', justDeclare: false, biddingOnly: true, seats: ['N', 'S'] },
    })
    // South alone is the default and is not kept
    expect(parsePracticeSettings({ biddingOnly: true, seats: ['S'] })).toEqual({
      settings: { deal: 'random', robotKind: 'gib', justDeclare: false, biddingOnly: true },
    })
    expect(parsePracticeSettings({ biddingOnly: false, seats: ['S'] })).toEqual({
      settings: { deal: 'random', robotKind: 'gib', justDeclare: false },
    })
    expect(parsePracticeSettings({ seats: ['S', 'N'] })).toEqual({ field: 'seats' })
    expect(parsePracticeSettings({ biddingOnly: true, seats: ['N'] })).toEqual({ field: 'seats' })
    expect(parsePracticeSettings({ biddingOnly: true, seats: ['S', 'S'] })).toEqual({ field: 'seats' })
    expect(parsePracticeSettings({ biddingOnly: true, seats: ['S', 'X'] })).toEqual({ field: 'seats' })
    expect(parsePracticeSettings({ biddingOnly: true, seats: 'S' })).toEqual({ field: 'seats' })
    expect(parsePracticeSettings({ biddingOnly: 'yes' })).toEqual({ field: 'biddingOnly' })
    expect(parsePracticeSettings({ biddingOnly: true, justDeclare: true })).toEqual({ field: 'biddingOnly' })
    expect(parseClientMessage('{"type":"call","call":"P","seat":3}')).toEqual({ error: 'badMessage' })
    expect(parseClientMessage('{"type":"call","call":"P","seat":"N"}')).toEqual({ message: { type: 'call', call: 'P', seat: 'N' } })
    expect(parseClientMessage('{"type":"rebid"}')).toEqual({ message: { type: 'rebid' } })
  })

  it('lets the member bid for South and North, shows them both hands, and ends the board with the auction: all four open, no play, no record', async () => {
    const amy = await member('amy')
    await practice(amy, { biddingOnly: true, seats: ['S', 'N'], robotKind: 'gib' })
    const table = view(amy)!
    expect(table.practice).toMatchObject({ biddingOnly: true, seats: ['N', 'S'] })
    expect(table.mySeat).toBe('S')
    expect(table.acts).toEqual(['N', 'S'])
    expect(table.seats.N).toMatchObject({ robot: true, controlledBy: 'amy' })
    expect(table.seats.E?.controlledBy).toBeUndefined()
    const before = table.board!
    expect(Object.keys(before.hands).sort()).toEqual(['N', 'S'])
    // Board 1: North deals, and North is the member's to bid
    expect(before.turn).toBe('N')
    expect(before.legalCalls.length).toBeGreaterThan(0)

    // The member opens and South (also the member) answers; the robots bid only East and West
    await bid(amy, (n) => (n === 0 ? '1C' : 'P'))
    const board = view(amy)!.board!
    for (const call of board.auction) expect(!!call.robot, `${call.seat} ${call.call}`).toBe(call.seat === 'E' || call.seat === 'W')
    expect(board.phase).toBe('finished')
    expect(board.contract).not.toBeNull()
    expect(board.result).toBeUndefined()
    expect(board.tricks).toEqual([])
    expect(Object.keys(board.hands).sort()).toEqual(['E', 'N', 'S', 'W'])
    expect(view(amy)!.dealAt).toBeNull()
    expect(view(amy)!.boardsPlayed).toBe(0)
    expect(queue.some((job) => job.kind === 'deal')).toBe(false)
    expect((await club.search(amy, { scope: 'mine', sort: 'date_desc', page: 1, size: 10 })).total).toBe(0)

    // 重叫這一副: the same hands from the start; 下一副: a new board
    await send(amy, { type: 'rebid' })
    const again = view(amy)!.board!
    expect(again).toMatchObject({ boardNo: before.boardNo, phase: 'auction', auction: [] })
    expect(again.hands).toEqual(before.hands)
    await send(amy, { type: 'redeal' })
    expect(view(amy)!.board!.boardNo).toBe(before.boardNo + 1)
  })

  it('checks the seat a call is made for: one the member bids for, and its turn', async () => {
    const amy = await member('amy')
    await practice(amy, { biddingOnly: true, seats: ['S', 'N'] })
    expect(view(amy)!.board!.turn).toBe('N')
    expect((await refused(amy, { type: 'call', call: 'P', seat: 'X' } as unknown as ClientMessage))?.code).toBe('badSeat')
    expect((await refused(amy, { type: 'call', call: 'P', seat: 'E' }))?.code).toBe('notYourSeat')
    // Without a seat the call is South's, whose turn it is not
    expect((await refused(amy, { type: 'call', call: 'P' }))?.code).toBe('notYourCall')
    expect((await refused(amy, { type: 'call', call: 'P', seat: 'S' }))?.code).toBe('notYourCall')
    expect(await refused(amy, { type: 'call', call: '1C', seat: 'N' })).toBeUndefined()
    expect(view(amy)!.board!.auction).toMatchObject([{ seat: 'N', call: '1C' }])
    // Now East's: the robot bids it, not the member
    expect(view(amy)!.board!.legalCalls).toEqual([])
    await runRobots()
    expect(view(amy)!.board!.auction[1]).toMatchObject({ seat: 'E', robot: true })
  })

  it('takes back the last call the member made, for whichever seat', async () => {
    const amy = await member('amy')
    await practice(amy, { biddingOnly: true, seats: ['S', 'N', 'E', 'W'] })
    // Nobody else bids: the member makes every call
    await send(amy, { type: 'call', call: '1C', seat: view(amy)!.board!.turn! })
    await send(amy, { type: 'call', call: '1D', seat: view(amy)!.board!.turn! })
    const second = view(amy)!.board!.auction[1].seat
    expect(view(amy)!.board!.canUndo).toBe(true)
    await send(amy, { type: 'undoRequest' })
    await runRobots()
    expect(view(amy)!.board!.auction.map((c) => c.call)).toEqual(['1C'])
    expect(view(amy)!.board!.turn).toBe(second)
    // Passed out after 1♣: over at once, nothing recorded
    for (let i = 0; i < 3; i++) await send(amy, { type: 'call', call: 'P', seat: view(amy)!.board!.turn! })
    expect(view(amy)!.board!.phase).toBe('finished')
    expect(view(amy)!.board!.contract).toMatchObject({ level: 1, strain: 'C' })
    expect(view(amy)!.board!.auction.some((c) => c.robot)).toBe(false)
    expect((await club.search(amy, { scope: 'mine', sort: 'date_desc', page: 1, size: 10 })).total).toBe(0)
  })

  it('shows a watcher what any watcher sees, and lets nobody else bid, rebid or bid for a controlled seat', async () => {
    const amy = await member('amy')
    const ben = await member('ben')
    await send(amy, { type: 'createPractice', settings: { biddingOnly: true, seats: ['S', 'N'] }, access: 'public' } as unknown as ClientMessage)
    const tableId = view(amy)!.id
    await send(ben, { type: 'joinTable', tableId })
    const watched = view(ben)!
    expect(watched.acts).toBeUndefined()
    expect(watched.board!.legalCalls).toEqual([])
    expect((await refused(ben, { type: 'call', call: 'P', seat: 'N' }))?.code).toBe('notSeated')
    expect((await refused(ben, { type: 'rebid' }))?.code).toBe('hostOnly')
    // Rebidding is for a bidding practice only
    const cat = await member('cat')
    await practice(cat)
    expect((await refused(cat, { type: 'rebid' }))?.code).toBe('biddingOnlyRebid')
  })
})
