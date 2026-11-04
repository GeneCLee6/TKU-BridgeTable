import { SEATS, type Hands, type Seat } from '../../shared/cards.ts'
import type { BoardRecord, PublicUser } from '../../shared/protocol.ts'
import type { VugraphRoom } from '../../shared/team-match.ts'

/** How often the Vugraph page asks for both rooms again while the match is played */
export const VUGRAPH_POLL_MS = 3000

/**
 * A room of the Vugraph page (or a table a guest from another club watches, e12-t07) drawn as a hand record (`RecordDiagram`), with every card shown so far
 * played: each hand is what it holds now plus what it played, so the diagram shows the board as the
 * server sent it (one trick behind when the match says so, `e8-t19`) and nothing more
 */
export function vugraphRecord(
  room: Pick<VugraphRoom, 'tableId' | 'board'> & { seats: Record<Seat, { id?: string; username: string } | null> },
): BoardRecord | null {
  const view = room.board
  if (!view) return null
  const play = view.tricks.flatMap((trick) => trick.cards)
  const hands = {} as Hands
  for (const seat of SEATS) {
    const played = play.filter((p) => p.seat === seat).map((p) => p.card)
    hands[seat] = [...new Set([...(view.hands[seat] ?? []), ...played])]
  }
  const players = {} as Record<Seat, PublicUser>
  // A guest from another club gets names only (the cross-club lobby, e12-t07)
  for (const seat of SEATS) {
    const occupant = room.seats[seat]
    players[seat] = occupant ? { id: occupant.id ?? '', username: occupant.username } : { id: '', username: '—' }
  }
  return {
    id: room.tableId,
    tableNumber: 0,
    finishedAt: 0,
    players,
    board: {
      boardNo: view.boardNo,
      dealer: view.dealer,
      vul: view.vul,
      hands,
      auction: view.auction,
      contract: view.contract,
      play,
      phase: view.phase,
      ...(view.result && { result: view.result }),
    },
  }
}
