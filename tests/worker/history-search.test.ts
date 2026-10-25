// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { Contract } from '../../shared/auction.ts'
import type { Vulnerability } from '../../shared/board.ts'
import type { Seat } from '../../shared/cards.ts'
import type { BoardState } from '../../shared/game.ts'
import { DEFAULT_HISTORY_QUERY, taiwanDayStart, type HistoryQuery } from '../../shared/history-query.ts'
import type { BoardRecord } from '../../shared/protocol.ts'
import { createHistoryIndex, indexRecord, searchBoards } from '../../worker/history-index.ts'
import { memorySql } from './sqlite.ts'

interface Fixture {
  id: string
  at?: number
  seats?: Record<Seat, string>
  contract?: Contract | null
  tricks?: number
  score?: number
  vul?: Vulnerability
  boardNo?: number
  table?: number
  revealAt?: number
}

const TABLE = { N: 'amy', S: 'ben', E: 'cat', W: 'robot:gib:W' } as const
const DAY = taiwanDayStart('2026-10-20')

function record(f: Fixture): BoardRecord {
  const seats = f.seats ?? TABLE
  const players = Object.fromEntries(Object.entries(seats).map(([s, id]) => [s, { id, username: id }])) as BoardRecord['players']
  const contract = f.contract === undefined ? null : f.contract
  const board = {
    boardNo: f.boardNo ?? 1,
    dealer: 'N',
    vul: f.vul ?? 'None',
    contract,
    result: { declarerTricks: f.tricks ?? 0, scoreNS: f.score ?? 0, claimed: false },
  } as unknown as BoardState
  return {
    id: f.id,
    tableNumber: f.table ?? 1,
    finishedAt: f.at ?? DAY,
    players,
    board,
    ...(f.revealAt !== undefined && { revealAt: f.revealAt }),
  }
}

const c = (level: number, strain: Contract['strain'], declarer: Seat, doubled: Contract['doubled'] = ''): Contract => ({
  level,
  strain,
  declarer,
  doubled,
})

/** Eight boards Amy, Ben and Cat played (and one without Amy) on two days */
const BOARDS: Fixture[] = [
  { id: 'spades4', at: DAY + 1, contract: c(4, 'S', 'N'), tricks: 10, score: 420, vul: 'NS' },
  { id: 'spades4x', at: DAY + 2, contract: c(4, 'S', 'E', 'X'), tricks: 8, score: 500 },
  { id: 'nt3', at: DAY + 3, contract: c(3, 'N', 'S'), tricks: 11, score: 460, boardNo: 7 },
  { id: 'hearts2', at: DAY + 4, contract: c(2, 'H', 'W', 'XX'), tricks: 8, score: -760, table: 2 },
  { id: 'slam', at: DAY + 5, contract: c(6, 'C', 'N'), tricks: 12, score: 920 },
  { id: 'grand', at: DAY + 6, contract: c(7, 'N', 'S'), tricks: 12, score: -100 },
  { id: 'passed', at: DAY + 7 },
  { id: 'nextday', at: DAY + 86_400_000, contract: c(5, 'D', 'E'), tricks: 11, score: -400 },
  { id: 'noamy', at: DAY + 8, seats: { N: 'dan', S: 'ben', E: 'cat', W: 'eve' }, contract: c(1, 'S', 'N'), tricks: 7, score: 80 },
]

function search(query: Partial<HistoryQuery>, viewer = 'amy', now = DAY + 10 * 86_400_000) {
  const sql = memorySql()
  createHistoryIndex(sql)
  for (const board of BOARDS) indexRecord(sql, record(board))
  return searchBoards(sql, { ...DEFAULT_HISTORY_QUERY, scope: 'all', size: 100, ...query }, viewer, now)
}
const ids = (query: Partial<HistoryQuery>, viewer?: string) => new Set(search(query, viewer).ids)

describe('history search', () => {
  it('lists everything newest first, or only my boards', () => {
    expect(search({}).ids).toEqual(['nextday', 'noamy', 'passed', 'grand', 'slam', 'hearts2', 'nt3', 'spades4x', 'spades4'])
    expect(ids({ scope: 'mine' })).not.toContain('noamy')
    expect(search({ scope: 'mine' }).total).toBe(8)
  })

  it('filters by contract: level, strain, doubling and the usual brackets', () => {
    expect(ids({ level: 4, strain: 'S' })).toEqual(new Set(['spades4', 'spades4x']))
    expect(ids({ level: 4 })).toEqual(new Set(['spades4', 'spades4x']))
    expect(ids({ strain: 'N' })).toEqual(new Set(['nt3', 'grand']))
    expect(ids({ strain: 'S', doubled: 'undoubled' })).toEqual(new Set(['spades4', 'noamy']))
    expect(ids({ doubled: 'X' })).toEqual(new Set(['spades4x']))
    expect(ids({ doubled: 'XX' })).toEqual(new Set(['hearts2']))
    expect(ids({ doubled: 'doubled' })).toEqual(new Set(['spades4x', 'hearts2']))
    expect(ids({ bracket: 'partial' })).toEqual(new Set(['hearts2', 'noamy']))
    expect(ids({ bracket: 'game' })).toEqual(new Set(['spades4', 'spades4x', 'nt3', 'nextday']))
    expect(ids({ bracket: 'slam' })).toEqual(new Set(['slam']))
    expect(ids({ bracket: 'grand' })).toEqual(new Set(['grand']))
    expect(ids({ bracket: 'passout' })).toEqual(new Set(['passed']))
  })

  it('filters by who declared: a member, a seat, or me, my partner or the opponents', () => {
    expect(ids({ declarer: 'ben' })).toEqual(new Set(['nt3', 'grand']))
    expect(ids({ declarerSeat: 'E' })).toEqual(new Set(['spades4x', 'nextday']))
    expect(ids({ declarerSide: 'me' })).toEqual(new Set(['spades4', 'slam']))
    expect(ids({ declarerSide: 'partner' })).toEqual(new Set(['nt3', 'grand']))
    // A robot declaring counts too
    expect(ids({ declarerSide: 'opponents' })).toEqual(new Set(['spades4x', 'hearts2', 'nextday']))
    expect(ids({ declarerSide: 'partner' }, 'cat')).toEqual(new Set(['hearts2']))
  })

  it('filters by players and partners', () => {
    expect(ids({ player: 'dan' })).toEqual(new Set(['noamy']))
    // "Cat and I at the same table"
    expect(search({ scope: 'mine', player: 'cat' }).total).toBe(8)
    expect(search({ partner: 'ben' }).total).toBe(8)
    expect(search({ partner: 'cat' }).total).toBe(0)
    expect(ids({ partner: 'cat' }, 'ben')).toEqual(new Set())
    expect(ids({ partner: 'eve' }, 'cat')).toEqual(new Set(['noamy']))
  })

  it('filters by Taiwan dates, both ends included', () => {
    expect(ids({ from: '2026-10-21' })).toEqual(new Set(['nextday']))
    expect(search({ to: '2026-10-20' }).total).toBe(8)
    expect(search({ from: '2026-10-20', to: '2026-10-21' }).total).toBe(9)
    expect(search({ from: '2026-10-22' }).total).toBe(0)
  })

  it('filters by result, vulnerability, board, table and mode', () => {
    expect(ids({ result: 'made' })).toEqual(new Set(['spades4', 'nt3', 'hearts2', 'slam', 'nextday', 'noamy']))
    expect(ids({ result: 'down' })).toEqual(new Set(['spades4x', 'grand']))
    expect(ids({ result: 'overtricks' })).toEqual(new Set(['nt3']))
    expect(ids({ vul: 'NS' })).toEqual(new Set(['spades4']))
    expect(ids({ boardNo: 7 })).toEqual(new Set(['nt3']))
    expect(ids({ table: 2 })).toEqual(new Set(['hearts2']))
    expect(search({ mode: 'casual' }).total).toBe(9)
    expect(search({ mode: 'challenge' }).total).toBe(0)
  })

  it('combines conditions', () => {
    expect(ids({ scope: 'mine', strain: 'S', declarerSide: 'opponents', result: 'down' })).toEqual(new Set(['spades4x']))
  })

  it('sorts by date, score or tricks, passed-out boards last', () => {
    expect(search({ sort: 'date_asc' }).ids[0]).toBe('spades4')
    expect(search({ sort: 'score_desc' }).ids.slice(0, 2)).toEqual(['slam', 'spades4x'])
    expect(search({ sort: 'score_asc' }).ids[0]).toBe('hearts2')
    expect(search({ sort: 'tricks_desc' }).ids.slice(0, 2)).toEqual(['grand', 'slam'])
    expect(search({ sort: 'tricks_asc' }).ids.slice(0, 2)).toEqual(['noamy', 'hearts2'])
    expect(search({ sort: 'tricks_asc' }).ids.at(-1)).toBe('passed')
    expect(search({ sort: 'tricks_desc' }).ids.at(-1)).toBe('passed')
  })

  it('pages, with the total, and shows the last page for one past the end', () => {
    expect(search({ size: 10, page: 1 })).toMatchObject({ total: 9, page: 1 })
    const second = search({ scope: 'mine', size: 10, page: 5 })
    expect(second).toMatchObject({ total: 8, page: 1 })
    expect(second.ids).toHaveLength(8)
  })

  it('keeps boards back from everyone but their players until they are revealed (AC-4.9)', () => {
    const sql = memorySql()
    createHistoryIndex(sql)
    indexRecord(sql, record({ id: 'open', at: DAY }))
    indexRecord(sql, record({ id: 'held', at: DAY + 1, revealAt: DAY + 100 }))
    const all = (viewer: string, now: number, query: Partial<HistoryQuery> = {}) =>
      searchBoards(sql, { ...DEFAULT_HISTORY_QUERY, scope: 'all', ...query }, viewer, now)
    expect(all('dan', DAY + 50)).toMatchObject({ ids: ['open'], total: 1 })
    expect(all('dan', DAY + 50, { strain: undefined, player: 'amy' }).ids).toEqual(['open'])
    // Every filter the history page offers still leaves the held board out for others
    const filters: Partial<HistoryQuery>[] = [
      { bracket: 'passout' },
      { declarerSide: 'opponents' },
      { player: 'amy' },
      { partner: 'cat' },
      { from: '2026-10-20', to: '2026-10-20' },
      { vul: 'None', boardNo: 1, table: 1, mode: 'casual' },
      { sort: 'score_desc' },
      { sort: 'tricks_asc' },
    ]
    for (const filter of filters) expect(all('dan', DAY + 50, filter).ids).not.toContain('held')
    expect(all('amy', DAY + 50).ids).toEqual(['held', 'open'])
    expect(all('dan', DAY + 100).ids).toEqual(['held', 'open'])
  })
})
