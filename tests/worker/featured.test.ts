// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { parseFeaturedInput } from '../../shared/featured.ts'
import type { BoardState } from '../../shared/game.ts'
import type { BoardRecord, PublicUser } from '../../shared/protocol.ts'
import { FeaturedService } from '../../worker/featured.ts'
import { ClubError } from '../../worker/service.ts'
import { MemoryStore } from '../../worker/store.ts'

const USERS: Record<string, PublicUser> = {
  amy: { id: 'amy', username: 'Amy' },
  ben: { id: 'ben', username: 'Ben' },
  cat: { id: 'cat', username: 'Cat' },
  dan: { id: 'dan', username: 'Dan' },
  'robot:gib:W': { id: 'robot:gib:W', username: 'TKB', robot: true },
}
const CURATORS = new Set(['amy', 'dan'])
const NOW = 1_000_000

let store: MemoryStore
let service: FeaturedService
let sent: { userId: string; kind: string; params: Record<string, string | number> }[]
let time: number

function record(id: string, revealAt?: number): BoardRecord {
  const players = { N: USERS.amy, S: USERS.ben, E: USERS.cat, W: USERS['robot:gib:W'] }
  const board = {
    boardNo: 3,
    dealer: 'N',
    vul: 'None',
    contract: { level: 4, strain: 'S', declarer: 'N', doubled: '' },
    result: { declarerTricks: 10, scoreNS: 420, claimed: false },
    play: [],
  } as unknown as BoardState
  return { id, tableNumber: 2, finishedAt: NOW - 1000, players, board, ...(revealAt !== undefined && { revealAt }) }
}

function build() {
  return new FeaturedService(store, {
    now: () => time,
    userById: (id) => USERS[id],
    requireCurator: (id) => {
      if (!CURATORS.has(id)) throw new ClubError('noPermission', {}, 403)
    },
    notify: async (userId, kind, params) => sent.push({ userId, kind, params }),
    takeAction: () => true,
  })
}

const input = { title: '  一墩也不能讓 ', category: 'declarer', explanation: '先清王', trickNotes: { 1: '首攻 ♥K', 3: ' ', 13: '最後一墩' } }

beforeEach(async () => {
  store = new MemoryStore()
  sent = []
  time = NOW
  await store.put('board:b1', record('b1'))
  await store.put('board:b2', record('b2'))
  // A challenge board kept back until NOW + 5000; Dan did not play it
  await store.put('board:hidden', record('hidden', NOW + 5000))
  service = build()
})

describe('featured input', () => {
  it('trims the text, drops empty notes and names the first bad field', () => {
    expect(parseFeaturedInput(input)).toEqual({
      input: { title: '一墩也不能讓', category: 'declarer', explanation: '先清王', trickNotes: { 1: '首攻 ♥K', 13: '最後一墩' } },
    })
    expect(parseFeaturedInput({ ...input, title: ' ' })).toEqual({ field: 'title' })
    expect(parseFeaturedInput({ ...input, title: 'x'.repeat(61) })).toEqual({ field: 'title' })
    expect(parseFeaturedInput({ ...input, category: 'lead' })).toEqual({ field: 'category' })
    expect(parseFeaturedInput({ ...input, trickNotes: { 14: 'x' } })).toEqual({ field: 'trickNotes' })
    expect(parseFeaturedInput({ ...input, trickNotes: { 0: 'x' } })).toEqual({ field: 'trickNotes' })
    expect(parseFeaturedInput({ ...input, trickNotes: [] })).toEqual({ field: 'trickNotes' })
    expect(parseFeaturedInput({ ...input, explanation: 'x'.repeat(4001) })).toEqual({ field: 'explanation' })
    expect(parseFeaturedInput({ ...input, extra: 1 })).toEqual({ field: 'extra' })
    expect(parseFeaturedInput(null)).toEqual({ field: 'featured' })
  })
})

describe('featured boards', () => {
  it('features a board, tells the members who played it once, and lists it for everyone', async () => {
    const featured = await service.set('dan', 'b1', input)
    expect(featured).toMatchObject({
      boardId: 'b1',
      title: '一墩也不能讓',
      by: USERS.dan,
      at: NOW,
      trickNotes: { 1: '首攻 ♥K', 13: '最後一墩' },
      board: { id: 'b1', tableNumber: 2, boardNo: 3, contract: { level: 4, strain: 'S' } },
    })
    // Not the robot
    expect(sent.map((n) => n.userId).sort()).toEqual(['amy', 'ben', 'cat'])
    expect(sent[0]).toMatchObject({ kind: 'boardFeatured', params: { boardId: 'b1', username: 'Dan' } })
    expect(await service.get('b1', 'ben')).toEqual(featured)
    expect(await service.get('b2', 'ben')).toBeNull()

    // An edit by another curator keeps who featured it first and tells no one again
    time += 60_000
    sent = []
    const edited = await service.set('amy', 'b1', { ...input, title: '改過的標題', category: 'defence' })
    expect(edited).toMatchObject({ title: '改過的標題', category: 'defence', by: USERS.dan, at: NOW, updatedAt: NOW + 60_000 })
    expect(sent).toEqual([])

    // The curator who played the board is not told about their own feature
    await service.set('amy', 'b2', input)
    expect(sent.map((n) => n.userId).sort()).toEqual(['ben', 'cat'])
    expect((await service.list('cat')).map((f) => f.boardId)).toEqual(['b2', 'b1'])
  })

  it('only lets curators feature, edit and remove', async () => {
    await expect(service.set('ben', 'b1', input)).rejects.toThrow('沒有這項權限')
    await service.set('dan', 'b1', input)
    await expect(service.remove('ben', 'b1')).rejects.toThrow('沒有這項權限')
    await expect(service.set('dan', 'b1', { ...input, category: 'x' })).rejects.toMatchObject({ code: 'badFeatured', params: { field: 'category' } })
    await expect(service.set('dan', 'gone', input)).rejects.toMatchObject({ code: 'boardGone', status: 404 })
    await expect(service.set('dan', '../x', input)).rejects.toMatchObject({ code: 'boardGone' })
  })

  it('features a board only once it is public, without telling outsiders it exists (§4)', async () => {
    // Amy played it: she hears it is not public yet; Dan did not and sees no such board
    await expect(service.set('amy', 'hidden', input)).rejects.toMatchObject({ code: 'featuredNotRevealed', status: 403 })
    await expect(service.set('dan', 'hidden', input)).rejects.toMatchObject({ code: 'boardGone', status: 404 })
    time = NOW + 5000
    await service.set('dan', 'hidden', input)
    expect((await service.list('dan')).map((f) => f.boardId)).toEqual(['hidden'])
  })

  it('keeps features in the store and takes them off again', async () => {
    await service.set('dan', 'b1', input)
    const reloaded = build()
    expect((await reloaded.list('ben')).map((f) => f.title)).toEqual(['一墩也不能讓'])
    await reloaded.remove('amy', 'b1')
    expect(await reloaded.get('b1', 'ben')).toBeNull()
    expect(await store.list('featured:')).toEqual(new Map())
    await expect(reloaded.remove('amy', 'b1')).rejects.toMatchObject({ code: 'featuredGone', status: 404 })
  })

  it('shows a curator whose account is gone as a dash', async () => {
    await service.set('dan', 'b1', input)
    delete USERS.dan
    try {
      expect((await service.get('b1', 'amy'))?.by).toEqual({ id: '', username: '—' })
    } finally {
      USERS.dan = { id: 'dan', username: 'Dan' }
    }
  })
})
