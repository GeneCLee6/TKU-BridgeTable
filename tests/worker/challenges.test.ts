// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { challengeDeadline, defaultChallengeSettings } from '../../shared/challenge.ts'
import { makeDealSet } from '../../shared/deal-set.ts'
import type { ServerMessage } from '../../shared/protocol.ts'
import { ChallengeStore, type Challenge } from '../../worker/challenges.ts'
import { ClubService, type Connections } from '../../worker/service.ts'
import type { MemoryStore } from '../../worker/store.ts'
import { memoryStore, memorySql } from './sqlite.ts'
import { clubService } from './event-mode.ts'

const T0 = 1_000_000
const DAY = 86_400_000

/** A challenge between `creator` and `invited`, just created: the creator has accepted */
function challenge(id: string, creator: string, invited: string[], at = T0): Challenge {
  const settings = defaultChallengeSettings(invited.length)
  return {
    id,
    creatorId: creator,
    createdAt: at,
    status: 'pending',
    deadline: challengeDeadline(at, settings),
    settings,
    deals: makeDealSet({ kind: 'random', count: 4 })!,
    players: [
      { userId: creator, status: 'accepted', invitedAt: at, answeredAt: at, knownDeals: false },
      ...invited.map((userId) => ({ userId, status: 'invited' as const, invitedAt: at, knownDeals: false })),
    ],
    results: [],
  }
}

const fresh = () => {
  const store = new ChallengeStore(memorySql())
  store.createTables()
  return store
}

describe('challenge store', () => {
  it('reads a challenge back as it was written, deals and all', () => {
    const store = fresh()
    const c = challenge('c1', 'amy', ['ben', 'cat'])
    store.create(c)
    expect(store.get('c1')).toEqual(c)
    expect(store.get('nope')).toBeNull()
    expect(c.deadline).toBe(T0 + 3 * DAY)
    expect(c.settings.scoring).toBe('mp')
  })

  it('keeps answers, starts and results, and refuses a board played twice', () => {
    const store = fresh()
    store.create(challenge('c1', 'amy', ['ben']))
    store.updatePlayer('c1', { userId: 'ben', status: 'accepted', invitedAt: T0, answeredAt: T0 + 5, knownDeals: false })
    store.setStatus('c1', 'active', T0 + 5)
    store.setStatus('c1', 'active', T0 + 9)
    store.addResult('c1', { userId: 'ben', seq: 2, boardId: 'b2', scoreNS: -100, playedAt: T0 + 30 })
    store.addResult('c1', { userId: 'amy', seq: 1, boardId: 'a1', scoreNS: 420, playedAt: T0 + 20 })
    store.addResult('c1', { userId: 'ben', seq: 1, boardId: 'b1', scoreNS: 450, playedAt: T0 + 10 })
    expect(() =>
      store.addResult('c1', { userId: 'ben', seq: 1, boardId: 'b9', scoreNS: 0, playedAt: T0 + 40 }),
    ).toThrow()

    const c = store.get('c1')!
    expect(c.status).toBe('active')
    // The first time it became active
    expect(c.startedAt).toBe(T0 + 5)
    expect(c.players[1]).toMatchObject({ userId: 'ben', status: 'accepted', answeredAt: T0 + 5 })
    // Creator first, then board order
    expect(c.results.map((r) => r.boardId)).toEqual(['a1', 'b1', 'b2'])

    store.setStatus('c1', 'finished', T0 + 99)
    expect(store.get('c1')).toMatchObject({ status: 'finished', endedAt: T0 + 99 })
  })

  it('lists a member’s challenges newest first, and the open ones', () => {
    const store = fresh()
    store.create(challenge('old', 'amy', ['ben'], T0))
    store.create(challenge('new', 'ben', ['amy', 'cat'], T0 + 1000))
    store.create(challenge('gone', 'cat', ['dan'], T0 + 2000))
    store.setStatus('gone', 'cancelled', T0 + 2001)
    expect(store.idsOf('amy')).toEqual(['new', 'old'])
    expect(store.idsOf('dan')).toEqual(['gone'])
    expect(store.idsOf('eve')).toEqual([])
    expect(store.openIds()).toEqual(['old', 'new'])
  })

  it('creates its tables idempotently and keeps what is there', () => {
    const sql = memorySql()
    const store = new ChallengeStore(sql)
    store.createTables()
    store.create(challenge('c1', 'amy', ['ben']))
    new ChallengeStore(sql).createTables()
    expect(new ChallengeStore(sql).get('c1')?.players).toHaveLength(2)
  })

  it('adds the reminder column to a table made before it, and keeps when the reminder went out', () => {
    const sql = memorySql()
    // The table as C2 made it, without `reminded_at`
    sql.exec(`CREATE TABLE challenges (challenge_id TEXT PRIMARY KEY, creator_id TEXT NOT NULL, created_at INTEGER NOT NULL,
      status TEXT NOT NULL, accept_by INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER, settings TEXT NOT NULL,
      deals TEXT NOT NULL)`)
    const store = new ChallengeStore(sql)
    store.createTables()
    store.create(challenge('c1', 'amy', ['ben']))
    expect(store.get('c1')!.remindedAt).toBeUndefined()
    store.setReminded('c1', T0 + DAY)
    store.createTables()
    expect(store.get('c1')!.remindedAt).toBe(T0 + DAY)
  })

  it('takes a deleted account out of open challenges and cancels those left with one player', () => {
    const store = fresh()
    store.create(challenge('duel', 'amy', ['ben']))
    store.create(challenge('group', 'amy', ['ben', 'cat']))
    store.create(challenge('declined', 'cat', ['ben', 'dan']))
    store.updatePlayer('declined', { userId: 'dan', status: 'declined', invitedAt: T0, answeredAt: T0, knownDeals: false })
    store.create(challenge('done', 'amy', ['ben']))
    store.addResult('done', { userId: 'ben', seq: 1, boardId: 'x', scoreNS: 50, playedAt: T0 })
    store.setStatus('done', 'finished', T0 + 1)
    store.addResult('group', { userId: 'ben', seq: 1, boardId: 'y', scoreNS: 50, playedAt: T0 })

    expect(store.openIdsOf('ben').sort()).toEqual(['declined', 'duel', 'group'])
    for (const id of ['declined', 'done', 'duel', 'group']) store.forgetIn(id, 'ben', T0 + 7)
    expect(store.get('duel')).toMatchObject({ status: 'cancelled', endedAt: T0 + 7 })
    expect(store.get('group')).toMatchObject({ status: 'pending', results: [] })
    expect(store.get('group')!.players.map((p) => p.userId)).toEqual(['amy', 'cat'])
    // Only cat is left who has not declined
    expect(store.get('declined')!.status).toBe('cancelled')
    // A finished challenge keeps its standings
    expect(store.get('done')!.results).toHaveLength(1)
    expect(store.idsOf('ben')).toEqual(['done'])
  })
})

class NoConnections implements Connections {
  onlineUserIds() {
    return []
  }
  send(_userId: string, _message: ServerMessage) {}
  disconnect() {}
}

describe('challenges in the club', () => {
  let store: MemoryStore
  let club: ClubService
  const open = async () => {
    club = clubService(store, new NoConnections(), { maxUsers: 10, now: () => T0, schedule: () => {} })
    await club.load()
  }
  const join = async (name: string) => {
    const result = await club.register(name, 'secret1', '')
    if ('user' in result) return result.user
    const application = club.adminApplications().find((a) => a.username === name)!
    return club.adminApprove(application.id)
  }

  beforeEach(async () => {
    store = memoryStore()
    await open()
  })

  it('keeps challenges when the object is evicted and loaded again', async () => {
    club.challenges.create(challenge('c1', 'amy', ['ben']))
    await open()
    expect(club.challenges.get('c1')?.players.map((p) => p.userId)).toEqual(['amy', 'ben'])
  })

  it('takes a deleted member out of their open challenges', async () => {
    const admin = await join('gene')
    const amy = await join('amy')
    const ben = await join('ben')
    club.challenges.create(challenge('c1', amy.id, [ben.id]))
    await club.adminDeleteUser(admin.id, ben.id)
    expect(club.challenges.get('c1')).toMatchObject({ status: 'cancelled', players: [{ userId: amy.id }] })
  })
})
