// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { mitchell } from '../../shared/movement.ts'
import { scorePairs, type PairsResult } from '../../shared/pairs.ts'
import { delayOf, parseRefereeRequest, penalizedMatch, penaltiesOf, refereeNotes, type RefereeAction, type RefereeEntry } from '../../shared/referee.ts'

/** `shared/referee.ts` and the director's rulings and penalties in the pairs scoring (`e9-t17`) */

const result = (boardNo: number, ns: number, ew: number, scoreNS: number, extra: Partial<PairsResult> = {}): PairsResult => ({
  round: 1,
  table: ns + 1,
  boardNo,
  ns,
  ew,
  boardId: `b${boardNo}-${ns}`,
  scoreNS,
  contract: null,
  declarerTricks: null,
  playedAt: 0,
  ...extra,
})

const entry = (id: string, action: RefereeAction): RefereeEntry => ({ id, at: 1, by: 'td', reason: 'why', ...action })

describe('pairs scoring with the director (e9-t17)', () => {
  // 6 pairs, 3 tables: every board played 3 times (top 4)
  const movement = mitchell(6, 1)!

  it('compares an assigned score as if played', () => {
    const { scored } = scorePairs(movement, [result(1, 0, 3, 0), result(1, 1, 4, 420), result(1, 2, 5, -50)], {
      rulingOf: (id) => (id === 'b1-0' ? { kind: 'score', scoreNS: 620 } : undefined),
    })
    expect(scored.map((s) => s.mpNS)).toEqual([4, 2, 0])
    expect(scored[0].ruling).toEqual({ kind: 'score', scoreNS: 620 })
  })

  it('gives Avg+/Avg- as 60/40% and leaves them out of the others’ comparison (Neuberg over the rest)', () => {
    const { scored } = scorePairs(movement, [
      result(1, 0, 3, 0, { boardId: '', ruling: { kind: 'avgPlus', side: 'EW' } }),
      result(1, 1, 4, 420),
      result(1, 2, 5, -50),
    ])
    // Avg+ for EW is 40% for NS
    expect(scored[0].percentNS).toBe(40)
    expect(scored[0].percentEW).toBe(60)
    // The other two compared with each other only: (2 + 1) × 3/2 − 1 = 3.5 of 4
    expect(scored[1].mpNS).toBeCloseTo(3.5)
    expect(scored[2].mpNS).toBeCloseTo(0.5)
  })

  it('takes a penalty off the pair’s matchpoints and its percentage, and re-ranks', () => {
    const results = [result(1, 0, 3, 420), result(1, 1, 4, 420), result(1, 2, 5, -50)]
    const { standings } = scorePairs(movement, results, { penalties: new Map([[0, 1]]) })
    const ns = standings.filter((s) => s.dir === 'NS')
    expect(ns.map((s) => [s.pair, s.rank, s.mp, s.percent, s.penalty])).toEqual([
      [1, 1, 3, 75, undefined],
      [0, 2, 2, 50, 1],
      [2, 3, 0, 0, undefined],
    ])
  })
})

describe('the director’s log (shared/referee.ts)', () => {
  it('reads requests and refuses what is not one', () => {
    expect(parseRefereeRequest({ action: 'penalty', target: 'A', amount: 1.25, reason: ' 遲到 ' })).toEqual({
      action: 'penalty',
      target: 'A',
      amount: 1.3,
      reason: '遲到',
    })
    expect(parseRefereeRequest({ action: 'penalty', target: 'A', amount: 0, reason: 'x' })).toBeNull()
    expect(parseRefereeRequest({ action: 'penalty', target: 'A', amount: 2000, reason: 'x' })).toBeNull()
    expect(parseRefereeRequest({ action: 'delay', minutes: 241, reason: 'x' })).toBeNull()
    expect(parseRefereeRequest({ action: 'delay', minutes: 0, reason: 'x' })).toEqual({ action: 'delay', minutes: 0, reason: 'x' })
    expect(parseRefereeRequest({ action: 'restart', table: 2, replay: [3, 3], reason: 'x' })).toEqual({
      action: 'restart',
      table: 2,
      replay: [3],
      reason: 'x',
    })
    expect(parseRefereeRequest({ action: 'score', table: 1, boardNo: 2, ruling: { kind: 'avgPlus', reason: 'x' } })).toBeNull()
    expect(parseRefereeRequest({ action: 'score', boardId: 'b1', ruling: null })).toEqual({ action: 'score', boardId: 'b1', ruling: null })
    expect(parseRefereeRequest({ action: 'withdraw', of: 'p1' })).toBeNull()
  })

  it('adds up the penalties in force, finds the delay, and marks what was taken back', () => {
    const entries = [
      entry('p1', { action: 'penalty', target: 'A', amount: 3 }),
      entry('p2', { action: 'penalty', target: 'A', amount: 1.5 }),
      entry('d1', { action: 'delay', until: 500 }),
      entry('w1', { action: 'withdraw', of: 'p1' }),
    ]
    expect(penaltiesOf(entries)).toEqual(new Map([['A', 1.5]]))
    expect(delayOf(entries)).toBe(500)
    expect(delayOf([...entries, entry('d2', { action: 'delay', until: null })])).toBeNull()
    const notes = refereeNotes(entries, (id) => ({ id, username: 'TD' }))
    expect(notes.map((n) => [n.id, n.withdrawn, n.by.username])).toEqual([
      ['p1', true, 'TD'],
      ['p2', undefined, 'TD'],
      ['d1', undefined, 'TD'],
      ['w1', undefined, 'TD'],
    ])
    expect(penalizedMatch({ totals: { A: 2, B: 0 }, leader: 'A' as const }, penaltiesOf(entries))).toEqual({
      totals: { A: 0.5, B: 0 },
      leader: 'A',
      penalties: { A: 1.5 },
    })
  })
})
