// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { SEATS, type Card, type Seat } from '../../shared/cards.ts'
import { DEAL_PRESETS } from '../../shared/deal-presets.ts'
import { meetsConditions } from '../../shared/dealer.ts'
import {
  PARTNER_BID_ACTIVE_MAX,
  PARTNER_BID_BOARDS_MAX,
  PARTNER_BID_IDLE_MS,
  PARTNER_BID_INVITE_MS,
  PARTNER_BID_KEEP_MS,
  PARTNER_BID_KEPT,
  PARTNER_BID_QUIET_MS,
  parsePartnerBidSettings,
  type PartnerBidView,
} from '../../shared/partner-bidding.ts'
import type { ServerMessage } from '../../shared/protocol.ts'
import { ruleBrain, type RobotBrain } from '../../shared/robot/brain.ts'
import { ClubService, type Connections, type ScheduleKind } from '../../worker/service.ts'
import type { MemoryStore } from '../../worker/store.ts'
import { memoryStore } from './sqlite.ts'

/** 搭檔非同步叫牌練習 (`e10-t08`, AC-10.6): two members, a set of deals, one call at a time */

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
}

let store: MemoryStore
let connections: FakeConnections
let club: ClubService
let queue: { run: () => void; ms: number; kind: ScheduleKind }[]
let time: number
let amy: string
let ben: string
let cat: string

const flush = () => new Promise((resolve) => setImmediate(resolve))

async function make(brain?: RobotBrain) {
  return new ClubService(store, connections, {
    maxUsers: 40,
    now: () => time,
    brain,
    schedule: (run, ms, kind) => queue.push({ run, ms, kind }),
  })
}

async function member(name: string) {
  const result = await club.register(name, 'club-secret-1', '')
  if ('user' in result) return result.user.id
  const application = club.adminApplications().find((a) => a.username === name)!
  return (await club.adminApprove(application.id)).id
}

/** Runs the review's jobs, the way the alarm would */
async function runRobots() {
  for (let i = 0; i < 40; i++) {
    const index = queue.findIndex((job) => job.kind === 'robot')
    if (index < 0) return
    queue.splice(index, 1)[0].run()
    await flush()
  }
}

/** Lets the expiry sweep's time come, and runs it */
async function sweep(after: number) {
  time += after
  const jobs = queue.filter((job) => job.kind === 'partnerBid')
  queue = queue.filter((job) => job.kind !== 'partnerBid')
  for (const job of jobs) job.run()
  await flush()
  await flush()
}

const bells = async (id: string) => (await club.notifications.view(id)).items.map((n) => n.kind)

/** Everything that went to a member's browser about partner bidding, and its answers */
const wire = (id: string) => JSON.stringify((connections.inbox.get(id) ?? []).filter((m) => m.type === 'partnerBid'))

/** The other member's cards must be nowhere in `text` */
const leaksAny = (text: string, cards: readonly Card[]) => cards.filter((card) => text.includes(`"${card}"`))

beforeEach(async () => {
  store = memoryStore()
  connections = new FakeConnections()
  queue = []
  time = 1_000_000
  club = await make()
  await club.load()
  await member('boss')
  amy = await member('amy')
  ben = await member('ben')
  cat = await member('cat')
})

/** A session both have agreed to; board numbers from 1, so North deals the first board */
async function started(boards = 1, settings: object = {}) {
  const invited = await club.partnerBids.create(amy, { partnerId: ben, settings: { boards, robotKind: 'gib', ...settings } })
  return club.partnerBids.answer(ben, invited.id, true)
}

const call = (who: string, id: string, what: string) => club.partnerBids.call(who, id, what)

/** Plays the board on the table to its end: 1NT by whoever's call it is, then passes */
async function bidOut(id: string) {
  let view = club.partnerBids.get(amy, id)
  const board = () => view.sessionBoards[view.done]
  let first = true
  const seq = view.done
  while (view.status === 'active' && view.done === seq) {
    const turn = board().turn!
    const who = turn === 'S' ? amy : ben
    view = await call(who, id, first ? '1N' : 'P')
    first = false
    view = club.partnerBids.get(who === amy ? ben : amy, id)
  }
  return view
}

const ownOnly = (view: PartnerBidView, seat: Seat, seq = 0) => Object.keys(view.sessionBoards[seq].hands).join() === seat

describe('inviting (e10-t08)', () => {
  it('invites another member, who hears it and accepts or declines', async () => {
    const view = await club.partnerBids.create(amy, { partnerId: ben, settings: { boards: 2 } })
    expect(view.status).toBe('invited')
    expect(view.seat).toBe('S')
    // Nobody sees any cards before the partner said yes
    expect(view.sessionBoards).toEqual([])
    expect(await bells(ben)).toContain('partnerBidInvited')

    // Only the partner answers
    await expect(club.partnerBids.answer(amy, view.id, true)).rejects.toMatchObject({ code: 'partnerBidNotInvited' })
    await expect(club.partnerBids.call(ben, view.id, 'P')).rejects.toMatchObject({ code: 'partnerBidOver' })

    const declined = await club.partnerBids.answer(ben, view.id, false)
    expect(declined.status).toBe('declined')
    expect(await bells(amy)).toContain('partnerBidDeclined')
    await expect(club.partnerBids.answer(ben, view.id, true)).rejects.toMatchObject({ code: 'partnerBidNotInvited' })
  })

  it('takes members of this club only, never oneself', async () => {
    await expect(club.partnerBids.create(amy, { partnerId: amy })).rejects.toMatchObject({ code: 'notSelf' })
    // Another club's member is simply not here (each club knows only its own, §1)
    await expect(club.partnerBids.create(amy, { partnerId: 'someone-at-another-club' })).rejects.toMatchObject({ code: 'userGone' })
  })

  it('checks blocks both ways and answers as any invitation does', async () => {
    await club.handle(amy, { type: 'setBlocked', userId: ben, blocked: true })
    await expect(club.partnerBids.create(amy, { partnerId: ben })).rejects.toMatchObject({ code: 'unblockToInvite' })
    await expect(club.partnerBids.create(ben, { partnerId: amy })).rejects.toMatchObject({ code: 'cannotInvite' })
    await club.handle(amy, { type: 'setBlocked', userId: ben, blocked: false })
    await expect(club.partnerBids.create(amy, { partnerId: ben })).resolves.toMatchObject({ status: 'invited' })
  })

  it('a block ends what the two have open, and the other member gets no bell', async () => {
    const view = await started()
    const before = (await bells(ben)).length
    await club.handle(ben, { type: 'setBlocked', userId: amy, blocked: true })
    expect(club.partnerBids.get(amy, view.id).status).toBe('abandoned')
    expect((await bells(amy)).filter((k) => k === 'partnerBidAbandoned')).toEqual([])
    expect((await bells(ben)).length).toBe(before)
  })

  it('limits the sessions a member has open, on either side', async () => {
    for (let i = 0; i < PARTNER_BID_ACTIVE_MAX; i++) await club.partnerBids.create(amy, { partnerId: ben })
    await expect(club.partnerBids.create(amy, { partnerId: cat })).rejects.toMatchObject({ code: 'partnerBidTooMany' })
    await expect(club.partnerBids.create(cat, { partnerId: amy })).rejects.toMatchObject({ code: 'partnerBidPartnerBusy' })
  })

  it('checks the settings', async () => {
    expect(parsePartnerBidSettings({ boards: PARTNER_BID_BOARDS_MAX + 1 }, 'gib')).toEqual({ field: 'boards' })
    expect(parsePartnerBidSettings({ boards: 0 }, 'gib')).toEqual({ field: 'boards' })
    expect(parsePartnerBidSettings({ deal: 'custom' }, 'gib')).toEqual({ field: 'deal' })
    expect(parsePartnerBidSettings({ deal: 'set' }, 'gib')).toEqual({ field: 'setId' })
    expect(parsePartnerBidSettings({ setId: 'bidding' }, 'gib')).toEqual({ field: 'setId' })
    expect(parsePartnerBidSettings({ robotKind: 'smart' }, 'gib')).toEqual({ field: 'robotKind' })
    expect(parsePartnerBidSettings({ hands: [] }, 'gib')).toEqual({ field: 'settings' })
    await expect(club.partnerBids.create(amy, { partnerId: ben, settings: { boards: 99 } })).rejects.toMatchObject({ code: 'badPartnerBidSettings' })
    await expect(club.partnerBids.create(amy, { partnerId: ben, settings: { deal: 'set', setId: 'nope' } })).rejects.toMatchObject({ code: 'practiceSetGone' })
  })

  it('deals to a preset from South, the inviter, and takes a practice set', async () => {
    const preset = await started(1, { deal: 'oneNotrump' })
    const board = club.partnerBids.get(amy, preset.id).sessionBoards[0]
    expect(board.dealer).toBe('S')
    // Worked out on the server: read straight from the board once it is over
    const over = await bidOut(preset.id)
    expect(meetsConditions(DEAL_PRESETS.oneNotrump, over.sessionBoards[0].hands as never)).toBe(true)

    const set = await started(2, { deal: 'set', setId: 'bidding' })
    expect(set.boards).toBe(2)
    expect(set.sessionBoards[0].category).toBeDefined()
  })
})

describe('who sees what (hard rule 2, ARCHITECTURE.md §4)', () => {
  it("never sends the partner's hand before the auction ends, in any answer or message", async () => {
    connections.online.add(amy)
    connections.online.add(ben)
    const view = await started(2)
    const id = view.id
    const amyView = club.partnerBids.get(amy, id)
    const benView = club.partnerBids.get(ben, id)
    expect(ownOnly(amyView, 'S')).toBe(true)
    expect(ownOnly(benView, 'N')).toBe(true)
    const amyCards = amyView.sessionBoards[0].hands.S!
    const benCards = benView.sessionBoards[0].hands.N!
    expect(amyCards).toHaveLength(13)
    expect(benCards).toHaveLength(13)

    const check = () => {
      const a = JSON.stringify(club.partnerBids.get(amy, id).sessionBoards[0]) + JSON.stringify(club.partnerBids.list(amy))
      const b = JSON.stringify(club.partnerBids.get(ben, id).sessionBoards[0]) + JSON.stringify(club.partnerBids.list(ben))
      expect(leaksAny(a, benCards)).toEqual([])
      expect(leaksAny(b, amyCards)).toEqual([])
    }
    check()
    // Board 1: North deals
    const first = club.partnerBids.get(ben, id).sessionBoards[0]
    expect(first.turn).toBe('N')
    await call(ben, id, '1C')
    check()
    await call(amy, id, '1H')
    check()
    // Their cards are on the wire only through views: only ever their own while the board is bid
    expect(leaksAny(wire(amy), benCards)).toEqual([])
    expect(leaksAny(wire(ben), amyCards)).toEqual([])
    // Nor does a stranger, nor an admin, read the session
    expect(() => club.partnerBids.get(cat, id)).toThrow()
    await expect(club.partnerBids.call(cat, id, 'P')).rejects.toMatchObject({ code: 'partnerBidGone' })
    await expect(club.partnerBids.abandon(cat, id)).rejects.toMatchObject({ code: 'partnerBidGone' })
    expect(club.partnerBids.list(cat)).toEqual([])
  })

  it('shows all four hands, the note and the review once the auction is over', async () => {
    const view = await started(2)
    const over = await bidOut(view.id)
    const board = over.sessionBoards[0]
    expect(board.over).toBe(true)
    for (const seat of SEATS) expect(board.hands[seat]).toHaveLength(13)
    // The next board is still secret
    expect(over.sessionBoards[1].over).toBe(false)
    expect(Object.keys(over.sessionBoards[1].hands)).toHaveLength(1)
  })

  it('an abandoned or expired session never opens the board being bid', async () => {
    const view = await started(1)
    const amyCards = club.partnerBids.get(amy, view.id).sessionBoards[0].hands.S!
    const ended = await club.partnerBids.abandon(ben, view.id)
    expect(ended.status).toBe('abandoned')
    expect(ownOnly(ended, 'N')).toBe(true)
    expect(leaksAny(JSON.stringify(ended), amyCards)).toEqual([])
    expect(ended.sessionBoards[0].legalCalls).toEqual([])

    const idle = await started(1)
    await sweep(PARTNER_BID_IDLE_MS + 1)
    const expired = club.partnerBids.get(amy, idle.id)
    expect(expired.status).toBe('expired')
    expect(ownOnly(expired, 'S')).toBe(true)
  })

  it('the account export has only what the member may see', async () => {
    const view = await started(1)
    const benCards = club.partnerBids.get(ben, view.id).sessionBoards[0].hands.N!
    const data = await club.exportAccount(amy, null)
    expect(data.partnerBidding).toHaveLength(1)
    expect(data.partnerBidding[0].id).toBe(view.id)
    expect(leaksAny(JSON.stringify(data.partnerBidding), benCards)).toEqual([])
    expect(data.partnerBidding[0].sessionBoards[0].hands.S).toHaveLength(13)
  })
})

describe('bidding (hard rule 1)', () => {
  it('gives legal calls to the one whose turn it is, from the server, and checks every call', async () => {
    const view = await started(1)
    const id = view.id
    expect(club.partnerBids.get(amy, id).sessionBoards[0].legalCalls).toEqual([])
    const ben1 = club.partnerBids.get(ben, id).sessionBoards[0]
    expect(ben1.legalCalls).toContain('P')
    expect(ben1.legalCalls).toContain('1C')
    await expect(call(amy, id, '1C')).rejects.toMatchObject({ code: 'notYourCall' })
    await expect(call(ben, id, 'X')).rejects.toMatchObject({ code: 'illegalCall' })
    await expect(call(ben, id, 'banana')).rejects.toMatchObject({ code: 'unknownCommand' })
    await call(ben, id, '1N')
    // East passed by itself
    const after = club.partnerBids.get(amy, id).sessionBoards[0]
    expect(after.auction.map((c) => `${c.seat}${c.call}`)).toEqual(['N1N', 'EP'])
    expect(after.turn).toBe('S')
    expect(after.legalCalls).not.toContain('1C')
    expect(after.legalCalls).toContain('2C')
    await expect(call(amy, id, '1C')).rejects.toMatchObject({ code: 'illegalCall' })
  })

  it('tells the other member when it is their turn, and not while they are at it', async () => {
    connections.online.add(amy)
    connections.online.add(ben)
    const { id } = await started(1)
    const turns = async (who: string) => (await bells(who)).filter((k) => k === 'partnerBidTurn').length
    await call(ben, id, '1C')
    expect(await turns(amy)).toBe(1)
    await call(amy, id, '1H')
    // Ben called moments ago and is online: the page shows it, no bell
    expect(await turns(ben)).toBe(0)
    time += PARTNER_BID_QUIET_MS + 1
    await call(ben, id, '1S')
    time += PARTNER_BID_QUIET_MS + 1
    await call(amy, id, '2C')
    expect(await turns(ben)).toBe(1)
  })

  it('goes through several deals, one dealt at a time, then tells the partner it is done', async () => {
    const { id } = await started(2)
    expect(club.partnerBids.get(amy, id).sessionBoards).toHaveLength(1)
    let view = await bidOut(id)
    expect(view.done).toBe(1)
    expect(view.sessionBoards).toHaveLength(2)
    expect(view.status).toBe('active')
    view = await bidOut(id)
    expect(view.status).toBe('finished')
    expect(view.done).toBe(2)
    await expect(call(amy, id, 'P')).rejects.toMatchObject({ code: 'partnerBidOver' })
    const told = [...(await bells(amy)), ...(await bells(ben))]
    expect(told).toContain('partnerBidFinished')
  })

  it('takes a board passed out', async () => {
    const { id } = await started(1)
    await call(ben, id, 'P')
    await call(amy, id, 'P')
    const view = club.partnerBids.get(amy, id)
    expect(view.status).toBe('finished')
    expect(view.sessionBoards[0].contract).toBeNull()
    for (const seat of SEATS) expect(view.sessionBoards[0].hands[seat]).toHaveLength(13)
  })

  it('resumes after the object is evicted: everything is in the store', async () => {
    const { id } = await started(2)
    await call(ben, id, '1C')
    const amyHand = club.partnerBids.get(amy, id).sessionBoards[0].hands.S
    club = await make()
    await club.load()
    const view = club.partnerBids.get(amy, id)
    expect(view.sessionBoards[0].hands.S).toEqual(amyHand)
    expect(view.sessionBoards[0].turn).toBe('S')
    await call(amy, id, '1H')
    expect(club.partnerBids.get(ben, id).sessionBoards[0].auction.length).toBe(4)
  })
})

describe('the review', () => {
  it('compares with TKB in jobs of their own, asking the brain one hand at a time', async () => {
    const seen: Seat[][] = []
    const spy: RobotBrain = {
      ...ruleBrain,
      bid: (kind, state, seat) => {
        seen.push(SEATS.filter((s) => state.hands[s].length > 0))
        return ruleBrain.bid(kind, state, seat)
      },
    }
    club = await make(spy)
    await club.load()
    const { id } = await started(1)
    await call(ben, id, '1N')
    await call(amy, id, 'P')
    expect(queue.filter((job) => job.kind === 'robot').length).toBeGreaterThan(0)
    // Nothing worked out in the request of the last call
    expect(seen).toEqual([])
    expect(club.partnerBids.get(amy, id).sessionBoards[0].review?.steps).toBeUndefined()

    await runRobots()
    const board = club.partnerBids.get(ben, id).sessionBoards[0]
    const review = board.review!
    expect(review.steps).toHaveLength(board.auction.length)
    expect(review.robot).toBeDefined()
    // Each question gives one hand (hard rule 6), and East and West are never asked
    expect(seen.length).toBeGreaterThan(0)
    for (const hands of seen) expect(hands).toHaveLength(1)
    expect(seen.flat().filter((s) => s === 'E' || s === 'W')).toEqual([])
    expect(review.steps!.filter((_, i) => board.auction[i].seat === 'E' || board.auction[i].seat === 'W').every((s) => s.call === 'P')).toBe(true)
    expect(review.robot!.auction.filter((c) => c.seat === 'E' || c.seat === 'W').every((c) => c.call === 'P')).toBe(true)
    // Both members read the same review
    expect(club.partnerBids.get(amy, id).sessionBoards[0].review).toEqual(review)
  })

  it('works a lost review out again when the board is next read', async () => {
    const { id } = await started(1)
    await call(ben, id, 'P')
    await call(amy, id, 'P')
    // Evicted before the job ran
    queue = []
    club = await make()
    await club.load()
    expect(club.partnerBids.get(amy, id).sessionBoards[0].review).toBeUndefined()
    await runRobots()
    expect(club.partnerBids.get(amy, id).sessionBoards[0].review?.robot).toBeDefined()
  })
})

describe('ending', () => {
  it('abandoning tells the other member; the inviter can take an invitation back', async () => {
    const invited = await club.partnerBids.create(amy, { partnerId: ben })
    const back = await club.partnerBids.abandon(amy, invited.id)
    expect(back.status).toBe('abandoned')
    expect(await bells(ben)).toContain('partnerBidAbandoned')
    await expect(club.partnerBids.abandon(amy, invited.id)).rejects.toMatchObject({ code: 'partnerBidOver' })
    // The invited partner abandoning it declines it
    const again = await club.partnerBids.create(amy, { partnerId: ben })
    expect((await club.partnerBids.abandon(ben, again.id)).status).toBe('declined')
  })

  it('an unanswered invitation and an idle session expire through the scheduler, and go after a while', async () => {
    const invited = await club.partnerBids.create(amy, { partnerId: ben })
    await sweep(PARTNER_BID_INVITE_MS + 1)
    expect(club.partnerBids.get(amy, invited.id).status).toBe('expired')
    expect(await bells(amy)).toContain('partnerBidExpired')
    expect(await bells(ben)).not.toContain('partnerBidExpired')

    const idle = await started(1)
    await sweep(PARTNER_BID_IDLE_MS + 1)
    expect(club.partnerBids.get(ben, idle.id).status).toBe('expired')
    expect(await bells(ben)).toContain('partnerBidExpired')

    await sweep(PARTNER_BID_KEEP_MS + 1)
    expect(club.partnerBids.list(amy)).toEqual([])
    expect(() => club.partnerBids.get(amy, idle.id)).toThrow()
    expect(store.sql.exec('SELECT * FROM partner_bid_boards')).toEqual([])
    // Nothing left to wait for
    expect(queue.filter((job) => job.kind === 'partnerBid')).toEqual([])
  })

  it('a new invitation expires on time when only an ended session was waiting, far later', async () => {
    const ended = await club.partnerBids.create(amy, { partnerId: ben })
    await club.partnerBids.abandon(amy, ended.id)
    await sweep(PARTNER_BID_INVITE_MS + 1)
    expect(queue.filter((job) => job.kind === 'partnerBid').map((job) => job.ms)).toEqual([PARTNER_BID_KEEP_MS - PARTNER_BID_INVITE_MS - 1])
    await club.partnerBids.create(amy, { partnerId: cat })
    expect(queue.filter((job) => job.kind === 'partnerBid').map((job) => job.ms)).toContain(PARTNER_BID_INVITE_MS)
  })

  it('a session being bid does not pile up sweep jobs', async () => {
    const { id } = await started(1)
    const before = queue.filter((job) => job.kind === 'partnerBid').length
    await call(ben, id, '1C')
    await call(amy, id, '1H')
    await call(ben, id, '1S')
    expect(queue.filter((job) => job.kind === 'partnerBid').length).toBe(before)
  })

  it('a call moves the expiry on, so an active session is not swept', async () => {
    const { id } = await started(1)
    time += PARTNER_BID_IDLE_MS - 1000
    await call(ben, id, '1C')
    await sweep(2000)
    expect(club.partnerBids.get(amy, id).status).toBe('active')
    await sweep(PARTNER_BID_IDLE_MS)
    expect(club.partnerBids.get(amy, id).status).toBe('expired')
  })

  it('the sweep is armed again after an eviction', async () => {
    const invited = await club.partnerBids.create(amy, { partnerId: ben })
    queue = []
    club = await make()
    await club.load()
    expect(queue.filter((job) => job.kind === 'partnerBid')).toHaveLength(1)
    await sweep(PARTNER_BID_INVITE_MS + 1)
    expect(club.partnerBids.get(amy, invited.id).status).toBe('expired')
  })

  it('keeps only so many ended sessions', async () => {
    let first = ''
    for (let i = 0; i < PARTNER_BID_KEPT + 2; i++) {
      time += 1000
      const view = await club.partnerBids.create(amy, { partnerId: ben })
      first ||= view.id
      await club.partnerBids.abandon(amy, view.id)
    }
    expect(club.partnerBids.list(amy)).toHaveLength(PARTNER_BID_KEPT)
    expect(() => club.partnerBids.get(amy, first)).toThrow()
  })

  it("an account's deletion takes its sessions, the other member's copy too", async () => {
    connections.online.add(ben)
    const { id } = await started(1)
    await club.adminDeleteUser('boss-id', amy)
    expect(club.partnerBids.list(ben)).toEqual([])
    expect(store.sql.exec('SELECT * FROM partner_bid_sessions')).toEqual([])
    expect(store.sql.exec('SELECT * FROM partner_bid_boards')).toEqual([])
    expect(connections.inbox.get(ben)?.findLast((m) => m.type === 'partnerBid')).toEqual({ type: 'partnerBid', id, session: null })
  })
})

describe('outside everything else', () => {
  it('leaves no record, no ranking, no table', async () => {
    const { id } = await started(1)
    await bidOut(id)
    await runRobots()
    expect((await club.history(amy, false, 1, 20)).total).toBe(0)
    expect((await club.history(ben, false, 1, 20)).total).toBe(0)
    expect([...store.data.keys()].filter((k) => k.startsWith('board:') || k.startsWith('hist:') || k.startsWith('uhist:') || k.startsWith('table'))).toEqual([])
    const data = await club.exportAccount(amy, null)
    expect(data.boards).toEqual([])
    expect(data.points).toEqual([])
  })
})
