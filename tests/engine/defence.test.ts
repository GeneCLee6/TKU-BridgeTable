import { describe, expect, it } from 'vitest'
import { fullDeck, rankOf, rankValue, SEATS, type Card, type Hands, type Seat } from '../../shared/cards.ts'
import { legalCards, makeCall, newBoard, playCard, turnOf, type BoardState } from '../../shared/game.ts'
import type { RobotKind } from '../../shared/protocol.ts'
import { chooseCard } from '../../shared/robot/play.ts'

/**
 * The defence the club reported as weak (fix/tkb-defence-*): second hand letting a lone honour
 * win, third hand not playing high. Each case is a concrete position; the robot sees only its own
 * hand, dummy and the cards played, so the hands it cannot see are filled in any order.
 */

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
  expect(new Set(SEATS.flatMap((s) => hands[s])).size).toBe(52)
  return hands
}

const LOW = 'low'

/** Board 3 (South deals) after the given calls and cards ('low' plays the lowest legal card) */
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

const KINDS: RobotKind[] = ['tku', 'gib']
const NOTRUMP = '1N P 3N P P P'
const SPADES = '1S P 4S P P P'

/** Both robots' choice at the seat to play */
const plays = (state: BoardState) => KINDS.map((kind) => chooseCard(state, turnOf(state)!, kind))

describe('second hand and fourth hand: not letting a lone honour win', () => {
  it('takes the ace over a singleton king led from hand, in notrump, as fourth hand', () => {
    // 3NT by South (1NT, 2+ cards promised everywhere): South leads a singleton ♦K towards dummy's
    // ♦QJT9. Dummy's queens and jacks outside the suit are entries, so there is nothing to shut
    // out by holding up: East takes the king
    const cards = layout({
      N: 'QJ3 Q54 QJT9 QJ4',
      S: 'AK5 AK3 K A98765',
      E: '9876 9876 A32 K3',
    })
    const state = board(cards, NOTRUMP, ['H2', 'H4', 'H6', 'HA', 'DK', LOW, 'D9'])
    expect(plays(state)).toEqual(['DA', 'DA'])
  })

  it('still holds up the stopper when dummy has no entry at all', () => {
    // The same, but dummy has nothing outside diamonds: the king was led from length (2+ by the
    // auction), and taking it would let dummy's suit in later
    const cards = layout({
      N: '543 542 QJT9 432',
      S: 'AKQ AKQ K AKQJ65',
      E: '9876 9876 A32 T9',
    })
    const state = board(cards, NOTRUMP, ['H3', 'H2', 'H6', 'HA', 'DK', LOW, 'D9'])
    expect(plays(state)).toEqual(['D2', 'D2'])
  })

  it('takes the ace over a singleton king in a suit contract, in either seat', () => {
    const east = layout({ N: 'A432 Q54 QJT9 K4', S: 'KQJT5 AK3 K AQJ6', E: '98 9876 A32 8753' })
    expect(plays(board(east, SPADES, ['HJ', 'H4', 'H6', 'HA', 'DK', LOW, 'D9']))).toEqual(['DA', 'DA'])
    const west = layout({ N: 'A432 Q54 QJT9 K4', S: 'KQJT5 AK3 K AQJ6', W: '98 9876 A32 8753' })
    expect(plays(board(west, SPADES, ['H9', 'H4', 'HJ', 'HA', 'DK']))).toEqual(['DA', 'DA'])
  })

  it('rises with the ace when declarer leads low towards a singleton king in dummy', () => {
    // 4♠ by South; dummy's ♦K is alone. Second hand low would let it score
    const cards = layout({ N: 'A432 Q54 K KQJT9', S: 'KQJT5 AK3 J432 A', W: '98 J976 AT876 86' })
    const state = board(cards, SPADES, ['HJ', 'H4', LOW, 'HA', 'D2'])
    expect(plays(state)).toEqual(['DA', 'DA'])
    // With ♦Kx in dummy there is no hurry: second hand low
    const longer = layout({ N: 'A432 Q54 K5 KQJT', S: 'KQJT5 AK3 J432 A', W: '98 J976 AT876 86' })
    expect(plays(board(longer, SPADES, ['HJ', 'H4', LOW, 'HA', 'D2']))).toEqual(['D6', 'D6'])
  })
})

describe('third hand high', () => {
  // 3NT by South; West (a person) leads a low heart, dummy plays low: East must play high
  it('plays high when dummy plays low, not the cheapest card above dummy', () => {
    const cards = layout({ N: 'A32 753 QJT9 K43', E: 'Q876 QT9 A32 872', W: 'T94 KJ84 654 T95' })
    expect(plays(board(cards, NOTRUMP, ['H4', 'H3']))).toEqual(['HQ', 'HQ'])
    // Dummy plays the 7, above the 4: the queen, not the 9
    expect(plays(board(cards, NOTRUMP, ['H4', 'H7']))).toEqual(['HQ', 'HQ'])
  })

  it('plays the lowest of touching honours', () => {
    const cards = layout({ N: 'A32 753 QJT9 K43', E: 'Q876 KQ9 A32 872', W: 'T94 JT84 654 T95' })
    expect(plays(board(cards, NOTRUMP, ['H4', 'H3']))).toEqual(['HQ', 'HQ'])
  })

  it("finesses against dummy's honour with a tenace over it", () => {
    // Dummy keeps the ♥Q; East's ♥KJ9: the jack forces the ace or wins, the king stays over the queen
    const cards = layout({ N: 'A32 Q53 QJT9 K43', E: 'Q876 KJ9 A32 872', W: 'T94 T874 654 T95' })
    expect(plays(board(cards, NOTRUMP, ['H4', 'H3']))).toEqual(['HJ', 'HJ'])
  })

  it("does not overtake a card of partner's that declarer cannot beat (the rule of eleven)", () => {
    // West leads the ♥7, fourth best from KJ975; dummy ♥T83 and East ♥AQ6 hold every other card
    // above the seven, so declarer has none: East keeps the ace and queen
    const cards = layout({ N: 'A32 T83 QJT9 K43', S: 'KJ5 42 K87 AQJ65', E: 'Q876 AQ6 A32 872', W: 'T94 KJ975 654 T9' })
    expect(plays(board(cards, NOTRUMP, ['H7', 'H3']))).toEqual(['H6', 'H6'])
  })

  it("does not overtake partner's honour, but unblocks a doubleton in notrump", () => {
    // West leads the ♥Q from QJT; East's ♥Kxx stays back
    const keep = layout({ N: 'A32 753 QJT9 K43', E: 'Q876 K92 A32 872', W: 'T94 QJT4 654 T95' })
    // (the club's attitude is upside down: the two likes it; both robots play it)
    expect(plays(board(keep, NOTRUMP, ['HQ', 'H3']))).toEqual(['H2', 'H2'])
    // West leads the ♥K from KQJ82 against 3NT; East's ♥A4 overtakes so the suit does not block
    const unblock = layout({ N: 'A32 753 QJT9 K43', E: 'Q876 A4 A32 9876', W: 'T94 KQJ82 654 T5' })
    expect(plays(board(unblock, NOTRUMP, ['HK', 'H3']))).toEqual(['HA', 'HA'])
    // Against a suit contract the king holds: encourage instead
    const suit = layout({ N: 'A32 753 QJT9 K43', S: 'KQJT5 96 K87 AQJ', E: '9876 A4 A32 9876', W: '4 KQJT82 654 T52' })
    expect(plays(board(suit, SPADES, ['HK', 'H3']))).toEqual(['H4', 'H4'])
  })

  it('plays low when dummy, still to play, holds a card above everything we have', () => {
    // East wins the first trick and leads the ♥4; South plays the ♥9; West's ♥KJ cannot beat
    // dummy's ace, so they stay over declarer's queen
    const cards = layout({ N: 'A32 A53 QJT9 K43', S: 'KJ5 Q96 K87 AQJ6', W: 'Q876 KJ2 542 872', E: 'T94 T874 A63 T95' })
    expect(plays(board(cards, NOTRUMP, ['D2', 'D9', 'DA', 'D7', 'H4', 'H9']))).toEqual(['H2', 'H2'])
  })
})
