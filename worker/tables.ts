import type { Seat } from '../shared/cards.ts'
import { AppError, type MessageCode, type MessageParams } from '../shared/messages.ts'
import type { BoardRecord, TableAction, TableMode, TableSettings } from '../shared/protocol.ts'
import type { Room } from '../shared/team-match.ts'
import { ClubError } from './errors.ts'
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
  /** A team match room's table (§5.8): which match and room, and the teams' names for the lobby's list of matches */
  match?: { matchId: string; room: Room; teamNames: [string, string]; ended?: boolean }
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
  /** Opens a new table: saved, its first board dealt when it is ready, its jobs scheduled */
  open(table: Table): Promise<TableEntry>
  /**
   * Takes over a table kept until now somewhere else (the club's `table:<id>`, schema 3 → 4): kept
   * as it is, nothing dealt. A table that already has its state keeps it (the move is done again
   * after an eviction halfway), and one that closed since answers null
   */
  adopt(table: Table): Promise<TableEntry | null>
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
  /** The table's team match ended: nothing more is dealt, and it closes once nobody is left (a robots-only room at once) */
  matchEnded(): Promise<TableEntry | null>
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

/**
 * A table's answer as it crosses Durable Object RPC (ARCHITECTURE.md §5.10): RPC keeps an error's
 * message but not its class, so `ClubError`/`GameError` travel as their code and are thrown again
 * on the club's side (`RemoteTables`)
 */
export type Wire<T> =
  | { ok: T }
  | { error: { code: MessageCode; params: MessageParams; status: number } }
  /** The object has no table (it closed, or never was): the club drops it from its directory */
  | { gone: true }

/** Runs a table call and wraps its answer, or the `ClubError`/`GameError` it threw, for RPC; any other error is a bug and is thrown */
export async function toWire<T>(run: () => Promise<T>): Promise<Wire<T>> {
  try {
    return { ok: await run() }
  } catch (error) {
    if (error instanceof AppError) return { error: { code: error.code, params: error.params, status: error.status } }
    throw error
  }
}

/** Unwraps a table's answer: its error thrown again as a `ClubError`; `gone` is told first, then `tableGone` thrown */
export function fromWire<T>(wire: Wire<T>, gone?: () => void): T {
  if ('gone' in wire) {
    gone?.()
    throw new ClubError('tableGone', {}, 404)
  }
  if ('error' in wire) throw new ClubError(wire.error.code, wire.error.params, wire.error.status)
  return wire.ok
}

/**
 * What one `TableObject` answers over RPC (`worker/table-object.ts`): `TableApi` with wrapped
 * answers, and two calls for moving the table back into the club (the switch `TABLE_OBJECTS=off`,
 * DEPLOY.md)
 */
export type TableRpc = {
  [K in keyof TableApi]: (...args: Parameters<TableApi[K]>) => Promise<Wire<Awaited<ReturnType<TableApi[K]>>>>
} & {
  /** The table as it is now, or null when there is none; from now on the object keeps still (saves and sends nothing) until `release` */
  handOver(): Promise<Wire<Table | null>>
  /** Forgets the table for good, once the club took it back (`handOver`) */
  release(): Promise<Wire<null>>
}

/** One table in its own Durable Object, as the club sees it: `TableApi` over RPC */
class RemoteTable implements TableApi {
  private readonly rpc: TableRpc
  private readonly gone: () => void

  constructor(rpc: TableRpc, gone: () => void) {
    this.rpc = rpc
    this.gone = gone
  }

  private async call<T>(answer: Promise<Wire<T>>): Promise<T> {
    return fromWire(await answer, this.gone)
  }

  open(table: Table) {
    return this.call(this.rpc.open(table))
  }
  adopt(table: Table) {
    return this.call(this.rpc.adopt(table))
  }
  join(person: Person) {
    return this.call(this.rpc.join(person))
  }
  sit(person: Person, seat: Seat) {
    return this.call(this.rpc.sit(person, seat))
  }
  leave(userId: string) {
    return this.call(this.rpc.leave(userId))
  }
  configure(userId: string, settings: Partial<TableSettings>, invited?: Named[]) {
    return this.call(this.rpc.configure(userId, settings, invited))
  }
  resume(person: Person) {
    return this.call(this.rpc.resume(person))
  }
  reclaim(userId: string, reseat: boolean) {
    return this.call(this.rpc.reclaim(userId, reseat))
  }
  presence(userId: string, online: boolean) {
    return this.call(this.rpc.presence(userId, online))
  }
  blocked(userId: string, blocked: string[]) {
    return this.call(this.rpc.blocked(userId, blocked))
  }
  forget(userId: string) {
    return this.call(this.rpc.forget(userId))
  }
  challengeEnded() {
    return this.call(this.rpc.challengeEnded())
  }
  matchEnded() {
    return this.call(this.rpc.matchEnded())
  }
  close() {
    return this.call(this.rpc.close())
  }
  act(userId: string, message: TableAction) {
    return this.call(this.rpc.act(userId, message))
  }
}

/**
 * The tables in production: each its own `TableObject` (`idFromName(<table id>)`), reached over
 * RPC. `stub` gives the object's stub; the tests give an in-process `TableHost` behind a structured
 * clone instead, so the whole path (wrapping, errors, copies) runs in Node
 */
export class RemoteTables implements Tables {
  private readonly stub: (tableId: string) => TableRpc
  /** Told when an object answers that it has no table, so the club drops it from its directory */
  onGone: (tableId: string) => void = () => {}

  constructor(stub: (tableId: string) => TableRpc) {
    this.stub = stub
  }

  get(tableId: string): TableApi {
    return new RemoteTable(this.stub(tableId), () => this.onGone(tableId))
  }

  /** Takes a table back out of its object (`TableRpc.handOver`), for the switch back into the club */
  async handOver(tableId: string): Promise<Table | null> {
    return fromWire(await this.stub(tableId).handOver())
  }

  async release(tableId: string): Promise<void> {
    fromWire(await this.stub(tableId).release())
  }
}
