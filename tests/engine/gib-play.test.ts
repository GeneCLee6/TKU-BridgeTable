import { describe, expect, it } from 'vitest'
import { deal } from '../../shared/board.ts'
import { fullDeck, rankOf, rankValue, SEATS, type Card, type Hands, type Seat } from '../../shared/cards.ts'
import { legalCards, makeCall, newBoard, playCard, turnOf, type BoardState } from '../../shared/game.ts'
import { chooseCard } from '../../shared/robot/play.ts'
import { robotCall } from '../../shared/robot/robots.ts'
import { HEAVY_MS } from './heavy.ts'

/** A hand from text like 'AKQ2 KJ3 Q54 32' (♠ ♥ ♦ ♣; '-' for a void) */
function hand(text: string): Card[] {
  return text.split(' ').flatMap((ranks, i) => [...ranks.replace('-', '')].map((r) => 'SHDC'[i] + r))
}

/** The given hands, the other seats filled with the rest of the deck */
function layout(given: Partial<Record<Seat, string>>): Hands {
  const hands = {} as Hands
  for (const seat of SEATS) if (given[seat]) hands[seat] = hand(given[seat])
  const rest = fullDeck().filter((c) => !SEATS.some((s) => hands[s]?.includes(c)))
  for (const seat of SEATS) if (!hands[seat]) hands[seat] = rest.splice(0, 13)
  return hands
}

/** In `board`'s cards: the lowest legal card */
const LOW = 'low'

/** Board 3 (South deals) after the given calls and cards */
function board(hands: Hands, calls: string, cards: string[] = []): BoardState {
  let state = newBoard(3, hands)
  for (const call of calls.split(' ')) state = makeCall(state, turnOf(state)!, call)
  for (const card of cards) {
    const seat = turnOf(state)!
    const lowest = () => [...legalCards(state, seat)].sort((a, b) => rankValue(rankOf(a)) - rankValue(rankOf(b)))[0]
    state = playCard(state, seat, card === LOW ? lowest() : card)
  }
  return state
}

const NOTRUMP = '1N P 3N P P P'
const SPADES = '1S P 4S P P P'

/** Both robots' card at the seat to play: the 2/1 robot plays the cards the club's way (ROBOT.md §3.2) */
const plays = (state: BoardState) => (['tku', 'gib'] as const).map((kind) => chooseCard(state, turnOf(state)!, kind))

describe("the 2/1 robot leads as the club's robot does", () => {
  it('against notrump: fourth best from the longest suit', () => {
    expect(plays(board(layout({ W: 'KJ32 Q74 A54 432' }), NOTRUMP))).toEqual(['S2', 'S2'])
  })

  it('the ace from AK against a suit contract', () => {
    expect(plays(board(layout({ W: 'T32 AK4 Q543 876' }), SPADES))).toEqual(['HA', 'HA'])
  })

  it("01 fourth best in partner's suit: second highest from no honour", () => {
    expect(plays(board(layout({ W: 'T32 852 Q543 K87' }), '1S P P 2H 4S P P P'))).toEqual(['H5', 'H5'])
  })

  it('the suit partner showed with a negative double, not our own (eval/sim/README.md §11)', () => {
    // 1♦ (1♥) X shows four spades; East's 1NT, South leads
    expect(plays(board(layout({ S: 'J842 K3 AQ752 Q6', N: 'KQ53 742 K4 J853' }), '1D 1H X 1N P P P'))).toEqual(['S2', 'S2'])
  })

  it('against a suit contract, the suit partner showed after AK', () => {
    // P (P) 1♦ (1♥) X (2♣): East's double shows four spades, South plays 2♣ and West leads
    const calls = 'P 1D 1H X 2C P P P'
    expect(plays(board(layout({ W: 'Q52 J74 AQJ53 32', E: 'KJ84 653 K4 T854' }), calls))).toEqual(['S2', 'S2'])
    expect(plays(board(layout({ W: 'Q52 AK4 AQJ53 32', E: 'KJ84 653 K4 T854' }), calls))).toEqual(['HA', 'HA'])
  })
})

describe("the 2/1 robot signals as the club's robot does", () => {
  it("gives count after partner's king lead", () => {
    const state = board(layout({ W: 'KQJ4 Q74 A54 432', E: 'A72 9853 T98 765' }), NOTRUMP, ['SK', LOW])
    expect(plays(state)).toEqual(['S2', 'S2'])
  })

  it('plays the lowest of equal cards as third hand', () => {
    const state = board(layout({ W: 'T96 Q742 A54 432', N: 'A53 AK3 K763 AK5', E: 'KQ4 9853 T98 765' }), NOTRUMP, ['ST', 'S3'])
    expect(plays(state)).toEqual(['SQ', 'SQ'])
  })

  it('discards the same card', () => {
    const state = board(layout({ W: 'T AKQJ5432 A K32', E: '32 - J8765 987654' }), SPADES, ['HA', LOW])
    const [tku, gib] = plays(state)
    expect(gib).toBe(tku)
  })
})

describe('2/1 robots play 300 random boards', () => {
  it('legally, to the end', () => {
    for (let seed = 1; seed <= 300; seed++) {
      let state = newBoard(seed, deal(seeded(seed)))
      while (state.phase === 'auction') {
        const seat = turnOf(state)!
        const { call, alert } = robotCall('gib', state.hands[seat], seat, state.auction, state.dealer, state.vul)
        state = makeCall(state, seat, call, alert)
      }
      while (state.phase === 'play') {
        const seat = turnOf(state)!
        state = playCard(state, seat, chooseCard(state, seat, 'gib'))
      }
      expect(state.phase).toBe('finished')
    }
  }, HEAVY_MS)
})

function seeded(seed: number) {
  return (n: number) => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
    return seed % n
  }
}
