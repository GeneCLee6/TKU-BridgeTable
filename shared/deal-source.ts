import { deal, type RandomInt } from './board.ts'
import type { Hands } from './cards.ts'

/**
 * Where a table's boards come from. It is plain data so it can be stored with the table; the hands
 * of a fixed set stay on the server and only reach a `BoardState` when that board is dealt.
 */
export type DealSource =
  /** A fresh shuffle every board (casual tables) */
  | { kind: 'random' }
  /** Board n gets `deals[n - 1]`; there are no boards after the last one (challenges, matches) */
  | { kind: 'fixed'; deals: Hands[] }

export const RANDOM_DEALS: DealSource = { kind: 'random' }

/** The hands for board `boardNo` (1-based), or null when the source has no more boards */
export function dealFrom(source: DealSource, boardNo: number, random: RandomInt): Hands | null {
  switch (source.kind) {
    case 'random':
      return deal(random)
    case 'fixed': {
      const hands = source.deals[boardNo - 1]
      return hands ? structuredClone(hands) : null
    }
  }
}
