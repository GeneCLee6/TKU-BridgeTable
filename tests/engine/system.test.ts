import { describe, expect, it } from 'vitest'
import type { AuctionCall } from '../../shared/auction.ts'
import { nextSeat, type Card, type Seat } from '../../shared/cards.ts'
import { contextOf, emptyReading, fitsPattern, patternProblem, tokens } from '../../shared/robot/system/context.ts'
import { choose } from '../../shared/robot/system/engine.ts'
import { evaluate, fits, keycards } from '../../shared/robot/system/evaluate.ts'
import { ANY, type System } from '../../shared/robot/system/spec.ts'

/** A hand from text like 'AKQ2 KJ3 Q54 32' (♠ ♥ ♦ ♣; '-' for a void) */
function hand(text: string): Card[] {
  return text.split(' ').flatMap((ranks, i) => [...ranks.replace('-', '')].map((r) => 'SHDC'[i] + r))
}

function auctionOf(calls: string, dealer: Seat = 'N'): AuctionCall[] {
  return calls
    .split(' ')
    .filter(Boolean)
    .map((call, i) => ({ seat: nextSeat(dealer, i), call }))
}

describe('GIB hand features', () => {
  it('counts total points: void 3, singleton 2, doubleton 1, one less with points in it', () => {
    expect(evaluate(hand('AKJ32 KQ32 432 -')).tp).toBe(13 + 3)
    expect(evaluate(hand('AKJ32 KQ32 4 432')).tp).toBe(13 + 2)
    expect(evaluate(hand('AKJ32 KQ32 K 432')).tp).toBe(16 + 1)
    expect(evaluate(hand('AKJ3 KQ32 43 432')).tp).toBe(13 + 1)
    expect(evaluate(hand('AKJ3 KQ32 Q3 432')).tp).toBe(15)
  })

  it('grades suits from biddable to solid', () => {
    const q = (text: string) => evaluate(hand(text)).quality.S
    expect(q('8432 AKQ 432 432')).toBeNull()
    expect(q('K432 AKQ 432 432')).toBe('biddable')
    expect(q('QJT2 AKQ 432 432')).toBe('biddable')
    expect(q('Q8432 AK 432 432')).toBe('biddable')
    expect(q('K8432 AK 432 432')).toBe('rebiddable')
    expect(q('986432 AK 432 43')).toBe('rebiddable')
    expect(q('K86432 AK 432 43')).toBe('twiceRebiddable')
    expect(q('KQJ432 AK 432 43')).toBe('twiceRebiddable')
    expect(q('KQJT32 AK 432 43')).toBe('strongRebiddable')
    expect(q('AKQ432 AK 432 43')).toBe('strongRebiddable')
    expect(q('AKQJ32 AK 432 43')).toBe('solid')
    expect(q('AKQ5432 AK 43 43')).toBe('solid')
  })

  it('grades stoppers from length plus points', () => {
    const s = (text: string) => evaluate(hand(text)).stop.S
    expect(s('32 AKQ2 Q432 432')).toBeNull()
    expect(s('Q2 AKQ2 Q432 432')).toBe('partial')
    expect(s('J32 AKQ2 Q43 432')).toBe('partial')
    expect(s('K2 AKQ2 Q432 432')).toBe('likely')
    expect(s('Q32 AKQ2 Q43 432')).toBe('likely')
    expect(s('A2 KQ32 Q432 432')).toBe('stop')
    expect(s('QJ2 AKQ2 Q43 432')).toBe('stop')
    expect(s('K432 AKQ Q43 432')).toBe('stop')
    expect(s('KJ32 AKQ Q43 432')).toBe('double')
  })

  it('counts controls, losers, keycards and the balanced shapes', () => {
    const h = evaluate(hand('AK32 K32 Q32 J32'))
    expect(h.controls).toBe(4)
    expect(h.losers).toBe(1 + 2 + 2 + 3)
    expect(h.balanced).toBe(true)
    expect(keycards(h, 'S')).toBe(2)
    expect(keycards(h, 'H')).toBe(2)
    expect(evaluate(hand('AK32 KQ32 Q432 2')).balanced).toBe(false)
    expect(evaluate(hand('AK432 Q32 Q32 32')).balanced).toBe(true)
  })

  it('checks a hand against what a call needs', () => {
    const h = evaluate(hand('AKJ32 K32 Q32 32'))
    expect(fits(h, { hcp: [11, 21], len: { S: [5, 13] } })).toBe(true)
    expect(fits(h, { hcp: [15, 17], balanced: true })).toBe(false)
    expect(fits(h, { quality: { S: 'rebiddable' } })).toBe(true)
    expect(fits(h, { quality: { S: 'solid' } })).toBe(false)
    expect(fits(h, { stop: { D: 'likely' } })).toBe(true)
    expect(fits(h, { stop: { C: 'partial' } })).toBe(false)
    expect(fits(h, { trump: 'S', keycards: [1, 4] })).toBe(false)
    expect(fits(h, { trump: 'S', keycards: [2, 5], trumpQueen: false })).toBe(true)
    expect(fits(h, { tp: [0, ANY] })).toBe(true)
  })
})

describe('auction patterns', () => {
  it('write the auction from the opening bid, the opponents in brackets', () => {
    const ctx = contextOf('S', auctionOf('P 1N P', 'W'), 'W', 'None', emptyReading())
    // West passed, North opened 1NT, East passed: South is responding
    expect(ctx.key).toEqual(['1N', '(P)'])
    expect(ctx.opening?.role).toBe('partner')
    expect(ctx.position).toBe(2)
    expect(ctx.passed).toBe(false)
    const balancing = contextOf('E', auctionOf('1H P P', 'S'), 'S', 'None', emptyReading())
    expect(balancing.key).toEqual(['(1H)', 'P', '(P)'])
    const third = contextOf('N', auctionOf('P P', 'S'), 'S', 'None', emptyReading())
    expect(third.key).toEqual([])
    expect(third.position).toBe(3)
    expect(contextOf('N', auctionOf('P P P 1S P'), 'N', 'None', emptyReading()).passed).toBe(true)
  })

  it('match exact calls and the wildcards', () => {
    const key = ['1H', '(2C)', 'X', '(P)']
    expect(fitsPattern(tokens('1H (2C) X (P)'), key)).toBe(true)
    expect(fitsPattern(tokens('1H (+) X (P)'), key)).toBe(true)
    expect(fitsPattern(tokens('1H (*) * (*)'), key)).toBe(true)
    expect(fitsPattern(tokens('1H (P) X (P)'), key)).toBe(false)
    expect(fitsPattern(tokens('1H (+) X (+)'), key)).toBe(false)
    expect(fitsPattern(tokens('1H (2C) X'), key)).toBe(false)
    expect(fitsPattern(tokens(''), [])).toBe(true)
  })

  it('reject patterns with the opponents in the wrong place', () => {
    expect(patternProblem('1N (P) 2C (P)')).toBeNull()
    expect(patternProblem('(1H) X (P)')).toBeNull()
    expect(patternProblem('')).toBeNull()
    expect(patternProblem('1N P')).toMatch(/theirs/)
    expect(patternProblem('(1N) (P)')).toMatch(/ours/)
    expect(patternProblem('1N (P) 9C (P)')).toMatch(/not a call/)
  })
})

describe('choosing a call', () => {
  const toy: System = {
    id: 'gib',
    books: [
      {
        after: '',
        rules: [
          { call: '1N', shows: { hcp: [15, 17], balanced: true } },
          { call: '1S', shows: { hcp: [11, 21], len: { S: [5, 13] } } },
          { call: '1C', shows: { hcp: [11, 21] }, when: (h) => h.len.C >= 3 },
        ],
      },
      {
        after: '1N (P)',
        rules: [
          { call: '2C', shows: { name: 'stayman', hcp: [8, ANY], artificial: true }, when: (h) => h.len.H >= 4 || h.len.S >= 4 },
          { call: '3N', shows: { hcp: [10, 15] } },
        ],
      },
      // A rule that would underbid: skipped as illegal
      { after: '(+)', rules: [{ call: '1S' }] },
    ],
  }
  const pick = (cards: string, calls: string, dealer: Seat = 'N') => {
    const auction = auctionOf(calls, dealer)
    return choose(toy, hand(cards), nextSeat(dealer, auction.length), auction, dealer)
  }

  it('takes the first rule the hand fits, with what that rule shows', () => {
    expect(pick('AQ2 KJ3 Q54 K432', '')).toEqual({ call: '1N', shows: { hcp: [15, 17], balanced: true } })
    expect(pick('AKJ32 K32 Q32 32', '').call).toBe('1S')
    expect(pick('A32 K32 Q432 K32', '').call).toBe('1C')
  })

  it('passes when no rule fits', () => {
    expect(pick('932 832 Q432 432', '')).toEqual({ call: 'P' })
    expect(pick('932 832 Q432 432', '1N P').call).toBe('P')
  })

  it('uses the book for the auction', () => {
    expect(pick('KJ32 Q43 Q54 Q32', '1N P').call).toBe('2C')
    expect(pick('K32 Q43 KJ54 Q32', '1N P').call).toBe('3N')
    // An opponent's overcall leaves the 1NT book
    expect(pick('KJ32 Q43 Q54 Q32', '1N 2D').call).toBe('P')
  })

  it('never makes an illegal call', () => {
    expect(pick('AKJ32 K32 Q32 32', '2S').call).toBe('P')
  })

  it('in a first-fit system, passes when the rule the hand fits names an illegal call', () => {
    const list: System = {
      id: 'tku',
      firstFit: true,
      books: [{ rules: [{ call: '1S', needs: {}, when: (h) => h.len.S >= 5 }, { call: '2S', needs: {} }] }],
    }
    const after = (calls: string) => {
      const auction = auctionOf(calls, 'N')
      return choose(list, hand('AKJ32 K32 Q32 32'), nextSeat('N', auction.length), auction, 'N').call
    }
    expect(after('')).toBe('1S')
    // 1♠ is not legal over 1NT: the first rule that fits still decides, so the robot passes
    expect(after('1N')).toBe('P')
    expect(choose({ ...list, firstFit: false }, hand('AKJ32 K32 Q32 32'), 'E', auctionOf('1N', 'N'), 'N').call).toBe('2S')
  })
})
