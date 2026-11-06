// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import type { ServerMessage } from '../../shared/protocol.ts'
import type { ClubService, Connections, ScheduleKind } from '../../worker/service.ts'
import type { MemoryStore } from '../../worker/store.ts'
import { memoryStore } from './sqlite.ts'
import { clubService, writeChallenge } from './event-mode.ts'
import { adminWithTwoFactor } from './admin-two-factor.ts'

/**
 * The challenges' M2 extras on both paths of `EVENT_OBJECTS` (the file matches the `challenge*`
 * tests in vite.config.ts): IMPs against the datum (e7-t30), each board's discussion thread
 * (e7-t27) and a member's challenge record (e7-t29)
 */

class FakeConnections implements Connections {
  online = new Set<string>()
  onlineUserIds() {
    return [...this.online]
  }
  send(_userId: string, _message: ServerMessage) {}
  disconnect(userId: string) {
    this.online.delete(userId)
  }
}

let store: MemoryStore
let connections: FakeConnections
let club: ClubService
let queue: { run: () => void; ms: number; kind: ScheduleKind }[]
let time: number
let boss: string
const ids: Record<string, string> = {}

const tick = async (times = 1) => {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setImmediate(resolve))
}

beforeEach(async () => {
  store = memoryStore()
  connections = new FakeConnections()
  queue = []
  time = Date.UTC(2026, 10, 10)
  club = clubService(store, connections, {
    maxUsers: 40,
    now: () => time,
    schedule: (run, ms, kind) => queue.push({ run, ms, kind }),
  })
  await club.load()
  const result = await club.register('boss', 'club-secret-1', '')
  boss = 'user' in result ? result.user.id : ''
  // The founder turns two-step sign-in on so that it acts as an admin (社長 2026-11-02)
  await adminWithTwoFactor(club, boss)
  for (const name of ['amy', 'ben', 'cat', 'dan']) ids[name] = await member(name)
})

async function member(name: string) {
  const result = await club.register(name, 'club-secret-1', '')
  const user =
    'user' in result ? result.user : await club.adminApprove(club.adminApplications().find((a) => a.username === name)!.id)
  connections.online.add(user.id)
  club.connected(user.id)
  await tick()
  return user.id
}

/** Amy challenges the others to two boards; each name's scores are written as played (a shorter row: unfinished) */
async function challenge(scores: Record<string, number[]>, settings: Record<string, unknown> = {}) {
  const names = Object.keys(scores).filter((n) => n !== 'amy')
  const created = await club.challengeRequest(ids.amy, {
    type: 'createChallenge',
    invitees: names.map((n) => ids[n]),
    boards: 2,
    settings,
  })
  const id = created!.id
  for (const name of names) await club.challengeRequest(ids[name], { type: 'answerChallenge', challengeId: id, accept: true })
  for (const [name, row] of Object.entries(scores))
    for (const [i, scoreNS] of row.entries())
      writeChallenge(club, id, (s) =>
        s.addResult(id, { userId: ids[name], seq: i + 1, boardId: `b-${id}-${name}-${i + 1}`, scoreNS, playedAt: time }),
      )
  return id
}

async function toDeadline(id: string) {
  time = club.challenges.get(id)!.deadline
  const due = queue.filter((job) => job.kind === 'challenge')
  queue = queue.filter((job) => job.kind !== 'challenge')
  for (const job of due) job.run()
  await tick(10)
}

describe('IMPs against the datum (e7-t30)', () => {
  it('is a scoring for three or more, ranked against each board datum', async () => {
    await expect(
      club.challengeRequest(ids.amy, { type: 'createChallenge', invitees: [ids.ben], settings: { scoring: 'datumImp' } }),
    ).rejects.toMatchObject({ code: 'badChallengeSettings', params: { field: 'scoring' } })

    const id = await challenge({ amy: [620, 100], ben: [420, 100], cat: [170, 140] }, { scoring: 'datumImp' })
    await toDeadline(id)
    const standings = club.challengeFor(id, ids.amy)!.standings!
    // Board 1, datum 420: +200 = 5, 0, −250 = −6; board 2, datum 100: 0, 0, +40 = 1
    expect(standings.scoring).toBe('datumImp')
    expect(standings.ranked.map((r) => [r.userId, r.total, r.rank])).toEqual([
      [ids.amy, 5, 1],
      [ids.ben, 0, 2],
      [ids.cat, -5, 3],
    ])
  })
})

describe('each board discussion thread (e7-t27)', () => {
  it('only those who played every board read and write while it is open', async () => {
    const id = await challenge({ amy: [620, 100], ben: [420, 100], cat: [170] }, { ranking: 'club' })
    const extras = club.challengeExtras

    expect(extras.comments(id, 1, ids.amy)).toEqual({ comments: [], canPost: true })
    const thread = extras.addComment(id, 1, ids.amy, '  4♠ makes on a club lead  ')
    expect(thread.comments).toEqual([
      {
        id: expect.any(Number),
        userId: ids.amy,
        user: expect.objectContaining({ username: 'amy' }),
        text: '4♠ makes on a club lead',
        at: time,
        removable: true,
      },
    ])
    expect(extras.comments(id, 1, ids.ben).comments.map((c) => [c.text, c.removable])).toEqual([['4♠ makes on a club lead', false]])

    // Cat is still playing: not even the board she played, nor a word of who said what
    expect(() => extras.comments(id, 1, ids.cat)).toThrow(expect.objectContaining({ code: 'challengeGone', status: 404 }))
    expect(() => extras.addComment(id, 1, ids.cat, 'hi')).toThrow(expect.objectContaining({ code: 'challengeGone' }))
    // Outsiders never, and a board out of range has no thread
    expect(() => extras.comments(id, 1, ids.dan)).toThrow(expect.objectContaining({ code: 'challengeGone' }))
    expect(() => extras.comments(id, 3, ids.amy)).toThrow(expect.objectContaining({ code: 'challengeGone' }))

    expect(() => extras.addComment(id, 1, ids.amy, '   ')).toThrow(expect.objectContaining({ code: 'challengeCommentEmpty' }))
    expect(() => extras.addComment(id, 1, ids.amy, 'x'.repeat(501))).toThrow(
      expect.objectContaining({ code: 'challengeCommentTooLong', params: { max: 500 } }),
    )

    // After the end Cat reads but, not having played every board, does not write; outsiders still see nothing
    await toDeadline(id)
    expect(extras.comments(id, 1, ids.cat)).toMatchObject({ canPost: false, comments: [{ text: '4♠ makes on a club lead' }] })
    expect(() => extras.addComment(id, 1, ids.cat, 'hi')).toThrow(expect.objectContaining({ code: 'challengeCommentFinishFirst' }))
    expect(() => extras.comments(id, 1, ids.dan)).toThrow(expect.objectContaining({ code: 'challengeGone' }))
    expect(extras.addComment(id, 2, ids.ben, 'flat board').comments).toHaveLength(1)
  })

  it('the writer or an admin deletes a comment; a deleted account takes its comments along', async () => {
    const id = await challenge({ amy: [620, 100], ben: [420, 100] })
    const extras = club.challengeExtras
    const [first] = extras.addComment(id, 1, ids.amy, 'mine').comments
    extras.addComment(id, 1, ids.ben, 'his')
    expect(() => extras.removeComment(id, 1, ids.ben, first.id)).toThrow(expect.objectContaining({ code: 'challengeCommentGone' }))
    expect(extras.removeComment(id, 1, ids.amy, first.id).comments.map((c) => c.text)).toEqual(['his'])

    // A new admin deletes others' comments once two-step sign-in is on
    await club.adminSetAdmin(boss, ids.amy, true)
    expect(extras.comments(id, 1, ids.amy).comments[0].removable).toBe(false)
    await adminWithTwoFactor(club, ids.amy)
    expect(extras.comments(id, 1, ids.amy).comments[0].removable).toBe(true)
    expect((await club.exportAccount(ids.ben, null)).challengeComments).toEqual([{ challengeId: id, seq: 1, text: 'his', at: time }])

    await club.adminDeleteUser(boss, ids.ben)
    expect(extras.comments(id, 1, ids.amy).comments).toEqual([])
  })
})

describe('a member challenge record (e7-t29)', () => {
  it('counts finished challenges among those who played every board, with the head to head', async () => {
    // IMPs, head to head: +6 and 0, a win over Ben
    const first = await challenge({ amy: [420, 100], ben: [170, 100] })
    await toDeadline(first)
    // Matchpoints: Amy loses to Ben (0% and 50%), draws with Cat; Dan did not finish and counts for nobody
    time += 1000
    const second = await challenge({ amy: [100, 100], ben: [200, 100], cat: [100, 100], dan: [50] })
    await toDeadline(second)
    // Still open: not counted
    time += 1000
    await challenge({ amy: [100, 100], ben: [-500, -500] })

    const stats = club.challengeExtras.stats(ids.amy)
    expect(stats).toMatchObject({ challenges: 2, firsts: 1, wins: 1, losses: 1, draws: 1, winRate: 0.5 })
    // +6, 0 (first); −3, 0 against Ben and 0, 0 against Cat (second)
    expect(stats.boards).toBe(6)
    expect(stats.averageImps).toBe(0.5)
    expect(stats.opponents.map((o) => [o.user?.username, o.challenges, o.wins, o.losses, o.draws, o.boards, o.imps])).toEqual([
      ['ben', 2, 1, 1, 0, 4, 3],
      ['cat', 1, 0, 0, 1, 2, 0],
    ])
    expect(club.challengeExtras.stats(ids.dan)).toMatchObject({ challenges: 0, winRate: null, opponents: [] })
  })
})
