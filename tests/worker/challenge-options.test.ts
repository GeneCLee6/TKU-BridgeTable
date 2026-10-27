// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { hcp, SEATS } from '../../shared/cards.ts'
import { robotAuction } from '../../shared/challenge-deals.ts'
import { encodeDealSet } from '../../shared/deal-set.ts'
import { ruleBrain, type RobotBrain } from '../../shared/robot/brain.ts'
import type { BoardRecord, ClientMessage, ServerMessage, TableView } from '../../shared/protocol.ts'
import { openingLead } from '../../shared/traveller.ts'
import { ClubService, type Connections, type ScheduleKind } from '../../worker/service.ts'
import type { MemoryStore } from '../../worker/store.ts'
import { memoryStore } from './sqlite.ts'
import { clubService } from './event-mode.ts'

/** Best Hand, Just Declare, rematch and 「用這副牌挑戰」 through the server (C8) */

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
/** Every robot decision: the seat asked and the calls and cards made before it */
let asked: { seat: string; action: number }[]

/** The rule robot, noting what it is asked */
const noting: RobotBrain = {
  bid: (kind, state, seat) => {
    asked.push({ seat, action: state.auction.length + state.play.length })
    return ruleBrain.bid(kind, state, seat)
  },
  play: (kind, state, seat) => {
    asked.push({ seat, action: state.auction.length + state.play.length })
    return ruleBrain.play(kind, state, seat)
  },
  acceptsClaim: (...args) => ruleBrain.acceptsClaim(...args),
}

const newClub = () =>
  clubService(store, connections, {
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
  // These challenges are set up with either TKB; the club's needs the permission (ROBOT.md §7)
  await club.adminSetPermissions(user.id, ['tkuSystem'])
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

/** The deal set kept with a challenge */
const dealsOf = (id: string) => club.challenges.get(id)!.deals

describe('Best Hand (e7-t10)', () => {
  it('deals every participant the same boards, South holding the most points', async () => {
    const { amy, ben, id } = await challenge({ bestHand: true })
    expect(club.challengeFor(id, amy)!.settings.bestHand).toBe(true)
    for (const board of dealsOf(id).boards)
      expect(hcp(board.hands.S)).toBe(Math.max(...SEATS.map((s) => hcp(board.hands[s]))))
    await play(amy, id)
    await play(ben, id)
    expect(view(amy)!.board!.hands.S).toEqual(dealsOf(id).boards[0].hands.S)
    expect(view(ben)!.board!.hands.S).toEqual(dealsOf(id).boards[0].hands.S)
  })
})

describe('Just Declare (e7-t11)', () => {
  it('starts each board after the robots’ auction, with the participant declaring', async () => {
    const { amy, id } = await challenge({ justDeclare: true, robotKind: 'gib' })
    const deals = dealsOf(id)
    expect(deals.boards.every((b) => b.auction?.length)).toBe(true)
    await play(amy, id)
    for (let n = 0; n < 4; n++) {
      const board = view(amy)!.board!
      expect(board.phase).toBe('play')
      expect(board.auction.map((c) => c.call)).toEqual(deals.boards[n].auction)
      expect(board.auction.every((c) => c.robot)).toBe(true)
      // The person declares, from South or moved to North; the robot on their left leads
      expect(view(amy)!.mySeat).toBe(board.contract!.declarer)
      expect(board.legalCalls).toEqual([])
      await runRobots()
      expect(view(amy)!.board!.tricks[0]?.cards.length).toBeGreaterThanOrEqual(1)
      await playBoard(amy)
      if (n < 3) await dealNext()
    }
    expect(club.challenges.get(id)!.results.filter((r) => r.userId === amy)).toHaveLength(4)
  })

  it('is the same for two participants who play the same way', async () => {
    const { amy, ben, id } = await challenge({ justDeclare: true })
    await play(amy, id)
    await playAll(amy)
    await send(amy, { type: 'leaveTable' })
    await play(ben, id)
    await playAll(ben)
    const a = await records(id, amy)
    const b = await records(id, ben)
    expect(b.map((r) => r.record.board.play)).toEqual(a.map((r) => r.record.board.play))
    expect(b.map((r) => r.scoreNS)).toEqual(a.map((r) => r.scoreNS))
  })
})

describe('a participant plays every board from South (AC-7.3)', () => {
  it('moves them back after declaring one from North', async () => {
    const { amy, id } = await challenge({ justDeclare: true, robotKind: 'gib' }, { boards: 16 })
    const deals = dealsOf(id)
    const kind = club.challenges.get(id)!.settings.robotKind
    const declarer = (i: number) => {
      const b = deals.boards[i]
      return robotAuction(kind, b.boardNo, b.hands, b.auction).contract!.declarer
    }
    const north = deals.boards.findIndex((_, i) => declarer(i) === 'N')
    const south = deals.boards.findIndex((_, i) => declarer(i) === 'S')
    expect(north).toBeGreaterThanOrEqual(0)
    expect(south).toBeGreaterThanOrEqual(0)
    // A board North declares, then one South declares
    const boards = [deals.boards[north], deals.boards[south], ...deals.boards.filter((_, i) => i !== north && i !== south)]
    store.sql.exec('UPDATE challenges SET deals = ? WHERE challenge_id = ?', encodeDealSet({ boards }), id)
    await play(amy, id)
    expect(view(amy)!.mySeat).toBe('N')
    expect(view(amy)!.board!.hands.N).toEqual(boards[0].hands.N)
    await playBoard(amy)
    await dealNext()
    expect(view(amy)!.mySeat).toBe('S')
    expect(view(amy)!.board!.hands.S).toEqual(boards[1].hands.S)
  })
})

describe('one-click rematch (e7-t21)', () => {
  it('challenges the same people again with the same settings and new boards', async () => {
    const settings = { scoring: 'crossImp', robotKind: 'tku', bestHand: true, justDeclare: false, days: 5, ranking: 'club' }
    const { amy, ben, more, id } = await challenge(settings, { boards: 6, others: ['cat'] })
    await send(more[0], { type: 'answerChallenge', challengeId: id, accept: true })
    expect(await refused(ben, { type: 'rematchChallenge', challengeId: id })).toBe('challengeNotOver')
    await send(amy, { type: 'cancelChallenge', challengeId: id })
    // ben and cat are friends of amy, not of each other: ben need not follow them to rematch
    time += 1
    const again = await club.challengeRequest(ben, { type: 'rematchChallenge', challengeId: id })
    expect(again!.id).not.toBe(id)
    expect(again!.creatorId).toBe(ben)
    expect(again!.players.map((p) => p.userId)).toEqual([ben, amy, more[0]])
    expect(again!.boards).toBe(6)
    expect(again!.settings).toEqual(settings)
    expect(dealsOf(again!.id)).not.toEqual(dealsOf(id))
    expect(club.challengeList(amy)[0].id).toBe(again!.id)
  })

  it('comes back with the 2/1 TKB for a member without tkuSystem (ROBOT.md §7)', async () => {
    const { amy, ben, id } = await challenge({ robotKind: 'tku' })
    await send(amy, { type: 'cancelChallenge', challengeId: id })
    await send(ben, { type: 'setFriend', userId: amy, friend: true })
    await club.adminSetPermissions(ben, [])
    time += 1
    const again = await club.challengeRequest(ben, { type: 'rematchChallenge', challengeId: id })
    expect(again!.settings.robotKind).toBe('gib')
    // The one who may use the club's robots keeps them
    await send(ben, { type: 'cancelChallenge', challengeId: again!.id })
    time += 1
    const amys = await club.challengeRequest(amy, { type: 'rematchChallenge', challengeId: id })
    expect(amys!.settings.robotKind).toBe('tku')
  })

  it('is only for a participant who accepted, and needs someone to play', async () => {
    const { amy, ben, id } = await challenge({}, { accept: false })
    const zoe = await member('zoe')
    await send(ben, { type: 'answerChallenge', challengeId: id, accept: false })
    expect(club.challengeFor(id, amy)!.status).toBe('expired')
    expect(await refused(zoe, { type: 'rematchChallenge', challengeId: id })).toBe('challengeGone')
    expect(await refused(ben, { type: 'rematchChallenge', challengeId: id })).toBe('challengeNotAccepted')
    expect(await refused(amy, { type: 'rematchChallenge', challengeId: id })).toBe('rematchNobody')
  })
})

/** Plays one board at the member's own table with three robots, from `seat`; returns the record */
async function robotBoard(userId: string, seat: 'N' | 'E' | 'S' | 'W' = 'S', kind: 'tku' | 'gib' = 'gib') {
  await send(userId, { type: 'createTable' })
  const tableId = view(userId)!.id
  if (seat !== 'S') await send(userId, { type: 'sit', tableId, seat })
  for (const s of SEATS) if (s !== seat) await send(userId, { type: 'addRobot', seat: s, kind })
  await playBoard(userId)
  const id = view(userId)!.board!.recordId!
  await send(userId, { type: 'leaveTable' })
  return (await club.record(id, userId)) as BoardRecord
}

describe('「用這副牌挑戰」 (e7-t22)', () => {
  it('counts the creator’s own result and turns the board so their seat is South', async () => {
    const amy = await member('amy')
    const ben = await member('ben')
    await send(amy, { type: 'setFriend', userId: ben, friend: true })
    const record = await robotBoard(amy, 'E', 'tku')
    const made = await club.challengeRequest(amy, { type: 'createChallenge', invitees: [ben], fromBoards: [record.id] })
    const c = club.challenges.get(made!.id)!
    expect(c.settings.robotKind).toBe('tku')
    expect(c.deals.boards).toHaveLength(1)
    expect(c.deals.boards[0].hands.S).toEqual(record.board.hands.E)
    expect(c.players[0]).toMatchObject({ userId: amy, knownDeals: true })
    expect(c.results).toEqual([
      { userId: amy, seq: 1, boardId: record.id, scoreNS: -record.board.result!.scoreNS || 0, playedAt: record.finishedAt },
    ])
    // The creator does not play again; ben does, from South
    expect(await refused(amy, { type: 'playChallenge', challengeId: c.id })).toBe('challengeDone')
    await send(ben, { type: 'answerChallenge', challengeId: c.id, accept: true })
    await play(ben, c.id)
    expect(view(ben)!.board!.hands.S).toEqual(record.board.hands.E)
    await playBoard(ben)
    // Both played every board: the challenge is over and both are ranked
    const done = club.challengeFor(c.id, ben)!
    expect(done.status).toBe('finished')
    expect(done.standings!.ranked.map((r) => r.userId).sort()).toEqual([amy, ben].sort())
    expect(done.players.find((p) => p.userId === amy)!.knownDeals).toBe(true)
  })

  it('turns down boards played with the club’s robots from a member without tkuSystem (ROBOT.md §7)', async () => {
    const amy = await member('amy')
    const ben = await member('ben')
    await send(amy, { type: 'setFriend', userId: ben, friend: true })
    const tku = await robotBoard(amy, 'S', 'tku')
    const gib = await robotBoard(amy, 'S', 'gib')
    await club.adminSetPermissions(amy, [])
    expect(await refused(amy, { type: 'createChallenge', invitees: [ben], fromBoards: [tku.id] })).toBe('tkuSystemOnly')
    expect(await refused(amy, { type: 'createChallenge', invitees: [ben], fromBoards: [gib.id] })).toBeUndefined()
  })

  it('takes only the creator’s boards with three robots of one system, as they were dealt', async () => {
    const amy = await member('amy')
    const ben = await member('ben')
    await send(amy, { type: 'setFriend', userId: ben, friend: true })
    const gib = await robotBoard(amy, 'S', 'gib')
    const tku = await robotBoard(amy, 'S', 'tku')
    const create = (fromBoards: string[], extra: Record<string, unknown> = {}) =>
      refused(amy, { type: 'createChallenge', invitees: [ben], fromBoards, ...extra } as ClientMessage)
    expect(await create([gib.id, tku.id])).toBe('challengeRobotKinds')
    expect(await create(['nope'])).toBe('boardGone')
    expect(await create([])).toBe('badChallengeSettings')
    expect(await create([gib.id, gib.id])).toBe('badChallengeSettings')
    // A challenge keeps to 16 boards, though a deal set may hold a team match's 32
    expect(await create(Array.from({ length: 17 }, (_, i) => `b${i}`))).toBe('badChallengeSettings')
    expect(await refused(amy, { type: 'createChallenge', invitees: [ben], boards: 17 })).toBe('challengeBoards')
    expect(await create([gib.id], { boards: 4 })).toBe('badChallengeSettings')
    expect(await create([gib.id], { settings: { bestHand: true } })).toBe('badChallengeSettings')
    expect(await create([gib.id], { settings: { justDeclare: true } })).toBe('badChallengeSettings')
    expect(await create([gib.id], { settings: { robotKind: 'tku' } })).toBe('badChallengeSettings')
    // ben did not play amy's board
    await send(ben, { type: 'setFriend', userId: amy, friend: true })
    expect(await refused(ben, { type: 'createChallenge', invitees: [amy], fromBoards: [gib.id] })).toBe('boardGone')

    // A board with another person at the table is not one to challenge with
    await send(amy, { type: 'createTable' })
    const tableId = view(amy)!.id
    await send(ben, { type: 'sit', tableId, seat: 'N' })
    for (const s of ['E', 'W'] as const) await send(amy, { type: 'addRobot', seat: s, kind: 'gib' })
    for (let i = 0; i < 400 && view(amy)!.board?.phase !== 'finished'; i++) {
      await runRobots()
      for (const who of [amy, ben]) {
        const board = view(who)!.board!
        if (board.legalCalls.length) await send(who, { type: 'call', call: 'P' })
        else if (board.legalCards.length) await send(who, { type: 'play', card: board.legalCards[0] })
      }
    }
    expect(await create([view(amy)!.board!.recordId!])).toBe('challengeRobotsOnly')
  })
})

/** Runs the challenge's deadline job, as the scheduler would at the deadline */
async function reachDeadline(id: string) {
  time = club.challenges.get(id)!.deadline
  const jobs = queue.filter((job) => job.kind === 'challenge')
  queue = queue.filter((job) => job.kind !== 'challenge')
  for (const job of jobs) job.run()
  for (let i = 0; i < 10; i++) await tick()
}

describe('one-board challenges (社長, 2026-10-25)', () => {
  it('plays a single board and ranks by matchpoints the two of three who played it', async () => {
    const { amy, ben, more, id } = await challenge({ scoring: 'mp' }, { boards: 1, others: ['cat'] })
    const [cat] = more
    await send(cat, { type: 'answerChallenge', challengeId: id, accept: true })
    await play(amy, id)
    await playBoard(amy)
    // Alone so far: first, with her total score only
    expect(club.challengeFor(id, amy)!.standings).toMatchObject({ final: false, scoring: 'total', ranked: [{ userId: amy, rank: 1 }] })
    expect(club.challengeFor(id, ben)!.standings).toBeUndefined()
    await play(ben, id)
    await playBoard(ben)
    await reachDeadline(id)
    const done = club.challengeFor(id, cat)!
    expect(done.status).toBe('finished')
    // Both played the board the same way against the same robots: the same score, 50% each
    expect(done.standings).toMatchObject({ final: true, scoring: 'mp', unfinished: [{ userId: cat, played: 0 }] })
    expect(done.standings!.ranked.map((r) => [r.userId, r.total, r.rank, r.boards])).toEqual([
      [amy, 50, 1, [50]],
      [ben, 50, 1, [50]],
    ])
    expect(done.travellers?.map((x) => [x.seq, x.entries.map((e) => e.userId)])).toEqual([[1, [amy, ben]]])
  })

  it('rematches with as many boards as before, even one', async () => {
    const { amy, ben, id } = await challenge({}, { boards: 1, accept: false })
    await send(amy, { type: 'cancelChallenge', challengeId: id })
    time += 1
    const again = await club.challengeRequest(amy, { type: 'rematchChallenge', challengeId: id })
    expect(again!.boards).toBe(1)
    expect(again!.players.map((p) => p.userId)).toEqual([amy, ben])
  })

  it('rematches a 「用這副牌挑戰」 of one board with one new board', async () => {
    const amy = await member('amy')
    const ben = await member('ben')
    await send(amy, { type: 'setFriend', userId: ben, friend: true })
    const record = await robotBoard(amy)
    const made = await club.challengeRequest(amy, { type: 'createChallenge', invitees: [ben], fromBoards: [record.id] })
    await send(amy, { type: 'cancelChallenge', challengeId: made!.id })
    time += 1
    const again = await club.challengeRequest(amy, { type: 'rematchChallenge', challengeId: made!.id })
    expect(again!.boards).toBe(1)
    expect(again!.players[0].knownDeals).toBe(false)
  })
})

describe('the results page: each board’s lead (社長, 2026-10-25)', () => {
  it('reads the leads only for travellers the member may see, as §4 says', async () => {
    const { amy, ben, id } = await challenge({ ranking: 'club' }, { boards: 2 })
    const zoe = await member('zoe')
    await play(amy, id)
    await playAll(amy)
    await play(ben, id)
    await playBoard(ben)
    await send(ben, { type: 'leaveTable' })
    const leadOf = async (boardId: string) => openingLead((await club.record(boardId, amy))!.board)

    // amy played every board: the travellers with everyone's lead
    const amyView = (await club.challengeDetail(id, amy))!
    expect(amyView.travellers!.map((x) => x.entries.map((e) => e.userId))).toEqual([[amy, ben], [amy]])
    for (const x of amyView.travellers!) for (const e of x.entries) expect(e.lead).toEqual(await leadOf(e.boardId))
    expect(amyView.travellers!.some((x) => x.entries.some((e) => e.lead))).toBe(true)
    // The lobby's list and the plain view do not read the records
    expect('lead' in club.challengeFor(id, amy)!.travellers![0].entries[0]).toBe(false)
    // ben is still playing: nobody's results, not even his own board's lead; zoe is not in it
    const benView = (await club.challengeDetail(id, ben))!
    expect(benView.travellers).toBeUndefined()
    expect(benView.standings).toBeUndefined()
    expect(await club.challengeDetail(id, zoe)).toBeNull()

    await reachDeadline(id)
    // Once it ended every participant sees it all; the club sees the standings without the boards
    expect((await club.challengeDetail(id, ben))!.travellers![0].entries.map((e) => e.lead)).toEqual(
      amyView.travellers![0].entries.map((e) => e.lead),
    )
    const zoeView = (await club.challengeDetail(id, zoe))!
    expect(zoeView.travellers).toBeUndefined()
    expect(zoeView.standings!.ranked.every((r) => r.boards === undefined)).toBe(true)
  })
})
