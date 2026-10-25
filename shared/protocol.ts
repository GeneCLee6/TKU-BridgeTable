import type { AuctionCall, Call, Contract } from './auction.ts'
import type { Vulnerability } from './board.ts'
import type { Card, Seat, Side } from './cards.ts'
import type { ChallengeSettings } from './challenge.ts'
import type { BoardResult, BoardState, Phase, Trick } from './game.ts'
import type { MessageCode, MessageParams } from './messages.ts'
import type { MatchSeat, TeamMatchView } from './team-match.ts'
import type { Profile } from './profile.ts'

/** Messages and views exchanged between the browser and the Worker over HTTP and WebSocket */

export interface PublicUser {
  id: string
  username: string
  /** Set for a robot player in a seat or a history record */
  robot?: boolean
  /**
   * The system TKB bids: the club's or the GIB-compatible 2/1; older records have none (the club's).
   * Records from when robots had levels may still carry a `robotLevel`, which nothing reads
   */
  robotKind?: RobotKind
}

/**
 * What an admin can let a member do beyond playing: edit TKU BridgeBook (淡江橋譜) online, and
 * import Word or PDF files into it. Admins can do both.
 */
/** TKU BridgeBook editing and import (§5.2), and featuring finished boards (`boardCurate`, e4-t28) */
export const PERMISSIONS = ['bookEdit', 'bookImport', 'boardCurate'] as const
export type Permission = (typeof PERMISSIONS)[number]
export const isPermission = (value: unknown): value is Permission => PERMISSIONS.includes(value as Permission)

/** The signed-in user, as /api/me returns it */
export interface Me extends PublicUser {
  admin: boolean
  /** Everything for an admin */
  permissions: Permission[]
  /** Admins only: registrations waiting for approval */
  applications?: number
  /** Whether the bell says when a friend comes online (e1-t24); the server always sets it, on unless turned off */
  friendOnlineNotice?: boolean
  /** The member's own profile (AC-1.5), to edit on "My account"; empty until they fill it in */
  profile?: Profile
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
  /** A robot sitting in for a member who dropped offline (代打, `e2-t31`): their name; they get the seat back on returning */
  substituteFor?: string
}

/**
 * Robots sit in seats under ids like 'robot:gib:N'. Ids saved earlier still read: 'robot:N' (the
 * club's system) and, from when robots had levels, 'robot:gib:beginner:N' (every level is TKB now)
 */
export const ROBOT_PREFIX = 'robot:'
export const isRobotId = (id: string | null | undefined) => !!id && id.startsWith(ROBOT_PREFIX)

/**
 * The robot is TKB (ROBOT.md), and a host seats it in either bidding system: the club's
 * (淡江制度, the club's system in TKU BridgeBook) or 2/1 (GIB-compatible, docs/BBO GIB)
 */
export const ROBOT_KINDS = ['tku', 'gib'] as const
export type RobotKind = (typeof ROBOT_KINDS)[number]
export const isRobotKind = (value: unknown): value is RobotKind => ROBOT_KINDS.includes(value as RobotKind)

/** A robot's id carries its system, so it moves with the robot when seats are swapped and survives a reload */
export const robotId = (kind: RobotKind, seat: Seat) => `${ROBOT_PREFIX}${kind}:${seat}`
export function robotKindOf(id: string): RobotKind {
  const kind = id.slice(ROBOT_PREFIX.length).split(':')[0]
  return isRobotKind(kind) ? kind : 'tku'
}

export interface ChatMessage {
  id: string
  at: number
  userId: string
  username: string
  text: string
}

/**
 * How a host runs their table (AC-2.9): open to every member or to invited ones only, and whether
 * people who are not seated may watch. Tables saved before settings use the defaults
 */
export const TABLE_VISIBILITIES = ['public', 'invite'] as const
export type TableVisibility = (typeof TABLE_VISIBILITIES)[number]
/** The time limits a host may set for each board, in minutes (AC-2.10); 0 is none */
export const BOARD_TIME_LIMITS = [0, 5, 7, 10, 15] as const
export interface TableSettings {
  visibility: TableVisibility
  allowKibitz: boolean
  /** Minutes each board may take, one of BOARD_TIME_LIMITS; 0 is no limit */
  boardMinutes: number
}
export const DEFAULT_TABLE_SETTINGS: TableSettings = { visibility: 'public', allowKibitz: true, boardMinutes: 0 }

/** After this long on one call or card a player is reminded, and the host may seat a robot instead (AC-2.10) */
export const SLOW_TURN_MS = 60_000
/** A seated member offline this long is replaced by a robot until they come back (代打, AC-2.13) */
export const SUBSTITUTE_MS = 3 * 60_000

/** Checks settings from the browser: every field optional, nothing else allowed; null when invalid */
export function parseTableSettings(value: unknown): Partial<TableSettings> | null {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { visibility, allowKibitz, boardMinutes, ...rest } = value as Record<string, unknown>
  if (Object.keys(rest).length) return null
  if (visibility !== undefined && !TABLE_VISIBILITIES.includes(visibility as TableVisibility)) return null
  if (allowKibitz !== undefined && typeof allowKibitz !== 'boolean') return null
  if (boardMinutes !== undefined && !(BOARD_TIME_LIMITS as readonly unknown[]).includes(boardMinutes)) return null
  return {
    ...(visibility !== undefined && { visibility: visibility as TableVisibility }),
    ...(allowKibitz !== undefined && { allowKibitz }),
    ...(boardMinutes !== undefined && { boardMinutes: boardMinutes as number }),
  }
}

/**
 * What a table is for (`worker/modes.ts`): `casual` tables anyone opens, and a participant's own
 * `challenge` table (ARCHITECTURE.md §5.5). Team matches, practice and pairs events add theirs
 */
export const TABLE_MODES = ['casual', 'challenge'] as const
export type TableMode = (typeof TABLE_MODES)[number]

/** A challenge table as its player sees it: which challenge, which board of how many, until when */
export interface TableChallenge {
  id: string
  /** The board on the table: its place in the challenge, 1-based (0 before the first) */
  seq: number
  /** Boards in the challenge */
  boards: number
  /** Boards the player has finished */
  played: number
  deadline: number
}

export interface TableSummary {
  id: string
  number: number
  hostName: string
  settings: TableSettings
  /** Whether the viewer may sit here: every member at a public table, the invited ones at an invite table */
  welcome: boolean
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
  settings: TableSettings
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
  /**
   * At a challenge table (§5.5): the challenge and the player's progress. Nobody watches, there is
   * no undo, and seats and settings do not change there
   */
  challenge?: TableChallenge
  /** The host only: the members invited to the table (`e2-t25`) */
  invited?: PublicUser[]
  /** When the board's time limit runs out (server clock, ms), while a board is played at a table with one */
  boardEndsAt: number | null
  /**
   * The seat the table is waiting on (a call or card from a person) and since when (server clock),
   * for the reminder after SLOW_TURN_MS; null when nobody is waited on
   */
  waiting: { seat: Seat; since: number } | null
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
  /** Ids of the members the viewer follows (好友, one-way: nobody is asked); `members` lists them first */
  friends: string[]
  /** Ids of the members the viewer blocked: their chat is hidden from the viewer, and they cannot join a table the viewer hosts */
  blocked: string[]
}

/**
 * Something a member should know about, kept for them until they read it (AC-1.8). The browser
 * writes the text in the viewer's language from `kind` and `params`, and knows where each kind
 * leads (`src/lib/notifications.ts`). Challenges, match invitations and messages add their kinds
 */
export const NOTIFICATION_KINDS = [
  'application',
  'challengeInvited',
  'challengeAccepted',
  'challengeDeclined',
  'challengeCancelled',
  'challengeReminder',
  'challengeResults',
  'challengeWeekly',
  'friendOnline',
  'tableInvited',
  'matchInvited',
  'matchAccepted',
  'matchDeclined',
  'matchLeft',
  'matchRemoved',
  'matchCancelled',
  'boardFeatured',
] as const
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number]

export interface Notification {
  id: string
  at: number
  kind: NotificationKind
  /**
   * `application`: { username } of the person who registered. The challenge kinds (§5.5):
   * { challengeId, username } of who invited, accepted, declined or cancelled; the reminder 12 hours
   * before the deadline and the results (`challengeReminder`, `challengeResults`) carry
   * { challengeId } and are sent by the deadline job (`e7-t13`); `challengeWeekly` { challengeId }
   * goes to every member when the weekly club challenge is created (`e7-t23`). `friendOnline`: { username } of
   * a member the viewer follows who just came online (e1-t24). `tableInvited`: { tableId, number,
   * username } of the table and the host who invited (`e2-t25`). `boardFeatured`: { boardId,
   * username } of a board the member played and who featured it (`e4-t29`). The team match kinds
   * (§5.8, `e8-t04`): { matchId, username } of who invited, accepted, declined, left, took the
   * member off a seat or called the match off
   */
  params: Record<string, string | number>
  read: boolean
}

/** The newest notifications (up to NOTIFICATIONS_SHOWN) and how many of all kept are unread */
export interface NotificationsView {
  items: Notification[]
  unread: number
}

/** How many notifications a member keeps, and how many the bell shows */
export const NOTIFICATIONS_KEPT = 500
export const NOTIFICATIONS_SHOWN = 30

/**
 * A direct message (私訊, AC-1.7) between two members. Only those two are ever sent it; ids grow
 * with time across the whole club, so they order a conversation and page it (`before`)
 */
export interface DirectMessage {
  id: number
  from: string
  to: string
  text: string
  at: number
}

/** One conversation as the viewer's list shows it: the other member, the newest message, unread count */
export interface Conversation {
  user: PublicUser
  last: DirectMessage
  unread: number
}

/** The viewer's conversations, newest first (up to DIRECT_CONVERSATIONS_SHOWN), and all their unread messages */
export interface DirectsView {
  conversations: Conversation[]
  unread: number
}

/** `GET /api/messages/:userId?before=<id>`: one page of a conversation, oldest first; `more` when older ones exist */
export interface DirectPage {
  messages: DirectMessage[]
  more: boolean
}

/** Messages kept per conversation, messages per page, and conversations in the list */
export const DIRECT_KEPT = 1000
export const DIRECT_PAGE_SIZE = 30
export const DIRECT_CONVERSATIONS_SHOWN = 50

export type ClientMessage =
  /** `invitees`: the members invited to the table (they are told), at most LIMITS.tableInvitesMax */
  | { type: 'createTable'; settings?: Partial<TableSettings>; invitees?: string[] }
  /** The host changes how the table is run; `invitees`, when sent, replaces the invitation list */
  | { type: 'updateTableSettings'; settings: Partial<TableSettings>; invitees?: string[] }
  /** Sits at the public table that most needs a player, or opens one when none does (快速入座) */
  | { type: 'quickSeat' }
  | { type: 'joinTable'; tableId: string }
  | { type: 'sit'; tableId: string; seat: Seat }
  | { type: 'stand' }
  | { type: 'leaveTable' }
  /** The host asks a person to leave a seat; they stay at the table, watching */
  | { type: 'kick'; seat: Seat }
  /** TKB in the club's system unless `kind` says otherwise */
  | { type: 'addRobot'; seat: Seat; kind?: RobotKind }
  | { type: 'removeRobot'; seat: Seat }
  /** The host asks a player who has kept the table waiting SLOW_TURN_MS to leave, and seats TKB there */
  | { type: 'replaceWithRobot'; seat: Seat; kind?: RobotKind }
  | { type: 'call'; call: Call; alert?: string }
  | { type: 'play'; card: Card }
  | { type: 'claim'; tricks: number }
  | { type: 'claimRespond'; accept: boolean }
  | { type: 'undoRequest' }
  | { type: 'undoRespond'; accept: boolean }
  | { type: 'chat'; text: string }
  /** Marks these notifications read, or all of them when `ids` is left out */
  | { type: 'readNotifications'; ids?: string[] }
  /** Follows another member (好友) or stops following them; one-way, they are not asked */
  | { type: 'setFriend'; userId: string; friend: boolean }
  /** Blocks or unblocks another member; blocking also stops following them */
  | { type: 'setBlocked'; userId: string; blocked: boolean }
  /** Starts a challenge, or goes back to it: the player's own table, from the next board (§5.5) */
  | { type: 'playChallenge'; challengeId: string }
  /**
   * Challenges 1–20 friends (§5.5): `boards` 4–16 (8 when left out), settings over the defaults.
   * With `fromBoards` (history ids, 1–16) the boards are ones the creator played with three robots
   * (「用這副牌挑戰」, `e7-t22`): their results count and they do not play again
   */
  | {
      type: 'createChallenge'
      invitees: string[]
      boards?: number
      settings?: Partial<ChallengeSettings>
      fromBoards?: string[]
    }
  /** An invitee accepts or declines, once, before the deadline */
  | { type: 'answerChallenge'; challengeId: string; accept: boolean }
  /** The creator calls a challenge off while nobody else has started */
  | { type: 'cancelChallenge'; challengeId: string }
  /** One-click rematch (`e7-t21`): the same people and settings, new boards, once a challenge ended */
  | { type: 'rematchChallenge'; challengeId: string }
  /**
   * Team match seats before the start (§5.8, `e8-t04`, `e8-t05`): a captain invites a member to an
   * empty seat of their team, puts a robot there or clears it; the invited answer; a seated member
   * moves to an empty seat of their team, or a captain swaps two seats of their team; anyone but
   * the host leaves. Also over HTTP (`POST /api/matches/:id/<action>`)
   */
  | { type: 'matchInvite'; matchId: string; room: MatchSeat['room']; seat: Seat; userId: string }
  | { type: 'matchAnswer'; matchId: string; accept: boolean }
  | { type: 'matchMove'; matchId: string; from: MatchSeat; to: MatchSeat }
  | { type: 'matchLeave'; matchId: string }
  | { type: 'matchClear'; matchId: string; room: MatchSeat['room']; seat: Seat }
  | { type: 'matchRobot'; matchId: string; room: MatchSeat['room']; seat: Seat }
  /** Sends a direct message (AC-1.7): not to oneself, a robot, or between members where either blocked the other */
  | { type: 'sendDirect'; to: string; text: string }
  /** Marks the conversation with this member read */
  | { type: 'readDirect'; userId: string }

export type ServerMessage =
  | { type: 'welcome'; me: Me }
  | { type: 'lobby'; lobby: LobbyView }
  /** `now` is the server's clock when sent, so the browser can turn `dealAt` into its own time */
  | { type: 'table'; table: TableWire | null; now: number }
  | { type: 'error'; code: MessageCode; params: MessageParams; message: string }
  /** On connecting, and whenever the member's notifications change */
  | { type: 'notifications'; notifications: NotificationsView }
  /** On connecting, and whenever the member's conversations or unread counts change */
  | { type: 'directs'; directs: DirectsView }
  /** A new direct message, sent only to its two members (all their tabs) */
  | { type: 'direct'; message: DirectMessage }
  /**
   * A team match the member is in changed (§5.8): as they now see it, or null once they may no
   * longer see it (they left, declined or were taken off their seat before the start)
   */
  | { type: 'match'; matchId: string; match: TeamMatchView | null }

/** A finished board kept in the history */
export interface BoardRecord {
  id: string
  tableNumber: number
  finishedAt: number
  players: Record<Seat, PublicUser>
  board: BoardState
  /** The table's mode when it is not `casual` */
  mode?: TableMode
  /** The challenge or match the board belongs to, if any */
  eventId?: string
  /**
   * Until when only the board's own players may see it (a challenge still being played); shown to
   * everyone when absent. `worker/views.ts` has the rule
   */
  revealAt?: number
  /** Seats where a robot played for a member who was offline (代打) during the board, and for whom */
  substitutes?: Partial<Record<Seat, PublicUser>>
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
  mode?: TableMode
  eventId?: string
  revealAt?: number
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
    ...(record.mode !== undefined && { mode: record.mode }),
    ...(record.eventId !== undefined && { eventId: record.eventId }),
    ...(record.revealAt !== undefined && { revealAt: record.revealAt }),
  }
}

/** One page of the history list, newest first; `page` counts from 1 */
export interface HistoryPage {
  boards: BoardSummary[]
  total: number
  page: number
  size: number
}

/** A board a member keeps (AC-4.4): their own note and tags, seen by no one else */
export interface Favorite {
  boardId: string
  note: string
  tags: string[]
  createdAt: number
  updatedAt: number
}

/** A member's tag and how many of their favorites carry it, for the tag filter and autocomplete */
export interface FavoriteTag {
  tag: string
  count: number
}

/** One page of 「我的收藏」: the boards as a history page, plus each one's note and tags */
export interface FavoritesPage extends HistoryPage {
  favorites: Favorite[]
  tags: FavoriteTag[]
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
  directMax: 500,
  alertMax: 200,
  maxUsersMin: 2,
  maxUsersMax: 100,
  tableInvitesMax: 30,
  historyPageDefault: 20,
  favoritesMax: 1000,
  favoriteNoteMax: 500,
  favoriteTagsMax: 8,
  favoriteTagMax: 20,
}

export const USERNAME_PATTERN = /^[\p{L}\p{N}_.-]+$/u

// ---------------------------------------------------------------------------------------------
// System profiles (制度集, TKU BridgeBook E1 e1-t07)
//
// A profile is a layer over the club's handbook: which conventions a team or partnership plays,
// and where its agreements differ from the club's. The handbook resolves the layers into the
// conventions a reader sees (TKU-BridgeBook src/lib/profiles.ts). TKU-BridgeBook src/lib/api.ts
// mirrors these types; change them together.
// ---------------------------------------------------------------------------------------------

/** The club's own profile: always there, never deleted, the root every other profile inherits */
export const CLUB_PROFILE_ID = 'club'

/** Who a profile belongs to: the club, a team, or a partnership */
export const PROFILE_SCOPES = ['club', 'team', 'partnership'] as const
export type ProfileScope = (typeof PROFILE_SCOPES)[number]
export const isProfileScope = (value: unknown): value is ProfileScope => PROFILE_SCOPES.includes(value as ProfileScope)

/**
 * Limits the Worker checks on a saved profile: its JSON in UTF-8 bytes, how many overrides it may
 * hold, how many profiles the club may have besides its own, the name's length and a note's length
 */
export const PROFILE_LIMITS = { bytesMax: 200_000, overridesMax: 500, profilesMax: 100, nameMax: 40, noteMax: 2_000 } as const

/** Whether a profile plays a convention; a convention it does not list follows the parent profile */
export type Adoption = 'on' | 'off'

/**
 * One place where a profile differs from its parent. Rows are found by position, the same as the
 * handbook's editor: `blockIndex` within the section's own blocks, `rowIndex` within that
 * `responses` block. `section` is a handbook Section (TKU-BridgeBook src/types/convention.ts),
 * checked here only for shape, like BookEntry.convention
 */
export type ProfileOverride =
  /** A response row means something else; `note`, when present, replaces the row's note ('' clears it) */
  | { kind: 'row'; slug: string; sectionId: string; blockIndex: number; rowIndex: number; meaning: string; note?: string }
  /** The whole section is replaced (it keeps `sectionId` as its id) */
  | { kind: 'section'; slug: string; sectionId: string; section: Record<string, unknown> }
  /** The convention's summary or tags, whichever is present */
  | { kind: 'meta'; slug: string; summary?: string; tags?: string[] }

/** A private note on a convention or one of its sections, shown only to the profile's members */
export interface ProfileNote {
  slug: string
  sectionId?: string
  text: string
  /** The user id that wrote it */
  by: string
  at: number
}

export interface SystemProfile {
  /** CLUB_PROFILE_ID for the club; a random id for the others */
  id: string
  /** 「社團預設」「A 隊」「小明＋小華」 */
  name: string
  scope: ProfileScope
  /** The profile this one inherits; absent for the club, and taken as the club when absent on any other */
  parentId?: string
  /** slug -> plays it or not; a slug left out follows the parent */
  adopted: Record<string, Adoption>
  overrides: ProfileOverride[]
  notes: ProfileNote[]
  version: number
  updatedAt: number
  /** The user id that saved this version */
  updatedBy: string
}

/** GET /api/book/profiles: a profile without its adoptions, overrides and notes, which it counts instead */
export interface ProfileSummary {
  id: string
  name: string
  scope: ProfileScope
  parentId?: string
  version: number
  updatedAt: number
  updatedBy: string
  counts: { adopted: number; overrides: number; notes: number }
}

/** A saved version of a profile, newest first in the list, which leaves out `profile` */
export interface ProfileRevision {
  profileId: string
  version: number
  at: number
  /** The user id that saved it */
  by: string
  note: string
  profile?: SystemProfile
}

/** What an editor sends to create or save a profile; the Worker sets the id, version and who saved it */
export type ProfileInput = Pick<SystemProfile, 'name' | 'scope' | 'parentId' | 'adopted' | 'overrides' | 'notes'>
