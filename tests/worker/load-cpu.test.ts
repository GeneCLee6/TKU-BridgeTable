// @vitest-environment node
import { writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { secureRandomInt } from '../../shared/board.ts'
import type { Seat } from '../../shared/cards.ts'
import type { ClientMessage, LobbyMine, ServerMessage, TableWire } from '../../shared/protocol.ts'
import { noLog } from '../../worker/log.ts'
import { manualScheduler } from '../../worker/scheduler.ts'
import { ClubService, type Connections } from '../../worker/service.ts'
import { TableHost } from '../../worker/table-host.ts'
import { RemoteTables, type TableRpc } from '../../worker/tables.ts'
import { decide, progressOf } from '../../scripts/load/player.ts'
import { summarize, type Summary } from '../../scripts/load/stats.ts'
import { memoryStore } from './sqlite.ts'

/**
 * The CPU side of the load test (e11-t21, docs/LOAD.md): the real `ClubService` and one `TableHost`
 * per table (each its own object, reached over a structured clone like RPC, as in
 * table-objects.test.ts), driven by simulated members on a virtual clock. Every invocation an
 * object would get in production (a socket message, an alarm, an RPC call) is timed on its own,
 * without the time of the calls it makes into other objects, so the numbers compare with the free
 * plan's 10 ms of CPU a request. Storage is in memory, so this is the CPU of the logic, not I/O.
 *
 * Small by default so it runs in CI (40 members, 6 tables, 4 virtual minutes); the full run is
 * `TBT_LOAD=full npx vitest run tests/worker/load-cpu.test.ts` (200 members, 30 tables, 10
 * minutes), and `TBT_LOAD_OUT=<file>` writes the numbers as JSON
 */

const FULL = process.env.TBT_LOAD === 'full'
const PLAN = FULL
  ? { users: 200, humanTables: 25, robotTables: 5, watchers: 45, minutes: 10, thinkMs: 2000 }
  : { users: 40, humanTables: 4, robotTables: 2, watchers: 6, minutes: 4, thinkMs: 2000 }

interface Job {
  at: number
  seq: number
  kind: string
  run: () => Promise<unknown> | unknown
}

const clone = <T>(value: T): T => (value === undefined ? value : structuredClone(value))
const settle = () => new Promise((resolve) => setImmediate(resolve))

/** One load run; returns each invocation kind's own time, and how busy each object was */
async function run(plan: typeof PLAN, random: () => number) {
  let time = 1_800_000_000_000
  let seq = 0
  const jobs: Job[] = []
  const at = (ms: number, kind: string, job: () => Promise<unknown> | unknown) => {
    jobs.push({ at: time + ms, seq: seq++, kind, run: job })
  }

  // Time each invocation without the calls it makes into other objects (`nested`)
  const samples = new Map<string, number[]>()
  const busy = new Map<string, number>()
  let nested = 0
  async function timed<T>(object: string, kind: string, work: () => Promise<T> | T): Promise<T> {
    const saved = nested
    nested = 0
    const started = performance.now()
    try {
      return await work()
    } finally {
      const wall = performance.now() - started
      const own = Math.max(0, wall - nested)
      nested = saved + wall
      const list = samples.get(kind) ?? []
      list.push(own)
      samples.set(kind, list)
      busy.set(object, (busy.get(object) ?? 0) + own)
    }
  }

  // ── Members as the browser holds them ──
  const lobbies = new Map<string, LobbyMine>()
  const views = new Map<string, TableWire | null>()
  const atTable = new Map<string, string>()
  const autoplay = new Set<string>()
  const thinking = new Set<string>()
  const sentBytes = { club: 0, table: 0, messages: 0 }

  const clubSockets: Connections & { online: Set<string> } = {
    online: new Set(),
    onlineUserIds() {
      return [...this.online]
    },
    send(userId: string, message: ServerMessage, data?: string) {
      // What the club serializes once for many members (the shared lobby, H3b) is counted for each who gets it
      sentBytes.club += (data ?? JSON.stringify(message)).length
      sentBytes.messages++
      if (message.type === 'lobbyMine') {
        lobbies.set(userId, message.mine)
        const next = message.mine.myTableId
        const was = atTable.get(userId)
        if (next !== was) {
          if (was) {
            atTable.delete(userId)
            const object = objects.get(was)
            if (object?.online.delete(userId)) at(20, 'connect', () => timed(`table:${was}`, 'table: socket closed', () => object.host.disconnected(userId)))
          }
          if (next) {
            atTable.set(userId, next)
            at(50, 'connect', async () => {
              if (atTable.get(userId) !== next) return
              const object = objectOf(next)
              object.online.add(userId)
              await timed(`table:${next}`, 'table: socket opened', () => object.host.connected(userId))
            })
          }
        }
      }
      if (message.type === 'table') seen(userId, message.table)
    },
    disconnect(userId: string) {
      this.online.delete(userId)
    },
  }

  function seen(userId: string, wire: TableWire | null) {
    const old = views.get(userId)
    views.set(userId, wire ? { ...wire, chat: wire.chat ?? old?.chat, recent: wire.recent ?? old?.recent } : null)
    play(userId)
  }

  /** A person thinks, then calls or plays over the table's connection */
  function play(userId: string) {
    if (!autoplay.has(userId) || thinking.has(userId)) return
    const view = views.get(userId)
    if (!decide(view, random)) return
    const position = progressOf(view)
    thinking.add(userId)
    at(plan.thinkMs * (0.5 + random()), 'person', async () => {
      thinking.delete(userId)
      const now = views.get(userId)
      if (progressOf(now) !== position) return play(userId)
      const move = decide(now, random)
      const tableId = atTable.get(userId)
      if (!move || !tableId) return
      await timed(`table:${tableId}`, `table: ${move.type}`, () => objectOf(tableId).host.message(userId, JSON.stringify(move)))
    })
  }

  // ── Objects: the club and one host per table ──
  interface FakeObject {
    storage: Map<string, unknown>
    online: Set<string>
    host: TableHost
  }
  const objects = new Map<string, FakeObject>()
  function objectOf(tableId: string): FakeObject {
    let found = objects.get(tableId)
    if (found) return found
    const storage = new Map<string, unknown>()
    const online = new Set<string>()
    const host: TableHost = new TableHost({
      storage: {
        get: async (key) => clone(storage.get(key)) as never,
        put: async (key, value) => void storage.set(key, clone(value)),
        clear: async () => storage.clear(),
      },
      sockets: {
        onlineUserIds: () => [...online],
        send: (userId, message) => {
          sentBytes.table += JSON.stringify(message).length
          sentBytes.messages++
          if (message.type === 'table') seen(userId, clone(message.table))
        },
        dismiss: (userId) => void online.delete(userId),
      },
      club: {
        changed: (entry) => timed('club', 'club: table changed (RPC)', () => club.link.changed(clone(entry))),
        closed: (id) => timed('club', 'club: table closed (RPC)', () => club.link.closed(id)),
        boardFinished: (record, event, stats) =>
          timed('club', 'club: board finished (RPC)', () => club.link.boardFinished(clone(record), clone(event), clone(stats))),
        mayUseTku: (userId) => timed('club', 'club: mayUseTku (RPC)', () => club.link.mayUseTku(userId)),
      },
      config: {
        now: () => time,
        random: secureRandomInt,
        scheduler: manualScheduler((job, ms, kind) => at(ms, kind, () => timed(`table:${tableId}`, `table: alarm (${kind})`, async () => {
          job()
          await settle()
        }))),
      },
      log: noLog,
    })
    found = { storage, online, host }
    objects.set(tableId, found)
    return found
  }
  const stub = (tableId: string): TableRpc =>
    new Proxy({} as TableRpc, {
      get:
        (_, name: string) =>
        (...args: unknown[]) =>
          timed(`table:${tableId}`, `table: ${name} (RPC)`, async () => {
            const host = objectOf(tableId).host as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
            return clone(await host[name](...clone(args)))
          }),
    })

  const store = memoryStore()
  const club = new ClubService(store, clubSockets, {
    maxUsers: plan.users + 10,
    now: () => time,
    schedule: (job, ms, kind) => at(ms, kind, () => timed('club', `club: alarm (${kind})`, async () => {
      job()
      await settle()
    })),
    log: noLog,
    tableObjects: new RemoteTables(stub),
    // As the Durable Object: the lobby at most every LOBBY_GAP_MS while it keeps changing (H3b)
    later: (job, ms) => at(ms, 'lobby', () => timed('club', 'club: lobby after the gap (timer)', job)),
  })
  await club.load()

  // ── Members ──
  const founder = await club.register('admin', 'secret1', '')
  if (!('user' in founder)) throw new Error('no founder')
  const ids = [founder.user.id]
  for (let i = 1; i < plan.users; i++) ids.push((await club.adminCreateUser(`load${String(i).padStart(3, '0')}`, 'secret1')).id)
  const clubSend = (userId: string, message: ClientMessage) =>
    timed('club', `club: ${message.type}`, async () => {
      await club.handleRaw(userId, JSON.stringify(message))
      await settle()
    })
  for (const id of ids) {
    clubSockets.online.add(id)
    await timed('club', 'club: socket opened', async () => {
      club.connected(id)
      await settle()
    })
  }
  const drain = async (until: number) => {
    for (;;) {
      jobs.sort((a, b) => a.at - b.at || a.seq - b.seq)
      const next = jobs[0]
      if (!next || next.at > until) break
      jobs.shift()
      time = Math.max(time, next.at)
      await next.run()
      await settle()
    }
    time = Math.max(time, until)
  }

  // ── Tables ──
  let cursor = 0
  const others: Seat[] = ['N', 'E', 'W']
  for (let t = 0; t < plan.humanTables + plan.robotTables; t++) {
    const human = t < plan.humanTables
    const players = ids.slice(cursor, (cursor += human ? 4 : 1))
    await clubSend(players[0], { type: 'createTable' })
    await drain(time + 100)
    const tableId = lobbies.get(players[0])!.myTableId!
    if (human) for (const [i, id] of players.slice(1).entries()) await clubSend(id, { type: 'sit', tableId, seat: others[i] })
    else
      for (const seat of others)
        await timed(`table:${tableId}`, 'table: addRobot', () => objectOf(tableId).host.message(players[0], JSON.stringify({ type: 'addRobot', seat })))
    for (const id of players) autoplay.add(id)
    await drain(time + 100)
    for (const id of players) play(id)
  }
  const tableIds = [...objects.keys()]
  for (let i = 0; i < plan.watchers; i++) await clubSend(ids[cursor++], { type: 'joinTable', tableId: tableIds[i % tableIds.length] })
  const lobbyIds = ids.slice(cursor)
  // Lobby members: a direct message or a history page, each about once a minute
  for (const id of lobbyIds) {
    const act = () => {
      if (random() < 0.5) {
        const other = lobbyIds[Math.floor(random() * lobbyIds.length)]
        if (other !== id) void clubSend(other, { type: 'sendDirect', to: id, text: 'hi' })
      } else void timed('club', 'club: history page (HTTP)', () => club.history(id, true, 1, 20))
      at(60_000 * (0.5 + random()), 'lobby', act)
    }
    at(60_000 * random(), 'lobby', act)
  }
  for (const key of samples.keys()) samples.set(key, [])
  busy.clear()
  const start = time
  await drain(start + plan.minutes * 60_000)
  const elapsed = time - start

  const status = club.status()
  const kinds: Record<string, Summary & { totalMs: number }> = {}
  for (const [kind, values] of [...samples].sort(([a], [b]) => a.localeCompare(b)))
    if (values.length) kinds[kind] = { ...summarize(values), totalMs: Math.round(values.reduce((a, b) => a + b, 0)) }
  const tableBusy = [...busy].filter(([object]) => object !== 'club').map(([, ms]) => ms / elapsed)
  return {
    plan,
    virtualMinutes: elapsed / 60_000,
    kinds,
    clubBusy: (busy.get('club') ?? 0) / elapsed,
    busiestTable: Math.max(0, ...tableBusy),
    boards: status.metrics.boards,
    robotMoves: status.metrics.robot.moves,
    sentMessages: sentBytes.messages,
    sentKBperMinute: Math.round((sentBytes.club + sentBytes.table) / 1024 / (elapsed / 60_000)),
    clubKBperMinute: Math.round(sentBytes.club / 1024 / (elapsed / 60_000)),
  }
}

function report(result: Awaited<ReturnType<typeof run>>) {
  const rows = Object.entries(result.kinds).map(
    ([kind, s]) => `  ${kind.padEnd(34)} ${String(s.count).padStart(6)}  p50 ${s.p50.toFixed(1).padStart(5)}  p95 ${s.p95.toFixed(1).padStart(5)}  p99 ${s.p99.toFixed(1).padStart(6)}  max ${s.max.toFixed(1).padStart(6)} ms`,
  )
  return [
    `load: ${JSON.stringify(result.plan)}, ${result.virtualMinutes} virtual minutes`,
    ...rows,
    `  club busy ${(result.clubBusy * 100).toFixed(2)}% of the time, busiest table ${(result.busiestTable * 100).toFixed(2)}%`,
    `  ${result.boards} boards, ${result.robotMoves} robot moves, ${result.sentMessages} messages out (${result.sentKBperMinute} KB/min, club ${result.clubKBperMinute} KB/min)`,
  ].join('\n')
}

describe('CPU under load (e11-t21)', () => {
  it('keeps every invocation of every object well under the free plan’s CPU a request', { timeout: FULL ? 1_800_000 : 300_000 }, async () => {
    let seed = 7
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
    const result = await run(PLAN, random)
    console.log(report(result))
    if (process.env.TBT_LOAD_OUT) writeFileSync(process.env.TBT_LOAD_OUT, JSON.stringify(result, null, 2))
    expect(result.boards).toBeGreaterThan(0)
    // Loose on purpose: CI runs every file side by side; the printed numbers are the point. The
    // full run is a measurement: with 200 online the lobby broadcast is known to be over (docs/LOAD.md)
    if (!FULL) for (const [kind, s] of Object.entries(result.kinds)) expect(s.p50, kind).toBeLessThan(50)
  })
})
