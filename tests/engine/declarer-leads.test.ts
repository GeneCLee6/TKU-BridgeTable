import { describe, expect, it } from 'vitest'
import { SEATS, suitOf, type Card, type Hands, type Seat } from '../../shared/cards.ts'
import { makeCall, newBoard, playCard, turnOf, type BoardState } from '../../shared/game.ts'
import type { RobotKind } from '../../shared/protocol.ts'
import { chooseCard } from '../../shared/robot/play.ts'

/**
 * The declaring side's leads of ROBOT.md §3.22: which suit first and when to cash. Set up the next
 * suit rather than cash a bare ace above a gap; cash the suit with the most tricks first; in
 * notrump run a suit that comes in on a normal split before finessing; draw trumps with the short
 * hand's master first; take the finesse now from a hand that will not get the lead again.
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

describe('which suit to set up', () => {
  it('sets up the clubs rather than cash the bare ace of AQ', () => {
    // 3NT by South: the ♦AQ opposite ♦87654 is the longer candidate, but ♦A knocks nothing out
    // and spends the queen; ♣QJT93 opposite ♣82 knocks out the ace and king
    const cards = hands({ N: '765 K54 87654 82', E: '32 9876 T932 K54', S: 'AK4 A32 AQ QJT93', W: 'QJT98 QJT KJ A76' })
    expect(plays(board(3, cards, '1C P 1D P 3N P P P', ['SQ', 'S5', 'S2', 'SA']))).toEqual(['CQ', 'CQ'])
  })

  it('does not cash the ace of AQ in a suit to set up (board 356 of the evaluation deck)', () => {
    // 3NT by South after ♥A and ♣A: ♦AQ opposite dummy's ♦8765; the spades are set up instead
    const cards = hands({ N: 'J982 KJ7 8765 32', E: 'K43 98 KT432 975', S: 'QT6 A654 AQ AKQ8', W: 'A75 QT32 J9 JT64' })
    const state = board(356, cards, 'P P P 2N P 3N P P P', ['H2', 'H7', 'H8', 'HA', 'CA', 'C4', 'C2', 'C5'])
    expect(plays(state).map(suitOf)).not.toContain('D')
  })
})

describe('the order of cashing', () => {
  it('cashes the long running suit before the single winners', () => {
    // 3NT by South with ten tricks on top: the clubs first, the red aces and kings kept
    const cards = hands({ N: '543 543 543 T943', E: '876 876 T9876 65', S: 'A2 AK2 AK2 AKQJ2', W: 'KQJT9 QJT9 QJ 87' })
    const state = board(3, cards, '2N P 3N P P P', ['SK', 'S3', 'S6', 'SA'])
    expect(plays(state).map(suitOf)).toEqual(['C', 'C'])
  })
})

describe('notrump: run the suit that comes in before finessing', () => {
  it('runs ♣AKQ872 opposite ♣654 instead of leading towards dummy (board 492 of the evaluation deck)', () => {
    // 3NT by East, ♦K won: four clubs out, the ace, king and queen bring them in on a 3-1 or 2-2
    // split; the old plan led a spade towards dummy's ♠KQ63 first
    const cards = hands({ N: 'AT974 Q87 542 T3', E: 'J5 KJ K83 AKQ872', S: '82 T643 AQJT7 J9', W: 'KQ63 A952 96 654' })
    const state = board(492, cards, 'P P 1C 1D X P 2C P P 2D 3N P P P', ['DQ', 'D6', 'D5', 'DK'])
    expect(plays(state)).toEqual(['CA', 'CA'])
  })
})

describe('drawing trumps', () => {
  it('leads low to the short hand’s king first, AJ742 opposite K9', () => {
    // 4♥ by South, ♠A won: the king from the short side first, then back for the finesse
    const cards = hands({ N: '6543 K9 K54 A543', E: '87 653 9876 9876', S: 'AK2 AJ742 A32 Q2', W: 'QJT9 QT8 QJT KJT' })
    expect(plays(board(3, cards, '1H P 2H P 4H P P P', ['SQ', 'S3', 'S7', 'SA']))).toEqual(['H2', 'H2'])
  })
})

describe('the last entry', () => {
  it('takes the club finesse from dummy while it is on lead', () => {
    // 3NT by South, dummy won ♠A and has no way back: ♣ towards declarer's ♣AQ5 now, not a heart
    // towards ♥AK65 (that would leave the club finesse to be taken from the wrong side)
    const cards = hands({ N: 'A32 9432 7632 76', E: '76 87 JT98 98432', S: 'K54 AK65 A54 AQ5', W: 'QJT98 QJT KQ KJT' })
    expect(plays(board(3, cards, '2N P 3N P P P', ['SQ', 'SA', 'S6', 'S4']))).toEqual(['C6', 'C6'])
  })

  it('does not when this hand still has a way back', () => {
    // The same, dummy's ♦K is a later entry (♦A of declarer's moved to dummy)
    const cards = hands({ N: 'A32 9432 A632 76', E: '76 87 JT98 98432', S: 'K54 AK65 754 AQ5', W: 'QJT98 QJT KQ KJT' })
    expect(plays(board(3, cards, '2N P 3N P P P', ['SQ', 'SA', 'S6', 'S4']))).not.toEqual(['C6', 'C6'])
  })
})
