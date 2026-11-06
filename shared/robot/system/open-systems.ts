import type { OpenRobotKind } from '../../protocol.ts'
import { GIB } from './gib/index.ts'
import { PRECISION } from './precision/index.ts'
import { SAYC } from './sayc/index.ts'
import type { System } from './spec.ts'

/**
 * The public bidding systems, one line each: TKB bids them (`robots.ts`), their cards are built into
 * public chunks (`scripts/system-cards-plugin.ts`) and checked (`scripts/check-public-assets.ts`).
 * The club's system is not here: this file must stay free of `tku/`, and the check keeps it that way.
 */
export const OPEN_SYSTEMS: Record<OpenRobotKind, System> = { gib: GIB, sayc: SAYC, precision: PRECISION }
