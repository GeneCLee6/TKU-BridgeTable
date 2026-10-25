import type { MessageCode } from '../shared/messages.ts'
import {
  MATCH_SEATS,
  parseTeamMatchSettings,
  teamAt,
  type MatchSeat,
  type TeamMatchSettings,
} from '../shared/team-match.ts'
import type { TeamMatch } from './team-matches.ts'

/**
 * The steps of a team match before it starts (ARCHITECTURE.md §5.8, e8-t03), as pure functions:
 * `TeamMatchService` checks who is asking, calls these, and writes what they return. Inviting,
 * captains and starting are later batches (F3, F4).
 */

export type FlowError = { error: MessageCode; params?: Record<string, string | number> }

/** The host's seat when they do not pick one: South of the open room, as on BBO */
export const HOST_SEAT_DEFAULT: MatchSeat = { room: 'open', seat: 'S' }

/** Reads the seat the host asked for; it has to be one of team A's (the host's team is team A) */
export function parseHostSeat(value: unknown): MatchSeat | null {
  if (value === undefined) return HOST_SEAT_DEFAULT
  if (!value || typeof value !== 'object') return null
  const { room, seat } = value as Record<string, unknown>
  const found = MATCH_SEATS.find((s) => s.room === room && s.seat === seat)
  return found && teamAt(found.room, found.seat) === 'A' ? { ...found } : null
}

/** A new match being set up: the host sits in their seat and captains team A; the other seats are empty */
export function newTeamMatch(input: {
  id: string
  hostId: string
  now: number
  settings: TeamMatchSettings
  seat: MatchSeat
}): TeamMatch {
  const { id, hostId, now, settings, seat } = input
  return {
    id,
    hostId,
    createdAt: now,
    status: 'setup',
    settings,
    captains: { A: hostId },
    seats: MATCH_SEATS.map((s) =>
      s.room === seat.room && s.seat === seat.seat
        ? { ...s, status: 'seated', userId: hostId, robot: false, answeredAt: now }
        : { ...s, status: 'empty', robot: false },
    ),
    boards: [],
  }
}

/** Only the host changes or cancels a match, and only before it starts */
function hostBeforeStart(match: TeamMatch, userId: string): FlowError | null {
  if (match.hostId !== userId) return { error: 'matchHostOnly' }
  if (match.status !== 'setup') return { error: 'matchStarted' }
  return null
}

/**
 * New settings from the host (every field optional, the rest kept). Turning robots off frees the
 * seats robots were in, since they could no longer stay
 */
export function changeSettings(
  match: TeamMatch,
  userId: string,
  value: unknown,
): FlowError | { settings: TeamMatchSettings; freed: MatchSeat[] } {
  const denied = hostBeforeStart(match, userId)
  if (denied) return denied
  const parsed = parseTeamMatchSettings(value, match.settings)
  if ('field' in parsed) return { error: 'badMatchSettings', params: { field: parsed.field } }
  const freed = parsed.settings.robots ? [] : match.seats.filter((s) => s.robot).map(({ room, seat }) => ({ room, seat }))
  return { settings: parsed.settings, freed }
}

/** The host calls the match off before it starts; nothing was dealt, so nothing else changes */
export function cancelMatch(match: TeamMatch, userId: string): FlowError | { ok: true } {
  return hostBeforeStart(match, userId) ?? { ok: true }
}

/** Why the host cannot start yet (AC-8.2), shown on the start button (`e8-t06`) */
export type NotReady = 'seats' | 'offline' | 'robots'

/**
 * Whether the host can start: every seat taken by a member who accepted or a robot, robots only
 * if the settings allow them, and every member online. Worked out each time, never stored, since
 * being online is not
 */
export function matchReady(match: TeamMatch, online: (userId: string) => boolean): { ready: true } | { ready: false; reason: NotReady } {
  if (match.status !== 'setup' || match.seats.some((s) => s.status !== 'seated')) return { ready: false, reason: 'seats' }
  if (!match.settings.robots && match.seats.some((s) => s.robot)) return { ready: false, reason: 'robots' }
  if (match.seats.some((s) => s.userId !== undefined && !online(s.userId))) return { ready: false, reason: 'offline' }
  return { ready: true }
}

/** Where a member sits (or is invited to sit) in the match, if anywhere */
export const seatOf = (match: TeamMatch, userId: string): MatchSeat | null => {
  const found = match.seats.find((s) => s.userId === userId)
  return found ? { room: found.room, seat: found.seat } : null
}

/** Someone the match is about: the host or anyone invited to or sitting in a seat */
export const isMatchPlayer = (match: TeamMatch, userId: string) =>
  match.hostId === userId || match.seats.some((s) => s.userId === userId)
