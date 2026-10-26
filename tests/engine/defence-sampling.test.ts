import { describe, expect, it } from 'vitest'
import { SEATS, type Card, type Hands } from '../../shared/cards.ts'
import { makeCall, newBoard, playCard, turnOf, type BoardState } from '../../shared/game.ts'
import type { RobotKind } from '../../shared/protocol.ts'
import { chooseCard } from '../../shared/robot/play.ts'

/**
 * Defence from single-dummy sampling (e6-t45, ROBOT.md §3.9): positions from `npm run sim --
 * compare --points defence` (eval/sim/README.md §3.2) where TKB's card scored worst against the
 * sampled layouts, each one board of the evaluation set as it was bid and played up to the
 * decision. The robot sees only its own hand, dummy and the cards played.
 */

/** 'AJ542.Q96.QT5.Q3' (spades first) */
function hand(text: string): Card[] {
  return text.split('.').flatMap((ranks, i) => [...ranks].map((r) => 'SHDC'[i] + r))
}

function position(board: number, given: Record<string, string>, auction: string[], play: string[]): BoardState {
  const hands = {} as Hands
  for (const seat of SEATS) hands[seat] = hand(given[seat])
  let state = newBoard(board, hands)
  for (const call of auction) state = makeCall(state, turnOf(state)!, call)
  for (const card of play) state = playCard(state, turnOf(state)!, card)
  return state
}

const KINDS: RobotKind[] = ['tku', 'gib']
const plays = (state: BoardState) => KINDS.map((kind) => chooseCard(state, turnOf(state)!, kind))

describe('third hand', () => {
  it('does not leave partner’s card to dummy, still to play, when dummy can beat it', () => {
    // Board 285, 3NT by West. South leads the ♠7, West shows out; dummy plays last with ♠98 over
    // the seven: North (AJ5) wins with the jack instead of a count card
    const state = position(
      285,
      { N: 'AJ542.Q96.QT5.Q3', E: '9863.K.KJ.AT9854', S: 'QT7.A8743.9764.6', W: 'K.JT52.A832.KJ72' },
      ['P', 'P', 'P', '1C', '1S', '3C', 'P', '3N', 'P', 'P', 'P'],
      ['S4', 'S3', 'SQ', 'SK', 'H2', 'H6', 'HK', 'HA', 'ST', 'D2', 'S2', 'S6', 'S7', 'C2'],
    )
    expect(plays(state)).toEqual(['SJ', 'SJ'])
  })

  it('takes partner’s card over with the ace when dummy behind holds the king', () => {
    // Board 261, 3NT by South. East returns the ♠8, dummy still holds the ♠K: West's ace, not a
    // count card that lets the king win
    const state = position(
      261,
      { N: 'KJ.QJT7.Q983.AT3', E: 'T83.AK53.T2.Q974', S: '754.92.AK764.K65', W: 'AQ962.864.J5.J82' },
      ['1D', 'P', '2N', 'P', '3N', 'P', 'P', 'P'],
      ['S6', 'SJ', 'ST', 'S4', 'HQ', 'HK', 'H2', 'H4', 'HA', 'H9', 'H8', 'H7', 'S8', 'S5'],
    )
    expect(plays(state)).toEqual(['SA', 'SA'])
  })

  it('forces dummy’s ace out with the card over its next one, keeping the king', () => {
    // Board 87, 3NT by South. East returns the ♠2, dummy behind holds ♠A9: West's KT53 plays the
    // ten (the ace must go, the king is then good), not low
    const state = position(
      87,
      { N: 'A96.K532.85.9872', E: 'QJ42.JT6.K72.653', S: '87.AQ4.AJT4.AKJT', W: 'KT53.987.Q963.Q4' },
      ['1C', 'P', '1H', 'P', '2N', 'P', '3N', 'P', 'P', 'P'],
      ['S3', 'S6', 'SJ', 'S7', 'S2', 'S8'],
    )
    expect(plays(state)).toEqual(['ST', 'ST'])
  })

  it('finesses against dummy’s king with the queen, not the nine under dummy’s ten', () => {
    // Board 114, 4♥ by East. South leads the ♣6, dummy plays low and keeps ♣KT8: North's AQ95
    // plays the queen (the highest card under the king)
    const state = position(
      114,
      { N: '.T95.JT8542.AQ95', E: 'A86.KJ874.Q9.J74', S: 'K97532.62.AK6.62', W: 'QJT4.AQ3.73.KT83' },
      ['P', '2D', 'X', 'P', '4H', 'P', 'P', 'P'],
      ['DA', 'D3', 'DT', 'D9', 'DK', 'D7', 'D2', 'DQ', 'C6', 'C3'],
    )
    expect(plays(state)).toEqual(['CQ', 'CQ'])
  })

  it('does not read a low lead against a suit contract by the rule of eleven', () => {
    // Board 298, 4♠ by East. South leads the ♣6 (a singleton): the rule of eleven would say
    // declarer has nothing over it, but against a suit contract it is as often short. Ace
    const state = position(
      298,
      { N: 'A96.J42.73.AJT85', E: 'K754.K3.KJ.KQ943', S: 'Q8.T9765.AQ984.6', W: 'JT32.AQ8.T652.72' },
      ['1C', '1H', 'X', 'P', '2S', 'P', '4S', 'P', 'P', 'P'],
      ['C6', 'C2'],
    )
    expect(plays(state)).toEqual(['CA', 'CA'])
  })
})

describe('second hand', () => {
  it('covers dummy’s last card of the suit', () => {
    // Board 356, 3NT by South. South leads the ♥5 towards dummy's lone ♥J: West's QT plays the
    // queen, the jack has to fall under it
    const state = position(
      356,
      { N: 'J982.KJ7.8765.32', E: 'K43.98.KT432.975', S: 'QT6.A654.AQ.AKQ8', W: 'A75.QT32.J9.JT64' },
      ['P', 'P', 'P', '2N', 'P', '3N', 'P', 'P', 'P'],
      ['H2', 'H7', 'H8', 'HA', 'SQ', 'SA', 'S2', 'S3', 'CJ', 'C2', 'C9', 'CQ', 'DA', 'D9', 'D5', 'D2', 'CA', 'C4', 'C3', 'C7', 'CK', 'CT', 'D6', 'C5', 'C8', 'C6', 'S8', 'H9', 'H4', 'H3', 'HK', 'DT', 'S9', 'S4', 'ST', 'S7', 'H5'],
    )
    expect(plays(state)).toEqual(['HQ', 'HQ'])
  })

  it('takes the setting trick with the ace', () => {
    // Board 1157, 4♠ by North. The defence has three tricks; North leads a diamond towards
    // dummy's ♦K6: East's ace is the fourth, low lets declarer throw it away
    const state = position(
      1157,
      { N: 'AKQ863.K74.T32.5', E: 'T2.J9862.A98.732', S: '754.QT.KJ6.KQ864', W: 'J9.A53.Q754.AJT9' },
      ['1S', 'P', '1N', 'X', 'P', '2H', '4S', 'P', 'P', 'P'],
      ['H6', 'HT', 'HA', 'H4', 'CA', 'C5', 'C7', 'C4', 'H5', 'H7', 'H9', 'HQ', 'S4', 'S9', 'SQ', 'ST', 'SA', 'S2', 'S5', 'SJ', 'HK', 'H2', 'C6', 'H3', 'D2', 'D8', 'DJ', 'DQ', 'CJ', 'S3', 'C3', 'C8', 'D3'],
    )
    expect(plays(state)).toEqual(['DA', 'DA'])
  })
})

describe('signals', () => {
  it('signals count with a card that cannot take a trick', () => {
    // Board 954, 6♠ by East. East leads the ♠J (the ♠Q is gone); South's T976 sit under dummy's
    // AK84 and the T9 may still win a trick: high-low with the seven, not the ten
    const state = position(
      954,
      { N: '.T864.J42.976543', E: 'QJ2.AQ3.Q7.AJT82', S: 'T9765.J752.AT83.', W: 'AK843.K9.K965.KQ' },
      ['1N', 'P', '2H', 'P', '2S', 'P', '3N', 'P', '4S', 'P', '4N', 'P', '5S', 'P', '6S', 'P', 'P', 'P'],
      ['H2', 'H9', 'HT', 'HQ', 'SQ', 'S5', 'S3', 'C4', 'SJ'],
    )
    expect(plays(state)).toEqual(['S7', 'S7'])
  })
})

describe('notrump: setting up the opening lead first', () => {
  it('keeps at its own suit instead of cashing a side ace', () => {
    // Board 398, 3NT by North. East's ♥K holds; the ♠A is East's entry to the hearts once they
    // are set up: the ♥Q next, not the ace
    const state = position(
      398,
      { N: 'K2.82.AK642.J643', E: 'AJ7.KQJT.3.AT852', S: 'QT9653.A94.Q5.KQ', W: '84.7653.JT987.97' },
      ['1C', '1S', 'P', '1N', 'P', '3N', 'P', 'P', 'P'],
      ['HK', 'H4', 'H7', 'H2'],
    )
    expect(plays(state)).toEqual(['HQ', 'HQ'])
  })

  it('knocks out the stopper of its long suit before cashing', () => {
    // Board 311, 3NT by North. East's ♣K holds and declarer still has the ♣A: East goes on with the
    // ♣Q to knock it out, keeping the ♠A to get back to the clubs
    const state = position(
      311,
      { N: 'K94.Q62.KQ64.A84', E: 'AJ8.84.T.KQJT653', S: '7.AJ75.AJ8732.72', W: 'QT6532.KT93.95.9' },
      ['P', 'P', '1D', '2C', '3D', 'P', '3N', 'P', 'P', 'P'],
      ['CK', 'C2', 'C9', 'C4'],
    )
    expect(plays(state)).toEqual(['CQ', 'CQ'])
  })
})
