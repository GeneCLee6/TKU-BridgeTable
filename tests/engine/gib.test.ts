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
