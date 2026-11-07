import { describe, expect, it } from 'vitest'
import { SEATS, type Card, type Hands, type Seat } from '../../shared/cards.ts'
import { makeCall, newBoard, playCard, turnOf, type BoardState } from '../../shared/game.ts'
import type { RobotKind } from '../../shared/protocol.ts'
import { chooseCard } from '../../shared/robot/play.ts'

/**
 * Play round of ROBOT.md §3.21: second hand on the declaring side covers when partner has nothing to
 * fight for the trick with, the last hand takes with a card below its master rather than hold up,
 * third hand plays the bottom of its top sequence, and a defender overtakes when the suit is all
 * theirs. Each position is a board of the evaluation deck where the sampling found the loss.
 */

function hand(text: string): Card[] {
  return text.split(' ').flatMap((ranks, i) => [...ranks.replace('-', '')].map((r) => 'SHDC'[i] + r))
}

function hands(given: Record<Seat, string>): Hands {
  const out = {} as Hands
  for (const seat of SEATS) out[seat] = hand(given[seat])
  expect(new Set(SEATS.flatMap((s) => out[s])).size).toBe(52)
  return out
}

function board(no: number, cards: Hands, calls: string, played: string[] = []): BoardState {
  let state = newBoard(no, cards)
  for (const call of calls.split(' ')) state = makeCall(state, turnOf(state)!, call)
  for (const card of played) state = playCard(state, turnOf(state)!, card)
  return state
}

const KINDS: RobotKind[] = ['tku', 'gib']
const plays = (state: BoardState) => KINDS.map((kind) => chooseCard(state, turnOf(state)!, kind))

describe('second hand covers when partner has nothing', () => {
  // Board 49, 3NT by East: dummy (West) has no diamond left, South's ♦KJ96 is over declarer
  const b49 = hands({ N: 'T75432 - 852 KJT9', E: 'A6 A963 AQT74 75', S: '- KQJT82 KJ96 643', W: 'KQJ98 754 3 AQ82' })
  const b49Calls = 'P 1D 2H 2S P 3N P P P'
  const b49Play = ['HK', 'H4', 'S2', 'HA', 'SA', 'H8', 'S8', 'S7', 'DA', 'D9', 'D3', 'D2', 'C5', 'C3', 'CQ', 'CK', 'D8']

  it('covers with the cheapest ten or higher when partner is void with no trump to ruff', () => {
    expect(plays(board(49, b49, b49Calls, b49Play))).toEqual(['DT', 'DT'])
  })

  it('stays low when partner holds a ten or higher', () => {
    // 3NT by South: West leads the ♥9, dummy's ♥Q32 has the queen, declarer stays low from ♥AK4
    const cards = hands({ S: 'A32 AK4 KQJT A32', N: '654 Q32 9876 K54', W: 'KQJT7 J98 A2 QJ9', E: '98 T765 543 T876' })
    expect(plays(board(3, cards, '2N P 3N P P P', ['H9']))).toEqual(['H2', 'H2'])
  })

  it('covers on the opening lead when partner has only small cards', () => {
    // 4♠ by South: West leads the ♦4, dummy's ♦QT5 over declarer's ♦832: the ten, not the five
    const cards = hands({ N: '9876 AK2 QT5 AK4', E: '54 J654 AK76 T98', S: 'AKQJT Q73 832 53', W: '32 T98 J94 QJ762' })
    expect(plays(board(3, cards, '1S P 4S P P P', ['D4']))).toEqual(['DT', 'DT'])
  })

  it('leaves it to partner when partner, void, can ruff', () => {
    // 4♠ by South, dummy void in clubs with trumps: dummy ruffs, declarer's ♣Q stays home
    const cards = hands({ N: '9876 AK2 AT952 -', E: '54 J654 KQ6 KT98', S: 'AKQJT Q73 83 Q53', W: '32 T98 J74 AJ7642' })
    expect(plays(board(3, cards, '1S P 4S P P P', ['C4']))).not.toContain('CQ')
  })
})

describe('the last hand does not hold up when a lower card wins', () => {
  it('takes with the jack from AJ52, keeping the ace', () => {
    // Board 39, 3NT by West: ♦3, dummy's 7, South's 8
    const cards = hands({ N: 'KT52 972 KQ43 75', E: 'AQJ8763 QJ T97 6', S: '9 AT43 86 KQ9432', W: '4 K865 AJ52 AJT8' })
    expect(plays(board(39, cards, 'P 1C P 1S P 1N P 3S P 3N P P P', ['D3', 'D7', 'D8']))).toEqual(['DJ', 'DJ'])
  })

  it('still holds up the ace when no lower card wins', () => {
    // 3NT by South: ♠K led, A32 opposite 654: the rule of seven ducks
    const cards = hands({ S: 'A32 AK4 KQJT A32', N: '654 Q32 9876 K54', W: 'KQJT7 J98 A2 QJ9', E: '98 T765 543 T876' })
    expect(plays(board(3, cards, '2N P 3N P P P', ['SK', 'S4', 'S8']))).toEqual(['S2', 'S2'])
  })
})

describe('third hand on the declaring side', () => {
  it('plays the bottom of its top sequence when there is nothing to finesse', () => {
    // Board 261, 3NT by South: ♥2 towards dummy's ♥QJT7, West's 4: the seven would lose to the eight
    const cards = hands({ N: 'KJ QJT7 Q983 AT3', E: 'T83 AK53 T2 Q974', S: '754 92 AK764 K65', W: 'AQ962 864 J5 J82' })
    const played = ['S6', 'SJ', 'S8', 'S4', 'D3', 'D2', 'DK', 'D5', 'H2', 'H4']
    expect(plays(board(261, cards, '1D P 2N P 3N P P P', played))).toEqual(['HT', 'HT'])
  })
})

describe('a defender overtakes when the suit is all theirs', () => {
  // Board 100, 3NT by South: West's ♠9 is the last spade anyone else holds, East has A87
  const cards = hands({ N: 'Q54 AJ65 A2 JT62', E: 'AJ876 QT7 T65 75', S: 'K3 K92 J984 AK94', W: 'T92 843 KQ73 Q83' })
  const played = ['S2', 'S4', 'SJ', 'SK', 'H2', 'H8', 'HJ', 'HQ', 'S6', 'S3', 'ST', 'SQ', 'CJ', 'C7', 'C4', 'CQ', 'S9', 'S5']

  it('overtakes in notrump with the ace', () => {
    expect(plays(board(100, cards, 'P 1C P 1D P 1H P 3N P P P', played))).toEqual(['SA', 'SA'])
  })

  it('does not overtake while another card of the suit is out', () => {
    // The same position with declarer keeping the ♠4: West's nine is still good, East stays low
    const other = hands({ N: 'Q5 AJ65 A42 JT62', E: 'AJ876 QT7 T65 75', S: 'K43 K92 J98 AK94', W: 'T92 843 KQ73 Q83' })
    const line = ['S2', 'S5', 'SJ', 'SK', 'H2', 'H8', 'HJ', 'HQ', 'S6', 'S3', 'ST', 'SQ', 'CJ', 'C7', 'C4', 'CQ', 'S9', 'D2']
    expect(plays(board(100, other, 'P 1C P 1D P 1H P 3N P P P', line))).not.toContain('SA')
  })
})
