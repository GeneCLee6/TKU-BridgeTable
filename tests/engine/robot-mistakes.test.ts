import { describe, expect, it } from 'vitest'
import { isBid } from '../../shared/auction.ts'
import { deal } from '../../shared/board.ts'
import { suitOf, type Hands } from '../../shared/cards.ts'
import { legalCards, makeCall, newBoard, playCard, turnOf, type BoardState } from '../../shared/game.ts'
import type { RobotKind, RobotLevel } from '../../shared/protocol.ts'
import { ruleBrain } from '../../shared/robot/brain.ts'
import { LEVEL_PARAMS } from '../../shared/robot/levels.ts'
import { actionNumber, errs, mistakeRoll } from '../../shared/robot/mistakes.ts'

/** Deliberate, reproducible mistakes (e6-t21, ROBOT.md §8) */

function seeded(seed: number) {
  return (n: number) => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
    return seed % n
  }
}

interface Played {
  state: BoardState
  /** Actions where the robot's answer differs from what it does without mistakes */
  mistakes: number
  /** Decisions with more than one legal choice */
  choices: number
}

/** Four robots at `level` play a board; `makeCall` and `playCard` throw on anything illegal */
async function playBoard(boardNo: number, cards: Hands, kind: RobotKind, level: RobotLevel, seed?: string): Promise<Played> {
  let state = newBoard(boardNo, cards)
  let mistakes = 0
  let choices = 0
  while (state.phase === 'auction') {
    const seat = turnOf(state)!
    const bid = await ruleBrain.bid(kind, state, seat, level, seed)
    const best = await ruleBrain.bid(kind, state, seat, level)
    if (bid.call !== best.call) {
      mistakes++
      // A mistaken call is another bid, never a pass or double in place of a bid
      expect(isBid(bid.call) && isBid(best.call)).toBe(true)
    }
    choices++
    state = makeCall(state, seat, bid.call, bid.alert)
  }
  while (state.phase === 'play') {
    const seat = turnOf(state)!
    const card = await ruleBrain.play(kind, state, seat, level, seed)
    expect(legalCards(state, seat)).toContain(card)
    if (legalCards(state, seat).length > 1) choices++
    const best = await ruleBrain.play(kind, state, seat, level)
    if (card !== best) {
      mistakes++
      // A mistake never ruffs when the robot meant to play another suit
      const trump = state.contract!.strain
      if (suitOf(best) !== trump) expect(suitOf(card)).not.toBe(trump)
    }
    state = playCard(state, seat, card)
  }
  return { state, mistakes, choices }
}

const KINDS: RobotKind[] = ['tku', 'gib']

describe('the mistake roll', () => {
  it('depends only on the seed key and the action number', () => {
    expect(mistakeRoll('t1:3', 7)).toBe(mistakeRoll('t1:3', 7))
    const rolls = new Set(Array.from({ length: 50 }, (_, i) => mistakeRoll('t1:3', i)))
    expect(rolls.size).toBe(50)
    expect(mistakeRoll('t1:3', 7)).not.toBe(mistakeRoll('t1:4', 7))
    for (const roll of rolls) expect(roll >= 0 && roll < 1).toBe(true)
  })

  it('errs at the given rate, and never at 0 or without a seed key', () => {
    let count = 0
    for (let board = 0; board < 200; board++) for (let action = 0; action < 50; action++) if (errs(0.15, `t:${board}`, action)) count++
    expect(count / 10_000).toBeGreaterThan(0.13)
    expect(count / 10_000).toBeLessThan(0.17)
    for (let action = 0; action < 1000; action++) expect(errs(0, 'x', action) || errs(1, undefined, action)).toBe(false)
  })

  it('numbers the actions by the calls and cards made so far', () => {
    const state = newBoard(1, deal(seeded(1)))
    expect(actionNumber(state)).toBe(0)
    expect(actionNumber(makeCall(state, 'N', 'P'))).toBe(1)
  })
})

describe('mistakes by level (e6-t21)', () => {
  it('only 初學者 errs on purpose for now; 大專 stays the robot it was', () => {
    expect(LEVEL_PARAMS.beginner.errorRate).toBeGreaterThan(0)
    expect(LEVEL_PARAMS.college.errorRate).toBe(0)
    expect(LEVEL_PARAMS.open.errorRate).toBe(0)
    expect(LEVEL_PARAMS.master.errorRate).toBe(0)
  })

  it.each(KINDS)('%s: 大專 never errs, with or without a seed key', async (kind) => {
    for (let n = 1; n <= 30; n++) {
      const { mistakes } = await playBoard(n, deal(seeded(n)), kind, 'college', `table:${n}`)
      expect(mistakes).toBe(0)
    }
  })

  it.each(KINDS)('%s: 初學者 makes legal mistakes, about as often as its rate allows', async (kind) => {
    let mistakes = 0
    let choices = 0
    for (let n = 1; n <= 60; n++) {
      const played = await playBoard(n, deal(seeded(n)), kind, 'beginner', `table:${n}`)
      expect(played.state.phase).toBe('finished')
      mistakes += played.mistakes
      choices += played.choices
    }
    // Some rolls find no second choice (one legal card, no other rule that fits), so the mistakes
    // seen are fewer than the rate, never more
    expect(mistakes).toBeGreaterThan(0)
    expect(mistakes / choices).toBeLessThan(LEVEL_PARAMS.beginner.errorRate + 0.03)
    expect(mistakes / choices).toBeGreaterThan(LEVEL_PARAMS.beginner.errorRate / 4)
  })

  it.each(KINDS)('%s: the same seed key gives the same mistakes; another key can differ', async (kind) => {
    let differ = 0
    for (let n = 1; n <= 20; n++) {
      const cards = deal(seeded(n))
      const once = await playBoard(n, cards, kind, 'beginner', `challenge-1:${n}`)
      const again = await playBoard(n, cards, kind, 'beginner', `challenge-1:${n}`)
      expect(again.state).toEqual(once.state)
      const other = await playBoard(n, cards, kind, 'beginner', `challenge-2:${n}`)
      if (JSON.stringify(other.state) !== JSON.stringify(once.state)) differ++
    }
    expect(differ).toBeGreaterThan(0)
  })
})
