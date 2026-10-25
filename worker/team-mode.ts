import { dealSourceOf, type DealSet } from '../shared/deal-set.ts'
import { dealFrom } from '../shared/deal-source.ts'
import { robotId, type RobotKind, type TableMatch } from '../shared/protocol.ts'
import { ROOMS, type Room } from '../shared/team-match.ts'
import { openingLead } from '../shared/traveller.ts'
import type { EventReport, TableModeHooks } from './modes.ts'
import type { TeamMatch } from './team-matches.ts'
import type { Table } from './views.ts'

/**
 * A team match room's table (`mode=team`, ARCHITECTURE.md §5.8, `e8-t07`–`e8-t09`): what it plays
 * and what it needs of its match to run on its own (§5.10). The club gives it when the match
 * starts and tells it when the match ends; the boards' hands stay in `Table.dealSource` (the
 * match's deal set, the same for both rooms), so the browser only ever gets the board being played
 */
export interface TeamTableState {
  matchId: string
  room: Room
  /** The teams' names, as the lobby lists the match (empty ones show as 「A 隊」 in each viewer's language) */
  teamNames: [string, string]
  /** The board on the table: its place in the match, 1-based (0 before the first) */
  seq: number
  /** How many boards the match has; board n of the set is board n of the match */
  boards: number
  /** The places in the match this room finished */
  played: number[]
  /**
   * The members with a seat in the match, by room. A player of the other room may neither watch
   * nor sit here (`matchOtherRoom`): they have not played these boards yet, or soon will
   */
  players: Record<Room, string[]>
  /** The system every robot in the match bids, for a robot that takes a deleted member's seat */
  robotKind: RobotKind
  /** The match ended (finished or abandoned): nothing more is dealt, and the table closes once its people leave */
  closed?: boolean
  /** Boards the host ruled on (`e8-t15`): this room skips them, and puts one away if it is being played */
  ruled?: number[]
  /** The host paused the match (`e8-t16`): since when. Nobody calls or plays, robots wait, nothing is dealt */
  pausedAt?: number
}

export const teamStateOf = (table: Table): TeamTableState | null =>
  table.mode === 'team' ? (table.modeState as TeamTableState) : null

/**
 * Until when a match board is kept back when its record is made: for good, until the club brings it
 * forward once the other room finished the same board, or the match ends (§5.8). Any time far
 * beyond the match does; this is the largest a JavaScript date can be
 */
export const HELD_BACK = 8_640_000_000_000_000

/** The next place in the match this room has not played (nor the host ruled on), or null once there is none */
export function nextTeamSeq(state: TeamTableState): number | null {
  for (let seq = 1; seq <= state.boards; seq++) if (!state.played.includes(seq) && !state.ruled?.includes(seq)) return seq
  return null
}

/** Whether the table's team match is paused (`e8-t16`) */
export const teamPaused = (table: Table): boolean => teamStateOf(table)?.pausedAt !== undefined

/** Whether a room has nothing left to play: the match ended, or it played every board and the last one is over */
export function teamTableOver(table: Table): boolean {
  const state = teamStateOf(table)
  if (!state) return false
  if (state.closed) return true
  return nextTeamSeq(state) === null && (!table.board || table.board.phase === 'finished')
}

/** What everyone at the table sees of the match (`TableView.match`) */
export function tableMatch(table: Table): TableMatch | undefined {
  const state = teamStateOf(table)
  if (!state) return undefined
  return {
    id: state.matchId,
    room: state.room,
    seq: state.seq,
    boards: state.boards,
    played: state.played.length,
    over: teamTableOver(table),
    ...(state.pausedAt !== undefined && { paused: true }),
    ...(state.ruled?.length && { ruled: [...state.ruled] }),
  }
}

/**
 * Both rooms deal the match's boards in order, each at its own pace (`e8-t08`): board n of the set
 * is board n of the match, with its number's dealer and vulnerability, so both rooms play the same
 * board. Each room plays a board once; nothing is dealt after the last one or once the match ended.
 * A finished board's record is kept back (`HELD_BACK`) and reported with the room's result; the
 * club writes it once (`TeamMatchStore.addResult`) and shows the board once both rooms played it
 */
export const teamMode: TableModeHooks = {
  deal: (table, ctx) => {
    const state = teamStateOf(table)!
    if (state.closed) return null
    const seq = nextTeamSeq(state)
    const hands = seq === null ? null : dealFrom(table.dealSource!, seq, ctx.random)
    if (seq === null || !hands) return null
    state.seq = seq
    return { boardNo: seq, hands }
  },
  record: (table, record) => {
    const state = teamStateOf(table)!
    // A board finished after the match ended is not kept back (nothing would bring it forward)
    return { ...record, mode: 'team', eventId: state.matchId, room: state.room, ...(!state.closed && { revealAt: HELD_BACK }) }
  },
  boardFinished: (table, record, ctx): EventReport => {
    const state = teamStateOf(table)!
    const report: EventReport = { kind: 'team', matchId: state.matchId, room: state.room, seq: state.seq, result: null }
    if (state.closed || state.seq < 1 || state.played.includes(state.seq)) return report
    state.played = [...state.played, state.seq].sort((a, b) => a - b)
    const lead = openingLead(record.board)
    report.result = { boardId: record.id, scoreNS: record.board.result?.scoreNS ?? 0, playedAt: ctx.now, ...(lead && { lead }) }
    return report
  },
}

/**
 * A room's table as the match starts (`e8-t07`): its four seats from the match's (robots of the
 * match's system), the match's deal set, the match's time limit, and anyone may watch (the lobby
 * lists the match, not the table). `people` has the name and blocks of each member in it
 */
export function teamTable(input: {
  id: string
  match: TeamMatch
  room: Room
  deals: DealSet
  now: number
  people: Record<string, { username: string; blocked: string[] }>
}): Table {
  const { id, match, room, deals, now, people } = input
  const kind = match.settings.robotKind
  const seats = { N: null, E: null, S: null, W: null } as Table['seats']
  for (const s of match.seats) if (s.room === room) seats[s.seat] = s.robot || s.userId === undefined ? robotId(kind, s.seat) : s.userId
  const players = Object.fromEntries(
    ROOMS.map((r) => [r, match.seats.flatMap((s) => (s.room === r && !s.robot && s.userId !== undefined ? [s.userId] : []))]),
  ) as Record<Room, string[]>
  const state: TeamTableState = {
    matchId: match.id,
    room,
    teamNames: match.settings.teamNames,
    seq: 0,
    boards: deals.boards.length,
    played: [],
    players,
    robotKind: kind,
  }
  const here = players[room]
  return {
    id,
    // Match tables are not numbered in the lobby; the page names them by room
    number: 0,
    hostId: match.hostId,
    seats,
    spectators: [],
    boardsPlayed: 0,
    board: null,
    chat: [],
    createdAt: now,
    mode: 'team',
    modeState: state,
    dealSource: dealSourceOf(deals),
    settings: { access: 'public', allowKibitz: true, boardMinutes: match.settings.boardMinutes },
    names: Object.fromEntries(Object.entries(people).map(([userId, p]) => [userId, p.username])),
    blocks: Object.fromEntries(here.flatMap((userId) => (people[userId] ? [[userId, people[userId].blocked]] : []))),
  }
}
