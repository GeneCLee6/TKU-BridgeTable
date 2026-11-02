/**
 * Pairs movements (`e9-t09`, AC-9.4, ARCHITECTURE.md §5.22): who sits at which table in each round
 * and which boards they play there. Pure functions, no I/O.
 *
 * Only the **Mitchell** movement, for 3 to 10 tables (社團的規模: 5 to 20 pairs). Howell needs a
 * printed table per size (its schedules are not a formula) and is the movement for one or two
 * tables, which a club this size plays as a team match instead; it can be added here later with
 * the same `Movement` shape.
 *
 * - North-South pairs stay at their table (NS pair t at table t); East-West pairs move up one
 *   table each round, the boards move down one. With T tables there are T board sets.
 * - An odd number of tables plays T rounds: every EW pair meets every NS pair and plays every set.
 * - An even number of tables is a **skip Mitchell**: after half the rounds the EW pairs skip one
 *   table, so nobody plays a set twice. It plays T − 1 rounds (every EW pair misses one NS pair and
 *   one set); a full T-th round would bring each EW pair back to its first opponent.
 * - An odd number of pairs leaves the last EW place empty (a phantom pair): the table it would be
 *   at sits out that round (輪空), and its NS pair plays nothing then.
 *
 * Every round each set is at exactly one table, so every board is played the same number of times
 * (one fewer at the boards the phantom would have played: Neuberg evens that out, `pairs.ts`).
 * NS and EW are ranked apart (two fields), as a Mitchell always is.
 */

export const MOVEMENT_TABLES = { min: 3, max: 10 } as const
/** Boards a round may have; the whole event at most `DEAL_SET_MAX` (32) boards */
export const BOARDS_PER_ROUND = { min: 1, max: 4 } as const
export const MOVEMENT_BOARDS_MAX = 32

export type PairDirection = 'NS' | 'EW'

/** A pair's place in the movement: NS 1..T sit still, EW 1..T move */
export interface PairPlace {
  dir: PairDirection
  /** 1-based, the pair's number in its direction (and the table NS sits at) */
  no: number
}

/** One table in one round: the two pairs (their places in the registration list) and the boards */
export interface MovementTable {
  /** 1-based */
  table: number
  /** The NS pair's index in the list of pairs */
  ns: number
  /** The EW pair's index in the list of pairs */
  ew: number
  /** The board set (0-based) at the table */
  set: number
  /** The board numbers played, in order */
  boards: number[]
}

export interface MovementRound {
  /** 1-based */
  round: number
  /** The tables that play; a table where the phantom pair would sit is left out (it sits out) */
  tables: MovementTable[]
  /** Pairs (indices) sitting out this round */
  sitOut: number[]
}

export interface Movement {
  kind: 'mitchell'
  tables: number
  rounds: number
  boardsPerRound: number
  /** All the boards: `tables × boardsPerRound` */
  boards: number
  pairs: number
  /** The odd pair out: the last EW place is empty */
  phantom: boolean
  schedule: MovementRound[]
}

const mod = (a: number, n: number) => ((a % n) + n) % n

/** How many tables `pairs` pairs need (two pairs a table, an odd one sits out each round) */
export const tablesFor = (pairs: number) => Math.ceil(pairs / 2)

/** Fewest and most pairs a movement takes */
export const MOVEMENT_PAIRS = { min: MOVEMENT_TABLES.min * 2 - 1, max: MOVEMENT_TABLES.max * 2 } as const

/** The boards a round has with `tables` tables: as asked, but never more than 32 boards in all */
export const boardsPerRoundFor = (tables: number, wanted: number) =>
  Math.max(BOARDS_PER_ROUND.min, Math.min(wanted, BOARDS_PER_ROUND.max, Math.floor(MOVEMENT_BOARDS_MAX / tables)))

/** Where the pair at `index` of the list plays: the first T pairs sit NS, the others EW */
export function pairPlace(index: number, tables: number): PairPlace {
  return index < tables ? { dir: 'NS', no: index + 1 } : { dir: 'EW', no: index - tables + 1 }
}

/**
 * The Mitchell movement for `pairs` pairs (5 to 20) and `boardsPerRound` boards a round (capped
 * so the event has at most 32 boards); null for a number of pairs it cannot take
 */
export function mitchell(pairs: number, boardsPerRound: number): Movement | null {
  if (!Number.isInteger(pairs) || pairs < MOVEMENT_PAIRS.min || pairs > MOVEMENT_PAIRS.max) return null
  if (!Number.isInteger(boardsPerRound) || boardsPerRound < BOARDS_PER_ROUND.min) return null
  const tables = tablesFor(pairs)
  const perRound = boardsPerRoundFor(tables, boardsPerRound)
  const even = tables % 2 === 0
  const rounds = even ? tables - 1 : tables
  const phantom = pairs % 2 === 1
  const schedule: MovementRound[] = []
  for (let r = 0; r < rounds; r++) {
    const skip = even && r >= tables / 2 ? 1 : 0
    const playing: MovementTable[] = []
    const sitOut: number[] = []
    for (let t = 0; t < tables; t++) {
      const ewPlace = mod(t - r - skip, tables)
      const set = mod(t + r, tables)
      const ns = t
      const ew = tables + ewPlace
      if (ew >= pairs) {
        sitOut.push(ns)
        continue
      }
      const boards = Array.from({ length: perRound }, (_, i) => set * perRound + i + 1)
      playing.push({ table: t + 1, ns, ew, set, boards })
    }
    schedule.push({ round: r + 1, tables: playing, sitOut })
  }
  return { kind: 'mitchell', tables, rounds, boardsPerRound: perRound, boards: tables * perRound, pairs, phantom, schedule }
}

/** Where a pair plays in a round: its table, or null when it sits out */
export function tableOfPair(movement: Movement, round: number, pair: number): MovementTable | null {
  return movement.schedule[round - 1]?.tables.find((t) => t.ns === pair || t.ew === pair) ?? null
}

/** How many times each board is played in the whole event (by board number, 1-based index) */
export function plannedPlays(movement: Movement): number[] {
  const plays = Array.from({ length: movement.boards + 1 }, () => 0)
  for (const round of movement.schedule) for (const table of round.tables) for (const b of table.boards) plays[b]++
  return plays
}
