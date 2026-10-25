import type { MessageCode } from '../shared/messages.ts'
import {
  arrangerOf,
  MATCH_SEATS,
  parseTeamMatchSettings,
  teamAt,
  type MatchSeat,
  type NotReady,
  type TeamMatchSettings,
} from '../shared/team-match.ts'
import type { TeamMatch, TeamMatchSeat } from './team-matches.ts'

/**
 * The steps of a team match before it starts (ARCHITECTURE.md §5.8, e8-t03), as pure functions:
 * `TeamMatchService` checks who is asking, calls these, and writes what they return. Seats and
 * captains are F3 (`e8-t04`, `e8-t05`); starting is F4.
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
): FlowError | { settings: TeamMatchSettings; freed: MatchSeat[]; captainB?: string } {
  const denied = hostBeforeStart(match, userId)
  if (denied) return denied
  const parsed = parseTeamMatchSettings(value, match.settings)
  if ('field' in parsed) return { error: 'badMatchSettings', params: { field: parsed.field } }
  const freed = parsed.settings.robots ? [] : match.seats.filter((s) => s.robot).map(({ room, seat }) => ({ room, seat }))
  // Turning to captains with members already seated in team B: the first of them captains it
  const seatedB =
    parsed.settings.invite === 'captains' && !match.captains.B
      ? match.seats.find((s) => teamAt(s.room, s.seat) === 'B' && s.status === 'seated' && s.userId !== undefined)
      : undefined
  return { settings: parsed.settings, freed, ...(seatedB?.userId !== undefined && { captainB: seatedB.userId }) }
}

/** The host calls the match off before it starts; nothing was dealt, so nothing else changes */
export function cancelMatch(match: TeamMatch, userId: string): FlowError | { ok: true } {
  return hostBeforeStart(match, userId) ?? { ok: true }
}

export type { NotReady }

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

// ── Seats (e8-t04, e8-t05) ────────────────────────────────────────────────────────────────────

/** A seat step's writes: the seats that changed (whole), and team B's captain when it changes (null takes it away) */
export interface SeatChange {
  seats: TeamMatchSeat[]
  captainB?: string | null
}

/** Reads a seat a message names: one of the eight */
export function parseMatchSeat(value: unknown): MatchSeat | null {
  if (!value || typeof value !== 'object') return null
  const { room, seat } = value as Record<string, unknown>
  const found = MATCH_SEATS.find((s) => s.room === room && s.seat === seat)
  return found ? { ...found } : null
}

const seatAt = (match: TeamMatch, at: MatchSeat) => match.seats.find((s) => s.room === at.room && s.seat === at.seat)!
const emptied = (s: MatchSeat): TeamMatchSeat => ({ room: s.room, seat: s.seat, status: 'empty', robot: false })
const teamOf = (s: MatchSeat) => teamAt(s.room, s.seat)

/** Seat steps happen only while setting up */
const beforeStart = (match: TeamMatch): FlowError | null => (match.status === 'setup' ? null : { error: 'matchStarted' })

/**
 * When team B's captain leaves their seat (or is taken off it), the first other member seated in
 * team B becomes captain; with nobody there the host invites a new one
 */
function captainAfter(match: TeamMatch, gone: string): Pick<SeatChange, 'captainB'> {
  if (match.captains.B !== gone) return {}
  const next = match.seats.find((s) => teamOf(s) === 'B' && s.status === 'seated' && s.userId && s.userId !== gone)
  return { captainB: next?.userId ?? null }
}

/**
 * A captain invites a member to an empty seat of their team (`e8-t04`). With captains (`e8-t05`)
 * and team B still without one, the host invites only team B's captain: one member in team B at a
 * time. Whether the member exists and whether either blocked the other is checked by the service,
 * which knows the club
 */
export function inviteToSeat(
  match: TeamMatch,
  userId: string,
  at: MatchSeat,
  inviteeId: string,
  now: number,
): FlowError | SeatChange {
  const denied = beforeStart(match)
  if (denied) return denied
  const team = teamOf(at)
  if (arrangerOf(match, team) !== userId) return { error: 'matchNotCaptain' }
  if (seatAt(match, at).status !== 'empty') return { error: 'matchSeatTaken' }
  if (inviteeId === userId) return { error: 'notSelf' }
  if (isMatchPlayer(match, inviteeId)) return { error: 'matchAlreadyIn' }
  const choosingCaptain = team === 'B' && match.settings.invite === 'captains' && !match.captains.B
  if (choosingCaptain && match.seats.some((s) => teamOf(s) === 'B' && s.userId !== undefined))
    return { error: 'matchCaptainPending' }
  return { seats: [{ ...at, status: 'invited', userId: inviteeId, robot: false, invitedAt: now }] }
}

/**
 * The invited member answers (`e8-t04`): accepting takes the seat, declining empties it. With
 * captains, the member who accepts a seat of team B while it has no captain is its captain (the
 * host invited them as such)
 */
export function answerSeat(match: TeamMatch, userId: string, accept: boolean, now: number): FlowError | SeatChange {
  const denied = beforeStart(match)
  if (denied) return denied
  const mine = match.seats.find((s) => s.userId === userId && s.status === 'invited')
  if (!mine) return { error: 'matchNoInvite' }
  if (!accept) return { seats: [emptied(mine)] }
  const seated: TeamMatchSeat = { ...mine, status: 'seated', answeredAt: now }
  const captain = teamOf(mine) === 'B' && match.settings.invite === 'captains' && !match.captains.B
  return { seats: [seated], ...(captain && { captainB: userId }) }
}

/**
 * A seat changes hands within a team (換座位): a seated member moves to an empty seat of their
 * team, or the team's captain swaps any two seats of it (`e8-t05`: captains arrange their team).
 * Seats never move between teams, since the team is the room and the direction
 */
export function moveSeat(match: TeamMatch, userId: string, from: MatchSeat, to: MatchSeat): FlowError | SeatChange {
  const denied = beforeStart(match)
  if (denied) return denied
  if (teamOf(from) !== teamOf(to)) return { error: 'matchOtherTeam' }
  const a = seatAt(match, from)
  const b = seatAt(match, to)
  if (a === b) return { error: 'badSeat' }
  if (a.status === 'empty') return { error: 'matchSeatEmpty' }
  const captain = arrangerOf(match, teamOf(from)) === userId
  const ownMove = a.userId === userId && a.status === 'seated'
  if (!captain && !ownMove) return { error: 'matchNotCaptain' }
  if (!captain && b.status !== 'empty') return { error: 'matchSeatTaken' }
  const { room: roomA, seat: seatA, ...contentA } = a
  const { room: roomB, seat: seatB, ...contentB } = b
  return { seats: [{ room: roomA, seat: seatA, ...contentB }, { room: roomB, seat: seatB, ...contentA }] }
}

/** Anyone but the host leaves their seat, or turns down an invitation they already have (`e8-t04`) */
export function leaveSeat(match: TeamMatch, userId: string): FlowError | SeatChange {
  const denied = beforeStart(match)
  if (denied) return denied
  if (match.hostId === userId) return { error: 'matchHostStays' }
  const mine = match.seats.find((s) => s.userId === userId)
  if (!mine) return { error: 'matchNoInvite' }
  return { seats: [emptied(mine)], ...captainAfter(match, userId) }
}

/**
 * Clears a seat: takes back an invitation, takes a member off it, or removes a robot. The team's
 * captain may, and the host anywhere (it is their match), but never the host's own seat
 */
export function clearSeat(match: TeamMatch, userId: string, at: MatchSeat): FlowError | SeatChange {
  const denied = beforeStart(match)
  if (denied) return denied
  if (arrangerOf(match, teamOf(at)) !== userId && match.hostId !== userId) return { error: 'matchNotCaptain' }
  const target = seatAt(match, at)
  if (target.status === 'empty') return { error: 'matchSeatEmpty' }
  if (target.userId === match.hostId) return { error: 'matchHostStays' }
  if (target.userId === userId) return leaveSeat(match, userId)
  return { seats: [emptied(target)], ...(target.userId !== undefined && captainAfter(match, target.userId)) }
}

/** The team's captain puts a robot in an empty seat, when the settings allow robots (補機器人) */
export function robotSeat(match: TeamMatch, userId: string, at: MatchSeat, now: number): FlowError | SeatChange {
  const denied = beforeStart(match)
  if (denied) return denied
  if (!match.settings.robots) return { error: 'matchNoRobots' }
  if (arrangerOf(match, teamOf(at)) !== userId) return { error: 'matchNotCaptain' }
  if (seatAt(match, at).status !== 'empty') return { error: 'matchSeatTaken' }
  return { seats: [{ ...at, status: 'seated', robot: true, answeredAt: now }] }
}
