import { legalCalls } from '../shared/auction.ts'
import { partnerOf, SEATS, type Seat } from '../shared/cards.ts'
import {
  claimApprovers,
  controllerOf,
  dummyOf,
  legalCards,
  remainingCards,
  tricksOf,
  tricksWon,
  turnOf,
  type BoardState,
} from '../shared/game.ts'
import type { BoardSummary, BoardView, ChatMessage, PublicUser, SeatOccupant } from '../shared/protocol.ts'

/** A table as the Worker keeps it */
export interface Table {
  id: string
  number: number
  hostId: string
  seats: Record<Seat, string | null>
  spectators: string[]
  boardsPlayed: number
  board: BoardState | null
  ready: Seat[]
  chat: ChatMessage[]
  undo?: { seat: Seat }
  recordId?: string
  /** Boards finished here, newest first (older tables may not have it) */
  recent?: BoardSummary[]
  createdAt: number
}

export function seatOccupants(
  table: Table,
  user: (id: string) => PublicUser | undefined,
  isOnline: (id: string) => boolean,
): Record<Seat, SeatOccupant | null> {
  const seats = {} as Record<Seat, SeatOccupant | null>
  for (const seat of SEATS) {
    const id = table.seats[seat]
    const found = id ? user(id) : undefined
    seats[seat] = found ? { ...found, online: isOnline(found.id) } : null
  }
  return seats
}

/**
 * What one viewer may see of a board. Players see their own hand, dummy once the opening lead is
 * made (and dummy then sees the declarer's hand, as on BBO), a claimer's hand when asked to accept
 * the claim, and everything once the board is over.
 * Spectators see all four hands, as kibitzers do on BBO. Partners never see each other's alerts
 * until the board is over.
 */
export function boardView(
  board: BoardState,
  viewer: Seat | null,
  extras: { undo?: { seat: Seat }; recordId?: string } = {},
): BoardView {
  const finished = board.phase === 'finished'
  const dummy = dummyOf(board)
  const dummyExposed = dummy !== null && board.play.length > 0
  const declarer = board.contract?.declarer
  const canSee = (seat: Seat) =>
    finished ||
    viewer === null ||
    seat === viewer ||
    (dummyExposed && seat === dummy) ||
    (dummyExposed && viewer === dummy && seat === declarer)

  const hands: BoardView['hands'] = {}
  const handCounts = {} as BoardView['handCounts']
  for (const seat of SEATS) {
    const cards = finished ? board.hands[seat] : remainingCards(board, seat)
    handCounts[seat] = cards.length
    if (canSee(seat)) hands[seat] = cards
  }

  const auction = board.auction.map((entry) => {
    if (entry.alert === undefined || finished || viewer === null || viewer !== partnerOf(entry.seat))
      return entry
    const { alert: _hidden, ...rest } = entry
    return rest
  })

  const turn = turnOf(board)
  const view: BoardView = {
    boardNo: board.boardNo,
    dealer: board.dealer,
    vul: board.vul,
    phase: board.phase,
    hands,
    handCounts,
    auction,
    contract: board.contract,
    dummy,
    turn,
    tricks: tricksOf(board),
    tricksWon: tricksWon(board),
    legalCards:
      viewer && turn && !board.claim && board.phase === 'play' && controllerOf(board, turn) === viewer
        ? legalCards(board, turn)
        : [],
    legalCalls:
      viewer && board.phase === 'auction' && turn === viewer
        ? [...legalCalls(board.auction, board.dealer)]
        : [],
  }

  if (board.claim) {
    const approvers = claimApprovers(board, board.claim.seat)
    view.claim = { ...board.claim, approvers }
    if (viewer === null || approvers.includes(viewer))
      view.claim.hand = remainingCards(board, board.claim.seat)
  }
  if (extras.undo && !finished) view.undo = extras.undo
  if (board.result) view.result = board.result
  if (extras.recordId && finished) view.recordId = extras.recordId
  return view
}
