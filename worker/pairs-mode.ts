import type { Card } from '../shared/cards.ts'
import { dealSourceOf, type DealSet } from '../shared/deal-set.ts'
import { dealFrom } from '../shared/deal-source.ts'
import type { RobotKind, RobotSpeed, TablePairs } from '../shared/protocol.ts'
import { openingLead } from '../shared/traveller.ts'
import type { EventReport, TableModeHooks } from './modes.ts'
import { HELD_BACK } from './team-mode.ts'
import type { Table } from './views.ts'

/**
 * A pairs event's table in one round (`mode=pairs`, `e9-t11`, ARCHITECTURE.md §5.22): the round's
 * boards for the two pairs the movement put there, and what the table needs of its event to run on
 * its own (§5.10). The club opens one for every table that plays a round and tells it when the
 * round (or the event) is over; the boards' hands stay in `Table.dealSource` (the event's deal
 * set), so the browser only ever gets the board being played
 */
export interface PairsTableState {
  eventId: string
  round: number
  rounds: number
  /** 1-based, the movement's table */
  table: number
  /** The pairs (indices in the event's list) */
  ns: number
  ew: number
  /** The board numbers of the round here, in order; board n is board n of the deal set */
  boards: number[]
  /** The board on the table (0 before the first) */
  boardNo: number
  played: number[]
  /** Everyone in the event: nobody of it watches a table while the event is on */
  players: string[]
  /** The system of a robot that sits in for someone (代打) */
  robotKind: RobotKind
  /** The round (or the event) ended: nothing more is dealt, and the table closes once its people leave */
  closed?: boolean
}

export const pairsStateOf = (table: Table): PairsTableState | null =>
  table.mode === 'pairs' ? (table.modeState as PairsTableState) : null

/** The next board of the round here, or null when every one was played */
export function nextPairsBoard(state: PairsTableState): number | null {
  return state.boards.find((b) => !state.played.includes(b)) ?? null
}

/** Whether the table has nothing left to play this round */
export function pairsTableOver(table: Table): boolean {
  const state = pairsStateOf(table)
  if (!state) return false
  return !!state.closed || (nextPairsBoard(state) === null && (!table.board || table.board.phase === 'finished'))
}

/** What everyone at the table sees of the event (`TableView.pairs`) */
export function tablePairs(table: Table): TablePairs | undefined {
  const state = pairsStateOf(table)
  if (!state) return undefined
  return {
    id: state.eventId,
    round: state.round,
    rounds: state.rounds,
    table: state.table,
    played: state.played.length,
    boards: state.boards.length,
    over: pairsTableOver(table),
  }
}

/** A finished board's result as the table reports it */
export interface PairsTableResult {
  boardId: string
  scoreNS: number
  playedAt: number
  contract: NonNullable<Table['board']>['contract']
  declarerTricks: number | null
  lead?: Card
}

/**
 * The table deals the round's boards in order, each with its number's dealer and vulnerability
 * (the same board at every table that plays it). Each is played once; nothing is dealt after the
 * last one or once the round ended. A record is kept back (`HELD_BACK`) until the event ends: the
 * other tables have not all played the board yet (§4)
 */
export const pairsMode: TableModeHooks = {
  deal: (table, ctx) => {
    const state = pairsStateOf(table)!
    if (state.closed) return null
    const boardNo = nextPairsBoard(state)
    const hands = boardNo === null ? null : dealFrom(table.dealSource!, boardNo, ctx.random)
    if (boardNo === null || !hands) return null
    state.boardNo = boardNo
    return { boardNo, hands }
  },
  record: (table, record) => {
    const state = pairsStateOf(table)!
    return { ...record, mode: 'pairs', eventId: state.eventId, ...(!state.closed && { revealAt: HELD_BACK }) }
  },
  boardFinished: (table, record, ctx): EventReport => {
    const state = pairsStateOf(table)!
    const report: EventReport = {
      kind: 'pairs',
      eventId: state.eventId,
      round: state.round,
      table: state.table,
      boardNo: state.boardNo,
      ns: state.ns,
      ew: state.ew,
      result: null,
    }
    if (state.closed || state.boardNo < 1 || state.played.includes(state.boardNo)) return report
    state.played = [...state.played, state.boardNo]
    const lead = openingLead(record.board)
    report.result = {
      boardId: record.id,
      scoreNS: record.board.result?.scoreNS ?? 0,
      playedAt: ctx.now,
      contract: record.board.contract,
      declarerTricks: record.board.result?.declarerTricks ?? null,
      ...(lead && { lead }),
    }
    return report
  },
}

/**
 * One table of a round as it opens: the NS pair North and South, the EW pair East and West (each
 * pair's first player North or East), the event's deal set and time limit, nobody watching
 */
export function pairsTable(input: {
  id: string
  eventId: string
  directorId: string
  round: number
  rounds: number
  table: number
  ns: [string, string]
  ew: [string, string]
  nsPair: number
  ewPair: number
  boards: number[]
  deals: DealSet
  boardMinutes: number
  players: string[]
  now: number
  people: Record<string, { username: string; blocked: string[]; robotSpeed?: RobotSpeed }>
}): Table {
  const { people } = input
  const here = [...input.ns, ...input.ew]
  const state: PairsTableState = {
    eventId: input.eventId,
    round: input.round,
    rounds: input.rounds,
    table: input.table,
    ns: input.nsPair,
    ew: input.ewPair,
    boards: input.boards,
    boardNo: 0,
    played: [],
    players: input.players,
    robotKind: 'tku',
  }
  return {
    id: input.id,
    // Not numbered in the lobby (it is not listed there): the pairs page names it by its table
    number: 0,
    hostId: input.directorId,
    seats: { N: input.ns[0], S: input.ns[1], E: input.ew[0], W: input.ew[1] },
    spectators: [],
    boardsPlayed: 0,
    board: null,
    chat: [],
    createdAt: input.now,
    mode: 'pairs',
    modeState: state,
    dealSource: dealSourceOf(input.deals),
    settings: { access: 'public', allowKibitz: false, boardMinutes: input.boardMinutes },
    names: Object.fromEntries(here.flatMap((id) => (people[id] ? [[id, people[id].username]] : []))),
    blocks: Object.fromEntries(here.flatMap((id) => (people[id] ? [[id, people[id].blocked]] : []))),
    speeds: Object.fromEntries(here.flatMap((id) => (people[id]?.robotSpeed ? [[id, people[id].robotSpeed]] : []))),
  }
}
