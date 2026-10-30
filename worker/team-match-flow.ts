import type { MessageCode } from '../shared/messages.ts'
import {
  arrangerOf,
  MATCH_SEATS,
  parseRulingReason,
  parseTeamMatchSettings,
  segmentCount,
  segmentRange,
  TEAM_MATCH_LIMITS,
  teamAt,
  type MatchSeat,
  type NotReady,
  type Room,
  type TeamMatchSettings,
} from '../shared/team-match.ts'
import { RULINGS, TEAMS, type Ruling, type RulingKind, type Team } from '../shared/team-scoring.ts'
import type { RoomResult, TeamMatch, TeamMatchBoard, TeamMatchSeat } from './team-matches.ts'

/**
 * The steps of a team match before it starts (ARCHITECTURE.md §5.8, e8-t03), as pure functions:
 * `TeamMatchService` checks who is asking, calls these, and writes what they return. Seats and
 * captains are F3 (`e8-t04`, `e8-t05`); starting and the rooms' results are F4 (`e8-t07`–`e8-t11`).
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

/** The members with a seat in the match (not robots), in seat order */
export const matchMembers = (match: TeamMatch): string[] =>
  match.seats.flatMap((s) => (s.userId !== undefined && !s.robot ? [s.userId] : []))

// ── Playing (e8-t07, e8-t08, e8-t10, e8-t11) ─────────────────────────────────────────────────

/** The host starts the match (`e8-t07`): only the host, only while setting up, and only when it is ready (`matchReady`) */
export function startMatch(match: TeamMatch, userId: string, online: (userId: string) => boolean): FlowError | { ok: true } {
  const denied = hostBeforeStart(match, userId)
  if (denied) return denied
  if (!matchReady(match, online).ready) return { error: 'matchNotReady' }
  return { ok: true }
}

/** Whether a board is done: both rooms played it, or the host ruled on it (the ruling counts, §5.8) */
const boardDone = (board: TeamMatchBoard | undefined) => !!board && ((!!board.open && !!board.closed) || !!board.ruling)

/** The segment being played (`e8-t21`): 1 for a match without segments */
export const currentSegment = (match: TeamMatch): number => match.segment ?? 1

/**
 * Where the match is once its boards are `boards`: every board done (`finished`), or every board
 * of the segment being played done with another segment to come (`segmentDone`, `e8-t21`: both
 * rooms stop and the match waits between segments)
 */
function progress(match: TeamMatch, boards: TeamMatchBoard[]): { finished: boolean; segmentDone: boolean } {
  const done = (first: number, last: number) =>
    Array.from({ length: last - first + 1 }, (_, i) => first + i).every((n) => boardDone(boards.find((b) => b.seq === n)))
  const finished = done(1, match.settings.boards)
  const segment = currentSegment(match)
  const { first, last } = segmentRange(match.settings, segment)
  return { finished, segmentDone: !finished && segment < segmentCount(match.settings) && done(first, last) }
}

/**
 * One room finished a board (`e8-t08`, `e8-t10`): null when it does not count — the match is not
 * being played, the board is not one of it, or that room already has a result there (each room
 * plays a board once; the same report sent again changes nothing). Otherwise what it means: whether
 * the board now has both rooms' results (`complete`: its two records are shown to everyone), and
 * whether every board of the match is done (`finished`, `e8-t11`)
 */
export function roomFinished(
  match: TeamMatch,
  seq: number,
  room: 'open' | 'closed',
  result: RoomResult,
): { complete: boolean; finished: boolean; segmentDone: boolean } | null {
  if (match.status !== 'playing' || !Number.isInteger(seq) || seq < 1 || seq > match.settings.boards) return null
  const before = match.boards.find((b) => b.seq === seq)
  if (before?.[room]) return null
  const board: TeamMatchBoard = { ...before, seq, [room]: result }
  const boards = match.boards.filter((b) => b.seq !== seq).concat(board)
  return { complete: !!board.open && !!board.closed, ...progress(match, boards) }
}

// ── Exceptions while playing (e8-t14–e8-t16) ─────────────────────────────────────────────────

/** Only the host, only while the match is played */
function hostWhilePlaying(match: TeamMatch, userId: string): FlowError | null {
  if (match.hostId !== userId) return { error: 'matchHostOnly' }
  if (match.status !== 'playing') return { error: 'matchNotPlaying' }
  return null
}

/** Where a room is, as the host's ruling needs it: the board on its table, whether it is being played, and since when */
export interface RoomClock {
  seq: number | null
  playing: boolean
  startedAt?: number
}

/**
 * The host rules on a board (`e8-t15`, AC-8.6): Avg, Avg+ or Avg- for a team, with a reason.
 * Only a board being played in a room past the time limit (as of the pause, while paused), or one
 * ruled on already (the host changes the ruling). The ruling stands for the board whatever the
 * rooms do after (§5.8): a room still playing it puts it away and goes on
 */
export function ruleBoard(
  match: TeamMatch,
  userId: string,
  input: { seq: unknown; ruling: unknown; team: unknown; reason: unknown },
  rooms: Partial<Record<Room, RoomClock>>,
  now: number,
): FlowError | { seq: number; ruling: Ruling; reason: string } {
  const denied = hostWhilePlaying(match, userId)
  if (denied) return denied
  const seq = input.seq
  const reason = parseRulingReason(input.reason)
  const bad: FlowError = { error: 'badRuling', params: { max: TEAM_MATCH_LIMITS.reasonMax } }
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1 || seq > match.settings.boards) return bad
  if (!RULINGS.includes(input.ruling as RulingKind) || !TEAMS.includes(input.team as Team) || reason === null) return bad
  const ruled = !!match.boards.find((b) => b.seq === seq)?.ruling
  const limit = match.settings.boardMinutes * 60_000
  const clockNow = match.pausedAt ?? now
  const overTime = Object.values(rooms).some(
    (r) => !!r && r.seq === seq && r.playing && limit > 0 && r.startedAt !== undefined && clockNow - r.startedAt >= limit,
  )
  if (!ruled && !overTime) return { error: 'matchNotOverTime' }
  return { seq, ruling: { kind: input.ruling as RulingKind, team: input.team as Team }, reason }
}

/** Whether every board of the match (`e8-t11`), or of the segment (`e8-t21`), is done once `seq` is ruled on */
export function finishedWithRuling(match: TeamMatch, seq: number): { finished: boolean; segmentDone: boolean } {
  const ruling: TeamMatchBoard['ruling'] = { kind: 'avg', team: 'A', reason: '', by: '', at: 0 }
  const board: TeamMatchBoard = { ...match.boards.find((b) => b.seq === seq), seq, ruling }
  return progress(match, match.boards.filter((b) => b.seq !== seq).concat(board))
}

/**
 * The host starts the next segment (`e8-t21`, AC-8.9): only while the match waits between
 * segments. Answers the segment and its boards; the seats are as the captains left them
 */
export function nextSegment(match: TeamMatch, userId: string): FlowError | { segment: number; first: number; last: number } {
  const denied = hostWhilePlaying(match, userId)
  if (denied) return denied
  if (match.breakAt === undefined) return { error: 'matchNotBreak' }
  const segment = currentSegment(match) + 1
  return { segment, ...segmentRange(match.settings, segment) }
}

/** Whether the match is played and waits between segments (`e8-t21`) */
export const betweenSegments = (match: TeamMatch) => match.status === 'playing' && match.breakAt !== undefined

/** The host pauses or resumes both rooms (`e8-t16`); `changed` is false when it already is that way */
export function pauseMatch(match: TeamMatch, userId: string, paused: boolean): FlowError | { changed: boolean } {
  return hostWhilePlaying(match, userId) ?? { changed: paused !== (match.pausedAt !== undefined) }
}

/** The host stops a match for good (`abandoned`, §5.8): it has to be paused first (or between segments) */
export function abandonMatch(match: TeamMatch, userId: string): FlowError | { ok: true } {
  const denied = hostWhilePlaying(match, userId)
  if (denied) return denied
  if (match.pausedAt === undefined && match.breakAt === undefined) return { error: 'matchPauseFirst' }
  return { ok: true }
}

/**
 * A member of the club takes a seat as a substitute (替補, `e8-t16`): the host, or the captain who
 * arranges that team, while the match is paused. The seat's team is fixed by its room and
 * direction, so the substitute plays for that team. Not the host's own seat, and not someone
 * already in the match. Whether the member exists, is free and is not watching is the service's
 */
export function replaceSeat(match: TeamMatch, userId: string, at: MatchSeat, newcomer: string, now: number): FlowError | SeatChange {
  if (match.status !== 'playing') return { error: 'matchNotPlaying' }
  if (arrangerOf(match, teamOf(at)) !== userId && match.hostId !== userId) return { error: 'matchNotCaptain' }
  // Paused, or between segments (`e8-t21`)
  if (match.pausedAt === undefined && match.breakAt === undefined) return { error: 'matchPauseFirst' }
  if (seatAt(match, at).userId === match.hostId) return { error: 'matchHostStays' }
  if (newcomer === userId) return { error: 'notSelf' }
  if (isMatchPlayer(match, newcomer)) return { error: 'matchAlreadyIn' }
  return { seats: [{ ...at, status: 'seated', userId: newcomer, robot: false, invitedAt: now, answeredAt: now }] }
}

/** The host has a robot sit in for the member in a seat (代打, `e8-t14`) until they come back */
export function sitInFor(match: TeamMatch, userId: string, at: MatchSeat): FlowError | { memberId: string } {
  const denied = hostWhilePlaying(match, userId)
  if (denied) return denied
  const target = seatAt(match, at)
  if (target.robot || target.userId === undefined) return { error: 'matchNotMember' }
  return { memberId: target.userId }
}

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
 * Seats never move between teams, since the team is the room and the direction. Also between
 * segments (`e8-t21`, 中場換位): a pair may change rooms (team A's North-South of the open room
 * sits East-West in the closed one), which the tables take on when the next segment starts
 */
export function moveSeat(match: TeamMatch, userId: string, from: MatchSeat, to: MatchSeat): FlowError | SeatChange {
  if (match.status !== 'setup' && !betweenSegments(match)) return { error: 'matchStarted' }
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
