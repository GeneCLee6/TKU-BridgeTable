import type { System } from '../spec.ts'
import { minors, strong } from './minors.ts'
import { notrump } from './notrump.ts'
import { openings } from './openings.ts'
import { target } from './target.ts'

/**
 * The club's robot (淡江機器人): the club's system from TKU BridgeBook 淡江橋譜, 5542 自然制 where the
 * handbook says nothing (ROBOT.md §2). A first-fit system: the first rule the hand fits decides.
 * Books for one auction come before the fallback (`target`), which takes everything else.
 */
export const TKU: System = {
  id: 'tku',
  firstFit: true,
  books: [openings, ...notrump, ...strong, ...minors, target],
}
