import { describe, expect, it } from 'vitest'
import type { AuctionCall } from '../../shared/auction.ts'
import { nextSeat, type Card, type Seat } from '../../shared/cards.ts'
import { robotCall } from '../../shared/robot/robots.ts'
import { describe as words } from '../../shared/robot/system/describe.ts'
import { explain } from '../../shared/robot/system/engine.ts'
import { TKU } from '../../shared/robot/system/tku/index.ts'
import { slamNeeds } from '../../shared/robot/system/tku/majorSlam.ts'

/** A hand from text like 'AKQ2 KJ3 Q54 32' (♠ ♥ ♦ ♣; '-' for a void) */
function hand(text: string): Card[] {
  return text.split(' ').flatMap((ranks, i) => [...ranks.replace('-', '')].map((r) => 'SHDC'[i] + r))
}

const auctionOf = (calls: string, dealer: Seat = 'N'): AuctionCall[] =>
  calls
    .split(' ')
    .filter(Boolean)
    .map((call, i) => ({ seat: nextSeat(dealer, i), call }))

/** The club's robot's call after the given calls, the first by North */
function bidOver(cards: Card[], calls: string) {
  const auction = auctionOf(calls)
  return robotCall('tku', cards, nextSeat('N', auction.length), auction, 'N', 'None').call
}

/** What a call made after these calls means to the club's robots */
const reads = (calls: string, call: string, lang: 'zh' | 'en' = 'zh') => {
  const spec = explain(TKU, auctionOf(calls), 'N').get(call)
  return spec ? words(spec, lang) : undefined
}

describe('J2N: opener shows shape (e5-t36)', () => {
  it('1♠–2NT: a singleton, a balanced range, 5422, a void', () => {
    expect(bidOver(hand('AKJ32 K43 A543 2'), '1S P 2N P')).toBe('3C')
    expect(bidOver(hand('AKJ32 K43 A5 432'), '1S P 2N P')).toBe('3D')
    expect(bidOver(hand('AKJ32 2 K43 A543'), '1S P 2N P')).toBe('3H')
    // Balanced: 12–14 3♣, 15–17 3♦, 18–19 3♥ (a sixth spade counts one)
    expect(bidOver(hand('AKJ32 K43 Q54 32'), '1S P 2N P')).toBe('3C')
    expect(bidOver(hand('AKJ32 K43 A54 32'), '1S P 2N P')).toBe('3D')
    expect(bidOver(hand('AKJ32 KQ3 A54 Q2'), '1S P 2N P')).toBe('3H')
    expect(bidOver(hand('AKJ432 K43 Q5 32'), '1S P 2N P')).toBe('3C')
    expect(bidOver(hand('AKJ432 K43 A5 32'), '1S P 2N P')).toBe('3D')
    // 5422: 3♠ 12–15, 3NT 16–21
    expect(bidOver(hand('AKJ32 K4 Q543 32'), '1S P 2N P')).toBe('3S')
    expect(bidOver(hand('AKJ32 K4 AQ43 32'), '1S P 2N P')).toBe('3N')
    // Voids: 4♣, 4♦; hearts 4♥ with a maximum, 4♠ with a minimum
    expect(bidOver(hand('AKJ32 K432 Q543 -'), '1S P 2N P')).toBe('4C')
    expect(bidOver(hand('AKJ32 Q432 - Q543'), '1S P 2N P')).toBe('4D')
    expect(bidOver(hand('AKJ32 - AQ43 K432'), '1S P 2N P')).toBe('4H')
    expect(bidOver(hand('AKJ32 - Q543 J432'), '1S P 2N P')).toBe('4S')
    // A two-suiter with a singleton: 3♣
    expect(bidOver(hand('AKJ32 2 KQ543 32'), '1S P 2N P')).toBe('3C')
  })

  it('1♥–2♠: 2NT short in spades, 3♣, 3♦; 3NT the spade void', () => {
    expect(bidOver(hand('2 AKJ32 K543 A32'), '1H P 2S P')).toBe('2N')
    expect(bidOver(hand('K43 AKJ32 A543 2'), '1H P 2S P')).toBe('3C')
    expect(bidOver(hand('K43 AKJ32 2 A543'), '1H P 2S P')).toBe('3D')
    expect(bidOver(hand('K3 AKJ32 Q54 432'), '1H P 2S P')).toBe('2N')
    expect(bidOver(hand('K4 AKJ32 AQ43 32'), '1H P 2S P')).toBe('3S')
    expect(bidOver(hand('- AKJ32 Q543 K432'), '1H P 2S P')).toBe('3N')
    expect(bidOver(hand('AQ43 AKJ32 - K432'), '1H P 2S P')).toBe('4D')
    expect(bidOver(hand('Q543 AKJ32 - J432'), '1H P 2S P')).toBe('4H')
  })

  it('answers the relay (加一詢問) with the balanced range or trumps and strength', () => {
    expect(bidOver(hand('AKJ32 K43 A5 432'), '1S P 2N P 3D P 3H P')).toBe('3S')
    // 3♣ then 3♦: +1 two-suiter, +2 balanced, +3 five spades 12–15 short in clubs, +4 six spades 11–14
    expect(bidOver(hand('AKJ32 2 KQ543 32'), '1S P 2N P 3C P 3D P')).toBe('3H')
    expect(bidOver(hand('AKJ32 K43 Q54 32'), '1S P 2N P 3C P 3D P')).toBe('3S')
    expect(bidOver(hand('AKJ32 K43 A543 2'), '1S P 2N P 3C P 3D P')).toBe('3N')
    expect(bidOver(hand('AKJ432 K43 A54 2'), '1S P 2N P 3C P 3D P')).toBe('4H')
    expect(bidOver(hand('AKJ432 K43 Q54 2'), '1S P 2N P 3C P 3D P')).toBe('4C')
    expect(bidOver(hand('AKJ32 K43 AK54 2'), '1S P 2N P 3C P 3D P')).toBe('4D')
    expect(bidOver(hand('AKJ32 K43 AKQ4 2'), '1S P 2N P 3C P 3D P')).toBe('4S')
    // Hearts: 2NT then 3♣
    expect(bidOver(hand('2 AKJ32 K543 A32'), '1H P 2S P 2N P 3C P')).toBe('3S')
  })

  it('responder relays, then bids RKCB or game by the points outside opener’s short suit', () => {
    expect(bidOver(hand('Q954 AQ2 K32 K54'), '1S P 2N P 3C P')).toBe('3D')
    // Opener short in clubs with 12–15: K♣ is wasted, game
    expect(bidOver(hand('Q954 AQ2 K32 K54'), '1S P 2N P 3C P 3D P 3N P')).toBe('4S')
    // Nothing in clubs: 14 + 13 = 27 ≥ 25 with nine trumps, RKCB
    expect(bidOver(hand('Q954 AQ2 KQ32 54'), '1S P 2N P 3C P 3D P 3N P')).toBe('4N')
    // Balanced 15–17 opposite 14: game
    expect(bidOver(hand('Q954 AQ2 K32 K54'), '1S P 2N P 3D P 3H P 3S P')).toBe('4S')
    // Hearts: RKCB is 4♠ (「♥為王牌時，這時的RKCB為4♠」)
    expect(bidOver(hand('AQ2 Q954 KQ32 54'), '1H P 2S P 3C P 3D P 3S P')).toBe('4S')
  })

  it('opener leaves the decision to responder', () => {
    expect(bidOver(hand('AKJ32 K43 A5 432'), '1S P 2N P 3D P 3H P 3S P 4S P')).toBe('P')
  })

  it('explains the answers', () => {
    expect(reads('1S P 2N P', '4C')).toContain('♣缺門')
    expect(reads('1S P 2N P', '5C')).toContain('EKB')
    expect(reads('1S P 2N P 3D P', '3H')).toContain('詢問')
  })
})

describe('Bergen and splinters: asking, control bids, RKCB (e5-t37)', () => {
  it('opener asks with 14+, 15+, 17+ by 牌值, otherwise signs off', () => {
    expect(bidOver(hand('AKJ32 K43 AQ4 32'), '1S P 3C P')).toBe('3D')
    expect(bidOver(hand('AKJ32 K43 Q54 32'), '1S P 3C P')).toBe('3S')
    expect(bidOver(hand('AKJ32 K43 AQ4 32'), '1S P 3D P')).toBe('3H')
    expect(bidOver(hand('AKJ32 K43 KQ4 32'), '1S P 3H P')).toBe('3S')
    expect(bidOver(hand('AKJ32 K43 AQ4 32'), '1S P 3H P')).toBe('3N')
    expect(bidOver(hand('K43 AKJ32 AQ4 32'), '1H P 2N P')).toBe('3C')
  })

  it('responder shows the singleton, the void or no shortness', () => {
    expect(bidOver(hand('Q954 A32 KJ432 4'), '1S P 3C P 3D P')).toBe('4C')
    expect(bidOver(hand('Q954 A32 KJ43 54'), '1S P 3C P 3D P')).toBe('3S')
    expect(bidOver(hand('Q954 A32 KJ5432 -'), '1S P 3C P 3D P')).toBe('3N')
    expect(bidOver(hand('Q954 A32 KJ5432 -'), '1S P 3C P 3D P 3N P 4C P')).toBe('4S')
    expect(bidOver(hand('A32 Q954 KJ432 4'), '1H P 2N P 3C P')).toBe('4C')
    expect(bidOver(hand('4 Q954 KJ432 A32'), '1H P 2N P 3C P')).toBe('3N')
    // After the 6–7 raise: shortness, or 4♠ with none
    expect(bidOver(hand('Q954 Q32 J5432 4'), '1S P 3H P 3N P')).toBe('4C')
    expect(bidOver(hand('Q954 Q32 J543 54'), '1S P 3H P 3N P')).toBe('4S')
  })

  it('opener judges the slam with what responder showed', () => {
    // K♣ opposite the singleton is wasted: game; the same strength elsewhere: RKCB
    expect(bidOver(hand('AQJ32 K4 A54 K32'), '1S P 3C P 3D P 4C P')).toBe('4S')
    expect(bidOver(hand('AQJ32 K4 AK5 432'), '1S P 3C P 3D P 4C P')).toBe('4N')
  })

  it('after a splinter: RKCB, a control bid in between, or game', () => {
    expect(bidOver(hand('AQJ32 K4 AK5 432'), '1S P 4C P')).toBe('4N')
    expect(bidOver(hand('AQJ32 A4 J54 Q32'), '1S P 4C P')).toBe('4H')
    expect(bidOver(hand('AQJ32 Q4 J54 Q32'), '1S P 4C P')).toBe('4S')
    // Responder after the control bid: RKCB with a maximum, game otherwise
    expect(bidOver(hand('K954 K732 AQ32 4'), '1S P 4C P 4H P')).toBe('4S')
    expect(bidOver(hand('K954 K732 AKJ2 4'), '1S P 4C P 4H P')).toBe('4N')
    // The void splinter: opener asks which void with slam chances (4♣)
    expect(bidOver(hand('AQJ32 K4 AK5 432'), '1S P 3N P')).toBe('4C')
    expect(bidOver(hand('K954 KQ32 AJ432 -'), '1S P 3N P 4C P')).toBe('4S')
  })

  it('the 短門滿貫 rule: 25 (23 with a void) with nine trumps, 27 (25) with eight', () => {
    expect([slamNeeds(9, 'single'), slamNeeds(9, 'void'), slamNeeds(8, 'single'), slamNeeds(8, 'void'), slamNeeds(9, null)]).toEqual([25, 23, 27, 25, 31])
  })
})

describe('RKCB 1430, the queen ask, the king ask (e5-t35)', () => {
  it('answers in steps: 1 or 4, 0 or 3, 2 without the queen, 2 with it', () => {
    const asked = '1S P 3C P 3D P 4C P 4N P'
    expect(bidOver(hand('Q954 A32 KJ432 4'), asked)).toBe('5C')
    expect(bidOver(hand('Q954 Q32 KJ432 4'), asked)).toBe('5D')
    expect(bidOver(hand('K954 A32 QJ432 4'), asked)).toBe('5H')
    expect(bidOver(hand('KQ54 A32 J5432 4'), asked)).toBe('5S')
    // Hearts after J2N: 4♠ asks, the steps start at 4NT
    expect(bidOver(hand('K43 AKJ32 A543 2'), '1H P 2S P 3C P 3D P 3S P 4S P')).toBe('5C')
  })

  it('the asker signs off two keycards short, asks for the queen, or bids the slam', () => {
    // Three keycards opposite 0 (not 3): two missing, stop at five; two opposite 1 (not 4): the same
    expect(bidOver(hand('AQJ32 K4 AQ5 A32'), '1S P 3C P 3D P 4C P 4N P 5D P')).toBe('5S')
    expect(bidOver(hand('AJ432 K4 AK5 432'), '1S P 3C P 3D P 4C P 4N P 5C P')).toBe('5S')
    // Two opposite 0 or 3: partner must have three; with the queen, the slam
    expect(bidOver(hand('AQJ32 K4 AK5 432'), '1S P 3C P 3D P 4C P 4N P 5D P')).toBe('6S')
    expect(bidOver(hand('AQJ32 K4 AK5 432'), '1S P 3C P 3D P 4C P 4N P 5H P')).toBe('6S')
    // Four keycards without the queen of trumps and only nine trumps: ask for it (the next step but trumps)
    expect(bidOver(hand('AKJ32 K4 AQ5 A32'), '1S P 3C P 3D P 4C P 4N P 5D P')).toBe('5H')
    expect(bidOver(hand('Q954 A32 KJ432 4'), '1S P 3C P 3D P 4C P 4N P 5C P 5D P')).toBe('6S')
    expect(bidOver(hand('T954 A32 KJ432 4'), '1S P 3C P 3D P 4C P 4N P 5C P 5D P')).toBe('5S')
  })

  it('explains RKCB 1430 and the answers', () => {
    expect(reads('1S P 3C P 3D P 4C P', '4N')).toBe('RKCB 1430：有滿貫興趣，迫叫一圈')
    expect(reads('1S P 3C P 3D P 4C P 4N P', '5C')).toContain('1 或 4 張關鍵張')
    expect(reads('1S P 3C P 3D P 4C P 4N P', '5S', 'en')).toContain('2 or 5 keycards')
  })
})

describe('Gerber, Blackwood, quantitative notrump (e5-t35)', () => {
  it('answers Gerber over 1NT and 2NT in aces', () => {
    expect(reads('1N P', '4C')).toContain('Gerber')
    expect(bidOver(hand('AQ2 KJ3 A542 Q32'), '1N P 4C P')).toBe('4S')
    expect(bidOver(hand('KQ2 KJ3 Q542 KQ2'), '1N P 4C P')).toBe('4D')
    expect(bidOver(hand('AQ2 AJ3 AK42 KQ2'), '2N P 4C P')).toBe('4N')
  })

  it('answers Blackwood when no suit is agreed', () => {
    expect(reads('1H P 1S P 2C P', '4N')).toContain('黑木問 A')
    expect(bidOver(hand('K2 AKJ32 3 KQ432'), '1H P 1S P 2C P 4N P')).toBe('5D')
  })

  it('1NT: 4NT 15–16, 6NT 17–18, 5NT 19–20, 7NT 21+; opener accepts in a four-card minor', () => {
    expect(bidOver(hand('KQ2 KJ3 QJ54 K32'), '1N P')).toBe('4N')
    expect(bidOver(hand('KQ2 KJ3 AJ54 K32'), '1N P')).toBe('6N')
    expect(bidOver(hand('KQ2 KQ3 AJ54 AJ2'), '1N P')).toBe('5N')
    expect(bidOver(hand('AQ2 KJ3 K542 K32'), '1N P 4N P')).toBe('5D')
    expect(bidOver(hand('AQ2 KJ3 Q542 Q32'), '1N P 4N P')).toBe('P')
    expect(bidOver(hand('KQ2 KJ3 QJ54 K32'), '1N P 4N P 5D P')).toBe('6D')
    expect(bidOver(hand('KQ2 KJ3 QJ5 K432'), '1N P 4N P 5D P')).toBe('6N')
  })
})

describe('the robot asks RKCB itself in an agreed major', () => {
  it('rather than bidding the slam blind', () => {
    // 1♥–2♥ shows three hearts: with 22 points opposite, a slam in hearts is the target
    expect(bidOver(hand('AK AKQJ32 AQ2 K2'), '2C P 2D P 2H P 3H P')).toBe('4N')
  })
})

describe('adjusted hand values (e5-t41)', () => {
  it('opens a good 11 by the Rule of 20 with two quick tricks', () => {
    expect(bidOver(hand('AK932 KJ432 32 2'), '')).toBe('1S')
    // Too weak for one of a suit; 5-5 in the majors opens the two-suiter 2♥ (社長 2026-10-25)
    expect(bidOver(hand('QJ932 QJ432 K2 2'), '')).toBe('2H')
    expect(bidOver(hand('QJ932 QJ43 K32 2'), '')).toBe('P')
    // Not in fourth seat, where the Rule of 15 decides
    expect(bidOver(hand('2 AK932 KJ432 32'), '')).toBe('1H')
    expect(bidOver(hand('2 AK932 KJ432 32'), 'P P P')).toBe('P')
  })

  it('opener counts a short suit once partner raises', () => {
    // 15 HCP and a singleton after the single raise: a long-suit try; the same 15 balanced passes
    expect(bidOver(hand('AKJ32 K432 A54 2'), '1S P 2S P')).toBe('3D')
    expect(bidOver(hand('AKJ32 K43 A54 32'), '1S P 2S P')).toBe('P')
  })
})
