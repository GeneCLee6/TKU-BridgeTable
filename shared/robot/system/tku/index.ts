import type { System } from '../spec.ts'
import { advancingBooks, supportDouble } from './advancing.ts'
import { competition, responsiveBooks } from './competition.ts'
import { overcalls } from './defence.ts'
import { majorSlam } from './majorSlam.ts'
import { majors, unusual } from './majors.ts'
import { minors, strong } from './minors.ts'
import { notrump } from './notrump.ts'
import { openings } from './openings.ts'
import { responder } from './responder.ts'
import { slamAnswers, slamAsks } from './slam.ts'
import { target } from './target.ts'

/**
 * The club's robot (淡江機器人): the club's system from TKU BridgeBook 淡江橋譜, 5542 自然制 where the
 * handbook says nothing (ROBOT.md §2). A first-fit system: the first rule the hand fits decides.
 * Books for one auction come before the fallback (`target`), which takes everything else.
 */
export const TKU: System = {
  id: 'tku',
  firstFit: true,
  books: [
    ...slamAnswers,
    openings,
    ...notrump,
    ...strong,
    ...majorSlam,
    ...majors,
    ...minors,
    ...responder,
    ...unusual,
    supportDouble(),
    ...competition,
    ...overcalls,
    ...responsiveBooks,
    ...advancingBooks,
    slamAsks,
    target,
  ],
}
