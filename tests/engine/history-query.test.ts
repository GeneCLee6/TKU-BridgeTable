import { describe, expect, it } from 'vitest'
import {
  DEFAULT_HISTORY_QUERY,
  historyQueryString,
  parseHistoryQuery,
  taiwanDayEnd,
  taiwanDayStart,
} from '../../shared/history-query.ts'
import { AppError } from '../../shared/messages.ts'

const parse = (query: string) => parseHistoryQuery(new URLSearchParams(query))
const fieldOf = (query: string) => {
  try {
    parse(query)
  } catch (error) {
    if (error instanceof AppError && error.code === 'badHistoryQuery') return error.params.field
    throw error
  }
  return null
}

describe('history queries', () => {
  it('default to my boards, newest first, 20 a page', () => {
    expect(parse('')).toEqual(DEFAULT_HISTORY_QUERY)
    expect(DEFAULT_HISTORY_QUERY).toEqual({ scope: 'mine', sort: 'date_desc', page: 1, size: 20 })
  })

  it('read every condition from the query string', () => {
    expect(
      parse(
        'scope=all&level=4&strain=S&doubled=doubled&bracket=game&declarer=u1&declarerSeat=N&declarerSide=partner' +
          '&player=u2&partner=u3&from=2026-10-01&to=2026-10-31&result=made&vul=Both&boardNo=7&table=2&mode=casual' +
          '&sort=score_desc&page=3&size=50',
      ),
    ).toEqual({
      scope: 'all',
      level: 4,
      strain: 'S',
      doubled: 'doubled',
      bracket: 'game',
      declarer: 'u1',
      declarerSeat: 'N',
      declarerSide: 'partner',
      player: 'u2',
      partner: 'u3',
      from: '2026-10-01',
      to: '2026-10-31',
      result: 'made',
      vul: 'Both',
      boardNo: 7,
      table: 2,
      mode: 'casual',
      sort: 'score_desc',
      page: 3,
      size: 50,
    })
  })

  it('name the first parameter that is wrong or unknown', () => {
    expect(fieldOf('level=8')).toBe('level')
    expect(fieldOf('level=4.5')).toBe('level')
    expect(fieldOf('strain=NT')).toBe('strain')
    expect(fieldOf('size=7')).toBe('size')
    expect(fieldOf('page=0')).toBe('page')
    expect(fieldOf('from=2026-02-30x')).toBe('from')
    expect(fieldOf('from=2026-10-31&to=2026-10-01')).toBe('from')
    expect(fieldOf("declarer=a'b")).toBe('declarer')
    expect(fieldOf('colour=red')).toBe('colour')
    expect(fieldOf('scope=all&level=4')).toBeNull()
  })

  it('write a query string that reads back the same, without the defaults', () => {
    const query = { ...DEFAULT_HISTORY_QUERY, level: 3, strain: 'N' as const, from: '2026-10-01', page: 2 }
    const text = historyQueryString(query)
    expect(text).toBe('level=3&strain=N&from=2026-10-01&page=2')
    expect(parse(text)).toEqual(query)
    expect(historyQueryString(DEFAULT_HISTORY_QUERY)).toBe('')
  })

  it('count days in Taiwan time', () => {
    expect(new Date(taiwanDayStart('2026-10-24')).toISOString()).toBe('2026-10-23T16:00:00.000Z')
    expect(taiwanDayEnd('2026-10-24') - taiwanDayStart('2026-10-24')).toBe(86_400_000)
  })
})
