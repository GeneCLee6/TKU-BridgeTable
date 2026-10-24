import { legalCalls } from '../shared/auction.ts'
import { partnerOf, SEATS, type Seat } from '../shared/cards.ts'
import {
  canUndoFor,
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
import type { BoardSummary, BoardView, ChatMessage, PublicUser, SeatOccupant, TableSettings } from '../shared/protocol.ts'
import type { DealSource } from '../shared/deal-source.ts'
import type { TableMode } from './modes.ts'

/** A table as the Worker keeps it */
export interface Table {
  id: string
  number: number
  hostId: string
  seats: Record<Seat, string | null>
  spectators: string[]
  boardsPlayed: number
  board: BoardState | null
  chat: ChatMessage[]
  undo?: { seat: Seat }
  /** The last claim, when it was turned down; cleared by the next action */
  rejectedClaim?: { seat: Seat; tricks: number; by: Seat }
  recordId?: string
  /** When the next board is dealt (ms), once a board is finished */
  dealAt?: number
  /** Declarer's and dummy's seats when a person was moved into a robot partner's declaring seat */
  swapped?: [Seat, Seat]
  /** Boards finished here, newest first (older tables may not have it) */
  recent?: BoardSummary[]
  createdAt: number
  /** What the table is for (`worker/modes.ts`); tables saved before modes are casual */
  mode?: TableMode
  /** The mode's own progress, e.g. which challenge boards are done */
  modeState?: unknown
  /** Where the boards come from; random when absent. Fixed hands never leave the server */
  dealSource?: DealSource
  /** How the host runs the table; tables saved before settings use DEFAULT_TABLE_SETTINGS */
  settings?: TableSettings
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
 * made (and dummy then sees the declarer's hand, as on BBO), and everything once the board is over.
 * A claim lays the claimer's hand face up for good, even if it is rejected: once the declarer has
 * claimed, both defenders see all four hands (the declarer still sees only their own and dummy);
 * a defender who claimed shows their hand to everyone.
 * Spectators see all four hands, as kibitzers do on BBO. Partners never see each other's alerts
 * until the board is over, except a robot's, which are for everyone (GIB's on BBO are too).
 * `auctionSeat` is where the viewer bid from, if a declarer swap has moved them since.
 */
export function boardView(
  board: BoardState,
  viewer: Seat | null,
  extras: {
    undo?: { seat: Seat }
    recordId?: string
    rejectedClaim?: { seat: Seat; tricks: number; by: Seat }
    auctionSeat?: Seat
  } = {},
): BoardView {
  const finished = board.phase === 'finished'
  const dummy = dummyOf(board)
  const dummyExposed = dummy !== null && board.play.length > 0
  const declarer = board.contract?.declarer
  const claimed = board.claimed ?? []
  const defender = viewer !== null && viewer !== declarer && viewer !== dummy
  const canSee = (seat: Seat) =>
    finished ||
    viewer === null ||
    seat === viewer ||
    (dummyExposed && seat === dummy) ||
    (dummyExposed && viewer === dummy && seat === declarer) ||
    (claimed.includes(seat) && seat !== declarer) ||
    (defender && !!declarer && claimed.includes(declarer))

  const hands: BoardView['hands'] = {}
  const handCounts = {} as BoardView['handCounts']
  for (const seat of SEATS) {
    const cards = finished ? board.hands[seat] : remainingCards(board, seat)
    handCounts[seat] = cards.length
    if (canSee(seat)) hands[seat] = cards
  }

  const auction = board.auction.map((entry) => {
    if (entry.alert === undefined || entry.robot || finished || viewer === null || viewer !== partnerOf(entry.seat))
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
    canUndo: !!viewer && !extras.undo && canUndoFor(board, viewer, extras.auctionSeat ?? viewer),
    canClaim: !!viewer && board.phase === 'play' && viewer !== dummy && !board.claim,
  }

  if (board.claim) {
    view.claim = { ...board.claim, approvers: claimApprovers(board, board.claim.seat) }
  }
  if (extras.undo && !finished) view.undo = extras.undo
  if (extras.rejectedClaim && board.phase === 'play') view.rejectedClaim = extras.rejectedClaim
  if (board.result) view.result = board.result
  if (extras.recordId && finished) view.recordId = extras.recordId
  return view
}
