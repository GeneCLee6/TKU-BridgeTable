import { describe, expect, it } from 'vitest'
import type { AuctionCall } from '../../shared/auction.ts'
import type { Vulnerability } from '../../shared/board.ts'
import { nextSeat, type Card, type Seat } from '../../shared/cards.ts'
import { patternProblem } from '../../shared/robot/system/context.ts'
import { describe as words } from '../../shared/robot/system/describe.ts'
import { choose, explain } from '../../shared/robot/system/engine.ts'
import { GIB } from '../../shared/robot/system/gib/index.ts'

/** A hand from text like 'AKQ2 KJ3 Q54 32' (♠ ♥ ♦ ♣; '-' for a void) */
function hand(text: string): Card[] {
  const cards = text.split(' ').flatMap((ranks, i) => [...ranks.replace('-', '')].map((r) => 'SHDC'[i] + r))
  if (cards.length !== 13) throw new Error(`${text} has ${cards.length} cards`)
  return cards
}

function auctionOf(calls: string, dealer: Seat): AuctionCall[] {
  return calls
    .split(' ')
    .filter(Boolean)
    .map((call, i) => ({ seat: nextSeat(dealer, i), call }))
}

/** The 2/1 robot's call with this hand after these calls (the first by `dealer`) */
function bidOver(cards: string, calls: string, dealer: Seat = 'N', vul: Vulnerability = 'None') {
  const auction = auctionOf(calls, dealer)
  return choose(GIB, hand(cards), nextSeat(dealer, auction.length), auction, dealer, vul).call
}

/** How the 2/1 robot explains `call` made after these calls, in Traditional Chinese */
function meaning(calls: string, call: string, dealer: Seat = 'N', lang: 'zh' | 'en' = 'zh') {
  const spec = explain(GIB, auctionOf(calls, dealer), dealer).get(call)
  return spec ? words(spec, lang) : undefined
}

describe('the 2/1 books', () => {
  it('write every auction pattern with the opponents in the right places', () => {
    for (const book of GIB.books) {
      const after = book.after === undefined ? [] : typeof book.after === 'string' ? [book.after] : book.after
      for (const pattern of after) expect(patternProblem(pattern), pattern).toBeNull()
    }
  })
})

describe('openings (§1)', () => {
  it('1NT 15–17 balanced, a five-card major allowed, but 17 with one opens the major', () => {
    expect(bidOver('AQ2 KJ3 Q54 K432', '')).toBe('1N')
    expect(bidOver('AQ432 KJ3 Q5 K32', '')).toBe('1N')
    expect(bidOver('AQ432 KQ3 K5 K32', '')).toBe('1S')
  })

  it('2NT 20–21 balanced and 2♣ with 22 or more', () => {
    expect(bidOver('AK2 AQ3 KQ54 K32', '')).toBe('2N')
    expect(bidOver('AKQ2 AK3 KQ5 A32', '')).toBe('2C')
  })

  it('five-card majors, spades with 5-5, a longer minor first', () => {
    expect(bidOver('AK432 KQ432 32 2', '')).toBe('1S')
    expect(bidOver('AK432 2 32 KQ432', '')).toBe('1S')
    expect(bidOver('AK432 KQ5432 32 -', '')).toBe('1H')
    expect(bidOver('2 AK432 2 KQ5432', '')).toBe('1C')
  })

  it('the minors: 1♦ with 4-4 and with 4432, 1♣ with 3-3 and 4423', () => {
    expect(bidOver('AK32 KQ32 432 32', '')).toBe('1D')
    expect(bidOver('AK32 KQ32 32 432', '')).toBe('1C')
    expect(bidOver('AK32 Q32 K32 Q32', '')).toBe('1C')
    expect(bidOver('A2 K32 KQ32 Q432', '')).toBe('1D')
  })

  it('opens 11 points only with the Rule of 20', () => {
    expect(bidOver('KQ432 AQ32 32 32', '')).toBe('1S')
    expect(bidOver('KQ32 AJ2 J32 432', '')).toBe('P')
  })

  it('opens lighter in third seat, and in fourth seat with the Rule of 15', () => {
    expect(bidOver('AQJ32 K32 432 32', '')).toBe('P')
    expect(bidOver('AQJ32 K32 432 32', 'P P')).toBe('1S')
    expect(bidOver('AK32 KQ2 32 5432', 'P P P')).toBe('1C')
    expect(bidOver('2 KQ32 AK32 5432', 'P P P')).toBe('P')
  })

  it('weak twos are disciplined: six cards, good honours, no side major', () => {
    expect(bidOver('KQJ932 32 432 32', '')).toBe('2S')
    expect(bidOver('32 32 KQJ932 432', '')).toBe('2D')
    expect(bidOver('J98632 K32 Q32 2', '')).toBe('P')
    expect(bidOver('KQJ932 K432 32 2', '')).toBe('P')
    // Not in fourth seat
    expect(bidOver('KQJ932 32 432 32', 'P P P')).toBe('P')
  })

  it('preempts with seven cards at the three level, eight in a major at the four level', () => {
    expect(bidOver('KQJ9532 32 432 2', '')).toBe('3S')
    expect(bidOver('2 KQJ98532 32 32', '')).toBe('4H')
    expect(bidOver('32 2 432 KQJ9532', '')).toBe('3C')
  })

  it('explains each opening the way GIB does', () => {
    expect(meaning('', '1S')).toBe('5+ 張♠，11–21 大牌點，12–22 總點')
    expect(meaning('', '1S', 'N', 'en')).toBe('5+ ♠; 11–21 HCP; 12–22 total points')
    expect(meaning('', '1C')).toBe('3+ 張♣，11–21 大牌點，12–22 總點')
    expect(meaning('', '1N')).toBe('15–17 大牌點，平均牌型')
    expect(meaning('', '2C')).toBe('強 2♣：22+ 大牌點，迫叫一圈')
    expect(meaning('', '2S')).toBe('弱二：6 張♠，♠ 可兩次再叫，5–10 大牌點')
    expect(meaning('', 'P')).toBe('0–11 大牌點')
    // A third-seat opening may be a point lighter
    expect(meaning('P P', '1S')).toBe('5+ 張♠，10–21 大牌點，11–22 總點')
  })
})
