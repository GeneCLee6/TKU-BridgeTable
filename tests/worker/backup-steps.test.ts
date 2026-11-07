// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import type { Contract } from '../../shared/auction.ts'
import type { Seat } from '../../shared/cards.ts'
import { clubStoragePrefix } from '../../shared/clubs.ts'
import type { BoardState } from '../../shared/game.ts'
import { DEFAULT_HISTORY_QUERY } from '../../shared/history-query.ts'
import type { BoardRecord, ServerMessage } from '../../shared/protocol.ts'
import { GAMES_PER_OBJECT, parsePart, RESTORE_ROWS_PER_DAY, SWEEP_EVERY_DAYS } from '../../worker/backup-steps.ts'
import {
  ACTIVITY_PREFIXES,
  ACTIVITY_TABLES,
  BACKUP_FORMAT,
  BACKUP_PREFIXES,
  BACKUP_TABLES,
  backupAdmin,
  type BackupBucket,
  backupName,
  parseBackup,
} from '../../worker/backup.ts'
import { scopedBucket } from '../../worker/buckets.ts'
import { searchReplica } from '../../worker/history-replica.ts'
import type { LogEntry } from '../../worker/log.ts'
import { ClubService, type Connections, type ScheduleKind } from '../../worker/service.ts'
import type { MemoryStore } from '../../worker/store.ts'
import { memoryD1, type MemoryD1 } from './d1.ts'
import { memoryStore } from './sqlite.ts'

/**
 * The backup's game log and activity parts (e11-t12, worker/backup-steps.ts, DEPLOY.md §4.4), through
 * the real ClubService: a lost club comes back, a healthy one is left alone, and every step can be
 * interrupted. The alarm is the tests' `drain`, with a clock that jumps to each job's time
 */

class MemoryBucket implements BackupBucket {
  readonly objects = new Map<string, { text: string; uploaded: Date }>()
  /** How many more puts work before they start failing, when set */
  putsLeft: number | null = null
  pageSize = 1000

  async put(key: string, value: string) {
    if (this.putsLeft !== null && this.putsLeft-- <= 0) throw new Error('R2 is down')
    this.objects.set(key, { text: value, uploaded: new Date(0) })
  }
  async get(key: string) {
    const object = this.objects.get(key)
    return object ? { text: async () => object.text } : null
  }
  async list({ prefix = '', cursor }: { prefix?: string; cursor?: string } = {}) {
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort()
    const from = cursor ? Number(cursor) : 0
    const page = keys.slice(from, from + this.pageSize)
    const truncated = from + this.pageSize < keys.length
    return {
      objects: page.map((key) => ({ key, size: this.objects.get(key)!.text.length, uploaded: this.objects.get(key)!.uploaded })),
      truncated,
      cursor: truncated ? String(from + this.pageSize) : undefined,
    }
  }
  async delete(keys: string | string[]) {
    for (const key of [keys].flat()) this.objects.delete(key)
  }
  keys(prefix: string) {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort()
  }
}

class NoConnections implements Connections {
  readonly inbox: ServerMessage[] = []
  onlineUserIds() {
    return []
  }
  send(_userId: string, message: ServerMessage) {
    this.inbox.push(message)
  }
  disconnect() {}
}

let time: number
const tick = () => new Promise((resolve) => setImmediate(resolve))

interface Private {
  saveRecord(record: BoardRecord): Promise<void>
  writeRecord(record: BoardRecord): Promise<void>
  dropImported(id: string): Promise<void>
}

/** One club's object: its service, its waiting jobs, and how often it asked to restart */
async function open(store: MemoryStore, bucket: BackupBucket | undefined, extra: { d1?: MemoryD1; clubId?: string } = {}) {
  const queue: { run: () => void; ms: number; kind: ScheduleKind }[] = []
  const log: LogEntry[] = []
  const object = {
    store,
    bucket,
    queue,
    log,
    restarts: 0,
    club: undefined as unknown as ClubService,
    get internals() {
      return object.club as unknown as Private
    },
    /** Runs the alarm until no backup or copy job waits; each job's wait passes on the clock */
    async drain(limit = 20_000) {
      for (let i = 0; i < limit; i++) {
        const at = queue.findIndex((job) => job.kind === 'backup' || job.kind === 'replica')
        if (at < 0) return
        const [job] = queue.splice(at, 1)
        time += job.ms
        job.run()
        await tick()
      }
      throw new Error('jobs never stop')
    },
    /** Runs this many steps of the alarm, then stops as an evicted object would */
    async steps(count: number) {
      for (let i = 0; i < count; i++) {
        const at = queue.findIndex((job) => job.kind === 'backup')
        if (at < 0) return
        queue.splice(at, 1)[0].run()
        await tick()
      }
    },
    admin(method: string, path: string, body: Record<string, unknown> = {}) {
      return backupAdmin(method, path, async () => body, {
        bucket: bucket as BackupBucket,
        store,
        now: time,
        steps: object.club.backups,
        restored: async (prefixes) => {
          if (prefixes.includes('user:')) await object.club.reloadAccounts()
        },
      }) as Promise<Record<string, Record<string, unknown>>>
    },
    backupNow: () => object.admin('POST', '/backups'),
    restore: (name: string) => object.admin('POST', '/backups/restore', { name, dryRun: false, confirm: name }),
  }
  object.club = new ClubService(store, new NoConnections(), {
    maxUsers: 40,
    now: () => time,
    schedule: (run, ms, kind) => queue.push({ run, ms, kind }),
    backupBucket: bucket,
    restart: () => {
      object.restarts += 1
    },
    log: (entry) => log.push(entry),
    ...(extra.clubId && { clubId: extra.clubId }),
    ...(extra.d1 && { historyReplica: extra.d1 }),
  })
  await object.club.load()
  return object
}

type Club = Awaited<ReturnType<typeof open>>

async function member(club: Club, name: string) {
  const result = await club.club.register(name, 'club-secret-1', '')
  if ('user' in result) return result.user.id
  return (await club.club.adminApprove(club.club.adminApplications().find((a) => a.username === name)!.id)).id
}

const STRAINS = ['C', 'D', 'H', 'S', 'N'] as const

/** A finished board with these members at the table */
function record(n: number, people: string[], extra: Partial<BoardRecord> = {}): BoardRecord {
  const seats: Record<Seat, string> = { N: people[n % people.length], E: people[(n + 1) % people.length], S: 'robot:tku:S', W: 'robot:tku:W' }
  const players = Object.fromEntries(Object.entries(seats).map(([s, id]) => [s, { id, username: id }])) as BoardRecord['players']
  const contract: Contract = { level: ((n % 7) + 1) as Contract['level'], strain: STRAINS[n % 5], declarer: 'N', doubled: '' }
  const board = { boardNo: (n % 16) + 1, dealer: 'N', vul: 'None', contract, result: { declarerTricks: 8, scoreNS: n * 10, claimed: false } } as unknown as BoardState
  return { id: `b${String(n).padStart(4, '0')}`, tableNumber: 1, finishedAt: START + n * 60_000, players, board, ...extra }
}

const START = Date.parse('2026-10-01T00:00:00Z')
/** 03:00 in Taiwan, when the cron runs */
const CRON = Date.parse('2026-11-01T19:00:00Z')

async function play(club: Club, from: number, to: number, people: string[]) {
  for (let n = from; n < to; n++) await club.internals.saveRecord(record(n, people))
}

const count = (store: MemoryStore, table: string) => store.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)[0].n
const keys = async (store: MemoryStore, prefix: string) => [...(await store.list(prefix)).keys()]

/** A little of everything the parts hold, as the services would have written it */
async function seedActivity(store: MemoryStore, userId: string) {
  await store.put('featured:b0001', { title: 'A slam' })
  await store.put(`practicePresets:${userId}`, [{ id: 'p1' }])
  await store.put('meta:points', { rules: 1 })
  store.sql.exec("INSERT INTO favorites (user_id, board_id, note, tags, created_at, updated_at) VALUES (?, 'b0001', 'nice', '[]', 1, 1)", userId)
  store.sql.exec("INSERT INTO favorite_tags (user_id, tag, board_id) VALUES (?, 'slam', 'b0001')", userId)
  store.sql.exec("INSERT INTO direct_messages (id, pair, from_id, to_id, text, at) VALUES (7, 'p', ?, 'x', 'hello', 1)", userId)
  store.sql.exec("INSERT INTO puzzle_progress (user_id, puzzle_id, revision, status, played, node, hints, attempts, failures, clean, updated_at) VALUES (?, 'z', 'r', 'solved', '[]', 0, 0, 1, 0, 1, 1)", userId)
  store.sql.exec("INSERT INTO challenges (challenge_id, creator_id, created_at, status, accept_by, settings, deals) VALUES ('c1', ?, 1, 'finished', 1, '{}', '[]')", userId)
  store.sql.exec("INSERT INTO points_entries (event_id, user_id, kind, at, rank, field, points) VALUES ('e1', ?, 'k', 1, 1, 4, 10)", userId)
}

const today = () => backupName(time)

beforeEach(() => {
  time = CRON
})

describe('a club that lost everything', () => {
  it('comes back: games, lists, searches, accounts and activity', async () => {
    const bucket = new MemoryBucket()
    const first = await open(memoryStore(), bucket)
    const amy = await member(first, 'amy')
    const ben = await member(first, 'ben')
    await play(first, 0, 2 * GAMES_PER_OBJECT + 5, [amy, ben])
    await seedActivity(first.store, amy)
    const before = await first.club.search(amy, DEFAULT_HISTORY_QUERY)
    const { backup } = await first.backupNow()
    await first.drain()
    expect(first.club.backups!.status().lastSweepAt).toBe(CRON)
    expect(bucket.keys('games/').length).toBeGreaterThanOrEqual(3)
    expect(bucket.keys(`activity/${today().slice(6, -6)}/`).length).toBeGreaterThanOrEqual(1)
    expect(parseBackup(bucket.objects.get(backup.name as string)!.text).header).toMatchObject({ version: 4, boards: 45 })

    // The object is gone. The first account of a new one signs in and restores
    const store = memoryStore()
    time += 3600_000
    const lost = await open(store, bucket)
    await member(lost, 'rescuer')
    const dry = await lost.admin('POST', '/backups/restore', { name: today() })
    expect(dry.restore.steps).toMatchObject({ activityComplete: true, boardsNow: 0 })
    expect(await keys(store, 'board:')).toEqual([])

    await lost.restore(today())
    await lost.drain()
    expect(lost.restarts).toBe(1)
    expect(lost.club.backups!.status()).toMatchObject({ restoring: null, lastRestore: { boards: 45, badLines: 0, badParts: 0 } })

    // What the reset gives: every service reads storage again
    const back = await open(store, bucket)
    await back.drain()
    expect(await keys(store, 'board:')).toHaveLength(45)
    expect(count(store, 'boards_index')).toBe(45)
    expect(count(store, 'board_players')).toBe(45 * 4)
    expect((await keys(store, 'hist:')).length).toBe(45)
    expect((await keys(store, `uhist:${amy}:`)).length).toBe(45)
    expect(await back.club.history(amy, true, 1, 100)).toMatchObject({ total: 45 })
    expect(await back.club.search(amy, DEFAULT_HISTORY_QUERY)).toEqual(before)
    expect((await store.get('user:' + amy)) as object).toMatchObject({ username: 'amy' })
    expect(await store.get('featured:b0001')).toEqual({ title: 'A slam' })
    expect(await store.get(`practicePresets:${amy}`)).toEqual([{ id: 'p1' }])
    for (const table of ['favorites', 'favorite_tags', 'direct_messages', 'puzzle_progress', 'challenges', 'points_entries']) expect(count(store, table)).toBe(1)
  })

  it('takes a board’s newest version and leaves out one deleted since', async () => {
    const bucket = new MemoryBucket()
    const first = await open(memoryStore(), bucket)
    const amy = await member(first, 'amy')
    await play(first, 0, 3, [amy])
    await first.backupNow()
    await first.drain()
    // Later versions in the log's newer objects
    await first.internals.writeRecord(record(1, [amy], { revealAt: 123 }))
    await first.internals.dropImported('b0002')
    time += 86_400_000
    await first.backupNow()
    await first.drain()

    const store = memoryStore()
    const lost = await open(store, bucket)
    await member(lost, 'rescuer')
    await lost.restore(today())
    await lost.drain()
    expect(await keys(store, 'board:')).toEqual(['board:b0000', 'board:b0001'])
    expect(await store.get<BoardRecord>('board:b0001')).toMatchObject({ revealAt: 123 })
    expect(await keys(store, 'bkgone:')).toEqual([])
    expect(count(store, 'boards_index')).toBe(2)
  })

  it('keeps D1 right: restored boards in, boards with no record out, same answers', async () => {
    const bucket = new MemoryBucket()
    const d1 = memoryD1()
    const first = await open(memoryStore(), bucket, { d1 })
    await first.drain()
    const amy = await member(first, 'amy')
    await play(first, 0, 10, [amy])
    await first.backupNow()
    await first.drain()
    // Played after the backup, copied to D1, then the object is lost: no copy of the record is left
    await play(first, 10, 13, [amy])
    await first.drain()
    expect(d1.rows('SELECT board_id FROM boards_index')).toHaveLength(13)

    const store = memoryStore()
    const lost = await open(store, bucket, { d1 })
    await lost.drain()
    await member(lost, 'rescuer')
    await lost.restore(today())
    await lost.drain()
    expect(d1.rows('SELECT board_id FROM boards_index')).toHaveLength(10)
    expect(d1.rows('SELECT board_id FROM board_summaries')).toHaveLength(10)
    expect(await keys(store, 'replq:')).toEqual([])
    const back = await open(store, bucket, { d1 })
    await back.drain()
    expect(await searchReplica(d1, 'tku', DEFAULT_HISTORY_QUERY, amy, time)).toEqual(await back.club.search(amy, DEFAULT_HISTORY_QUERY))
  })
})

describe('a healthy club', () => {
  it('rolls the accounts back and leaves games, activity and tables alone', async () => {
    const bucket = new MemoryBucket()
    const club = await open(memoryStore(), bucket)
    const amy = await member(club, 'amy')
    await play(club, 0, 25, [amy])
    await seedActivity(club.store, amy)
    await club.club.handle(amy, { type: 'createTable' })
    await club.backupNow()
    await club.drain()
    const logged = bucket.keys('games/')

    // Since the backup: more boards, a ruling-like change to a board, a row moved on, a new account
    time += 3 * 86_400_000
    await play(club, 25, 30, [amy])
    await club.internals.writeRecord(record(3, [amy], { revealAt: 999 }))
    club.store.sql.exec("UPDATE challenges SET status = 'open' WHERE challenge_id = 'c1'")
    const later = await member(club, 'later')
    const tables = await club.store.list('table:')
    expect(tables.size).toBe(1)
    const savedTable = JSON.stringify([...tables.values()])

    const name = backupName(CRON)
    const writes = count(club.store, 'boards_index')
    await club.restore(name)
    await club.drain()

    expect(await club.store.get(`user:${later}`)).toBeUndefined()
    expect(count(club.store, 'boards_index')).toBe(writes)
    expect(await keys(club.store, 'board:')).toHaveLength(30)
    expect(await club.store.get<BoardRecord>('board:b0003')).toMatchObject({ revealAt: 999 })
    expect(club.store.sql.exec<{ status: string }>("SELECT status FROM challenges WHERE challenge_id = 'c1'")[0].status).toBe('open')
    expect(club.restarts).toBe(0)
    expect(club.club.backups!.status().lastRestore).toMatchObject({ merged: 0, boards: 0 })
    expect(JSON.stringify([...(await club.store.list('table:')).values()])).toBe(savedTable)
    // Nothing it restored was queued to be logged again
    expect(bucket.keys('games/').slice(0, logged.length)).toEqual(logged)
  })

  it('rebuilds a lost index from the records the club still has, and fills in what is missing', async () => {
    const bucket = new MemoryBucket()
    const club = await open(memoryStore(), bucket)
    const amy = await member(club, 'amy')
    await play(club, 0, 6, [amy])
    await seedActivity(club.store, amy)
    await club.backupNow()
    await club.drain()
    const before = await club.club.search(amy, DEFAULT_HISTORY_QUERY)
    club.store.sql.exec('DELETE FROM boards_index')
    club.store.sql.exec('DELETE FROM board_players')
    await club.store.delete('board:b0002')
    club.store.sql.exec("DELETE FROM favorites")
    expect((await club.club.search(amy, DEFAULT_HISTORY_QUERY)).total).toBe(0)

    await club.restore(today())
    await club.drain()
    expect(count(club.store, 'boards_index')).toBe(6)
    expect(count(club.store, 'board_players')).toBe(24)
    expect(await club.store.get('board:b0002')).toBeDefined()
    expect(count(club.store, 'favorites')).toBe(1)
    expect(club.restarts).toBe(1)
    expect(await club.club.search(amy, DEFAULT_HISTORY_QUERY)).toEqual(before)
  })
})

describe('steps that stop halfway', () => {
  it('carries on a sweep after R2 fails and after the object is evicted', async () => {
    const bucket = new MemoryBucket()
    const store = memoryStore()
    const first = await open(store, bucket)
    const amy = await member(first, 'amy')
    await play(first, 0, 5 * GAMES_PER_OBJECT, [amy])
    await first.backupNow()

    // The core went out; the steps stop on R2 after a few objects, and wait to try again
    bucket.putsLeft = 2
    await first.steps(4)
    expect(first.log.some((l) => l.event === 'backup' && !l.ok)).toBe(true)
    const waiting = first.queue.find((job) => job.kind === 'backup')!
    expect(waiting.ms).toBeGreaterThan(1000)
    bucket.putsLeft = null

    // Evicted: jobs are not stored, where it got to is
    const second = await open(store, bucket)
    await second.steps(2)
    const third = await open(store, bucket)
    await third.drain()
    expect(third.club.backups!.status()).toMatchObject({ exporting: null, sweeping: null })
    expect(await keys(store, 'bakq:')).toEqual([])

    const restored = memoryStore()
    const lost = await open(restored, bucket)
    await member(lost, 'rescuer')
    await lost.restore(today())
    await lost.drain()
    expect(await keys(restored, 'board:')).toHaveLength(5 * GAMES_PER_OBJECT)
  })

  it('carries on a restore after an eviction, and waits for tomorrow’s writes', async () => {
    const bucket = new MemoryBucket()
    const first = await open(memoryStore(), bucket)
    const amy = await member(first, 'amy')
    await play(first, 0, 2 * GAMES_PER_OBJECT, [amy])
    await seedActivity(first.store, amy)
    await first.backupNow()
    await first.drain()

    const store = memoryStore()
    const lost = await open(store, bucket)
    await member(lost, 'rescuer')
    await lost.restore(today())
    await lost.steps(6)
    expect(lost.club.backups!.status().restoring).toMatchObject({ stage: 'games' })
    const partway = (await keys(store, 'board:')).length
    expect(partway).toBeGreaterThan(0)
    expect(partway).toBeLessThan(2 * GAMES_PER_OBJECT)
    // The quota is gone for today: the next object waits past the next UTC midnight
    const state = (await store.get<{ restore: { rows: number; day: number } }>('meta:backupjob'))!
    state.restore.rows = RESTORE_ROWS_PER_DAY
    await store.put('meta:backupjob', state)

    const evicted = await open(store, bucket)
    await evicted.steps(1)
    expect((await keys(store, 'board:')).length).toBe(partway)
    const wait = evicted.queue.find((job) => job.kind === 'backup')!.ms
    expect(wait).toBeGreaterThan(0)
    expect(Math.floor((time + wait) / 86_400_000)).toBe(Math.floor(time / 86_400_000) + 1)
    await evicted.drain()
    expect(await keys(store, 'board:')).toHaveLength(2 * GAMES_PER_OBJECT)
    expect(evicted.club.backups!.status().restoring).toBeNull()
  })
})

describe('older backups', () => {
  it('reads version 3: its core only, no games or activity touched', async () => {
    const bucket = new MemoryBucket()
    const club = await open(memoryStore(), bucket)
    const amy = await member(club, 'amy')
    await play(club, 0, 2, [amy])
    await club.backupNow()
    await club.drain()
    const name = 'daily/2026-10-01.jsonl'
    const header = { format: BACKUP_FORMAT, version: 3, createdAt: '2026-10-01T00:00:00.000Z', prefixes: ['book:'], keys: 1, tables: [], rows: 0 }
    bucket.objects.set(name, { text: `${JSON.stringify(header)}\n${JSON.stringify({ k: 'book:version', v: 5 })}\n`, uploaded: new Date(0) })
    await club.store.delete('board:b0001')

    const dry = await club.admin('POST', '/backups/restore', { name })
    expect(dry.restore).toMatchObject({ version: 3, puts: 1 })
    expect(dry.restore.steps).toBeUndefined()
    const { restore } = await club.restore(name)
    expect(restore.version).toBe(3)
    await club.drain()
    expect(club.club.backups!.status().lastRestore).toBeNull()
    // The log is not read, so the board stays missing: this backup says nothing about it
    expect(await club.store.get('board:b0001')).toBeUndefined()
    expect(await club.store.get('user:' + amy)).toBeDefined()
  })
})

describe('clubs', () => {
  it('each keep and restore their own objects', async () => {
    const raw = new MemoryBucket()
    const other = scopedBucket(raw as never, clubStoragePrefix('ntu')) as unknown as BackupBucket
    expect(clubStoragePrefix('tku')).toBe('')

    const tku = await open(memoryStore(), raw)
    const ntu = await open(memoryStore(), other, { clubId: 'ntu' })
    const amy = await member(tku, 'amy')
    await play(tku, 0, 3, [amy])
    await ntu.internals.saveRecord(record(500, ['nia']))
    await tku.backupNow()
    await ntu.backupNow()
    await tku.drain()
    await ntu.drain()

    expect(raw.keys('games/').length).toBeGreaterThan(0)
    expect(raw.keys('clubs/ntu/games/').length).toBeGreaterThan(0)
    expect(raw.keys('clubs/ntu/activity/').length).toBeGreaterThan(0)
    expect(raw.keys('clubs/ntu/daily/').length).toBe(1)
    const tkuUsage = (await tku.admin('GET', '/backups')).usage as unknown as { games: { objects: number } }
    expect(tkuUsage.games.objects).toBe(raw.keys('games/').length)

    // Only ntu's own lost: its restore brings its own board, and 淡江's objects stay as they were
    const tkuKeys = raw.keys('games/')
    const store = memoryStore()
    const lost = await open(store, other, { clubId: 'ntu' })
    await lost.club.backups!.startRestore(today())
    await lost.drain()
    expect(await keys(store, 'board:')).toEqual(['board:b0500'])
    expect(raw.keys('games/')).toEqual(tkuKeys)
    expect(await keys(tku.store, 'board:')).toHaveLength(3)
  })
})

describe('the log’s size over time', () => {
  async function sweepAfterDays(club: Club) {
    time += SWEEP_EVERY_DAYS * 86_400_000
    await club.backupNow()
    await club.drain()
  }

  it('keeps two finished passes, and a restore still finds everything', async () => {
    const bucket = new MemoryBucket()
    const club = await open(memoryStore(), bucket)
    const amy = await member(club, 'amy')
    await play(club, 0, 3 * GAMES_PER_OBJECT, [amy])
    await club.backupNow()
    await club.drain()
    const firstPass = bucket.keys('games/')

    await sweepAfterDays(club)
    const secondPass = bucket.keys('games/')
    expect(secondPass.length).toBeGreaterThan(firstPass.length)
    await sweepAfterDays(club)
    const left = bucket.keys('games/')
    for (const key of firstPass) expect(left).not.toContain(key)
    expect(left.length).toBe(6)
    // A board deleted after the first pass is out of R2 once two later passes are done
    await club.internals.dropImported('b0005')
    await sweepAfterDays(club)
    await sweepAfterDays(club)
    const texts = bucket.keys('games/').map((key) => bucket.objects.get(key)!.text)
    expect(texts.some((text) => text.includes('"id":"b0005"'))).toBe(false)
    expect(await keys(club.store, 'bakq:')).toEqual([])

    const store = memoryStore()
    const lost = await open(store, bucket)
    await member(lost, 'rescuer')
    await lost.restore(today())
    await lost.drain()
    expect(await keys(store, 'board:')).toHaveLength(3 * GAMES_PER_OBJECT - 1)
  })

  it('never lets an emptied club clean away the log', async () => {
    const bucket = new MemoryBucket()
    const first = await open(memoryStore(), bucket)
    const amy = await member(first, 'amy')
    await play(first, 0, 2 * GAMES_PER_OBJECT, [amy])
    await first.backupNow()
    await first.drain()
    const before = bucket.keys('games/')

    // The object lost everything, its own notes on the log too, and nobody noticed for months
    const store = memoryStore()
    const lost = await open(store, bucket)
    for (let i = 0; i < 4; i++) await sweepAfterDays(lost)
    const after = bucket.keys('games/')
    for (const key of before) expect(after).toContain(key)
    expect(await keys(store, 'board:')).toEqual([])
    await member(lost, 'rescuer')
    await lost.restore(today())
    await lost.drain()
    expect(await keys(store, 'board:')).toHaveLength(2 * GAMES_PER_OBJECT)
  })

  it('stops a pass that finds far fewer boards from deleting anything', async () => {
    const bucket = new MemoryBucket()
    const club = await open(memoryStore(), bucket)
    const amy = await member(club, 'amy')
    await play(club, 0, 10, [amy])
    await club.backupNow()
    await club.drain()
    await sweepAfterDays(club)
    const before = bucket.keys('games/')
    for (let n = 0; n < 8; n++) await club.store.delete(`board:b000${n}`)
    await sweepAfterDays(club)
    for (const key of before) expect(bucket.keys('games/')).toContain(key)
    expect(club.log.some((l) => l.event === 'backup' && !l.ok && (l.error ?? '').includes('older objects kept'))).toBe(true)
  })
})

describe('the activity’s parts', () => {
  async function withManyRows() {
    const bucket = new MemoryBucket()
    const club = await open(memoryStore(), bucket)
    const amy = await member(club, 'amy')
    club.store.sql.transaction(() => {
      for (let id = 1; id <= 1500; id++)
        club.store.sql.exec("INSERT INTO direct_messages (id, pair, from_id, to_id, text, at) VALUES (?, 'p', ?, 'x', ?, 1)", id, amy, `message ${id} ${'x'.repeat(100)}`)
    })
    for (let n = 0; n < 120; n++) await club.store.put(`audit:${String(n).padStart(4, '0')}`, { n })
    return { bucket, club, amy }
  }
  const lines = (bucket: MemoryBucket, date: string) => bucket.keys(`activity/${date}/`).flatMap((key) => parsePart(bucket.objects.get(key)!.text)!.lines)

  it('splits on keys, in parts of a size one step can take, with nothing twice', async () => {
    const { bucket, club } = await withManyRows()
    await club.backupNow()
    await club.drain()
    const date = today().slice(6, -6)
    const parts = bucket.keys(`activity/${date}/`)
    expect(parts.length).toBeGreaterThan(2)
    for (const key of parts) expect(bucket.objects.get(key)!.text.length).toBeLessThan(120_000)
    const all = lines(bucket, date)
    const ids = all.flatMap((line) => ('t' in line && line.t === 'direct_messages' ? [line.r.id] : []))
    expect(ids).toHaveLength(1500)
    expect(new Set(ids).size).toBe(1500)
    expect(all.filter((line) => 'k' in line && line.k.startsWith('audit:'))).toHaveLength(120)
    expect(parsePart(bucket.objects.get(parts.at(-1)!)!.text)!.last).toBe(true)
    expect(parsePart(bucket.objects.get(parts[0])!.text)!.last).toBe(false)
  })

  it('a second run the same day replaces the first; old days go with their daily object', async () => {
    const { bucket, club } = await withManyRows()
    await club.backupNow()
    await club.drain()
    const date = today().slice(6, -6)
    const firstCount = bucket.keys(`activity/${date}/`).length
    club.store.sql.exec('DELETE FROM direct_messages WHERE id > 100')
    await club.backupNow()
    await club.drain()
    expect(bucket.keys(`activity/${date}/`).length).toBeLessThan(firstCount)
    expect(lines(bucket, date).filter((line) => 't' in line && line.t === 'direct_messages')).toHaveLength(100)

    time += 40 * 86_400_000
    await club.backupNow()
    await club.drain()
    expect(bucket.keys(`activity/${date}/`)).toEqual([])
    expect(bucket.keys(`activity/${today().slice(6, -6)}/`).length).toBeGreaterThan(0)
  })

  it('an export that never finished still gives back what it wrote, and says so', async () => {
    const { club } = await withManyRows()
    await club.backupNow()
    await club.steps(2)
    const dry = await club.admin('POST', '/backups/restore', { name: today() })
    expect(dry.restore.steps).toMatchObject({ activityComplete: false })
    expect((dry.restore.steps as unknown as { activityParts: number }).activityParts).toBeGreaterThan(0)
  })

  it('refuses a part that names anything outside the catalogue', () => {
    const part = (line: object) => `${JSON.stringify({ format: BACKUP_FORMAT, kind: 'activity', lines: 1, last: true })}\n${JSON.stringify(line)}\n`
    expect(parsePart(part({ k: 'featured:a', v: 1 }))).toMatchObject({ last: true })
    expect(parsePart(part({ k: 'user:a', v: 1 }))).toBeNull()
    expect(parsePart(part({ t: 'sqlite_master', r: {} }))).toBeNull()
    expect(parsePart(part({ t: 'favorites', r: { a: { nested: 1 } } }))).toBeNull()
    expect(parsePart('not json')).toBeNull()
  })
})

describe('the catalogue', () => {
  /** Every table a club makes is decided: a new one fails here until someone says where it goes */
  const REBUILT = ['boards_index', 'board_players', 'board_rulings']
  const NOT_KEPT = [
    'partner_bid_sessions',
    'partner_bid_boards',
    'match_watchers',
    'support_reports',
    'book_errors',
    'book_metrics',
    'book_visitors',
    'book_telemetry_settings',
    'product_metrics',
    'product_retention',
    'product_seen',
    'product_salts',
  ]

  it('says where every SQL table goes', async () => {
    const { store } = await open(memoryStore(), new MemoryBucket())
    new (await import('../../worker/forum.ts')).ForumService(store.sql, { now: () => 0, newId: () => 'x', members: () => [] }).createTables()
    new (await import('../../worker/book-telemetry.ts')).BookTelemetry(store.sql, { now: () => 0, log: () => {} }).createTables()
    const tables = store.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'forum_%fts%'").map((t) => t.name)
    const decided = new Set([...BACKUP_TABLES.map((t) => t.name), ...ACTIVITY_TABLES.map((t) => t.name), ...REBUILT, ...NOT_KEPT])
    expect(tables.filter((t) => !decided.has(t))).toEqual([])
    for (const table of ACTIVITY_TABLES) {
      expect(tables).toContain(table.name)
      const key = store.sql
        .exec<{ name: string; pk: number }>(`PRAGMA table_info(${table.name})`)
        .filter((c) => c.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((c) => c.name)
      expect(table.key).toEqual(key)
    }
  })

  it('keeps the parts’ keys out of the core, whose restore rolls back and deletes', () => {
    for (const prefix of ACTIVITY_PREFIXES) expect(BACKUP_PREFIXES.some((p) => prefix.startsWith(p) || p.startsWith(prefix))).toBe(false)
    for (const derived of ['board:', 'hist:', 'uhist:', 'bakq:', 'replq:', 'session:']) expect([...ACTIVITY_PREFIXES, ...BACKUP_PREFIXES].some((p) => derived.startsWith(p))).toBe(false)
  })
})
