import type { AuctionCall, Call, Contract } from './auction.ts'
import type { Vulnerability } from './board.ts'
import type { Card, Seat, Side } from './cards.ts'
import type { BoardResult, BoardState, Phase, Trick } from './game.ts'

/** Messages and views exchanged between the browser and the Worker over HTTP and WebSocket */

export interface PublicUser {
  id: string
  username: string
}

export interface SeatOccupant extends PublicUser {
  online: boolean
}

export interface ChatMessage {
  id: string
  at: number
  userId: string
  username: string
  text: string
}

export interface TableSummary {
  id: string
  number: number
  hostName: string
  seats: Record<Seat, SeatOccupant | null>
  spectators: number
  boardsPlayed: number
  /** Board number currently on the table, if any */
  boardNo: number | null
}

/** One board as a particular viewer is allowed to see it */
export interface BoardView {
  boardNo: number
  dealer: Seat
  vul: Vulnerability
  phase: Phase
  /** Remaining cards of each hand the viewer may see (all original cards once finished) */
  hands: Partial<Record<Seat, Card[]>>
  handCounts: Record<Seat, number>
  /** Alerts the viewer may not see are removed */
  auction: AuctionCall[]
  contract: Contract | null
  dummy: Seat | null
  turn: Seat | null
  tricks: Trick[]
  tricksWon: Record<Side, number>
  /** Cards the viewer may click right now, if any (their own hand or dummy's) */
  legalCards: Card[]
  /** Calls the viewer may make, if it is their turn to call */
  legalCalls: Call[]
  claim?: { seat: Seat; tricks: number; accepted: Seat[]; approvers: Seat[]; hand?: Card[] }
  undo?: { seat: Seat }
  result?: BoardResult
  /** History record id once the board is saved */
  recordId?: string
}

export interface TableView {
  id: string
  number: number
  hostId: string
  seats: Record<Seat, SeatOccupant | null>
  spectators: PublicUser[]
  mySeat: Seat | null
  board: BoardView | null
  boardsPlayed: number
  /** Seats that pressed "next board" after a finished board */
  ready: Seat[]
  chat: ChatMessage[]
}

export interface LobbyView {
  online: PublicUser[]
  tables: TableSummary[]
  /** The table the current user is seated at or watching */
  myTableId: string | null
}

export type ClientMessage =
  | { type: 'createTable' }
  | { type: 'joinTable'; tableId: string }
  | { type: 'sit'; tableId: string; seat: Seat }
  | { type: 'stand' }
  | { type: 'leaveTable' }
  | { type: 'freeSeat'; seat: Seat }
  | { type: 'call'; call: Call; alert?: string }
  | { type: 'play'; card: Card }
  | { type: 'claim'; tricks: number }
  | { type: 'claimRespond'; accept: boolean }
  | { type: 'undoRequest' }
  | { type: 'undoRespond'; accept: boolean }
  | { type: 'ready' }
  | { type: 'chat'; text: string }

export type ServerMessage =
  | { type: 'welcome'; me: PublicUser }
  | { type: 'lobby'; lobby: LobbyView }
  | { type: 'table'; table: TableView | null }
  | { type: 'error'; message: string }

/** A finished board kept in the history */
export interface BoardRecord {
  id: string
  tableNumber: number
  finishedAt: number
  players: Record<Seat, PublicUser>
  board: BoardState
}

export interface BoardSummary {
  id: string
  tableNumber: number
  finishedAt: number
  players: Record<Seat, PublicUser>
  boardNo: number
  dealer: Seat
  vul: Vulnerability
  contract: Contract | null
  result: BoardResult
}

export function summarize(record: BoardRecord): BoardSummary {
  const { board } = record
  return {
    id: record.id,
    tableNumber: record.tableNumber,
    finishedAt: record.finishedAt,
    players: record.players,
    boardNo: board.boardNo,
    dealer: board.dealer,
    vul: board.vul,
    contract: board.contract,
    result: board.result!,
  }
}

/** Limits shared by the client forms and the server checks */
export const LIMITS = {
  usernameMin: 2,
  usernameMax: 16,
  passwordMin: 6,
  chatMax: 300,
  alertMax: 200,
}

export const USERNAME_PATTERN = /^[\p{L}\p{N}_.-]+$/u
