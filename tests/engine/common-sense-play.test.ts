import { describe, expect, it } from 'vitest'
import { turnOf, type BoardState } from '../../shared/game.ts'
import type { RobotKind } from '../../shared/protocol.ts'
import { chooseCard, readDiscard } from '../../shared/robot/play.ts'
import { loadPlayBank, playState } from '../../eval/play-quiz.ts'

/**
 * Common-sense card play without double dummy at decision time (e6-t28, ROBOT.md §3.20): the
 * positions the study (`npm run sim -- common-sense`) found, kept in the question bank.
 */

const questions = loadPlayBank().flatMap((file) => file.questions)

function at(id: string): BoardState {
  const question = questions.find((q) => q.id === id)
  if (!question) throw new Error(`no question ${id}`)
  return playState(question)
}

const KINDS: RobotKind[] = ['tku', 'gib', 'sayc']
const plays = (state: BoardState) => KINDS.map((kind) => chooseCard(state, turnOf(state)!, kind))

describe('a signal does not cost a trick', () => {
  it('keeps a ten that will win rather than show count from T6', () => {
    expect(plays(at('play-second-013'))).toEqual(['S6', 'S6', 'S6'])
  })

  it('keeps the ten behind declarer’s jack as fourth hand', () => {
    expect(plays(at('play-fourth-003'))).toEqual(['C2', 'C2', 'C2'])
  })

  it('keeps the ten when discouraging partner’s ace', () => {
    expect(plays(at('play-fourth-004'))).toEqual(['S7', 'S7', 'S7'])
  })

  it('keeps a card back only from the eight up', () => {
    // H85 under declarer's jack, the eight likely to win: the five
    expect(plays(at('play-second-015'))).toEqual(['H5', 'H5', 'H5'])
    // H74 under the jack, the seven likely to win: the seven, the count still shown
    expect(plays(at('play-second-016'))).toEqual(['H7', 'H7', 'H7'])
  })

  it('shows count from T853 with the eight, the next card that still reads as high', () => {
    expect(plays(at('play-second-014'))).toEqual(['D8', 'D8', 'D8'])
  })
})

describe('the suit partner asked for', () => {
  it('is led from the top of touching honours', () => {
    expect(plays(at('play-lead-common-001'))).toEqual(['DA', 'DA', 'DA'])
    expect(plays(at('play-lead-common-002'))).toEqual(['DK', 'DK', 'DK'])
    expect(plays(at('play-lead-common-003'))).toEqual(['HA', 'HA', 'HA'])
  })
})

describe('the first discard', () => {
  it('reads as the suit wanted when a card of a suit that costs the same does', () => {
    expect(plays(at('play-discard-common-001'))).toEqual(['C3', 'C3', 'C3'])
  })

  it('reads the way the club reads it', () => {
    // Against spades, a heart led: an odd card asks for its own suit, an even card points on
    expect(readDiscard('D5', 'S', 'H')).toBe('D')
    expect(readDiscard('D8', 'S', 'H')).toBe('H')
    expect(readDiscard('D2', 'S', 'H')).toBe('C')
    // Notrump, a heart led: high for the higher of the other two, low for the lower
    expect(readDiscard('S9', null, 'H')).toBe('D')
    expect(readDiscard('S4', null, 'H')).toBe('C')
    expect(readDiscard('C3', null, 'H')).toBe('D')
  })
})

describe('third hand', () => {
  it('overtakes partner’s jack from a doubleton KQ with the queen', () => {
    expect(plays(at('play-third-common-001'))).toEqual(['CQ', 'CQ', 'CQ'])
  })
})
