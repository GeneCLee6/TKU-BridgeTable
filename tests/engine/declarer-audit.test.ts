import { describe, expect, it } from 'vitest'
import { SEATS, suitOf, type Card, type Hands, type Seat } from '../../shared/cards.ts'
import { makeCall, newBoard, playCard, turnOf, type BoardState } from '../../shared/game.ts'
import type { RobotKind } from '../../shared/protocol.ts'
import { chooseCard } from '../../shared/robot/play.ts'

/**
 * The declarer audit (fix/tkb-declarer-audit, ROBOT.md §3.7): positions from the double-dummy
 * audit where the declaring side's rules gave a trick away, each reduced to a deal.
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

/** Board 3 (South deals) after the given calls and cards */
function board(cards: Hands, calls: string, played: string[] = []): BoardState {
  let state = newBoard(3, cards)
  for (const call of calls.split(' ')) state = makeCall(state, turnOf(state)!, call)
  for (const card of played) state = playCard(state, turnOf(state)!, card)
  return state
}

const KINDS: RobotKind[] = ['tku', 'gib']
const plays = (state: BoardState) => KINDS.map((kind) => chooseCard(state, turnOf(state)!, kind))

describe('the declarer', () => {
  it('knocks out the one trump above its sequence even with six trumps', () => {
    // 3♦ by West with ♦T964 opposite ♦QJ; the king has gone and only the ace is out
    const cards = hands({ W: 'A32 K62 T964 876', E: 'K84 AJ43 QJ J942', N: 'QJT9 Q75 A873 KQ', S: '765 T98 K52 AT53' })
    const state = board(cards, 'P 1D P 3D P P P', ['D3', 'DJ', 'DK', 'D4', 'S7', 'SA', 'S9', 'S4'])
    for (const card of plays(state)) expect(suitOf(card)).toBe('D')
  })

  it('does not lead a bare honour from a doubleton when nothing in the plan applies', () => {
    // 4♠ by South, trumps drawn, no plan left: not the ♥K from K9 into the ace
    const cards = hands({ S: 'AKQJT9 K9 J86 52', N: '876 T63 T52 QJ84', W: '543 AJ85 Q93 K97', E: '2 Q742 AK74 AT63' })
    const played = ['C7', 'CJ', 'CA', 'C2', 'DA', 'D6', 'D3', 'D2', 'DK', 'D8', 'D9', 'D5', 'C6', 'C5', 'CK', 'C4', 'S3', 'S6', 'S2', 'S9', 'SA', 'S4', 'S7', 'H2', 'SK', 'S5', 'S8', 'H4']
    for (const card of plays(board(cards, '1S P 4S P P P', played))) expect(card).not.toBe('HK')
  })

  it("overtakes dummy's last winner to run the suit from hand", () => {
    // 3NT by South; dummy's ♣K is alone and dummy has no entry: South's ♣AQ654 overtake
    const cards = hands({ N: 'J873 5432 9865 K', S: 'AQ2 AK6 A2 AQ654', E: 'T964 QJT9 QJ3 32', W: 'K5 87 KT74 JT987' })
    const state = board(cards, '2N P 3N P P P', ['D4', 'D5', 'DJ', 'DA', 'S2', 'S5', 'SJ', 'S4', 'CK', 'C2'])
    expect(plays(state)).toEqual(['CA', 'CA'])
  })

  it('wins as cheaply as possible when the last player has shown out', () => {
    // 2♠ by West; South threw a heart on the second round of trumps. West leads the ♠5, North
    // the six: dummy's seven wins, the queen is not needed
    const cards = hands({ W: 'A954 QJ7 K72 A65', E: 'QT73 K54 963 KT4', N: 'KJ862 3 QJ5 J983', S: '- AT9862 AT84 Q72' })
    const played = ['H3', 'H4', 'HA', 'H7', 'D4', 'DK', 'D5', 'D3', 'S4', 'S2', 'ST', 'H2', 'C4', 'C2', 'CA', 'C3', 'S5', 'S6']
    expect(plays(board(cards, 'P 1S P 2S P P P', played))).toEqual(['S7', 'S7'])
  })
})
