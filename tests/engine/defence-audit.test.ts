import { describe, expect, it } from 'vitest'
import { rankOf, rankValue, SEATS, suitOf, type Card, type Hands, type Seat } from '../../shared/cards.ts'
import { legalCards, makeCall, newBoard, playCard, turnOf, type BoardState } from '../../shared/game.ts'
import type { RobotKind } from '../../shared/protocol.ts'
import { chooseCard } from '../../shared/robot/play.ts'

/**
 * The defence audit (fix/tkb-defence-audit, ROBOT.md §3.6): positions from the double-dummy
 * audit of the robots' play where a rule gave a trick away, each reduced to a deal. The hands
 * are given in full; the robot sees only its own, dummy and the cards played.
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

const LOW = 'low'

/** Board 3 (South deals) after the given calls and cards */
function board(cards: Hands, calls: string, played: string[] = []): BoardState {
  let state = newBoard(3, cards)
  for (const call of calls.split(' ')) state = makeCall(state, turnOf(state)!, call)
  for (const card of played) {
    const seat = turnOf(state)!
    const lowest = () => [...legalCards(state, seat)].sort((a, b) => rankValue(rankOf(a)) - rankValue(rankOf(b)))[0]
    state = playCard(state, seat, card === LOW ? lowest() : card)
  }
  return state
}

const KINDS: RobotKind[] = ['tku', 'gib']
const NOTRUMP = '1N P 3N P P P'
const plays = (state: BoardState) => KINDS.map((kind) => chooseCard(state, turnOf(state)!, kind))

describe('second hand', () => {
  it('wins cheaply when dummy, playing next, cannot beat the card', () => {
    // 3NT by South. South leads the ♥4 from JT74 towards dummy's singleton ♥6: West's eight wins
    // the trick, low would hand it to the four
    const cards = hands({ N: 'K53 6 QJT98 KQJ4', S: 'A42 JT74 A2 A532', W: 'QJT9 KQ832 7 986', E: '876 A95 K6543 T7' })
    expect(plays(board(cards, NOTRUMP, ['SQ', 'S3', 'S6', 'SA', 'H4']))).toEqual(['H8', 'H8'])
  })

  it('takes a ten led from dummy with the cheapest sure winner', () => {
    // Dummy leads the ♠T from T86; East's ♠AK54 sit over it: the king, not second hand low
    const cards = hands({ N: 'T86 AQ4 AQ9 K432', S: 'Q97 KJ3 KJT8 AQJ', E: 'AK54 T98 764 T98', W: 'J32 7652 532 765' })
    expect(plays(board(cards, NOTRUMP, ['D2', 'D9', 'D4', 'D8', 'ST']))).toEqual(['SK', 'SK'])
  })

  it('does not ruff when dummy, still to play, is seen to overruff', () => {
    // 4♠ by South; South leads a diamond, West and dummy are both void: dummy's ♠AQ4 overruff
    // any of West's ♠J952, so West throws a loser instead
    const cards = hands({ N: 'AQ4 KQ43 - KQJT98', S: 'KT876 A5 432 A32', W: 'J952 JT9876 - 654', E: '3 2 AKQJT98765 7' })
    for (const card of plays(board(cards, '1S P 4S P P P', ['HJ', 'HQ', 'H2', 'HA', 'D2']))) expect(suitOf(card)).not.toBe('S')
  })
})

describe('discards', () => {
  it('never throws a master to signal', () => {
    // 3NT by South; East, void in clubs, holds ♠AK82 ♥Q865 and the master ♦J: the club robot
    // signals for spades from the hearts, not with the jack
    const cards = hands({ N: 'Q93 J4 87 AKQJT9', S: 'T4 AT93 AKQ9 832', E: 'AK82 Q865 J653 4', W: 'J765 K72 T42 765' })
    const played = ['C7', 'C9', 'C4', 'C2', 'D7', 'D3', 'DA', 'D2', 'DK', 'D4', 'D8', 'D5', 'DQ', 'DT', 'CT', 'D6', 'C3', 'C5', 'CJ']
    for (const card of plays(board(cards, NOTRUMP, played))) expect(card).not.toBe('DJ')
  })

  it('keeps the guards of an honour and throws from a suit with nothing to lose', () => {
    // 3NT by South, running hearts; West (void) holds ♠KT964 (the ace is gone), ♦AKQJ and
    // ♣J73 against declarer's ♣AK62: a club would let the fourth club score, so a spade goes
    const cards = hands({ N: 'J85 8765 T984 85', S: 'A32 AKQJT9 - AK62', W: 'KT9764 - AKQJ J73', E: 'Q 432 76532 QT94' })
    for (const card of plays(board(cards, '2N P 3N P P P', ['S7', 'S5', 'SQ', 'SA', 'HA']))) {
      expect(suitOf(card)).toBe('S')
      expect(card).not.toBe('SK')
    }
  })
})
