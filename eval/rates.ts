import type { BoardState } from '../shared/game.ts'
import { ruleBrain, type RobotBrain } from '../shared/robot/brain.ts'
import { paramsOf } from '../shared/robot/levels.ts'
import { actionNumber, errs, mistakenCard } from '../shared/robot/mistakes.ts'
import { chooseCard } from '../shared/robot/play.ts'
import { robotCall } from '../shared/robot/robots.ts'

/**
 * The rule robot with another error rate, for the level calibration (e6-t22, ROBOT.md §7.1):
 * everything as `ruleBrain` in `shared/robot/brain.ts`, but the deliberate mistakes (ROBOT.md §8)
 * use `errorRate` instead of the level's, so a what-if rate can be measured without touching
 * `levels.ts`. Only for evaluation; the shipped levels keep their own rates.
 */
export function brainWithErrorRate(errorRate: number): RobotBrain {
  if (!(errorRate >= 0 && errorRate <= 1)) throw new Error(`an error rate is between 0 and 1, not ${errorRate}`)
  const erring = (state: BoardState, seed: string | undefined) => errs(errorRate, seed, actionNumber(state))
  return {
    bid: (kind, state, seat, level, seed) =>
      robotCall(kind, state.hands[seat], seat, state.auction, state.dealer, state.vul, level, erring(state, seed)),
    play: (kind, state, seat, level, seed) => {
      const card = chooseCard(state, seat, kind, paramsOf(level))
      return (erring(state, seed) && mistakenCard(state, seat, card)) || card
    },
    acceptsClaim: ruleBrain.acceptsClaim,
  }
}
