import type { HistoryQuery } from '../shared/history-query.ts'
import { summarize, type BoardRecord, type BoardSummary, type HistoryDay, type HistoryPage } from '../shared/protocol.ts'
import { dayRows, dayStatement, INDEX_COLUMNS, indexRow, searchStatements, shownPage, type PlayerRow, type Statement } from './history-index.ts'
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
 *
 * Every club's copy is in the same database (e12-t03): every row says its club (`club_id`, part of
 * every key, since a board id is only unique inside a club), each club writes and deletes only its
 * own rows, says only its own copy is complete, and every read is of one club's rows (`where`'s
 * `club`). The tables from before clubs (no `club_id`) are dropped and filled again the first time
 * (REPLICA_VERSION 3): 淡江's rows come back with `tku`.
 */

/** What the history copy needs of D1: run statements in one round trip and one transaction, rows back per statement */
export interface ReplicaDb {
  batch(statements: Statement[]): Promise<Record<string, SqlValue>[][]>
}

/**
 * The copy's tables: the club's index tables with the club in front of every key (e12-t03), each
 * board's summary, and whether each club's copy is complete. `club_id` defaults to 淡江's, so a
 * Worker from before clubs (a rollback) still reads and writes 淡江's rows here as it did
 */
export const REPLICA_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS boards_index (
    club_id TEXT NOT NULL DEFAULT 'tku',
    board_id TEXT NOT NULL,
    played_at INTEGER NOT NULL,
    table_no INTEGER NOT NULL,
    mode TEXT NOT NULL,
    event_id TEXT,
    board_no INTEGER NOT NULL,
    dealer TEXT NOT NULL,
    vul TEXT NOT NULL,
    level INTEGER,
    strain TEXT,
    doubled INTEGER NOT NULL,
    declarer_seat TEXT,
    declarer_user TEXT,
    tricks INTEGER,
    score_ns INTEGER NOT NULL,
    claimed INTEGER NOT NULL,
    reveal_at INTEGER,
    PRIMARY KEY (club_id, board_id)
  )`,
  'CREATE INDEX IF NOT EXISTS boards_by_time ON boards_index (club_id, played_at, board_id)',
  'CREATE INDEX IF NOT EXISTS boards_by_contract ON boards_index (club_id, level, strain, played_at)',
  'CREATE INDEX IF NOT EXISTS boards_by_declarer ON boards_index (club_id, declarer_user, played_at)',
  `CREATE TABLE IF NOT EXISTS board_players (
    club_id TEXT NOT NULL DEFAULT 'tku',
    board_id TEXT NOT NULL,
    seat TEXT NOT NULL,
    side TEXT NOT NULL,
    user_id TEXT,
    PRIMARY KEY (club_id, board_id, seat)
  ) WITHOUT ROWID`,
  'CREATE INDEX IF NOT EXISTS players_by_user ON board_players (club_id, user_id, board_id)',
  `CREATE TABLE IF NOT EXISTS board_summaries (
    club_id TEXT NOT NULL DEFAULT 'tku',
    board_id TEXT NOT NULL,
    summary TEXT NOT NULL,
    PRIMARY KEY (club_id, board_id)
  ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS index_meta (
    club_id TEXT NOT NULL DEFAULT 'tku',
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (club_id, key)
  ) WITHOUT ROWID`,
]

/** The copy's tables, the only names the upgrade below ever drops */
const REPLICA_TABLES = ['boards_index', 'board_players', 'board_summaries', 'index_meta'] as const

/**
 * The statements that make the copy's tables, after dropping any made before clubs (no `club_id`,
 * e12-t03): those held 淡江's rows only, keyed by board id alone, and the club that drops them fills
 * its copy again right after. Tables that have the column are never dropped, so one club filling
 * its copy never touches another's rows. One round trip to read what is there
 */
export async function replicaSchema(db: ReplicaDb): Promise<Statement[]> {
  const [tables] = await db.batch([
    { sql: `SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN (${REPLICA_TABLES.map(() => '?').join(', ')})`, params: [...REPLICA_TABLES] },
  ])
  const old = REPLICA_TABLES.filter((name) => tables.some((t) => t.name === name && !String(t.sql).includes('club_id')))
  return [...old.map((name) => ({ sql: `DROP TABLE IF EXISTS ${name}`, params: [] })), ...REPLICA_SCHEMA.map((sql) => ({ sql, params: [] }))]
}

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

const setReady = (clubId: string, ready: boolean): Statement => ({
  sql: "INSERT OR REPLACE INTO index_meta (club_id, key, value) VALUES (?, 'ready', ?)",
  params: [clubId, ready ? '1' : '0'],
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
 * The statements that make club `clubId`'s copy match these records, in one batch: every board's
 * rows written again, and the boards in `gone` (no record any more) taken out. Only that club's
 * rows (e12-t03). Idempotent
 */
export function replicaWrites(records: BoardRecord[], gone: string[], clubId: string): Statement[] {
  const ids = [...records.map((r) => r.id), ...gone]
  if (!ids.length) return []
  const marks = (n: number) => Array(n).fill('?').join(', ')
  // D1's 100 parameters a statement, less the club's
  const deletes = (table: string, of: string[]) =>
    chunks(of, MAX_PARAMS - 1).map((part) => ({ sql: `DELETE FROM ${table} WHERE club_id = ? AND board_id IN (${marks(part.length)})`, params: [clubId, ...part] }))
  const statements: Statement[] = deletes('board_players', ids)
  if (gone.length) statements.push(...deletes('boards_index', gone), ...deletes('board_summaries', gone))
  const rows = records.map(indexRow)
  statements.push(
    ...inserts(
      `INSERT OR REPLACE INTO boards_index (club_id, ${INDEX_COLUMNS.join(', ')})`,
      INDEX_COLUMNS.length + 1,
      rows.map((r) => [clubId, ...r.board]),
    ),
    ...inserts(
      'INSERT INTO board_players (club_id, board_id, seat, side, user_id)',
      5,
      rows.flatMap((r) => (r.players as PlayerRow[]).map((player) => [clubId, ...player])),
    ),
    // Summaries are a kilobyte or two each: a few per statement keeps each well under D1's statement size
    ...chunks(records, 10).flatMap((chunk) =>
      inserts(
        'INSERT OR REPLACE INTO board_summaries (club_id, board_id, summary)',
        3,
        chunk.map((r) => [clubId, r.id, JSON.stringify(summarize(r))]),
      ),
    ),
  )
  return statements
}

/**
 * Runs some reads on the copy in one round trip, or gives null when club `clubId`'s copy is not
 * complete (being filled, switched off and back on, or never filled yet)
 */
async function readyBatch(db: ReplicaDb, clubId: string, statements: Statement[]): Promise<Record<string, SqlValue>[][] | null> {
  let answers: Record<string, SqlValue>[][]
  try {
    answers = await db.batch([{ sql: "SELECT value FROM index_meta WHERE club_id = ? AND key = 'ready'", params: [clubId] }, ...statements])
  } catch (error) {
    // Never filled yet (a new database), or the tables from before clubs (e12-t03): not complete, like one being filled
    if (error instanceof Error && /no such table|no such column/i.test(error.message)) return null
    throw error
  }
  const [ready, ...rest] = answers
  return ready[0]?.value === '1' ? rest : null
}

/** How many boards a search finds per Taiwan date, from club `clubId`'s copy (`dayStatement`), or null when it is not complete */
export async function daysReplica(db: ReplicaDb, clubId: string, query: HistoryQuery, viewer: string, now: number): Promise<HistoryDay[] | null> {
  const answers = await readyBatch(db, clubId, [dayStatement(query, viewer, now, [], clubId)])
  return answers && dayRows(answers[0])
}

/**
 * One page of a history search from club `clubId`'s copy, as the club answers it
 * (`ClubService.search`), or null when the copy is not complete (being filled, or switched off and
 * back on): the caller then asks the club. One round trip, two when the page asked for is past the end
 */
export async function searchReplica(db: ReplicaDb, clubId: string, query: HistoryQuery, viewer: string, now: number): Promise<HistoryPage | null> {
  const statements = searchStatements(
    query,
    viewer,
    now,
    false,
    'b.board_id, (SELECT s.summary FROM board_summaries s WHERE s.club_id = b.club_id AND s.board_id = b.board_id) AS summary',
    [],
    clubId,
  )
  const answers = await readyBatch(db, clubId, [statements.count, statements.page(query.page)])
  if (!answers) return null
  const [count, rows] = answers
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
 * and every club fills its copy afresh on its next load (the Worker reads the club meanwhile).
 * 3: every row says its club (e12-t03)
 */
export const REPLICA_VERSION = 3

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
  /** The club whose copy this keeps (e12-t03): it writes, deletes and marks only that club's rows */
  clubId: string
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
      await this.config.db.batch([...(await replicaSchema(this.config.db)), setReady(this.config.clubId, false)])
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
        await this.config.db.batch([...(await replicaSchema(this.config.db)), setReady(this.config.clubId, false)])
        await this.save({ state: 'filling', version: REPLICA_VERSION })
      }
      const after = this.state.after
      const batch = await this.store.list<BoardRecord>('board:', { limit: REPLICA_BATCH, ...(after && { start: `${after}\0` }) })
      if (batch.size) await this.config.db.batch(replicaWrites([...batch.values()], [], this.config.clubId))
      if (batch.size === REPLICA_BATCH) {
        await this.save({ state: 'filling', after: [...batch.keys()].at(-1)!, version: REPLICA_VERSION })
        this.wait = RETRY_MS
        this.scheduleFill(FILL_STEP_MS)
        return
      }
      await this.config.db.batch([setReady(this.config.clubId, true)])
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
      await this.config.db.batch(replicaWrites(found, gone, this.config.clubId))
      for (const [key, stamp] of queued) if ((await this.store.get(key)) === stamp) await this.store.delete(key)
      this.wait = RETRY_MS
      if ((await this.store.list(QUEUE, { limit: 1 })).size) this.scheduleFlush(FLUSH_DELAY_MS)
    } catch (error) {
      this.failed('flush', error)
      // The copy's tables are gone (the database was replaced) or from before clubs: fill it again from the records
      if (error instanceof Error && /no such table|no column named|no such column/i.test(error.message)) {
        await this.save({ state: 'off' })
        this.scheduleFill(0)
        return
      }
      this.scheduleFlush(this.backoff())
    }
  }
}
