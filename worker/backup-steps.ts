import type { BoardRecord } from '../shared/protocol.ts'
import {
  ACTIVITY_OBJECTS,
  ACTIVITY_PREFIXES,
  ACTIVITY_TABLES,
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  type BackupBucket,
  backupName,
  countBoards,
  decodeValue,
  encodeValue,
  expiredBackups,
  GAME_OBJECTS,
  listObjects,
  type RestoreStepsPlan,
  type SqlRow,
} from './backup.ts'
import type { LogEntry } from './log.ts'
import type { Scheduler } from './scheduler.ts'
import type { SqlValue, Store } from './store.ts'

/**
 * The part of the daily backup that does not fit one request's 10 ms of CPU (e11-t12, DEPLOY.md
 * §4.4 has the numbers): the activity (`activity/<date>/<part>.jsonl`) and the games
 * (`games/<seq>.jsonl`), each written and restored a small step per alarm, with where it has got to
 * in `meta:backupjob`, so an evicted object or a failed step carries on where it stopped. Like the
 * D1 copy's sync it touches no Cloudflare API: `BackupBucket` is an R2 bucket's calls, and the club's
 * own part of it (`scopedBucket`), so no club can reach another's objects.
 *
 * **The game log.** Every board written or deleted waits in an outbox (`bakq:<id>`) and goes into the
 * next object when the day's backup runs: a board's newest version, or a mark that it is gone (`x`,
 * an imported board deleted with its account). Objects are numbered and never rewritten. Records do
 * change (a director's ruling, a challenge bringing `revealAt` forward), so a board can be in the log
 * more than once: the highest number is the latest.
 *
 * **Sweeps keep the log from growing for ever and let deleted boards leave it.** Every
 * SWEEP_EVERY_DAYS one pass walks all of `board:` into new objects; when it finishes, everything older
 * than the previous finished pass is deleted. So there are at most three passes' worth in R2, and a
 * board deleted from the club is gone from R2 about 30 days later, as with the daily objects. The
 * first pass is what brings the boards from before this code in. Only objects this object itself
 * numbered are ever deleted, and not when a pass found less than half the boards of the one before:
 * a lost and refilled object must not clean away the only copy of its games.
 *
 * **Restoring adds, never removes.** The log is read from its newest object down and the first
 * version of a board wins; a board the club has is left alone, so a restore costs nothing on a
 * healthy club, and boards played after the backup stay. A board comes back through the same writes
 * as a new one: its record, `hist:`, `uhist:` and the SQL index, then the D1 copy's outbox. At the end
 * the copy's rows for boards that have no record are taken out. The activity goes back the same way:
 * only what is missing, so a running challenge's rows are not touched; then the object restarts
 * (`restart`) so every service reads it again, as after any eviction.
 *
 * Restoring is limited to RESTORE_ROWS_PER_DAY rows written a day, the rest of the free plan's
 * 100,000 being left for the club to go on working; it waits for the next UTC day and carries on.
 */

/** Boards per log object, one step's work: about 130 KB of JSON at 6.5 KB a board (DEPLOY.md §4.4) */
export const GAMES_PER_OBJECT = 20
/** Boards one restore step writes (each is about 25 writes), and lines it looks at (one SQL read for a board the club has) */
export const RESTORE_BOARDS_PER_STEP = 5
export const RESTORE_LINES_PER_STEP = 20
/** About how much text one part of the activity holds: some 300 rows */
export const ACTIVITY_PART_CHARS = 60_000
/** Keys and rows of a part one restore step puts back */
export const RESTORE_MERGES_PER_STEP = 50
/** The pause between steps, each in its own alarm */
export const STEP_MS = 1000
export const SWEEP_EVERY_DAYS = 14
/** A sweep finding fewer than this share of the last one's boards deletes nothing */
const SWEEP_MIN_SHARE = 0.5
/** The first wait after a failed step; it doubles up to RETRY_MAX_MS */
export const RETRY_MS = 30_000
export const RETRY_MAX_MS = 10 * 60_000
/**
 * What restoring may write in a UTC day, of the free plan's 100,000 rows: about 3,000 boards at
 * ROWS_PER_BOARD. The club writes from the same quota: running out would stop every game's writes
 */
export const RESTORE_ROWS_PER_DAY = 63_000
/** A restored board: the record, `hist:`, up to 4 `uhist:`, `replq:` twice; 5 for `boards_index` and its indexes, 8 for `board_players` and its */
export const ROWS_PER_BOARD = 21
/** A restored row of the activity, with its index entry */
const ROWS_PER_LINE = 2

const OUTBOX = 'bakq:'
const STATE_KEY = 'meta:backupjob'
/** Boards the log says are gone, while a restore reads down past their older versions */
const GONE = 'bkgone:'
const JOB_KEY = 'backup:steps'
const DAY_MS = 86_400_000
const LIST_PAGE = 50
const SQL_PAGE = 100
const BOARD_ID = /^[\w-]+$/

const gameName = (seq: number) => `${GAME_OBJECTS}${String(seq).padStart(8, '0')}.jsonl`
const GAME_KEY = /^games\/(\d{8})\.jsonl$/
const partName = (date: string, part: number) => `${ACTIVITY_OBJECTS}${date}/${String(part).padStart(4, '0')}.jsonl`
const PART_DATE = /^activity\/(\d{4}-\d{2}-\d{2})\//
const dateOf = (dailyName: string) => dailyName.slice('daily/'.length, -'.jsonl'.length)
const NDJSON = { httpMetadata: { contentType: 'application/x-ndjson; charset=utf-8' } }

/** What can be read in the activity: a key prefix, or a table with its key */
const ITEMS: readonly (string | { name: string; key: readonly string[] })[] = [...ACTIVITY_PREFIXES, ...ACTIVITY_TABLES]

interface Generation {
  /** The first object of this pass */
  start: number
  boards: number
  at: number
}

interface ExportJob {
  date: string
  createdAt: string
  part: number
  item: number
  /** The last key written of this item: a key-value key, or a table's key columns */
  after?: string | SqlValue[]
  /** An earlier run's parts of this date were cleared */
  cleared?: boolean
}

interface RestoreJob {
  name: string
  date: string
  stage: 'activity' | 'games' | 'replica'
  /** How many parts that day has, and the next to read (from 1) */
  parts: number
  part: number
  /** The log object to read next, going down to `floor`: numbers only, so this state stays small however long the log is */
  seq: number
  floor: number
  /** The line to go on from in the object being read (0 is its header) */
  line: number
  /** Rows and keys of the activity put back, parts it could not read */
  merged: number
  badParts: number
  boards: number
  gone: number
  badLines: number
  replicaAfter?: string
  day: number
  rows: number
}

interface JobState {
  /** The next object's number; 0 until the bucket was read (a new object, or one that lost its state) */
  seq: number
  /** Finished passes, oldest first */
  generations: Generation[]
  sweep?: { start: number; at: number; boards: number; after?: string }
  export?: ExportJob
  restore?: RestoreJob
  lastRestore?: { name: string; at: number; merged: number; boards: number; gone: number; badParts: number; badLines: number }
}

/** The history index's D1 copy, as far as a restore needs it */
export interface ReplicaForRestore {
  dropMissing(after: string | undefined): Promise<string | null>
}

export interface BackupStepsConfig {
  store: Store
  bucket: BackupBucket
  scheduler: Scheduler
  now: () => number
  log: (entry: LogEntry) => void
  /** Writes a board back: its record, summaries and index, and queues it for the D1 copy */
  restoreBoard: (record: BoardRecord) => Promise<void>
  replica?: ReplicaForRestore
  /** The activity came back: every service must read it again (the Durable Object resets; in tests, nothing or a spy) */
  restart: () => void
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

const isBoardRecord = (value: unknown): value is BoardRecord =>
  isObject(value) && typeof value.id === 'string' && BOARD_ID.test(value.id) && isObject(value.board) && isObject(value.players) && typeof value.finishedAt === 'number'

const isSqlValue = (value: unknown): value is SqlValue => value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))

export class BackupSteps {
  private readonly config: BackupStepsConfig
  private state: JobState = { seq: 0, generations: [] }
  private wait = RETRY_MS
  /** Tells apart two queuings of the same board, so one made during a write is not lost */
  private stamp = 0
  private running = false
  /** The log object a restore is part way through */
  private reading: { seq: number; lines: string[] } | undefined
  /** The activity's part a restore is part way through */
  private part: { key: string; lines: PartLine[] } | undefined
  private restartWanted = false

  constructor(config: BackupStepsConfig) {
    this.config = config
  }

  private get store() {
    return this.config.store
  }
  private get bucket() {
    return this.config.bucket
  }
  private get sql() {
    return this.config.store.sql
  }

  /** Picks up where it was: jobs are not stored, what it was doing is */
  async load() {
    this.state = (await this.store.get<JobState>(STATE_KEY)) ?? this.state
    if (this.hasWork()) this.schedule(0)
  }

  /** A board was written or deleted: it goes in the next object */
  async queue(boardId: string) {
    await this.store.put(`${OUTBOX}${boardId}`, `${this.config.now()}-${++this.stamp}`)
  }

  /** Where it stands, for the admin API */
  status() {
    const { seq, generations, sweep, export: exporting, restore, lastRestore } = this.state
    return {
      nextObject: seq,
      lastSweepAt: generations.at(-1)?.at ?? null,
      sweeping: sweep ? { boards: sweep.boards } : null,
      exporting: exporting ? { date: exporting.date, part: exporting.part } : null,
      restoring: restore
        ? {
            name: restore.name,
            stage: restore.stage,
            left: restore.stage === 'activity' ? restore.parts - restore.part + 1 : restore.stage === 'games' ? restore.seq - restore.floor + 1 : 0,
            merged: restore.merged,
            boards: restore.boards,
          }
        : null,
      lastRestore: lastRestore ?? null,
    }
  }

  /** The day's export: the activity's parts, the outbox, and a sweep when one is due */
  async startExport() {
    await this.knowSeq()
    const now = this.config.now()
    const { state } = this
    state.export = { date: dateOf(backupName(now)), createdAt: new Date(now).toISOString(), part: 1, item: 0 }
    const last = state.generations.at(-1)?.at
    if (!state.sweep && !state.restore && (last === undefined || now - last >= SWEEP_EVERY_DAYS * DAY_MS)) state.sweep = { start: state.seq, at: now, boards: 0 }
    await this.save()
    this.schedule(0)
  }

  /** What a restore of this daily backup would read */
  async plan(name: string): Promise<RestoreStepsPlan> {
    const parts = await this.activityOf(dateOf(name))
    return {
      activityParts: parts.length,
      activityComplete: parts.length > 0 && (await this.isLastPart(parts.at(-1)!)),
      gameObjects: (await this.gameObjects()).length,
      boardsNow: countBoards(this.sql) ?? 0,
    }
  }

  /** After the core was restored: the activity, then the games, then the D1 copy; a restore already running gives way */
  async startRestore(name: string) {
    for (const key of (await this.store.list(GONE)).keys()) await this.store.delete(key)
    this.reading = undefined
    this.part = undefined
    const objects = await this.gameObjects()
    this.state.restore = {
      name,
      date: dateOf(name),
      stage: 'activity',
      parts: (await this.activityOf(dateOf(name))).length,
      part: 1,
      seq: objects.at(-1) ?? 0,
      floor: objects[0] ?? 1,
      line: 1,
      merged: 0,
      badParts: 0,
      boards: 0,
      gone: 0,
      badLines: 0,
      day: 0,
      rows: 0,
    }
    await this.save()
    this.schedule(0)
  }

  // ── Stepping ───────────────────────────────────────────────────────────────────────────────

  private hasWork() {
    const { sweep, export: exporting, restore } = this.state
    return !!(sweep || exporting || restore)
  }

  private schedule(ms: number) {
    this.config.scheduler.add(JOB_KEY, 'backup', ms, () => this.step())
  }

  private async save() {
    await this.store.put(STATE_KEY, this.state)
  }

  /** One step: restoring comes first; while it waits for tomorrow's rows the export goes on */
  private async step() {
    if (this.running) return
    this.running = true
    try {
      await this.knowSeq()
      const waitMs = await this.oneStep()
      this.wait = RETRY_MS
      if (waitMs !== null) this.schedule(waitMs)
      // Last: the next alarm is set by now, and the reset comes after it is written
      if (this.restartWanted) {
        this.restartWanted = false
        this.config.restart()
      }
    } catch (error) {
      this.config.log({ event: 'backup', ok: false, step: 'step', error: error instanceof Error ? error.message : String(error) })
      const wait = this.wait
      this.wait = Math.min(this.wait * 2, RETRY_MAX_MS)
      this.schedule(wait)
    } finally {
      this.running = false
    }
  }

  /** Returns when to run again, or null with nothing left */
  private async oneStep(): Promise<number | null> {
    const { restore } = this.state
    if (restore) {
      const tomorrow = this.waitForRows(restore)
      if (tomorrow === 0) {
        await this.restoreStep(restore)
        return STEP_MS
      }
      // The activity's export reads what the restore is merging: not until that is through
      if (restore.stage !== 'activity' && (await this.exportStep())) return STEP_MS
      return tomorrow
    }
    if (await this.exportStep()) return STEP_MS
    return this.hasWork() ? STEP_MS : null
  }

  /** One unit of exporting; false with nothing to do. A sweep waits while a restore runs: the club is not whole yet */
  private async exportStep() {
    if (this.state.export) {
      await this.writePart(this.state.export)
      return true
    }
    if (await this.flush()) return true
    if (this.state.sweep && !this.state.restore) {
      await this.sweepStep(this.state.sweep)
      return true
    }
    return false
  }

  /** The object number to go on from: the bucket's highest, so a lost state never overwrites an object */
  private async knowSeq() {
    if (this.state.seq) return
    const objects = await this.gameObjects()
    this.state.seq = (objects.at(-1) ?? 0) + 1
    await this.save()
  }

  private async gameObjects() {
    return (await listObjects(this.bucket, GAME_OBJECTS)).flatMap((o) => {
      const match = GAME_KEY.exec(o.key)
      return match ? [Number(match[1])] : []
    })
  }

  private async activityOf(date: string) {
    return (await listObjects(this.bucket, `${ACTIVITY_OBJECTS}${date}/`)).map((o) => o.key).sort()
  }

  // ── Writing the games ──────────────────────────────────────────────────────────────────────

  /**
   * One object of the log. The object is written, then the number moves on, then the outbox goes: a
   * step that dies before the number moved writes the same number again, one that dies after only
   * repeats some boards, and the later copy of a board is as good as any
   */
  private async writeGames(lines: string[], boards: number, kind: 'outbox' | 'sweep') {
    const header = { format: BACKUP_FORMAT, version: BACKUP_FORMAT_VERSION, kind, createdAt: new Date(this.config.now()).toISOString(), seq: this.state.seq, boards, lines: lines.length }
    await this.bucket.put(gameName(this.state.seq), [JSON.stringify(header), ...lines].join('\n') + '\n', NDJSON)
    this.state.seq += 1
  }

  /** The next boards waiting in the outbox; false with none */
  private async flush() {
    const queued = await this.store.list<string>(OUTBOX, { limit: GAMES_PER_OBJECT })
    if (!queued.size) return false
    const ids = [...queued.keys()].map((key) => key.slice(OUTBOX.length))
    const records = await Promise.all(ids.map((id) => this.store.get<BoardRecord>(`board:${id}`)))
    const lines = ids.map((id, i) => JSON.stringify(records[i] ? { b: records[i] } : { x: id }))
    await this.writeGames(lines, records.filter(Boolean).length, 'outbox')
    await this.save()
    for (const [key, stamp] of queued) if ((await this.store.get(key)) === stamp) await this.store.delete(key)
    return true
  }

  /** The next boards of a pass over all of them; the pass's end may let older objects go */
  private async sweepStep(sweep: NonNullable<JobState['sweep']>) {
    const batch = await this.store.list<BoardRecord>('board:', { limit: GAMES_PER_OBJECT, ...(sweep.after && { start: `${sweep.after}\0` }) })
    if (batch.size) {
      await this.writeGames([...batch.values()].map((b) => JSON.stringify({ b })), batch.size, 'sweep')
      sweep.boards += batch.size
      sweep.after = [...batch.keys()].at(-1)
    }
    if (batch.size === GAMES_PER_OBJECT) {
      await this.save()
      return
    }
    const { generations } = this.state
    const previous = generations.at(-1)
    generations.push({ start: sweep.start, boards: sweep.boards, at: sweep.at })
    this.state.sweep = undefined
    await this.save()
    this.config.log({ event: 'backup', ok: true, step: 'sweep', objects: this.state.seq - sweep.start, boards: sweep.boards })
    if (previous && sweep.boards < previous.boards * SWEEP_MIN_SHARE) {
      // Far fewer boards than last time: an emptied club, most likely. Nothing goes until someone looks
      this.config.log({ event: 'backup', ok: false, step: 'sweep', error: `found ${sweep.boards} boards, ${previous.boards} last time: older objects kept` })
      return
    }
    while (generations.length > 2) {
      const [oldest, keep] = generations
      const doomed = (await this.gameObjects()).filter((seq) => seq >= oldest.start && seq < keep.start)
      for (let i = 0; i < doomed.length; i += 1000) await this.bucket.delete(doomed.slice(i, i + 1000).map(gameName))
      generations.shift()
      await this.save()
    }
  }

  // ── Writing the activity ───────────────────────────────────────────────────────────────────

  /** One part: reads on until it is about full. Same-day runs start the date over, so no old part stays behind */
  private async writePart(job: ExportJob) {
    if (!job.cleared) {
      const old = await this.activityOf(job.date)
      for (let i = 0; i < old.length; i += 1000) await this.bucket.delete(old.slice(i, i + 1000))
      job.cleared = true
    }
    const lines: string[] = []
    let chars = 0
    const add = (line: unknown) => {
      const text = JSON.stringify(line)
      lines.push(text)
      chars += text.length
    }
    const tables = this.tableNames()
    while (job.item < ITEMS.length && chars < ACTIVITY_PART_CHARS) {
      const item = ITEMS[job.item]
      if (typeof item === 'string') {
        const after = typeof job.after === 'string' ? `${job.after}\0` : undefined
        const page = await this.store.list<unknown>(item, { limit: LIST_PAGE, ...(after && { start: after }) })
        for (const [k, v] of page) add({ k, v: encodeValue(v) })
        if (page.size < LIST_PAGE) this.nextItem(job)
        else job.after = [...page.keys()].at(-1)
      } else if (!tables.has(item.name)) {
        this.nextItem(job)
      } else {
        const rows = this.tablePage(item, Array.isArray(job.after) ? job.after : undefined)
        for (const r of rows) add({ t: item.name, r })
        if (rows.length < SQL_PAGE) this.nextItem(job)
        else job.after = item.key.map((column) => rows.at(-1)![column])
      }
    }
    const last = job.item >= ITEMS.length
    const header = { format: BACKUP_FORMAT, version: BACKUP_FORMAT_VERSION, kind: 'activity', createdAt: job.createdAt, part: job.part, lines: lines.length, last }
    await this.bucket.put(partName(job.date, job.part), [JSON.stringify(header), ...lines].join('\n') + '\n', NDJSON)
    job.part += 1
    if (last) {
      // Unless a new day's run took over while this part was being written
      if (this.state.export === job) this.state.export = undefined
      await this.expireActivity()
      this.config.log({ event: 'backup', ok: true, step: 'activity', name: job.date, parts: job.part - 1 })
    }
    await this.save()
  }

  private nextItem(job: ExportJob) {
    job.item += 1
    job.after = undefined
  }

  private tableNames() {
    try {
      return new Set(this.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map((t) => t.name))
    } catch {
      return new Set<string>()
    }
  }

  /** A page of a table in key order, from just after `after`: only the database's own names are in the query */
  private tablePage(table: { name: string; key: readonly string[] }, after: SqlValue[] | undefined) {
    const columns = table.key.join(', ')
    const where = after ? `WHERE (${columns}) > (${table.key.map(() => '?').join(', ')})` : ''
    return this.sql.exec<SqlRow>(`SELECT * FROM ${table.name} ${where} ORDER BY ${columns} LIMIT ${SQL_PAGE}`, ...(after ?? []))
  }

  /** The parts of the days whose daily object has expired go with the same rule */
  private async expireActivity() {
    const keys = (await listObjects(this.bucket, ACTIVITY_OBJECTS)).map((o) => o.key)
    const dates = [...new Set(keys.flatMap((key) => PART_DATE.exec(key)?.[1] ?? []))]
    const expired = new Set(expiredBackups(dates.map((date) => `daily/${date}.jsonl`), this.config.now()).map(dateOf))
    const doomed = keys.filter((key) => expired.has(PART_DATE.exec(key)?.[1] ?? ''))
    for (let i = 0; i < doomed.length; i += 1000) await this.bucket.delete(doomed.slice(i, i + 1000))
  }

  private async isLastPart(key: string) {
    const object = await this.bucket.get(key)
    if (!object) return false
    try {
      const header = JSON.parse((await object.text()).split('\n', 1)[0]) as { last?: unknown }
      return header.last === true
    } catch {
      return false
    }
  }

  // ── Restoring ──────────────────────────────────────────────────────────────────────────────

  /** How long until this restore may write again; 0 when it may. A step's worst case must fit */
  private waitForRows(job: RestoreJob) {
    const now = this.config.now()
    const today = Math.floor(now / DAY_MS)
    if (job.day !== today) {
      job.day = today
      job.rows = 0
    }
    if (job.rows + RESTORE_BOARDS_PER_STEP * ROWS_PER_BOARD <= RESTORE_ROWS_PER_DAY) return 0
    return (today + 1) * DAY_MS - now + 60_000
  }

  private async restoreStep(job: RestoreJob) {
    if (job.stage === 'activity') await this.restorePart(job)
    else if (job.stage === 'games') await this.restoreObject(job)
    else await this.restoreReplica(job)
  }

  /** Some lines of the activity put back where missing; after the last, the object restarts to read it all */
  private async restorePart(job: RestoreJob) {
    if (job.part > job.parts) {
      job.stage = 'games'
      job.line = 1
      this.restartWanted = job.merged > 0
      await this.save()
      return
    }
    const key = partName(job.date, job.part)
    if (this.part?.key !== key) {
      const object = await this.bucket.get(key)
      const parsed = object ? parsePart(await object.text()) : null
      if (!parsed) {
        job.badParts += 1
        job.part += 1
        job.line = 1
        this.config.log({ event: 'backup', ok: false, step: 'restore', name: key, error: 'part not readable' })
        await this.save()
        return
      }
      this.part = { key, lines: parsed.lines }
    }
    const { lines } = this.part
    const from = job.line - 1
    const merged = await this.mergePart(lines.slice(from, from + RESTORE_MERGES_PER_STEP))
    job.merged += merged
    job.rows += merged * ROWS_PER_LINE
    job.line += RESTORE_MERGES_PER_STEP
    if (job.line - 1 >= lines.length) {
      job.part += 1
      job.line = 1
      this.part = undefined
    }
    await this.save()
  }

  /** Keys that are not there and rows whose key is not there; returns how many went in */
  private async mergePart(lines: PartLine[]) {
    let merged = 0
    const columns = new Map<string, string[]>()
    const tables = this.tableNames()
    const known = (table: string) => {
      let names = columns.get(table)
      if (!names) columns.set(table, (names = this.sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name)))
      return names
    }
    for (const line of lines) {
      if (!('k' in line) || (await this.store.get(line.k)) !== undefined) continue
      await this.store.put(line.k, line.v)
      merged += 1
    }
    const rows = lines.filter((line): line is RowLine => 't' in line && tables.has(line.t))
    if (rows.length)
      this.sql.transaction(() => {
        for (const { t, r } of rows) {
          // A column since dropped is left out, one since added takes its default; the names are the database's own
          const names = known(t).filter((name) => name in r)
          if (!names.length) continue
          const inserted = this.sql.exec(
            `INSERT OR IGNORE INTO ${t} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')}) RETURNING 1`,
            ...names.map((name) => r[name]),
          )
          merged += inserted.length
        }
      })
    return merged
  }

  /** One object of the log, from the newest down: the first version of a board wins */
  private async restoreObject(job: RestoreJob) {
    if (job.seq < job.floor) {
      job.stage = 'replica'
      job.replicaAfter = undefined
      await this.save()
      return
    }
    const { seq } = job
    if (this.reading?.seq !== seq) {
      // Kept between steps: read once, and each step parses only the lines it takes
      const object = await this.bucket.get(gameName(seq))
      this.reading = { seq, lines: object ? (await object.text()).split('\n') : [] }
    }
    const { lines } = this.reading
    let written = 0
    for (let looked = 0; job.line < lines.length && written < RESTORE_BOARDS_PER_STEP && looked < RESTORE_LINES_PER_STEP; looked++) {
      const line = lines[job.line]
      if (line.trim())
        try {
          if (await this.restoreLine(job, JSON.parse(line) as unknown)) written += 1
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error
          job.badLines += 1
        }
      job.line += 1
    }
    if (job.line >= lines.length) {
      job.seq -= 1
      job.line = 1
      this.reading = undefined
    }
    await this.save()
  }

  /** One line of the log; true when it wrote a board */
  private async restoreLine(job: RestoreJob, line: unknown) {
    if (isObject(line) && typeof line.x === 'string' && BOARD_ID.test(line.x)) {
      // Gone since its older versions were written, unless a newer version already came back
      if (!(await this.hasIndexed(line.x)) && (await this.store.get(`board:${line.x}`)) === undefined) {
        await this.store.put(`${GONE}${line.x}`, 1)
        job.gone += 1
        job.rows += 1
      }
      return false
    }
    const record = isObject(line) ? line.b : undefined
    if (!isBoardRecord(record)) {
      job.badLines += 1
      return false
    }
    if (await this.hasIndexed(record.id)) return false
    // A record with no index (a step that died halfway) is indexed again from what the club has
    const here = await this.store.get<BoardRecord>(`board:${record.id}`)
    if (!here && (await this.store.get(`${GONE}${record.id}`)) !== undefined) return false
    await this.config.restoreBoard(here ?? record)
    job.boards += 1
    job.rows += ROWS_PER_BOARD
    return true
  }

  private async hasIndexed(boardId: string) {
    return this.sql.exec('SELECT 1 FROM boards_index WHERE board_id = ?', boardId).length > 0
  }

  /** The D1 copy's rows for boards with no record; then the restore is done */
  private async restoreReplica(job: RestoreJob) {
    if (this.config.replica) {
      const after = await this.config.replica.dropMissing(job.replicaAfter)
      if (after !== null) {
        job.replicaAfter = after
        await this.save()
        return
      }
    }
    for (const key of (await this.store.list(GONE)).keys()) await this.store.delete(key)
    const { name, merged, boards, gone, badParts, badLines } = job
    this.state.lastRestore = { name, at: this.config.now(), merged, boards, gone, badParts, badLines }
    this.state.restore = undefined
    await this.save()
    this.config.log({ event: 'backup', ok: badParts === 0 && badLines === 0, step: 'restore', name, rows: merged, boards })
  }
}

interface KeyLine {
  k: string
  v: unknown
}
interface RowLine {
  t: string
  r: SqlRow
}
type PartLine = KeyLine | RowLine

/** A part of the activity, or null if it is not one. Lines outside the catalogue are never written: a part cannot name anything else */
export function parsePart(text: string): { last: boolean; lines: PartLine[] } | null {
  try {
    const [first, ...rest] = text.split('\n').filter((line) => line.trim() !== '')
    const header = JSON.parse(first) as { format?: unknown; kind?: unknown; last?: unknown; lines?: unknown }
    if (header.format !== BACKUP_FORMAT || header.kind !== 'activity' || header.lines !== rest.length) return null
    const lines = rest.flatMap((line): PartLine[] => {
      const entry = JSON.parse(line) as { k?: unknown; v?: unknown; t?: unknown; r?: unknown }
      if (typeof entry.k === 'string' && ACTIVITY_PREFIXES.some((p) => (entry.k as string).startsWith(p))) return [{ k: entry.k, v: decodeValue(entry.v) }]
      const { t, r } = entry
      if (typeof t === 'string' && ACTIVITY_TABLES.some((table) => table.name === t) && isObject(r) && Object.values(r).every(isSqlValue)) return [{ t, r: r as SqlRow }]
      throw new Error('outside the catalogue')
    })
    return { last: header.last === true, lines }
  } catch {
    return null
  }
}
