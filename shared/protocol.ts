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

/**
 * What an admin can let a member do beyond playing: edit TKU BridgeBook (淡江橋譜) online, and
 * import Word or PDF files into it. Admins can do both.
 */
export const PERMISSIONS = ['bookEdit', 'bookImport'] as const
export type Permission = (typeof PERMISSIONS)[number]
export const isPermission = (value: unknown): value is Permission => PERMISSIONS.includes(value as Permission)

/** The signed-in user, as /api/me returns it */
export interface Me extends PublicUser {
  admin: boolean
  /** Everything for an admin */
  permissions: Permission[]
  /** Admins only: registrations waiting for approval */
  applications?: number
}

/** Where someone registered; both sites share the accounts */
export type Site = 'table' | 'book'

/** A registration waiting for an admin to approve it, as the admin page lists it */
export interface Application {
  id: string
  username: string
  /** What the applicant wrote about themselves, e.g. their name and class */
  note: string
  site: Site
  createdAt: number
}

/** POST /api/register: the first account signs in at once; later ones wait for approval */
export type RegisterResult = { user: Me } | { pending: true; username: string }

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
  claim?: { seat: Seat; tricks: number; accepted: Seat[]; approvers: Seat[] }
  /** The last claim, turned down by `by`; shown until the next card */
  rejectedClaim?: { seat: Seat; tricks: number; by: Seat }
  /** Whether the viewer may ask to take back their last call or card (and everything since) */
  canUndo: boolean
  /** Whether the viewer may claim now: any time during the play, for anyone but dummy */
  canClaim: boolean
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
  /**
   * When the next board will be dealt (server clock, ms), while a finished board is on the table
   * and all four seats are taken; the browser runs its countdown from it
   */
  dealAt: number | null
  chat: ChatMessage[]
  /** Boards finished at this table, newest first, for the History panel */
  recent: BoardSummary[]
}

/**
 * A table as it goes over the wire: chat and recent boards are left out when they have not changed
 * since the last message to that member, and the browser keeps its copy
 */
export type TableWire = Omit<TableView, 'chat' | 'recent'> & { chat?: ChatMessage[]; recent?: BoardSummary[] }

/** After the last card the trick stays on the table this long before the countdown starts */
export const LAST_TRICK_MS = 3500
/** The countdown before the next deal */
export const DEAL_COUNTDOWN_MS = 3000

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
  /** The host asks a person to leave a seat; they stay at the table, watching */
  | { type: 'kick'; seat: Seat }
  | { type: 'addRobot'; seat: Seat }
  | { type: 'removeRobot'; seat: Seat }
  | { type: 'call'; call: Call; alert?: string }
  | { type: 'play'; card: Card }
  | { type: 'claim'; tricks: number }
  | { type: 'claimRespond'; accept: boolean }
  | { type: 'undoRequest' }
  | { type: 'undoRespond'; accept: boolean }
  | { type: 'chat'; text: string }

export type ServerMessage =
  | { type: 'welcome'; me: Me }
  | { type: 'lobby'; lobby: LobbyView }
  /** `now` is the server's clock when sent, so the browser can turn `dealAt` into its own time */
  | { type: 'table'; table: TableWire | null; now: number }
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

/** One page of the history list, newest first; `page` counts from 1 */
export interface HistoryPage {
  boards: BoardSummary[]
  total: number
  page: number
  size: number
}

/** Page sizes the history list offers */
export const HISTORY_PAGE_SIZES = [10, 20, 50, 100] as const

/** A member as the admin page lists them */
export interface AdminUser {
  id: string
  username: string
  admin: boolean
  createdAt: number
  lastLoginAt: number | null
  boards: number
  online: boolean
  permissions: Permission[]
  /** When they last reset a forgotten password themselves */
  passwordResetAt: number | null
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
  applicationNoteMax: 60,
  chatMax: 300,
  alertMax: 200,
  maxUsersMin: 2,
  maxUsersMax: 100,
  historyPageDefault: 20,
}

export const USERNAME_PATTERN = /^[\p{L}\p{N}_.-]+$/u
