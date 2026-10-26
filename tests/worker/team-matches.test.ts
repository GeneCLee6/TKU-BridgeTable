// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { makeDealSet } from '../../shared/deal-set.ts'
import type { ServerMessage } from '../../shared/protocol.ts'
import { defaultTeamMatchSettings } from '../../shared/team-match.ts'
import { ClubError, ClubService, type Connections } from '../../worker/service.ts'
import type { MemoryStore } from '../../worker/store.ts'
import { changeSettings, matchReady, newTeamMatch, parseHostSeat, seatOf } from '../../worker/team-match-flow.ts'
import { TeamMatchStore, type TeamMatch } from '../../worker/team-matches.ts'
import { teamMatchView } from '../../worker/views.ts'
import { memorySql, memoryStore } from './sqlite.ts'
import { clubService } from './event-mode.ts'

/** Team matches: the SQL tables, the steps before the start and the HTTP service (e8-t03) */

const T0 = 1_000_000

const match = (id: string, host: string, at = T0): TeamMatch =>
  newTeamMatch({ id, hostId: host, now: at, settings: defaultTeamMatchSettings(), seat: { room: 'open', seat: 'S' } })

const fresh = () => {
  const store = new TeamMatchStore(memorySql())
  store.createTables()
  return store
}

/** Every seat taken: the host, `others` in order, then robots */
function fill(m: TeamMatch, others: string[]): TeamMatch {
  const queue = [...others]
  return {
    ...m,
    seats: m.seats.map((s) => {
      if (s.userId) return s
      const userId = queue.shift()
      return userId ? { ...s, status: 'seated', userId, robot: false } : { ...s, status: 'seated', robot: true }
    }),
  }
}

describe('team match store', () => {
  it('reads a match back as it was written', () => {
    const store = fresh()
    const m = match('m1', 'amy')
    store.create(m)
    expect(store.get('m1')).toEqual(m)
    expect(store.get('nope')).toBeNull()
    expect(m.seats).toHaveLength(8)
    expect(m.seats.filter((s) => s.status === 'seated')).toEqual([
      { room: 'open', seat: 'S', status: 'seated', userId: 'amy', robot: false, answeredAt: T0 },
    ])
    expect(m.captains).toEqual({ A: 'amy' })
  })

  it('keeps seats, the start, each room’s results and rulings', () => {
    const store = fresh()
    store.create(match('m1', 'amy'))
    store.updateSeat('m1', { room: 'closed', seat: 'E', status: 'invited', userId: 'ben', robot: false, invitedAt: T0 + 1 })
    store.updateSeat('m1', { room: 'open', seat: 'W', status: 'seated', robot: true })
    store.setCaptainB('m1', 'cat')
    const deals = makeDealSet({ kind: 'random', count: 4 })!
    store.setStarted('m1', deals, { open: 't1', closed: 't2' }, T0 + 10)
    store.addResult('m1', 2, 'closed', { boardId: 'c2', scoreNS: -100, playedAt: T0 + 30 })
    store.addResult('m1', 1, 'open', { boardId: 'o1', scoreNS: 420, playedAt: T0 + 20 })
    store.addResult('m1', 1, 'closed', { boardId: 'c1', scoreNS: -50, playedAt: T0 + 25 })
    // Each room plays a board once
    expect(() => store.addResult('m1', 1, 'open', { boardId: 'o9', scoreNS: 0, playedAt: T0 + 40 })).toThrow()
    store.setRuling('m1', 3, { kind: 'avgPlus', team: 'B', reason: '超時', by: 'amy', at: T0 + 50 })

    const m = store.get('m1')!
    expect(m).toMatchObject({ status: 'playing', startedAt: T0 + 10, deals, tables: { open: 't1', closed: 't2' } })
    expect(m.captains).toEqual({ A: 'amy', B: 'cat' })
    expect(m.seats.find((s) => s.room === 'closed' && s.seat === 'E')).toMatchObject({ status: 'invited', userId: 'ben' })
    expect(m.seats.find((s) => s.room === 'open' && s.seat === 'W')).toEqual({ room: 'open', seat: 'W', status: 'seated', robot: true })
    expect(m.boards).toEqual([
      {
        seq: 1,
        open: { boardId: 'o1', scoreNS: 420, playedAt: T0 + 20 },
        closed: { boardId: 'c1', scoreNS: -50, playedAt: T0 + 25 },
      },
      { seq: 2, closed: { boardId: 'c2', scoreNS: -100, playedAt: T0 + 30 } },
      { seq: 3, ruling: { kind: 'avgPlus', team: 'B', reason: '超時', by: 'amy', at: T0 + 50 } },
    ])

    store.setRuling('m1', 3, null)
    expect(store.get('m1')!.boards[2]).toEqual({ seq: 3 })
    store.setStatus('m1', 'finished', T0 + 99)
    expect(store.get('m1')).toMatchObject({ status: 'finished', endedAt: T0 + 99 })
  })

  it('lists a member’s matches newest first, the open ones, and the open one they host', () => {
    const store = fresh()
    store.create(match('old', 'amy', T0))
    const seated = match('new', 'ben', T0 + 1000)
    seated.seats[0] = { ...seated.seats[0], status: 'invited', userId: 'amy', invitedAt: T0 + 1000 }
    store.create(seated)
    store.create(match('gone', 'cat', T0 + 2000))
    store.setStatus('gone', 'cancelled', T0 + 2001)
    expect(store.idsOf('amy')).toEqual(['new', 'old'])
    expect(store.idsOf('cat')).toEqual(['gone'])
    expect(store.idsOf('eve')).toEqual([])
    expect(store.openIds()).toEqual(['old', 'new'])
    expect(store.openHostedBy('amy')).toEqual(['old'])
    expect(store.openHostedBy('cat')).toEqual([])
  })

  it('creates its tables idempotently and keeps what is there', () => {
    const sql = memorySql()
    new TeamMatchStore(sql).createTables()
    new TeamMatchStore(sql).create(match('m1', 'amy'))
    new TeamMatchStore(sql).createTables()
    expect(new TeamMatchStore(sql).get('m1')?.seats).toHaveLength(8)
  })

  it('forgets a deleted account: cancels what they host, empties or robots their seats, keeps ended matches', () => {
    const store = fresh()
    store.create(match('hosted', 'ben'))
    store.create(fill(match('setup', 'amy'), ['ben']))
    store.setCaptainB('setup', 'ben')
    store.create(fill(match('playing', 'amy'), ['ben']))
    store.setStatus('playing', 'playing', T0 + 1)
    store.create(fill(match('done', 'amy'), ['ben']))
    store.setStatus('done', 'finished', T0 + 2)

    expect(store.forget('ben', T0 + 7).sort()).toEqual(['hosted', 'playing', 'setup'])
    expect(store.get('hosted')).toMatchObject({ status: 'cancelled', endedAt: T0 + 7 })
    const setup = store.get('setup')!
    expect(setup.captains).toEqual({ A: 'amy' })
    expect(seatOf(setup, 'ben')).toBeNull()
    expect(setup.seats.filter((s) => s.status === 'empty')).toHaveLength(1)
    const playing = store.get('playing')!
    expect(seatOf(playing, 'ben')).toBeNull()
    expect(playing.seats.filter((s) => s.robot)).toHaveLength(7)
    expect(seatOf(store.get('done')!, 'ben')).not.toBeNull()
  })
})

describe('team match steps before the start', () => {
  it('seats the host in one of team A’s seats', () => {
    expect(parseHostSeat(undefined)).toEqual({ room: 'open', seat: 'S' })
    expect(parseHostSeat({ room: 'closed', seat: 'W' })).toEqual({ room: 'closed', seat: 'W' })
    // Team B's seats and nonsense
    expect(parseHostSeat({ room: 'open', seat: 'E' })).toBeNull()
    expect(parseHostSeat({ room: 'closed', seat: 'N' })).toBeNull()
    expect(parseHostSeat({ room: 'lobby', seat: 'S' })).toBeNull()
    expect(parseHostSeat('S')).toBeNull()
  })

  it('lets only the host change settings, only before the start, and frees robots when they are turned off', () => {
    const m = fill(match('m1', 'amy'), ['ben', 'cat'])
    expect(changeSettings(m, 'ben', { boards: 12 })).toEqual({ error: 'matchHostOnly' })
    expect(changeSettings({ ...m, status: 'playing' }, 'amy', { boards: 12 })).toEqual({ error: 'matchStarted' })
    expect(changeSettings(m, 'amy', { boards: 3 })).toEqual({ error: 'badMatchSettings', params: { field: 'boards' } })
    expect(changeSettings(m, 'amy', { boards: 12 })).toEqual({ settings: { ...m.settings, boards: 12 }, freed: [] })
    const step = changeSettings(m, 'amy', { robots: false })
    expect('freed' in step && step.freed).toHaveLength(5)
  })

  it('is ready when every seat is taken, robots are allowed and every member is online', () => {
    const online = new Set(['amy', 'ben', 'cat'])
    const isOnline = (id: string) => online.has(id)
    expect(matchReady(match('m1', 'amy'), isOnline)).toEqual({ ready: false, reason: 'seats' })
    const full = fill(match('m1', 'amy'), ['ben', 'cat'])
    expect(matchReady(full, isOnline)).toEqual({ ready: true })
    expect(matchReady({ ...full, settings: { ...full.settings, robots: false } }, isOnline)).toEqual({ ready: false, reason: 'robots' })
    online.delete('cat')
    expect(matchReady(full, isOnline)).toEqual({ ready: false, reason: 'offline' })
    expect(matchReady({ ...full, status: 'playing' }, () => true)).toEqual({ ready: false, reason: 'seats' })
  })
})

describe('what members see of a match', () => {
  const user = (id: string) => ({ id, username: id })

  it('shows a match being set up only to the host and those with a seat', () => {
    const m = fill(match('m1', 'amy'), ['ben'])
    expect(teamMatchView(m, 'amy', user)).not.toBeNull()
    expect(teamMatchView(m, 'ben', user)?.seats.find((s) => s.userId === 'ben')).toMatchObject({ user: { id: 'ben' } })
    expect(teamMatchView(m, 'eve', user)).toBeNull()
    expect(teamMatchView({ ...m, status: 'cancelled' }, 'eve', user)).toBeNull()
    for (const status of ['playing', 'finished', 'abandoned'] as const) expect(teamMatchView({ ...m, status }, 'eve', user)).not.toBeNull()
  })

  it('shows only boards with a result, never one room’s score alone, and never the deals', () => {
    const m: TeamMatch = {
      ...fill(match('m1', 'amy'), ['ben']),
      status: 'playing',
      deals: makeDealSet({ kind: 'random', count: 8 })!,
      boards: [
        { seq: 1, open: { boardId: 'o1', scoreNS: 420, playedAt: T0 }, closed: { boardId: 'c1', scoreNS: -50, playedAt: T0 } },
        { seq: 2, open: { boardId: 'o2', scoreNS: 140, playedAt: T0 } },
        { seq: 3, ruling: { kind: 'avgPlus', team: 'B', reason: '超時', by: 'amy', at: T0 } },
      ],
    }
    const view = teamMatchView(m, 'eve', user)!
    expect(view.boards.map((b) => b.seq)).toEqual([1, 3])
    expect(view.boards[0]).toMatchObject({ open: { boardId: 'o1', scoreNS: 420 }, result: { A: 10, B: 0 } })
    expect(view.boards[1]).toEqual({ seq: 3, ruling: { kind: 'avgPlus', team: 'B', reason: '超時' }, result: { A: 0, B: 3, ruled: true } })
    expect(view.totals).toEqual({ A: 10, B: 3 })
    expect(view.leader).toBe('A')
    expect(JSON.stringify(view)).not.toContain('o2')
    expect(view).not.toHaveProperty('deals')
    expect(view.seats.map((s) => s.team)).toEqual(['A', 'B', 'A', 'B', 'B', 'A', 'B', 'A'])
  })
})

// ── Through the club (HTTP) ──────────────────────────────────────────────────────────────────

class FakeConnections implements Connections {
  onlineUserIds() {
    return []
  }
  send(_userId: string, _message: ServerMessage) {}
  disconnect() {}
}

let store: MemoryStore
let club: ClubService
let time: number
let bossId: string

beforeEach(async () => {
  store = memoryStore()
  time = T0
  club = clubService(store, new FakeConnections(), { maxUsers: 40, now: () => time, schedule: () => {} })
  await club.load()
  const boss = await club.register('boss', 'secret1', '')
  bossId = 'user' in boss ? boss.user.id : ''
})

async function member(name: string) {
  const result = await club.register(name, 'secret1', '')
  const user =
    'user' in result ? result.user : await club.adminApprove(club.adminApplications().find((a) => a.username === name)!.id)
  return user.id
}

/** The code a request was turned down with */
function refused(fn: () => unknown) {
  try {
    fn()
  } catch (error) {
    if (error instanceof ClubError) return error.code
    throw error
  }
  throw new Error('it was not turned down')
}

async function refusedAsync(fn: () => Promise<unknown>) {
  try {
    await fn()
  } catch (error) {
    if (error instanceof ClubError) return error.code
    throw error
  }
  throw new Error('it was not turned down')
}

describe('team matches through the club', () => {
  it('creates a match with settings and a seat, changes it, cancels it, and lists it', async () => {
    const amy = await member('amy')
    const created = club.matches.create(amy, { settings: { teamNames: ['淡江', '政大'], boards: 16 }, seat: { room: 'closed', seat: 'E' } })
    expect(created).toMatchObject({ hostId: amy, status: 'setup', captains: { A: amy }, boards: [], totals: { A: 0, B: 0 } })
    expect(created.settings).toMatchObject({ teamNames: ['淡江', '政大'], boards: 16, scoring: 'imp' })
    expect(created.seats.find((s) => s.userId === amy)).toMatchObject({ room: 'closed', seat: 'E', team: 'A', user: { username: 'amy' } })

    const changed = club.matches.update(amy, created.id, { scoring: 'bam', boardMinutes: 0 })
    expect(changed.settings).toMatchObject({ boards: 16, scoring: 'bam', boardMinutes: 0 })
    expect(club.matches.list(amy).map((m) => m.id)).toEqual([created.id])
    expect(club.matches.get(created.id, amy)?.settings.scoring).toBe('bam')

    time += 5
    expect(await club.matches.cancel(amy, created.id)).toMatchObject({ status: 'cancelled', endedAt: T0 + 5 })
    expect(await refusedAsync(() => club.matches.cancel(amy, created.id))).toBe('matchStarted')
    expect(refused(() => club.matches.update(amy, created.id, { boards: 8 }))).toBe('matchStarted')
    // Survives the object being evicted
    const again = clubService(store, new FakeConnections(), { maxUsers: 40, now: () => time, schedule: () => {} })
    await again.load()
    expect(again.matches.get(created.id, amy)?.status).toBe('cancelled')
  })

  it('turns down bad settings and seats, a second open match, strangers and non-hosts', async () => {
    const amy = await member('amy')
    const ben = await member('ben')
    expect(refused(() => club.matches.create(amy, { settings: { boards: 40 } }))).toBe('badMatchSettings')
    expect(refused(() => club.matches.create(amy, { seat: { room: 'open', seat: 'E' } }))).toBe('badMatchSettings')
    const { id } = club.matches.create(amy, {})
    expect(refused(() => club.matches.create(amy, {}))).toBe('matchOpen')
    // Others do not even learn it exists while it is set up
    expect(club.matches.get(id, ben)).toBeNull()
    expect(refused(() => club.matches.update(ben, id, { boards: 12 }))).toBe('matchGone')
    expect(await refusedAsync(() => club.matches.cancel(ben, 'nope'))).toBe('matchGone')
    expect(club.matches.list(ben)).toEqual([])
    // Once it ended the host may open another
    await club.matches.cancel(amy, id)
    expect(club.matches.create(amy, {}).status).toBe('setup')
  })

  it('cancels a match being set up when its host’s account is deleted', async () => {
    const amy = await member('amy')
    const { id } = club.matches.create(amy, {})
    await club.adminDeleteUser(bossId, amy)
    expect(club.matches.store.get(id)?.status).toBe('cancelled')
  })
})
