import type { Seat } from './cards.ts'
import { isRobotKind, type PublicUser, type RobotKind } from './protocol.ts'
import { MATCH_SCORINGS, type MatchScoring, type Ruling, type Team, type TeamBoardResult } from './team-scoring.ts'

/**
 * A two-table team match's states, seats and settings (docs/PRD/e8-two-table-team-match.md,
 * ARCHITECTURE.md §5.7). Storage is `worker/team-matches.ts`, the steps `worker/team-match-flow.ts`.
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
  }
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
  const { teamNames, boards, scoring, boardMinutes, robots, robotKind, invite, ...rest } = value as Record<
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
}

/** A board both rooms finished (or the host ruled on), as everyone allowed to see the score sees it */
export interface MatchBoardView {
  /** The board's place in the match, 1-based */
  seq: number
  open?: { boardId: string; scoreNS: number }
  closed?: { boardId: string; scoreNS: number }
  ruling?: Ruling & { reason: string }
  result: TeamBoardResult
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
  /** Only boards with a result: a board one room has played and the other has not is never shown */
  boards: MatchBoardView[]
  totals: Record<Team, number>
  leader: Team | null
}
