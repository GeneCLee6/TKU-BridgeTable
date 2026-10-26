// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { summarize } from '../../scripts/load/stats.ts'

/**
 * The lobby broadcast on its own (H3b, docs/LOAD.md §3): a club of `TBT_BENCH_USERS` members (200)
 * all online, 30 tables (25 of four members, 5 of one and three TKB), the rest in the lobby. Measures
 * one broadcast (a member starts watching: the action and the lobby it sends), the bytes it sends,
 * and how long a crowd waits when 45 start watching at once and when everyone at a table leaves at
 * once (from the burst to the message that tells each one it worked). Wall clock, tables in the
 * club's own object, storage in memory.
 *
 * Skipped unless `TBT_BENCH=1`. `TBT_BENCH_OLD=<folder>` also runs another copy of the code (its
 * `worker/service.ts` and `tests/worker/sqlite.ts`, e.g. `git archive origin/main worker shared
 * tests/worker | tar -x -C bench-old`), the two taking turns in the same process, `TBT_BENCH_ROUNDS` times
 */

const RUN = process.env.TBT_BENCH === '1'
/** At least 160: 105 at the tables, 45 to start watching, and a few in the lobby */
const USERS = Math.max(160, Number(process.env.TBT_BENCH_USERS ?? 200))
const ROUNDS = Number(process.env.TBT_BENCH_ROUNDS ?? 2)

type Message = { type: string; lobby?: { myTableId?: string | null }; mine?: { myTableId?: string | null } }
interface Club {
  load(): Promise<void>
  register(name: string, password: string, code: string): Promise<{ user?: { id: string } }>
  adminCreateUser(name: string, password: string): Promise<{ id: string }>
  connected(userId: string): void
  handle(userId: string, message: unknown): Promise<void>
}
type ClubClass = new (store: unknown, connections: unknown, config: Record<string, unknown>) => Club

/** Where a member is, as their latest lobby says (either protocol) */
const tableIn = (m: Message) =>
  m.type === 'lobby' ? (m.lobby?.myTableId ?? null) : m.type === 'lobbyMine' ? (m.mine?.myTableId ?? null) : undefined

async function bench(code: { ClubService: ClubClass; memoryStore: () => unknown }) {
  const online = new Set<string>()
  const waiting = new Map<string, { want: string | null; done: (at: number) => void }>()
  let bytes = 0
  const connections = {
    onlineUserIds: () => [...online],
    send(userId: string, message: Message, data?: string) {
      bytes += (data ?? JSON.stringify(message)).length
      const at = tableIn(message)
      const wait = waiting.get(userId)
      if (wait && at !== undefined && at === wait.want) {
        waiting.delete(userId)
        wait.done(performance.now())
      }
    },
    disconnect: () => undefined,
  }
  const club = new code.ClubService(code.memoryStore(), connections, {
    maxUsers: USERS + 10,
    schedule: () => undefined,
    // As the Durable Object (H3b); a copy without it ignores it
    later: (run: () => void, ms: number) => void setTimeout(run, ms),
  })
  await club.load()
  const founder = await club.register('admin', 'secret1', '')
  const ids = [founder.user!.id]
  for (let i = 1; i < USERS; i++) ids.push((await club.adminCreateUser(`load${String(i).padStart(3, '0')}`, 'secret1')).id)
  for (const id of ids) {
    online.add(id)
    club.connected(id)
  }
  const quiet = () => new Promise((resolve) => setTimeout(resolve, 250))
  const myTable = new Map<string, string>()
  /**
   * A crowd acting at once: their messages are queued, so the club takes them one after another
   * (each to its end, as the Durable Object does when nothing waits on I/O); each member's time is
   * from the start to the lobby message that tells them it worked
   */
  async function crowd(actions: [string, unknown, string | null][]) {
    const started = performance.now()
    const done = actions.map(
      ([userId, , want]) =>
        new Promise<number>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`${userId} never got to ${want}`)), 60_000)
          waiting.set(userId, {
            want,
            done: (at) => {
              clearTimeout(timer)
              resolve(at - started)
            },
          })
        }),
    )
    for (const [userId, message] of actions) await club.handle(userId, message)
    return Promise.all(done)
  }
  let cursor = 0
  const tables: string[] = []
  for (let t = 0; t < 30; t++) {
    const players = ids.slice(cursor, (cursor += t < 25 ? 4 : 1))
    const host = players[0]
    const created = new Promise<string>((resolve) => {
      const send = connections.send
      connections.send = (userId, message, data) => {
        const at = tableIn(message)
        if (userId === host && at) {
          connections.send = send
          resolve(at)
        }
        send(userId, message, data)
      }
    })
    void club.handle(host, { type: 'createTable' })
    const tableId = await Promise.race([created, new Promise<string>((_, reject) => setTimeout(() => reject(new Error(`table ${t} not opened`)), 60_000))])
    tables.push(tableId)
    for (const id of players) myTable.set(id, tableId)
    if (t < 25) for (const [i, id] of players.slice(1).entries()) await club.handle(id, { type: 'sit', tableId, seat: (['N', 'E', 'W'] as const)[i] })
    else for (const seat of ['N', 'E', 'W']) await club.handle(host, { type: 'addRobot', seat })
    await quiet()
  }
  const lobby = ids.slice(cursor)

  // One broadcast: a lobby member starts watching, then stops (each one action, one lobby)
  const single: number[] = []
  const singleBytes: number[] = []
  for (let i = 0; i < 20; i++) {
    const id = lobby[lobby.length - 1 - (i % 5)]
    const leaving = myTable.has(id)
    const tableId = tables[i % tables.length]
    await quiet()
    bytes = 0
    const started = performance.now()
    await club.handle(id, leaving ? { type: 'leaveTable' } : { type: 'joinTable', tableId })
    single.push(performance.now() - started)
    singleBytes.push(bytes)
    if (leaving) myTable.delete(id)
    else myTable.set(id, tableId)
    await quiet()
  }

  // 45 start watching at once
  await quiet()
  const watchers = lobby.slice(0, 45)
  const watch = await crowd(watchers.map((id, i) => [id, { type: 'joinTable', tableId: tables[i % tables.length] }, tables[i % tables.length]]))
  for (const [i, id] of watchers.entries()) myTable.set(id, tables[i % tables.length])

  // Everyone at a table leaves at once
  await quiet()
  const leavers = [...myTable.keys()]
  const leave = await crowd(leavers.map((id) => [id, { type: 'leaveTable' }, null]))
  await quiet()
  return { single: summarize(single), bytes: summarize(singleBytes), watch: summarize(watch), leave: summarize(leave), leavers: leavers.length }
}

describe.skipIf(!RUN)('the lobby broadcast on its own (H3b)', () => {
  it('measures one broadcast and a crowd’s wait', { timeout: 3_600_000 }, async () => {
    const copies: [string, Parameters<typeof bench>[0]][] = [
      ['this', { ClubService: (await import('../../worker/service.ts')).ClubService as never, memoryStore: (await import('./sqlite.ts')).memoryStore }],
    ]
    const old = process.env.TBT_BENCH_OLD
    if (old) {
      const base = old.replace(/\\/g, '/').replace(/\/$/, '')
      copies.push([
        old,
        {
          ClubService: (await import(/* @vite-ignore */ `${base}/worker/service.ts`)).ClubService,
          memoryStore: (await import(/* @vite-ignore */ `${base}/tests/worker/sqlite.ts`)).memoryStore,
        },
      ])
    }
    const f = (s: ReturnType<typeof summarize>) => `p50 ${s.p50.toFixed(0)} p95 ${s.p95.toFixed(0)} max ${s.max.toFixed(0)}`
    for (let round = 0; round < ROUNDS; round++)
      for (const [name, code] of round % 2 ? [...copies].reverse() : copies) {
        const r = await bench(code)
        console.log(
          [
            `${name} (round ${round + 1}, ${USERS} online, 30 tables)`,
            `  one broadcast (ms)        ${f(r.single)}`,
            `  bytes sent by it          ${f(r.bytes)}`,
            `  45 watching at once (ms)  ${f(r.watch)}`,
            `  ${r.leavers} leaving at once (ms) ${f(r.leave)}`,
          ].join('\n'),
        )
        expect(r.watch.count).toBe(45)
      }
  })
})
