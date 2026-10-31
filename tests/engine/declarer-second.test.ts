import { describe, expect, it } from 'vitest'
import { SEATS, type Card, type Hands, type Seat } from '../../shared/cards.ts'
import { makeCall, newBoard, playCard, turnOf, type BoardState } from '../../shared/game.ts'
import type { RobotKind } from '../../shared/protocol.ts'
import { chooseCard } from '../../shared/robot/play.ts'

/**
 * Declarer play, next round (Y4, ROBOT.md §3.14): second hand on the declaring side takes the
 * trick with a master when partner cannot, and AQ with eleven cards plays for the king to drop.
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

describe('second hand on the declaring side', () => {
  it('takes the trick with a master in a trump contract when partner has none of the suit', () => {
    // 4♠ by South; West leads the ♣7 in the middle of the play. Dummy's ♣AK65 against declarer's
    // ♣432: ducking lets East win with the ten
    const cards = hands({ S: 'AKQJ2 32 AK2 432', N: 'T987 A4 543 AK65', W: '65 KQJT9 QJT QJ7', E: '43 8765 9876 T98' })
    const played = ['DQ', 'D3', 'D6', 'DA', 'SA', 'S5', 'S7', 'S3', 'SK', 'S6', 'S8', 'S4', 'DK', 'DJ', 'D4', 'D7', 'D2', 'DT', 'D5', 'D8', 'C7']
    expect(plays(board(3, cards, '1S P 4S P P P', played))).toEqual(['CK', 'CK'])
  })

  it('takes the trick in notrump when partner is void in the suit', () => {
    // Board 916, 6NT by North: West leads the ♠8, dummy has no spade left
    const cards = hands({ N: 'AKQ3 KQ AK96 Q72', E: 'T975 5 T832 9853', S: '4 JT983 Q54 AKJ6', W: 'J862 A7642 J7 T4' })
    const played = ['ST', 'S4', 'SJ', 'SQ', 'HK', 'H5', 'H3', 'HA', 'S8']
    expect(plays(board(916, cards, 'P 2C P 2D P 2N P 6N P P P', played))).toEqual(['SK', 'SK'])
  })

  it('stays low in notrump when partner holds the suit', () => {
    // 3NT by South: West leads the ♥9, dummy's ♥Q32 opposite declarer's ♥AK4
    const cards = hands({ S: 'A32 AK4 KQJT A32', N: '654 Q32 9876 K54', W: 'KQJT7 J98 A2 QJ9', E: '98 T765 543 T876' })
    expect(plays(board(3, cards, '2N P 3N P P P', ['H9']))).toEqual(['H2', 'H2'])
  })
})

describe('finesse or drop', () => {
  it('plays the ace for the king to drop with eleven trumps', () => {
    // 4♠ by South, ♠AQJ987 opposite ♠65432: East follows with the ten, only the king is out
    const cards = hands({ S: 'AQJ987 AK2 K2 A2', N: '65432 43 A43 543', W: 'K QJT98 QJT9 KQJ', E: 'T 765 8765 T9876' })
    const played = ['HQ', 'H3', 'H5', 'HA', 'D2', 'D9', 'DA', 'D5', 'S2', 'ST']
    expect(plays(board(3, cards, '1S P 4S P P P', played))).toEqual(['SA', 'SA'])
  })
})
