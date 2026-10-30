// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import type { BookAnalyticsBatch, BookAnalyticsEvent } from '../../shared/protocol.ts'
import { BACKUP_TABLES, exportRows, parseBackup, restoreBackup, runBackup, type BackupBucket } from '../../worker/backup.ts'
import {
  BOOK_ERRORS_KEPT,
  BOOK_TELEMETRY_TABLES,
  BookTelemetry,
  dayOf,
  eventMetrics,
  parseBookError,
  parseBookEvents,
  weekOf,
} from '../../worker/book-telemetry.ts'
import { CLIENT_ERROR_BURST } from '../../worker/rate-limit.ts'
import type { LogEntry } from '../../worker/log.ts'
import type { MemoryStore } from '../../worker/store.ts'
import { memoryStore } from './sqlite.ts'

const DAY = 86_400_000
/** A Wednesday, 2026-10-28, at noon UTC */
const START = Date.parse('2026-10-28T12:00:00Z')
const VISITOR = 'abcdefghijklmnop'

let store: MemoryStore
let time: number
let logs: LogEntry[]
let telemetry: BookTelemetry

const make = () => new BookTelemetry(store.sql, { now: () => time, log: (e) => logs.push(e) })

beforeEach(() => {
  store = memoryStore()
  time = START
  logs = []
  telemetry = make()
  telemetry.createTables()
})

const error = (body: Record<string, unknown>) => JSON.stringify({ kind: 'error', message: 'boom', ...body })
const batch = (events: BookAnalyticsEvent[], visitor = VISITOR) => JSON.stringify({ visitor, events } satisfies BookAnalyticsBatch)
/** Lets the rate limit fill up again */
const later = (ms = 60_000) => (time += ms)

describe('weeks and days', () => {
  it('counts in UTC days and Monday-based weeks', () => {
    expect(dayOf(START)).toBe('2026-10-28')
    expect(weekOf(START)).toBe('2026-10-26')
    expect(weekOf(Date.parse('2026-10-26T00:00:00Z'))).toBe('2026-10-26')
    expect(weekOf(Date.parse('2026-10-25T23:59:59Z'))).toBe('2026-10-19')
    expect(weekOf(Date.parse('2026-11-01T23:59:59Z'))).toBe('2026-10-26')
  })
})

describe('parseBookError', () => {
  it('keeps the known fields, cleaned and cut short; the page loses its query and fragment', () => {
    const report = parseBookError(
      error({
        kind: 'boundary',
        message: `bad user 1234567 at a@b.co ${'x'.repeat(600)}`,
        source: 'https://hall.example/assets/app.js?token=secret',
        stack: 'y'.repeat(3000),
        page: '/c/stayman?q=1#s2',
        version: 'v'.repeat(60),
        userId: 'u1',
      }),
    )
    expect(report).toMatchObject({ kind: 'boundary', source: 'https://hall.example/assets/app.js', page: '/c/stayman' })
    expect(report!.message).toMatch(/^bad user <n> at <email> x+$/)
    expect(report!.message).toHaveLength(500)
    expect(report!.stack).toHaveLength(2000)
    expect(report!.version).toHaveLength(40)
    expect(report).not.toHaveProperty('userId')
  })

  it('refuses what is not a report', () => {
    expect(parseBookError('nope')).toBeNull()
    expect(parseBookError('[]')).toBeNull()
    expect(parseBookError(error({ kind: 'warning' }))).toBeNull()
    expect(parseBookError(JSON.stringify({ message: 'no kind' }))).toBeNull()
    expect(parseBookError(error({ message: '' }))).toBeNull()
    expect(parseBookError(error({ stack: 'z'.repeat(9000) }))).toBeNull()
  })
})

describe('error reports', () => {
  it('stores a report and logs it as a book clientError', () => {
    expect(telemetry.report(error({ page: '/practice', version: 'abc' }))).toBe(true)
    expect(telemetry.errors()).toEqual([{ id: 1, at: START, kind: 'error', message: 'boom', page: '/practice', version: 'abc', count: 1 }])
    expect(logs).toEqual([{ event: 'clientError', site: 'book', kind: 'error', message: 'boom', page: '/practice', version: 'abc' }])
    expect(telemetry.report('{')).toBe(false)
  })

  it('merges the same kind, message, source and page into one row with the latest time', () => {
    telemetry.report(error({ page: '/a' }))
    later()
    telemetry.report(error({ page: '/b' }))
    later()
    telemetry.report(error({ page: '/a', stack: 'newer' }))
    telemetry.report(error({ kind: 'rejection', page: '/a' }))
    const errors = telemetry.errors()
    expect(errors.map((e) => [e.kind, e.page, e.count])).toEqual([
      ['rejection', '/a', 1],
      ['error', '/a', 2],
      ['error', '/b', 1],
    ])
    expect(errors[1]).toMatchObject({ id: 1, at: START + 120_000, stack: 'newer' })
  })

  it('keeps only the latest hundred', () => {
    for (let i = 0; i < BOOK_ERRORS_KEPT + 5; i++) {
      later(1000)
      telemetry.report(error({ message: `boom ${i}` }))
    }
    const errors = telemetry.errors()
    expect(errors).toHaveLength(BOOK_ERRORS_KEPT)
    expect(errors[0].message).toBe(`boom ${BOOK_ERRORS_KEPT + 4}`)
    expect(errors.at(-1)!.message).toBe('boom 5')
  })

  it('drops reports over the club rate, still answering yes', () => {
    for (let i = 0; i < CLIENT_ERROR_BURST + 5; i++) expect(telemetry.report(error({ message: `boom ${i}` }))).toBe(true)
    expect(telemetry.errors()).toHaveLength(CLIENT_ERROR_BURST)
    expect(logs).toHaveLength(CLIENT_ERROR_BURST)
  })

  it('clears them all', () => {
    telemetry.report(error({}))
    telemetry.clearErrors()
    expect(telemetry.errors()).toEqual([])
  })
})

describe('parseBookEvents', () => {
  it('counts each valid event and drops the others one by one', () => {
    const parsed = parseBookEvents(
      batch([
        { type: 'page', path: '/c/stayman?x=1', slug: 'stayman' },
        { type: 'page', path: '/practice' },
        { type: 'page', path: 'no-slash' },
        { type: 'page', path: `/${'p'.repeat(200)}` },
        { type: 'page', path: '/c/x', slug: 'bad slug!' },
        { type: 'search', query: '  Jacoby   TRANSFER ' },
        { type: 'search', query: 'x'.repeat(51) },
        { type: 'search', query: '   ' },
        { type: 'profile-switch', profileKind: 'pair' },
        { type: 'profile-switch', profileKind: 'secret' as never },
        { type: 'quiz-answer', slug: 'stayman', correct: true },
        { type: 'quiz-answer', slug: 'stayman', correct: 'yes' as never },
        { type: 'unknown' as never },
        null as never,
      ]),
    )
    expect(parsed?.visitor).toBe(VISITOR)
    expect(Object.fromEntries(parsed!.metrics)).toEqual({
      'page\t/c/stayman': 1,
      'convention\tstayman': 1,
      'page\t/practice': 1,
      'search\tjacoby transfer': 1,
      'profile\tpair': 1,
      'quiz\tstayman:true': 1,
    })
  })

  it('refuses a batch with a bad visitor, no events, too many or too big', () => {
    const page: BookAnalyticsEvent = { type: 'page', path: '/' }
    expect(parseBookEvents(batch([page], 'short'))).toBeNull()
    expect(parseBookEvents(batch([page], 'has spaces in it here'))).toBeNull()
    expect(parseBookEvents(batch([page], 'x'.repeat(65)))).toBeNull()
    expect(parseBookEvents(batch([]))).toBeNull()
    expect(parseBookEvents(batch(Array(51).fill(page)))).toBeNull()
    expect(parseBookEvents(JSON.stringify({ visitor: VISITOR, events: [{ type: 'search', query: 'q'.repeat(40) }], pad: 'x'.repeat(17_000) }))).toBeNull()
    expect(parseBookEvents('not json')).toBeNull()
    expect(parseBookEvents(batch(Array(50).fill(page)))).not.toBeNull()
  })

  it('masks what could identify someone in a path or a search', () => {
    expect(eventMetrics({ type: 'page', path: '/members/12345678' })).toEqual([['page', '/members/<n>']])
    expect(eventMetrics({ type: 'search', query: 'a@b.co' })).toEqual([['search', '<email>']])
  })
})

describe('usage counts', () => {
  const view = () => telemetry.view()

  it('adds up the last 28 days: conventions, searches, profile switches and answers', () => {
    // Written in time order, as the rate limit expects; 28 days ago is outside, 27 days ago inside
    time = START - 28 * DAY
    telemetry.record(batch([{ type: 'page', path: '/c/drury', slug: 'drury' }, { type: 'profile-switch', profileKind: 'club' }]))
    time = START - 27 * DAY
    telemetry.record(batch([{ type: 'page', path: '/c/landy', slug: 'landy' }]))
    time = START
    telemetry.record(
      batch([
        { type: 'page', path: '/c/stayman', slug: 'stayman' },
        { type: 'page', path: '/c/stayman', slug: 'stayman' },
        { type: 'page', path: '/c/drury', slug: 'drury' },
        { type: 'search', query: 'Stayman' },
        { type: 'search', query: 'stayman ' },
        { type: 'search', query: 'drury' },
        { type: 'profile-switch', profileKind: 'team' },
        { type: 'quiz-answer', slug: 'stayman', correct: true },
        { type: 'quiz-answer', slug: 'stayman', correct: false },
        { type: 'quiz-answer', correct: true },
      ]),
    )
    expect(view()).toMatchObject({
      enabled: true,
      topConventions: [
        { slug: 'stayman', views: 2 },
        { slug: 'drury', views: 1 },
        { slug: 'landy', views: 1 },
      ],
      topSearches: [
        { query: 'stayman', count: 2 },
        { query: 'drury', count: 1 },
      ],
      profileSwitches: 1,
      quiz: { answered: 3, correct: 2 },
    })
  })

  it('shows twelve weeks oldest first, with the empty ones, and counts each visitor once a week', () => {
    time = START - 12 * 7 * DAY
    telemetry.record(batch([{ type: 'page', path: '/' }]))
    time = START - 7 * DAY
    telemetry.record(batch([{ type: 'page', path: '/' }]))
    time = START
    telemetry.record(batch([{ type: 'page', path: '/' }, { type: 'page', path: '/practice' }]))
    telemetry.record(batch([{ type: 'page', path: '/' }]))
    telemetry.record(batch([{ type: 'page', path: '/' }], 'another-visitor-1'))
    const { weeks } = view()
    expect(weeks).toHaveLength(12)
    expect(weeks[0].week).toBe('2026-08-10')
    expect(weeks.at(-1)).toEqual({ week: '2026-10-26', visitors: 2, pages: 4 })
    expect(weeks.at(-2)).toEqual({ week: '2026-10-19', visitors: 1, pages: 1 })
    expect(weeks.slice(0, 10).every((w) => w.visitors === 0 && w.pages === 0)).toBe(true)
  })

  it('drops whole batches while counting is off, and comes back on', () => {
    expect(telemetry.setEnabled({ enabled: 'no' })).toBe(false)
    expect(telemetry.setEnabled({ enabled: false })).toBe(true)
    expect(telemetry.record(batch([{ type: 'page', path: '/' }]))).toBe(true)
    expect(store.sql.exec('SELECT * FROM book_metrics')).toEqual([])
    expect(store.sql.exec('SELECT * FROM book_visitors')).toEqual([])
    expect(view().enabled).toBe(false)
    telemetry.setEnabled({ enabled: true })
    telemetry.record(batch([{ type: 'page', path: '/' }]))
    expect(view()).toMatchObject({ enabled: true })
    expect(view().weeks.at(-1)!.pages).toBe(1)
  })

  it('records no visitor for a batch with nothing valid, and refuses one that is not a batch', () => {
    expect(telemetry.record(batch([{ type: 'nope' as never }]))).toBe(true)
    expect(store.sql.exec('SELECT * FROM book_visitors')).toEqual([])
    expect(telemetry.record('{}')).toBe(false)
  })

  it('stores counts only: no visitor id beside them', () => {
    telemetry.record(batch([{ type: 'page', path: '/c/stayman', slug: 'stayman' }]))
    const columns = store.sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('book_metrics')").map((c) => c.name)
    expect(columns).toEqual(['day', 'type', 'key', 'count'])
    expect(JSON.stringify(store.sql.exec('SELECT * FROM book_metrics'))).not.toContain(VISITOR)
  })

  it('clears counts after 180 days and visitors after 13 weeks, once a day when something is written', () => {
    time = START - 200 * DAY
    telemetry.record(batch([{ type: 'page', path: '/old' }]))
    time = START - 179 * DAY
    telemetry.record(batch([{ type: 'page', path: '/kept' }]))
    time = START - 14 * 7 * DAY
    telemetry.record(batch([{ type: 'page', path: '/' }], 'old-visitor-0000'))
    time = START - 12 * 7 * DAY
    telemetry.record(batch([{ type: 'page', path: '/' }], 'kept-visitor-000'))
    time = START
    telemetry.record(batch([{ type: 'page', path: '/' }]))
    const paths = store.sql.exec<{ key: string }>("SELECT DISTINCT key FROM book_metrics WHERE type = 'page' ORDER BY key").map((r) => r.key)
    expect(paths).toEqual(['/', '/kept'])
    const visitors = store.sql.exec<{ visitor: string }>('SELECT visitor FROM book_visitors ORDER BY week').map((r) => r.visitor)
    expect(visitors).toEqual(['kept-visitor-000', VISITOR])
  })

  it('drops batches over the club rate', () => {
    for (let i = 0; i < 150; i++) telemetry.record(batch([{ type: 'page', path: '/' }]))
    expect(view().weeks.at(-1)!.pages).toBeLessThan(150)
  })
})

describe('the daily backup', () => {
  const bucket: BackupBucket & { objects: Map<string, string> } = {
    objects: new Map(),
    async put(key, value) {
      this.objects.set(key, value)
    },
    async get(key) {
      const text = this.objects.get(key)
      return text === undefined ? null : { text: async () => text }
    },
    async list() {
      return { objects: [...this.objects.keys()].map((key) => ({ key, size: 0, uploaded: new Date(START) })), truncated: false }
    },
    async delete(keys) {
      for (const key of [keys].flat()) this.objects.delete(key)
    },
  }

  it('leaves the telemetry tables out, and a restore leaves them alone', async () => {
    telemetry.report(error({}))
    telemetry.record(batch([{ type: 'page', path: '/' }]))
    telemetry.setEnabled({ enabled: false })
    for (const table of BOOK_TELEMETRY_TABLES) expect(BACKUP_TABLES.map((t) => t.name)).not.toContain(table)
    expect(exportRows(store.sql).rows.filter(([table]) => table.startsWith('book_'))).toEqual([])

    await store.put('book:entry:a', { v: 1 })
    const result = await runBackup(store, bucket, START)
    const [name] = bucket.objects.keys()
    expect(result.name).toBe(name)
    expect(bucket.objects.get(name)).not.toContain('boom')
    expect(parseBackup(bucket.objects.get(name)!).rows).toEqual([])

    await restoreBackup(store, bucket, name, false)
    expect(telemetry.errors()).toHaveLength(1)
    expect(telemetry.enabled()).toBe(false)
    expect(store.sql.exec('SELECT * FROM book_metrics')).toHaveLength(1)
  })
})
