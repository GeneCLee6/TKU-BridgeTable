import type {
  BookAnalyticsEvent,
  BookAnalyticsView,
  BookAnalyticsWeek,
  BookClientError,
} from '../shared/protocol.ts'
import { scrub } from '../shared/scrub.ts'
import { CLIENT_ERROR_FIELD_MAX, CLIENT_ERROR_MAX_CHARS } from './client-errors.ts'
import type { LogEntry } from './log.ts'
import { BOOK_EVENT_BURST, BOOK_EVENTS_PER_SECOND, CLIENT_ERROR_BURST, CLIENT_ERRORS_PER_SECOND, TokenBuckets } from './rate-limit.ts'
import type { Sql, SqlValue } from './store.ts'

/**
 * TKU-BridgeHall's error reports (e10-t06) and anonymous usage counts (e10-t07), in the club
 * object's SQLite database (ARCHITECTURE.md §5.15). Four tables, none of them in the daily backup
 * (backup.ts BACKUP_TABLES), so a restore leaves them as they are:
 *
 * - `book_errors`: the latest BOOK_ERRORS_KEPT browser errors, cleaned; the same kind, message,
 *   source and page make one row with a count
 * - `book_metrics`: counts per UTC day, type and key, kept BOOK_METRICS_DAYS days; never a member,
 *   a profile or the visitor id
 * - `book_visitors`: each ISO week's random visitor ids, only to count a week's visitors; kept
 *   BOOK_VISITOR_WEEKS weeks
 * - `book_telemetry_settings`: whether the club counts usage (`analytics`, on unless an admin
 *   turns it off)
 *
 * Neither POST reads who is signed in. Both are rate limited for the whole club; what is over the
 * limit, and usage while counting is off, is dropped without telling the browser.
 */

export const BOOK_ERRORS_KEPT = 100
/** The largest usage batch the server reads (characters) and how many events it may hold */
export const BOOK_EVENTS_MAX_CHARS = 16_384
export const BOOK_EVENTS_PER_BATCH = 50
export const BOOK_METRICS_DAYS = 180
/** This week and the twelve before it: what the twelve-week chart needs, and no more */
export const BOOK_VISITOR_WEEKS = 13
const VIEW_WEEKS = 12
const VIEW_DAYS = 28
const VIEW_TOP = 20
const PATH_MAX = 200
const QUERY_MAX = 50
const DAY_MS = 86_400_000

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS book_errors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    message TEXT NOT NULL,
    source TEXT,
    stack TEXT,
    page TEXT,
    version TEXT,
    count INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS book_errors_by_time ON book_errors (at)',
  `CREATE TABLE IF NOT EXISTS book_metrics (
    day TEXT NOT NULL,
    type TEXT NOT NULL,
    key TEXT NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (day, type, key)
  ) WITHOUT ROWID`,
  'CREATE INDEX IF NOT EXISTS book_metrics_by_type ON book_metrics (type, day)',
  `CREATE TABLE IF NOT EXISTS book_visitors (
    week TEXT NOT NULL,
    visitor TEXT NOT NULL,
    PRIMARY KEY (week, visitor)
  ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS book_telemetry_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) WITHOUT ROWID`,
]

/** The tables this module keeps; none of them is backed up */
export const BOOK_TELEMETRY_TABLES = ['book_errors', 'book_metrics', 'book_visitors', 'book_telemetry_settings'] as const

const ERROR_KINDS = ['error', 'rejection', 'boundary'] as const
const PROFILE_KINDS = ['club', 'team', 'pair', 'personal'] as const
const SLUG = /^[\w-]{1,100}$/
const VISITOR = /^[A-Za-z0-9_-]{16,64}$/

type ErrorReport = Omit<BookClientError, 'id' | 'at' | 'count'>

/** `book_metrics.type` for each kind of count */
type MetricType = 'page' | 'convention' | 'search' | 'profile' | 'quiz'

/** UTC day, YYYY-MM-DD */
export const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/** The Monday (UTC) of the week `ms` is in, YYYY-MM-DD */
export function weekOf(ms: number) {
  const days = Math.floor(ms / DAY_MS)
  // 1970-01-01 was a Thursday: three days after a Monday
  return dayOf((days - ((days + 3) % 7)) * DAY_MS)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function parseJson(raw: string, max: number): Record<string, unknown> | null {
  if (raw.length > max) return null
  try {
    const data: unknown = JSON.parse(raw)
    return isRecord(data) ? data : null
  } catch {
    return null
  }
}

const cleaned = (value: unknown, max: number) => (typeof value === 'string' && value ? scrub(value, max) || undefined : undefined)

/** The path of a page address, without its query and fragment */
const pathOnly = (value: string) => value.split(/[?#]/)[0]

/** Reads an error report from `POST /api/book/errors`; null when it is not one */
export function parseBookError(raw: string): ErrorReport | null {
  const body = parseJson(raw, CLIENT_ERROR_MAX_CHARS)
  if (!body) return null
  const kind = ERROR_KINDS.find((k) => k === body.kind)
  const message = cleaned(body.message, CLIENT_ERROR_FIELD_MAX.message)
  if (!kind || !message) return null
  const report: ErrorReport = { kind, message }
  const source = cleaned(body.source, CLIENT_ERROR_FIELD_MAX.field)
  const stack = cleaned(body.stack, CLIENT_ERROR_FIELD_MAX.stack)
  const page = typeof body.page === 'string' ? cleaned(pathOnly(body.page), CLIENT_ERROR_FIELD_MAX.field) : undefined
  const version = cleaned(body.version, CLIENT_ERROR_FIELD_MAX.version)
  if (source) report.source = source
  if (stack) report.stack = stack
  if (page) report.page = page
  if (version) report.version = version
  return report
}

/** A search as it is counted: lower case, spaces merged; null when empty */
export const searchKey = (query: string) => query.trim().toLowerCase().replace(/\s+/g, ' ') || null

/** What one event adds to the counts, or null when it is not a valid event (it is dropped) */
export function eventMetrics(event: unknown): [MetricType, string][] | null {
  if (!isRecord(event)) return null
  const e = event as Partial<Record<keyof BookAnalyticsEvent, unknown>>
  const slug = e.slug === undefined ? undefined : typeof e.slug === 'string' && SLUG.test(e.slug) ? e.slug : null
  if (slug === null) return null
  switch (e.type) {
    case 'page': {
      if (typeof e.path !== 'string') return null
      const path = pathOnly(e.path)
      if (!path.startsWith('/') || path.length > PATH_MAX) return null
      const metrics: [MetricType, string][] = [['page', scrub(path, PATH_MAX)]]
      if (slug) metrics.push(['convention', slug])
      return metrics
    }
    case 'search': {
      if (typeof e.query !== 'string' || e.query.trim().length > QUERY_MAX) return null
      const key = searchKey(scrub(e.query, QUERY_MAX))
      return key ? [['search', key]] : null
    }
    case 'profile-switch': {
      const kind = PROFILE_KINDS.find((k) => k === e.profileKind)
      return kind ? [['profile', kind]] : null
    }
    case 'quiz-answer':
      return typeof e.correct === 'boolean' ? [['quiz', `${slug ?? ''}:${e.correct}`]] : null
    default:
      return null
  }
}

/** Reads a usage batch from `POST /api/book/events`: its visitor and counts; null when it is not one */
export function parseBookEvents(raw: string): { visitor: string; metrics: Map<string, number> } | null {
  const body = parseJson(raw, BOOK_EVENTS_MAX_CHARS)
  if (!body || typeof body.visitor !== 'string' || !VISITOR.test(body.visitor)) return null
  const events = body.events
  if (!Array.isArray(events) || events.length < 1 || events.length > BOOK_EVENTS_PER_BATCH) return null
  // `type \t key` → how many times in this batch
  const metrics = new Map<string, number>()
  for (const event of events) {
    for (const [type, key] of eventMetrics(event) ?? []) {
      const id = `${type}\t${key}`
      metrics.set(id, (metrics.get(id) ?? 0) + 1)
    }
  }
  return { visitor: body.visitor, metrics }
}

interface ErrorRow {
  id: number
  at: number
  kind: string
  message: string
  source: string | null
  stack: string | null
  page: string | null
  version: string | null
  count: number
}

function toError(row: ErrorRow): BookClientError {
  const error: BookClientError = { id: row.id, at: row.at, kind: row.kind as BookClientError['kind'], message: row.message, count: row.count }
  if (row.source !== null) error.source = row.source
  if (row.stack !== null) error.stack = row.stack
  if (row.page !== null) error.page = row.page
  if (row.version !== null) error.version = row.version
  return error
}

export interface BookTelemetryOptions {
  now: () => number
  log: (entry: LogEntry) => void
}

export class BookTelemetry {
  private readonly sql: Sql
  private readonly now: () => number
  private readonly log: (entry: LogEntry) => void
  private readonly errorLimit: TokenBuckets
  private readonly eventLimit: TokenBuckets
  /** The day the old counts were last cleared, so it happens once a day at most */
  private prunedDay = ''

  constructor(sql: Sql, options: BookTelemetryOptions) {
    this.sql = sql
    this.now = options.now
    this.log = options.log
    this.errorLimit = new TokenBuckets(CLIENT_ERROR_BURST, CLIENT_ERRORS_PER_SECOND, this.now)
    this.eventLimit = new TokenBuckets(BOOK_EVENT_BURST, BOOK_EVENTS_PER_SECOND, this.now)
  }

  createTables() {
    for (const statement of SCHEMA) this.sql.exec(statement)
  }

  /**
   * `POST /api/book/errors`: false when the body is not a report (400). A report over the club's
   * rate is dropped; one that is kept is logged as `clientError` (`site: 'book'`) too
   */
  report(raw: string): boolean {
    const report = parseBookError(raw)
    if (!report) return false
    if (!this.errorLimit.take('club')) return true
    this.log({ event: 'clientError', site: 'book', ...report })
    const at = this.now()
    const optional = [report.source ?? null, report.stack ?? null, report.page ?? null, report.version ?? null]
    this.sql.transaction(() => {
      const same = this.sql.exec<{ id: number }>(
        'SELECT id FROM book_errors WHERE kind = ? AND message = ? AND source IS ? AND page IS ?',
        report.kind,
        report.message,
        optional[0],
        optional[2],
      )[0]
      if (same) this.sql.exec('UPDATE book_errors SET at = ?, count = count + 1, stack = ?, version = ? WHERE id = ?', at, optional[1], optional[3], same.id)
      else
        this.sql.exec(
          'INSERT INTO book_errors (at, kind, message, source, stack, page, version, count) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
          at,
          report.kind,
          report.message,
          ...optional,
        )
      this.sql.exec(
        'DELETE FROM book_errors WHERE id NOT IN (SELECT id FROM book_errors ORDER BY at DESC, id DESC LIMIT ?)',
        BOOK_ERRORS_KEPT,
      )
    })
    return true
  }

  /** `GET /api/book/errors`: the latest first */
  errors(): BookClientError[] {
    return this.sql
      .exec<ErrorRow>('SELECT * FROM book_errors ORDER BY at DESC, id DESC LIMIT ?', BOOK_ERRORS_KEPT)
      .map(toError)
  }

  /** `DELETE /api/book/errors` */
  clearErrors() {
    this.sql.exec('DELETE FROM book_errors')
  }

  enabled(): boolean {
    const row = this.sql.exec<{ value: string }>("SELECT value FROM book_telemetry_settings WHERE key = 'analytics'")[0]
    return row?.value !== 'off'
  }

  /** `PUT /api/book/analytics/settings` (admins'); false when the body is not `{ enabled: boolean }` */
  setEnabled(body: unknown): boolean {
    if (!isRecord(body) || typeof body.enabled !== 'boolean') return false
    this.sql.exec(
      "INSERT INTO book_telemetry_settings (key, value) VALUES ('analytics', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      body.enabled ? 'on' : 'off',
    )
    return true
  }

  /**
   * `POST /api/book/events`: false when the body is not a batch (400). Events that are not valid
   * are dropped one by one; the whole batch is dropped while counting is off or over the club's rate
   */
  record(raw: string): boolean {
    const batch = parseBookEvents(raw)
    if (!batch) return false
    if (!batch.metrics.size || !this.enabled() || !this.eventLimit.take('club')) return true
    const now = this.now()
    const day = dayOf(now)
    this.sql.transaction(() => {
      for (const [id, count] of batch.metrics) {
        const [type, key] = id.split('\t')
        this.sql.exec(
          'INSERT INTO book_metrics (day, type, key, count) VALUES (?, ?, ?, ?) ON CONFLICT (day, type, key) DO UPDATE SET count = count + excluded.count',
          day,
          type,
          key,
          count,
        )
      }
      this.sql.exec('INSERT OR IGNORE INTO book_visitors (week, visitor) VALUES (?, ?)', weekOf(now), batch.visitor)
    })
    if (this.prunedDay !== day) this.prune()
    return true
  }

  /** Clears counts older than BOOK_METRICS_DAYS days and visitors older than BOOK_VISITOR_WEEKS weeks */
  prune() {
    const now = this.now()
    this.prunedDay = dayOf(now)
    this.sql.exec('DELETE FROM book_metrics WHERE day < ?', dayOf(now - (BOOK_METRICS_DAYS - 1) * DAY_MS))
    this.sql.exec('DELETE FROM book_visitors WHERE week < ?', weekOf(now - (BOOK_VISITOR_WEEKS - 1) * 7 * DAY_MS))
  }

  /** `GET /api/book/analytics`: the last twelve weeks and the last 28 days (today included), in UTC */
  view(): BookAnalyticsView {
    const now = this.now()
    const weeks: BookAnalyticsWeek[] = []
    for (let i = VIEW_WEEKS - 1; i >= 0; i--) weeks.push({ week: weekOf(now - i * 7 * DAY_MS), visitors: 0, pages: 0 })
    const byWeek = new Map(weeks.map((w) => [w.week, w]))
    const first = weeks[0].week
    for (const row of this.sql.exec<{ week: string; n: number }>('SELECT week, COUNT(*) AS n FROM book_visitors WHERE week >= ? GROUP BY week', first)) {
      const week = byWeek.get(row.week)
      if (week) week.visitors = row.n
    }
    for (const row of this.sql.exec<{ day: string; n: number }>("SELECT day, SUM(count) AS n FROM book_metrics WHERE type = 'page' AND day >= ? GROUP BY day", first)) {
      const week = byWeek.get(weekOf(Date.parse(`${row.day}T00:00:00Z`)))
      if (week) week.pages += row.n
    }

    const since = dayOf(now - (VIEW_DAYS - 1) * DAY_MS)
    const top = (type: MetricType) =>
      this.sql.exec<{ key: string; n: number }>(
        'SELECT key, SUM(count) AS n FROM book_metrics WHERE type = ? AND day >= ? GROUP BY key ORDER BY n DESC, key LIMIT ?',
        type,
        since,
        VIEW_TOP,
      )
    const total = (type: MetricType, key?: string) => {
      const params: SqlValue[] = [type, since]
      if (key) params.push(key)
      const query = `SELECT COALESCE(SUM(count), 0) AS n FROM book_metrics WHERE type = ? AND day >= ?${key ? ' AND key LIKE ?' : ''}`
      return this.sql.exec<{ n: number }>(query, ...params)[0]?.n ?? 0
    }
    return {
      enabled: this.enabled(),
      weeks,
      topConventions: top('convention').map((r) => ({ slug: r.key, views: r.n })),
      topSearches: top('search').map((r) => ({ query: r.key, count: r.n })),
      profileSwitches: total('profile'),
      quiz: { answered: total('quiz'), correct: total('quiz', '%:true') },
    }
  }
}
