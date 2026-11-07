// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Seat } from '../../shared/cards.ts'
import { PRODUCT_FEATURES, PRODUCT_METRIC_MIN, type BoardRecord, type ProductFeature } from '../../shared/protocol.ts'
import { BACKUP_TABLES } from '../../worker/backup.ts'
import { BookTelemetry, dayOf, weekOf } from '../../worker/book-telemetry.ts'
import type { LogEntry } from '../../worker/log.ts'
import { hideSmallCells, PRODUCT_METRIC_TABLES, ProductMetrics, type RawRetentionRow } from '../../worker/product-metrics.ts'
import { adminWithTwoFactor } from './admin-two-factor.ts'
import { ClubError, ClubService, type Connections } from '../../worker/service.ts'
import type { MemoryStore, Sql } from '../../worker/store.ts'
import { memoryStore } from './sqlite.ts'

const DAY = 86_400_000
const WEEK = 7 * DAY
/** A Wednesday at noon UTC */
const START = Date.parse('2026-10-28T12:00:00Z')
const MIN = PRODUCT_METRIC_MIN

let store: MemoryStore
let time: number
let logs: LogEntry[]
let metrics: ProductMetrics

const make = () => new ProductMetrics(store.sql, { now: () => time, log: (e) => logs.push(e) })

beforeEach(() => {
  store = memoryStore()
  time = START
  logs = []
  metrics = make()
  metrics.createTables()
})

/** Counts the rows written, the way Durable Object storage bills them */
function countingWrites(sql: Sql) {
  let writes = 0
  const counted: Sql = {
    exec: (query, ...params) => {
      if (/^\s*(INSERT|UPDATE|DELETE)/i.test(query)) writes++
      return sql.exec(query, ...params)
    },
    transaction: (fn) => sql.transaction(fn),
  }
  return { counted, writes: () => writes }
}

const ids = (n: number, prefix = 'm') => Array.from({ length: n }, (_, i) => `${prefix}${i}`)

/** These members come now; they signed up at `joinedAt` */
async function come(members: string[], joinedAt = START - 100 * WEEK) {
  for (const id of members) metrics.member(id, joinedAt)
  await metrics.settled()
}

const dump = () => JSON.stringify(PRODUCT_METRIC_TABLES.map((t) => store.sql.exec(`SELECT * FROM ${t}`)))

describe('active members', () => {
  it('counts a member once a day and once a week, whatever they do', async () => {
    await come(ids(6))
    await come(ids(6))
    time += DAY
    await come(ids(6))
    const view = await metrics.view([])
    expect(view.days.at(-1)).toEqual({ day: dayOf(time), active: 6 })
    expect(view.days.at(-2)).toEqual({ day: dayOf(time - DAY), active: 6 })
    expect(view.weeks.at(-1)?.active).toBe(6)
  })

  it('still counts a member once after the object was evicted and forgot who it saw', async () => {
    await come(ids(5))
    metrics = make()
    await come(ids(5))
    expect((await metrics.view([])).days.at(-1)?.active).toBe(5)
  })

  it('writes for a member only the first time in a day and a week, also after an eviction', async () => {
    const { counted, writes } = countingWrites(store.sql)
    metrics = new ProductMetrics(counted, { now: () => time, log: () => {} })
    await come(['warm'])
    const before = writes()
    metrics.member('a', 0)
    await metrics.settled()
    // The day's hash, the week's hash and the retention count
    expect(writes() - before).toBe(3)
    const once = writes()
    metrics.member('a', 0)
    await metrics.settled()
    expect(writes()).toBe(once)
    metrics = new ProductMetrics(counted, { now: () => time, log: () => {} })
    metrics.member('a', 0)
    await metrics.settled()
    // The rollover's clearing runs once for the new object; nothing for the member
    const afterEviction = writes() - once
    time += DAY
    await come(['warm'])
    const newDay = writes()
    metrics.member('a', 0)
    await metrics.settled()
    expect(writes() - newDay).toBe(1)
    expect(afterEviction).toBeLessThanOrEqual(2)
  })

  it('never stores who it counted: no ids, and the hashes are gone with their period', async () => {
    await come(['memberid-1', 'memberid-2'])
    metrics.board('tableid-1', [])
    await metrics.settled()
    const today = dump()
    expect(today).not.toContain('memberid')
    expect(today).not.toContain('tableid')
    expect(store.sql.exec('SELECT * FROM product_seen').length).toBeGreaterThan(0)

    time += 8 * DAY
    metrics.count('puzzleSolved')
    await metrics.settled()
    const later = store.sql.exec<{ period: string }>('SELECT period FROM product_seen')
    expect(later).toEqual([])
    expect(store.sql.exec<{ period: string }>('SELECT period FROM product_salts')).toEqual([])
  })

  it('hashes one member differently in each period', async () => {
    await come(['a'])
    const first = store.sql.exec<{ period: string; hash: string }>('SELECT period, hash FROM product_seen ORDER BY period')
    expect(first).toHaveLength(2)
    expect(first[0].hash).not.toBe(first[1].hash)
    time += DAY
    await come(['a'])
    const second = store.sql.exec<{ period: string; hash: string }>('SELECT period, hash FROM product_seen ORDER BY period')
    const old = new Set(first.map((r) => r.hash))
    expect(second.filter((r) => r.period.startsWith('d:')).every((r) => !old.has(r.hash))).toBe(true)
  })

  it('rolls up a day nobody wrote after, when an admin looks', async () => {
    await come(ids(7))
    time += 3 * DAY
    const view = await metrics.view([])
    expect(view.days.find((d) => d.day === dayOf(START))?.active).toBe(7)
    expect(store.sql.exec("SELECT * FROM product_seen WHERE period LIKE 'd:%'")).toEqual([])
    // The week is not over: its hashes stay until it is
    expect(store.sql.exec("SELECT * FROM product_seen WHERE period LIKE 'w:%'")).toHaveLength(7)
  })
})

describe('what the view hides', () => {
  it('gives no number below the threshold, for any measure', async () => {
    await come(ids(MIN - 1))
    metrics.board('t', ['gib'])
    metrics.count('puzzleSolved')
    const view = await metrics.view(Array(3).fill(START - WEEK))
    expect(view.days.at(-1)?.active).toBeNull()
    expect(view.weeks.at(-1)).toMatchObject({ active: null, tables: null, boards: null, boardsPerTable: null })
    expect(view.boardsPerTable).toBeNull()
    expect(view.features.every((f) => f.count === null)).toBe(true)
    expect(JSON.stringify(view)).not.toMatch(/"(active|count|size|tables|boards)":[1-4]\b/)
  })

  it('shows the threshold itself', async () => {
    await come(ids(MIN))
    expect((await metrics.view([])).days.at(-1)?.active).toBe(MIN)
  })

  const WEEKS = ['2026-10-19']
  const row = (cohort: string | null, size: number, active: number): RawRetentionRow => ({ cohort, size, cells: new Map([[WEEKS[0], active]]) })
  const cells = (rows: RawRetentionRow[]) => hideSmallCells(rows, WEEKS).rows.map((r) => r.cells[0].active)

  it('hides a retention cell below the threshold, and everyone in a small signup week', () => {
    expect(cells([row(null, 30, 20), row('2026-10-12', 8, 4), row('2026-10-05', 3, 2), row('2026-09-28', 9, 5)])).toEqual([20, null, null, 5])
    expect(hideSmallCells([row(null, 4, 2)], WEEKS).rows[0].size).toBeNull()
  })

  it('hides a cell where everyone in the signup week came: it says what each of them did', () => {
    expect(cells([row(null, 30, 20), row('2026-10-12', 6, 6), row('2026-10-05', 9, 2)])).toEqual([20, null, null])
  })

  it('hides a second cell when one hidden cell could be worked out from the week’s total', () => {
    // 20 + 8 + 2 = 30 active: with the total on the page, the 2 would be 30 − 28
    expect(cells([row(null, 30, 20), row('2026-10-12', 9, 8), row('2026-10-05', 3, 2)])).toEqual([20, null, null])
  })

  it('hides the week’s total when the one hidden cell is all there is', () => {
    const { hiddenTotals, rows } = hideSmallCells([row(null, 6, 6)], WEEKS)
    expect(rows[0].cells[0].active).toBeNull()
    expect(hiddenTotals.has(WEEKS[0])).toBe(true)
  })

  it('leaves out the week under way from the retention table', async () => {
    await come(ids(10))
    const view = await metrics.view(Array(20).fill(START - 100 * WEEK))
    expect(view.retention.weeks).not.toContain(weekOf(START))
    expect(view.retention.weeks.at(-1)).toBe(weekOf(START - WEEK))
    expect(view.weeks.at(-1)?.active).toBe(10)
  })

  it('makes retention from counts: a signup week’s members in each later week', async () => {
    const joined = START - WEEK
    const cohort = weekOf(joined)
    await come(ids(10), joined)
    time += WEEK
    await come(ids(6), joined)
    time += WEEK
    const view = await metrics.view(Array(12).fill(joined))
    const row = view.retention.rows.find((r) => r.cohort === cohort)
    expect(row?.size).toBe(12)
    expect(row?.cells.find((c) => c.week === weekOf(START))?.active).toBe(10)
    expect(row?.cells.find((c) => c.week === weekOf(START + WEEK))?.active).toBe(6)
    expect(store.sql.exec('SELECT * FROM product_retention').length).toBe(2)
  })

  it('puts a signup week too small to show in that one row, not in a row of dashes', async () => {
    const small = START - 2 * WEEK
    await come(ids(10), START - 50 * WEEK)
    await come(ids(2, 'new'), small)
    time += WEEK
    const view = await metrics.view([...Array(12).fill(START - 50 * WEEK), ...Array(3).fill(small)])
    expect(view.retention.rows).toHaveLength(1)
    expect(view.retention.rows[0]).toMatchObject({ cohort: null, size: 15 })
    expect(view.retention.rows[0].cells.find((c) => c.week === weekOf(START))?.active).toBe(12)
  })

  it('puts everyone from before the table in one row', async () => {
    await come(ids(10), START - 50 * WEEK)
    time += WEEK
    const view = await metrics.view(Array(12).fill(START - 50 * WEEK))
    expect(view.retention.rows.map((r) => r.cohort)).toEqual([null])
    expect(view.retention.rows[0]).toMatchObject({ size: 12 })
    expect(view.retention.rows[0].cells.find((c) => c.week === weekOf(START))?.active).toBe(10)
  })
})

describe('boards and features', () => {
  it('counts boards and each table once a day, for boards per table', async () => {
    for (const table of ids(5, 't')) for (let i = 0; i < 4; i++) metrics.board(table, [])
    await metrics.settled()
    metrics = make()
    metrics.board('t0', [])
    const view = await metrics.view([])
    expect(view.weeks.at(-1)).toMatchObject({ tables: 5, boards: 21, boardsPerTable: 4.2 })
    expect(view.boardsPerTable).toBe(4.2)
  })

  it('counts boards with robots by bidding system, once a board', async () => {
    for (let i = 0; i < 5; i++) metrics.board('t', ['sayc', 'sayc', 'sayc'])
    metrics.board('t', ['precision'])
    const { features } = await metrics.view([])
    expect(features.find((f) => f.key === 'robotBoard:sayc')?.count).toBe(5)
    expect(features[0].key).toBe('robotBoard:sayc')
    expect(features.find((f) => f.key === 'robotBoard:precision')?.count).toBeNull()
  })

  it('only knows the closed list, and only reports the last 28 days', async () => {
    for (let i = 0; i < 6; i++) metrics.count('boardImport')
    await metrics.settled()
    expect((await metrics.view([])).features.find((f) => f.key === 'boardImport')?.count).toBe(6)
    expect((await metrics.view([])).features.map((f) => f.key).sort()).toEqual([...PRODUCT_FEATURES].sort())
    time += 29 * DAY
    expect((await metrics.view([])).features.find((f) => f.key === 'boardImport')?.count).toBeNull()
  })

  it('clears what is past its time on the first write of a day', async () => {
    await come(ids(6))
    metrics.count('boardImport')
    await metrics.settled()
    time += 181 * DAY
    metrics.count('boardImport')
    await metrics.settled()
    const days = store.sql.exec<{ day: string }>('SELECT DISTINCT day FROM product_metrics').map((r) => r.day)
    expect(days).toEqual([dayOf(time)])
    expect(store.sql.exec('SELECT * FROM product_retention')).toEqual([])
  })
})

describe('the switch', () => {
  it('is the same one as BridgeHall’s, both ways', async () => {
    const hall = new BookTelemetry(store.sql, { now: () => time, log: () => {} })
    hall.createTables()
    expect(metrics.setEnabled({ enabled: false })).toBe(true)
    expect(hall.enabled()).toBe(false)
    expect(hall.setEnabled({ enabled: true })).toBe(true)
    metrics.switched()
    expect(metrics.enabled()).toBe(true)
    expect(metrics.setEnabled({ enabled: 'no' })).toBe(false)
  })

  it('counts nothing while off, keeps no hash and keeps what it had', async () => {
    await come(ids(6))
    metrics.setEnabled({ enabled: false })
    expect(store.sql.exec('SELECT * FROM product_seen')).toEqual([])
    expect(store.sql.exec('SELECT * FROM product_salts')).toEqual([])
    await come(ids(6, 'other'))
    metrics.board('t', ['gib'])
    metrics.count('boardImport')
    const view = await metrics.view([])
    expect(view.enabled).toBe(false)
    expect(view.days.at(-1)?.active).toBe(6)
    expect(store.sql.exec('SELECT * FROM product_seen')).toEqual([])
    expect(view.features.every((f) => f.count === null)).toBe(true)
  })

  it('counts again once it is back on', async () => {
    metrics.setEnabled({ enabled: false })
    await come(ids(6))
    metrics.setEnabled({ enabled: true })
    await come(ids(6))
    expect((await metrics.view([])).days.at(-1)?.active).toBe(6)
  })
})

describe('the backup', () => {
  it('has none of it', () => {
    for (const table of PRODUCT_METRIC_TABLES) expect(BACKUP_TABLES.map((t) => t.name)).not.toContain(table)
  })
})

const noConnections: Connections = { onlineUserIds: () => [], send: () => {}, disconnect: () => {} }

describe('ClubService', () => {
  async function club() {
    const own = memoryStore()
    const service = new ClubService(own, noConnections, { maxUsers: 40, now: () => time, schedule: () => {} })
    await service.load()
    return { service, own }
  }

  async function join(service: ClubService, name: string) {
    const result = await service.register(name, 'club-secret-1', '')
    if ('user' in result) return result.user
    return service.adminApprove(service.adminApplications().find((a) => a.username === name)!.id)
  }

  async function admin(service: ClubService, name = 'gene') {
    const user = await join(service, name)
    await adminWithTwoFactor(service, user.id)
    return user
  }

  const code = async (work: () => Promise<unknown>) => {
    try {
      await work()
    } catch (error) {
      return error instanceof ClubError ? error.code : String(error)
    }
    return 'no error'
  }

  /** A finished board with a member in the south seat and robots of this system elsewhere */
  const record = (id: string, member: string, tableId: string): BoardRecord => {
    const robot = (seat: string) => ({ id: `robot:gib:${seat}`, username: 'TKB', robot: true, robotKind: 'gib' as const })
    const players = { N: robot('N'), E: robot('E'), S: { id: member, username: member }, W: robot('W') } as Record<Seat, BoardRecord['players'][Seat]>
    const board = { boardNo: 1, dealer: 'N', vul: 'None', contract: null, auction: [], play: [], result: { declarerTricks: 0, scoreNS: 0, claimed: false } } as unknown as BoardRecord['board']
    return { id, tableNumber: 1, finishedAt: time, players, board, tableId }
  }

  it('answers admins only, in the service itself', async () => {
    const { service } = await club()
    await admin(service)
    const member = await join(service, 'amy')
    expect(await code(() => service.adminProductMetrics(member.id))).toBe('adminOnly')
    expect(await code(() => service.adminSetProductMetrics(member.id, { enabled: false }))).toBe('adminOnly')
    expect(await code(() => service.adminProductMetrics('nobody'))).toBe('adminOnly')
  })

  it('wants an admin with two-step sign-in, as the other admin answers do', async () => {
    const { service } = await club()
    const user = await join(service, 'gene')
    expect(await code(() => service.adminProductMetrics(user.id))).toBe('adminTwoFactorRequired')
  })

  it('refuses a switch that is not one', async () => {
    const { service } = await club()
    const user = await admin(service)
    expect(await code(() => service.adminSetProductMetrics(user.id, { enabled: 'off' }))).toBe('badMessage')
    expect((await service.adminSetProductMetrics(user.id, { enabled: false })).enabled).toBe(false)
  })

  it('counts members from their connections, and boards with who played them', async () => {
    const { service } = await club()
    const user = await admin(service)
    const members = await Promise.all(ids(4).map((name) => join(service, name)))
    service.connected(user.id)
    for (const m of members) service.connected(m.id)
    const sixth = await join(service, 'sixth')
    await service.link.boardFinished(record('b1', sixth.id, 't1'), null)
    const view = await service.adminProductMetrics(user.id)
    expect(view.days.at(-1)?.active).toBe(6)
    expect(JSON.stringify(view)).not.toContain(sixth.id)
  })

  it('counts a board the table had to offer again once, when it finally got through', async () => {
    const { service, own } = await club()
    const user = await admin(service)
    const board = record('b2', user.id, 't2')
    const event = vi.spyOn(service as unknown as { boardReachedEvent: () => Promise<void> }, 'boardReachedEvent').mockRejectedValueOnce(new Error('the challenge is away'))
    await expect(service.link.boardFinished(board, null)).rejects.toThrow('the challenge is away')
    await service.link.boardFinished(board, null)
    expect(event).toHaveBeenCalledTimes(2)
    await service.adminProductMetrics(user.id)
    expect(own.sql.exec<{ count: number }>("SELECT count FROM product_metrics WHERE type = 'boards'")[0].count).toBe(1)
    expect(own.sql.exec<{ count: number }>("SELECT count FROM product_metrics WHERE key = 'robotBoard:gib'")[0].count).toBe(1)
  })

  it('keeps each club’s numbers in its own object', async () => {
    const tku = await club()
    const ntu = await club()
    const tkuAdmin = await admin(tku.service)
    const ntuAdmin = await admin(ntu.service)
    const members = await Promise.all(ids(5).map((name) => join(tku.service, name)))
    for (const m of members) tku.service.connected(m.id)
    expect((await tku.service.adminProductMetrics(tkuAdmin.id)).days.at(-1)?.active).toBe(5)
    expect((await ntu.service.adminProductMetrics(ntuAdmin.id)).days.at(-1)?.active).toBeNull()
    expect(ntu.own.sql.exec('SELECT * FROM product_seen')).toEqual([])
    await tku.service.adminSetProductMetrics(tkuAdmin.id, { enabled: false })
    expect((await ntu.service.adminProductMetrics(ntuAdmin.id)).enabled).toBe(true)
  })
})

const typed: ProductFeature[] = [...PRODUCT_FEATURES]
it('keeps the list of features small', () => {
  expect(typed.length).toBeLessThanOrEqual(12)
})
