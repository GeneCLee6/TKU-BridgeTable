import type { RandomInt } from '../shared/board.ts'
import type { Hands } from '../shared/cards.ts'
import { dealFrom, RANDOM_DEALS } from '../shared/deal-source.ts'
import type { BoardState } from '../shared/game.ts'
import type { BoardRecord } from '../shared/protocol.ts'
import type { Table } from './views.ts'

/** What a table is for. Challenges, team matches, practice and pairs events add their own modes */
export type TableMode = 'casual'

/**
 * The three places where a mode changes what a table does; bidding, play, seating and visibility
 * stay the same in every mode. A new mode that needs a fourth hook has to say why in its PR.
 */
export interface TableModeHooks {
  /** The hands for the table's next board, or null when the mode has no more boards to play */
  deal(table: Table, random: RandomInt): Hands | null
  /** A board was just finished, before it is recorded */
  boardFinished(table: Table, board: BoardState): void
  /** The record kept for a finished board */
  record(table: Table, record: BoardRecord): BoardRecord
}

/** A table anyone can open: boards are dealt one after another for as long as people play */
const casual: TableModeHooks = {
  deal: (table, random) => dealFrom(table.dealSource ?? RANDOM_DEALS, table.boardsPlayed + 1, random),
  boardFinished: () => {},
  record: (_table, record) => record,
}

const MODES: Record<TableMode, TableModeHooks> = { casual }

/** Tables saved before modes existed are casual */
export function modeOf(table: Table): TableModeHooks {
  return MODES[table.mode ?? 'casual']
}
