// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { actionTimes, realGaps, REAL_GAP_MAX_MS, REAL_GAP_MIN_MS, type BoardEvent } from '../../shared/board-events.ts'
import type { Seat } from '../../shared/cards.ts'
import type { ClientMessage, ServerMessage, TableView } from '../../shared/protocol.ts'
import { ClubService, type Connections } from '../../worker/service.ts'
import { memoryStore } from './sqlite.ts'

/**
 * The action log, the director and rulings (`e2-t32`～`e2-t35`, AC-2.14): every call and card is
 * logged with the server's time and kept in the record (never sent with the live table); a seated
 * player calls the director, the host and the admins are told and may come in; the host or an
 * admin rules on a finished board
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

let connections: FakeConnections
let club: ClubService
let time: number

beforeEach(async () => {
  connections = new FakeConnections()
  time = 1_000_000
  club = new ClubService(memoryStore(), connections, {
    maxUsers: 20,
    now: () => time,
    schedule: () => {},
  })
  await club.load()
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
const notified = (userId: string) => connections.last(userId, 'notifications')?.notifications.items ?? []

/** The admin first (the first account), then four members seated N E S W at South's table */
async function fullTable() {
  const admin = await member('boss')
  const ids = [] as string[]
  for (const name of ['north', 'east', 'south', 'west']) ids.push(await member(name))
  const bySeat: Record<Seat, string> = { N: ids[0], E: ids[1], S: ids[2], W: ids[3] }
  await send(bySeat.S, { type: 'createTable' })
  const tableId = tableFor(bySeat.S).id
  for (const seat of ['N', 'E', 'W'] as const) await send(bySeat[seat], { type: 'sit', tableId, seat })
  return { admin, tableId, bySeat }
}

async function passOut(bySeat: Record<Seat, string>) {
  for (const seat of ['N', 'E', 'S', 'W'] as const) await send(bySeat[seat], { type: 'call', call: 'P' })
  return tableFor(bySeat.N).board!.recordId!
}

describe('the action log (e2-t32)', () => {
  it('logs every call, card, undo and claim with the server time, append-only, into the record', async () => {
    const { bySeat } = await fullTable()
    const startedAt = time
    for (const [seat, call] of [['N', '1S'], ['E', 'P'], ['S', 'P'], ['W', 'P']] as const) {
      time += 1000
      await send(bySeat[seat], { type: 'call', call })
    }
    // East leads, takes it back with North's agreement, and leads again
    time += 5000
    const first = tableFor(bySeat.E).board!.legalCards[0]
    await send(bySeat.E, { type: 'play', card: first })
    time += 1000
    await send(bySeat.E, { type: 'undoRequest' })
    await send(bySeat.N, { type: 'undoRespond', accept: true })
    time += 3000
    const lead = tableFor(bySeat.E).board!.legalCards.at(-1)!
    await send(bySeat.E, { type: 'play', card: lead })
    // North claims everything; both defenders accept
    time += 2000
    await send(bySeat.N, { type: 'claim', tricks: 13 })
    await send(bySeat.E, { type: 'claimRespond', accept: true })
    await send(bySeat.W, { type: 'claimRespond', accept: true })

    // Nothing of the log goes with the live table
    expect(JSON.stringify(connections.inbox.get(bySeat.N))).not.toContain('"events"')

    const id = tableFor(bySeat.N).board!.recordId!
    const record = (await club.record(id, bySeat.S))!
    expect(record.startedAt).toBe(startedAt)
    expect(record.hostId).toBe(bySeat.S)
    const events = record.events!
    expect(events.map((e) => e.type)).toEqual([
      'deal',
      'call',
      'call',
      'call',
      'call',
      'play',
      'undo',
      'play',
      'claim',
      'claimAccept',
      'claimAccept',
    ])
    expect(events[5]).toEqual({ type: 'play', seat: 'E', card: first, at: startedAt + 9000 })
    expect(events[6]).toEqual({ type: 'undo', seat: 'E', calls: 4, cards: 0, at: startedAt + 10000 })
    expect(events[8]).toMatchObject({ type: 'claim', seat: 'N', tricks: 13 })
    // Times never go back
    for (let i = 1; i < events.length; i++) expect(events[i].at).toBeGreaterThanOrEqual(events[i - 1].at)
    // The replay's times: the card that stands is the second lead, not the one taken back
    const times = actionTimes(events, record.board.auction.length, record.board.play.length)!
    expect(times.cards).toEqual([startedAt + 13000])
    expect(times.calls).toEqual([1, 2, 3, 4].map((i) => startedAt + i * 1000))
    expect(record.board.play).toEqual([{ seat: 'E', card: lead }])
  })

  it('starts a fresh log with every board', async () => {
    const { bySeat } = await fullTable()
    const first = (await club.record(await passOut(bySeat), bySeat.N))!
    expect(first.events!.filter((e) => e.type === 'call')).toHaveLength(4)
  })
})

describe('replay times (e2-t33)', () => {
  const at = (type: BoardEvent['type'], t: number, extra: object = {}) => ({ type, at: t, seat: 'N', ...extra }) as BoardEvent

  it('waits as long as the players did, within limits', () => {
    const events = [
      at('deal', 0),
      at('call', 1000, { call: '1N' }),
      at('play', 4000, { card: 'SA' }),
      at('play', 4010, { card: 'S2' }),
      at('play', 4010 + REAL_GAP_MAX_MS * 3, { card: 'S3' }),
    ]
    const times = actionTimes(events, 1, 3)!
    expect(realGaps(times)).toEqual([3000, REAL_GAP_MIN_MS, REAL_GAP_MAX_MS])
  })

  it('gives nothing for a log that does not match the board', () => {
    expect(actionTimes(undefined, 0, 0)).toBeNull()
    expect(actionTimes([at('deal', 0), at('play', 1, { card: 'SA' })], 0, 2)).toBeNull()
  })
})

describe('calling the director (e2-t34)', () => {
  it('tells the host and the admins, shows the call at the table, and lets them in where watching is off', async () => {
    const { admin, tableId, bySeat } = await fullTable()
    await send(bySeat.S, { type: 'updateTableSettings', settings: { allowKibitz: false } })
    time += 1000
    await send(bySeat.E, { type: 'callDirector' })
    await tick()
    for (const seat of ['N', 'E', 'S', 'W'] as const)
      expect(tableFor(bySeat[seat]).directorCall).toEqual({ user: expect.objectContaining({ id: bySeat.E, username: 'east' }), at: time })
    for (const id of [admin, bySeat.S])
      expect(notified(id)[0]).toMatchObject({ kind: 'directorCalled', params: { tableId, username: 'east' } })
    expect(notified(bySeat.N).some((n) => n.kind === 'directorCalled')).toBe(false)

    // Nobody else watches this table, but the admin comes in
    const stranger = await member('stranger')
    await send(stranger, { type: 'joinTable', tableId })
    expect(connections.last(stranger, 'error')?.code).toBe('noKibitzing')
    await send(admin, { type: 'joinTable', tableId })
    expect(tableFor(admin).spectators.map((u) => u.id)).toContain(admin)

    // Another player cannot clear it; the admin can
    await send(bySeat.W, { type: 'clearDirector' })
    expect(connections.last(bySeat.W, 'error')?.code).toBe('directorOnly')
    await send(admin, { type: 'clearDirector' })
    expect(tableFor(bySeat.N).directorCall).toBeUndefined()
  })

  it('is only for a seated player', async () => {
    const { tableId, bySeat } = await fullTable()
    const watcher = await member('watcher')
    await send(watcher, { type: 'joinTable', tableId })
    await send(watcher, { type: 'callDirector' })
    expect(connections.last(watcher, 'error')?.code).toBe('notSeated')
    expect(tableFor(bySeat.N).directorCall).toBeUndefined()
    // Without a call nobody gets past a table's settings as the director
    await send(bySeat.S, { type: 'updateTableSettings', settings: { allowKibitz: false } })
    const admin = club.adminIds()[0]
    await send(admin, { type: 'joinTable', tableId })
    expect(connections.last(admin, 'error')?.code).toBe('noKibitzing')
  })
})

describe('rulings (e2-t35)', () => {
  it('lets the host or an admin rule on a board, with a reason, shown in the history', async () => {
    const { admin, bySeat } = await fullTable()
    const id = await passOut(bySeat)
    const ruling = { kind: 'avgPlus', side: 'NS', reason: 'Unauthorised information' }
    await expect(club.ruleBoard(bySeat.W, id, ruling)).rejects.toMatchObject({ code: 'directorOnly' })

    time += 60_000
    const ruled = await club.ruleBoard(bySeat.S, id, ruling)
    expect(ruled.ruling).toEqual({ ...ruling, by: expect.objectContaining({ id: bySeat.S }), at: time })
    // The result as played stays
    expect(ruled.board.result?.scoreNS).toBe(0)
    expect((await club.record(id, bySeat.N))!.ruling?.kind).toBe('avgPlus')
    const listed = (await club.history(bySeat.E, false)).boards.find((b) => b.id === id)!
    expect(listed.ruling).toEqual({ kind: 'avgPlus', side: 'NS' })
    expect(JSON.stringify(listed)).not.toContain('Unauthorised')

    await club.ruleBoard(admin, id, { kind: 'score', scoreNS: -420, reason: 'Revoke' })
    expect((await club.history(bySeat.E, false)).boards.find((b) => b.id === id)!.ruling).toEqual({ kind: 'score', scoreNS: -420 })
    // Taken back
    await club.ruleBoard(admin, id, null)
    expect((await club.record(id, bySeat.N))!.ruling).toBeUndefined()
  })

  it('refuses a ruling that is not one', async () => {
    const { bySeat } = await fullTable()
    const id = await passOut(bySeat)
    for (const bad of [
      { kind: 'avg', reason: '' },
      { kind: 'avgMinus', reason: 'x' },
      { kind: 'score', scoreNS: 425, reason: 'x' },
      { kind: 'score', scoreNS: 99_990, reason: 'x' },
      { kind: 'bonus', reason: 'x' },
    ])
      await expect(club.ruleBoard(bySeat.S, id, bad)).rejects.toMatchObject({ code: 'badBoardRuling' })
    await expect(club.ruleBoard(bySeat.S, 'nope', { kind: 'avg', reason: 'x' })).rejects.toMatchObject({ code: 'boardGone' })
  })
})
