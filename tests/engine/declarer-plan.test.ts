import { describe, expect, it } from 'vitest'
import { SEATS, type Card, type Hands, type Seat } from '../../shared/cards.ts'
import { makeCall, newBoard, playCard, turnOf, type BoardState } from '../../shared/game.ts'
import type { RobotKind } from '../../shared/protocol.ts'
import { chooseCard } from '../../shared/robot/play.ts'

/**
 * Drawing trumps (W1, ROBOT.md §3.13): the club president's report that TKB kept cashing side
 * winners the opponents ruffed instead of drawing trumps, and his exception to "leave the last
 * master trump out" (V4c) when it blocks the entry to partner's winners.
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

describe('drawing trumps', () => {
  it("leads low towards declarer's trump honours instead of cashing a side winner", () => {
    // Board 333, 4♠ by North: dummy (South) is in with ♠74 opposite ♠QJ85, ♠KT6 out. West is void
    // in clubs: the ♣J was ruffed. A low trump now
    const cards = hands({ N: 'QJ852 8 A2 QT874', E: '96 KJ9 KJT986 K9', S: 'A74 A62 Q7 AJ653', W: 'KT3 QT7543 543 2' })
    const played = ['DJ', 'DQ', 'D5', 'D2', 'SA', 'S3', 'S2', 'S9', 'CA', 'C2', 'C4', 'C9']
    expect(plays(board(333, cards, '2S 3D 4S P P P', played))).toEqual(['S4', 'S4'])
  })

  it('draws towards partner’s master trump whatever the length of the fit', () => {
    // Board 310, 4♠X by North: dummy ♠J6 opposite ♠KQ98, the ♠A and ♠T52 out
    const cards = hands({ N: 'KQ987 863 652 K4', E: 'T52 K42 Q98 Q762', S: 'J643 T JT74 A853', W: 'A AQJ975 AK3 JT9' })
    const played = ['H2', 'HT', 'HA', 'H3', 'DA', 'D2', 'D8', 'D4', 'DK', 'D5', 'D9', 'D7', 'CJ', 'CK', 'C2', 'C3', 'H6', 'HK', 'S3', 'H5', 'CA', 'CT', 'C4', 'C6', 'C5', 'C9', 'S7', 'C7', 'H8', 'H4', 'S4', 'H9']
    expect(plays(board(310, cards, 'P P 1H 1S 2H 2S 4H 4S P P X P P P', played))).toEqual(['S6', 'S6'])
  })

  it('draws the last master trump when it would take the only entry to dummy', () => {
    // 4♠ by South: only West's ♠A is out. South is void in diamonds, dummy's ♦KQJT are masters and
    // the trumps are the only way across (♠3 to the ♠6): the ♠J knocks the ace out first
    const cards = hands({ S: 'KQJ32 AK2 - AK432', N: '654 54 KQJT9 765', W: 'AT9 QJT9 A876 QJ', E: '87 8763 5432 T98' })
    const played = ['DA', 'D9', 'D2', 'S2', 'SK', 'S9', 'S4', 'S7', 'SQ', 'ST', 'S5', 'S8']
    expect(plays(board(3, cards, '1S P 2D P 4S P P P', played))).toEqual(['SJ', 'SJ'])
  })
})
