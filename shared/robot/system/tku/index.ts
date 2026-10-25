import type { System } from '../spec.ts'
import { advancingBooks, supportDouble } from './advancing.ts'
import { competition, responsiveBooks } from './competition.ts'
import { overcalls } from './defence.ts'
import { majors, unusual } from './majors.ts'
import { minors, strong } from './minors.ts'
import { notrump } from './notrump.ts'
import { openings } from './openings.ts'
import { responder } from './responder.ts'
import { cite } from './sources.ts'
import { target } from './target.ts'

/**
 * The club's robot (淡江機器人): the club's system from TKU BridgeBook 淡江橋譜, 5542 自然制 where the
 * handbook says nothing (ROBOT.md §2). A first-fit system: the first rule the hand fits decides.
 * Books for one auction come before the fallback (`target`), which takes everything else.
 */
export const TKU: System = {
  id: 'tku',
  firstFit: true,
  // Each group names the 淡江橋館 articles it follows, for keeping in step with them (`sources.ts`)
  books: [
    ...cite(['system-overview', 'system-one-club', 'system-one-diamond', 'system-one-major', 'system-notrump', 'system-strong-and-preempts', 'two-diamond-opening'], [openings]),
    ...cite(['system-notrump', 'notrump-responses', 'two-notrump-opening', 'lebensohl'], notrump),
    ...cite(['system-strong-and-preempts'], strong),
    ...cite(['system-one-major', 'bergen-raises', 'jacoby-2nt', 'single-raise-major'], majors),
    ...cite(['system-one-club', 'system-one-diamond'], minors),
    ...cite(['system-one-club', 'system-one-diamond', 'system-one-major', 'new-minor-forcing'], responder),
    ...cite(['defense-vs-unusual-2nt'], unusual),
    ...cite(['system-doubles'], [supportDouble()]),
    ...cite(['system-doubles', 'system-competition'], competition),
    ...cite(['system-competition', 'system-doubles', 'system-notrump'], overcalls),
    ...cite(['responsive-double'], responsiveBooks),
    ...cite(['system-competition', 'system-doubles', 'system-notrump', 'lebensohl'], advancingBooks),
    ...cite(['system-competition'], [target]),
  ],
}
