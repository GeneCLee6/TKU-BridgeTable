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
    const { call, alert } = chooseCall(state.hands[seat], seat, state.auction, state.dealer, state.vul)
    state = makeCall(state, seat, call, alert)
  }
  while (state.phase === 'play') {
    const seat = turnOf(state)!
    state = playCard(state, seat, chooseCard(state, seat))
  }
  return state
}

/** A hand from text like 'AKQ2 KJ3 Q54 32' (♠ ♥ ♦ ♣; '-' for a void) */
function hand(text: string): Card[] {
  return text.split(' ').flatMap((ranks, i) => [...ranks.replace('-', '')].map((r) => 'SHDC'[i] + r))
}

/** The robot's call after the given calls, the first by `dealer` */
function bidOver(cards: Card[], calls: string, dealer: Seat = 'N', vul: 'None' | 'Both' = 'None') {
  const auction: AuctionCall[] = calls
    .split(' ')
    .filter(Boolean)
    .map((call, i) => ({ seat: nextSeat(dealer, i), call }))
  return chooseCall(cards, nextSeat(dealer, auction.length), auction, dealer, vul).call
}

describe('robots play 300 random boards', () => {
  it('legally, to the end, reaching sensible contracts', () => {
    const levels = new Map<string, number>()
    for (let seed = 1; seed <= 300; seed++) {
      const state = robotBoard(seed, deal(seeded(seed)))
      expect(state.phase).toBe('finished')
      expect(state.auction.length).toBeLessThan(40)
      const c = contractOf(state.auction)
      const key = c ? `${c.level}` : 'passed'
      levels.set(key, (levels.get(key) ?? 0) + 1)
    }
    expect(levels.get('passed') ?? 0).toBeLessThan(60)
    expect((levels.get('3') ?? 0) + (levels.get('4') ?? 0)).toBeGreaterThan(50)
  })
})

describe('openings (淡江制度)', () => {
  it('1NT 15–17 without a five-card major', () => {
    expect(chooseCall(hand('AQ2 KJ3 Q54 K432'), 'N', [], 'N').call).toBe('1N')
    expect(chooseCall(hand('AQ2 KJ3 Q54 K432'), 'N', [], 'N').alert).toContain('15–17')
    // Five clubs is fine, five hearts is not
    expect(bidOver(hand('A2 KJ3 Q54 KQ432'), '')).toBe('1N')
    expect(bidOver(hand('A2 KJ432 Q54 KQ3'), '')).toBe('1H')
  })

  it('five-card majors and the better minor', () => {
    expect(bidOver(hand('AKJ32 K43 Q54 32'), '')).toBe('1S')
    expect(bidOver(hand('A43 K43 Q543 K32'), '')).toBe('1D')
    expect(bidOver(hand('A32 K43 Q54 K432'), '')).toBe('1C')
  })

  it('2♦ is a weak two in one major (一高弱二)', () => {
    expect(bidOver(hand('32 KQJ943 54 432'), '')).toBe('2D')
    expect(bidOver(hand('KQJ943 32 54 432'), '')).toBe('2D')
  })
})

describe('after 1NT', () => {
  it('Stayman, transfers, Texas, minor ask and invitations', () => {
    expect(bidOver(hand('KJ32 Q43 Q54 Q32'), '1N P')).toBe('2C')
    expect(bidOver(hand('32 QJ432 J54 432'), '1N P')).toBe('2D')
    expect(bidOver(hand('QJ432 32 J54 432'), '1N P')).toBe('2H')
    expect(bidOver(hand('KQJ432 32 K54 Q2'), '1N P')).toBe('4H')
    expect(bidOver(hand('2 32 J54 QJ86432'), '1N P')).toBe('2S')
    expect(bidOver(hand('K32 Q43 J54 Q432'), '1N P')).toBe('2N')
    expect(bidOver(hand('K32 Q43 K54 Q432'), '1N P')).toBe('3N')
  })

  it('opener completes transfers, super-accepting with four trumps and 17', () => {
    expect(bidOver(hand('AQ2 KJ3 Q54 K432'), '1N P 2D P')).toBe('2H')
    expect(bidOver(hand('AQ2 KJ32 KQ5 Q32'), '1N P 2D P')).toBe('3H')
    expect(bidOver(hand('AQ2 KJ32 Q54 K43'), '1N P 2C P')).toBe('2H')
    expect(bidOver(hand('AQ2 KJ3 Q54 K432'), '1N P 2C P')).toBe('2D')
    expect(bidOver(hand('AQ2 KJ3 Q54 K432'), '1N P 2S P')).toBe('3C')
  })

  it('responder places the contract after a transfer', () => {
    expect(bidOver(hand('32 QJ432 J54 432'), '1N P 2D P 2H P')).toBe('P')
    expect(bidOver(hand('32 KJ432 K54 Q32'), '1N P 2D P 2H P')).toBe('2N')
    expect(bidOver(hand('32 KJ432 K54 K32'), '1N P 2D P 2H P')).toBe('3N')
  })

  it('uses Lebensohl after an overcall', () => {
    // Weak five-card suit: 2-level, not forcing
    expect(bidOver(hand('KJ432 32 J54 432'), '1N 2D')).toBe('2S')
    // Game values: five-card suit GF at the three level; stopper 2NT relay; no stopper 3NT
    expect(bidOver(hand('K32 Q43 54 KQJ32'), '1N 2D')).toBe('3C')
    expect(bidOver(hand('K32 Q43 KJ5 Q432'), '1N 2D')).toBe('2N')
    expect(bidOver(hand('K32 Q432 54 KQJ2'), '1N 2D')).toBe('3N')
    // Four of their suit and values: penalty double
    expect(bidOver(hand('K32 Q4 KJ54 Q432'), '1N 2D')).toBe('X')
    expect(bidOver(hand('AQ2 KJ3 Q54 K432'), '1N 2D 2N P')).toBe('3C')
  })
})

describe('after 1♥ / 1♠', () => {
  it('Bergen raises with four trumps (松濤版)', () => {
    expect(bidOver(hand('KJ32 Q43 J54 A32'), '1S P')).toBe('3C')
    expect(bidOver(hand('KJ32 Q43 Q54 432'), '1S P')).toBe('3D')
    expect(bidOver(hand('KJ32 J43 54 5432'), '1S P')).toBe('3H')
    expect(bidOver(hand('Q432 J43 54 5432'), '1S P')).toBe('3S')
    expect(bidOver(hand('Q43 KJ32 J54 A32'), '1H P')).toBe('2N')
    expect(bidOver(hand('Q43 KJ32 Q54 432'), '1H P')).toBe('3C')
  })

  it('J2N with game values and splinters with 12–13 and a singleton', () => {
    expect(bidOver(hand('KJ32 AQ3 K54 432'), '1S P')).toBe('2N')
    expect(bidOver(hand('Q43 KJ32 AK4 432'), '1H P')).toBe('2S')
    expect(bidOver(hand('KJ32 AQ43 K543 2'), '1S P')).toBe('4C')
  })

  it('three-card single raise, 1NT forcing and 2/1', () => {
    expect(bidOver(hand('K32 Q43 J54 Q432'), '1S P')).toBe('2S')
    expect(bidOver(hand('32 KQ43 J54 Q432'), '1S P')).toBe('1N')
    expect(bidOver(hand('32 KQ4 AJ543 Q32'), '1S P')).toBe('2D')
    expect(bidOver(hand('KQ43 32 J54 Q432'), '1H P')).toBe('1S')
  })

  it('opener judges Bergen and the single raise', () => {
    expect(bidOver(hand('AKJ32 K43 Q54 32'), '1S P 3C P')).toBe('3S')
    expect(bidOver(hand('AKJ32 K43 AQ4 32'), '1S P 3C P')).toBe('4S')
    // 16 points after a single raise: the club's long-suit try
    expect(bidOver(hand('AKJ32 K43 Q54 A2'), '1S P 2S P')).toBe('3D')
    expect(bidOver(hand('AKJ32 K43 Q54 32'), '1S P 2S P')).toBe('P')
  })

  it('defends against Unusual 2NT the club way', () => {
    // 1♥ (2NT): 3♣ shows a heart fit and invitational values; 3♦ five spades and game values
    expect(bidOver(hand('K32 Q43 KJ5 Q432'), '1H 2N')).toBe('3C')
    expect(bidOver(hand('AKJ32 43 KJ5 Q32'), '1H 2N')).toBe('3D')
    // 1♠ (2NT): 3♦ shows a spade fit; 3♣ five hearts and game values
    expect(bidOver(hand('K32 Q43 KJ5 Q432'), '1S 2N')).toBe('3D')
    expect(bidOver(hand('43 AKJ32 KJ5 Q32'), '1S 2N')).toBe('3C')
  })
})

describe('competition', () => {
  it('overcalls, doubles for takeout and uses Unusual 2NT', () => {
    expect(bidOver(hand('AQJ32 K43 54 432'), '1D')).toBe('1S')
    expect(bidOver(hand('AQ32 K432 5 KJ32'), '1D')).toBe('X')
    expect(bidOver(hand('32 K43 Q54 J9432'), '1D')).toBe('P')
    expect(bidOver(hand('2 3 KJ543 QJ5432'), '1S')).toBe('2N')
  })

  it('makes a responsive double after partner’s takeout double is raised', () => {
    // 1♣ (X) 2♣: both majors, 6–11
    expect(bidOver(hand('KJ32 Q432 J54 32'), '1C X 2C')).toBe('X')
    // 1♥ (X) 2♥: both minors
    expect(bidOver(hand('32 43 KJ54 Q5432'), '1H X 2H')).toBe('X')
  })

  it('answers 2♦ pass-or-correct and the 2NT ask', () => {
    expect(bidOver(hand('K32 Q43 J54 Q432'), '2D P')).toBe('2H')
    expect(bidOver(hand('AK2 KQ3 A54 Q432'), '2D P')).toBe('2N')
    expect(bidOver(hand('32 KQJ943 54 432'), '2D P 2N P')).toBe('3C')
    expect(bidOver(hand('KQJ943 32 A4 432'), '2D P 2N P')).toBe('3H')
    expect(bidOver(hand('KQJ943 32 54 432'), '2D P 2H P')).toBe('2S')
  })
})

describe('card play', () => {
  it('follows suit on every trick of an extreme deal', () => {
    const hands: Hands = {
      N: fullDeck().filter((c) => c[0] === 'S'),
      E: fullDeck().filter((c) => c[0] === 'H'),
      S: fullDeck().filter((c) => c[0] === 'D'),
      W: fullDeck().filter((c) => c[0] === 'C'),
    }
    expect(robotBoard(1, hands).phase).toBe('finished')
  })
})
