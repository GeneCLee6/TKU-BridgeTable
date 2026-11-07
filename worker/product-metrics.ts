import { PRODUCT_FEATURES, PRODUCT_METRIC_MIN } from '../shared/protocol.ts'
import type { ProductFeature, ProductMetricsView, ProductRetentionRow, ProductWeek, RobotKind } from '../shared/protocol.ts'
import { analyticsEnabled, dayOf, setAnalyticsEnabled, TELEMETRY_SETTINGS_SCHEMA, weekOf } from './book-telemetry.ts'
import type { LogEntry } from './log.ts'
import type { Sql } from './store.ts'

/**
 * How much the site is used, for the club's admins (e12-t17, AC-12.9, ARCHITECTURE.md §5.27): counted
 * on the server, from what the club already handles, in the club object's SQLite. Four tables, none
 * of them in the daily backup (backup.ts BACKUP_TABLES), so a restore leaves them as they are:
 *
 * - `product_metrics`: counts per UTC day, type and key, kept PRODUCT_METRICS_DAYS days
 * - `product_retention`: how many members of a signup week were active in a week, kept
 *   PRODUCT_RETENTION_WEEKS weeks. Who they were is not kept
 * - `product_seen`: this day's and this week's keyed hashes of members (and this day's of tables),
 *   only so that nobody counts twice
 * - `product_salts`: the random key of each of those periods
 *
 * A period's hashes and its key are deleted together on the first write after it ends, so afterwards
 * nothing can tell whether a member of one period is a member of another. `product_seen` has no
 * rowid: its rows are in hash order, not in the order people came.
 *
 * Small numbers identify people in a small club, so the view, not the page, hides them
 * (`hideSmallCells`). The switch is BridgeHall's `analytics` setting: one for the club, both sites.
 */

export const PRODUCT_METRICS_DAYS = 180
/** This week and the twelve before it */
export const PRODUCT_RETENTION_WEEKS = 13
const VIEW_DAYS = 28
const VIEW_WEEKS = 12
/** Finished weeks in the retention table */
const VIEW_RETENTION_WEEKS = 8
/** The weeks behind the headline boards per table */
const HEADLINE_WEEKS = 4
const DAY_MS = 86_400_000
const WEEK_MS = 7 * DAY_MS

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS product_metrics (
    day TEXT NOT NULL,
    type TEXT NOT NULL,
    key TEXT NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (day, type, key)
  ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS product_retention (
    week TEXT NOT NULL,
    cohort TEXT NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (week, cohort)
  ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS product_seen (
    period TEXT NOT NULL,
    hash TEXT NOT NULL,
    PRIMARY KEY (period, hash)
  ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS product_salts (
    period TEXT PRIMARY KEY,
    salt TEXT NOT NULL
  ) WITHOUT ROWID`,
]

/** The tables this module keeps; none of them is backed up */
export const PRODUCT_METRIC_TABLES = ['product_metrics', 'product_retention', 'product_seen', 'product_salts'] as const

/** `product_metrics.type` for each kind of count */
type MetricType = 'active' | 'tables' | 'boards' | 'feature'

const hide = (n: number) => (n < PRODUCT_METRIC_MIN ? null : n)
const toHex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
const average = (boards: number, tables: number) => (tables >= PRODUCT_METRIC_MIN ? Math.round((boards / tables) * 10) / 10 : null)

/** A keyed hash that only this period's salt can reproduce */
async function keyedHash(salt: string, id: string) {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', encoder.encode(salt), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return toHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(id))).slice(0, 16))
}

/** A row of the retention table before anything is hidden; `size` is how many signed up then */
export interface RawRetentionRow {
  cohort: string | null
  size: number
  /** Active members per week */
  cells: Map<string, number>
}

/**
 * What the view may say about each cell, and the weeks whose total must go too:
 * - fewer than PRODUCT_METRIC_MIN members in the cell or in the signup week: hidden
 * - everyone in the signup week active: hidden, it says what each of them did
 * - the only hidden cell of its week: a week's cells add up to its active members, so the total would
 *   give it away. The next smallest cell goes too, or the total when there is no other cell
 */
export function hideSmallCells(rows: readonly RawRetentionRow[], weeks: readonly string[]): { rows: ProductRetentionRow[]; hiddenTotals: Set<string> } {
  const shown = rows.map((row) => {
    const cells = new Map<string, number | null>()
    for (const week of weeks) {
      if (row.cohort !== null && row.cohort > week) continue
      const active = row.cells.get(week) ?? 0
      cells.set(week, row.size < PRODUCT_METRIC_MIN || active < PRODUCT_METRIC_MIN || active >= row.size ? null : active)
    }
    return { row, cells }
  })
  const hiddenTotals = new Set<string>()
  for (const week of weeks) {
    const inWeek = shown.filter((s) => s.cells.has(week))
    if (inWeek.filter((s) => s.cells.get(week) === null).length !== 1) continue
    const visible = inWeek.filter((s) => s.cells.get(week) !== null)
    if (!visible.length) {
      hiddenTotals.add(week)
      continue
    }
    const smallest = visible.reduce((a, b) => (b.cells.get(week)! < a.cells.get(week)! ? b : a))
    smallest.cells.set(week, null)
  }
  return {
    rows: shown.map(({ row, cells }) => ({
      cohort: row.cohort,
      size: hide(row.size),
      cells: [...cells].map(([week, active]) => ({ week, active })),
    })),
    hiddenTotals,
  }
}

export interface ProductMetricsOptions {
  now: () => number
  log: (entry: LogEntry) => void
}

export class ProductMetrics {
  private readonly sql: Sql
  private readonly now: () => number
  private readonly log: (entry: LogEntry) => void
  /** Who was already counted today, so that they cost nothing until the object is evicted. Never stored */
  private readonly members = new Set<string>()
  private readonly tables = new Set<string>()
  private memoryDay = ''
  /** The day the finished periods were last rolled up, so it happens once a day at most */
  private rolledDay = ''
  /** Hashing waits for WebCrypto; one at a time, so a member is never checked twice at once */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(sql: Sql, options: ProductMetricsOptions) {
    this.sql = sql
    this.now = options.now
    this.log = options.log
  }

  createTables() {
    for (const statement of SCHEMA) this.sql.exec(statement)
    this.sql.exec(TELEMETRY_SETTINGS_SCHEMA)
  }

  enabled() {
    return analyticsEnabled(this.sql)
  }

  /** Turns counting on or off, for both sites; false when the body is not `{ enabled: boolean }` */
  setEnabled(body: unknown): boolean {
    if (!setAnalyticsEnabled(this.sql, body)) return false
    this.switched()
    return true
  }

  /**
   * The switch changed: while it is off no hash stays behind, today's are added to the counts at once.
   * A member who comes back after it is turned on again the same day counts again that day
   */
  switched() {
    this.members.clear()
    this.tables.clear()
    this.rolledDay = ''
    if (!this.enabled()) this.sql.transaction(() => this.rollUp([]))
  }

  private enqueue(where: string, task: () => Promise<void>) {
    this.queue = this.queue.then(task).catch((error: unknown) => {
      this.log({ event: 'crash', where, error: error instanceof Error ? error.message : String(error) })
    })
  }

  private forToday(now: number) {
    const day = dayOf(now)
    if (this.memoryDay === day) return
    this.memoryDay = day
    this.members.clear()
    this.tables.clear()
  }

  /** This period's random key, made the first time it is needed */
  private salt(period: string): string {
    const known = this.sql.exec<{ salt: string }>('SELECT salt FROM product_salts WHERE period = ?', period)[0]
    if (known) return known.salt
    const salt = toHex(crypto.getRandomValues(new Uint8Array(32)))
    this.sql.exec('INSERT INTO product_salts (period, salt) VALUES (?, ?)', period, salt)
    return salt
  }

  private seen(period: string, hash: string) {
    return this.sql.exec('SELECT 1 AS yes FROM product_seen WHERE period = ? AND hash = ?', period, hash).length > 0
  }

  private add(day: string, type: MetricType, key: string, count = 1) {
    this.sql.exec(
      'INSERT INTO product_metrics (day, type, key, count) VALUES (?, ?, ?, ?) ON CONFLICT (day, type, key) DO UPDATE SET count = count + excluded.count',
      day,
      type,
      key,
      count,
    )
  }

  private live(period: string) {
    return this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM product_seen WHERE period = ?', period)[0]?.n ?? 0
  }

  /** Turns every period but `keep` into counts and deletes its hashes and key */
  private rollUp(keep: readonly string[]) {
    const periods = new Set(this.sql.exec<{ period: string }>('SELECT period FROM product_salts').map((r) => r.period))
    for (const r of this.sql.exec<{ period: string }>('SELECT DISTINCT period FROM product_seen')) periods.add(r.period)
    for (const period of periods) {
      if (keep.includes(period)) continue
      // A week's members are in `product_retention` already
      const type = period.startsWith('d:') ? 'active' : period.startsWith('t:') ? 'tables' : null
      const n = type ? this.live(period) : 0
      if (type && n) this.add(period.slice(2), type, '', n)
      this.sql.exec('DELETE FROM product_seen WHERE period = ?', period)
      this.sql.exec('DELETE FROM product_salts WHERE period = ?', period)
    }
  }

  /** The first write of a day: rolls up what ended and clears what is past its time */
  private rollOver(now: number) {
    const day = dayOf(now)
    if (this.rolledDay === day) return
    this.rolledDay = day
    this.sql.transaction(() => {
      this.rollUp([`d:${day}`, `t:${day}`, `w:${weekOf(now)}`])
      this.sql.exec('DELETE FROM product_metrics WHERE day < ?', dayOf(now - (PRODUCT_METRICS_DAYS - 1) * DAY_MS))
      this.sql.exec('DELETE FROM product_retention WHERE week < ?', weekOf(now - (PRODUCT_RETENTION_WEEKS - 1) * WEEK_MS))
    })
  }

  /**
   * A member did something today. Costs nothing after the first time until the object is evicted,
   * and only a hash and a read after that: the writes are once a day and once a week
   */
  member(userId: string, joinedAt: number) {
    const now = this.now()
    this.forToday(now)
    if (this.members.has(userId)) return
    this.members.add(userId)
    this.enqueue('productMember', async () => {
      if (!this.enabled()) return
      this.rollOver(now)
      const day = `d:${dayOf(now)}`
      const week = `w:${weekOf(now)}`
      const dayHash = await keyedHash(this.salt(day), userId)
      if (this.seen(day, dayHash)) return
      const weekHash = await keyedHash(this.salt(week), userId)
      // The switch may have been turned off while hashing
      if (!this.enabled()) return
      this.sql.transaction(() => {
        this.sql.exec('INSERT OR IGNORE INTO product_seen (period, hash) VALUES (?, ?)', day, dayHash)
        if (this.seen(week, weekHash)) return
        this.sql.exec('INSERT INTO product_seen (period, hash) VALUES (?, ?)', week, weekHash)
        this.sql.exec(
          'INSERT INTO product_retention (week, cohort, count) VALUES (?, ?, 1) ON CONFLICT (week, cohort) DO UPDATE SET count = count + 1',
          weekOf(now),
          weekOf(joinedAt),
        )
      })
    })
  }

  /** A feature was used; one row, in a request that was happening anyway */
  count(feature: ProductFeature) {
    const now = this.now()
    this.enqueue('productFeature', async () => {
      if (!this.enabled()) return
      this.rollOver(now)
      this.add(dayOf(now), 'feature', feature)
    })
  }

  /** A board finished at a table: the board, the table once a day, and the robots' systems */
  board(tableId: string | undefined, robotKinds: readonly RobotKind[]) {
    const now = this.now()
    this.forToday(now)
    const newTable = tableId !== undefined && !this.tables.has(tableId)
    if (newTable) this.tables.add(tableId)
    this.enqueue('productBoard', async () => {
      if (!this.enabled()) return
      this.rollOver(now)
      const today = dayOf(now)
      const period = `t:${today}`
      const hash = newTable ? await keyedHash(this.salt(period), tableId) : null
      if (!this.enabled()) return
      this.sql.transaction(() => {
        this.add(today, 'boards', '')
        for (const kind of new Set(robotKinds)) this.add(today, 'feature', `robotBoard:${kind}`)
        if (hash) this.sql.exec('INSERT OR IGNORE INTO product_seen (period, hash) VALUES (?, ?)', period, hash)
      })
    })
  }

  /** Waits for what is being counted */
  async settled() {
    await this.queue
  }

  private retention(now: number, joinedAt: readonly number[]) {
    const thisWeek = weekOf(now)
    const weeks: string[] = []
    for (let i = VIEW_RETENTION_WEEKS; i >= 1; i--) weeks.push(weekOf(now - i * WEEK_MS))
    const first = weeks[0]
    const sizes = new Map<string, number>()
    for (const at of joinedAt) {
      const cohort = weekOf(at)
      if (cohort < thisWeek) sizes.set(cohort, (sizes.get(cohort) ?? 0) + 1)
    }
    // A signup week too small to show would be all dashes, and hide its neighbours with it (a club
    // rarely has five signups in a week): it goes in one row with everyone from before the table
    const ownRow = (cohort: string) => cohort >= first && (sizes.get(cohort) ?? 0) >= PRODUCT_METRIC_MIN
    let others = 0
    for (const [cohort, size] of sizes) if (!ownRow(cohort)) others += size
    const otherCells = new Map<string, number>()
    const cells = new Map<string, Map<string, number>>()
    // The week under way is left out: it would tell whose signup week just came in, as they come
    for (const row of this.sql.exec<{ week: string; cohort: string; count: number }>(
      'SELECT week, cohort, count FROM product_retention WHERE week >= ? AND week < ?',
      first,
      thisWeek,
    )) {
      if (!ownRow(row.cohort)) otherCells.set(row.week, (otherCells.get(row.week) ?? 0) + row.count)
      else {
        if (!cells.has(row.cohort)) cells.set(row.cohort, new Map())
        cells.get(row.cohort)!.set(row.week, row.count)
      }
    }
    const rows: RawRetentionRow[] = []
    if (others || otherCells.size) rows.push({ cohort: null, size: others, cells: otherCells })
    for (const cohort of weeks) {
      if (ownRow(cohort)) rows.push({ cohort, size: sizes.get(cohort)!, cells: cells.get(cohort) ?? new Map<string, number>() })
    }
    return { weeks, ...hideSmallCells(rows, weeks) }
  }

  /**
   * `GET /api/admin/product-metrics`: the last 28 days and twelve weeks (the current ones included,
   * in UTC) and the eight finished weeks of the retention table. Every number below
   * PRODUCT_METRIC_MIN is null. `joinedAt` is when each member signed up, nothing more
   */
  async view(joinedAt: readonly number[]): Promise<ProductMetricsView> {
    await this.settled()
    const now = this.now()
    const today = dayOf(now)
    this.rollOver(now)

    const since = weekOf(now - (VIEW_WEEKS - 1) * WEEK_MS)
    const recent = dayOf(now - (VIEW_DAYS - 1) * DAY_MS)
    const daily = new Map<string, number>()
    const weekly = new Map<string, { tables: number; boards: number }>()
    const features = new Map<string, number>()
    const ofWeek = (day: string) => {
      const week = weekOf(Date.parse(`${day}T00:00:00Z`))
      if (!weekly.has(week)) weekly.set(week, { tables: 0, boards: 0 })
      return weekly.get(week)!
    }
    for (const row of this.sql.exec<{ day: string; type: MetricType; key: string; count: number }>('SELECT day, type, key, count FROM product_metrics WHERE day >= ?', since)) {
      if (row.type === 'active') daily.set(row.day, row.count)
      else if (row.type === 'tables') ofWeek(row.day).tables += row.count
      else if (row.type === 'boards') ofWeek(row.day).boards += row.count
      else if (row.day >= recent) features.set(row.key, (features.get(row.key) ?? 0) + row.count)
    }
    // Today's are still hashes
    const activeToday = this.live(`d:${today}`)
    daily.set(today, (daily.get(today) ?? 0) + activeToday)
    ofWeek(today).tables += this.live(`t:${today}`)

    const days: ProductMetricsView['days'] = []
    for (let i = VIEW_DAYS - 1; i >= 0; i--) {
      const day = dayOf(now - i * DAY_MS)
      days.push({ day, active: hide(daily.get(day) ?? 0) })
    }

    const retention = this.retention(now, joinedAt)
    const actives = new Map(
      this.sql.exec<{ week: string; n: number }>('SELECT week, SUM(count) AS n FROM product_retention WHERE week >= ? GROUP BY week', since).map((r) => [r.week, r.n]),
    )
    const weeks: ProductWeek[] = []
    let tables = 0
    let boards = 0
    for (let i = VIEW_WEEKS - 1; i >= 0; i--) {
      const week = weekOf(now - i * WEEK_MS)
      const counts = weekly.get(week) ?? { tables: 0, boards: 0 }
      if (i < HEADLINE_WEEKS) {
        tables += counts.tables
        boards += counts.boards
      }
      weeks.push({
        week,
        active: retention.hiddenTotals.has(week) ? null : hide(actives.get(week) ?? 0),
        tables: hide(counts.tables),
        boards: hide(counts.boards),
        boardsPerTable: average(counts.boards, counts.tables),
      })
    }

    const first = this.sql.exec<{ day: string | null }>('SELECT MIN(day) AS day FROM product_metrics')[0]?.day ?? null
    return {
      enabled: this.enabled(),
      minCount: PRODUCT_METRIC_MIN,
      since: first ?? (activeToday ? today : null),
      days,
      weeks,
      boardsPerTable: average(boards, tables),
      retention: { weeks: retention.weeks, rows: retention.rows },
      features: PRODUCT_FEATURES.map((key) => ({ key, count: hide(features.get(key) ?? 0) })).sort((a, b) => (b.count ?? 0) - (a.count ?? 0)),
    }
  }
}
