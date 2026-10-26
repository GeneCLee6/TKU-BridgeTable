// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { CHALLENGE_LIMITS, parseChallengeSettings, type ChallengeView } from '../../shared/challenge.ts'
import type { ClientMessage, ServerMessage } from '../../shared/protocol.ts'
import { answer, cancel, deadlineOutcome, newChallenge } from '../../worker/challenge-flow.ts'
import { makeDealSet } from '../../shared/deal-set.ts'
import { defaultChallengeSettings } from '../../shared/challenge.ts'
import { ClubService, type Connections } from '../../worker/service.ts'
import type { MemoryStore } from '../../worker/store.ts'
import { memoryStore } from './sqlite.ts'

/** Challenges through the server: create, answer, cancel, notifications and what members see (C3) */

const DAY = 86_400_000

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
}

let store: MemoryStore
let connections: FakeConnections
let club: ClubService
let time: number

const makeClub = () =>
  new ClubService(store, connections, { maxUsers: 40, now: () => time, schedule: () => {} })

beforeEach(async () => {
  store = memoryStore()
  connections = new FakeConnections()
  time = 1_000_000
  club = makeClub()
  await club.load()
  // The first account is the admin and hears of every registration; keep that out of the bells
  await club.register('boss', 'secret1', '')
})

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

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
const error = (userId: string) => connections.last(userId, 'error')
const bell = (userId: string) => connections.last(userId, 'notifications')?.notifications

/** Sends a message that should be turned down, and returns the code it was turned down with */
async function refused(userId: string, message: ClientMessage) {
  connections.inbox.set(userId, [])
  await send(userId, message)
  return error(userId)?.code
}

/** Members with the first following all the others */
async function friends(...names: string[]) {
  const ids = []
  for (const name of names) ids.push(await member(name))
  for (const id of ids.slice(1)) await send(ids[0], { type: 'setFriend', userId: id, friend: true })
  return ids
}

async function create(creator: string, invitees: string[], extra: Partial<Extract<ClientMessage, { type: 'createChallenge' }>> = {}) {
  connections.inbox.set(creator, [])
  // A tick apart, so the newest is first in the list
  time += 1
  await send(creator, { type: 'createChallenge', invitees, ...extra })
  expect(error(creator)).toBeUndefined()
  return club.challengeList(creator)[0]
}

const view = (id: string, userId: string) => club.challengeFor(id, userId)
const statusOf = (c: ChallengeView, userId: string) => c.players.find((p) => p.userId === userId)?.status

describe('creating a challenge (e7-t05)', () => {
  it('invites friends with the defaults: pending, the creator accepted, random boards kept on the server', async () => {
    const [amy, ben] = await friends('amy', 'ben')
    const c = await create(amy, [ben])
    expect(c).toMatchObject({ creatorId: amy, status: 'pending', boards: 8, createdAt: time, deadline: time + 3 * DAY })
    expect(c.settings).toEqual(defaultChallengeSettings(1))
    expect(c.players.map((p) => [p.user?.username, p.status, p.played])).toEqual([
      ['amy', 'accepted', 0],
      ['ben', 'invited', 0],
    ])
    expect(JSON.stringify(c)).not.toContain('hands')
    const stored = club.challenges.get(c.id)!
    expect(stored.deals.boards.map((b) => b.boardNo)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('takes the boards and the settings the creator chose', async () => {
    const [amy, ben, cat] = await friends('amy', 'ben', 'cat')
    // TKB in the club's system is only for members given `tkuSystem` (ROBOT.md §7)
    const settings = { scoring: 'crossImp', robotKind: 'tku', bestHand: true, justDeclare: true, days: 7, ranking: 'club' } as const
    await send(amy, { type: 'createChallenge', invitees: [ben, cat], boards: 12, settings })
    expect(error(amy)?.code).toBe('tkuSystemOnly')
    expect(club.challengeList(amy)).toEqual([])
    await club.adminSetPermissions(amy, ['tkuSystem'])
    const c = await create(amy, [ben, cat], {
      boards: 12,
      settings: { scoring: 'crossImp', robotKind: 'tku', bestHand: true, justDeclare: true, days: 7, ranking: 'club' },
    })
    expect(c.boards).toBe(12)
    expect(c.deadline).toBe(time + 7 * DAY)
    expect(c.settings).toEqual({
      scoring: 'crossImp',
      robotKind: 'tku',
      bestHand: true,
      justDeclare: true,
      days: 7,
      ranking: 'club',
    })
  })

  it('defaults to matchpoints with more than one invitee', async () => {
    const [amy, ben, cat] = await friends('amy', 'ben', 'cat')
    expect((await create(amy, [ben, cat])).settings.scoring).toBe('mp')
  })

  it('invites only friends: not someone the creator does not follow, nor oneself, nor nobody', async () => {
    const [amy, ben] = await friends('amy', 'ben')
    const zoe = await member('zoe')
    expect(await refused(amy, { type: 'createChallenge', invitees: [zoe] })).toBe('notFriend')
    expect(error(amy)?.params).toEqual({ name: 'zoe' })
    // Following is one-way: zoe following amy does not make zoe amy's friend
    await send(zoe, { type: 'setFriend', userId: amy, friend: true })
    expect(await refused(amy, { type: 'createChallenge', invitees: [ben, zoe] })).toBe('notFriend')
    expect(await refused(amy, { type: 'createChallenge', invitees: [amy] })).toBe('notSelf')
    expect(await refused(amy, { type: 'createChallenge', invitees: ['nobody'] })).toBe('userGone')
    expect(await refused(amy, { type: 'createChallenge', invitees: ['tku:N'] })).toBe('userGone')
    expect(club.challengeList(amy)).toEqual([])
    expect(bell(ben)?.items).toEqual([])
  })

  it('never invites someone blocked, either way, without telling the creator they were blocked', async () => {
    const [amy, ben, cat] = await friends('amy', 'ben', 'cat')
    // Amy blocks Ben: that also stops her following him
    await send(amy, { type: 'setBlocked', userId: ben, blocked: true })
    expect(await refused(amy, { type: 'createChallenge', invitees: [ben] })).toBe('notFriend')
    // Cat blocks Amy, who still follows her
    await send(cat, { type: 'setBlocked', userId: amy, blocked: true })
    expect(await refused(amy, { type: 'createChallenge', invitees: [cat] })).toBe('cannotInvite')
    expect(error(amy)?.params).toEqual({ name: 'cat' })
    expect(bell(cat)?.items).toEqual([])
  })

  it('invites 1 to 20 different members', async () => {
    const names = Array.from({ length: 22 }, (_, i) => `p${String(i).padStart(2, '0')}`)
    const [amy, ...others] = await friends(...names)
    const { invitedMin, invitedMax } = CHALLENGE_LIMITS
    expect(await refused(amy, { type: 'createChallenge', invitees: [] })).toBe('challengeInvitees')
    expect(error(amy)?.params).toEqual({ min: invitedMin, max: invitedMax })
    expect(await refused(amy, { type: 'createChallenge', invitees: others })).toBe('challengeInvitees')
    expect(await refused(amy, { type: 'createChallenge', invitees: [others[0], others[0]] })).toBe('badChallengeSettings')
    expect(await refused(amy, { type: 'createChallenge', invitees: 'all' as never })).toBe('badChallengeSettings')
    const c = await create(amy, others.slice(0, 20))
    expect(c.players).toHaveLength(21)
  })

  it('deals 1 to 16 boards', async () => {
    const [amy, ben] = await friends('amy', 'ben')
    for (const boards of [0, -1, 17, 8.5, '8' as never]) {
      expect(await refused(amy, { type: 'createChallenge', invitees: [ben], boards })).toBe('challengeBoards')
    }
    expect(error(amy)?.params).toEqual({ min: 1, max: 16 })
    expect((await create(amy, [ben], { boards: 1 })).boards).toBe(1)
    expect((await create(amy, [ben], { boards: 4 })).boards).toBe(4)
    expect((await create(amy, [ben], { boards: 16 })).boards).toBe(16)
  })

  it('turns down settings that are not allowed', async () => {
    const [amy, ben, cat] = await friends('amy', 'ben', 'cat')
    const bad = async (settings: object, invitees = [ben]) => {
      expect(await refused(amy, { type: 'createChallenge', invitees, settings: settings as never })).toBe('badChallengeSettings')
      return error(amy)?.params.field
    }
    expect(await bad({ scoring: 'mp' })).toBe('scoring')
    expect(await bad({ scoring: 'crossImp' })).toBe('scoring')
    expect(await bad({ scoring: 'imp' }, [ben, cat])).toBe('scoring')
    // Unplayed boards are not scored at all: only those who play every board are ranked
    expect(await bad({ unfinished: 'worst' })).toBe('unfinished')
    expect(await bad({ robotKind: 'deep' })).toBe('robotKind')
    // The robot is TKB, with no levels (社長, 2026-10-24): a level is an unknown field
    expect(await bad({ robotLevel: 'college' })).toBe('robotLevel')
    expect(await bad({ bestHand: 'yes' })).toBe('bestHand')
    expect(await bad({ justDeclare: 1 })).toBe('justDeclare')
    expect(await bad({ days: 0 })).toBe('days')
    expect(await bad({ days: 8 })).toBe('days')
    expect(await bad({ days: 1.5 })).toBe('days')
    expect(await bad({ ranking: 'world' })).toBe('ranking')
    expect(await bad({ preset: 'slam' })).toBe('preset')
    expect(await bad([])).toBe('settings')
    expect(club.challengeList(amy)).toEqual([])
  })

  it('tells each invitee', async () => {
    const [amy, ben, cat] = await friends('amy', 'ben', 'cat')
    const c = await create(amy, [ben, cat])
    await tick()
    for (const id of [ben, cat])
      expect(bell(id)?.items[0]).toMatchObject({ kind: 'challengeInvited', params: { challengeId: c.id, username: 'amy' } })
    expect(bell(amy)?.items ?? []).toEqual([])
  })
})

describe('answering and cancelling (e7-t06)', () => {
  it('becomes active when someone besides the creator accepts; others may still accept', async () => {
    const [amy, ben, cat] = await friends('amy', 'ben', 'cat')
    const c = await create(amy, [ben, cat])
    time += 1000
    await send(ben, { type: 'answerChallenge', challengeId: c.id, accept: true })
    let now = view(c.id, amy)!
    expect(now).toMatchObject({ status: 'active', startedAt: time })
    expect(now.players[1]).toMatchObject({ status: 'accepted', answeredAt: time })
    time += 1000
    await send(cat, { type: 'answerChallenge', challengeId: c.id, accept: true })
    now = view(c.id, amy)!
    expect(now.startedAt).toBe(time - 1000)
    expect(statusOf(now, cat)).toBe('accepted')
  })

  it('stays pending when someone declines, and expires once everyone has declined', async () => {
    const [amy, ben, cat] = await friends('amy', 'ben', 'cat')
    const c = await create(amy, [ben, cat])
    await send(ben, { type: 'answerChallenge', challengeId: c.id, accept: false })
    expect(view(c.id, amy)).toMatchObject({ status: 'pending' })
    await send(cat, { type: 'answerChallenge', challengeId: c.id, accept: false })
    expect(view(c.id, amy)).toMatchObject({ status: 'expired', endedAt: time })
  })

  it('answers only once, only by an invitee, only before the deadline', async () => {
    const [amy, ben, cat, dan] = await friends('amy', 'ben', 'cat', 'dan')
    const c = await create(amy, [ben, cat])
    await send(ben, { type: 'answerChallenge', challengeId: c.id, accept: true })
    expect(await refused(ben, { type: 'answerChallenge', challengeId: c.id, accept: false })).toBe('alreadyAnswered')
    expect(await refused(amy, { type: 'answerChallenge', challengeId: c.id, accept: false })).toBe('alreadyAnswered')
    expect(await refused(dan, { type: 'answerChallenge', challengeId: c.id, accept: true })).toBe('challengeGone')
    expect(await refused(ben, { type: 'answerChallenge', challengeId: 'nope', accept: true })).toBe('challengeGone')
    expect(await refused(cat, { type: 'answerChallenge', challengeId: c.id, accept: 'yes' as never })).toBe('unknownCommand')
    time = c.deadline
    expect(await refused(cat, { type: 'answerChallenge', challengeId: c.id, accept: true })).toBe('challengeClosed')
    expect(statusOf(view(c.id, amy)!, cat)).toBe('invited')
  })

  it('takes no answers once the challenge is cancelled', async () => {
    const [amy, ben] = await friends('amy', 'ben')
    const c = await create(amy, [ben])
    await send(amy, { type: 'cancelChallenge', challengeId: c.id })
    expect(await refused(ben, { type: 'answerChallenge', challengeId: c.id, accept: true })).toBe('challengeClosed')
  })

  it('tells the creator who accepted and who declined', async () => {
    const [amy, ben, cat] = await friends('amy', 'ben', 'cat')
    const c = await create(amy, [ben, cat])
    await send(ben, { type: 'answerChallenge', challengeId: c.id, accept: true })
    await send(cat, { type: 'answerChallenge', challengeId: c.id, accept: false })
    await tick()
    expect(bell(amy)?.items.map((n) => [n.kind, n.params.username, n.params.challengeId])).toEqual([
      ['challengeDeclined', 'cat', c.id],
      ['challengeAccepted', 'ben', c.id],
    ])
    expect(bell(ben)?.items.map((n) => n.kind)).toEqual(['challengeInvited'])
  })

  it('lets the creator cancel, pending or active, while nobody else has started; the others are told', async () => {
    const [amy, ben, cat, dan] = await friends('amy', 'ben', 'cat', 'dan')
    const c = await create(amy, [ben, cat, dan])
    await send(ben, { type: 'answerChallenge', challengeId: c.id, accept: true })
    await send(dan, { type: 'answerChallenge', challengeId: c.id, accept: false })
    // The creator has started: that does not stop them cancelling
    const stored = club.challenges.get(c.id)!
    club.challenges.updatePlayer(c.id, { ...stored.players[0], startedAt: time })
    time += 5000
    await send(amy, { type: 'cancelChallenge', challengeId: c.id })
    expect(view(c.id, amy)).toMatchObject({ status: 'cancelled', endedAt: time })
    await tick()
    for (const id of [ben, cat])
      expect(bell(id)?.items[0]).toMatchObject({ kind: 'challengeCancelled', params: { challengeId: c.id, username: 'amy' } })
    expect(bell(dan)?.items.map((n) => n.kind)).toEqual(['challengeInvited'])
    expect(await refused(amy, { type: 'cancelChallenge', challengeId: c.id })).toBe('challengeClosed')
  })

  it('cannot be cancelled once someone else started, nor by anyone but the creator', async () => {
    const [amy, ben, cat] = await friends('amy', 'ben', 'cat')
    const c = await create(amy, [ben])
    expect(await refused(ben, { type: 'cancelChallenge', challengeId: c.id })).toBe('challengeCreatorOnly')
    expect(await refused(cat, { type: 'cancelChallenge', challengeId: c.id })).toBe('challengeGone')
    await send(ben, { type: 'answerChallenge', challengeId: c.id, accept: true })
    const stored = club.challenges.get(c.id)!
    club.challenges.updatePlayer(c.id, { ...stored.players[1], startedAt: time })
    expect(await refused(amy, { type: 'cancelChallenge', challengeId: c.id })).toBe('challengeStarted')
    expect(view(c.id, amy)?.status).toBe('active')
  })
})

describe('reading challenges', () => {
  it('shows a challenge only to its participants, with progress but no one else’s results or deals', async () => {
    const [amy, ben, cat] = await friends('amy', 'ben', 'cat')
    const zoe = await member('zoe')
    const c = await create(amy, [ben, cat])
    await send(ben, { type: 'answerChallenge', challengeId: c.id, accept: true })
    await send(cat, { type: 'answerChallenge', challengeId: c.id, accept: false })
    club.challenges.addResult(c.id, { userId: amy, seq: 1, boardId: 'secretBoardOne', scoreNS: 4321, playedAt: time })
    club.challenges.addResult(c.id, { userId: amy, seq: 2, boardId: 'secretBoardTwo', scoreNS: -50, playedAt: time })
    for (const id of [amy, ben, cat]) {
      const seen = view(c.id, id)!
      expect(seen.players.map((p) => p.played)).toEqual([2, 0, 0])
      expect(seen.standings).toBeUndefined()
      expect(club.challengeList(id).map((x) => x.id)).toEqual([c.id])
      const json = JSON.stringify(seen)
      for (const hidden of ['4321', 'secretBoard', 'hands', 'scoreNS', 'results']) expect(json).not.toContain(hidden)
    }
    // amy has not played every board yet: no travellers, not even for the boards she played
    expect(view(c.id, amy)!.travellers).toBeUndefined()
    expect(view(c.id, zoe)).toBeNull()
    expect(club.challengeList(zoe)).toEqual([])
    expect(view('nope', amy)).toBeNull()
  })

  it('lists a member’s challenges newest first', async () => {
    const [amy, ben, cat] = await friends('amy', 'ben', 'cat')
    const first = await create(amy, [ben])
    time += 1000
    const second = await create(amy, [ben, cat])
    expect(club.challengeList(amy).map((c) => c.id)).toEqual([second.id, first.id])
    expect(club.challengeList(cat).map((c) => c.id)).toEqual([second.id])
  })

  it('keeps everything after the object is evicted and loaded again', async () => {
    const [amy, ben, cat] = await friends('amy', 'ben', 'cat')
    const c = await create(amy, [ben, cat], { boards: 5, settings: { days: 2 } })
    await send(ben, { type: 'answerChallenge', challengeId: c.id, accept: true })
    const before = view(c.id, amy)
    club = makeClub()
    await club.load()
    expect(view(c.id, amy)).toEqual(before)
    await send(cat, { type: 'answerChallenge', challengeId: c.id, accept: false })
    expect(statusOf(view(c.id, amy)!, cat)).toBe('declined')
  })
})

describe('challenge requests over HTTP (e7-t16, e7-t17)', () => {
  it('creates, answers and cancels with the socket’s checks, and hands back the challenge as the member sees it', async () => {
    const [amy, ben, cat] = await friends('amy', 'ben', 'cat')
    time += 1
    const made = await club.challengeRequest(amy, {
      type: 'createChallenge',
      invitees: [ben, cat],
      boards: 6,
      settings: { scoring: 'crossImp', days: 5 },
    })
    expect(made).toMatchObject({ creatorId: amy, status: 'pending', boards: 6, deadline: time + 5 * DAY })
    expect(made!.settings.scoring).toBe('crossImp')
    expect(bell(ben)?.items[0]).toMatchObject({ kind: 'challengeInvited', params: { challengeId: made!.id } })

    const answered = await club.challengeRequest(ben, { type: 'answerChallenge', challengeId: made!.id, accept: true })
    expect(answered?.status).toBe('active')
    expect(statusOf(answered!, ben)).toBe('accepted')

    // Errors are thrown with the same codes the socket sends
    await expect(
      club.challengeRequest(ben, { type: 'cancelChallenge', challengeId: made!.id }),
    ).rejects.toMatchObject({ code: 'challengeCreatorOnly' })
    await expect(
      club.challengeRequest(amy, { type: 'createChallenge', invitees: [await member('zoe')] }),
    ).rejects.toMatchObject({ code: 'notFriend' })
    await expect(
      club.challengeRequest(cat, { type: 'answerChallenge', challengeId: made!.id, accept: 'yes' as unknown as boolean }),
    ).rejects.toMatchObject({ code: 'badMessage' })

    const cancelled = await club.challengeRequest(amy, { type: 'cancelChallenge', challengeId: made!.id })
    expect(cancelled?.status).toBe('cancelled')
  })
})

describe('challenge-flow', () => {
  const deals = makeDealSet({ kind: 'random', count: 4 })!
  const fresh = (invitees = ['b', 'c']) =>
    newChallenge({ id: 'x', creatorId: 'a', invitees, settings: defaultChallengeSettings(invitees.length), deals, now: 0 })

  it('at the deadline, whoever has not answered declined; expired without anyone but the creator, else finished', () => {
    const c = fresh()
    expect(deadlineOutcome(c, c.deadline)).toEqual({
      players: [
        { userId: 'b', status: 'declined', invitedAt: 0, answeredAt: c.deadline, knownDeals: false },
        { userId: 'c', status: 'declined', invitedAt: 0, answeredAt: c.deadline, knownDeals: false },
      ],
      status: 'expired',
    })
    const step = answer(c, 'b', true, 10)
    if ('error' in step) throw new Error(step.error)
    const active = { ...c, status: step.status!, players: c.players.map((p) => step.players.find((q) => q.userId === p.userId) ?? p) }
    expect(deadlineOutcome(active, c.deadline)).toMatchObject({ status: 'finished', players: [{ userId: 'c', status: 'declined' }] })
    expect(deadlineOutcome({ ...c, status: 'cancelled' }, c.deadline)).toBeNull()
  })

  it('cancels only open challenges', () => {
    expect(cancel({ ...fresh(), status: 'expired' }, 'a')).toEqual({ error: 'challengeClosed' })
    expect(cancel(fresh(), 'a')).toEqual({ players: [], status: 'cancelled' })
  })

  it('parses settings for the number invited', () => {
    expect(parseChallengeSettings(undefined, 3)).toEqual({ settings: defaultChallengeSettings(3) })
    expect(parseChallengeSettings({ scoring: 'total' }, 1)).toMatchObject({ settings: { scoring: 'total' } })
    expect(parseChallengeSettings({ scoring: 'total' }, 5)).toMatchObject({ settings: { scoring: 'total' } })
  })
})
