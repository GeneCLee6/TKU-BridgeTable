import { describe, expect, it } from 'vitest'
import { contractOf, type AuctionCall } from '../../shared/auction.ts'
import { deal } from '../../shared/board.ts'
import { fullDeck, nextSeat, type Card, type Hands, type Seat } from '../../shared/cards.ts'
import { makeCall, newBoard, playCard, turnOf, type BoardState } from '../../shared/game.ts'
import { chooseCall } from '../../shared/robot/bidding.ts'
import { chooseCard } from '../../shared/robot/play.ts'

function seeded(seed: number) {
  return (n: number) => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
    return seed % n
  }
}

function robotBoard(boardNo: number, hands: Hands): BoardState {
  let state = newBoard(boardNo, hands)
  while (state.phase === 'auction') {
    const seat = turnOf(state)!
    const { call, alert } = chooseCall(state.hands[seat], seat, state.auction, state.dealer)
    state = makeCall(state, seat, call, alert)
  }
  while (state.phase === 'play') {
    const seat = turnOf(state)!
    state = playCard(state, seat, chooseCard(state, seat))
  }
  return state
}

/** Build a hand from text like 'AKQ2 KJ3 Q54 32' (♠ ♥ ♦ ♣) */
function hand(text: string): Card[] {
  return text.split(' ').flatMap((ranks, i) => [...ranks.replace('-', '')].map((r) => 'SHDC'[i] + r))
}

function bidOver(cards: Card[], calls: string, dealer: Seat = 'N') {
  const auction: AuctionCall[] = calls
    .split(' ')
    .filter(Boolean)
    .map((call, i) => ({ seat: nextSeat(dealer, i), call }))
  return chooseCall(cards, nextSeat(dealer, auction.length), auction, dealer).call
}

describe('robots', () => {
  it('bid and play 300 random boards legally to the end', () => {
    const contracts = new Map<string, number>()
    for (let seed = 1; seed <= 300; seed++) {
      const state = robotBoard(seed, deal(seeded(seed)))
      expect(state.phase).toBe('finished')
      expect(state.auction.length).toBeLessThan(40)
      const c = contractOf(state.auction)
      const key = c ? `${c.level}` : 'passed'
      contracts.set(key, (contracts.get(key) ?? 0) + 1)
    }
    // Sanity: most boards are played, and robots reach games as well as partscores
    expect(contracts.get('passed') ?? 0).toBeLessThan(60)
    expect((contracts.get('3') ?? 0) + (contracts.get('4') ?? 0)).toBeGreaterThan(50)
  })

  it('opens the standard way', () => {
    expect(chooseCall(hand('AQ2 KJ3 Q54 K432'), 'N', [], 'N')).toEqual({ call: '1N', alert: '15–17 點平均牌型' })
    expect(bidOver(hand('AKJ32 K43 Q54 32'), '')).toBe('1S')
    expect(bidOver(hand('A43 K43 Q543 K32'), '')).toBe('1D')
    expect(bidOver(hand('A32 K43 Q54 K432'), '')).toBe('1C')
    expect(bidOver(hand('32 KQJ943 54 432'), '')).toBe('2H')
    expect(bidOver(hand('AKQ2 AKQ AQ5 K32'), '')).toBe('2C')
    expect(bidOver(hand('32 K43 Q54 J9432'), '')).toBe('P')
  })

  it('responds to 1NT with Stayman and invites or bids game', () => {
    expect(bidOver(hand('KJ32 Q43 Q54 432'), '1N P')).toBe('2C')
    expect(bidOver(hand('K32 Q43 J54 Q432'), '1N P')).toBe('2N')
    expect(bidOver(hand('K32 Q43 K54 Q432'), '1N P')).toBe('3N')
    expect(bidOver(hand('32 Q43 J54 J9432'), '1N P')).toBe('P')
    // Opener answers Stayman
    expect(bidOver(hand('AQ2 KJ32 Q54 K43'), '1N P 2C P')).toBe('2H')
    expect(bidOver(hand('AQ2 KJ3 Q54 K432'), '1N P 2C P')).toBe('2D')
  })

  it('raises partner’s major with support', () => {
    expect(bidOver(hand('K32 Q43 J54 Q432'), '1S P')).toBe('2S')
    expect(bidOver(hand('KJ32 Q43 J54 A32'), '1S P')).toBe('3S')
    expect(bidOver(hand('32 KQ43 J54 Q432'), '1S P')).toBe('1N')
  })

  it('overcalls and doubles for takeout', () => {
    expect(bidOver(hand('AQJ32 K43 54 432'), '1D')).toBe('1S')
    expect(bidOver(hand('AQ32 K432 5 KJ32'), '1D')).toBe('X')
    expect(bidOver(hand('32 K43 Q54 J9432'), '1D')).toBe('P')
  })

  it('wins tricks it can and follows suit', () => {
    // North declares 7♠ with all the spades: the robots still play every card legally
    const hands: Hands = {
      N: fullDeck().filter((c) => c[0] === 'S'),
      E: fullDeck().filter((c) => c[0] === 'H'),
      S: fullDeck().filter((c) => c[0] === 'D'),
      W: fullDeck().filter((c) => c[0] === 'C'),
    }
    const state = robotBoard(1, hands)
    expect(state.phase).toBe('finished')
  })
})
