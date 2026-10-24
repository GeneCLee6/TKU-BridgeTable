import { describe, expect, it } from 'vitest'
import { deal } from '../../shared/board.ts'
import { fullDeck, rankOf, rankValue, SEATS, type Card, type Hands, type Seat } from '../../shared/cards.ts'
import { legalCards, makeCall, newBoard, playCard, turnOf, type BoardState } from '../../shared/game.ts'
import { chooseCard } from '../../shared/robot/play.ts'
import { robotCall } from '../../shared/robot/robots.ts'

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

describe('the 2/1 robot leads as GIB does', () => {
  it('leads passively against notrump: low from three small', () => {
    const state = board(layout({ W: 'KJ32 Q74 A54 432' }), NOTRUMP)
    expect(chooseCard(state, 'W', 'gib')).toBe('C2')
    expect(chooseCard(state, 'W', 'tku')).toBe('S2')
  })

  it('leads the king from AK', () => {
    expect(chooseCard(board(layout({ W: 'AK3 Q742 J54 432' }), NOTRUMP), 'W', 'gib')).toBe('SK')
    const state = board(layout({ W: 'T32 AK4 Q543 876' }), SPADES)
    expect(chooseCard(state, 'W', 'gib')).toBe('HK')
    expect(chooseCard(state, 'W', 'tku')).toBe('HA')
  })

  it('leads a small doubleton against a suit contract, hoping to ruff', () => {
    expect(chooseCard(board(layout({ W: 'T32 KJ74 Q543 87' }), SPADES), 'W', 'gib')).toBe('C8')
  })

  it("leads low from three small in partner's suit", () => {
    const state = board(layout({ W: 'T32 852 Q543 K87' }), '1S P P 2H 4S P P P')
    expect(chooseCard(state, 'W', 'gib')).toBe('H2')
    expect(chooseCard(state, 'W', 'tku')).toBe('H8')
  })
})

describe('the 2/1 robot signals as GIB does', () => {
  it("encourages partner's lead with a high spot when holding the ace", () => {
    const state = board(layout({ W: 'KQJ4 Q74 A54 432', E: 'A72 9853 T98 765' }), NOTRUMP, ['SK', LOW])
    expect(chooseCard(state, 'E', 'gib')).toBe('S7')
    // The club's robot gives count after a king lead
    expect(chooseCard(state, 'E', 'tku')).toBe('S2')
  })

  it('discourages with the lowest card', () => {
    const state = board(layout({ W: 'KQJ4 Q74 A54 432', E: '9752 A853 T98 76' }), NOTRUMP, ['SK', LOW])
    expect(chooseCard(state, 'E', 'gib')).toBe('S2')
  })

  it("encourages with the queen over dummy's king", () => {
    const state = board(layout({ W: 'T63 Q74 A542 432', N: 'AK5 AK2 K763 AK5', E: 'Q72 9853 T98 765' }), NOTRUMP, ['S3', 'SA'])
    expect(chooseCard(state, 'E', 'gib')).toBe('S7')
  })

  it('plays the lowest of equal cards as third hand', () => {
    const state = board(layout({ W: 'T96 Q742 A54 432', N: 'A53 AK3 K763 AK5', E: 'KQ4 9853 T98 765' }), NOTRUMP, ['ST', 'S3'])
    expect(chooseCard(state, 'E', 'gib')).toBe('SQ')
    expect(chooseCard(state, 'E', 'tku')).toBe('SK')
  })

  it('discards from the shortest side suit with trumps left, without a signal', () => {
    const state = board(layout({ W: 'T AKQJ5432 A K32', E: '32 - J8765 987654' }), SPADES, ['HA', LOW])
    expect(chooseCard(state, 'E', 'gib')).toBe('D5')
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
  })
})

function seeded(seed: number) {
  return (n: number) => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
    return seed % n
  }
}
