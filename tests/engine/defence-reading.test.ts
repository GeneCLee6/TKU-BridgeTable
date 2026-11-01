import { describe, expect, it } from 'vitest'
import { turnOf } from '../../shared/game.ts'
import { chooseCard } from '../../shared/robot/play.ts'
import { declarerLen, dummyDiscards, partnerAttitude, partnerCount, placeHonour, runningPreference, runningSuitAt } from '../../shared/robot/defence-reading.ts'
import { View } from '../../shared/robot/view.ts'
import { playState, type PlayQuestion } from '../../eval/play-quiz.ts'

/**
 * T4 (ROBOT.md §3.16): the defenders read partner's signals and count the declarer's hand. Each
 * position is also in the play question bank (tests/play-quiz/*.reading.json).
 */

const position = (hands: PlayQuestion['hands'], auction: string[], play: string[], board = 3) =>
  playState({ id: 't', system: 'both', board, hands, auction, play, answer: play[0], source: 't', reviewer: null, status: 'pending' })

const both = (state: ReturnType<typeof position>) => (['tku', 'gib'] as const).map((kind) => chooseCard(state, turnOf(state)!, kind))

const HOLD_UP = { N: 'AK7.AQ.32.AKT942', E: 'T862.J973.764.Q6', S: '543.642.KQJT9.73', W: 'QJ9.KT85.A85.J85' }
const ONE_CLUB = ['1C', 'P', '1D', 'P', '3N', 'P', 'P', 'P']

describe("reading partner's signals", () => {
  it("reads one card of partner's count for the hold-up, and holds up the ace", () => {
    const state = position(HOLD_UP, ONE_CLUB, ['H3', 'H2', 'HK', 'HA', 'CA', 'C6', 'C3', 'C5', 'D2', 'D4', 'DK'], 1)
    const view = new View(state, 'W', 'tku')
    // Only the 3 lower than partner's 4 is out of view: a low card, an odd number
    expect(partnerCount(view, 'D')).toBeNull()
    expect(partnerCount(view, 'D', true)).toBe('odd')
    expect(declarerLen(view, 'D', true)[0]).toBe(1)
    expect(both(state)).toEqual(['D5', 'D5'])
  })

  it("takes the ace when partner's count leaves the declarer none", () => {
    const hands = { N: 'AK7.AQ.2.AKT9842', E: 'T862.J973.7643.Q', S: '543.642.KQJT9.73', W: 'QJ9.KT85.A85.J65' }
    const state = position(hands, ONE_CLUB, ['H3', 'H2', 'HK', 'HA', 'CA', 'CQ', 'C3', 'C5', 'D2', 'D7', 'DK'], 1)
    expect(partnerCount(new View(state, 'W', 'tku'), 'D', true)).toBe('even')
    expect(both(state)).toEqual(['DA', 'DA'])
  })

  it('does not read the Smith Echo trick as count', () => {
    // Diamonds are the first suit the declarer plays in notrump
    const state = position(HOLD_UP, ONE_CLUB, ['H3', 'H2', 'HK', 'HA', 'D2', 'D4', 'DK'], 1)
    expect(partnerCount(new View(state, 'W', 'tku'), 'D', true)).toBeNull()
  })

  it("reads partner's attitude to our lead (the club's reverse attitude)", () => {
    const hands = { N: '765.QJ4.73.KQJT9', E: 'AKJT.7632.J652.8', S: '432.AK5.AKQ4.732', W: 'Q98.T98.T98.A654' }
    const high = position(hands, ['1N', 'P', '3N', 'P', 'P', 'P'], ['HT', 'H4', 'H7', 'HA'])
    expect(partnerAttitude(new View(high, 'W', 'tku'), 'H')).toBe('dislike')
    const low = position(hands, ['1N', 'P', '3N', 'P', 'P', 'P'], ['HT', 'H4', 'H2', 'HA'])
    expect(partnerAttitude(new View(low, 'W', 'tku'), 'H')).toBe('like')
  })

  it("reads suit preference while dummy's long suit runs, and gives it the same way", () => {
    const hands = { N: '652.74.AKQJ2.643', E: '743.8632.9873.AK', S: 'AKQJ9.KQ5.54.QJ7', W: 'T8.AJT9.T6.T9852' }
    const auction = ['1S', 'P', '2D', 'P', '3S', 'P', '4S', 'P', 'P', 'P']
    const drawn = ['S8', 'S2', 'S3', 'S9', 'SA', 'ST', 'S5', 'S4', 'SK', 'C2', 'S6', 'S7']
    // East, with the club winners, asks for clubs (the lower of hearts and clubs) with its lowest diamond
    const asking = position(hands, auction, [...drawn, 'D4', 'D6', 'DA'])
    expect(runningSuitAt(new View(asking, 'E', 'tku'), 12, 'S')).toBe('D')
    expect(chooseCard(asking, 'E', 'tku')).toBe('D3')
    const play = [...drawn, 'D4', 'D6', 'DA', 'D3', 'DK', 'D7', 'D5', 'DT', 'DQ', 'D8', 'C7', 'C5', 'DJ', 'D9', 'H5', 'C8', 'H7', 'H2', 'HK', 'HA']
    const state = position(hands, auction, play)
    expect(runningPreference(new View(state, 'W', 'tku'), 'S')).toBe('C')
    expect(both(state)).toEqual(['CT', 'CT'])
  })
})

describe("counting the declarer's hand", () => {
  it("places the missing honours with partner from the declarer's points", () => {
    const hands = { N: '765.QJ4.73.KQJT9', E: 'AKJT.7632.J652.8', S: '432.AK5.AKQ4.732', W: 'Q98.T98.T98.A654' }
    const play = ['HT', 'H4', 'H7', 'HA', 'DA', 'D8', 'D3', 'D2', 'DK', 'D9', 'D7', 'D5', 'DQ', 'DT', 'S5', 'D6', 'HK', 'H8', 'HJ', 'H3', 'C2', 'CA', 'C9', 'C8']
    const state = position(hands, ['1N', 'P', '3N', 'P', 'P', 'P'], play)
    const view = new View(state, 'W', 'tku')
    // 1NT is 15–17 and the declarer has shown 16
    expect(placeHonour(view, 'SA')).toBe('E')
    expect(placeHonour(view, 'SK')).toBe('E')
    expect(both(state)).toEqual(['S8', 'S8'])
  })

  it("counts the declarer's discards on dummy's suit", () => {
    // Dummy's AKQ of hearts: the declarer showed four hearts (Stayman), so there is no discard
    const hands = { N: 'J73.AKQ.8642.932', E: 'KQ98.9765.KT.J74', S: 'A54.JT43.AQ5.AK5', W: 'T62.82.J973.QT86' }
    const state = position(hands, ['1N', 'P', '2C', 'P', '2H', 'P', '3N', 'P', 'P', 'P'], ['C6', 'C2', 'CJ', 'CA'])
    expect(dummyDiscards(new View(state, 'W', 'tku'), null, false)).toBeNull()
  })
})
