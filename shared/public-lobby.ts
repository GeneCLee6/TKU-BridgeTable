import type { Seat } from './cards.ts'
import type { BoardView, TableMode, TableSettings } from './protocol.ts'

/**
 * The cross-club lobby (跨社團大廳, e12-t07, ARCHITECTURE.md §1「跨社團大廳」): clubs that joined it
 * (their `publicLobby` flag) list the tables their hosts opened to other clubs, and members of the
 * other clubs that joined may watch them. Watching only: a guest from another club never takes a
 * seat, never chats and is never told anyone's member id; seating across clubs is for later.
 */

/** Whether a table may be shown to other clubs: a casual, public table that allows kibitzers, opened to them by its host */
export function openToOtherClubs(table: { mode?: TableMode; settings: TableSettings }): boolean {
  const { access, allowKibitz, openToClubs } = table.settings
  return (table.mode ?? 'casual') === 'casual' && access === 'public' && allowKibitz && openToClubs === true
}

/** A seat as another club sees it: a name and whether it is a robot; never the member's id */
export interface GuestSeat {
  username: string
  robot?: true
  online: boolean
}

/** One table in the cross-club lobby (`GET /api/public/lobby`) */
export interface PublicTable {
  clubId: string
  /** The club's name to show (shared/clubs.ts `clubName`) */
  clubName: string
  tableId: string
  number: number
  seats: Record<Seat, GuestSeat | null>
  boardsPlayed: number
  playing: boolean
}

export interface PublicLobby {
  tables: PublicTable[]
}

/**
 * A table as a guest from another club watches it (`GET /api/public/tables/<club>/<id>`, asked again
 * every few seconds): the seats by name, the board as any spectator sees it (all four hands, as on
 * BBO, worker/views.ts `guestTableView`), and nothing else: no chat, no spectators, no recent boards
 */
export interface GuestTable {
  clubId: string
  clubName: string
  tableId: string
  number: number
  seats: Record<Seat, GuestSeat | null>
  board: BoardView | null
  boardsPlayed: number
}

/** How often the guest's page asks for the table again */
export const GUEST_POLL_MS = 3000
