// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { applyLobbyDelta, composeLobby, emptyReplica, receiveLobby, type LobbySharedMessage } from '../../shared/lobby.ts'
import type { LobbyMine, LobbyShared, MemberStatus, ServerMessage, SharedTable } from '../../shared/protocol.ts'
import { ACTION_SLOW_MS, sampleActions, type LogEntry } from '../../worker/log.ts'
import { Metrics } from '../../worker/metrics.ts'
import { ClubService, LOBBY_GAP_MS, type Connections } from '../../worker/service.ts'
import { lobbyFrom } from './lobby-copy.ts'
import { memoryStore } from './sqlite.ts'

/** The lobby in two parts, deltas only (H3b, ARCHITECTURE.md §5.13), and the sampled action logs */

const member = (id: string, online = true, tableNumber: number | null = null): MemberStatus => ({
  id,
  username: id,
  online,
  tableNumber,
  seat: tableNumber === null ? null : 'S',
})
const table = (id: string, number: number, empty: number): SharedTable => ({
  id,
  number,
  hostName: 'amy',
  settings: { access: 'public', allowKibitz: true, boardMinutes: 0 },
  seats: {
    N: empty > 0 ? null : { id: 'n', username: 'n', online: true },
    E: empty > 1 ? null : { id: 'e', username: 'e', online: true },
    S: { id: 's', username: 's', online: true },
    W: empty > 2 ? null : { id: 'w', username: 'w', online: true },
  },
  spectators: 0,
  boardsPlayed: 0,
  boardNo: null,
})
const mine = (over: Partial<LobbyMine> = {}): LobbyMine => ({
  myTableId: null,
  friends: [],
  blocked: [],
  tables: [],
  welcome: [],
  requested: [],
  places: {},
  ...over,
})
const whole = (rev: number, lobby: LobbyShared, epoch = 1): LobbySharedMessage => ({ type: 'lobbyShared', epoch, rev, lobby })
const delta = (base: number, members: MemberStatus[], epoch = 1): LobbySharedMessage => ({
  type: 'lobbyDelta',
  epoch,
  base,
  rev: base + 1,
  delta: { members },
})
const names = (lobby: LobbyShared) => lobby.members.map((m) => m.id).sort()

describe('the browser’s copy of the shared lobby', () => {
  const start: LobbyShared = { members: [member('amy'), member('ben')], tables: [], matches: [] }

  it('applies deltas in order, replacing and removing entries by id', () => {
    const lobby = applyLobbyDelta(
      { ...start, tables: [table('t1', 1, 1)] },
      { members: [member('cal')], gone: ['ben'], tables: [table('t2', 2, 3)], closed: ['t1'], matches: [] },
    )
    expect(names(lobby)).toEqual(['amy', 'cal'])
    expect(lobby.tables.map((t) => t.id)).toEqual(['t2'])
  })

  it('takes deltas out of order once the missing one comes, without asking', () => {
    let replica = receiveLobby(emptyReplica(), whole(1, start)).replica
    let step = receiveLobby(replica, delta(2, [member('dan')]))
    // Version 2 is missing: it waits and asks once
    expect(step.sync).toBe(true)
    expect(step.replica.copy!.rev).toBe(1)
    step = receiveLobby(step.replica, delta(3, [member('eve')]))
    expect(step.sync).toBe(false)
    step = receiveLobby(step.replica, delta(1, [member('cal')]))
    replica = step.replica
    expect(replica.copy!.rev).toBe(4)
    expect(names(replica.copy!.lobby)).toEqual(['amy', 'ben', 'cal', 'dan', 'eve'])
    expect(replica.early).toEqual([])
  })

  it('drops a delta it already has, and one from an earlier run of the club', () => {
    const replica = receiveLobby(receiveLobby(emptyReplica(), whole(1, start, 5)).replica, delta(1, [member('cal')], 5)).replica
    expect(receiveLobby(replica, delta(1, [member('dan')], 5))).toEqual({ replica, sync: false })
    expect(receiveLobby(replica, delta(9, [member('dan')], 4))).toEqual({ replica, sync: false })
  })

  it('asks for the whole lobby after a jump, and the whole lobby replaces the copy', () => {
    const replica = receiveLobby(emptyReplica(), whole(1, start)).replica
    const jumped = receiveLobby(replica, delta(7, [member('dan')]))
    expect(jumped.sync).toBe(true)
    // The whole lobby at version 9: the early delta (to 8) is older and dropped
    const after = receiveLobby(jumped.replica, whole(9, { ...start, members: [member('zed')] }))
    expect(after.sync).toBe(false)
    expect(after.replica).toEqual({ copy: { epoch: 1, rev: 9, lobby: { ...start, members: [member('zed')] } }, early: [], asked: false })
  })

  it('after the club restarted (a new epoch), waits for the whole lobby again', () => {
    const replica = receiveLobby(emptyReplica(), whole(40, start, 1)).replica
    const step = receiveLobby(replica, delta(1, [member('dan')], 2))
    expect(step.sync).toBe(true)
    const reconnected = receiveLobby(step.replica, whole(2, start, 2))
    // The early delta of the new run (1 → 2) is already in the whole lobby at 2
    expect(reconnected.replica.copy!.rev).toBe(2)
    expect(reconnected.replica.early).toEqual([])
  })

  it('a delta before any whole lobby waits for it', () => {
    const step = receiveLobby(emptyReplica(), delta(1, [member('dan')]))
    expect(step.sync).toBe(true)
    expect(step.replica.copy).toBeNull()
    expect(receiveLobby(step.replica, whole(1, start)).replica.copy!.rev).toBe(2)
  })

  it('puts the two parts together: the lobby’s order, friends on top, the viewer’s own tables and places', () => {
    const shared: LobbyShared = {
      members: [member('zoe'), member('amy', false), member('ben', true, 1), member('cal')],
      tables: [table('full', 1, 0), table('short', 2, 1)],
      matches: [],
    }
    const own = { ...table('hidden', 3, 2), settings: { access: 'hidden' as const, allowKibitz: true, boardMinutes: 0 }, welcome: true }
    const lobby = composeLobby(shared, mine({ friends: ['zoe', 'amy'], welcome: ['short'], requested: ['full'], tables: [own], places: { cal: { tableNumber: 3, seat: null } } }))
    expect(lobby.members.map((m) => m.id)).toEqual(['zoe', 'ben', 'cal', 'amy'])
    expect(lobby.members.find((m) => m.id === 'cal')).toMatchObject({ tableNumber: 3, seat: null })
    expect(lobby.tables.map((t) => [t.id, t.welcome, t.requested])).toEqual([
      ['short', true, undefined],
      ['hidden', true, undefined],
      ['full', false, true],
    ])
    expect(lobby.online.map((u) => u.id)).toEqual(['zoe', 'ben', 'cal'])
  })
})

/** A club whose connections keep each message and the string it went out as */
class Wire implements Connections {
  online = new Set<string>()
  inbox = new Map<string, { message: ServerMessage; data?: string }[]>()
  onlineUserIds() {
    return [...this.online]
  }
  send(userId: string, message: ServerMessage, data?: string) {
    this.inbox.set(userId, [...(this.inbox.get(userId) ?? []), { message, data }])
  }
  disconnect() {}
  messages(userId: string) {
    return (this.inbox.get(userId) ?? []).map((m) => m.message)
  }
  of(userId: string, type: ServerMessage['type']) {
    return (this.inbox.get(userId) ?? []).filter((m) => m.message.type === type)
  }
}

async function clubWith(config: { later?: (run: () => void, ms: number) => void } = {}) {
  const wire = new Wire()
  const clock = { time: 1_000_000 }
  const store = memoryStore()
  const make = () => new ClubService(store, wire, { maxUsers: 20, now: () => clock.time, schedule: () => undefined, ...config })
  let club = make()
  await club.load()
  const founder = await club.register('admin', 'secret1', '')
  const admin = 'user' in founder ? founder.user.id : ''
  const ids = [admin]
  for (const name of ['amy', 'ben', 'cal']) ids.push((await club.adminCreateUser(name, 'secret1')).id)
  for (const id of ids) {
    wire.online.add(id)
    club.connected(id)
  }
  return {
    wire,
    clock,
    ids,
    club: () => club,
    /** The object evicted and woken again, its sockets still open (hibernation) */
    restart: async () => {
      club = make()
      await club.load()
    },
  }
}

describe('the club’s lobby (H3b)', () => {
  it('sends the shared part as the very same string to everyone, then only what changed', async () => {
    const { wire, ids, club } = await clubWith()
    const [admin, amy, ben] = ids
    await club().handle(amy, { type: 'createTable' })
    const seen = new Map(ids.map((id) => [id, wire.messages(id).length]))
    const fresh = (id: string, type: ServerMessage['type']) => (wire.inbox.get(id) ?? []).slice(seen.get(id)).filter((m) => m.message.type === type)
    await club().handle(ben, { type: 'sit', tableId: club().lobbyView(amy).myTableId!, seat: 'N' })
    const deltas = ids.map((id) => fresh(id, 'lobbyDelta'))
    expect(deltas[0].length).toBeGreaterThan(0)
    for (const got of deltas) expect(got.map((m) => m.data)).toEqual(deltas[0].map((m) => m.data))
    // Only what changed: the table and Ben's place there, not the other members
    const last = deltas[0].at(-1)!.message as Extract<ServerMessage, { type: 'lobbyDelta' }>
    expect(JSON.parse(deltas[0].at(-1)!.data!)).toEqual(last)
    expect(last.delta.members?.map((m) => m.id)).toEqual([ben])
    expect(last.delta.tables).toHaveLength(1)
    // Ben's own part told him where he is; the admin's own part did not change, so it was not sent
    expect(fresh(ben, 'lobbyMine').at(-1)!.message).toMatchObject({ mine: { myTableId: club().lobbyView(amy).myTableId } })
    expect(fresh(admin, 'lobbyMine')).toEqual([])
    // A broadcast that changes nothing sends nothing
    const before = wire.messages(admin).length
    club().broadcast()
    expect(wire.messages(admin)).toHaveLength(before)
    for (const id of ids) expect(lobbyFrom(wire.messages(id))).toEqual(club().lobbyView(id))
  })

  it('sends the whole shared part on connecting and when asked (lobbySync)', async () => {
    const { wire, ids, club } = await clubWith()
    const [, amy, ben] = ids
    await club().handle(amy, { type: 'createTable' })
    wire.inbox.set(ben, [])
    await club().handle(ben, { type: 'lobbySync' })
    const [again] = wire.of(ben, 'lobbyShared')
    expect(again.message).toMatchObject({ type: 'lobbyShared', rev: (wire.of(amy, 'lobbyDelta').at(-1)!.message as { rev: number }).rev })
    expect(JSON.parse(again.data!)).toEqual(again.message)
    // A new connection starts with the whole of it
    wire.inbox.set(ben, [])
    club().connected(ben)
    expect(wire.of(ben, 'lobbyShared')).toHaveLength(1)
    expect(lobbyFrom(wire.messages(ben))).toEqual(club().lobbyView(ben))
  })

  it('after a restart sends everyone the whole lobby of a new epoch, which their copies take', async () => {
    const { wire, ids, club, restart, clock } = await clubWith()
    const [, amy] = ids
    const epoch = (wire.of(amy, 'lobbyShared')[0].message as { epoch: number }).epoch
    clock.time += 60_000
    await restart()
    await club().handle(amy, { type: 'createTable' })
    for (const id of ids) {
      const fresh = wire.of(id, 'lobbyShared').at(-1)!.message as { epoch: number }
      expect(fresh.epoch).toBeGreaterThan(epoch)
      expect(lobbyFrom(wire.messages(id))).toEqual(club().lobbyView(id))
    }
  })

  it('with a gap (the Durable Object), a crowd’s changes go out together, at most every LOBBY_GAP_MS', async () => {
    const timers: { run: () => void; ms: number }[] = []
    const { wire, ids, club, clock } = await clubWith({ later: (run, ms) => timers.push({ run, ms }) })
    const [admin, amy, ben, cal] = ids
    const deltas = () => wire.of(admin, 'lobbyDelta').length
    const gapOver = () => {
      clock.time += LOBBY_GAP_MS
      while (timers.length) timers.shift()!.run()
    }
    gapOver()
    clock.time += 1000
    let before = deltas()
    await club().handle(amy, { type: 'createTable' })
    const tableId = club().lobbyView(amy).myTableId!
    // The first change went out at once
    expect(deltas()).toBe(before + 1)
    gapOver()
    // Ben, Cal and the admin come in the same moment: Ben's seat goes out at once, the other two together after the gap
    clock.time += 1000
    before = deltas()
    await club().handle(ben, { type: 'sit', tableId, seat: 'N' })
    expect(deltas()).toBe(before + 1)
    await club().handle(cal, { type: 'sit', tableId, seat: 'E' })
    await club().handle(admin, { type: 'joinTable', tableId })
    expect(deltas()).toBe(before + 1)
    expect(timers.map((t) => t.ms)).toEqual([LOBBY_GAP_MS])
    gapOver()
    expect(deltas()).toBe(before + 2)
    expect(wire.of(ben, 'lobbyMine').at(-1)!.message).toMatchObject({ mine: { myTableId: tableId } })
    expect(wire.of(cal, 'lobbyMine').at(-1)!.message).toMatchObject({ mine: { myTableId: tableId } })
    for (const id of ids) expect(lobbyFrom(wire.messages(id))).toEqual(club().lobbyView(id))
    // Quiet for longer than the gap: the next change goes out at once again
    clock.time += 1000
    before = deltas()
    await club().handle(cal, { type: 'leaveTable' })
    expect(deltas()).toBe(before + 1)
  })
})

describe('sampled action logs (H3b)', () => {
  it('writes one quick action in ten, every failed or slow one, and everything else; the counts see them all', () => {
    const written: LogEntry[] = []
    const metrics = new Metrics(() => 1_000_000)
    let n = 0
    const sampled = sampleActions((entry) => written.push(entry), 10, () => (n++ % 10) / 10)
    const log = (entry: LogEntry) => {
      metrics.observe(entry)
      sampled(entry)
    }
    for (let i = 0; i < 100; i++) log({ event: 'action', type: 'play', user: 'u', ms: 2 })
    log({ event: 'action', type: 'play', user: 'u', ms: 2, code: 'notYourTurn' })
    log({ event: 'action', type: 'sit', user: 'u', ms: ACTION_SLOW_MS })
    log({ event: 'http', method: 'GET', path: '/api/me', status: 200, ms: 1 })
    log({ event: 'rejected', user: 'u', code: 'slowDown' })
    const actions = written.filter((e) => e.event === 'action')
    expect(actions.filter((e) => e.event === 'action' && e.sample === 10)).toHaveLength(10)
    expect(actions.filter((e) => e.event === 'action' && e.sample === undefined)).toHaveLength(2)
    expect(written.filter((e) => e.event !== 'action')).toHaveLength(2)
    expect(metrics.view()).toMatchObject({ actions: 102, refused: 1, requests: 1, rejected: 1 })
  })
})
