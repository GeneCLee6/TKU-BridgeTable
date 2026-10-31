import { describe, expect, it } from 'vitest'
import { turnOf } from '../../shared/game.ts'
import { chooseCard } from '../../shared/robot/play.ts'
import { dummyThreat, noHurry, ruffsInDummy } from '../../shared/robot/defence-plan.ts'
import { suitCards } from '../../shared/robot/hand.ts'
import { View } from '../../shared/robot/view.ts'
import { playState, type PlayQuestion } from '../../eval/play-quiz.ts'

/**
 * Y3 (ROBOT.md §3.14): the defenders read the declarer's plan from dummy and the auction. Each
 * position is also in the play question bank (tests/play-quiz/*.plan.json).
 */

const position = (hands: PlayQuestion['hands'], auction: string[], play: string[]) =>
  playState({ id: 't', system: 'both', board: 3, hands, auction, play, answer: play[0], source: 't', reviewer: null, status: 'pending' })

const both = (state: ReturnType<typeof position>) => (['tku', 'gib'] as const).map((kind) => chooseCard(state, turnOf(state)!, kind))

const SPADES_RAISED = ['1S', 'P', '2S', 'P', '4S', 'P', 'P', 'P']
const DIAMONDS_RUN = ['1S', 'P', '2D', 'P', '2S', 'P', '4S', 'P', 'P', 'P']

describe("the defenders' model of the declarer's plan", () => {
  it("finds dummy's long suit that runs, and only once it runs", () => {
    const hands = { N: '76.432.KQJT9.K32', E: 'T98.K87.876.8765', S: 'AKQJ5.J65.32.AQ4', W: '432.AQT9.A54.JT9' }
    // Before the ace of diamonds is played the suit is not running yet
    const before = position(hands, DIAMONDS_RUN, ['C9'])
    expect(dummyThreat(new View(before, 'E', 'tku'), 'S')).toBeNull()
    const after = position(hands, DIAMONDS_RUN, ['DA', 'D9', 'D6', 'D2'])
    expect(dummyThreat(new View(after, 'W', 'tku'), 'S')).toBe('D')
  })

  it('sees no hurry to cash a winner when dummy has no long suit and holds two of the suit', () => {
    const state = position({ N: 'K54.Q87.Q65.K432', E: '73.T964.AT832.AQ', S: 'AQJT9.K32.K4.J65', W: '862.AJ5.J97.T987' }, SPADES_RAISED, ['D7', 'D5', 'DA', 'D4'])
    const view = new View(state, 'E', 'tku')
    expect(noHurry(view, 'C', 'S')).toBe(true)
    expect(both(state)).toEqual(['DT', 'DT'])
  })

  it('cashes at once when dummy has a running suit to discard on', () => {
    const state = position({ N: '76.432.KQJT9.K32', E: 'T98.K87.876.8765', S: 'AKQJ5.J65.32.AQ4', W: '432.AQT9.A54.JT9' }, DIAMONDS_RUN, ['DA', 'D9', 'D6', 'D2'])
    expect(noHurry(new View(state, 'W', 'tku'), 'H', 'S')).toBe(false)
    expect(both(state)).toEqual(['HA', 'HA'])
  })

  it('attacks the suit dummy is weak in when dummy will run its suit', () => {
    const state = position({ N: '75.Q64.AKQJ9.643', E: 'A94.JT8.T863.872', S: 'KQJT86.AK5.52.QJ', W: '32.9732.74.AKT95' }, DIAMONDS_RUN, ['S3', 'S5', 'SA', 'S6'])
    expect(both(state)).toEqual(['C8', 'C8'])
  })

  it('leads a trump when the declarer showed a second suit dummy is short in', () => {
    const hands = { N: 'KJ842.Q63.7.J953', E: 'T963.T8.T842.AQ7', S: '5.AKJ74.KQJ53.82', W: 'AQ7.952.A96.KT64' }
    const state = position(hands, ['1H', 'P', '1S', 'P', '2D', 'P', '2H', 'P', 'P', 'P'], ['DA', 'D7', 'D4', 'D3'])
    const view = new View(state, 'W', 'tku')
    expect(ruffsInDummy(view, view.ownCards(), 'H')).toBe(true)
    for (const card of both(state)) expect(suitCards([card], 'H')).toEqual([card])
  })

  it('holds up the ace as second hand when the declarer leads towards dummy’s suit with no entry', () => {
    const state = position(
      { N: '8642.543.QJT98.2', E: 'T93.AT76.652.T96', S: 'AQ5.KQ2.K3.AKJ87', W: 'KJ7.J98.A74.Q543' },
      ['2N', 'P', '3N', 'P', 'P', 'P'],
      ['C3', 'C2', 'CT', 'CJ', 'DK'],
    )
    expect(both(state)).toEqual(['D4', 'D4'])
  })

  it('takes the ace at trick one of a suit contract when the declarer may hold a singleton', () => {
    const state = position({ N: 'AJ5.KJT.854.Q873', E: 'T6.62.AK72.AJT94', S: 'KQ7.AQ8753.Q63.K', W: '98432.94.JT9.652' }, ['1H', 'P', '4H', 'P', 'P', 'P'], ['C5', 'C3'])
    expect(both(state)).toEqual(['CA', 'CA'])
  })

  it("keeps the length that guards the declarer's long suit when discarding", () => {
    const state = position(
      { N: 'AQ4.84.K72.AK853', E: 'J865..J9654.T972', S: 'K72.AKQJ5.Q83.64', W: 'T93.T97632.AT.QJ' },
      ['P', 'P', '1C', 'P', '1H', 'P', '2C', 'P', '3C', 'P', '3N', 'P', 'P', 'P'],
      ['D5', 'D3', 'DA', 'D2', 'DT', 'DK', 'D4', 'D8', 'H4'],
    )
    for (const card of both(state)) expect(card[0]).not.toBe('C')
  })
})
