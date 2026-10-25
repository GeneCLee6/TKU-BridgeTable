import { SEATS, type Seat } from './cards.ts'

/** How the lobby lists tables and where 快速入座 sits (AC-2.11) */

/** The part of a table these rules look at */
export interface LobbyTable {
  number: number
  seats: Record<Seat, unknown>
}

/** Empty seats; a robot's seat is taken (a person may still take it from the table) */
export const missingSeats = (table: LobbyTable) => SEATS.filter((seat) => !table.seats[seat]).length

/**
 * The lobby's order: tables short of players first, the ones closest to starting (fewest seats
 * missing) on top, then full tables; by table number within each
 */
export function lobbyOrder(a: LobbyTable, b: LobbyTable): number {
  const ma = missingSeats(a)
  const mb = missingSeats(b)
  if (!ma !== !mb) return ma ? -1 : 1
  return ma - mb || a.number - b.number
}

/**
 * Where 快速入座 sits: the first table in the lobby's order that is short of players, among the
 * ones the member may sit at, and its first empty seat (South, then North, East, West); null when
 * no table needs anyone
 */
export function quickSeatChoice<T extends LobbyTable>(tables: T[]): { table: T; seat: Seat } | null {
  const table = [...tables].sort(lobbyOrder).find((t) => missingSeats(t) > 0)
  if (!table) return null
  const seat = (['S', 'N', 'E', 'W'] as const).find((s) => !table.seats[s])!
  return { table, seat }
}
