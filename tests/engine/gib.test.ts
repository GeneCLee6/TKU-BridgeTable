import { describe, expect, it } from 'vitest'
import { contractOf, type AuctionCall } from '../../shared/auction.ts'
import { deal, type Vulnerability } from '../../shared/board.ts'
import { nextSeat, type Card, type Seat } from '../../shared/cards.ts'
import { makeCall, newBoard, turnOf } from '../../shared/game.ts'
import { robotCall } from '../../shared/robot/robots.ts'
import { patternProblem } from '../../shared/robot/system/context.ts'
import { describe as words } from '../../shared/robot/system/describe.ts'
import { choose, explain } from '../../shared/robot/system/engine.ts'
import { evaluate } from '../../shared/robot/system/evaluate.ts'
import { decide, fallback, goalFor } from '../../shared/robot/system/gib/fallback.ts'
import { GIB } from '../../shared/robot/system/gib/index.ts'
import { openings } from '../../shared/robot/system/gib/openings.ts'
import { contextFor } from '../../shared/robot/system/infer.ts'
import type { System } from '../../shared/robot/system/spec.ts'

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

/** Openings and the fallback alone, so these tests do not change as books are added to GIB */
const FALLBACK_ONLY: System = { id: 'gib', books: [openings, fallback] }

/** The auction from the seat about to call (fallback only), and a hand for it */
function situation(cards: string, calls: string, dealer: Seat = 'N') {
  const auction = auctionOf(calls, dealer)
  const ctx = contextFor(FALLBACK_ONLY, nextSeat(dealer, auction.length), auction, dealer, 'None')
  return { h: evaluate(hand(cards)), ctx }
}

function seeded(seed: number) {
  return (n: number) => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
    return seed % n
  }
}

describe('the robots a host can seat', () => {
  it('the 2/1 robot alerts with GIB-style words and keeps what the call shows', () => {
    const bid = robotCall('gib', hand('AKJ32 K43 Q54 32'), 'N', [], 'N', 'None')
    expect(bid).toEqual({ call: '1S', alert: '5+ 張♠，11–21 大牌點，12–22 總點', meaning: { len: { S: [5, 13] }, hcp: [11, 21], tp: [12, 22] } })
    expect(robotCall('gib', hand('932 843 J54 5432'), 'N', [], 'N', 'None')).toEqual({ call: 'P' })
  })

  it('the club’s robot bids the club’s system with the same engine, keeping what the call shows', () => {
    const bid = robotCall('tku', hand('AKJ32 K43 Q54 32'), 'N', [], 'N', 'None')
    expect(bid).toEqual({ call: '1S', alert: '5+ 張♠，12–21 大牌點', meaning: { len: { S: [5, 13] }, hcp: [12, 21] } })
    expect(robotCall('tku', hand('932 843 J54 5432'), 'N', [], 'N', 'None')).toEqual({ call: 'P' })
  })
})

describe('the 2/1 books', () => {
  it('write every auction pattern with the opponents in the right places', () => {
    for (const book of GIB.books) {
      const after = book.after === undefined ? [] : typeof book.after === 'string' ? [book.after] : book.after
      for (const pattern of after) expect(patternProblem(pattern), pattern).toBeNull()
    }
  })

  it('bid 300 random boards legally to the end, explaining every call but pass', () => {
    const contracts = new Map<string, number>()
    for (let seed = 1; seed <= 300; seed++) {
      let state = newBoard(seed, deal(seeded(seed)))
      while (state.phase === 'auction') {
        const seat = turnOf(state)!
        const { call, shows } = choose(GIB, state.hands[seat], seat, state.auction, state.dealer, state.vul)
        if (call !== 'P') expect(shows && words(shows, 'zh'), `board ${seed}: ${call}`).toBeTruthy()
        // makeCall throws on an illegal call
        state = makeCall(state, seat, call, shows ? words(shows, 'zh') : undefined)
        expect(state.auction.length, `board ${seed}`).toBeLessThan(40)
      }
      const c = contractOf(state.auction)
      const kind = !c ? 'passed' : c.level >= 6 ? 'slam' : c.level >= (c.strain === 'N' ? 3 : c.strain === 'S' || c.strain === 'H' ? 4 : 5) ? 'game' : 'part'
      contracts.set(kind, (contracts.get(kind) ?? 0) + 1)
    }
    expect(contracts.get('passed') ?? 0).toBeLessThan(30)
    expect(contracts.get('game') ?? 0).toBeGreaterThan(90)
    expect(contracts.get('slam') ?? 0).toBeLessThan(20)
  })
})

describe('after 1♣ / 1♦ (§2)', () => {
  it('bids 3NT with 13+ balanced, not only 13–15 (V4a: 16 passed 1♣ and 1NT)', () => {
    expect(bidOver('AKT 932 AQ6 QJ42', '1C P')).toBe('3N')
    expect(bidOver('KQ3 KT5 AJ3 KQ74', '1C P')).toBe('3N')
    // Responder after opener's 1NT rebid
    expect(bidOver('AT9 AT74 KT7 KQT', '1C P 1H P 1N P')).toBe('3N')
    expect(bidOver('A953 AQ K97 K854', '1D P 1S P 1N P')).toBe('3N')
  })

  it('answers in a new suit: longer diamonds first, majors 4-4 hearts, 5-5 spades', () => {
    expect(bidOver('32 K432 QJ432 32', '1C P')).toBe('1D')
    expect(bidOver('432 K432 QJ43 32', '1C P')).toBe('1H')
    expect(bidOver('K432 Q432 J43 32', '1C P')).toBe('1H')
    expect(bidOver('K5432 Q5432 J 32', '1C P')).toBe('1S')
  })

  it('raises inverted, bids 2♣ over 1♦ as a game force, and jumps to 3♣ to invite', () => {
    expect(bidOver('32 K32 A32 KJ432', '1C P')).toBe('2C')
    expect(bidOver('A3 K32 Q32 AK432', '1D P')).toBe('2C')
    expect(bidOver('K2 32 432 AQJ432', '1D P')).toBe('3C')
    expect(bidOver('32 432 KJ5432 32', '1D P')).toBe('3D')
  })

  it('shows balanced hands without a major in notrump, and passes 0–5', () => {
    expect(bidOver('K32 Q32 J32 J432', '1C P')).toBe('1N')
    expect(bidOver('K32 Q32 AJ3 J432', '1D P')).toBe('2N')
    expect(bidOver('K32 Q32 AJ3 KJ32', '1C P')).toBe('3N')
    expect(bidOver('432 432 5432 432', '1C P')).toBe('P')
  })

  it('makes fit jumps as a passed hand', () => {
    expect(bidOver('KQJ32 32 K432 32', 'P P 1D P')).toBe('2S')
  })

  it('opener raises by strength, shows a new suit, notrump or a long minor', () => {
    expect(bidOver('A32 KJ32 32 KJ32', '1C P 1H P')).toBe('2H')
    expect(bidOver('A32 KQ32 32 AKJ2', '1C P 1H P')).toBe('3H')
    expect(bidOver('A32 AKQ2 3 AKJ32', '1C P 1H P')).toBe('4H')
    expect(bidOver('KJ32 32 A32 KQ32', '1C P 1H P')).toBe('1S')
    expect(bidOver('K32 Q2 A32 KJ432', '1C P 1H P')).toBe('1N')
    expect(bidOver('AQ2 K2 AJ32 KQ32', '1D P 1H P')).toBe('2N')
    expect(bidOver('A2 32 K32 AKQJ32', '1C P 1H P')).toBe('3C')
    // A four-card major comes before raising 1♦
    expect(bidOver('- KJ32 Q432 AKJ32', '1C P 1D P')).toBe('1H')
  })

  it('reverses with 17+ and the minor longer; the 2NT relay shows a weak hand', () => {
    expect(bidOver('A2 K2 KQ32 AJ432', '1C P 1S P')).toBe('2D')
    expect(bidOver('KQ432 32 432 432', '1C P 1S P 2D P')).toBe('2N')
    expect(bidOver('A2 K2 KQ32 AJ432', '1C P 1S P 2D P 2N P')).toBe('3C')
  })

  it('uses new minor forcing after 1NT, and opener answers it', () => {
    expect(bidOver('K2 AQ432 Q32 432', '1C P 1H P 1N P')).toBe('2D')
    expect(bidOver('K32 Q32 A2 QJ432', '1C P 1H P 1N P 2D P')).toBe('2H')
    expect(bidOver('K32 Q2 A32 QJ432', '1C P 1H P 1N P 2D P')).toBe('2N')
  })

  it('bids the fourth suit as an artificial game force', () => {
    expect(bidOver('32 K32 AQJ32 K32', '1C P 1D P 1H P')).toBe('1S')
  })

  it('explains these calls the way GIB does', () => {
    expect(meaning('1C P', '2C')).toBe('倒轉低花加叫：0–3 張♠，0–3 張♥，5+ 張♣，10+ 大牌點，迫叫一圈')
    expect(meaning('1C P', '1N')).toBe('0–3 張♠，0–3 張♥，6–10 大牌點')
    expect(meaning('1C P', 'P')).toBe('0–5 大牌點')
    expect(meaning('1C P 1S P', '2D')).toBe('反序：4+ 張♦，5+ 張♣，17–21 大牌點，迫叫一圈')
    expect(meaning('1C P 1H P 1N P', '2D')).toBe('新低花迫叫：11+ 大牌點，迫叫一圈')
    expect(meaning('1C P 1D P 1H P', '1S')).toBe('第四花色迫叫：12+ 大牌點，迫叫成局')
    expect(meaning('1C P 1S P 2D P', '2N')).toBe('雷本索：請同伴叫 3♣，5–8 大牌點，迫叫一圈')
  })
})

describe('after 1♥ / 1♠ (§3)', () => {
  it('raises with four trumps by strength: splinter, Jacoby 2NT, limit raise, preempt', () => {
    expect(bidOver('KQ32 A432 KJ32 2', '1S P')).toBe('4C')
    expect(bidOver('KQ32 A32 KJ32 32', '1S P')).toBe('2N')
    expect(bidOver('KQ32 A32 J432 32', '1S P')).toBe('3S')
    expect(bidOver('Q8432 2 J5432 32', '1S P')).toBe('4S')
    expect(bidOver('K32 Q432 J432 32', '1S P')).toBe('2S')
  })

  it('bids a 2/1 game force, 1♠ over 1♥, or 1NT forcing', () => {
    expect(bidOver('32 AKJ32 K32 Q32', '1S P')).toBe('2H')
    expect(bidOver('32 A32 AKJ32 Q32', '1S P')).toBe('2D')
    expect(bidOver('A32 KQ32 KQ3 Q32', '1S P')).toBe('2C')
    expect(bidOver('K2 Q432 J432 432', '1S P')).toBe('1N')
    expect(bidOver('KJ32 32 Q432 K32', '1H P')).toBe('1S')
    expect(bidOver('KJ32 Q32 J32 432', '1H P')).toBe('2H')
    expect(bidOver('2 32 K32 AQJ5432', '1S P')).toBe('3C')
  })

  it('uses Reverse Drury as a passed hand, and opener answers it', () => {
    expect(bidOver('K32 A32 KJ32 432', 'P P 1S P')).toBe('2C')
    expect(bidOver('KQJ32 K32 432 32', 'P P 1S P 2C P')).toBe('2S')
    expect(bidOver('KQJ32 K32 A32 32', 'P P 1S P 2C P')).toBe('2N')
    expect(bidOver('KQJ32 K2 A432 32', 'P P 1S P 2C P')).toBe('2D')
  })

  it('makes two-way game tries after a single raise', () => {
    expect(bidOver('AKQ32 AK32 K2 32', '1S P 2S P')).toBe('4S')
    expect(bidOver('AKJ32 KQ32 Q32 2', '1S P 2S P')).toBe('2N')
    expect(bidOver('AKJ32 Q32 AK2 32', '1S P 2S P')).toBe('3H')
    expect(bidOver('AKJ32 AK2 432 32', '1S P 2S P')).toBe('3S')
    expect(bidOver('AKJ32 Q32 432 32', '1S P 2S P')).toBe('P')
  })

  it('answers a short-suit try, and opener shows where the shortness is', () => {
    expect(bidOver('Q32 A32 K432 432', '1S P 2S P 2N P')).toBe('4S')
    expect(bidOver('Q32 A32 Q432 432', '1S P 2S P 2N P')).toBe('3C')
    expect(bidOver('Q32 A32 J432 432', '1S P 2S P 2N P')).toBe('3S')
    // Short in clubs, the step suit: bid the major
    expect(bidOver('AKJ32 KQ32 Q32 2', '1S P 2S P 2N P 3C P')).toBe('3S')
    expect(bidOver('AKJ32 KQ32 2 Q32', '1S P 2S P 2N P 3C P')).toBe('3D')
  })

  it('rebids after 1NT forcing, and responder makes the delayed limit raise', () => {
    expect(bidOver('AKJ32 KQ32 32 32', '1S P 1N P')).toBe('2H')
    expect(bidOver('AKJ432 K32 32 32', '1S P 1N P')).toBe('2S')
    expect(bidOver('AKJ32 K2 Q32 432', '1S P 1N P')).toBe('2C')
    expect(bidOver('AKJ32 KQ2 AQ2 32', '1S P 1N P')).toBe('2N')
    expect(bidOver('AKJ2 KQJ32 A2 32', '1H P 1N P')).toBe('2S')
    expect(bidOver('K32 Q2 KQ432 432', '1S P 1N P 2H P')).toBe('3S')
    expect(bidOver('K2 432 Q5432 Q32', '1S P 1N P 2H P')).toBe('2S')
  })

  it('opener answers Jacoby 2NT: shortness, a good second suit, or strength', () => {
    expect(bidOver('AKJ32 KQ32 Q32 2', '1S P 2N P')).toBe('3C')
    expect(bidOver('AKJ32 AQ432 32 2', '1S P 2N P')).toBe('4H')
    expect(bidOver('AKJ32 KQ2 AQ2 32', '1S P 2N P')).toBe('3S')
    expect(bidOver('AKJ32 K32 A32 32', '1S P 2N P')).toBe('3N')
    expect(bidOver('AKJ32 Q32 Q32 32', '1S P 2N P')).toBe('4S')
  })

  it('opener rebids after a 2/1: raise, new suit, notrump or the major', () => {
    expect(bidOver('AKJ32 32 KQ32 32', '1S P 2D P')).toBe('3D')
    expect(bidOver('AKJ32 KQ32 32 32', '1S P 2D P')).toBe('2H')
    expect(bidOver('AKJ32 K32 32 432', '1S P 2D P')).toBe('2N')
    expect(bidOver('AKJ32 32 32 K432', '1S P 2D P')).toBe('2S')
  })

  it('explains these calls the way GIB does', () => {
    expect(meaning('1S P', '2N')).toBe('Jacoby 2NT：4+ 張♠，13+ 總點，迫叫成局')
    expect(meaning('1S P', '4C')).toBe('Splinter：♣單張或缺門，4+ 張♠，0–1 張♣，13–16 總點，迫叫成局')
    expect(meaning('1S P', '2S')).toBe('3+ 張♠，7–10 總點')
    expect(meaning('1S P', '1N')).toBe('6–12 大牌點，迫叫一圈')
    expect(meaning('1S P 2S P', '2N')).toBe('短門成局試探：某一門單張或缺門，16–18 總點，迫叫一圈')
    expect(meaning('1H P 2H P', '2N')).toBe('長門成局試探：♠需要幫助，3+ 張♠，16–18 總點，迫叫一圈')
    expect(meaning('P P 1S P', '2C')).toBe('Reverse Drury：3+ 張♠，11–12 總點，迫叫一圈')
  })
})

describe('after 1NT / 2NT (§4, §5)', () => {
  it('answers 1NT with Stayman, transfers, Texas, minor-suit Stayman, shortness and notrump', () => {
    expect(bidOver('KJ32 Q43 Q54 Q32', '1N P')).toBe('2C')
    expect(bidOver('KJ432 Q432 Q5 32', '1N P')).toBe('2C')
    expect(bidOver('32 QJ432 J54 432', '1N P')).toBe('2D')
    expect(bidOver('QJ432 32 J54 432', '1N P')).toBe('2H')
    // 5-5 in the majors: through hearts when weak, through spades with game
    expect(bidOver('QJ432 QJ432 32 2', '1N P')).toBe('2D')
    expect(bidOver('KQ432 AJ432 32 2', '1N P')).toBe('2H')
    expect(bidOver('KQJ432 32 K54 Q2', '1N P')).toBe('4H')
    expect(bidOver('2 32 AQ432 KJ432', '1N P')).toBe('2S')
    expect(bidOver('KJ32 Q432 2 AJ32', '1N P')).toBe('3D')
    expect(bidOver('2 32 432 QJ86432', '1N P')).toBe('2N')
    expect(bidOver('K32 Q43 K54 Q432', '1N P')).toBe('3N')
    // Inviting 3NT without a major goes through Stayman
    expect(bidOver('K32 Q43 J54 Q432', '1N P')).toBe('2C')
    expect(bidOver('KQ2 AQ3 K54 Q432', '1N P')).toBe('4N')
    expect(bidOver('932 843 J54 5432', '1N P')).toBe('P')
  })

  it('opener accepts an invitation after Stayman with the top two points (V4a)', () => {
    expect(bidOver('943 Q62 AK98 AKT', '1N P 2C P 2D P 2N P')).toBe('3N')
    expect(bidOver('943 Q62 AK98 AJT', '1N P 2C P 2D P 2N P')).toBe('P')
    expect(bidOver('Q72 AQ86 KJ5 KJ2', '1N P 2C P 2H P 3H P')).toBe('4H')
    expect(bidOver('Q72 AQ86 KJ5 QJ2', '1N P 2C P 2H P 3H P')).toBe('P')
    expect(meaning('1N P 2C P 2S P 2N P', '3N')).toBe('接受，16–17 大牌點')
  })

  it('opener answers Stayman, transfers and minor-suit Stayman', () => {
    expect(bidOver('AQ2 KJ32 Q54 K32', '1N P 2C P')).toBe('2H')
    expect(bidOver('AQ32 KJ3 Q54 K32', '1N P 2C P')).toBe('2S')
    expect(bidOver('AQ2 KJ3 Q54 K432', '1N P 2C P')).toBe('2D')
    expect(bidOver('AQ2 KJ3 Q54 K432', '1N P 2D P')).toBe('2H')
    expect(bidOver('AQ2 KJ32 KQ5 Q32', '1N P 2D P')).toBe('3H')
    expect(bidOver('AQ2 KJ3 Q54 K432', '1N P 2S P')).toBe('2N')
    expect(bidOver('AQ2 K3 Q543 K432', '1N P 2S P')).toBe('3D')
    expect(bidOver('AQ2 KJ3 Q54 K432', '1N P 2N P')).toBe('3C')
    expect(bidOver('AQ2 KJ3 Q54 K432', '1N P 4D P')).toBe('4H')
  })

  it('responder continues after Stayman: Smolen, invitations, game', () => {
    expect(bidOver('KJ32 AQ432 32 32', '1N P 2C P 2D P')).toBe('3S')
    expect(bidOver('KJ32 QJ432 Q2 32', '1N P 2C P 2D P')).toBe('2H')
    expect(bidOver('KJ32 Q432 K54 32', '1N P 2C P 2H P')).toBe('3H')
    expect(bidOver('KJ32 Q432 K54 Q2', '1N P 2C P 2H P')).toBe('4H')
    expect(bidOver('KJ32 Q43 K54 Q32', '1N P 2C P 2H P')).toBe('3N')
    expect(bidOver('KJ32 Q43 J54 Q32', '1N P 2C P 2S P')).toBe('3S')
  })

  it('responder continues after a transfer, and opener answers the choice', () => {
    expect(bidOver('32 QJ432 J54 432', '1N P 2D P 2H P')).toBe('P')
    expect(bidOver('32 KJ432 K54 Q32', '1N P 2D P 2H P')).toBe('2N')
    expect(bidOver('32 KJ432 K54 K32', '1N P 2D P 2H P')).toBe('3N')
    expect(bidOver('A2 KJ5432 54 432', '1N P 2D P 2H P')).toBe('3H')
    expect(bidOver('KJ432 KJ432 2 32', '1N P 2D P 2H P')).toBe('2S')
    expect(bidOver('AQ2 KJ3 Q54 K432', '1N P 2D P 2H P 3N P')).toBe('4H')
    expect(bidOver('AQ32 K3 Q54 K432', '1N P 2D P 2H P 3N P')).toBe('P')
    expect(bidOver('AQ2 KJ3 Q54 K432', '1N P 2D P 2H P 2N P')).toBe('3H')
    expect(bidOver('AQ32 K3 KQ4 K432', '1N P 2D P 2H P 2N P')).toBe('3N')
    // Opener declined the invitation: responder passes
    expect(bidOver('KJ432 32 K54 Q32', '1N P 2H P 2S P 2N P 3S P')).toBe('P')
  })

  it('answers 2NT the same way a level higher', () => {
    expect(bidOver('K432 Q43 543 432', '2N P')).toBe('3C')
    expect(bidOver('Q5432 32 543 432', '2N P')).toBe('3H')
    expect(bidOver('KQ5432 32 543 32', '2N P')).toBe('4H')
    expect(bidOver('2 32 KQ432 J5432', '2N P')).toBe('3S')
    expect(bidOver('K32 Q43 543 5432', '2N P')).toBe('3N')
    expect(bidOver('932 843 543 5432', '2N P')).toBe('P')
    expect(bidOver('AK2 KQJ2 AQ4 K32', '2N P 3C P')).toBe('3H')
  })

  it('keeps the system on over a 2♣ overcall or a double, and uses Lebensohl otherwise', () => {
    expect(bidOver('KJ32 Q43 K54 Q32', '1N 2C')).toBe('X')
    expect(bidOver('32 32 J5432 Q432', '1N X')).toBe('XX')
    expect(bidOver('KJ432 32 Q54 432', '1N 2H')).toBe('2S')
    expect(bidOver('K32 32 A54 KQJ32', '1N 2H')).toBe('3C')
    expect(bidOver('K32 KJ32 A54 J43', '1N 2H')).toBe('X')
    expect(bidOver('K32 KJ2 A54 J432', '1N 2H')).toBe('2N')
    expect(bidOver('AQ2 Q43 KQ54 K32', '1N 2H 2N P')).toBe('3C')
    expect(bidOver('K32 KJ2 A54 J432', '1N 2H 2N P 3C P')).toBe('3N')
  })

  it('explains these calls the way GIB does', () => {
    expect(meaning('1N P', '2C')).toBe('Stayman：詢問 4 張高花，8+ 大牌點，迫叫一圈')
    expect(meaning('1N P', '2D')).toBe('轉換：轉到♥，5+ 張♥，迫叫一圈')
    expect(meaning('1N P', '4C')).toBe('Gerber')
    expect(meaning('1N P 2D P 2H P', '3N')).toBe('請同伴選 4♥ 或 3NT，5 張♥，10–15 大牌點')
    expect(meaning('1N P 2C P 2D P', '3S')).toBe('Smolen：4 張♠，5 張♥，10+ 大牌點，迫叫成局')
    expect(meaning('1N 2H', '2N')).toBe('雷本索：請同伴叫 3♣，迫叫一圈')
  })
})

describe('the 2/1 audit: forcing calls and the notrump structure (ROBOT.md §6.7)', () => {
  it('a six-card major with slam interest transfers and bids four; Texas is game without it, or a slam drive', () => {
    // 13 HCP and six spades opposite 15–17: a mild slam try, not Texas
    expect(bidOver('AKJ932 K32 Q2 32', '1N P')).toBe('2H')
    expect(bidOver('AKJ932 K32 Q2 32', '1N P 2H P 2S P')).toBe('4S')
    expect(bidOver('32 AKJ932 Q2 K32', '1N P')).toBe('2D')
    expect(bidOver('32 AKJ932 Q2 K32', '1N P 2D P 2H P')).toBe('4H')
    expect(bidOver('AQJ932 K32 KQ2 2', '1N P 2H P 2S P')).toBe('4C')
    // Texas: game and no slam interest, or enough to ask for keycards at once
    expect(bidOver('KQJ932 K32 Q2 32', '1N P')).toBe('4H')
    expect(bidOver('AKJ932 AK2 Q2 32', '1N P')).toBe('4H')
    expect(bidOver('AKJ932 AK2 Q2 32', '1N P 4H P 4S P')).toBe('4N')
    // The same over 2NT
    expect(bidOver('QJ9832 K32 Q2 32', '2N P')).toBe('3H')
    expect(bidOver('QJ9832 K32 Q2 32', '2N P 3H P 3S P')).toBe('4S')
    expect(bidOver('QJ9832 32 Q32 32', '2N P')).toBe('4H')
  })

  it('opener accepts the mild slam try with a maximum, and declines without', () => {
    expect(bidOver('K54 Q32 AK32 KJ2', '1N P 2H P 2S P 4S P')).toBe('4N')
    expect(bidOver('Q54 Q32 AK32 KJ2', '1N P 2H P 2S P 4S P')).toBe('P')
  })

  it('opener answers the shortness after a minor transfer: 3NT with a stopper, else game in the minor', () => {
    expect(bidOver('AQ2 KJ3 KQ4 J432', '1N P 2N P 3C P 3D P')).toBe('3N')
    expect(bidOver('AQ2 KJ32 54 AK32', '1N P 2N P 3C P 3D P')).toBe('5C')
  })

  it('new minor forcing: responder places the contract, and 1♥–1♠–1NT–2♣ is new minor forcing too', () => {
    expect(bidOver('K2 AQ432 Q32 Q32', '1D P 1H P 1N P 2C P 2H P')).toBe('4H')
    expect(bidOver('K2 AQ432 J32 J32', '1D P 1H P 1N P 2C P 2H P')).toBe('P')
    expect(bidOver('K2 AQ432 J32 Q32', '1D P 1H P 1N P 2C P 2N P')).toBe('P')
    expect(bidOver('AQ432 32 K32 K32', '1H P 1S P 1N P')).toBe('2C')
    expect(bidOver('K32 AQ432 Q32 K2', '1H P 1S P 1N P 2C P')).toBe('3S')
    expect(bidOver('AQ43 K32 K32 Q32', '1H P 1S P 1N P')).toBe('4H')
  })

  it('fourth suit forcing: opener shows support, a stopper or shape; also after 1♥–1♠–2♣', () => {
    expect(bidOver('AQ32 K32 4 KJ432', '1C P 1H P 1S P 2D P')).toBe('2H')
    expect(bidOver('AQ32 32 KJ4 KJ32', '1C P 1H P 1S P 2D P')).toBe('2N')
    expect(bidOver('A 75 KQ532 KT765', '1D P 1S P 2C P 2H P')).toBe('3C')
    expect(bidOver('AJ532 Q2 432 AK2', '1H P 1S P 2C P')).toBe('2D')
  })

  it('opener rebids after an inverted raise and after 1♦–2♣', () => {
    expect(bidOver('K32 AQ3 K32 J432', '1C P 2C P')).toBe('2N')
    expect(bidOver('A2 KQ32 AJ432 32', '1D P 2D P')).toBe('2H')
    expect(bidOver('K32 AJ3 KJ32 J32', '1D P 2C P')).toBe('2N')
    expect(bidOver('AT4 AJ7 AJT2 KJ8', '1D P 2C P')).toBe('3N')
  })

  it('after a 2/1 responder raises slowly with extras and jumps to game with a minimum', () => {
    expect(bidOver('KQ3 A2 J32 AKJ32', '1S P 2C P 2S P')).toBe('3S')
    expect(bidOver('K53 A2 J32 KQJ32', '1S P 2C P 2S P')).toBe('4S')
  })

  it('explains these calls the way GIB does', () => {
    expect(meaning('1N P', '4H')).toBe('Texas 轉換：轉到♠，6+ 張♠，10+ 大牌點，迫叫一圈')
    expect(meaning('1N P 2H P 2S P', '4S')).toBe('沒有單張或缺門，有滿貫興趣，6+ 張♠，13–15 大牌點')
    expect(meaning('1C P 1H P 1S P 2D P', '2H')).toBe('支持同伴的♥，3+ 張♥，迫叫成局')
  })
})

describe('after 2♣, weak twos and preempts (§6)', () => {
  it('answers 2♣ with a positive in a good suit, 2NT, or the 2♦ waiting bid', () => {
    expect(bidOver('32 KQJ32 K32 432', '2C P')).toBe('2H')
    expect(bidOver('K2 QJ432 K32 432', '2C P')).toBe('2N')
    expect(bidOver('32 Q432 J32 5432', '2C P')).toBe('2D')
  })

  it('opener rebids 2NT with 22–24 (then the 2NT system), 3NT with 25–27, or a long suit', () => {
    expect(bidOver('AK2 AQ3 KQ54 KQ2', '2C P 2D P')).toBe('2N')
    expect(bidOver('AKQ2 AK3 KQ5 A32', '2C P 2D P')).toBe('3N')
    expect(bidOver('AKQJ32 AK3 AQ 32', '2C P 2D P')).toBe('2S')
    expect(bidOver('K432 Q43 543 432', '2C P 2D P 2N P')).toBe('3C')
  })

  it('answers a weak two: the feature ask, raises by the Law of Total Tricks, a new suit', () => {
    expect(bidOver('A2 AKJ2 KQ32 432', '2S P')).toBe('2N')
    expect(bidOver('Q432 2 J5432 432', '2S P')).toBe('4S')
    expect(bidOver('Q32 32 J5432 432', '2S P')).toBe('3S')
    expect(bidOver('2 AKQJ32 K32 432', '2S P')).toBe('3H')
    expect(bidOver('32 Q432 J32 5432', '2S P')).toBe('P')
  })

  it('opener shows a feature with a maximum', () => {
    expect(bidOver('KQJ932 A2 432 32', '2S P 2N P')).toBe('3H')
    expect(bidOver('KQJ932 32 432 32', '2S P 2N P')).toBe('3S')
  })

  it('raises a preempt or bids 3NT', () => {
    expect(bidOver('Q32 2 J5432 Q432', '3S P')).toBe('4S')
    expect(bidOver('2 AK32 KQ32 KQ32', '3S P')).toBe('3N')
    expect(bidOver('K432 Q2 32 Q5432', '3C P')).toBe('5C')
  })

  it('explains these calls the way GIB does', () => {
    expect(meaning('2C P', '2D')).toBe('等待叫：迫叫一圈')
    // GIB's own example: weak with four trumps or strong with two
    expect(meaning('2S P', '4S')).toBe('打這個合約，2+ 張♠，4+ 總點')
    expect(meaning('2S P', '2N')).toBe('詢問特徵：15+ 大牌點，迫叫一圈')
    expect(meaning('2S P 2N P', '3H')).toBe('特徵：高限，♥有 A 或 K，8–10 大牌點')
  })
})

describe('when the opponents open (§7)', () => {
  it('overcalls directly: Michaels, Unusual 2NT, 1NT, takeout doubles, weak jumps, simple overcalls', () => {
    expect(bidOver('KQJ32 2 AQ432 32', '1H')).toBe('2H')
    expect(bidOver('KQ432 AJ432 32 2', '1C')).toBe('2C')
    // Unusual 2NT: an intermediate hand not vulnerable; vulnerable it needs more
    expect(bidOver('2 32 KQJ32 KJ432', '1S')).toBe('2N')
    expect(bidOver('2 32 KQJ32 KJ432', '1S', 'N', 'Both')).toBe('2D')
    expect(bidOver('AQ2 KJ3 KQ5 J432', '1D')).toBe('1N')
    expect(bidOver('AQ32 2 KJ32 Q432', '1H')).toBe('X')
    expect(bidOver('KQJ932 32 432 32', '1C')).toBe('2S')
    expect(bidOver('KQJ32 32 K32 432', '1C')).toBe('1S')
    expect(bidOver('32 AQJ32 K32 432', '1S')).toBe('2H')
    expect(bidOver('32 Q432 J32 5432', '1S')).toBe('P')
  })

  it('balances lighter, and makes a sandwich 1NT as a passed hand', () => {
    expect(bidOver('K32 32 KJ32 Q432', '1H P P')).toBe('X')
    expect(bidOver('K32 KJ2 Q432 Q32', '1H P P')).toBe('1N')
    expect(bidOver('KQ432 QJ32 32 32', 'P P 1C P 1D')).toBe('1N')
    // With less than 12 and a five-card suit, the suit rather than the double (V4a)
    expect(bidOver('AKT72 95 J83 Q86', '1H P P')).toBe('1S')
    expect(bidOver('AKT72 95 AJ3 Q86', '1H P P')).toBe('X')
  })

  it('acts over a weak two and over 1NT (Cappelletti)', () => {
    expect(bidOver('AQ32 2 KJ32 KQ32', '2H')).toBe('X')
    expect(bidOver('AQ2 KJ3 KQ5 J432', '2H')).toBe('2N')
    expect(bidOver('KQ32 AJ432 32 32', '1N')).toBe('2D')
    expect(bidOver('AKJ932 K2 432 32', '1N')).toBe('2C')
    expect(bidOver('32 AQJ32 KQ32 32', '1N')).toBe('2H')
  })

  it('advances a takeout double', () => {
    expect(bidOver('KQ32 32 AJ32 K32', '1H X P')).toBe('2H')
    expect(bidOver('KQ432 32 AJ32 32', '1H X P')).toBe('4S')
    expect(bidOver('KQ32 32 KJ32 432', '1H X P')).toBe('2S')
    expect(bidOver('J432 432 Q32 432', '1H X P')).toBe('1S')
    expect(bidOver('J32 KJ2 Q432 432', '1H X P')).toBe('1N')
  })

  it('uses Lebensohl after doubling a weak two', () => {
    expect(bidOver('32 432 432 Q8432', '2H X P')).toBe('2N')
    expect(bidOver('AQ32 2 KJ32 KQ32', '2H X P 2N P')).toBe('3C')
    expect(bidOver('32 432 432 Q8432', '2H X P 2N P 3C P')).toBe('P')
    expect(bidOver('32 432 K32 AQ432', '2H X P')).toBe('3C')
    expect(bidOver('J5432 432 432 32', '2H X P')).toBe('2S')
  })

  it('makes responsive doubles, and partner answers them', () => {
    expect(bidOver('K32 32 KJ32 Q432', '1H X 2H')).toBe('X')
    // Equal length: the cheaper suit
    expect(bidOver('AQ32 2 KJ32 Q432', '1H X 2H X P')).toBe('3C')
    expect(bidOver('AQ32 2 KJ432 Q43', '1H X 2H X P')).toBe('3D')
  })

  it('advances an overcall: cue-bid raise, raises, notrump', () => {
    expect(bidOver('K32 A32 KJ32 432', '1C 1S P')).toBe('2C')
    expect(bidOver('K32 Q432 J432 32', '1C 1S P')).toBe('2S')
    expect(bidOver('Q432 2 J5432 432', '1C 1S P')).toBe('4S')
    expect(bidOver('J2 KJ3 Q432 K432', '1C 1S P')).toBe('1N')
  })

  it('advances Michaels, Unusual 2NT and Cappelletti', () => {
    expect(bidOver('Q32 K432 432 432', '1C 2C P')).toBe('2H')
    expect(bidOver('32 32 KJ432 Q432', '1S 2S P')).toBe('2N')
    expect(bidOver('2 KQJ32 AQ432 32', '1S 2S P 2N P')).toBe('3D')
    expect(bidOver('432 Q432 Q32 K32', '1S 2N P')).toBe('3C')
    expect(bidOver('432 Q432 Q32 K32', '1N 2C P')).toBe('2D')
    expect(bidOver('AKJ932 K2 432 32', '1N 2C P 2D P')).toBe('2S')
    expect(bidOver('K32 J432 432 432', '1N 2D P')).toBe('2H')
    expect(bidOver('K32 J2 Q5432 432', '1N 2H P')).toBe('P')
  })

  it('explains these calls the way GIB does', () => {
    expect(meaning('1C', '2C')).toBe('Michaels 扣叫：兩門高花，5+ 張♠，5+ 張♥，8+ 大牌點，迫叫一圈')
    expect(meaning('1H', 'X')).toBe('迫伴賭倍：12+ 大牌點，迫叫一圈')
    expect(meaning('1S', '2N')).toBe('不尋常 2NT：兩門低花，5+ 張♦，5+ 張♣，8–12 大牌點，迫叫一圈')
    expect(meaning('1C', '2S')).toBe('弱跳競叫：6+ 張♠，3–9 大牌點')
    expect(meaning('1C', '1S')).toBe('競叫：5+ 張♠，8–17 大牌點，9–19 總點')
    expect(meaning('1N', '2D')).toBe('Cappelletti：兩門高花，4+ 張♠，4+ 張♥，10–15 大牌點')
    expect(meaning('1H X 2H', 'X')).toBe('回答性賭倍：4+ 張♦，4+ 張♣，7+ 大牌點，迫叫一圈')
  })
})

describe('when our opening is doubled or overcalled (§8)', () => {
  it('makes negative doubles that show the unbid majors', () => {
    expect(bidOver('KJ32 Q432 432 32', '1C 1D')).toBe('X')
    // One major left at the one level: the double shows exactly four, five bid it
    expect(bidOver('KJ32 432 432 Q32', '1D 1H')).toBe('X')
    expect(bidOver('KJ432 32 432 Q32', '1D 1H')).toBe('1S')
    // No major left: both minors
    expect(bidOver('K2 432 KJ32 Q432', '1S 2H')).toBe('X')
  })

  it('raises with the cue bid, bids a free suit, or notrump with a stopper', () => {
    expect(bidOver('K32 A432 K432 32', '1H 1S')).toBe('2S')
    expect(bidOver('J32 Q32 K432 432', '1H 1S')).toBe('2H')
    // Four trumps and a weak hand: the preemptive jump (nine trumps, three level)
    expect(bidOver('32 Q5432 J432 32', '1H 1S')).toBe('3H')
    expect(bidOver('32 AQJ32 K32 432', '1S 2C')).toBe('2H')
    expect(bidOver('KJ2 Q43 432 Q432', '1D 1S')).toBe('1N')
  })

  it('bids a free suit at the three level and 3NT with any game hand (V4a)', () => {
    // The cheapest bid in a new suit over a two-level overcall: 5+ cards, 10+, forcing
    expect(bidOver('AK5 2 AKT8743 63', '1C 2H')).toBe('3D')
    expect(bidOver('AJ 32 K63 KJ9876', '1H 2D')).toBe('3C')
    expect(meaning('1C 2H', '3D')).toBe('5+ 張♦，10+ 大牌點，迫叫一圈')
    // 3NT with their suit stopped is 13+, not 13–15 (these passed)
    expect(bidOver('AJ92 A85 A93 AT8', '1D 2S')).toBe('3N')
    expect(bidOver('AKJ AJT8 K75 Q76', '1D 2H')).toBe('3N')
  })

  it('redoubles, or uses Truscott 2NT, over a double', () => {
    expect(bidOver('KQ32 32 KJ32 Q32', '1H X')).toBe('XX')
    expect(bidOver('K32 A432 K432 32', '1H X')).toBe('2N')
    expect(bidOver('J32 Q32 K432 432', '1H X')).toBe('2H')
    expect(bidOver('KJ432 32 Q32 432', '1H X')).toBe('1S')
  })

  it('uses Unusual vs. Unusual over their 2NT', () => {
    expect(bidOver('K32 A432 K432 32', '1H 2N')).toBe('3C')
    expect(bidOver('AQJ32 2 K32 K432', '1H 2N')).toBe('3D')
  })

  it('opener answers a negative double, or leaves it in for penalty', () => {
    expect(bidOver('A32 KJ32 32 KQ32', '1C 1D X P')).toBe('1H')
    expect(bidOver('A2 32 KQJ32 AQ32', '1C 1D X P')).toBe('P')
  })

  it('opener makes a support double with three trumps, raises with four', () => {
    expect(bidOver('A32 K32 32 KQ432', '1C P 1H 1S')).toBe('X')
    expect(bidOver('A32 K432 3 KQ432', '1C P 1H 1S')).toBe('2H')
  })

  it('opener reopens with a takeout double when short in their suit (W3)', () => {
    // 1♦ (2♠) P (P): 14+ with a doubleton in their suit, 13+ with a singleton, 12+ with a void
    expect(bidOver('43 KJ32 AQJ84 K3', '1D 2S P P')).toBe('X')
    expect(bidOver('4 AK32 AQJ84 K32', '1D 2S P P')).toBe('X')
    expect(bidOver('- KJ32 AJ984 K432', '1D 2S P P')).toBe('X')
    expect(bidOver('4 AK32 AQJ84 K32', '1D 1S P P')).toBe('X')
    expect(explain(GIB, auctionOf('1D 2S P P', 'N'), 'N').get('X')?.name).toBe('takeout')
    // A point fewer, three cards in their suit, or a seven-card suit: pass
    expect(bidOver('43 KJ32 AQ984 K3', '1D 2S P P')).toBe('P')
    expect(bidOver('4 KJ32 AQJ84 J32', '1D 2S P P')).toBe('P')
    expect(bidOver('432 AK32 AQJ8 K3', '1D 2S P P')).toBe('P')
    expect(bidOver('4 A2 AKQJ842 K32', '1D 2S P P')).toBe('P')
  })

  it('responder passes the reopening double for penalty with their suit, otherwise bids (W3)', () => {
    expect(bidOver('KJT98 32 Q3 J654', '1D 2S P P X P')).toBe('P')
    expect(explain(GIB, auctionOf('1D 2S P P X P', 'N'), 'N').get('P')?.name).toBe('penalty')
    expect(bidOver('32 KJ54 Q3 J6542', '1D 2S P P X P')).toBe('3H')
    expect(bidOver('32 J54 Q3 J65432', '1D 2S P P X P')).toBe('3C')
    expect(bidOver('A32 54 Q32 Q6542', '1D 2S P P X P')).toBe('2N')
  })

  it('explains these calls the way GIB does', () => {
    expect(meaning('1C 1D', 'X')).toBe('負性賭倍：4+ 張♠，4+ 張♥，6+ 大牌點，迫叫一圈')
    expect(meaning('1D 1H', 'X')).toBe('負性賭倍：4 張♠，6+ 大牌點，迫叫一圈')
    expect(meaning('1H X', '2N')).toBe('Truscott 2NT：3+ 張♥，10+ 總點，迫叫一圈')
    expect(meaning('1H 2N', '3C')).toBe('對抗不尋常 2NT：3+ 張♥，10+ 總點，迫叫一圈')
    expect(meaning('1C P 1H 1S', 'X')).toBe('支持性賭倍：2–3 張♥，迫叫一圈')
    expect(meaning('1H 1S', '2S')).toBe('扣叫加叫：3+ 張♥，10+ 總點，迫叫一圈')
  })
})

describe('Soloway jump shifts (§9)', () => {
  it('jumps with one of the four hands', () => {
    // A solid suit
    expect(bidOver('AKQJ32 AK2 32 32', '1C P')).toBe('2S')
    // Four-card support for opener (before Jacoby 2NT)
    expect(bidOver('AKJ32 KQ32 A2 32', '1H P')).toBe('2S')
    // 18+ and 5332
    expect(bidOver('AQJ32 KQ2 K2 A32', '1D P')).toBe('2S')
    // Not one of them: a normal response
    expect(bidOver('AQJ32 K32 K2 432', '1C P')).toBe('1S')
    // Not by a passed hand
    expect(bidOver('AKQJ32 AK2 32 32', 'P P 1C P').startsWith('2S')).toBe(false)
  })

  it('opener raises, rebids six cards, shows a side suit with at least KQ, or bids notrump', () => {
    expect(bidOver('K32 K32 A2 QJ432', '1C P 2S P')).toBe('3S')
    expect(bidOver('32 K32 A2 KQJ432', '1C P 2S P')).toBe('3C')
    expect(bidOver('32 K32 AJ32 KQJ2', '1C P 2S P')).toBe('3D')
    expect(bidOver('32 Q432 Q32 AKJ2', '1C P 2S P')).toBe('2N')
  })

  it('the jump shifter shows the type with the next bid', () => {
    expect(bidOver('AKQJ32 AK2 32 32', '1C P 2S P 3C P')).toBe('3S')
    expect(bidOver('AKJ32 KQ32 A32 2', '1H P 2S P 2N P')).toBe('3C')
  })

  it('explains the jump shift the way GIB does', () => {
    expect(meaning('1C P', '2S')).toBe('Soloway 跳叫新花：♠ 可再叫，17+ 總點，4+ 控制，迫叫成局')
  })
})

describe('slams (§10)', () => {
  // 1♠–2NT (Jacoby), 3♠ (18+, no shortness): spades are agreed
  const jacoby = '1S P 2N P 3S P'

  it('asks with RKCB 4NT when the hands are worth a slam', () => {
    expect(bidOver('KQ32 A32 AJ32 K2', jacoby)).toBe('4N')
    expect(bidOver('KQ32 A32 QJ32 32', jacoby)).toBe('4S')
  })

  it('answers RKCB 0314', () => {
    expect(bidOver('AKJ32 KQ2 QJ2 A2', `${jacoby} 4N P`)).toBe('5C')
    expect(bidOver('AKQ32 K32 Q32 32', `${jacoby} 4N P`)).toBe('5S')
    expect(bidOver('AKJ32 KQ2 QJ2 32', `${jacoby} 4N P`)).toBe('5H')
  })

  it('the asker bids the slam, signs off two keycards short, or asks for the queen', () => {
    expect(bidOver('QJ32 A32 AK32 K2', `${jacoby} 4N P 5C P`)).toBe('6S')
    expect(bidOver('J432 A32 AK32 K2', `${jacoby} 4N P 5C P`)).toBe('5D')
    // Opener showed a minimum (4♠): 5♦ is one keycard, two are missing
    expect(bidOver('Q432 KQ2 AQ32 KQ', '1S P 2N P 4S P 4N P 5D P')).toBe('5S')
  })

  it('answers the queen ask and the king ask', () => {
    expect(bidOver('AKQ32 K32 QJ2 A2', `${jacoby} 4N P 5C P 5D P`)).toBe('5H')
    expect(bidOver('AKJ32 K32 QJ2 A2', `${jacoby} 4N P 5C P 5D P`)).toBe('5S')
    expect(bidOver('AKQ32 K32 QJ2 A2', `${jacoby} 4N P 5S P 5N P`)).toBe('6H')
  })

  it('uses DOPI over interference, answers Gerber, and leaves the decision to the asker', () => {
    expect(bidOver('AKJ32 KQ2 QJ2 A2', `${jacoby} 4N 5C`)).toBe('X')
    expect(bidOver('AQ2 KJ3 A54 K432', '1N P 4C P')).toBe('4S')
    expect(bidOver('AKJ32 KQ2 QJ2 A2', `${jacoby} 4N P 5C P 6S P`)).toBe('P')
  })

  it('explains these calls the way GIB does', () => {
    expect(meaning(jacoby, '4N')).toBe('RKCB 0314：有滿貫興趣，迫叫一圈')
    expect(meaning(`${jacoby} 4N P`, '5C')).toBe('回答關鍵張：0 或 3 張關鍵張')
    expect(meaning(`${jacoby} 4N P`, '5H')).toBe('回答關鍵張：2 或 5 張關鍵張，沒有王牌 Q')
    expect(meaning(`${jacoby} 4N P 5C P`, '5D')).toBe('詢問王牌 Q：迫叫一圈')
    expect(meaning('1N P 4C P', '4D')).toBe('回答關鍵張：0 或 4 張 A')
  })
})

describe('when no book covers the auction (§11)', () => {
  const goal = (cards: string, calls: string) => {
    const { h, ctx } = situation(cards, calls)
    return goalFor(h, ctx)
  }
  const call = (cards: string, calls: string) => {
    const { h, ctx } = situation(cards, calls)
    return decide(h, ctx)
  }

  it('aims for a fit, otherwise notrump, at the level the points are worth', () => {
    // Partner opened 1NT, counted as 16: 10 more is game, 17 more a small slam, 6 more a part score
    expect(goal('K32 Q43 K54 Q432', '1N P')).toEqual({ strain: 'N', level: 3, kind: 'game' })
    expect(goal('KQ2 AQ3 K54 K432', '1N P')).toEqual({ strain: 'N', level: 6, kind: 'slam' })
    expect(goal('K32 Q43 J54 5432', '1N P')).toEqual({ strain: 'N', level: 0, kind: 'part' })
    // Partner showed five spades: three of them make a fit
    expect(goal('K32 A43 K54 5432', '1S P')?.strain).toBe('S')
    expect(goal('932 843 J54 5432', '1S P')).toBeNull()
  })

  it('counts the narrower of partner’s ranges (V4a)', () => {
    // Opener answered the negative double with 1♠ (11–14): a weak 4-4 fit stays low, not 3♠ on
    // the opening's 12–22 total points
    expect(bidOver('8643 Q863 92 KQ4', '1C 1D X P 1S P')).toBe('P')
  })

  it('stops once the contract is reached', () => {
    expect(call('AQ2 KJ3 Q54 K432', '1N P 3N P')).toBe('P')
  })

  it('competes over the opponents by the Law of Total Tricks', () => {
    // Partner raised to 2♠ (three trumps): eight trumps stay at two, nine compete to three
    expect(call('AKQ32 43 K54 Q32', '1S P 2S 3H')).toBe('P')
    expect(call('AKQ432 43 K5 Q32', '1S P 2S 3H')).toBe('3S')
  })

  it('explains every bid it might make', () => {
    const calls = explain(FALLBACK_ONLY, auctionOf('1N P 2N P', 'N'), 'N')
    expect(words(calls.get('3N')!, 'zh')).toMatch(/成局/)
    expect(words(calls.get('6N')!, 'zh')).toMatch(/小滿貫/)
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
