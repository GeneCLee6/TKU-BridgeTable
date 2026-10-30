import type { Contract } from './auction.ts'
import type { Card, Seat } from './cards.ts'
import { isRobotKind, type BoardView, type PublicUser, type RobotKind, type SeatOccupant, type TableMatch } from './protocol.ts'
import type { ScoreRuling } from './ruling-scoring.ts'
import { MATCH_SCORINGS, type MatchScoring, type Ruling, type Team, type TeamBoardResult } from './team-scoring.ts'

/**
 * A two-table team match's states, seats and settings (docs/PRD/e8-two-table-team-match.md,
 * ARCHITECTURE.md §5.8). Storage is `worker/team-matches.ts`, the steps `worker/team-match-flow.ts`.
 *
 * - `setup`: the host is gathering eight players; settings can change, the host can cancel. Being
 *   ready to start (`matchReady` in the flow) is worked out from the seats and who is online, not
 *   stored, since being online is not
 * - `playing`: both tables are dealing the same boards
 * - `finished`: both rooms played every board (or the host ruled on the rest)
 * - `cancelled`: the host called it off before it started
 * - `abandoned`: stopped while playing; the boards both rooms played are kept and scored
 */
export const MATCH_STATUSES = ['setup', 'playing', 'finished', 'cancelled', 'abandoned'] as const
export type MatchStatus = (typeof MATCH_STATUSES)[number]

/** A match that can still change; the others are kept as they ended */
export const isOpenMatch = (status: MatchStatus) => status === 'setup' || status === 'playing'

/** The open room (Table 1) and the closed room (Table 2) */
export const ROOMS = ['open', 'closed'] as const
export type Room = (typeof ROOMS)[number]

export interface MatchSeat {
  room: Room
  seat: Seat
}

/** The eight seats in order: the open room's N E S W, then the closed room's */
export const MATCH_SEATS: readonly MatchSeat[] = ROOMS.flatMap((room) =>
  (['N', 'E', 'S', 'W'] as const).map((seat) => ({ room, seat })),
)

/** Team A sits North-South in the open room and East-West in the closed room; team B the reverse */
export function teamAt(room: Room, seat: Seat): Team {
  const northSouth = seat === 'N' || seat === 'S'
  return northSouth === (room === 'open') ? 'A' : 'B'
}

export const isRoom = (value: unknown): value is Room => ROOMS.includes(value as Room)

/** How the eight are gathered: the host invites everyone to a seat, or only the other captain */
export const INVITE_MODES = ['direct', 'captains'] as const
export type InviteMode = (typeof INVITE_MODES)[number]

export interface TeamMatchSettings {
  /** Team A's and team B's names; an empty name shows as 「A 隊」/「B 隊」 in the viewer's language */
  teamNames: [string, string]
  boards: number
  scoring: MatchScoring
  /** Minutes a board may take before the host can rule on it; 0 is no limit */
  boardMinutes: number
  /** Robots may fill empty seats */
  robots: boolean
  /** The system TKB bids for every robot in the match, so both rooms face the same robot */
  robotKind: RobotKind
  invite: InviteMode
  /**
   * Watchers see each room one trick behind (`e8-t19`, AC-8.8): the server holds back the trick
   * being played and the one before it (`laggedBoard` in worker/views.ts)
   */
  delay: boolean
  /**
   * Boards per segment (`e8-t21`, AC-8.9); 0 plays the match in one go. Between segments both
   * rooms stop, the captains may change their team's seats and bring in substitutes, and the host
   * starts the next; the score runs on (`segmentOf`, `segmentRange`)
   */
  segmentBoards: number
}

export const TEAM_MATCH_LIMITS = {
  boardsMin: 4,
  boardsMax: 32,
  boardsDefault: 8,
  /** 0 turns the time limit off */
  minutesMin: 3,
  minutesMax: 30,
  minutesDefault: 10,
  nameMax: 20,
  /** A ruling's reason (`e8-t15`) */
  reasonMax: 200,
  /** The fewest boards a segment has (`e8-t21`); it has fewer than the match */
  segmentMin: 2,
} as const

export function defaultTeamMatchSettings(): TeamMatchSettings {
  return {
    teamNames: ['', ''],
    boards: TEAM_MATCH_LIMITS.boardsDefault,
    scoring: 'imp',
    boardMinutes: TEAM_MATCH_LIMITS.minutesDefault,
    robots: true,
    robotKind: 'gib',
    invite: 'direct',
    delay: false,
    segmentBoards: 0,
  }
}

// ── Segments (`e8-t21`, AC-8.9) ──────────────────────────────────────────────────────────────

/** How many segments the match has: 1 without segments; the last one may be shorter */
export function segmentCount(settings: Pick<TeamMatchSettings, 'boards' | 'segmentBoards'>): number {
  return settings.segmentBoards > 0 ? Math.ceil(settings.boards / settings.segmentBoards) : 1
}

/** The segment (1-based) a board of the match (`seq`, 1-based) is in */
export function segmentOf(settings: Pick<TeamMatchSettings, 'boards' | 'segmentBoards'>, seq: number): number {
  return settings.segmentBoards > 0 ? Math.max(1, Math.ceil(seq / settings.segmentBoards)) : 1
}

/** The first and last boards (`seq`) of a segment */
export function segmentRange(settings: Pick<TeamMatchSettings, 'boards' | 'segmentBoards'>, segment: number): { first: number; last: number } {
  if (settings.segmentBoards <= 0) return { first: 1, last: settings.boards }
  const first = (segment - 1) * settings.segmentBoards + 1
  return { first, last: Math.min(settings.boards, segment * settings.segmentBoards) }
}

const isTeamName = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length <= TEAM_MATCH_LIMITS.nameMax && !/[\p{Cc}]/u.test(value)

/**
 * Checks settings the host sent: every field optional, falling back on `base` (the defaults when
 * creating, the match's settings when changing them), nothing else allowed. Team names are
 * trimmed. Returns the settings, or the first field that is wrong
 */
export function parseTeamMatchSettings(
  value: unknown,
  base: TeamMatchSettings = defaultTeamMatchSettings(),
): { settings: TeamMatchSettings } | { field: string } {
  if (value === undefined) return { settings: base }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { field: 'settings' }
  const { teamNames, boards, scoring, boardMinutes, robots, robotKind, invite, delay, segmentBoards, ...rest } = value as Record<
    string,
    unknown
  >
  const extra = Object.keys(rest)[0]
  if (extra !== undefined) return { field: extra }
  if (teamNames !== undefined && !(Array.isArray(teamNames) && teamNames.length === 2 && teamNames.every(isTeamName)))
    return { field: 'teamNames' }
  const { boardsMin, boardsMax, minutesMin, minutesMax } = TEAM_MATCH_LIMITS
  if (boards !== undefined && !(Number.isInteger(boards) && (boards as number) >= boardsMin && (boards as number) <= boardsMax))
    return { field: 'boards' }
  if (scoring !== undefined && !MATCH_SCORINGS.includes(scoring as MatchScoring)) return { field: 'scoring' }
  const minutes = boardMinutes as number
  if (boardMinutes !== undefined && !(Number.isInteger(minutes) && (minutes === 0 || (minutes >= minutesMin && minutes <= minutesMax))))
    return { field: 'boardMinutes' }
  if (robots !== undefined && typeof robots !== 'boolean') return { field: 'robots' }
  if (robotKind !== undefined && !isRobotKind(robotKind)) return { field: 'robotKind' }
  if (invite !== undefined && !INVITE_MODES.includes(invite as InviteMode)) return { field: 'invite' }
  if (delay !== undefined && typeof delay !== 'boolean') return { field: 'delay' }
  const total = (boards as number | undefined) ?? base.boards
  const isSegment = (n: unknown) => Number.isInteger(n) && ((n as number) === 0 || ((n as number) >= TEAM_MATCH_LIMITS.segmentMin && (n as number) < total))
  if (segmentBoards !== undefined && !isSegment(segmentBoards)) return { field: 'segmentBoards' }
  // Fewer boards than a segment kept from before: the match is played in one go
  const segments = (segmentBoards as number | undefined) ?? (isSegment(base.segmentBoards) ? base.segmentBoards : 0)
  return {
    settings: {
      ...base,
      ...(teamNames !== undefined && { teamNames: (teamNames as string[]).map((n) => n.trim()) as [string, string] }),
      ...(boards !== undefined && { boards: boards as number }),
      ...(scoring !== undefined && { scoring: scoring as MatchScoring }),
      ...(boardMinutes !== undefined && { boardMinutes: minutes }),
      ...(robots !== undefined && { robots }),
      ...(robotKind !== undefined && { robotKind }),
      ...(invite !== undefined && { invite: invite as InviteMode }),
      ...(delay !== undefined && { delay }),
      segmentBoards: segments,
    },
  }
}

// ── What the browser gets (`teamMatchView`, worker/views.ts) ─────────────────────────────────

/** A seat: nobody yet, someone invited who has not answered, or taken (by a member or a robot) */
export const SEAT_STATUSES = ['empty', 'invited', 'seated'] as const
export type SeatStatus = (typeof SEAT_STATUSES)[number]

export interface MatchSeatView extends MatchSeat {
  team: Team
  status: SeatStatus
  /** The member invited to or sitting in the seat; absent when empty, a robot, or a deleted account */
  user?: PublicUser
  userId?: string
  robot: boolean
  /** Whether the member in the seat is online now; absent for an empty seat or a robot */
  online?: boolean
  /** While it is played: a robot sits in for the member until they come back (代打, `e8-t14`) */
  substitute?: boolean
}

/** Why the host cannot start yet (AC-8.2), shown on the start button (`e8-t06`) */
export type NotReady = 'seats' | 'offline' | 'robots'

/**
 * Who arranges a team's seats (`e8-t05`): team A's captain is the host. Team B's is the host too
 * when the host invites everyone (`direct`); with captains it is team B's captain once one
 * accepted, and the host until then (who may invite only that captain, and add robots)
 */
export function arrangerOf(match: { hostId: string; settings: TeamMatchSettings; captains: { A: string; B?: string } }, team: Team): string {
  if (team === 'A' || match.settings.invite === 'direct') return match.hostId
  return match.captains.B ?? match.hostId
}

/**
 * One room's result on a board of the result page (`e8-t12`, AC-8.7): its record (the replay), the
 * North-South score, and from the history index the contract and the declarer's tricks; the opening
 * lead as the room reported it (absent for boards played before it was kept)
 */
export interface MatchRoomView {
  boardId: string
  scoreNS: number
  /** Null for a passed-out board; absent when the index has no row for it */
  contract?: Contract | null
  declarerTricks?: number | null
  lead?: Card
  /**
   * A director's ruling on this room's board (`e2-t36`), only when it counted in the score (the
   * host's ruling on the whole board wins); `scoreNS` stays the score played
   */
  ruling?: ScoreRuling
}

/** A board both rooms finished (or the host ruled on), as everyone allowed to see the score sees it */
export interface MatchBoardView {
  /** The board's place in the match, 1-based */
  seq: number
  open?: MatchRoomView
  closed?: MatchRoomView
  ruling?: Ruling & { reason: string }
  result: TeamBoardResult
}

/**
 * Where a room is (`e8-t15`), for the host only, who rules on a board over the time limit: the
 * board on its table (its place in the match), whether it is being played and when its time is up
 * (absent without a limit)
 */
export interface MatchRoomClock {
  seq: number | null
  playing: boolean
  endsAt?: number
}

export interface TeamMatchView {
  id: string
  hostId: string
  createdAt: number
  status: MatchStatus
  startedAt?: number
  endedAt?: number
  settings: TeamMatchSettings
  captains: { A: string; B?: string }
  seats: MatchSeatView[]
  /**
   * The two rooms' tables while it is played (`e8-t07`): players go back to theirs, others may
   * watch either; the tables themselves keep a player out of the other room (§4)
   */
  tables?: Record<Room, string>
  /** Only boards with a result: a board one room has played and the other has not is never shown */
  boards: MatchBoardView[]
  totals: Record<Team, number>
  leader: Team | null
  /** While setting up: whether the host can start, or why not (`matchReady`, worked out each time) */
  ready?: { ready: true } | { ready: false; reason: NotReady }
  /** The host paused it (`e8-t16`): since when */
  pausedAt?: number
  /**
   * While it is played with segments (`e8-t21`): the segment being played, 1-based, and since when
   * both rooms finished it and wait for the host to start the next (`breakAt`, 中場)
   */
  segment?: number
  breakAt?: number
  /** While it is played, to the host only: each room's board and clock, for rulings (`e8-t15`) */
  rooms?: Record<Room, MatchRoomClock>
}

// ── The Vugraph page (`e8-t18`, `e8-t19`, AC-8.8) ────────────────────────────────────────────

/**
 * One room as the Vugraph page shows it: its seats and the board on its table as a watcher sees
 * it (all four hands, `vugraphBoard` in worker/views.ts), one trick behind when the match says so
 */
export interface VugraphRoom {
  tableId: string
  seats: Record<Seat, SeatOccupant | null>
  board: BoardView | null
  /** Where the room is in the match (`TableView.match`) */
  match: TableMatch
}

/** A line of the watchers' chat; the players never get it */
export interface VugraphChatLine {
  id: string
  at: number
  userId: string
  username: string
  text: string
}

/**
 * The Vugraph page (`GET /api/matches/:id/vugraph`): the match with its score, both rooms while it
 * is played, and the watchers' chat. Never for anyone who plays in the match while it is on
 */
export interface MatchVugraph {
  match: TeamMatchView
  rooms: Partial<Record<Room, VugraphRoom>>
  chat: VugraphChatLine[]
}

/** How long a line of the watchers' chat may be */
export const VUGRAPH_CHAT_MAX = 300

/** Reads a ruling's reason: trimmed, 1–200 characters, no control characters; null when it is not one */
export function parseRulingReason(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const reason = value.trim()
  if (!reason || reason.length > TEAM_MATCH_LIMITS.reasonMax || /[\p{Cc}]/u.test(reason)) return null
  return reason
}
