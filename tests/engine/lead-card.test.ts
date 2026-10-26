import { describe, expect, it } from 'vitest'
import { fullDeck, SEATS, type Card, type Hands, type Seat } from '../../shared/cards.ts'
import { makeCall, newBoard, playCard, turnOf, type BoardState } from '../../shared/game.ts'
import { clubLeadCard } from '../../shared/robot/lead-card.ts'
import { chooseCard } from '../../shared/robot/play.ts'

/**
 * The club's leads (淡江「01 第 4」, the club president 2026-10-26): the card led has no touching
 * card above it and at most one honour above it, AK aside
 */

/** A holding like 'KT94' in spades, highest first */
const suit = (ranks: string): Card[] => [...ranks].map((r) => 'S' + r)
const lead = (ranks: string, trump: 'H' | null) => clubLeadCard(suit(ranks), trump)[1]

describe('the card led from a holding', () => {
  it('against a suit contract', () => {
    const cases: [string, string][] = [
      ['9', '9'],
      ['93', '9'],
      ['K3', 'K'],
      ['A752', 'A'], // never away from an ace
      ['A7', 'A'],
      ['AK4', 'A'],
      ['AK74', 'K'], // AK and length: the king, asking count (can partner ruff the third round?)
      ['KQ74', 'Q'], // KQ without the jack: the queen asks attitude (does partner hold the ace?)
      ['KQJ4', 'K'], // with the jack: the king asks count
      ['QJ3', 'Q'],
      ['JT52', 'J'],
      ['T942', 'T'],
      ['KJT4', 'J'],
      ['KT94', 'T'], // the ten denies the jack
      ['QT93', 'T'],
      ['K742', '2'],
      ['Q73', '3'],
      ['J8642', '4'],
      ['T852', '8'], // the ten is no honour against a suit contract: second highest
      ['9864', '8'], // so the nine is only ever led from a singleton or doubleton
      ['852', '5'],
    ]
    for (const [ranks, card] of cases) expect([ranks, lead(ranks, 'H')]).toEqual([ranks, card])
  })

  it('against notrump', () => {
    const cases: [string, string][] = [
      ['A8532', '3'], // away from an ace is fine
      ['AK52', '2'], // AK alone is no sequence against notrump
      ['AKQ4', 'K'], // strong: the king asks count
      ['AKJ4', 'A'], // the ace asks attitude: does partner hold the queen?
      ['AQJ4', 'Q'],
      ['KQJ4', 'K'], // the king asks count
      ['KQT4', 'Q'], // the queen asks attitude: does partner hold the jack?
      ['KQ54', '4'],
      ['QJT4', 'Q'],
      ['QJ94', 'Q'],
      ['QJ54', '4'],
      ['JT9', 'J'],
      ['JT84', 'J'],
      ['KJT4', 'J'],
      ['KT94', 'T'],
      ['T98', 'T'],
      ['T974', 'T'],
      ['T942', '2'], // T9 without the eight or seven: the ten is an honour, fourth best
      ['T842', '8'], // the ten without the nine is no honour: second highest
      ['K742', '2'],
      ['9643', '6'],
    ]
    for (const [ranks, card] of cases) expect([ranks, lead(ranks, null)]).toEqual([ranks, card])
  })
})

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

/** Board 3 (South deals) after the given calls and cards */
function board(hands: Hands, calls: string, cards: string[] = []): BoardState {
  let state = newBoard(3, hands)
  for (const call of calls.split(' ')) state = makeCall(state, turnOf(state)!, call)
  for (const card of cards) state = playCard(state, turnOf(state)!, card)
  return state
}

describe("TKB's opening lead and partner's answer", () => {
  it('leads the ace, not away from it, against a suit contract', () => {
    // West's only long suit is headed by the ace; every suit holds an ace or is short
    const state = board(layout({ W: 'A8642 A73 A52 A3' }), '1S P 4S P P P')
    expect(chooseCard(state, 'W', 'tku')[1]).toBe('A')
  })

  it('does not lead partner’s suit when it is the trump suit', () => {
    // East overcalled 1♠ and South plays in spades: the KQJ sequence instead of West's trump
    const state = board(layout({ W: '8 9753 KQJ4 T862' }), 'P P P 1S 2S P 4S P P P')
    expect(chooseCard(state, 'W', 'tku')).toBe('DK')
  })

  it('keeps out of the suits the declaring side showed against notrump', () => {
    // South showed hearts, North spades: diamonds, not West's long hearts
    const state = board(layout({ W: 'K94 Q8653 J72 T5' }), '1H P 1S P 1N P 3N P P P')
    expect(chooseCard(state, 'W', 'tku')).toBe('D2')
  })

  it('leads a small doubleton with trump control against a suit contract', () => {
    const state = board(layout({ W: 'A43 K962 Q85 73' }), '1S P 4S P P P')
    expect(chooseCard(state, 'W', 'tku')).toBe('C7')
  })

  it('does not lead away from a lone honour against a suit contract when another suit will do', () => {
    const state = board(layout({ W: '93 K962 875 Q843' }), '1S P 4S P P P')
    expect(chooseCard(state, 'W', 'tku')).toBe('D7')
  })

  it('leads fourth best from Axxxx against notrump', () => {
    const state = board(layout({ W: '942 J63 A8532 T4' }), '1N P 3N P P P')
    expect(chooseCard(state, 'W', 'tku')).toBe('D3')
  })

  it('leads the queen from KQT against notrump, and partner likes it with the jack', () => {
    const cards = layout({ W: 'KQT4 863 T52 974', N: 'A32 Q54 KQJ9 K32', E: 'J65 KJ97 8643 J5' })
    const state = board(cards, '1N P 3N P P P')
    expect(chooseCard(state, 'W', 'tku')).toBe('SQ')
    // Dummy's ace takes; East's jack says come again: the low card (attitude upside down)
    expect(chooseCard(board(cards, '1N P 3N P P P', ['SQ', 'SA']), 'E', 'tku')).toBe('S5')
  })
})
