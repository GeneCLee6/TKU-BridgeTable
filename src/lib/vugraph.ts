import { SEATS, type Hands, type Seat } from '../../shared/cards.ts'
import type { BoardRecord, PublicUser } from '../../shared/protocol.ts'
import type { VugraphRoom } from '../../shared/team-match.ts'

/** How often the Vugraph page asks for both rooms again while the match is played */
export const VUGRAPH_POLL_MS = 3000

/**
 * A room of the Vugraph page drawn as a hand record (`RecordDiagram`), with every card shown so far
 * played: each hand is what it holds now plus what it played, so the diagram shows the board as the
 * server sent it (one trick behind when the match says so, `e8-t19`) and nothing more
 */
export function vugraphRecord(room: VugraphRoom): BoardRecord | null {
  const view = room.board
  if (!view) return null
  const play = view.tricks.flatMap((trick) => trick.cards)
  const hands = {} as Hands
  for (const seat of SEATS) {
    const played = play.filter((p) => p.seat === seat).map((p) => p.card)
    hands[seat] = [...new Set([...(view.hands[seat] ?? []), ...played])]
  }
  const players = {} as Record<Seat, PublicUser>
  for (const seat of SEATS) players[seat] = room.seats[seat] ?? { id: '', username: '—' }
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
