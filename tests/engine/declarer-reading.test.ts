import { describe, expect, it } from 'vitest'
import { SEATS, SUITS, type Card, type Hands, type Seat } from '../../shared/cards.ts'
import { makeCall, newBoard, playCard, remainingCards, turnOf, type BoardState } from '../../shared/game.ts'
import type { RobotKind } from '../../shared/protocol.ts'
import { chooseCard } from '../../shared/robot/play.ts'
import { View } from '../../shared/robot/view.ts'

/**
 * Declarer play by reading the cards (T3, ROBOT.md §3.16): the card reading (`card-reading.ts`)
 * from the club's opening leads, count signals, vacant places and the auction's points, and the
 * declarer's hold-up, avoidance and finesse-or-drop decisions that use it.
 */

function hand(text: string): Card[] {
  return text.split('.').flatMap((ranks, i) => [...ranks.replace('-', '')].map((r) => 'SHDC'[i] + r))
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

describe('the card reading', () => {
  it('lists the holdings the club leads a card from (01 fourth best, the rule of eleven)', () => {
    // 3NT by South; West leads the ♠5. Fourth best leaves three cards above it, the second
    // highest from no honour one, the top of a doubleton none
    const cards = hands({ S: 'A42.AK4.KQJT.A32', N: '96.Q32.9876.K654', W: 'KQ753.J98.A2.QJ9', E: 'JT8.T765.543.T87' })
    const state = board(3, cards, '1N P 3N P P P', ['S5'])
    const reading = new View(state, 'N', 'tku').cardReading
    const options = reading.leadOptions()!
    expect(options.length).toBeGreaterThan(0)
    // The holdings are what West may hold now: never a card in view, at most four of the seven out
    for (const h of options) {
      for (const c of h.cards) expect(['SA', 'S4', 'S2', 'S9', 'S6', 'S5']).not.toContain(c)
      expect(h.cards.size).toBeLessThanOrEqual(5)
    }
    // A spot card in notrump leads the longest suit: four or more cards most of the time
    const west = reading.lengthOdds('W', 'S')!
    expect(west.slice(3).reduce((a, b) => a + b, 0)).toBeGreaterThan(0.85)
    expect(reading.len('W', 'S')[1]).toBeLessThanOrEqual(5)
  })

  it('reads a defender’s count signal on the declarer’s lead (high then low: even)', () => {
    // 4♠ by South; the declarer leads ♦ twice and East plays the 8 then the 2: an even number
    const cards = hands({ S: 'AKQJ2.A32.AK4.32', N: 'T987.K54.Q53.AK5', W: '65.QJT9.JT9.QJT9', E: '43.876.8762.8764' })
    const state = board(3, cards, '1S P 4S P P P', ['HQ', 'H4', 'H6', 'HA', 'DA', 'D9', 'D3', 'D8', 'DK', 'DT', 'D5', 'D2'])
    const reading = new View(state, 'S', 'tku').cardReading
    expect(reading.countSignal('E', 'D')).toBe('even')
    // East had an even number: two or none left, never one or three (West's 9 then T: odd)
    const east = reading.lengthOdds('E', 'D')!
    expect(east[1]).toBe(0)
    expect(east[3]).toBe(0)
    expect(east[2]).toBeGreaterThan(0.5)
  })

  it('places an honour with the hand whose points the auction needs', () => {
    // West opened 1NT (15–17) and has played ♣AK: the 9 points out leave East at most one
    const cards = hands({ S: 'AJT98.KJ3.AQ.QT9', N: 'K765.AT2.987.876', W: 'Q3.Q54.KJ42.AKJ2', E: '42.9876.T653.543' })
    const play = ['CK', 'C6', 'C3', 'C9', 'CA', 'C7', 'C4', 'CT', 'D4', 'D7', 'DT', 'DQ', 'S8', 'S3', 'SK', 'S2', 'H2', 'H6']
    const reading = new View(board(4, cards, '1N P P 3S P 4S P P P', play), 'S', 'tku').cardReading
    expect(reading.odds('HQ').W).toBe(1)
    expect(reading.holder('HQ')).toBe('W')
  })

  it('uses only what the robot sees: shuffling the hidden hands changes nothing', () => {
    const cards = hands({ S: 'A42.AK4.KQJT.A32', N: '96.Q32.9876.K654', W: 'KQ753.J98.A2.QJ9', E: 'JT8.T765.543.T87' })
    const state = board(3, cards, '1N P 3N P P P', ['S5', 'S6', 'SJ', 'S2', 'ST', 'S4', 'S3', 'S9'])
    const read = (s: BoardState) => {
      const r = new View(s, 'S', 'tku').cardReading
      const lengths: unknown[] = SUITS.flatMap((suit) => [r.len('W', suit), r.len('E', suit), r.lengthOdds('W', suit)])
      return [...lengths, ...['SK', 'HK', 'DA', 'CQ'].map((c) => r.odds(c))]
    }
    // Swap West's and East's unplayed cards of the same count: the reading must not move
    const hidden = (seat: Seat) => remainingCards(state, seat)
    const playedBy = (seat: Seat) => state.play.filter((p) => p.seat === seat).map((p) => p.card)
    const pool = [...hidden('W'), ...hidden('E')].reverse()
    const shuffled: Hands = { ...state.hands, W: [...playedBy('W'), ...pool.slice(0, hidden('W').length)], E: [...playedBy('E'), ...pool.slice(hidden('W').length)] }
    expect(read({ ...state, hands: shuffled })).toEqual(read(state))
  })
})

describe('View.winsNow', () => {
  it('a card is a master for later rounds but does not win a trick a higher card leads', () => {
    // 4♠ by South; West leads the ♣Q and dummy's ace wins; the declarer then leads the ♠K
    const cards = hands({ S: 'AKQJ2.32.AK2.432', N: 'T987.A4.543.AK65', W: '65.KQJT9.QJT.QJ7', E: '43.8765.9876.T98' })
    const first = new View(board(3, cards, '1S P 4S P P P', ['CQ']), 'N', 'tku')
    expect(first.isMaster('CA')).toBe(true)
    expect(first.winsNow('CA')).toBe(true)
    const state = board(3, cards, '1S P 4S P P P', ['CQ', 'CA', 'C8', 'C2', 'S7', 'S3', 'SA', 'S5', 'SK', 'S6'])
    const view = new View(state, 'N', 'tku')
    // Dummy's ♠T: every card above it is the declarer's or played, but the king on the table beats it
    expect(view.isMaster('ST')).toBe(true)
    expect(view.winsNow('ST')).toBe(false)
  })
})

describe('declarer play from the card reading', () => {
  it('stops holding up once the shorter defender is out and the long hand leads the suit', () => {
    // 3NT; West opened 3♠ and leads the ♠K, ducked; the ♠Q, East discards. The rule of seven
    // (five cards) would duck again: take the ace
    const cards = hands({ W: 'KQJT987.543.76.2', E: '2.QJT9.T985.7643', S: 'A65.AK2.KQJ2.AK5', N: '43.876.A43.QJT98' })
    expect(plays(board(4, cards, '3S P P 3N P P P', ['SK', 'S3', 'S2', 'S5', 'SQ', 'S4', 'H9']))).toEqual(['SA', 'SA'])
  })

  it('keeps the danger hand off lead: no finesse into West’s established suit', () => {
    const cards = hands({ S: 'A64.AK54.AQ32.A2', N: '92.32.765.KQJT98', W: 'KQJ753.986.K84.4', E: 'T8.QJT7.JT9.7653' })
    const play = ['SK', 'S2', 'S8', 'S4', 'SQ', 'S9', 'ST', 'S6', 'SJ', 'C8', 'H7', 'SA', 'C2', 'C4', 'CT', 'C3', 'D5', 'D9']
    expect(plays(board(3, cards, '2N P 3N P P P', play))).toEqual(['DA', 'DA'])
  })

  it('finesses with nine cards when the preempter has few places for the queen', () => {
    // West's 3♥ shows seven hearts: East holds the ♠Q about two times in three
    const cards = hands({ S: 'AKJ54.A3.AKQ.KQJ', N: '7632.654.JT9.AT9', W: '8.KQJT987.432.32', E: 'QT9.2.8765.87654' })
    expect(plays(board(4, cards, '3H P P 4S P P P', ['C3', 'CA', 'C4', 'CJ', 'S2', 'S9']))).toEqual(['SJ', 'SJ'])
  })

  it('does not finesse into the hand that must hold the queen by points', () => {
    const cards = hands({ S: 'AJT98.KJ3.AQ.QT9', N: 'K765.AT2.987.876', W: 'Q3.Q54.KJ42.AKJ2', E: '42.9876.T653.543' })
    const play = ['CK', 'C6', 'C3', 'C9', 'CA', 'C7', 'C4', 'CT', 'D4', 'D7', 'DT', 'DQ', 'S8', 'S3', 'SK', 'S2', 'H2', 'H6']
    expect(plays(board(4, cards, '1N P P 3S P 4S P P P', play))).toEqual(['HK', 'HK'])
  })
})
