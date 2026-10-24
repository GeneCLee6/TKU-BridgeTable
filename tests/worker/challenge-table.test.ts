// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { deal } from '../../shared/board.ts'
import { encodeDealSet, type DealSet } from '../../shared/deal-set.ts'
import { ruleBrain, type RobotBrain } from '../../shared/robot/brain.ts'
import { paramsOf } from '../../shared/robot/levels.ts'
import { actionNumber, errs } from '../../shared/robot/mistakes.ts'
import type { BoardRecord, ClientMessage, ServerMessage, TableView } from '../../shared/protocol.ts'
import { ClubService, type Connections, type ScheduleKind } from '../../worker/service.ts'
import type { MemoryStore } from '../../worker/store.ts'
import { memoryStore } from './sqlite.ts'

/** The challenge table (C4): playing a challenge, its fairness, and coming back to it */

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
  last<T extends ServerMessage['type']>(userId: string, type: T) {
    return (this.inbox.get(userId) ?? []).findLast((m) => m.type === type) as
      | Extract<ServerMessage, { type: T }>
      | undefined
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
}

let store: MemoryStore
let connections: FakeConnections
let club: ClubService
let queue: { run: () => void; ms: number; kind: ScheduleKind }[]
let time: number
/** Every robot decision: the seed it was given and the action it was for */
let asked: { seed: string | undefined; action: number }[]

/** The rule robot, noting the seeds it is given */
const noting: RobotBrain = {
  bid: (kind, state, seat, level, seed) => {
    asked.push({ seed, action: actionNumber(state) })
    return ruleBrain.bid(kind, state, seat, level, seed)
  },
  play: (kind, state, seat, level, seed) => {
    asked.push({ seed, action: actionNumber(state) })
    return ruleBrain.play(kind, state, seat, level, seed)
  },
  acceptsClaim: (...args) => ruleBrain.acceptsClaim(...args),
}

const newClub = () =>
  new ClubService(store, connections, {
    maxUsers: 40,
    now: () => time,
    schedule: (run, ms, kind) => queue.push({ run, ms, kind }),
    brain: noting,
  })

beforeEach(async () => {
  store = memoryStore()
  connections = new FakeConnections()
  queue = []
  asked = []
  time = 1_000_000
  club = newClub()
  await club.load()
  await club.register('boss', 'secret1', '')
})

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

async function runRobots(limit = 400) {
  for (let i = 0; i < limit; i++) {
    const index = queue.findIndex((job) => job.kind === 'robot')
    if (index < 0) return
    queue.splice(index, 1)[0].run()
    await tick()
  }
}

async function dealNext() {
  const deals = queue.filter((job) => job.kind === 'deal')
  queue = queue.filter((job) => job.kind !== 'deal')
  time += Math.max(0, ...deals.map((job) => job.ms))
  for (const job of deals) job.run()
  await tick()
}

async function member(name: string) {
  const result = await club.register(name, 'secret1', '')
  const user =
    'user' in result ? result.user : await club.adminApprove(club.adminApplications().find((a) => a.username === name)!.id)
  connections.online.add(user.id)
  club.connected(user.id)
  await tick()
  return user.id
}

const send = (userId: string, message: ClientMessage) => club.handle(userId, message)
const view = (userId: string) => connections.table(userId)

async function refused(userId: string, message: ClientMessage) {
  connections.inbox.set(userId, [])
  await send(userId, message)
  return connections.last(userId, 'error')?.code
}

/** amy challenges ben (and whoever else), with ben accepting unless told otherwise */
async function challenge(
  settings: Record<string, unknown> = {},
  { boards = 4, others = [] as string[], accept = true } = {},
) {
  const amy = await member('amy')
  const ben = await member('ben')
  const more = []
  for (const name of others) more.push(await member(name))
  for (const id of [ben, ...more]) await send(amy, { type: 'setFriend', userId: id, friend: true })
  await send(amy, { type: 'createChallenge', invitees: [ben, ...more], boards, settings })
  const id = club.challengeList(amy)[0].id
  if (accept) await send(ben, { type: 'answerChallenge', challengeId: id, accept: true })
  return { amy, ben, more, id }
}

const play = (userId: string, challengeId: string) => send(userId, { type: 'playChallenge', challengeId })

/**
 * Plays as a person always would: pass in the auction, the first legal card in the play, so two
 * people playing this way make exactly the same calls and cards. Stops when the board is over
 */
async function playBoard(userId: string) {
  for (let i = 0; i < 400; i++) {
    await runRobots()
    const board = view(userId)?.board
    if (!board) throw new Error('no board')
    if (board.phase === 'finished') return
    if (board.legalCalls.length) await send(userId, { type: 'call', call: 'P' })
    else if (board.legalCards.length) await send(userId, { type: 'play', card: board.legalCards[0] })
    else throw new Error(`stuck: ${board.phase}, turn ${board.turn}`)
  }
}

/** Plays every board left, waiting for each deal */
async function playAll(userId: string) {
  for (;;) {
    await playBoard(userId)
    const c = view(userId)!.challenge!
    if (c.played >= c.boards) return
    await dealNext()
  }
}

async function records(challengeId: string, userId: string) {
  const results = club.challenges.get(challengeId)!.results.filter((r) => r.userId === userId)
  return Promise.all(results.map(async (r) => ({ ...r, record: (await club.record(r.boardId, userId)) as BoardRecord })))
}

describe('starting a challenge (e7-t08)', () => {
  it('opens the player’s own table: South, three robots of the challenge’s kind and level, board 1 of the set', async () => {
    const { amy, id } = await challenge({ robotKind: 'tku', robotLevel: 'beginner' })
    await play(amy, id)
    const table = view(amy)!
    expect(table.mySeat).toBe('S')
    expect(table.challenge).toEqual({ id, seq: 1, boards: 4, played: 0, deadline: club.challenges.get(id)!.deadline })
    for (const seat of ['N', 'E', 'W'] as const)
      expect(table.seats[seat]).toMatchObject({ robot: true, robotKind: 'tku', robotLevel: 'beginner' })
    expect(table.settings.allowKibitz).toBe(false)
    const stored = club.challenges.get(id)!
    expect(table.board!.boardNo).toBe(1)
    expect(table.board!.hands.S).toEqual(stored.deals.boards[0].hands.S)
    // Only the hand the player may see; the rest of the set stays on the server
    expect(Object.keys(table.board!.hands)).toEqual(['S'])
    expect(JSON.stringify(connections.inbox.get(amy))).not.toContain(stored.deals.boards[1].hands.N.join('","'))
    expect(stored.players.find((p) => p.userId === amy)!.startedAt).toBe(time)
    // Not in the lobby, for anyone
    expect(club.lobbyView(amy).tables).toEqual([])
    expect(club.lobbyView(amy).myTableId).toBe(table.id)
  })

  it('lets the creator play before anyone accepts', async () => {
    const { amy, id } = await challenge({}, { accept: false })
    expect(club.challengeFor(id, amy)!.status).toBe('pending')
    await play(amy, id)
    expect(view(amy)?.challenge?.seq).toBe(1)
  })

  it('turns away whoever may not play it now', async () => {
    const { amy, ben, more, id } = await challenge({}, { accept: false, others: ['cat'] })
    const [cat] = more
    const zoe = await member('zoe')
    expect(await refused(zoe, { type: 'playChallenge', challengeId: id })).toBe('challengeGone')
    expect(await refused(ben, { type: 'playChallenge', challengeId: id })).toBe('challengeNotAccepted')
    expect(await refused(ben, { type: 'playChallenge', challengeId: 'nope' })).toBe('challengeGone')
    await send(cat, { type: 'answerChallenge', challengeId: id, accept: true })
    await send(ben, { type: 'answerChallenge', challengeId: id, accept: false })
    expect(await refused(ben, { type: 'playChallenge', challengeId: id })).toBe('challengeNotAccepted')
    await play(cat, id)
    expect(view(cat)?.challenge?.seq).toBe(1)
    // Once the last invitee declines with nobody else accepting, it expired: nobody plays it any more
    const second = await (async () => {
      // A tick later, so it is first in the list
      time += 1
      await send(amy, { type: 'createChallenge', invitees: [ben] })
      return club.challengeList(amy)[0].id
    })()
    await send(ben, { type: 'answerChallenge', challengeId: second, accept: false })
    expect(await refused(amy, { type: 'playChallenge', challengeId: second })).toBe('challengeClosed')
  })

  it('is closed after the deadline and once cancelled', async () => {
    const first = await challenge()
    time = club.challenges.get(first.id)!.deadline
    expect(await refused(first.ben, { type: 'playChallenge', challengeId: first.id })).toBe('challengeClosed')

    const amy = first.amy
    const cat = await member('cat')
    await send(amy, { type: 'setFriend', userId: cat, friend: true })
    time += 1
    await send(amy, { type: 'createChallenge', invitees: [cat] })
    const second = club.challengeList(amy)[0].id
    await play(amy, second)
    await send(amy, { type: 'leaveTable' })
    await send(amy, { type: 'cancelChallenge', challengeId: second })
    expect(await refused(amy, { type: 'playChallenge', challengeId: second })).toBe('challengeClosed')
    // The parked table went with it
    expect((await store.list('table:')).size).toBe(0)
  })
})

describe('the deadline (社長, 2026-10-24)', () => {
  it('stops play at once, as on BBO: the board being played is dropped and nothing is scored', async () => {
    const { ben, id } = await challenge()
    await play(ben, id)
    await runRobots()
    const before = view(ben)!.board!
    expect(before.phase).toBe('auction')
    expect(before.legalCalls.length).toBeGreaterThan(0)

    time = club.challenges.get(id)!.deadline
    expect(await refused(ben, { type: 'call', call: 'P' })).toBe('challengeClosed')
    // The robots stop too: nothing moves on the table
    await runRobots()
    expect(view(ben)?.board?.auction.length ?? before.auction.length).toBe(before.auction.length)
    expect(club.challenges.get(id)!.results).toHaveLength(0)
    expect(await refused(ben, { type: 'playChallenge', challengeId: id })).toBe('challengeClosed')
  })
})

describe('a challenge table is fixed (AC-7.3)', () => {
  it('has no undo, no kibitzers, no seat or robot changes', async () => {
    const { amy, ben, id } = await challenge()
    await play(amy, id)
    const tableId = view(amy)!.id
    expect(view(amy)!.board!.canUndo).toBe(false)
    await runRobots()
    if (view(amy)!.board!.legalCalls.length) await send(amy, { type: 'call', call: 'P' })
    expect(view(amy)!.board!.canUndo).toBe(false)
    expect(await refused(amy, { type: 'undoRequest' })).toBe('challengeNoUndo')
    expect(await refused(ben, { type: 'joinTable', tableId })).toBe('tableGone')
    expect(await refused(ben, { type: 'sit', tableId, seat: 'N' })).toBe('tableGone')
    expect(await refused(amy, { type: 'sit', tableId, seat: 'N' })).toBe('challengeTableFixed')
    expect(await refused(amy, { type: 'stand' })).toBe('challengeTableFixed')
    expect(await refused(amy, { type: 'removeRobot', seat: 'N' })).toBe('challengeTableFixed')
    expect(await refused(amy, { type: 'kick', seat: 'N' })).toBe('challengeTableFixed')
    expect(await refused(amy, { type: 'updateTableSettings', settings: { allowKibitz: true } })).toBe('challengeTableFixed')
    expect(view(ben)).toBeNull()
  })
})

describe('playing it through (e7-t08)', () => {
  it('plays each board once, numbered from the set, and writes the results and the records', async () => {
    const { amy, ben, id } = await challenge()
    // A set whose board numbers are not 1, 2, 3…, as one made from boards already played would be
    const set: DealSet = { boards: [7, 2, 16, 9].map((boardNo) => ({ boardNo, hands: deal() })) }
    store.sql.exec('UPDATE challenges SET deals = ? WHERE challenge_id = ?', encodeDealSet(set), id)
    const deadline = club.challenges.get(id)!.deadline

    await play(amy, id)
    const seen: number[] = []
    for (;;) {
      seen.push(view(amy)!.board!.boardNo)
      await playBoard(amy)
      if (view(amy)!.challenge!.played === 4) break
      await dealNext()
    }
    expect(seen).toEqual([7, 2, 16, 9])
    expect(club.challenges.get(id)!.players.find((p) => p.userId === amy)!.finishedAt).toBe(time)
    // The last board stays on the table, with nothing more to deal
    expect(view(amy)!.dealAt).toBeNull()
    await dealNext()
    expect(view(amy)!.board!.boardNo).toBe(9)

    const mine = await records(id, amy)
    expect(mine.map((r) => r.seq)).toEqual([1, 2, 3, 4])
    for (const [i, r] of mine.entries()) {
      expect(r.record).toMatchObject({ mode: 'challenge', eventId: id, revealAt: deadline, tableNumber: 0 })
      expect(r.record.board.boardNo).toBe(set.boards[i].boardNo)
      expect(r.record.board.hands).toEqual(set.boards[i].hands)
      expect(r.scoreNS).toBe(r.record.board.result!.scoreNS)
      // Kept from everyone else until the challenge ends
      expect(await club.record(r.boardId, ben)).toBeNull()
    }
    expect(club.challengeFor(id, ben)!.players.find((p) => p.userId === amy)!.played).toBe(4)

    // Leaving a finished challenge closes its table, and there is nothing more to play
    await send(amy, { type: 'leaveTable' })
    expect(view(amy)).toBeNull()
    expect(await refused(amy, { type: 'playChallenge', challengeId: id })).toBe('challengeDone')
  })
})

describe('progress and coming back (e7-t12)', () => {
  it('leaving pauses the table; coming back goes on with the same board, then the next', async () => {
    const { amy, id } = await challenge()
    await play(amy, id)
    await playBoard(amy)
    await dealNext()
    await runRobots()
    if (view(amy)!.board!.legalCalls.length) await send(amy, { type: 'call', call: 'P' })
    await runRobots()
    const before = view(amy)!
    expect(before.challenge).toMatchObject({ seq: 2, played: 1 })

    // Opening another table leaves the challenge table, which waits
    await send(amy, { type: 'createTable' })
    expect(view(amy)!.challenge).toBeUndefined()
    await runRobots()
    await dealNext()
    await send(amy, { type: 'leaveTable' })
    expect(view(amy)).toBeNull()

    await play(amy, id)
    const after = view(amy)!
    expect(after.id).toBe(before.id)
    expect(after.board).toEqual(before.board)
    expect(after.challenge).toMatchObject({ seq: 2, played: 1 })
    await playBoard(amy)
    await dealNext()
    expect(view(amy)!.challenge).toMatchObject({ seq: 3, played: 2 })
  })

  it('a board finished before leaving is followed by the next one on coming back', async () => {
    const { amy, id } = await challenge()
    await play(amy, id)
    await playBoard(amy)
    await send(amy, { type: 'leaveTable' })
    await dealNext()
    await play(amy, id)
    expect(view(amy)!.board!.phase).toBe('finished')
    await dealNext()
    expect(view(amy)!.challenge).toMatchObject({ seq: 2, played: 1 })
  })

  it('a dropped connection keeps the seat, and a reloaded object keeps the table', async () => {
    const { amy, id } = await challenge()
    await play(amy, id)
    await runRobots()
    const before = view(amy)!
    connections.online.delete(amy)
    await club.disconnected(amy)

    // The object is evicted and loaded again from the store
    queue = []
    club = newClub()
    await club.load()
    connections.online.add(amy)
    connections.inbox.set(amy, [])
    club.connected(amy)
    await tick()
    expect(view(amy)!.id).toBe(before.id)
    expect(view(amy)!.board).toEqual(before.board)
    await playAll(amy)
    expect(club.challenges.get(id)!.results.filter((r) => r.userId === amy)).toHaveLength(4)
  })

  it('a parked table survives a reload too', async () => {
    const { amy, id } = await challenge()
    await play(amy, id)
    await playBoard(amy)
    await dealNext()
    await send(amy, { type: 'leaveTable' })
    queue = []
    club = newClub()
    await club.load()
    await play(amy, id)
    expect(view(amy)!.challenge).toMatchObject({ seq: 2, played: 1 })
  })
})

describe('the same robots for everyone (e7-t09)', () => {
  /** Two participants play every board the same way; the robots must answer them the same way */
  async function bothPlay(settings: Record<string, unknown>) {
    const { amy, ben, id } = await challenge(settings)
    await play(amy, id)
    await playAll(amy)
    const amySeeds = asked.splice(0)
    await send(amy, { type: 'leaveTable' })
    await play(ben, id)
    await playAll(ben)
    const benSeeds = asked.splice(0)
    const of = async (userId: string) =>
      (await records(id, userId)).map(({ record }) => ({ auction: record.board.auction, play: record.board.play, result: record.board.result }))
    return { amy: await of(amy), ben: await of(ben), amySeeds, benSeeds, id }
  }

  it('gives two participants who play alike identical auctions and play', async () => {
    const { amy, ben, amySeeds, benSeeds, id } = await bothPlay({ robotLevel: 'open' })
    expect(amy).toHaveLength(4)
    expect(amy.some((b) => b.play.length > 0)).toBe(true)
    expect(ben).toEqual(amy)
    expect(benSeeds).toEqual(amySeeds)
    expect(new Set(amySeeds.map((s) => s.seed))).toEqual(new Set([1, 2, 3, 4].map((seq) => `challenge:${id}:${seq}`)))
  })

  it('makes the same mistakes for both at the beginner level', async () => {
    const { amy, ben, amySeeds, benSeeds } = await bothPlay({ robotLevel: 'beginner', robotKind: 'tku' })
    expect(ben).toEqual(amy)
    expect(benSeeds).toEqual(amySeeds)
    // Beginners did err along the way, at the very same actions for both
    const { errorRate } = paramsOf('beginner')
    expect(amySeeds.filter(({ seed, action }) => errs(errorRate, seed, action)).length).toBeGreaterThan(0)
  })
})
