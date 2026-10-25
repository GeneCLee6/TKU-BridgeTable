// @vitest-environment node
import { expect, it } from 'vitest'
import type { ClientMessage, ServerMessage, TableView } from '../../shared/protocol.ts'
import { ClubService, type Connections, type ScheduleKind } from '../../worker/service.ts'
import { memoryStore } from './sqlite.ts'

/**
 * End to end (C9, e7-t25, AC-7.4, AC-7.5): three people take a 4-board matchpoint challenge
 * through the real tables and robots; one stops after two boards and is not ranked at the
 * deadline. The standings must match matchpoints worked out by hand from the scores they made.
 */

class FakeConnections implements Connections {
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
  bell(userId: string) {
    const last = (this.inbox.get(userId) ?? []).findLast((m) => m.type === 'notifications')
    return last?.type === 'notifications' ? last.notifications.items.map((n) => n.kind) : []
  }
}

const tick = async (times = 1) => {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

it('three people, four boards, matchpoints: one stops halfway and only the finishers are ranked', async () => {
  const store = memoryStore()
  const connections = new FakeConnections()
  let queue: { run: () => void; ms: number; kind: ScheduleKind }[] = []
  let time = 1_000_000
  const club = new ClubService(store, connections, {
    maxUsers: 40,
    now: () => time,
    schedule: (run, ms, kind) => queue.push({ run, ms, kind }),
  })
  await club.load()
  await club.register('boss', 'secret1', '')

  const member = async (name: string) => {
    await club.register(name, 'secret1', '')
    const user = await club.adminApprove(club.adminApplications().find((a) => a.username === name)!.id)
    connections.online.add(user.id)
    club.connected(user.id)
    await tick()
    return user.id
  }
  const send = (userId: string, message: ClientMessage) => club.handle(userId, message)
  const runRobots = async () => {
    for (let i = 0; i < 400; i++) {
      const index = queue.findIndex((job) => job.kind === 'robot')
      if (index < 0) return
      queue.splice(index, 1)[0].run()
      await tick()
    }
  }
  const dealNext = async () => {
    const deals = queue.filter((job) => job.kind === 'deal')
    queue = queue.filter((job) => job.kind !== 'deal')
    time += Math.max(0, ...deals.map((job) => job.ms))
    for (const job of deals) job.run()
    await tick()
  }
  /** Plays one board: always passes, and leads the first or the last legal card, so people score differently */
  const playBoard = async (userId: string, pick: 'first' | 'last') => {
    for (let i = 0; i < 400; i++) {
      await runRobots()
      const board = connections.table(userId)?.board
      if (!board) throw new Error('no board')
      if (board.phase === 'finished') return
      if (board.legalCalls.length) await send(userId, { type: 'call', call: 'P' })
      else if (board.legalCards.length)
        await send(userId, { type: 'play', card: pick === 'first' ? board.legalCards[0] : board.legalCards.at(-1)! })
      else throw new Error(`stuck: ${board.phase}, turn ${board.turn}`)
    }
  }
  /** Sits down at (or goes back to) the challenge table and plays until `upTo` boards are done */
  const play = async (userId: string, challengeId: string, upTo: number, pick: 'first' | 'last') => {
    await send(userId, { type: 'playChallenge', challengeId })
    for (let i = 0; i < 20; i++) {
      const view = connections.table(userId)!
      if (view.board?.phase === 'finished') {
        if (view.challenge!.played >= upTo) return
        await dealNext()
      } else await playBoard(userId, pick)
    }
    throw new Error('too many boards')
  }

  const amy = await member('amy')
  const ben = await member('ben')
  const cat = await member('cat')
  for (const other of [ben, cat]) await send(amy, { type: 'setFriend', userId: other, friend: true })
  await send(amy, { type: 'createChallenge', invitees: [ben, cat], boards: 4, settings: { scoring: 'mp' } })
  const id = club.challengeList(amy)[0].id
  await send(ben, { type: 'answerChallenge', challengeId: id, accept: true })
  await send(cat, { type: 'answerChallenge', challengeId: id, accept: true })

  // amy and ben play every board in more than one sitting; cat stops after two
  await play(amy, id, 2, 'first')
  await send(amy, { type: 'leaveTable' })
  await play(amy, id, 4, 'first')
  await play(ben, id, 4, 'last')
  await play(cat, id, 2, 'first')
  for (const userId of [amy, ben, cat]) await send(userId, { type: 'leaveTable' })
  // Leaving after the last board closes the table; cat's stays, parked
  const tables = () => [...store.data.keys()].filter((k) => k.startsWith('table:'))
  expect(tables()).toHaveLength(1)

  // Before the deadline: ben finished and sees the live standings; cat, still playing, sees none
  expect(club.challengeFor(id, ben)?.standings?.final).toBe(false)
  expect(club.challengeFor(id, cat)?.standings).toBeUndefined()

  time = club.challenges.get(id)!.deadline
  const jobs = queue.filter((job) => job.kind === 'challenge')
  queue = queue.filter((job) => job.kind !== 'challenge')
  for (const job of jobs) job.run()
  await tick(10)

  const settled = club.challenges.get(id)!
  expect(settled.status).toBe('finished')
  const score = (userId: string) =>
    [1, 2, 3, 4].map((seq) => settled.results.find((r) => r.userId === userId && r.seq === seq)?.scoreNS)
  const amyScores = score(amy) as number[]
  const benScores = score(ben) as number[]
  expect(amyScores.every((s) => typeof s === 'number')).toBe(true)
  expect(benScores.every((s) => typeof s === 'number')).toBe(true)
  expect(score(cat).filter((s) => s !== undefined)).toHaveLength(2)

  // By hand: each board, 100% for beating the other finisher, 50% for a tie; cat's boards do not count
  const mp = (mine: number[], theirs: number[]) => mine.map((m, i): number => (m > theirs[i] ? 100 : m === theirs[i] ? 50 : 0))
  const amyBoards = mp(amyScores, benScores)
  const benBoards = mp(benScores, amyScores)
  const amyTotal = amyBoards.reduce((a, b) => a + b, 0) / 4
  const benTotal = benBoards.reduce((a, b) => a + b, 0) / 4
  const amyRank = amyTotal < benTotal ? 2 : 1
  const benRank = benTotal < amyTotal ? 2 : 1

  for (const viewer of [amy, ben, cat]) {
    const standings = club.challengeFor(id, viewer)!.standings!
    expect(standings.final).toBe(true)
    expect(standings.scoring).toBe('mp')
    expect(standings.ranked.map((r) => [r.userId, r.rank, r.total, r.boards]).sort()).toEqual(
      [
        [amy, amyRank, amyTotal, amyBoards],
        [ben, benRank, benTotal, benBoards],
      ].sort(),
    )
    expect(standings.unfinished).toEqual([{ userId: cat, played: 2 }])
  }
  for (const userId of [amy, ben, cat]) expect(connections.bell(userId)).toContain('challengeResults')
  // cat's parked table closed with the challenge
  expect(tables()).toHaveLength(0)
})
