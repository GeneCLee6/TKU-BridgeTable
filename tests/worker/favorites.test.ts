// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import type { Seat } from '../../shared/cards.ts'
import type { BoardState } from '../../shared/game.ts'
import { DEFAULT_HISTORY_QUERY, parseHistoryQuery, type HistoryQuery } from '../../shared/history-query.ts'
import { LIMITS, type BoardRecord } from '../../shared/protocol.ts'
import { indexRecord } from '../../worker/history-index.ts'
import { ClubService, type Connections } from '../../worker/service.ts'
import type { MemoryStore } from '../../worker/store.ts'
import { memoryStore } from './sqlite.ts'

const connections: Connections = { onlineUserIds: () => [], send: () => {}, disconnect: () => {} }
const NOW = 5_000_000

let store: MemoryStore
let club: ClubService

function record(id: string, at: number, seats: Record<Seat, string>, extra: Partial<BoardRecord> = {}): BoardRecord {
  const players = Object.fromEntries(Object.entries(seats).map(([s, user]) => [s, { id: user, username: user }])) as BoardRecord['players']
  const board = {
    boardNo: 1,
    dealer: 'N',
    vul: 'None',
    contract: { level: 4, strain: 'S', declarer: 'N', doubled: '' },
    result: { declarerTricks: 10, scoreNS: 420, claimed: false },
  } as unknown as BoardState
  return { id, tableNumber: 1, finishedAt: at, players, board, ...extra }
}

async function put(r: BoardRecord) {
  indexRecord(store.sql, r)
  await store.put(`board:${r.id}`, r)
}

const AMY_TABLE = { N: 'amy', S: 'ben', E: 'cat', W: 'robot:gib:W' } as const
const OTHERS = { N: 'dan', S: 'eve', E: 'fay', W: 'gus' } as const

const list = (userId: string, query: Partial<HistoryQuery> = {}) =>
  club.favorites(userId, { ...DEFAULT_HISTORY_QUERY, ...query })

beforeEach(async () => {
  store = memoryStore()
  club = new ClubService(store, connections, { maxUsers: 10, now: () => NOW })
  await club.load()
  await put(record('mine1', 1000, AMY_TABLE))
  await put(record('mine2', 2000, AMY_TABLE))
  await put(record('theirs', 3000, OTHERS))
  // A challenge board Dan's table played, kept back until NOW + 1000 (AC-4.9)
  await put(record('held', 4000, OTHERS, { mode: 'challenge', eventId: 'c1', revealAt: NOW + 1000 }))
})

describe('favorites (AC-4.4)', () => {
  it('adds, lists newest board first, and removes', async () => {
    await club.saveFavorite('amy', 'mine1', {})
    await club.saveFavorite('amy', 'theirs', {})
    expect(club.favoriteIds('amy').sort()).toEqual(['mine1', 'theirs'])
    // Favorites are listed whoever played them; the default "mine" scope does not apply
    const page = await list('amy')
    expect(page.boards.map((b) => b.id)).toEqual(['theirs', 'mine1'])
    expect(page.total).toBe(2)
    expect(page.favorites.map((f) => f.boardId)).toEqual(['theirs', 'mine1'])
    club.removeFavorite('amy', 'theirs')
    expect((await list('amy')).boards.map((b) => b.id)).toEqual(['mine1'])
    // Removing what is not kept does nothing
    club.removeFavorite('amy', 'theirs')
  })

  it('keeps a private note and tags, and leaves out what is not sent', async () => {
    const saved = await club.saveFavorite('amy', 'mine1', { note: '  首攻錯了 ', tags: ['首攻', ' 防守  練習 ', '首攻', ''] })
    expect(saved).toMatchObject({ note: '首攻錯了', tags: ['首攻', '防守 練習'], createdAt: NOW })
    const tagsOnly = await club.saveFavorite('amy', 'mine1', { tags: ['坐莊'] })
    expect(tagsOnly).toMatchObject({ note: '首攻錯了', tags: ['坐莊'] })
    expect((await club.favorite('amy', 'mine1')).favorite?.tags).toEqual(['坐莊'])
    // Nobody else sees Amy's note: Ben's favorite of the same board is his own
    expect((await club.favorite('ben', 'mine1')).favorite).toBeNull()
    await club.saveFavorite('ben', 'mine1', { note: 'ben' })
    expect((await club.favorite('amy', 'mine1')).favorite?.note).toBe('首攻錯了')
  })

  it('filters by tag and by the history conditions, and counts the tags', async () => {
    await club.saveFavorite('amy', 'mine1', { tags: ['Slam', '練習'] })
    await club.saveFavorite('amy', 'mine2', { tags: ['練習'] })
    await club.saveFavorite('amy', 'theirs', {})
    await club.saveFavorite('ben', 'theirs', { tags: ['Slam'] })
    expect((await list('amy', { tag: '練習' })).boards.map((b) => b.id)).toEqual(['mine2', 'mine1'])
    // Tags match whatever the letter case
    expect((await list('amy', { tag: 'slam' })).boards.map((b) => b.id)).toEqual(['mine1'])
    expect((await list('amy', { player: 'dan' })).boards.map((b) => b.id)).toEqual(['theirs'])
    expect((await list('amy', { to: '1970-01-01' })).total).toBe(3)
    expect((await list('amy')).tags).toEqual([
      { tag: '練習', count: 2 },
      { tag: 'Slam', count: 1 },
    ])
    expect(parseHistoryQuery(new URLSearchParams('tag=%20練習%20')).tag).toBe('練習')
  })

  it('cannot keep or list a board the member may not see yet (AC-4.9)', async () => {
    await expect(club.saveFavorite('amy', 'held', {})).rejects.toMatchObject({ code: 'boardGone', status: 404 })
    await expect(club.favorite('amy', 'held')).rejects.toMatchObject({ code: 'boardGone' })
    await expect(club.saveFavorite('amy', 'nothing', {})).rejects.toMatchObject({ code: 'boardGone' })
    await expect(club.saveFavorite('amy', '../x', {})).rejects.toMatchObject({ code: 'boardGone' })
    // Its own players may keep it, and only they see it in the list until it is revealed
    await club.saveFavorite('dan', 'held', {})
    expect((await list('dan')).boards.map((b) => b.id)).toEqual(['held'])
    // Once revealed, anyone may
    const later = new ClubService(store, connections, { maxUsers: 10, now: () => NOW + 1000 })
    await later.load()
    await later.saveFavorite('amy', 'held', {})
    expect((await later.favorites('amy', DEFAULT_HISTORY_QUERY)).boards.map((b) => b.id)).toEqual(['held'])
  })

  it('checks the note, the tags and how many boards a member keeps', async () => {
    await expect(club.saveFavorite('amy', 'mine1', { note: 'x'.repeat(LIMITS.favoriteNoteMax + 1) })).rejects.toMatchObject({
      code: 'favoriteNoteTooLong',
    })
    const many = Array.from({ length: LIMITS.favoriteTagsMax + 1 }, (_, i) => `t${i}`)
    await expect(club.saveFavorite('amy', 'mine1', { tags: many })).rejects.toMatchObject({ code: 'favoriteTagsBad' })
    await expect(club.saveFavorite('amy', 'mine1', { tags: ['x'.repeat(LIMITS.favoriteTagMax + 1)] })).rejects.toMatchObject({
      code: 'favoriteTagsBad',
    })
    expect(club.favoriteIds('amy')).toEqual([])
    for (let i = 0; i < LIMITS.favoritesMax; i++)
      store.sql.exec(
        'INSERT INTO favorites (user_id, board_id, note, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        'amy',
        `filler${i}`,
        '',
        '[]',
        0,
        0,
      )
    await expect(club.saveFavorite('amy', 'mine1', {})).rejects.toMatchObject({ code: 'favoritesFull' })
  })
})
