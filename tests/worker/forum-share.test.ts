// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import type { BoardState } from '../../shared/game.ts'
import type { BoardRecord } from '../../shared/protocol.ts'
import { addedRecordIds } from '../../worker/forum-share.ts'
import { indexRecord } from '../../worker/history-index.ts'
import { ClubError, ClubService, type Connections } from '../../worker/service.ts'
import type { MemoryStore } from '../../worker/store.ts'
import { memoryStore } from './sqlite.ts'

/** E13 K3: sharing a board from the history (e13-t07) and the profile page's privacy (e13-t08) */

const connections: Connections = { onlineUserIds: () => [], send: () => undefined, disconnect: () => undefined }

let store: MemoryStore
let club: ClubService
let time: number
let admin: string

beforeEach(async () => {
  store = memoryStore()
  time = 1_000_000
  club = new ClubService(store, connections, { maxUsers: 20, now: () => time, schedule: () => undefined })
  await club.load()
  const founder = await club.register('admin', 'club-secret-1', '')
  if (!('user' in founder)) throw new Error('the first account should sign in at once')
  admin = founder.user.id
})

async function member(name: string) {
  const result = await club.register(name, 'club-secret-1', '')
  if ('user' in result) return result.user.id
  return (await club.adminApprove(club.adminApplications().find((a) => a.username === name)!.id)).id
}

async function finished(id: string, at: number, ids: [string, string, string, string], revealAt?: number) {
  const [N, E, S, W] = ids.map((x) => ({ id: x, username: x }))
  const record: BoardRecord = {
    id,
    tableNumber: 1,
    finishedAt: at,
    players: { N, E, S, W },
    board: {
      boardNo: 1,
      dealer: 'N',
      vul: 'None',
      contract: null,
      result: { declarerTricks: 0, scoreNS: 0, claimed: false },
    } as unknown as BoardState,
    ...(revealAt !== undefined && { revealAt }),
  }
  await store.put(`board:${id}`, record)
  indexRecord(store.sql, record)
}

async function codeOf(promise: Promise<unknown>) {
  try {
    await promise
  } catch (e) {
    if (e instanceof ClubError) return e.code
    throw e
  }
  return 'ok'
}

describe('addedRecordIds', () => {
  it('finds the record blocks a post adds, once each', () => {
    const body = {
      title: 'x',
      blocks: [
        { kind: 'paragraph', text: 'hi' },
        { kind: 'record', tableRecordId: 'b1' },
        { kind: 'record', tableRecordId: 'b2' },
        { kind: 'record', tableRecordId: 'b1' },
      ],
    }
    expect(addedRecordIds(body)).toEqual(['b1', 'b2'])
    // An edit checks only the boards it adds
    expect(addedRecordIds(body, [{ kind: 'record', tableRecordId: 'b1' }])).toEqual(['b2'])
  })

  it('leaves a malformed body to the forum to refuse', () => {
    expect(addedRecordIds(null)).toEqual([])
    expect(addedRecordIds({ blocks: 'no' })).toEqual([])
    expect(addedRecordIds({ blocks: [null, 3, { kind: 'record', tableRecordId: 7 }, { kind: 'deal' }] })).toEqual([])
  })
})

describe('sharing a board on the forum (e13-t07, AC-13.3)', () => {
  it('lets anyone who may see a revealed board share it', async () => {
    const amy = await member('amy')
    await finished('open', 100, [amy, 'robot:N', 'robot:E', 'robot:W'])
    await finished('past', 200, ['x', 'y', 'z', 'w'], time - 1)
    expect(await codeOf(club.checkShareable(amy, 'open'))).toBe('ok')
    expect(await codeOf(club.checkShareable(admin, 'open'))).toBe('ok')
    expect(await codeOf(club.checkShareable(amy, 'past'))).toBe('ok')
  })

  it('refuses a board kept back, even to its own players, until it is revealed', async () => {
    const amy = await member('amy')
    const ben = await member('ben')
    await finished('held', 100, [amy, 'robot:N', 'robot:E', 'robot:W'], time + 1000)
    // Amy played it and may see it, but the challenge is not over
    expect(await codeOf(club.checkShareable(amy, 'held'))).toBe('recordNotShareable')
    // Ben may not see it at all: the same answer as a board that is not there
    expect(await codeOf(club.checkShareable(ben, 'held'))).toBe('boardGone')
    expect(await codeOf(club.checkShareable(ben, 'nothing'))).toBe('boardGone')
    expect(await codeOf(club.checkShareable(ben, '../bad id'))).toBe('boardGone')
    time += 1000
    expect(await codeOf(club.checkShareable(amy, 'held'))).toBe('ok')
    expect(await codeOf(club.checkShareable(ben, 'held'))).toBe('ok')
  })
})

describe('profile page privacy (e13-t08, AC-13.5)', () => {
  it('shows both by default and keeps the choice on the account', async () => {
    const amy = await member('amy')
    expect((await club.setAccountPreferences(amy, { robotSpeed: 'fast' })).profilePrivacy).toEqual({ boards: true, posts: true })
    const me = await club.setAccountPreferences(amy, { profileBoards: false, profilePosts: false })
    expect(me.profilePrivacy).toEqual({ boards: false, posts: false })
    // Only what is sent changes
    expect((await club.setAccountPreferences(amy, { profilePosts: true })).profilePrivacy).toEqual({ boards: false, posts: true })
    // It survives the object being recycled
    const again = new ClubService(store, connections, { maxUsers: 20, now: () => time, schedule: () => undefined })
    await again.load()
    expect(again.profileHidden(admin, amy)).toEqual({ boards: true, posts: false })
  })

  it('refuses anything but true or false', async () => {
    const amy = await member('amy')
    expect(await codeOf(club.setAccountPreferences(amy, { profileBoards: 'no' }))).toBe('unknownCommand')
    expect(await codeOf(club.setAccountPreferences(amy, { profilePosts: 1 }))).toBe('unknownCommand')
    expect(await codeOf(club.setAccountPreferences(amy, {}))).toBe('unknownCommand')
  })

  it('leaves hidden boards off the page for others, never for the member', async () => {
    const amy = await member('amy')
    const ben = await member('ben')
    await finished('b1', 100, [amy, ben, 'robot:S', 'robot:W'])
    expect((await club.memberProfile(ben, amy)).recent.map((b) => b.id)).toEqual(['b1'])
    await club.setAccountPreferences(amy, { profileBoards: false })
    expect((await club.memberProfile(ben, amy)).recent).toEqual([])
    expect((await club.memberProfile(admin, amy)).recent).toEqual([])
    expect((await club.memberProfile(amy, amy)).recent.map((b) => b.id)).toEqual(['b1'])
    expect(club.profileHidden(ben, amy)).toEqual({ boards: true, posts: false })
    expect(club.profileHidden(amy, amy)).toEqual({ boards: false, posts: false })
    // Nothing is said about someone who is not there
    expect(club.profileHidden(ben, 'nobody')).toEqual({ boards: false, posts: false })
  })
})
