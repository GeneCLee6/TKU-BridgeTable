import { describe, expect, it } from 'vitest'
import { SEATS, type Card, type Hands, type Seat } from '../../shared/cards.ts'
import { makeCall, newBoard, playCard, turnOf, type BoardState } from '../../shared/game.ts'
import type { RobotKind } from '../../shared/protocol.ts'
import { chooseCard } from '../../shared/robot/play.ts'
import { TableReading } from '../../shared/robot/reading.ts'

/** A hand from text like 'AKQ2 KJ3 Q54 32' ('-' for a void) */
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

describe("the declarer's plan (e6-t41)", () => {
  it('holds up the only stopper in notrump by the rule of seven', () => {
    // 3NT by North; East leads from KQJT9 against ♠A32 opposite ♠54: duck twice
    const cards = hands({
      N: 'A32 AK2 AK32 432',
      S: '54 Q43 Q54 AKQJ5',
      E: 'KQJT9 765 76 876',
      W: '876 JT98 JT98 T9',
    })
    const auction = 'P P 1N P 3N P P P'
    for (const kind of KINDS) {
      expect(chooseCard(board(cards, auction, ['SK', 'S4', 'S6']), 'N', kind)).toBe('S2')
      expect(chooseCard(board(cards, auction, ['SK', 'S4', 'S6', 'S2', 'SQ', 'S5', 'S7']), 'N', kind)).toBe('S3')
      const third = ['SK', 'S4', 'S6', 'S2', 'SQ', 'S5', 'S7', 'S3', 'SJ', 'H3', 'S8']
      expect(chooseCard(board(cards, auction, third), 'N', kind)).toBe('SA')
    }
  })

  it('cashes a suit from the shorter holding first so it does not block', () => {
    // 1NT by North, enough top tricks; dummy's ♣AQJ5 opposite North's ♣K2: low to the king first
    const cards = hands({
      N: 'AK65 K54 A765 K2',
      S: '432 A32 432 AQJ5',
      E: 'QJT9 QJT 98 T987',
      W: '87 9876 KQJT 643',
    })
    for (const kind of KINDS) expect(chooseCard(board(cards, 'P P 1N P P P', ['HQ', 'HA', 'H6', 'H4']), 'S', kind)).toBe('C5')
  })

  it('plays for the drop with nine cards missing the queen', () => {
    // 4♠ by North: ♠AKJ32 opposite ♠7654; dummy leads low and West follows
    const cards = hands({
      N: 'AKJ32 A32 A32 32',
      S: '7654 54 54 AKQJ5',
      E: 'Q8 KQJT9 KQJ 876',
      W: 'T9 876 T9876 T94',
    })
    const played = ['C8', 'CA', 'C4', 'C2', 'S4', 'S9']
    for (const kind of KINDS) expect(chooseCard(board(cards, 'P P 1S P 4S P P P', played), 'N', kind)).toBe('SK')
  })

  it('ruffs a loser in the hand with fewer trumps before drawing them', () => {
    // 4♠ by North, a trick short of the top tricks: ruff a heart in dummy
    const cards = hands({
      N: 'AKQJ2 A32 432 32',
      S: '543 - 98765 AKQJ5',
      E: 'T98 KQJT9 AK T96',
      W: '76 87654 QJT 874',
    })
    for (const kind of KINDS) {
      expect(chooseCard(board(cards, 'P P 1S P 4S P P P', ['HK', 'D5', 'H4', 'HA']), 'N', kind)).toBe('H2')
    }
  })
})

describe('defending from inferences (e6-t42)', () => {
  it("reads partner's count signal to place the declarer's last card", () => {
    const cards = hands({
      N: 'AKQJ2 A32 432 32',
      S: '543 - 98765 AKQJ5',
      E: 'T98 KQJT9 AK T96',
      W: '76 87654 QJT 874',
    })
    // West follows low then high in clubs: an odd number, so West has the last club
    const played = ['HK', 'D5', 'H4', 'HA', 'C2', 'C6', 'CA', 'C4', 'CK', 'C8', 'C3', 'C9']
    const reading = new TableReading(board(cards, 'P P 1S P 4S P P P', played), 'E', 'tku')
    expect(reading.countSignal('W', 'C')).toBe('odd')
    expect(reading.len('W', 'C')).toEqual([1, 1])
    expect(reading.isVoid('N', 'C')).toBe(true)
    // Only partner's signals are read, and only by a defender
    expect(reading.countSignal('N', 'C')).toBeNull()
    expect(new TableReading(board(cards, 'P P 1S P 4S P P P', played), 'N', 'tku').countSignal('S', 'C')).toBeNull()
  })
})
