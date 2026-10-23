import type { System } from '../spec.ts'
import { contested } from './contested.ts'
import { defence } from './defence.ts'
import { fallback, forcedCall, silent } from './fallback.ts'
import { majors } from './majors.ts'
import { minors } from './minors.ts'
import { notrump } from './notrump.ts'
import { openings } from './openings.ts'
import { strong } from './strong.ts'

/**
 * The 2/1 robot's system, compatible with BBO's GIB (docs/BBO GIB/gib-2over1.md). Books are tried
 * in this order, so the more specific auctions come first and the fallback (§11) comes last.
 */
export const GIB: System = {
  id: 'gib',
  books: [openings, ...notrump, ...strong, ...minors, ...majors, ...contested, ...defence, silent, fallback],
  emergency: forcedCall,
}
