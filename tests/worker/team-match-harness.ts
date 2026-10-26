import type { ClientMessage, ServerMessage, TableView } from '../../shared/protocol.ts'
import { MATCH_SEATS, type MatchSeat, type Room } from '../../shared/team-match.ts'
import { ClubService, type Connections, type ScheduleKind } from '../../worker/service.ts'
import type { MemoryStore } from '../../worker/store.ts'
import { memoryD1 } from './d1.ts'
import { memoryStore } from './sqlite.ts'
import { clubService } from './event-mode.ts'

/**
 * A club in Node for the team match tests (F5) and the visibility suite (`e11-t13`): the tables
 * run in the club's object (`LocalTables`), jobs wait in a manual queue, and every message each
 * member's browser was sent is kept, so a test can check everything a browser ever saw
 */

export class FakeConnections implements Connections {
  online = new Set<string>()
  inbox = new Map<string, ServerMessage[]>()
  onlineUserIds() {
    return [...this.online]
  }
  send(userId: string, message: ServerMessage) {
    this.inbox.set(userId, [...(this.inbox.get(userId) ?? []), message])
  }
  disconnect(userId: string) {
    this.online.delete(userId)
  }
  last<T extends ServerMessage['type']>(userId: string, type: T) {
    return (this.inbox.get(userId) ?? []).findLast((m) => m.type === type) as Extract<ServerMessage, { type: T }> | undefined
  }
  /** The table as the member's browser holds it */
  table(userId: string): TableView | null {
    let view = null as TableView | null
    for (const m of this.inbox.get(userId) ?? []) {
      if (m.type !== 'table') continue
      const wire = m.table
      if (!wire) {
        view = null
        continue
      }
      const keep = view?.id === wire.id ? view : null
      view = { ...wire, chat: wire.chat ?? keep?.chat ?? [], recent: wire.recent ?? keep?.recent ?? [] }
    }
    return view
  }
}

export const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
export const at = (room: Room, seat: MatchSeat['seat']): MatchSeat => ({ room, seat })

export interface Job {
  run: () => void
  ms: number
  kind: ScheduleKind
}

export async function teamHarness() {
  const store: MemoryStore = memoryStore()
  const connections = new FakeConnections()
  const h = {
    store,
    connections,
    queue: [] as Job[],
    time: 1_000_000,
    club: null as unknown as ClubService,
    boss: '',
  }
  // The history pages' D1 copy (§5.12), so the visibility suite checks what the Worker answers too
  const d1 = memoryD1()
  h.club = clubService(store, connections, {
    maxUsers: 40,
    now: () => h.time,
    schedule: (run, ms, kind) => h.queue.push({ run, ms, kind }),
    historyReplica: d1,
  })
  await h.club.load()
  const founder = await h.club.register('boss', 'secret1', '')
  h.boss = 'user' in founder ? founder.user.id : ''

  const club = () => h.club
  const send = (userId: string, message: ClientMessage) => club().handle(userId, message)

  async function member(name: string) {
    const result = await club().register(name, 'secret1', '')
    const user = 'user' in result ? result.user : await club().adminApprove(club().adminApplications().find((a) => a.username === name)!.id)
    connections.online.add(user.id)
    club().connected(user.id)
    await tick()
    return user.id
  }

  /** The error code a member got for a message, if any */
  async function refused(userId: string, message: ClientMessage) {
    const before = (connections.inbox.get(userId) ?? []).length
    await send(userId, message)
    const fresh = (connections.inbox.get(userId) ?? []).slice(before)
    return (fresh.findLast((m) => m.type === 'error') as Extract<ServerMessage, { type: 'error' }> | undefined)?.code
  }

  /**
   * Amy hosts (team A, open room South) a match of `boards` boards; each member given takes the
   * seat given, the other seats get robots
   */
  async function match({ boards = 4, seats = {} as Record<string, MatchSeat>, scoring = 'imp' as 'imp' | 'bam', boardMinutes = 10 } = {}) {
    const amy = await member('amy')
    const { id } = club().matches.create(amy, { settings: { boards, scoring, boardMinutes } })
    const people: Record<string, string> = { amy }
    for (const [name, seat] of Object.entries(seats)) {
      const userId = await member(name)
      people[name] = userId
      await club().matches.act(amy, { type: 'matchInvite', matchId: id, ...seat, userId })
      await club().matches.act(userId, { type: 'matchAnswer', matchId: id, accept: true })
    }
    const taken = [at('open', 'S'), ...Object.values(seats)]
    for (const s of MATCH_SEATS)
      if (!taken.some((t) => t.room === s.room && t.seat === s.seat)) await club().matches.act(amy, { type: 'matchRobot', matchId: id, ...s })
    return { id, amy, people }
  }

  const tableIdOf = (id: string, room: Room) => club().matches.store.get(id)!.tables![room]
  const tableState = (tableId: string) => club().localTable(tableId)?.state ?? null
  const played = (tableId: string) => tableState(tableId)?.boardsPlayed ?? 0
  const view = (userId: string) => connections.table(userId)

  /** Runs the queued jobs of one kind (each once) */
  async function run(kind: ScheduleKind) {
    const jobs = h.queue.filter((job) => job.kind === kind)
    h.queue = h.queue.filter((job) => job.kind !== kind)
    for (const job of jobs) job.run()
    await tick()
  }

  /**
   * Plays on until `done`: the members given pass when it is their call and play their first legal
   * card (dummy's too when declaring), robots move, and the next board is dealt when its time comes
   */
  async function playUntil(people: string[], done: () => boolean, limit = 8000) {
    for (let i = 0; i < limit; i++) {
      if (done()) return
      let acted = false
      for (const userId of people) {
        const board = view(userId)?.board
        if (!board || board.phase === 'finished' || view(userId)?.match?.paused) continue
        if (board.legalCalls.length) await send(userId, { type: 'call', call: 'P' })
        else if (board.legalCards.length) await send(userId, { type: 'play', card: board.legalCards[0] })
        else continue
        acted = true
      }
      if (acted) continue
      const index = h.queue.findIndex((job) => job.kind === 'robot')
      if (index >= 0) {
        h.queue.splice(index, 1)[0].run()
        await tick()
        continue
      }
      const deals = h.queue.filter((job) => job.kind === 'deal')
      if (!deals.length) throw new Error('nothing left to run')
      h.queue = h.queue.filter((job) => job.kind !== 'deal')
      h.time += Math.max(0, ...deals.map((job) => job.ms))
      for (const job of deals) job.run()
      await tick()
    }
    throw new Error('did not get there')
  }

  /** Copies what the club queued to the D1 copy (each job of kind `replica` until none is left) */
  async function copyToD1() {
    for (let i = 0; i < 50 && h.queue.some((job) => job.kind === 'replica'); i++) {
      await run('replica')
      // A write is a few awaits deep
      for (let j = 0; j < 5; j++) await tick()
    }
  }

  return { h, d1, club, send, member, refused, match, tableIdOf, tableState, played, view, run, playUntil, copyToD1 }
}
