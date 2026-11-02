import { describe, expect, it } from 'vitest'
import {
  DEFAULT_POINTS_RULES,
  parsePointsRules,
  periodOf,
  placePoints,
  rankRows,
  seasonAt,
  shiftMonth,
  taiwanMonth,
} from '../../shared/points.ts'

/** Club points (`e9-t04`, `e9-t06`, AC-9.2): the rule, the admins' settings and the periods */

const rule = { enabled: true, participation: 1, perBeaten: 2, minSides: 2 }

describe('placePoints', () => {
  it('gives participation plus the sides beaten; ties beat the same sides', () => {
    const points = placePoints(rule, [
      { userIds: ['a'], rank: 1 },
      { userIds: ['b'], rank: 2 },
      { userIds: ['c'], rank: 2 },
      { userIds: ['d'], rank: 4 },
    ])
    expect(points).toEqual([
      { userId: 'a', rank: 1, field: 4, points: 7 },
      { userId: 'b', rank: 2, field: 4, points: 3 },
      { userId: 'c', rank: 2, field: 4, points: 3 },
      { userId: 'd', rank: 4, field: 4, points: 1 },
    ])
  })

  it('gives every member of a side the whole of it; a side with no members still counts', () => {
    const points = placePoints(rule, [
      { userIds: ['a', 'b'], rank: 1 },
      { userIds: [], rank: 2 },
    ])
    expect(points.map((p) => [p.userId, p.points])).toEqual([
      ['a', 3],
      ['b', 3],
    ])
  })

  it('gives nothing when the rule is off or the field is too small', () => {
    const sides = [
      { userIds: ['a'], rank: 1 },
      { userIds: ['b'], rank: 2 },
    ]
    expect(placePoints({ ...rule, enabled: false }, sides)).toEqual([])
    expect(placePoints({ ...rule, minSides: 3 }, sides)).toEqual([])
  })

  it('a friends’ challenge needs three by default', () => {
    expect(DEFAULT_POINTS_RULES.kinds.challenge.minSides).toBe(3)
  })
})

describe('parsePointsRules', () => {
  it('changes only what is sent', () => {
    const parsed = parsePointsRules({ kinds: { daily: { perBeaten: 2.25 } } })
    expect('rules' in parsed && parsed.rules.kinds.daily).toEqual({ ...DEFAULT_POINTS_RULES.kinds.daily, perBeaten: 2.3 })
    expect('rules' in parsed && parsed.rules.kinds.weekly).toEqual(DEFAULT_POINTS_RULES.kinds.weekly)
  })

  it('refuses unknown kinds and fields and numbers out of range', () => {
    expect(parsePointsRules({ kinds: { poker: {} } })).toEqual({ field: 'poker' })
    expect(parsePointsRules({ kinds: { daily: { bonus: 1 } } })).toEqual({ field: 'daily' })
    expect(parsePointsRules({ kinds: { daily: { perBeaten: -1 } } })).toEqual({ field: 'daily' })
    expect(parsePointsRules({ kinds: { daily: { minSides: 1 } } })).toEqual({ field: 'daily' })
    expect(parsePointsRules({ other: 1 })).toEqual({ field: 'other' })
    expect(parsePointsRules([])).toEqual({ field: 'rules' })
  })

  it('takes seasons, sorted, and refuses bad dates or a repeated id', () => {
    const parsed = parsePointsRules({
      seasons: [
        { id: 'b', name: ' 下學期 ', from: '2027-02-01', to: '2027-07-31' },
        { id: 'a', name: '上學期', from: '2026-09-01', to: '2027-01-31' },
      ],
    })
    expect('rules' in parsed && parsed.rules.seasons.map((s) => [s.id, s.name])).toEqual([
      ['a', '上學期'],
      ['b', '下學期'],
    ])
    expect(parsePointsRules({ seasons: [{ id: 'a', name: 'x', from: '2026-09-01', to: '2026-08-01' }] })).toEqual({ field: 'seasons' })
    expect(parsePointsRules({ seasons: [{ id: 'a', name: 'x', from: '2026-13-01', to: '2026-14-01' }] })).toEqual({ field: 'seasons' })
    const same = { id: 'a', name: 'x', from: '2026-09-01', to: '2026-10-01' }
    expect(parsePointsRules({ seasons: [same, same] })).toEqual({ field: 'seasons' })
  })
})

describe('periods (Taiwan time)', () => {
  /** 2026-11-01 00:00 in Taiwan */
  const NOV = Date.UTC(2026, 9, 31, 16)

  it('a month runs from its first midnight in Taiwan to the next month’s', () => {
    expect(periodOf({ month: '2026-11' }, [])).toEqual({ kind: 'month', key: '2026-11', from: NOV, to: Date.UTC(2026, 10, 30, 16) })
    expect(taiwanMonth(NOV)).toBe('2026-11')
    expect(taiwanMonth(NOV - 1)).toBe('2026-10')
    expect(periodOf({ month: '2026-13' }, [])).toBeNull()
  })

  it('a year is the calendar year; a season includes both its dates', () => {
    expect(periodOf({ year: '2027' }, [])).toMatchObject({ from: Date.UTC(2026, 11, 31, 16), to: Date.UTC(2027, 11, 31, 16) })
    const seasons = [{ id: 'a', name: '上學期', from: '2026-09-01', to: '2027-01-31' }]
    expect(periodOf({ season: 'a' }, seasons)).toEqual({
      kind: 'season',
      key: 'a',
      name: '上學期',
      from: Date.UTC(2026, 7, 31, 16),
      to: Date.UTC(2027, 0, 31, 16),
    })
    expect(seasonAt(NOV, seasons)?.id).toBe('a')
    expect(seasonAt(Date.UTC(2027, 0, 31, 16), seasons)).toBeUndefined()
    expect(periodOf({ season: 'b' }, seasons)).toBeNull()
  })

  it('steps months across years', () => {
    expect(shiftMonth('2026-12', 1)).toBe('2027-01')
    expect(shiftMonth('2026-01', -1)).toBe('2025-12')
  })
})

describe('rankRows', () => {
  it('shares places on equal points and skips the next', () => {
    const rows = rankRows([
      { userId: 'b', points: 3, events: 1 },
      { userId: 'a', points: 5, events: 2 },
      { userId: 'c', points: 3, events: 2 },
      { userId: 'd', points: 1, events: 1 },
    ])
    expect(rows.map((r) => [r.userId, r.rank])).toEqual([
      ['a', 1],
      ['c', 2],
      ['b', 2],
      ['d', 4],
    ])
  })
})
