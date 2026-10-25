// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import type { BoardRecord, ServerMessage } from '../../shared/protocol.ts'
import { robotId } from '../../shared/protocol.ts'
import { ClubError } from '../../worker/errors.ts'
import type { EventReport } from '../../worker/modes.ts'
import { manualScheduler, type JobKind } from '../../worker/scheduler.ts'
import { MemoryStore } from '../../worker/store.ts'
import { TableService } from '../../worker/table-service.ts'
import type { TableEntry } from '../../worker/tables.ts'
import type { Table } from '../../worker/views.ts'

/** One table on its own (ARCHITECTURE.md §5.10): what it tells the club, and only that */

let store: MemoryStore
let queue: { run: () => void; ms: number; kind: JobKind }[]
let time: number
let reports: TableEntry[]
let closed: string[]
let finished: { record: BoardRecord; event: EventReport | null }[]
let refuse: boolean
let sent: ServerMessage[]
let table: TableService

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function newTable(): Table {
  return {
    id: 'tbl1',
    number: 1,
    hostId: 'amy',
    seats: { N: robotId('tku', 'N'), E: robotId('tku', 'E'), S: 'amy', W: robotId('tku', 'W') },
    spectators: [],
    boardsPlayed: 0,
    board: null,
    chat: [],
    createdAt: time,
    mode: 'casual',
    names: { amy: 'amy' },
    blocks: { amy: [] },
  }
}

async function runRobots() {
  for (let i = 0; i < 400; i++) {
    const index = queue.findIndex((job) => job.kind === 'robot')
    if (index < 0) return
    queue.splice(index, 1)[0].run()
    await tick()
  }
}

/** Amy passes or plays her first legal card until the board is over */
async function playOut() {
  for (let i = 0; i < 400; i++) {
    await runRobots()
    const view = table.view('amy')!.board!
    if (view.phase === 'finished') return
    if (view.legalCalls.length) await table.act('amy', { type: 'call', call: 'P' })
    else await table.act('amy', { type: 'play', card: view.legalCards[0] })
  }
}

beforeEach(async () => {
  store = new MemoryStore()
  queue = []
  time = 1_000_000
  reports = []
  closed = []
  finished = []
  refuse = false
  sent = []
  table = new TableService(
    'tbl1',
    { save: (t) => store.put(`table:${t.id}`, t), remove: (id) => store.delete(`table:${id}`) },
    { onlineUserIds: () => ['amy'], send: (_userId, message) => void sent.push(message) },
    {
      changed: (entry) => void reports.push(entry),
      closed: (id) => void closed.push(id),
      boardFinished: async (record, event) => {
        if (refuse) throw new Error('club busy')
        finished.push({ record, event })
      },
    },
    { now: () => time, random: (n) => Math.floor(n / 2), scheduler: manualScheduler((run, ms, kind) => queue.push({ run, ms, kind })) },
  )
  await table.open(newTable())
})

describe('a table on its own', () => {
  it('deals as it opens and tells the club what the lobby shows', async () => {
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ id: 'tbl1', boardNo: 1, playing: true, seats: { S: 'amy' } })
    expect(sent.at(-1)).toMatchObject({ type: 'table', table: { id: 'tbl1', mySeat: 'S' } })
  })

  it('does not wake the club for calls and cards, only when a board ends', async () => {
    await playOut()
    // Dealt, then finished: nothing in between reached the club
    expect(reports.map((r) => r.playing)).toEqual([true, false])
    expect(reports[1].rev).toBeGreaterThan(reports[0].rev)
    expect(finished).toHaveLength(1)
    expect(finished[0].record.players.S).toEqual({ id: 'amy', username: 'amy' })
    expect(finished[0].event).toBeNull()
  })

  it('keeps a finished board until the club takes it', async () => {
    refuse = true
    await playOut()
    expect(finished).toHaveLength(0)
    expect((await store.get<Table>('table:tbl1'))!.outbox).toHaveLength(1)
    refuse = false
    const retry = queue.find((job) => job.kind === 'outbox')!
    retry.run()
    await tick()
    expect(finished).toHaveLength(1)
    expect((await store.get<Table>('table:tbl1'))!.outbox).toBeUndefined()
  })

  it('closes when its last person leaves, and then knows nobody', async () => {
    expect(await table.leave('amy')).toBeNull()
    expect(closed).toEqual(['tbl1'])
    expect(await store.get('table:tbl1')).toBeUndefined()
    await expect(table.join({ id: 'ben', username: 'ben', blocked: [] })).rejects.toThrow(ClubError)
  })

  it('shows each person the chat without the members they blocked', async () => {
    await table.join({ id: 'ben', username: 'ben', blocked: ['amy'] })
    await table.act('amy', { type: 'chat', text: 'hello' })
    expect(table.view('ben')!.chat).toEqual([])
    expect(table.view('amy')!.chat.map((m) => m.text)).toEqual(['hello'])
    await table.blocked('ben', [])
    expect(table.view('ben')!.chat.map((m) => m.username)).toEqual(['amy'])
  })
})
