// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { Contract } from '../../shared/auction.ts'
import type { Seat } from '../../shared/cards.ts'
import type { BoardState } from '../../shared/game.ts'
import type { BoardRecord } from '../../shared/protocol.ts'
import {
  boardsPlayedBy,
  boardsPlayedWith,
  createHistoryIndex,
  indexRecord,
  unindexRecord,
} from '../../worker/history-index.ts'
import type { Sql } from '../../worker/store.ts'
import { memorySql } from './sqlite.ts'

/** A finished board with only what the index reads */
function record(id: string, at: number, seats: Record<Seat, string>, contract: Contract | null = null): BoardRecord {
  const players = Object.fromEntries(
    Object.entries(seats).map(([seat, userId]) => [seat, { id: userId, username: userId }]),
  ) as BoardRecord['players']
  const board = {
    boardNo: 3,
    dealer: 'S',
    vul: 'NS',
    contract,
    result: { declarerTricks: contract ? 10 : 0, scoreNS: contract ? 620 : 0, claimed: true },
  } as unknown as BoardState
  return { id, tableNumber: 2, finishedAt: at, players, board }
}

const AMY_BEN = { N: 'amy', S: 'ben', E: 'robot:gib:E', W: 'cat' } as const
const fresh = () => {
  const sql = memorySql()
  createHistoryIndex(sql)
  return sql
}

describe('history index', () => {
  it('keeps one row per board and one per seat, with robots as no one', () => {
    const sql = fresh()
    indexRecord(sql, record('b1', 100, AMY_BEN, { level: 4, strain: 'S', doubled: 'X', declarer: 'N' }))
    expect(sql.exec('SELECT * FROM boards_index')).toEqual([
      {
        board_id: 'b1',
        played_at: 100,
        table_no: 2,
        mode: 'casual',
        event_id: null,
        board_no: 3,
        dealer: 'S',
        vul: 'NS',
        level: 4,
        strain: 'S',
        doubled: 1,
        declarer_seat: 'N',
        declarer_user: 'amy',
        tricks: 10,
        score_ns: 620,
        claimed: 1,
        reveal_at: null,
      },
    ])
    expect(sql.exec('SELECT seat, side, user_id FROM board_players ORDER BY seat')).toEqual([
      { seat: 'E', side: 'EW', user_id: null },
      { seat: 'N', side: 'NS', user_id: 'amy' },
      { seat: 'S', side: 'NS', user_id: 'ben' },
      { seat: 'W', side: 'EW', user_id: 'cat' },
    ])
  })

  it('leaves the contract empty for a passed-out board and no declarer for a robot', () => {
    const sql = fresh()
    indexRecord(sql, record('out', 1, AMY_BEN))
    indexRecord(sql, record('bot', 2, AMY_BEN, { level: 3, strain: 'N', doubled: '', declarer: 'E' }))
    expect(sql.exec('SELECT board_id, level, strain, doubled, declarer_seat, declarer_user, tricks FROM boards_index ORDER BY played_at')).toEqual([
      { board_id: 'out', level: null, strain: null, doubled: 0, declarer_seat: null, declarer_user: null, tricks: null },
      { board_id: 'bot', level: 3, strain: 'N', doubled: 0, declarer_seat: 'E', declarer_user: null, tricks: 10 },
    ])
  })

  it('can index a board again, or creates its tables again, without changing anything', () => {
    const sql = fresh()
    createHistoryIndex(sql)
    const board = record('b1', 100, AMY_BEN)
    indexRecord(sql, board)
    indexRecord(sql, { ...board, players: { ...board.players, W: { id: 'dan', username: 'dan' } } })
    expect(sql.exec('SELECT COUNT(*) AS n FROM boards_index')).toEqual([{ n: 1 }])
    expect(sql.exec("SELECT user_id FROM board_players WHERE seat = 'W'")).toEqual([{ user_id: 'dan' }])
    unindexRecord(sql, 'b1')
    expect(sql.exec('SELECT COUNT(*) AS n FROM board_players')).toEqual([{ n: 0 }])
  })

  it('answers who played and who played with whom, newest first', () => {
    const sql = fresh()
    indexRecord(sql, record('b1', 100, AMY_BEN))
    // Amy and Ben on opposite sides
    indexRecord(sql, record('b2', 200, { N: 'amy', E: 'ben', S: 'cat', W: 'dan' }))
    indexRecord(sql, record('b3', 300, { N: 'cat', E: 'dan', S: 'robot:tku:S', W: 'ben' }))
    expect(boardsPlayedBy(sql, 'amy')).toEqual(['b2', 'b1'])
    expect(boardsPlayedBy(sql, 'ben')).toEqual(['b3', 'b2', 'b1'])
    expect(boardsPlayedWith(sql, 'amy', 'ben', true)).toEqual(['b1'])
    expect(boardsPlayedWith(sql, 'amy', 'ben', false)).toEqual(['b2', 'b1'])
    expect(boardsPlayedWith(sql, 'ben', 'dan', true)).toEqual(['b3', 'b2'])
    expect(boardsPlayedWith(sql, 'amy', 'amy', false)).toEqual([])
  })

  it('writes a board all or nothing', () => {
    const real = fresh()
    const failing: Sql = {
      ...real,
      exec: (query, ...params) => {
        if (query.startsWith('INSERT INTO board_players') && params[1] === 'W') throw new Error('disk full')
        return real.exec(query, ...params)
      },
    }
    expect(() => indexRecord(failing, record('b1', 100, AMY_BEN))).toThrow('disk full')
    expect(real.exec('SELECT COUNT(*) AS n FROM boards_index')).toEqual([{ n: 0 }])
    expect(real.exec('SELECT COUNT(*) AS n FROM board_players')).toEqual([{ n: 0 }])
  })
})
