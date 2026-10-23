import { describe, expect, it } from 'vitest'
import { contractOf, type AuctionCall } from '../../shared/auction.ts'
import { deal, type Vulnerability } from '../../shared/board.ts'
import { nextSeat, type Card, type Seat } from '../../shared/cards.ts'
import { makeCall, newBoard, turnOf } from '../../shared/game.ts'
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
