import type { System } from '../spec.ts'
import { openings } from './openings.ts'

/**
 * The 2/1 robot's system, compatible with BBO's GIB (docs/BBO GIB/gib-2over1.md). Books are tried
 * in this order, so the more specific auctions come first.
 */
export const GIB: System = {
  id: 'gib',
  books: [openings],
}
