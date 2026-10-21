import type { AuctionCall, Call, Contract } from './auction.ts'
import type { Vulnerability } from './board.ts'
import type { Card, Seat, Side } from './cards.ts'
import type { BoardResult, BoardState, Phase, Trick } from './game.ts'
import type { MessageCode, MessageParams } from './messages.ts'

/** Messages and views exchanged between the browser and the Worker over HTTP and WebSocket */

export interface PublicUser {
  id: string
  username: string
  /** Set for a robot player in a seat or a history record */
  robot?: boolean
}

/** The signed-in user, as /api/me returns it */
export interface Me extends PublicUser {
  admin: boolean
}

export interface SeatOccupant extends PublicUser {
  online: boolean
}

/** Robots sit in seats under ids like 'robot:N' */
export const ROBOT_PREFIX = 'robot:'
export const isRobotId = (id: string | null | undefined) => !!id && id.startsWith(ROBOT_PREFIX)

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
  /** Boards finished at this table, newest first, for the History panel */
  recent: BoardSummary[]
}

/** A club member as the People panel lists them */
export interface MemberStatus extends PublicUser {
  online: boolean
  /** Number of the table they are seated at or watching */
  tableNumber: number | null
  /** Their seat there, if seated */
  seat: Seat | null
}

export interface LobbyView {
  online: PublicUser[]
  /** Every member, online first, for the People panel */
  members: MemberStatus[]
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
  | { type: 'addRobot'; seat: Seat }
  | { type: 'removeRobot'; seat: Seat }
  | { type: 'call'; call: Call; alert?: string }
  | { type: 'play'; card: Card }
  | { type: 'claim'; tricks: number }
  | { type: 'claimRespond'; accept: boolean }
  | { type: 'undoRequest' }
  | { type: 'undoRespond'; accept: boolean }
  | { type: 'ready' }
  | { type: 'chat'; text: string }

export type ServerMessage =
  | { type: 'welcome'; me: Me }
  | { type: 'lobby'; lobby: LobbyView }
  | { type: 'table'; table: TableView | null }
  | { type: 'error'; code: MessageCode; params: MessageParams; message: string }

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

/** One page of the history list; `next` is the cursor for the following (older) page */
export interface HistoryPage {
  boards: BoardSummary[]
  next: string | null
}

/** A member as the admin page lists them */
export interface AdminUser {
  id: string
  username: string
  admin: boolean
  createdAt: number
  lastLoginAt: number | null
  boards: number
  online: boolean
}

/** Club settings an admin can change; they override the Worker's environment defaults */
export interface ClubSettings {
  maxUsers: number
  /** Empty means anyone may register (up to the limit) */
  inviteCode: string
}

/** Limits shared by the client forms and the server checks */
export const LIMITS = {
  usernameMin: 2,
  usernameMax: 16,
  passwordMin: 6,
  chatMax: 300,
  alertMax: 200,
  maxUsersMin: 2,
  maxUsersMax: 100,
  historyPage: 50,
}

export const USERNAME_PATTERN = /^[\p{L}\p{N}_.-]+$/u
