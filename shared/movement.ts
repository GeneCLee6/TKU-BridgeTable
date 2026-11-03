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
 *
 * And the **individual** movement (個人賽, `e9-t15`, `individual` below): every player changes
 * partner every round, for 8, 12, 16 or 20 players, on a whist tournament's schedule.
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
  /** The NS pair's index in the list of pairs (an individual movement: North's index among the players) */
  ns: number
  /** The EW pair's index in the list of pairs (an individual movement: East's index among the players) */
  ew: number
  /**
   * An individual movement (`e9-t15`): the four players at the table, North, South, East, West
   * (indices in the list of players); North–South and East–West are this round's partnerships
   */
  seats?: [number, number, number, number]
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
  /** A pairs Mitchell, or an individual movement (`e9-t15`, `individual`) */
  kind: 'mitchell' | 'individual'
  tables: number
  rounds: number
  boardsPerRound: number
  /** All the boards: `tables × boardsPerRound` */
  boards: number
  /** Pairs entered (an individual movement: players) */
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
  return movement.schedule[round - 1]?.tables.find((t) => entrantsAt(t).includes(pair)) ?? null
}

/** How many times each board is played in the whole event (by board number, 1-based index) */
export function plannedPlays(movement: Movement): number[] {
  const plays = Array.from({ length: movement.boards + 1 }, () => 0)
  for (const round of movement.schedule) for (const table of round.tables) for (const b of table.boards) plays[b]++
  return plays
}

// ── Individual movements (個人賽, `e9-t15`, AC-9.6) ─────────────────────────────────────────────

/**
 * Players an individual event takes: 2 to 5 full tables, nobody sitting out (the pairs engine
 * seats no robots). Each size has a complete schedule below
 */
export const INDIVIDUAL_SIZES = [8, 12, 16, 20] as const
export const INDIVIDUAL_PLAYERS = { min: INDIVIDUAL_SIZES[0], max: INDIVIDUAL_SIZES[INDIVIDUAL_SIZES.length - 1] } as const

/**
 * The first round of a **Z-cyclic whist tournament** Wh(n) for n = 8, 12, 16, 20 players: the
 * players are the numbers 0 … m − 1 (m = n − 1) and ∞ (= m). Each table `[a, b, c, d]` is a and c
 * (North–South) against b and d (East–West). Round r adds r to every number (mod m, ∞ stays), and
 * there are m rounds. For these first rounds the partners' differences (±(a − c), ±(b − d)) cover
 * every non-zero number mod m exactly once and the opponents' (±(a − b), ±(a − d), ±(c − b),
 * ±(c − d)) exactly twice, so over the m rounds **every player partners every other player exactly
 * once and plays against every other player exactly twice** — the most even schedule there is.
 * Found by a computer search and checked in `tests/engine/individual-movement.test.ts`.
 */
export const WHIST_FIRST_ROUNDS: Record<(typeof INDIVIDUAL_SIZES)[number], [number, number, number, number][]> = {
  8: [[0, 1, 2, 4], [3, 5, 7, 6]],
  12: [[0, 1, 3, 8], [2, 4, 7, 6], [5, 9, 11, 10]],
  16: [[0, 1, 2, 6], [3, 10, 7, 13], [4, 8, 11, 9], [5, 12, 14, 15]],
  20: [[0, 1, 2, 5], [3, 10, 12, 19], [4, 11, 15, 17], [6, 9, 18, 14], [7, 13, 8, 16]],
}

export const isIndividualSize = (players: number): players is (typeof INDIVIDUAL_SIZES)[number] =>
  (INDIVIDUAL_SIZES as readonly number[]).includes(players)

/** The most players of `count` an individual movement seats: the largest size not above it (0: too few) */
export const individualSizeFor = (count: number): number =>
  [...INDIVIDUAL_SIZES].reverse().find((n) => n <= count) ?? 0

/** Most rounds an individual event may be cut to (`rounds` below): the largest size's n − 1 */
export const INDIVIDUAL_ROUNDS_MAX = INDIVIDUAL_PLAYERS.max - 1

/** The rounds an individual event of `players` plays when its director asked for `wanted` (absent: all n − 1) */
export const individualRoundsFor = (players: number, wanted?: number) =>
  wanted === undefined ? players - 1 : Math.max(1, Math.min(wanted, players - 1))

/**
 * The individual movement for `players` players (8, 12, 16 or 20) and `boardsPerRound` boards a
 * round (capped so the event has at most 32 boards): n − 1 rounds of n / 4 tables, every player
 * at a table every round (`WHIST_FIRST_ROUNDS`). Online there are no boards to carry, so every
 * table of a round plays the same boards and each board is played at every table (compared n / 4
 * times). The entry order is the players' numbers: the last one entered is ∞ (stays at one seat);
 * null for a size it cannot take.
 *
 * `rounds` cuts it to the first rounds of the schedule (1 … n − 1; more is read as n − 1): every
 * player still plays every round and partners nobody twice, but not everyone partners everyone
 * (ARCHITECTURE.md §5.25). The 32-board cap counts the rounds played
 */
export function individual(players: number, boardsPerRound: number, rounds?: number): Movement | null {
  if (!isIndividualSize(players)) return null
  if (!Number.isInteger(boardsPerRound) || boardsPerRound < BOARDS_PER_ROUND.min) return null
  if (rounds !== undefined && (!Number.isInteger(rounds) || rounds < 1)) return null
  const m = players - 1
  const played = individualRoundsFor(players, rounds)
  const tables = players / 4
  const perRound = Math.max(BOARDS_PER_ROUND.min, Math.min(boardsPerRound, BOARDS_PER_ROUND.max, Math.floor(MOVEMENT_BOARDS_MAX / played)))
  const first = WHIST_FIRST_ROUNDS[players]
  const schedule: MovementRound[] = []
  for (let r = 0; r < played; r++) {
    const at = (x: number) => (x === m ? m : mod(x + r, m))
    const boards = Array.from({ length: perRound }, (_, i) => r * perRound + i + 1)
    schedule.push({
      round: r + 1,
      tables: first.map(([a, b, c, d], t) => {
        const seats: [number, number, number, number] = [at(a), at(c), at(b), at(d)]
        return { table: t + 1, ns: seats[0], ew: seats[2], set: r, boards: [...boards], seats }
      }),
      sitOut: [],
    })
  }
  return { kind: 'individual', tables, rounds: played, boardsPerRound: perRound, boards: played * perRound, pairs: players, phantom: false, schedule }
}

/** The entrants (pairs, or an individual movement's players) at a table: NS then EW */
export const entrantsAt = (table: MovementTable): number[] => table.seats ?? [table.ns, table.ew]

/** The two sides of a table, as entrants: a pair each, or two players each in an individual movement */
export function sidesAt(table: MovementTable): { ns: number[]; ew: number[] } {
  return table.seats ? { ns: [table.seats[0], table.seats[1]], ew: [table.seats[2], table.seats[3]] } : { ns: [table.ns], ew: [table.ew] }
}

/** The table of a round in the movement */
export const movementTable = (movement: Movement, round: number, table: number): MovementTable | undefined =>
  movement.schedule[round - 1]?.tables.find((t) => t.table === table)
