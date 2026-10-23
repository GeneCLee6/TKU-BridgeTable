import { describe, expect, it } from 'vitest'
import { deal } from '../../shared/board.ts'
import { fullDeck, nextSeat, SEATS, sideOf, SUITS, suitOf, type Card, type Seat, type Side, type Suit } from '../../shared/cards.ts'
import { makeCall, makeClaim, newBoard, playCard, trickWinner, turnOf, legalCards, type BoardState } from '../../shared/game.ts'
import { acceptsClaim } from '../../shared/robot/claim.ts'
import { canTake, type DoubleDummyPosition } from '../../shared/robot/dd.ts'

function seeded(seed: number) {
  return (n: number) => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
    return seed % n
  }
}

/** A hand from text like 'AKQ2 KJ3 Q54 32' (♠ ♥ ♦ ♣; '-' for a void) */
function hand(text: string): Card[] {
  return text.split(' ').flatMap((ranks, i) => [...ranks.replace('-', '')].map((r) => 'SHDC'[i] + r))
}

/** The most tricks `side` takes with best play by everyone: plain minimax, for small endings */
function bruteForce(position: DoubleDummyPosition, side: Side): number {
  const hands = Object.fromEntries(SEATS.map((s) => [s, [...position.hands[s]]])) as Record<Seat, Card[]>
  const trump = position.trump
  const best = (trick: { seat: Seat; card: Card }[], leader: Seat): number => {
    if (trick.length === 4) {
      const winner = trickWinner(trick, trump)
      return (sideOf(winner) === side ? 1 : 0) + best([], winner)
    }
    const seat = nextSeat(leader, trick.length)
    const cards = hands[seat]
    if (!cards.length) return 0
    const led = trick[0] && suitOf(trick[0].card)
    const legal = led && cards.some((c) => suitOf(c) === led) ? cards.filter((c) => suitOf(c) === led) : cards
    const results = legal.map((card) => {
      hands[seat] = cards.filter((c) => c !== card)
      const value = best([...trick, { seat, card }], leader)
      hands[seat] = cards
      return value
    })
    return sideOf(seat) === side ? Math.max(...results) : Math.min(...results)
  }
  return best([...position.trick], position.leader)
}

describe('double-dummy solver', () => {
  it('agrees with plain minimax on random endings', () => {
    const random = seeded(11)
    for (let round = 0; round < 150; round++) {
      const size = 1 + random(4)
      const deck = fullDeck()
      for (let i = deck.length - 1; i > 0; i--) {
        const j = random(i + 1)
        ;[deck[i], deck[j]] = [deck[j], deck[i]]
      }
      const hands = Object.fromEntries(SEATS.map((s, i) => [s, deck.slice(i * size, (i + 1) * size)])) as Record<Seat, Card[]>
      const trump: Suit | null = random(5) === 4 ? null : SUITS[random(4)]
      const leader = SEATS[random(4)]
      // Sometimes start in the middle of a trick
      const trick: { seat: Seat; card: Card }[] = []
      for (let k = random(3); k > 0; k--) {
        const seat = nextSeat(leader, trick.length)
        const led = trick[0] && suitOf(trick[0].card)
        const options = led && hands[seat].some((c) => suitOf(c) === led) ? hands[seat].filter((c) => suitOf(c) === led) : hands[seat]
        const card = options[random(options.length)]
        hands[seat] = hands[seat].filter((c) => c !== card)
        trick.push({ seat, card })
      }
      const position = { hands, trick, leader, trump }
      const side: Side = random(2) ? 'NS' : 'EW'
      const most = bruteForce(position, side)
      for (let tricks = 0; tricks <= size; tricks++) expect(canTake(position, side, tricks), `round ${round}, ${tricks} tricks`).toBe(tricks <= most)
    }
  })

  it('finds a finesse that works and knows one that fails', () => {
    // South leads towards North's ♠AQ; East's king sits under it only when West holds it
    const position = (westKing: boolean): DoubleDummyPosition => ({
      hands: {
        N: hand('AQ - - -'),
        E: westKing ? hand('32 - - -') : hand('K3 - - -'),
        S: hand('54 - - -'),
        W: westKing ? hand('K6 - - -') : hand('62 - - -'),
      },
      trick: [],
      leader: 'S',
      trump: null,
    })
    expect(canTake(position(true), 'NS', 2)).toBe(true)
    expect(canTake(position(false), 'NS', 2)).toBe(false)
    expect(canTake(position(false), 'NS', 1)).toBe(true)
  })

  it('reads a full deal within its budget, or says it gave up', () => {
    const hands = deal(seeded(3))
    const started = Date.now()
    const answer = canTake({ hands, trick: [], leader: 'E', trump: 'S' }, 'NS', 7)
    expect([true, false, null]).toContain(answer)
    expect(Date.now() - started).toBeLessThan(2000)
  })
})

describe('a robot asked to accept a claim', () => {
  /** North declares 3NT with East on lead, then the first `cards` legal cards are played */
  function claimAfter(hands: Record<Seat, Card[]>, cards: number, tricks: number): BoardState {
    let state = newBoard(1, hands)
    for (const call of ['3N', 'P', 'P', 'P']) state = makeCall(state, turnOf(state)!, call)
    for (let i = 0; i < cards; i++) {
      const seat = turnOf(state)!
      state = playCard(state, seat, legalCards(state, seat)[0])
    }
    return makeClaim(state, 'N', tricks)
  }

  // North–South hold every top card in spades and hearts
  const hands: Record<Seat, Card[]> = {
    N: hand('AKQJ AKQJ 432 32'),
    E: hand('T98 T98 AKQ AKQJ'),
    S: hand('765 765 765 7654'),
    W: hand('432 432 JT98 T98'),
  }

  it('accepts a claim the cards make good', () => {
    // North wins the first trick with ♠A and leads seven top winners in the majors
    const state = claimAfter(hands, 4, 0)
    expect(acceptsClaim({ ...state, claim: { ...state.claim!, tricks: 7 } }, 'E')).toBe(true)
  })

  it('rejects a claim of more than the cards allow', () => {
    const state = claimAfter(hands, 4, 0)
    // The minors all belong to East–West
    expect(acceptsClaim({ ...state, claim: { ...state.claim!, tricks: 8 } }, 'E')).toBe(false)
  })

  it('goes along with its partner and always accepts a concession', () => {
    const state = claimAfter(hands, 4, 0)
    expect(acceptsClaim({ ...state, claim: { seat: 'E', tricks: 12, accepted: [] } }, 'W')).toBe(true)
    expect(acceptsClaim(state, 'W')).toBe(true)
  })
})
