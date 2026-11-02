// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import type { Seat } from '../../shared/cards.ts'
import type { BoardState } from '../../shared/game.ts'
import { addSighting, INTEGRITY_LIMITS, integrityDays, SIGHTING_STEP_MS, type Sighting } from '../../shared/integrity.ts'
import type { BoardRecord, ServerMessage } from '../../shared/protocol.ts'
import { indexRecord } from '../../worker/history-index.ts'
import { ClubError, ClubService, type Connections } from '../../worker/service.ts'
import type { MemoryStore } from '../../worker/store.ts'
import { memoryStore } from './sqlite.ts'

/** The anti-cheating report (e11-t25, ARCHITECTURE.md §5.17) */

class NoConnections implements Connections {
  onlineUserIds() {
    return []
  }
  send(_userId: string, _message: ServerMessage) {}
  disconnect(_userId: string) {}
}

const DAY = 86_400_000
const SALT = 'test-salt-0123456789abcdef'
let store: MemoryStore
let club: ClubService
let time: number

beforeEach(async () => {
  store = memoryStore()
  time = 400 * DAY
  club = new ClubService(store, new NoConnections(), { maxUsers: 20, now: () => time, schedule: () => {}, seenSalt: SALT })
  await club.load()
})

async function join(name: string) {
  const result = await club.register(name, 'secret1', '')
  if ('user' in result) return result.user.id
  const application = club.adminApplications().find((a) => a.username === name)!
  return (await club.adminApprove(application.id)).id
}

let boardNo = 0
/** A finished board in the club's history index: who sat where, and in which challenge or match */
function board(players: Partial<Record<Seat, string>>, at: number, event?: { mode: 'challenge' | 'team'; id: string }) {
  const id = `b${++boardNo}`
  const record = {
    id,
    tableNumber: 1,
    finishedAt: at,
    players: Object.fromEntries(
      (['N', 'E', 'S', 'W'] as Seat[]).map((seat) => [seat, { id: players[seat] ?? `robot:tkb:${seat}`, username: seat }]),
    ),
    board: { boardNo: 1, dealer: 'N', vul: 'None', contract: null, result: { declarerTricks: 0, scoreNS: 0, claimed: false } } as unknown as BoardState,
    ...(event && { mode: event.mode, eventId: event.id }),
  } as BoardRecord
  indexRecord(store.sql, record)
  return id
}

const report = async (adminId: string, days?: unknown) => club.adminIntegrityReport(adminId, days)

describe('the anti-cheating report', () => {
  it('is for admins only', async () => {
    await join('boss')
    const amy = await join('amy')
    await expect(report(amy)).rejects.toMatchObject({ code: 'adminOnly', status: 403 })
    await expect(report(amy)).rejects.toBeInstanceOf(ClubError)
  })

  it('pairs two accounts used from one browser, stronger when they played together', async () => {
    const boss = await join('boss')
    const amy = await join('amy')
    const bob = await join('bob')
    await club.noteSighting(amy, '1.2.3.4', 'device-one', 'Chrome · Windows')
    await club.noteSighting(bob, '5.6.7.8', 'device-one', 'Chrome · Windows')
    let found = await report(boss)
    expect(found.networkOff).toBe(false)
    expect(found.pairs).toHaveLength(1)
    expect(found.pairs[0]).toMatchObject({ level: 'medium', devices: ['Chrome · Windows'], networks: 0, partners: 0, opponents: 0 })
    expect([found.pairs[0].a.username, found.pairs[0].b.username].sort()).toEqual(['amy', 'bob'])

    const partners = board({ N: amy, S: bob }, time - DAY)
    const opponents = board({ N: amy, E: bob }, time - 2 * DAY)
    board({ N: amy, E: boss }, time - DAY)
    found = await report(boss)
    expect(found.pairs[0]).toMatchObject({ level: 'high', partners: 1, opponents: 1, boards: [partners, opponents] })
  })

  it('pairs a small network weakly, and names who played a challenge after the other', async () => {
    const boss = await join('boss')
    const amy = await join('amy')
    const bob = await join('bob')
    await club.noteSighting(amy, '10.0.0.1', 'a-device', 'Safari · iPhone')
    await club.noteSighting(bob, '10.0.0.1', 'b-device', 'Firefox · Linux')
    expect((await report(boss)).pairs[0]).toMatchObject({ level: 'low', networks: 1, devices: [] })

    const challenge = { mode: 'challenge' as const, id: 'ch1' }
    board({ S: amy }, time - 3 * DAY, challenge)
    board({ S: amy }, time - 3 * DAY + 60_000, challenge)
    board({ S: bob }, time - DAY, challenge)
    // A team match's two rooms play at the same time
    board({ N: amy }, time - 5 * DAY, { mode: 'team', id: 'tm1' })
    board({ N: bob }, time - 5 * DAY, { mode: 'team', id: 'tm1' })
    // Only one of them in this one
    board({ S: amy }, time - DAY, { mode: 'challenge', id: 'ch2' })
    const pair = (await report(boss)).pairs[0]
    expect(pair.level).toBe('medium')
    expect(pair.events).toEqual([
      { id: 'ch1', mode: 'challenge', at: time - 3 * DAY, after: pair.a.id === bob ? 'a' : 'b' },
      { id: 'tm1', mode: 'team', at: time - 5 * DAY, after: null },
    ])
  })

  it('does not pair a network many members use, and only counts it', async () => {
    const boss = await join('boss')
    const ids = await Promise.all(['m1', 'm2', 'm3', 'm4', 'm5'].map(join))
    for (const [i, id] of ids.entries()) await club.noteSighting(id, '140.136.1.1', `dev-${i}-xxxxx`, 'Chrome · Android')
    const found = await report(boss)
    expect(INTEGRITY_LIMITS.sharedNetwork).toBe(4)
    expect(found.pairs).toEqual([])
    expect(found.shared).toEqual([{ label: expect.stringMatching(/^[0-9a-f]{6}$/), members: 5, lastSeen: time }])
    expect(found.seen).toBe(5)
  })

  it('looks only as far back as asked, 30 days unless 7 or 90', async () => {
    const boss = await join('boss')
    const amy = await join('amy')
    const bob = await join('bob')
    await club.noteSighting(amy, '', 'shared-device', 'Edge · Windows')
    await club.noteSighting(bob, '', 'shared-device', 'Edge · Windows')
    time += 20 * DAY
    expect((await report(boss)).days).toBe(30)
    expect((await report(boss, '7')).pairs).toEqual([])
    expect((await report(boss, '30')).pairs).toHaveLength(1)
    expect((await report(boss, 'everything')).days).toBe(30)
    time += 20 * DAY
    expect((await report(boss)).pairs).toEqual([])
    expect((await report(boss, 90)).pairs).toHaveLength(1)
  })

  it('never keeps the address itself, and keeps a hash the same for the same address', async () => {
    const boss = await join('boss')
    await club.noteSighting(boss, '203.0.113.9', 'boss-device', 'Chrome · macOS')
    const dump = JSON.stringify([...store.data.entries()])
    expect(dump).not.toContain('203.0.113.9')
    const [first] = (await store.get<Sighting[]>(`seen:${boss}`))!
    expect(first.net).toMatch(/^[0-9a-f]{16}$/)
    const amy = await join('amy')
    await club.noteSighting(amy, '203.0.113.9', 'amy-device', 'Chrome · macOS')
    expect((await store.get<Sighting[]>(`seen:${amy}`))![0].net).toBe(first.net)
  })

  it('salts with the Worker secret, never with anything in the club’s storage', async () => {
    const boss = await join('boss')
    await club.noteSighting(boss, '203.0.113.9', 'boss-device', 'Chrome · macOS')
    const dump = JSON.stringify([...store.data.entries()])
    expect(dump).not.toContain(SALT)
    expect(await store.get('meta:seenSalt')).toBeUndefined()
    const net = (await store.get<Sighting[]>(`seen:${boss}`))![0].net

    // Another secret (a rotated one, or another environment) gives another hash for the same address
    const other = memoryStore()
    const elsewhere = new ClubService(other, new NoConnections(), { maxUsers: 20, now: () => time, schedule: () => {}, seenSalt: 'another-salt-0123456789' })
    await elsewhere.load()
    const first = await elsewhere.register('boss', 'secret1', '')
    const otherBoss = 'user' in first ? first.user.id : ''
    await elsewhere.noteSighting(otherBoss, '203.0.113.9', 'boss-device', 'Chrome · macOS')
    expect((await other.get<Sighting[]>(`seen:${otherBoss}`))![0].net).not.toBe(net)
  })

  it('without SEEN_SALT keeps no network, only the browser, says so in the report, and logs it once', async () => {
    const logged: string[] = []
    store = memoryStore()
    club = new ClubService(store, new NoConnections(), {
      maxUsers: 20,
      now: () => time,
      schedule: () => {},
      seenSalt: 'too-short',
      log: (entry) => void logged.push(entry.event),
    })
    await club.load()
    const boss = await join('boss')
    const amy = await join('amy')
    const bob = await join('bob')
    await club.noteSighting(amy, '10.0.0.1', 'amy-device', 'Chrome · Windows')
    await club.noteSighting(bob, '10.0.0.1', 'shared-device', 'Chrome · Windows')
    await club.noteSighting(amy, '10.0.0.1', 'shared-device', 'Chrome · Windows')
    expect((await store.get<Sighting[]>(`seen:${amy}`))!.map((s) => s.net)).toEqual(['', ''])
    expect(logged.filter((event) => event === 'seenSaltMissing')).toHaveLength(1)
    const found = await report(boss)
    expect(found.networkOff).toBe(true)
    expect(found.pairs).toHaveLength(1)
    expect(found.pairs[0]).toMatchObject({ networks: 0, devices: ['Chrome · Windows'] })
    expect(found.shared).toEqual([])
  })

  it('ignores a device id that is not one the club makes', async () => {
    const boss = await join('boss')
    await club.noteSighting(boss, '', 'x'.repeat(200), 'Chrome · macOS')
    await club.noteSighting(boss, '', '<script>', 'Chrome · macOS')
    expect(await store.get(`seen:${boss}`)).toBeUndefined()
  })

  it('goes with a deleted account, and is in the member’s own data export', async () => {
    const boss = await join('boss')
    const amy = await join('amy')
    const bob = await join('bob')
    await club.noteSighting(amy, '', 'shared-device', 'Edge · Windows')
    await club.noteSighting(bob, '', 'shared-device', 'Edge · Windows')
    const exported = await club.exportAccount(amy, null)
    expect(exported.signIns).toEqual([{ net: '', device: 'shared-device', label: 'Edge · Windows', first: time, last: time }])
    await club.adminDeleteUser(boss, bob)
    expect(await store.get(`seen:${bob}`)).toBeUndefined()
    expect((await report(boss)).pairs).toEqual([])
  })
})

describe('sightings', () => {
  const seen = { net: 'n1', device: 'd1', label: 'Chrome · Windows' }

  it('writes the same browser and network again at most once an hour', () => {
    const list = addSighting([], seen, 1000)!
    expect(list).toEqual([{ ...seen, first: 1000, last: 1000 }])
    expect(addSighting(list, seen, 1000 + SIGHTING_STEP_MS - 1)).toBeNull()
    expect(addSighting(list, seen, 1000 + SIGHTING_STEP_MS)).toEqual([{ ...seen, first: 1000, last: 1000 + SIGHTING_STEP_MS }])
    expect(addSighting(list, { net: '', device: '', label: '' }, 5000)).toBeNull()
  })

  it('keeps the newest few, none older than 90 days', () => {
    let list: Sighting[] = []
    for (let i = 0; i < 30; i++) list = addSighting(list, { ...seen, device: `d${i}` }, i * DAY)!
    expect(list).toHaveLength(INTEGRITY_LIMITS.perMember)
    expect(list[0].device).toBe('d29')
    list = addSighting(list, { ...seen, device: 'late' }, 200 * DAY)!
    expect(list.map((s) => s.device)).toEqual(['late'])
  })

  it('reads the report window from the query', () => {
    expect(integrityDays('7')).toBe(7)
    expect(integrityDays(90)).toBe(90)
    expect(integrityDays(null)).toBe(30)
    expect(integrityDays('31')).toBe(30)
  })
})
