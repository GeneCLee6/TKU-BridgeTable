import { describe, expect, it } from 'vitest'
import { deal, dealerOf, vulnerabilityOf } from '../../shared/board.ts'
import { fullDeck, sortHand, type Hands, type Seat } from '../../shared/cards.ts'
import {
  GameError,
  legalCards,
  makeCall,
  makeClaim,
  newBoard,
  playCard,
  remainingCards,
  respondToClaim,
  trickWinner,
  tricksOf,
  tricksWon,
  turnOf,
  undoLast,
  type BoardState,
} from '../../shared/game.ts'

/** A seeded generator so random deals are repeatable */
function seeded(seed: number) {
  return (n: number) => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
    return seed % n
  }
}

/** North holds every spade, East every heart, South every diamond, West every club */
const suitHands: Hands = {
  N: fullDeck().filter((c) => c[0] === 'S'),
  E: fullDeck().filter((c) => c[0] === 'H'),
  S: fullDeck().filter((c) => c[0] === 'D'),
  W: fullDeck().filter((c) => c[0] === 'C'),
}

function bid(state: BoardState, calls: string) {
  for (const call of calls.split(' ')) state = makeCall(state, turnOf(state)!, call)
  return state
}

/** Plays the first legal card for whoever is on turn */
function playOut(state: BoardState, cards = 52) {
  for (let i = 0; i < cards && state.phase === 'play'; i++) {
    const seat = turnOf(state)!
    state = playCard(state, seat, legalCards(state, seat)[0])
  }
  return state
}

describe('board numbering', () => {
  it('rotates the dealer and follows the 16-board vulnerability cycle', () => {
    expect([1, 2, 3, 4, 5].map(dealerOf)).toEqual(['N', 'E', 'S', 'W', 'N'])
    expect([1, 2, 3, 4, 5, 9, 13, 16, 17].map(vulnerabilityOf)).toEqual([
      'None', 'NS', 'EW', 'Both', 'NS', 'EW', 'Both', 'EW', 'None',
    ])
  })

  it('deals 13 distinct cards to each seat', () => {
    const hands = deal(seeded(7))
    const all = Object.values(hands).flat()
    expect(new Set(all).size).toBe(52)
    for (const hand of Object.values(hands)) {
      expect(hand).toHaveLength(13)
      expect(hand).toEqual(sortHand(hand))
    }
  })
})

describe('trickWinner', () => {
  const t = (...cards: string[]) => cards.map((card, i) => ({ seat: (['N', 'E', 'S', 'W'] as Seat[])[i], card }))
  it('takes the highest card of the suit led', () => {
    expect(trickWinner(t('H5', 'HK', 'S2', 'HA'), null)).toBe('W')
    expect(trickWinner(t('H5', 'D2', 'DA', 'C3'), null)).toBe('N')
  })
  it('lets the highest trump win', () => {
    expect(trickWinner(t('HA', 'S2', 'S9', 'HK'), 'S')).toBe('S')
    expect(trickWinner(t('S2', 'HA', 'HK', 'HQ'), 'S')).toBe('N')
  })
})

describe('a full board', () => {
  it('plays a grand slam where every trick is ruffed', () => {
    let state = bid(newBoard(1, suitHands), '7S P P P')
    expect(state.phase).toBe('play')
    expect(state.contract).toEqual({ level: 7, strain: 'S', doubled: '', declarer: 'N' })
    expect(turnOf(state)).toBe('E')

    state = playOut(state)
    expect(state.phase).toBe('finished')
    expect(tricksWon(state)).toEqual({ NS: 13, EW: 0 })
    expect(state.result).toEqual({ declarerTricks: 13, scoreNS: 1510, claimed: false })
  })

  it('makes players follow suit and lets the trick winner lead', () => {
    let state = bid(newBoard(2, deal(seeded(42))), 'P P P 1N P P P')
    const leader = turnOf(state)!
    const lead = legalCards(state, leader)[0]
    state = playCard(state, leader, lead)
    const second = turnOf(state)!
    const sameSuit = remainingCards(state, second).filter((c) => c[0] === lead[0])
    if (sameSuit.length) {
      expect(legalCards(state, second)).toEqual(sameSuit)
      const offSuit = remainingCards(state, second).find((c) => c[0] !== lead[0])
      if (offSuit) expect(() => playCard(state, second, offSuit)).toThrow(GameError)
    }
    state = playOut(state, 3)
    const [first] = tricksOf(state)
    expect(turnOf(state)).toBe(first.winner)
  })

  it('always adds up to 13 tricks on random deals', () => {
    for (let seed = 1; seed <= 20; seed++) {
      let state = bid(newBoard(seed, deal(seeded(seed))), '1C P P P')
      state = playOut(state)
      const won = tricksWon(state)
      expect(won.NS + won.EW).toBe(13)
    }
  })

  it('scores a passed-out board as zero', () => {
    const state = bid(newBoard(3, suitHands), 'P P P P')
    expect(state.phase).toBe('finished')
    expect(state.result?.scoreNS).toBe(0)
  })

  it('rejects calls out of turn and illegal calls', () => {
    const state = bid(newBoard(1, suitHands), '1H')
    expect(() => makeCall(state, 'N', 'P')).toThrow('還沒輪到你叫牌')
    expect(() => makeCall(state, 'E', '1D')).toThrow('不合法的叫品')
  })
})

describe('claims', () => {
  it('settles the remaining tricks once both opponents accept', () => {
    let state = bid(newBoard(1, suitHands), '4S P P P')
    state = playOut(state, 4)
    state = makeClaim(state, 'N', 12)
    expect(() => respondToClaim(state, 'S', true)).toThrow()
    state = respondToClaim(state, 'E', true)
    expect(state.phase).toBe('play')
    state = respondToClaim(state, 'W', true)
    expect(state.phase).toBe('finished')
    // One ruffed trick plus 12 claimed: 4♠ +3, not vulnerable on board 1
    expect(state.result).toEqual({ declarerTricks: 13, scoreNS: 510, claimed: true })
  })

  it('goes back to play when a claim is rejected', () => {
    let state = bid(newBoard(1, suitHands), '4S P P P')
    state = makeClaim(state, 'N', 13)
    state = respondToClaim(state, 'E', false)
    expect(state.claim).toBeUndefined()
    expect(state.phase).toBe('play')
  })

  it('is credited to the declarer when a defender claims', () => {
    let state = bid(newBoard(1, suitHands), '4S P P P')
    state = makeClaim(state, 'E', 3)
    state = respondToClaim(state, 'N', true)
    state = respondToClaim(state, 'W', true)
    expect(state.result?.declarerTricks).toBe(10)
  })
})

describe('undoLast', () => {
  it('takes back a card, then reopens the auction', () => {
    let state = bid(newBoard(1, suitHands), '1S P P P')
    state = playOut(state, 1)
    state = undoLast(state)
    expect(state.play).toHaveLength(0)
    expect(state.phase).toBe('play')
    state = undoLast(state)
    expect(state.phase).toBe('auction')
    expect(state.contract).toBeNull()
    expect(state.auction).toHaveLength(3)
  })
})
