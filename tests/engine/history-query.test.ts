import { describe, expect, it } from 'vitest'
import {
  DEFAULT_HISTORY_QUERY,
  datePresetOf,
  datePresetRange,
  readHistoryQuery,
  taiwanDate,
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

describe('the history page address', () => {
  it('keeps what it understands and drops the rest', () => {
    const query = readHistoryQuery(new URLSearchParams('level=4&strain=Z&colour=red&sort=score_desc&from=2026-10-20&to=2026-10-01'))
    expect(query).toEqual({ ...DEFAULT_HISTORY_QUERY, level: 4, sort: 'score_desc', from: '2026-10-20' })
  })

  it('round-trips through the query string', () => {
    const query = { ...DEFAULT_HISTORY_QUERY, scope: 'all' as const, declarerSide: 'partner' as const, partner: 'u1', vul: 'NS' as const, page: 3 }
    expect(readHistoryQuery(new URLSearchParams(historyQueryString(query)))).toEqual(query)
  })
})

describe('quick date ranges (Taiwan time)', () => {
  // Wednesday 2026-10-21 at 01:00 in Taiwan is still Tuesday in UTC
  const now = Date.parse('2026-10-20T17:00:00Z')

  it('know the Taiwan date', () => {
    expect(taiwanDate(now)).toBe('2026-10-21')
    expect(taiwanDate(Date.parse('2026-10-20T15:59:59Z'))).toBe('2026-10-20')
  })

  it('give today, this week from Monday and this month', () => {
    expect(datePresetRange('today', now)).toEqual({ from: '2026-10-21', to: '2026-10-21' })
    expect(datePresetRange('week', now)).toEqual({ from: '2026-10-19', to: '2026-10-21' })
    expect(datePresetRange('month', now)).toEqual({ from: '2026-10-01', to: '2026-10-21' })
    // A Sunday belongs to the week that started the Monday before
    expect(datePresetRange('week', Date.parse('2026-10-25T04:00:00Z'))).toEqual({ from: '2026-10-19', to: '2026-10-25' })
  })

  it('recognise a range that is one of them', () => {
    expect(datePresetOf({ from: '2026-10-19', to: '2026-10-21' }, now)).toBe('week')
    expect(datePresetOf({ from: '2026-10-18', to: '2026-10-21' }, now)).toBeUndefined()
    expect(datePresetOf({ from: '2026-10-19' }, now)).toBeUndefined()
  })
})
