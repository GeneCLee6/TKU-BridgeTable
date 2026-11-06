import { fallback, forcedCall, silent } from '../gib/fallback.ts'
import type { System } from '../spec.ts'
import { competition } from './competition.ts'
import { notrump } from './notrump.ts'
import { openings } from './openings.ts'
import { slamAnswers, slamAsks, slamCheck } from './slam.ts'
import { strong } from './strong.ts'
import { suits } from './suits.ts'

/**
 * Standard American Yellow Card, as the ACBL's booklet writes it (docs/systems/sayc.md). Books are
 * tried in this order, more specific auctions first. What the booklet leaves open goes to the same
 * fallback as 2/1 (finding a fit and a level from what partner has shown), so the calls no book
 * makes are still bid and explained. Nothing here reads the club's system.
 */
export const SAYC: System = {
  id: 'sayc',
  books: [...slamAnswers, openings, ...notrump, ...strong, ...suits, ...competition, ...slamAsks, silent, fallback],
  emergency: forcedCall,
  revise: slamCheck,
}
