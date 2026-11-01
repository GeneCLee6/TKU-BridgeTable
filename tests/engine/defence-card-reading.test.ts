import { describe, expect, it } from 'vitest'
import { deal } from '../../shared/board.ts'
import { partnerOf, sameSide, type Seat } from '../../shared/cards.ts'
import { makeCall, newBoard, playCard, turnOf, type BoardState } from '../../shared/game.ts'
import type { RobotKind } from '../../shared/protocol.ts'
import { declarerLength } from '../../shared/robot/defence-plan.ts'
import { declarerHas, partnerHolds, placeHonour } from '../../shared/robot/defence-reading.ts'
import { chooseCard } from '../../shared/robot/play.ts'
import { robotCall } from '../../shared/robot/robots.ts'
import { View } from '../../shared/robot/view.ts'
import { playState, type PlayQuestion } from '../../eval/play-quiz.ts'
import { HEAVY_MS } from './heavy.ts'

/**
 * S2 (ROBOT.md §3.18): the defenders read the declarer's hand with the card reading of T3
 * (`card-reading.ts`: the auction, the opening lead, both defenders' count signals, vacant places,
 * the honour layouts the points allow) for switches, discards and second and third hand. Each
 * position is also in the play question bank (tests/play-quiz/*.reading.json).
 */

const position = (hands: PlayQuestion['hands'], auction: string[], play: string[], board = 3) =>
  playState({ id: 't', system: 'both', board, hands, auction, play, answer: play[0], source: 't', reviewer: null, status: 'pending' })

const KINDS: RobotKind[] = ['tku', 'gib']
const both = (state: BoardState) => KINDS.map((kind) => chooseCard(state, turnOf(state)!, kind))

describe('second hand covers by the count of the declarer’s hand', () => {
  it('does not cover the queen from a doubleton the count shows', () => {
    const hands = { N: '654.652.AJT9.AK4', E: '87.T987.762.T976', S: 'AKQJ32.AK4.Q5.32', W: 'T9.QJ3.K843.QJ85' }
    const play = ['CQ', 'CA', 'C6', 'C2', 'S4', 'S8', 'SA', 'S9', 'SK', 'ST', 'S5', 'S7', 'HA', 'H3', 'H2', 'H8', 'HK', 'HJ', 'H5', 'H7', 'H4', 'HQ', 'H6', 'H9', 'CJ', 'CK', 'C7', 'C3', 'C4', 'C9', 'S2', 'C5', 'DQ']
    const state = position(hands, ['1S', 'P', '3S', 'P', '4S', 'P', 'P', 'P'], play)
    // Partner's even count in spades and hearts, the club ruff: the declarer's four cards are three spades and the ♦5
    expect(declarerHas(new View(state, 'W', 'tku'), 'D', 0, 1)).toBe(1)
    for (const card of both(state)) expect(['D3', 'D4', 'D8']).toContain(card)
  })
})

describe('third hand from the card reading', () => {
  it('plays the queen from AQ when the declarer’s points place the king with partner (notrump)', () => {
    const hands = { S: 'AK3.J74.AKQ2.432', W: '7642.KT63.93.A76', N: 'Q5.952.J876.KQ95', E: 'JT98.AQ8.T54.JT8' }
    const play = ['S2', 'S5', 'S8', 'SK', 'DA', 'D3', 'D6', 'D4', 'DK', 'D9', 'D7', 'D5', 'DQ', 'S4', 'D8', 'DT', 'SA', 'S6', 'SQ', 'S9', 'C2', 'CA', 'C5', 'C8', 'H3', 'H2']
    const state = position(hands, ['1N', 'P', '3N', 'P', 'P', 'P'], play)
    const view = new View(state, 'E', 'tku')
    // 1NT is 15–17 and the declarer has shown 16
    expect(partnerHolds(view, 'HK')).toBe(1)
    expect(placeHonour(view, 'HK')).toBe('W')
    expect(both(state)).toEqual(['HQ', 'HQ'])
  })

  it('still plays the ace against a suit contract', () => {
    // 4♠ after a 3♠ opening: the king is more likely partner's, but a singleton king falls under the ace
    const hands = { N: 'A43.T72.AKQ7.J65', E: '52.AQ8.JT84.AKQ2', S: 'KQJT987.4.952.43', W: '6.KJ9653.63.T987' }
    expect(both(position(hands, ['3S', 'P', '4S', 'P', 'P', 'P'], ['H6', 'H2']))).toEqual(['HA', 'HA'])
  })
})

describe('discards guard against dummy’s honours', () => {
  it('counts dummy’s ace above our king when dummy is long enough to use it', () => {
    const hands = { N: 'A65.54.AKQJT9.65', S: 'J32.AK6.32.AKQ43', W: 'K7.QJ982.4.JT987', E: 'QT984.T73.8765.2' }
    const state = position(hands, ['1N', 'P', '3N', 'P', 'P', 'P'], ['CJ', 'C5', 'C2', 'CA', 'D3', 'D4', 'DT', 'D5', 'DA', 'D6', 'D2'])
    const view = new View(state, 'W', 'tku')
    // Discarding from K7 under dummy's A65 leaves the king bare: 4 more than the hearts or clubs
    expect(declarerLength(view, 'S', ['SK', 'S7'], ['SA', 'S6', 'S5'])).toBeGreaterThanOrEqual(4)
  })
})

describe('the defence uses only what it sees', () => {
  function seeded(seed: number) {
    return () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed
    }
  }

  /** The declarer's and partner's unplayed cards swapped between the two hands (same counts) */
  function swapped(state: BoardState, seat: Seat): BoardState {
    const declarer = state.contract!.declarer
    const partner = partnerOf(seat)
    const played = new Set(state.play.map((p) => p.card))
    const left = (s: Seat) => state.hands[s].filter((c) => !played.has(c))
    const kept = (s: Seat) => state.hands[s].filter((c) => played.has(c))
    const pool = [...left(partner), ...left(declarer)]
    const n = left(declarer).length
    return { ...state, hands: { ...state.hands, [declarer]: [...kept(declarer), ...pool.slice(0, n)], [partner]: [...kept(partner), ...pool.slice(n)] } }
  }

  it('plays the same card with the declarer’s and partner’s hidden cards swapped, on 40 boards', { timeout: HEAVY_MS }, () => {
    let checked = 0
    for (const kind of KINDS) {
      for (let no = 1; no <= 40; no++) {
        const random = seeded(no * 7919 + 13)
        let state = newBoard(no, deal((n: number) => random() % n))
        while (state.phase === 'auction') {
          const seat = turnOf(state)!
          state = makeCall(state, seat, robotCall(kind, state.hands[seat], seat, state.auction, state.dealer, state.vul).call)
        }
        while (state.phase === 'play') {
          const seat = turnOf(state)!
          const card = chooseCard(state, seat, kind)
          if (!sameSide(seat, state.contract!.declarer)) {
            expect(chooseCard(swapped(state, seat), seat, kind), `${kind} board ${no} card ${state.play.length}`).toBe(card)
            checked++
          }
          state = playCard(state, seat, card)
        }
      }
    }
    expect(checked).toBeGreaterThan(500)
  })
})
