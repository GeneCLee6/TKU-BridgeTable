import type { Seat } from '../shared/cards.ts'
import type { BoardRecord, TableAction, TableMode, TableSettings } from '../shared/protocol.ts'
import type { EventReport } from './modes.ts'
import type { Table } from './views.ts'

/**
 * How the club and the tables talk (ARCHITECTURE.md §5.10). Every table runs on its own
 * (`TableService`; in production one `TableObject` Durable Object each), and the club only keeps
 * a directory of them (`TableEntry`) for the lobby and for moving people between tables. Both
 * directions are plain async calls with structured-clonable arguments, so they work the same in
 * one process (`LocalTables`, the tests) and as Durable Object RPC.
 */

/** What the club keeps about a table: what the lobby shows and what moving between tables needs */
export interface TableEntry {
  id: string
  /** 0 for a challenge table, which the lobby does not list */
  number: number
  hostId: string
  mode: TableMode
  settings: TableSettings
  invited: string[]
  seats: Record<Seat, string | null>
  spectators: string[]
  /** Robots sitting in for members who dropped offline (代打): seat → the member's id */
  substitutes: Partial<Record<Seat, string>>
  boardsPlayed: number
  boardNo: number | null
  /** A board is on the table and not finished: nobody changes seats */
  playing: boolean
  /** A challenge table: whose and for which challenge */
  challenge?: { challengeId: string; userId: string }
  /**
   * Grows with every report (`max(last + 1, now)`, so it never goes back after the table's object
   * is reloaded); the club drops a report older than the one it has
   */
  rev: number
}

/** A member as a table needs them: their name, and whom they blocked (their chat leaves those out) */
export interface Person {
  id: string
  username: string
  blocked: string[]
}

/** A member a table shows without them being there (invited) */
export interface Named {
  id: string
  username: string
}

/**
 * What the club asks of one table. Each answers with the table's entry as it is now, or null when
 * the table closed (or never was). Errors are `ClubError`/`GameError`; over RPC they travel as
 * `{ error }` and are thrown again on the club's side (`worker/table-object.ts`)
 */
export interface TableApi {
  /** Opens a new table (or one moved in from the club's storage): saved, its jobs scheduled */
  open(table: Table): Promise<TableEntry>
  /** Comes to watch */
  join(person: Person): Promise<TableEntry>
  /** Takes a seat, from the table or from outside it (the club has already taken them from any other table) */
  sit(person: Person, seat: Seat): Promise<TableEntry>
  /** Leaves the table; a challenge table is only paused (parked) */
  leave(userId: string): Promise<TableEntry | null>
  /** The host changes the settings, and the invitation list when given */
  configure(userId: string, settings: Partial<TableSettings>, invited?: Named[]): Promise<TableEntry>
  /** A challenge's participant comes back to their parked table */
  resume(person: Person): Promise<TableEntry>
  /** A member back online takes back the seat a robot kept for them (代打) when `reseat`, else forgets it */
  reclaim(userId: string, reseat: boolean): Promise<TableEntry | null>
  /** A member at the table came online or dropped offline */
  presence(userId: string, online: boolean): Promise<TableEntry | null>
  /** A member at the table blocked or unblocked someone: the chat they see changes */
  blocked(userId: string, blocked: string[]): Promise<void>
  /** An account was deleted: the table forgets them (invitations, the seat kept for them, the name) */
  forget(userId: string): Promise<TableEntry | null>
  /** The table's challenge ended: it closes, unless its participant is still sitting after their last board */
  challengeEnded(): Promise<TableEntry | null>
  /** Closes the table (an admin, or a challenge that ended) */
  close(): Promise<void>
  /** A table action from a member at the table (bidding, play, chat, the host's seat changes) */
  act(userId: string, message: TableAction): Promise<TableEntry | null>
}

/** What a table tells the club */
export interface ClubLink {
  /** Something the lobby shows changed */
  changed(entry: TableEntry): void | Promise<void>
  /** The table closed */
  closed(tableId: string): void | Promise<void>
  /**
   * A board was finished: the club keeps its record (history and index) and writes what it means
   * for the table's event. Saving the same record twice changes nothing
   */
  boardFinished(record: BoardRecord, event: EventReport | null): Promise<void>
}

/** The club's way to reach a table by id */
export interface Tables {
  get(tableId: string): TableApi
}
