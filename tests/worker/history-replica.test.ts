// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import type { Contract } from '../../shared/auction.ts'
import type { Seat } from '../../shared/cards.ts'
import type { BoardState } from '../../shared/game.ts'
import { DEFAULT_HISTORY_QUERY, taiwanDayStart, type HistoryQuery } from '../../shared/history-query.ts'
import { summarize, type BoardRecord } from '../../shared/protocol.ts'
import { createHistoryIndex, indexRecord, listQuery, searchBoards } from '../../worker/history-index.ts'
import {
  REPLICA_BATCH,
  ReplicaSync,
  RETRY_MS,
  searchReplica,
} from '../../worker/history-replica.ts'
import type { LogEntry } from '../../worker/log.ts'
import type { JobKind, Scheduler } from '../../worker/scheduler.ts'
import { MemoryStore } from '../../worker/store.ts'
import { memoryD1, type MemoryD1 } from './d1.ts'
import { memorySql } from './sqlite.ts'

/**
 * The history index's D1 copy (ARCHITECTURE.md §5.12, `e11-t20`): filled from the records a step at
 * a time, kept in step through the outbox, answering every search exactly as the club's own index,
 * and safe to switch off and on
 */

const DAY = taiwanDayStart('2026-10-20')
const PEOPLE = ['amy', 'ben', 'cat', 'dan', 'eve']
const STRAINS = ['C', 'D', 'H', 'S', 'N'] as const

/** A finished board; `n` varies the players, contract, result and time */
function record(n: number, extra: Partial<BoardRecord> = {}): BoardRecord {
  const seats: Record<Seat, string> = {
    N: PEOPLE[n % 5],
    E: PEOPLE[(n + 1) % 5],
    S: n % 3 ? PEOPLE[(n + 2) % 5] : 'robot:gib:S',
    W: 'robot:tku:W',
  }
  const players = Object.fromEntries(Object.entries(seats).map(([s, id]) => [s, { id, username: id }])) as BoardRecord['players']
  const contract: Contract | null = n % 7 === 0 ? null : { level: (n % 7) as Contract['level'], strain: STRAINS[n % 5], declarer: (['N', 'E', 'S', 'W'] as const)[n % 4], doubled: n % 11 ? '' : 'X' }
  const board = {
    boardNo: (n % 16) + 1,
    dealer: 'N',
    vul: n % 2 ? 'NS' : 'None',
    contract,
    result: { declarerTricks: contract ? 6 + ((n * 3) % 8) : 0, scoreNS: (n % 9) * 50 - 200, claimed: n % 4 === 0 },
  } as unknown as BoardState
  return { id: `b${String(n).padStart(4, '0')}`, tableNumber: (n % 3) + 1, finishedAt: DAY + n * 60_000, players, board, ...extra }
}

/** The scheduler as the alarm queue runs it, by hand: `next` runs the earliest job */
function handScheduler() {
  const jobs = new Map<string, { at: number; kind: JobKind; run: () => Promise<void> }>()
  let clock = 0
  const scheduler: Scheduler = {
    add(key, kind, ms, run) {
      if (!jobs.has(key)) jobs.set(key, { at: clock + ms, kind, run })
    },
    pending: (key) => jobs.has(key),
  }
  return {
    scheduler,
    jobs,
    /** Runs the earliest job; false when none waits */
    async next() {
      const first = [...jobs].sort((a, b) => a[1].at - b[1].at)[0]
      if (!first) return false
      jobs.delete(first[0])
      clock = Math.max(clock, first[1].at)
      await first[1].run()
      return true
    },
    async drain(limit = 500) {
      for (let i = 0; i < limit; i++) if (!(await this.next())) return i
      throw new Error('jobs never stop')
    },
  }
}

let store: MemoryStore
let d1: MemoryD1
let hand: ReturnType<typeof handScheduler>
let logs: LogEntry[]
const NOW = DAY + 30 * 86_400_000

function sync() {
  return new ReplicaSync({ store, db: d1, scheduler: hand.scheduler, now: () => NOW, log: (entry) => logs.push(entry) })
}

/** Writes records as the club does (its own index, then `board:`), queuing each for the copy */
async function write(replica: ReplicaSync, records: BoardRecord[]) {
  for (const r of records) {
    indexRecord(store.sql, r)
    await store.put(`board:${r.id}`, r)
    await replica.queue(r.id)
  }
}

const ready = () => d1.rows<{ value: string }>("SELECT value FROM index_meta WHERE key = 'ready'")[0]?.value

beforeEach(() => {
  store = new MemoryStore(memorySql())
  createHistoryIndex(store.sql)
  d1 = memoryD1()
  hand = handScheduler()
  logs = []
})

/** Searches both sides; the copy must answer exactly as the club's index and records */
async function both(query: HistoryQuery, viewer: string) {
  const found = searchBoards(store.sql, query, viewer, NOW)
  const boards = await Promise.all(found.ids.map(async (id) => summarize((await store.get<BoardRecord>(`board:${id}`))!)))
  const club = { boards, total: found.total, page: found.page, size: query.size }
  const edge = await searchReplica(d1, query, viewer, NOW)
  return { club, edge }
}

describe('filling the D1 copy', () => {
  it('copies every record a batch per step, then answers every search as the club does', async () => {
    const records = Array.from({ length: 57 }, (_, n) => record(n + 1))
    // A challenge board still kept back, and a practice board: the copy keeps them out the same way
    records.push(record(100, { mode: 'challenge', eventId: 'ch1', revealAt: NOW + 86_400_000 }), record(101, { mode: 'practice' }))
    for (const r of records) {
      indexRecord(store.sql, r)
      await store.put(`board:${r.id}`, r)
    }
    const replica = sync()
    await replica.load(true)
    expect(await searchReplica(d1, listQuery(true, 1, 20), 'amy', NOW)).toBeNull()
    // Not complete until the last step: the Worker keeps asking the club
    await hand.next()
    await hand.next()
    expect(ready()).toBe('0')
    expect(await searchReplica(d1, listQuery(true, 1, 20), 'amy', NOW)).toBeNull()
    await hand.drain()
    expect(ready()).toBe('1')
    expect(replica.status).toBe('ready')
    expect(d1.rows('SELECT board_id FROM boards_index')).toHaveLength(records.length)
    expect(d1.rows('SELECT * FROM board_players')).toHaveLength(records.length * 4)
    // Each call stays well inside the free plan's 50 queries
    expect(d1.largest).toBeLessThanOrEqual(15)
    expect(Math.ceil(records.length / REPLICA_BATCH)).toBeLessThanOrEqual(d1.batches)

    const queries: Partial<HistoryQuery>[] = [
      {},
      { scope: 'all' },
      { scope: 'all', page: 2, size: 10 },
      { scope: 'all', page: 99, size: 10 },
      { scope: 'all', level: 3 },
      { scope: 'all', strain: 'S', sort: 'score_desc' },
      { scope: 'all', bracket: 'passout' },
      { scope: 'all', declarerSide: 'partner', sort: 'tricks_asc' },
      { partner: 'ben' },
      { scope: 'all', player: 'cat', result: 'down' },
      { scope: 'all', mode: 'challenge' },
      { scope: 'all', mode: 'practice' },
      { scope: 'all', doubled: 'X', vul: 'NS' },
    ]
    for (const viewer of ['amy', 'ben', 'dan']) {
      for (const q of queries) {
        const query = { ...DEFAULT_HISTORY_QUERY, ...q }
        const { club, edge } = await both(query, viewer)
        expect(edge, `${viewer} ${JSON.stringify(q)}`).toEqual(club)
      }
    }
    // The board kept back: only its players get it, from either side
    const kept = 'b0100'
    const has = async (viewer: string) => (await searchReplica(d1, listQuery(true, 1, 100), viewer, NOW))!.boards.some((b) => b.id === kept)
    expect(await has('amy')).toBe(true)
    expect(await has('dan')).toBe(false)
  })

  it('carries on where it stopped after the club is evicted, and copies what was written meanwhile', async () => {
    const records = Array.from({ length: 50 }, (_, n) => record(n + 1))
    for (const r of records) await store.put(`board:${r.id}`, r)
    await sync().load(true)
    await hand.next()
    await hand.next()
    const done = d1.rows('SELECT board_id FROM boards_index').length
    expect(done).toBe(REPLICA_BATCH * 2)
    // Evicted: the jobs are gone; a new board arrives with the next load
    hand.jobs.clear()
    const replica = sync()
    await replica.load(true)
    await write(replica, [record(500)])
    await hand.drain()
    expect(ready()).toBe('1')
    expect(d1.rows('SELECT board_id FROM boards_index')).toHaveLength(51)
    expect(await store.list('replq:')).toHaveProperty('size', 0)
  })
})

describe('keeping the copy in step', () => {
  async function filled() {
    const replica = sync()
    await replica.load(true)
    await hand.drain()
    return replica
  }

  it('copies each board written, rewrites a board written again and takes out one whose record is gone', async () => {
    const replica = await filled()
    const kept = record(1, { mode: 'challenge', eventId: 'ch1', revealAt: NOW + 1000 })
    await write(replica, [kept, record(2), record(3)])
    expect(hand.jobs.get('replica:flush')?.kind).toBe('replica')
    await hand.drain()
    expect((await searchReplica(d1, listQuery(true, 1, 20), 'amy', NOW))!.total).toBe(2)
    // The challenge ends: the record is written again, shown from now
    await write(replica, [{ ...kept, revealAt: NOW }])
    await hand.drain()
    expect((await searchReplica(d1, listQuery(true, 1, 20), 'amy', NOW))!.total).toBe(3)
    expect(d1.rows('SELECT reveal_at FROM boards_index WHERE board_id = ?', kept.id)).toEqual([{ reveal_at: NOW }])
    // A board saved halfway is taken back out by the club (§5.3): the copy follows
    await store.delete(`board:${record(2).id}`)
    await replica.queue(record(2).id)
    await hand.drain()
    expect(d1.rows('SELECT board_id FROM boards_index ORDER BY board_id')).toEqual([{ board_id: 'b0001' }, { board_id: 'b0003' }])
    expect(d1.rows('SELECT board_id FROM board_summaries WHERE board_id = ?', 'b0002')).toEqual([])
  })

  it('keeps boards in the outbox while D1 fails, waiting longer each time, and copies them once it is back', async () => {
    const replica = await filled()
    d1.fail = new Error('D1_ERROR: daily limit reached')
    await write(replica, [record(1), record(2)])
    await hand.next()
    expect(logs.at(-1)).toMatchObject({ event: 'replica', step: 'flush', ok: false })
    expect((await store.list('replq:')).size).toBe(2)
    const first = hand.jobs.get('replica:flush')!.at
    await hand.next()
    expect(hand.jobs.get('replica:flush')!.at - first).toBe(RETRY_MS * 2)
    d1.fail = null
    await hand.drain()
    expect((await store.list('replq:')).size).toBe(0)
    expect(d1.rows('SELECT board_id FROM boards_index')).toHaveLength(2)
  })

  it('never drops a board queued again while its batch was being written', async () => {
    const replica = await filled()
    await write(replica, [record(1)])
    const batch = d1.batch.bind(d1)
    // While D1 writes the first version, the board is written again
    d1.batch = async (statements) => {
      d1.batch = batch
      await write(replica, [{ ...record(1), revealAt: NOW - 5 }])
      return batch(statements)
    }
    await hand.drain()
    expect(d1.rows('SELECT reveal_at FROM boards_index')).toEqual([{ reveal_at: NOW - 5 }])
    expect((await store.list('replq:')).size).toBe(0)
  })

  it('writes the copy in batches of REPLICA_BATCH, each well inside D1’s limits', async () => {
    const replica = await filled()
    await write(replica, Array.from({ length: 45 }, (_, n) => record(n + 1)))
    d1.largest = 0
    const runs = await hand.drain()
    expect(runs).toBe(3)
    expect(d1.largest).toBeLessThanOrEqual(15)
    expect(d1.rows('SELECT board_id FROM boards_index')).toHaveLength(45)
  })
})

describe('switching the copy off and on (HISTORY_D1=off)', () => {
  it('stops queuing, tells D1 it is not complete, and fills it afresh when switched back on', async () => {
    let replica = sync()
    await replica.load(true)
    await hand.drain()
    await write(replica, [record(1)])
    // Switched off before the board was copied: the queue goes, D1 says not complete
    hand.jobs.clear()
    replica = sync()
    await replica.load(false)
    expect(replica.status).toBe('off')
    expect((await store.list('replq:')).size).toBe(0)
    // D1 is told by a job: loading the club never waits on D1
    expect(ready()).toBe('1')
    await hand.drain()
    expect(ready()).toBe('0')
    await write(replica, [record(2)])
    expect((await store.list('replq:')).size).toBe(0)
    expect(hand.jobs.size).toBe(0)
    // Back on: everything written while off is in the copy before the Worker reads it again
    replica = sync()
    await replica.load(true)
    expect(await searchReplica(d1, listQuery(true, 1, 20), 'amy', NOW)).toBeNull()
    await hand.drain()
    expect(ready()).toBe('1')
    expect(d1.rows('SELECT board_id FROM boards_index ORDER BY board_id')).toEqual([{ board_id: 'b0001' }, { board_id: 'b0002' }])
  })

  it('keeps trying to tell D1 when it is down at the switch', async () => {
    const replica = sync()
    await replica.load(true)
    await hand.drain()
    d1.fail = new Error('network')
    await sync().load(false)
    await hand.next()
    await hand.next()
    expect(ready()).toBe('1')
    expect(logs.filter((entry) => entry.event === 'replica' && entry.step === 'off' && !entry.ok)).toHaveLength(2)
    expect(hand.jobs.has('replica:off')).toBe(true)
    d1.fail = null
    await hand.drain()
    expect(ready()).toBe('0')
  })

  it('fills the copy again when D1 lost its tables or the copy is of an older version', async () => {
    let replica = sync()
    await replica.load(true)
    await write(replica, [record(1)])
    await hand.drain()
    d1.db.exec('DROP TABLE boards_index')
    await write(replica, [record(2)])
    await hand.drain()
    expect(ready()).toBe('1')
    expect(d1.rows('SELECT board_id FROM boards_index')).toHaveLength(2)
    // An older version's copy
    await store.put('meta:replica', { state: 'ready', version: 0 })
    hand.jobs.clear()
    replica = sync()
    await replica.load(true)
    expect(replica.status).toBe('off')
    const batches = d1.batches
    await hand.drain()
    expect(replica.status).toBe('ready')
    expect(ready()).toBe('1')
    // Made the tables and marked not complete, wrote the records, marked complete
    expect(d1.batches - batches).toBe(3)
  })
})
