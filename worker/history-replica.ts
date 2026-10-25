import type { HistoryQuery } from '../shared/history-query.ts'
import { summarize, type BoardRecord, type BoardSummary, type HistoryPage } from '../shared/protocol.ts'
import { INDEX_COLUMNS, INDEX_SCHEMA, indexRow, searchStatements, shownPage, type PlayerRow, type Statement } from './history-index.ts'
import type { LogEntry } from './log.ts'
import type { Scheduler } from './scheduler.ts'
import type { SqlValue, Store } from './store.ts'

/**
 * The history index's copy in D1 (ARCHITECTURE.md §5.12, `e11-t20`): the read side of the history
 * pages, which the Worker answers at the edge without the club's Durable Object. The club stays the
 * one that writes (its own SQLite index is where challenges, matches and favorites read, and what
 * this copy is rebuilt from); every board it writes is queued here (an outbox in its own storage)
 * and copied over in batches, again and again until D1 takes it. Copying a board twice changes
 * nothing, and a board whose record is gone is taken out.
 *
 * Neither side touches a Cloudflare API: `ReplicaDb` is all of D1 they use (`worker/d1.ts` wraps a
 * real binding; tests use SQLite in memory, `tests/worker/d1.ts`).
 */

/** What the history copy needs of D1: run statements in one round trip and one transaction, rows back per statement */
export interface ReplicaDb {
  batch(statements: Statement[]): Promise<Record<string, SqlValue>[][]>
}

/** The copy's tables: the club's index tables as they are, each board's summary, and whether the copy is complete */
export const REPLICA_SCHEMA = [
  ...INDEX_SCHEMA,
  `CREATE TABLE IF NOT EXISTS board_summaries (
    board_id TEXT PRIMARY KEY,
    summary TEXT NOT NULL
  ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS index_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) WITHOUT ROWID`,
]

/** Boards per write: about ten statements, well inside the free plan's 50 queries per call */
export const REPLICA_BATCH = 20
/** How soon a queued board is copied (boards finishing together go in one batch) */
export const FLUSH_DELAY_MS = 1000
/** The pause between two steps of filling the copy, each in its own alarm (so each stays small) */
export const FILL_STEP_MS = 1000
/** The first wait after D1 refused a write; it doubles up to RETRY_MAX_MS */
export const RETRY_MS = 30_000
export const RETRY_MAX_MS = 10 * 60_000

/** D1 binds at most 100 parameters per statement */
const MAX_PARAMS = 100

const setReady = (ready: boolean): Statement => ({
  sql: "INSERT OR REPLACE INTO index_meta (key, value) VALUES ('ready', ?)",
  params: [ready ? '1' : '0'],
})

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** One multi-row INSERT per chunk that fits the parameter limit */
function inserts(head: string, width: number, rows: SqlValue[][]): Statement[] {
  const placeholder = `(${Array(width).fill('?').join(', ')})`
  return chunks(rows, Math.floor(MAX_PARAMS / width)).map((chunk) => ({
    sql: `${head} VALUES ${chunk.map(() => placeholder).join(', ')}`,
    params: chunk.flat(),
  }))
}

/**
 * The statements that make the copy match these records, in one batch: every board's rows written
 * again, and the boards in `gone` (no record any more) taken out. Idempotent
 */
export function replicaWrites(records: BoardRecord[], gone: string[]): Statement[] {
  const ids = [...records.map((r) => r.id), ...gone]
  if (!ids.length) return []
  const marks = (n: number) => Array(n).fill('?').join(', ')
  const statements: Statement[] = [{ sql: `DELETE FROM board_players WHERE board_id IN (${marks(ids.length)})`, params: ids }]
  if (gone.length)
    statements.push(
      { sql: `DELETE FROM boards_index WHERE board_id IN (${marks(gone.length)})`, params: gone },
      { sql: `DELETE FROM board_summaries WHERE board_id IN (${marks(gone.length)})`, params: gone },
    )
  const rows = records.map(indexRow)
  statements.push(
    ...inserts(`INSERT OR REPLACE INTO boards_index (${INDEX_COLUMNS.join(', ')})`, INDEX_COLUMNS.length, rows.map((r) => r.board)),
    ...inserts(
      'INSERT INTO board_players (board_id, seat, side, user_id)',
      4,
      rows.flatMap((r) => r.players as PlayerRow[]),
    ),
    // Summaries are a kilobyte or two each: a few per statement keeps each well under D1's statement size
    ...chunks(records, 10).flatMap((chunk) =>
      inserts('INSERT OR REPLACE INTO board_summaries (board_id, summary)', 2, chunk.map((r) => [r.id, JSON.stringify(summarize(r))])),
    ),
  )
  return statements
}

/**
 * One page of a history search from the copy, as the club answers it (`ClubService.search`), or
 * null when the copy is not complete (being filled, or switched off and back on): the caller then
 * asks the club. One round trip, two when the page asked for is past the end
 */
export async function searchReplica(db: ReplicaDb, query: HistoryQuery, viewer: string, now: number): Promise<HistoryPage | null> {
  const statements = searchStatements(
    query,
    viewer,
    now,
    false,
    'b.board_id, (SELECT s.summary FROM board_summaries s WHERE s.board_id = b.board_id) AS summary',
  )
  let answers: Record<string, SqlValue>[][]
  try {
    answers = await db.batch([
      { sql: "SELECT value FROM index_meta WHERE key = 'ready'", params: [] },
      statements.count,
      statements.page(query.page),
    ])
  } catch (error) {
    // Never filled yet (a new database): not complete, like one being filled
    if (error instanceof Error && /no such table/i.test(error.message)) return null
    throw error
  }
  const [ready, count, rows] = answers
  if (ready[0]?.value !== '1') return null
  const total = Number(count[0].n)
  const page = shownPage(query, total)
  const shown = page === query.page ? rows : (await db.batch([statements.page(page)]))[0]
  return {
    boards: shown.flatMap((row) => (typeof row.summary === 'string' ? [JSON.parse(row.summary) as BoardSummary] : [])),
    total,
    page,
    size: query.size,
  }
}

/**
 * The copy's version: raise it when the D1 tables or what a board's row holds (its summary) change,
 * and every club fills its copy afresh on its next load (the Worker reads the club meanwhile)
 */
export const REPLICA_VERSION = 1

/** Where filling the copy has got to (`meta:replica`) */
interface ReplicaState {
  /** `off`: not kept (switched off, or never on); `filling`: being written from the records; `ready`: complete */
  state: 'off' | 'filling' | 'ready'
  /** While filling: the last `board:` key written */
  after?: string
  /** While off: whether D1 was told the copy is not complete (so the Worker stops reading it) */
  marked?: boolean
  /** REPLICA_VERSION when it was filled (or started filling) */
  version?: number
}

const STATE_KEY = 'meta:replica'
const QUEUE = 'replq:'

export interface ReplicaSyncConfig {
  store: Store
  db: ReplicaDb
  scheduler: Scheduler
  now: () => number
  log: (entry: LogEntry) => void
}

/**
 * Keeps the D1 copy in step, inside the club (`ClubService`): `queue` after every record written,
 * `load` when the club loads. Each board waits in the outbox (`replq:<board id>`, in the club's
 * storage, so it survives eviction) until a batch with it was written to D1; the batch is rebuilt
 * from the records then, so the latest version is what gets copied
 */
export class ReplicaSync {
  private readonly config: ReplicaSyncConfig
  private state: ReplicaState = { state: 'off' }
  private wait = RETRY_MS
  /** Tells apart two queuings of the same board, so one made during a write is not lost */
  private stamp = 0

  constructor(config: ReplicaSyncConfig) {
    this.config = config
  }

  private get store() {
    return this.config.store
  }

  /** Where it stands, for tests and the health check */
  get status(): ReplicaState['state'] {
    return this.state.state
  }

  /**
   * Picks up where it was: on, it carries on filling or copies what is queued; off (`HISTORY_D1=off`),
   * it stops queuing, drops the queue and tells D1 the copy is not complete, so switching on again
   * fills it afresh before the Worker reads it
   */
  async load(on: boolean) {
    this.state = (await this.store.get<ReplicaState>(STATE_KEY)) ?? { state: 'off' }
    if (!on) {
      if (this.state.state !== 'off' || !this.state.marked) await this.switchOff()
      return
    }
    // Nothing here waits on D1: the club loads inside blockConcurrencyWhile, so D1 is only called from jobs
    // Filled by an older version: fill it again (marked not complete first, so the Worker waits)
    if (this.state.state !== 'off' && this.state.version !== REPLICA_VERSION) await this.save({ state: 'off' })
    if (this.state.state === 'ready') {
      if ((await this.store.list(QUEUE, { limit: 1 })).size) this.scheduleFlush(0)
      return
    }
    this.scheduleFill(0)
  }

  /** A board was written (or written again): copy it soon */
  async queue(boardId: string) {
    if (this.state.state === 'off') return
    await this.store.put(`${QUEUE}${boardId}`, `${this.config.now()}-${++this.stamp}`)
    this.scheduleFlush(FLUSH_DELAY_MS)
  }

  private async save(state: ReplicaState) {
    this.state = state
    await this.store.put(STATE_KEY, state)
  }

  /** Drops the queue at once; telling D1 is a job, so the club's load never waits on D1 */
  private async switchOff() {
    for (const key of (await this.store.list(QUEUE)).keys()) await this.store.delete(key)
    await this.save({ state: 'off', marked: false })
    this.scheduleMark(0)
  }

  private scheduleMark(ms: number) {
    this.config.scheduler.add('replica:off', 'replica', ms, () => this.markNotComplete())
  }

  /** Tells D1 the copy is not complete (so the Worker stops reading it), again and again until it hears */
  private async markNotComplete() {
    if (this.state.state !== 'off' || this.state.marked) return
    try {
      await this.config.db.batch([...REPLICA_SCHEMA.map((sql) => ({ sql, params: [] })), setReady(false)])
      await this.save({ state: 'off', marked: true })
      this.wait = RETRY_MS
    } catch (error) {
      this.failed('off', error)
      this.scheduleMark(this.backoff())
    }
  }

  private scheduleFill(ms: number) {
    this.config.scheduler.add('replica:fill', 'replica', ms, () => this.fill())
  }

  private scheduleFlush(ms: number) {
    this.config.scheduler.add('replica:flush', 'replica', ms, () => this.flush())
  }

  private backoff() {
    const wait = this.wait
    this.wait = Math.min(this.wait * 2, RETRY_MAX_MS)
    return wait
  }

  private failed(step: 'fill' | 'flush' | 'off', error: unknown) {
    this.config.log({ event: 'replica', step, ok: false, error: error instanceof Error ? error.message : String(error) })
  }

  /**
   * One step of filling the copy from every `board:` record: the tables made and marked not
   * complete first, then a batch of records per step (the last key done kept in `meta:replica`, so
   * an evicted club carries on), then marked complete. Boards written meanwhile are in the outbox
   * as well, so none is missed whatever order the keys come in
   */
  private async fill() {
    if (this.state.state === 'ready') return
    try {
      if (this.state.state === 'off') {
        await this.config.db.batch([...REPLICA_SCHEMA.map((sql) => ({ sql, params: [] })), setReady(false)])
        await this.save({ state: 'filling', version: REPLICA_VERSION })
      }
      const after = this.state.after
      const batch = await this.store.list<BoardRecord>('board:', { limit: REPLICA_BATCH, ...(after && { start: `${after}\0` }) })
      if (batch.size) await this.config.db.batch(replicaWrites([...batch.values()], []))
      if (batch.size === REPLICA_BATCH) {
        await this.save({ state: 'filling', after: [...batch.keys()].at(-1)!, version: REPLICA_VERSION })
        this.wait = RETRY_MS
        this.scheduleFill(FILL_STEP_MS)
        return
      }
      await this.config.db.batch([setReady(true)])
      await this.save({ state: 'ready', version: REPLICA_VERSION })
      this.config.log({ event: 'replica', step: 'fill', ok: true })
      this.wait = RETRY_MS
      this.scheduleFlush(0)
    } catch (error) {
      this.failed('fill', error)
      this.scheduleFill(this.backoff())
    }
  }

  /** Copies a batch of queued boards; what D1 took leaves the outbox unless it was queued again meanwhile */
  private async flush() {
    if (this.state.state === 'off') return
    const queued = await this.store.list<string>(QUEUE, { limit: REPLICA_BATCH })
    if (!queued.size) return
    try {
      const ids = [...queued.keys()].map((key) => key.slice(QUEUE.length))
      const records = await Promise.all(ids.map((id) => this.store.get<BoardRecord>(`board:${id}`)))
      const found = records.filter((r): r is BoardRecord => !!r)
      const gone = ids.filter((_, i) => !records[i])
      await this.config.db.batch(replicaWrites(found, gone))
      for (const [key, stamp] of queued) if ((await this.store.get(key)) === stamp) await this.store.delete(key)
      this.wait = RETRY_MS
      if ((await this.store.list(QUEUE, { limit: 1 })).size) this.scheduleFlush(FLUSH_DELAY_MS)
    } catch (error) {
      this.failed('flush', error)
      // The copy's tables are gone (the database was replaced): fill it again from the records
      if (error instanceof Error && /no such table/i.test(error.message)) {
        await this.save({ state: 'off' })
        this.scheduleFill(0)
        return
      }
      this.scheduleFlush(this.backoff())
    }
  }
}
