import { parseClientMessage } from '../shared/message-guard.ts'
import type { MessageCode } from '../shared/messages.ts'
import type { ClientMessage, NotificationKind, PublicUser, ServerMessage } from '../shared/protocol.ts'
import type { DealSet } from '../shared/deal-set.ts'
import {
  arrangerOf,
  parseTeamMatchSettings,
  ROOMS,
  teamAt,
  type MatchRoomClock,
  type MatchSeat,
  type Room,
  type TeamMatchView,
} from '../shared/team-match.ts'
import type { EventBoard } from './history-index.ts'
import { ClubError } from './service.ts'
import {
  abandonMatch,
  answerSeat,
  cancelMatch,
  changeSettings,
  clearSeat,
  inviteToSeat,
  leaveSeat,
  matchMembers,
  matchReady,
  moveSeat,
  finishedWithRuling,
  newTeamMatch,
  parseHostSeat,
  parseMatchSeat,
  pauseMatch,
  replaceSeat,
  robotSeat,
  roomFinished,
  ruleBoard,
  sitInFor,
  startMatch,
  type FlowError,
  type RoomClock,
  type SeatChange,
} from './team-match-flow.ts'
import { TeamMatchStore, type RoomResult, type TeamMatch } from './team-matches.ts'
import { teamMatchView } from './views.ts'

/**
 * Team matches (ARCHITECTURE.md §5.8): creating one, changing its settings and cancelling it
 * before it starts (e8-t03), its seats — invitations, answers, moving, leaving, robots and the
 * captains (e8-t04, e8-t05) — starting it and the rooms' results as they come in (e8-t07–e8-t11),
 * and reading them back as each member may see them. It is kept out of
 * `ClubService`, which only builds it and hands it what it needs from the club: the clock, ids,
 * who members are, blocks, who is online, notifications, the socket and the per-member rate limit.
 * Like `ClubService` it never touches a Cloudflare API: the matches are in `Store.sql` through
 * `TeamMatchStore`. Every change is pushed to the match's members who are online (`match`).
 */

export interface TeamMatchDeps {
  now: () => number
  newId: () => string
  /** A member or robot as others see them; undefined for an account that no longer exists */
  userById: (id: string) => PublicUser | undefined
  /** Takes one action from the member's rate limit (AC-11.7); false when they are over it */
  takeAction: (userId: string) => boolean
  /** Whether `id` is a member's account (not a robot, not deleted) */
  isMember: (id: string) => boolean
  /** Whether `by` blocked `other` */
  blocked: (by: string, other: string) => boolean
  /** The members with a socket open now */
  online: () => string[]
  /** Sends a socket message to a member who is online */
  send: (userId: string, message: ServerMessage) => void
  /** Everyone at the match's two tables (seated or watching), who see its score too */
  watchers: (matchId: string) => string[]
  /**
   * The match's two tables as the club's directory has them: where each room is (the host's
   * rulings, `e8-t15`) and the members a robot sits in for (代打, `e8-t14`)
   */
  live: (matchId: string) => { rooms: Partial<Record<Room, RoomClock>>; sittingIn: string[] }
  /** The match's boards in the history index: contract and tricks for the result page (`e8-t12`) */
  boardDetails: (matchId: string) => Map<string, EventBoard>
  notify: (userId: string, kind: NotificationKind, params: Record<string, string | number>) => Promise<unknown>
  /** Whether the member may set TKB up in the club's system (`tkuSystem`, ROBOT.md §7) */
  mayUseTku: (userId: string) => boolean
}

/** What the host (替補 also a captain) does while the match is played (`e8-t14`–`e8-t16`) */
export type MatchPlayAction = Extract<
  ClientMessage,
  { type: 'matchRule' | 'matchPause' | 'matchAbandon' | 'matchReplace' | 'matchSitIn' }
>

/** What the board's seat was before a substitute came in, and who is in the match now (`e8-t16`) */
export interface Replaced {
  matchId: string
  room: Room
  seat: MatchSeat['seat']
  newcomer: string
  /** The member who sat there, if any (not a robot) */
  before?: string
  players: Record<Room, string[]>
}

/** The seat actions, over the socket or `POST /api/matches/:id/<action>` */
export type MatchAction = Extract<
  ClientMessage,
  { type: 'matchInvite' | 'matchAnswer' | 'matchMove' | 'matchLeave' | 'matchClear' | 'matchRobot' }
>

const STATUS: Partial<Record<MessageCode, number>> = {
  matchHostOnly: 403,
  matchNotCaptain: 403,
  cannotInvite: 403,
  matchGone: 404,
  userGone: 404,
  matchNoWatching: 403,
}

/** What views of a match need from the club: who is online, the boards' rows in the index, the tables */
interface ViewContext {
  online: Set<string>
  details?: Map<string, EventBoard>
  live?: ReturnType<TeamMatchDeps['live']>
}

export class TeamMatchService {
  readonly store: TeamMatchStore
  private readonly deps: TeamMatchDeps

  constructor(store: TeamMatchStore, deps: TeamMatchDeps) {
    this.store = store
    this.deps = deps
  }

  private limit(userId: string) {
    if (!this.deps.takeAction(userId)) throw new ClubError('slowDown', {}, 429)
  }

  private fail(step: FlowError): never {
    throw new ClubError(step.error, step.params ?? {}, STATUS[step.error] ?? 400)
  }

  /** The match, or `matchGone` for one that does not exist or the member may not see (not told apart) */
  private require(id: unknown, userId: string): TeamMatch {
    const match = typeof id === 'string' ? this.store.get(id) : null
    if (!match || !teamMatchView(match, userId, this.deps.userById)) throw new ClubError('matchGone', {}, 404)
    return match
  }

  private online(): Set<string> {
    return new Set(this.deps.online())
  }

  /** What every member's view of a match needs from the club, worked out once for all of them */
  private context(match: TeamMatch, online = this.online()): ViewContext {
    return {
      online,
      ...(match.boards.length > 0 && { details: this.deps.boardDetails(match.id) }),
      ...(match.status === 'playing' && { live: this.deps.live(match.id) }),
    }
  }

  /**
   * The match as the member may see it, with who is online in each seat and, while it is set up,
   * whether the host can start (`matchReady`); while it is played, who a robot sits in for (代打)
   * and, for the host, where each room is and when its board's time is up (`e8-t15`). Null if they
   * may not see it
   */
  private viewOf(match: TeamMatch, userId: string, ctx = this.context(match)): TeamMatchView | null {
    const view = teamMatchView(match, userId, this.deps.userById, ctx.details)
    if (!view) return null
    const { online, live } = ctx
    const limit = match.settings.boardMinutes * 60_000
    const clock = (room: Room): MatchRoomClock => {
      const r = live?.rooms[room]
      return {
        seq: r?.seq ?? null,
        playing: !!r?.playing,
        ...(r?.playing && limit > 0 && r.startedAt !== undefined && { endsAt: r.startedAt + limit }),
      }
    }
    return {
      ...view,
      seats: view.seats.map((s) =>
        s.userId !== undefined && !s.robot
          ? { ...s, online: online.has(s.userId), ...(live?.sittingIn.includes(s.userId) && { substitute: true }) }
          : s,
      ),
      ...(match.status === 'setup' && { ready: matchReady(match, (id) => online.has(id)) }),
      ...(live && match.hostId === userId && { rooms: Object.fromEntries(ROOMS.map((room) => [room, clock(room)])) as Record<Room, MatchRoomClock> }),
    }
  }

  private view(id: string, userId: string): TeamMatchView {
    return this.viewOf(this.store.get(id)!, userId)!
  }

  /** Everyone the match is about: the host and whoever is invited to or sitting in a seat */
  private players(match: TeamMatch): string[] {
    return [...new Set([match.hostId, ...match.seats.flatMap((s) => (s.userId === undefined ? [] : [s.userId]))])]
  }

  /**
   * Pushes the match as each of its members now sees it to those online, and `null` to those in
   * `before` who may no longer see it (they left, declined or were taken off). While it is played,
   * everyone watching one of its tables gets it too: the score bar above the table (`e8-t10`)
   */
  push(id: string, before: string[] = []) {
    const { send } = this.deps
    const match = this.store.get(id)
    if (!match) return
    const ctx = this.context(match)
    const watching = match.status === 'setup' || match.status === 'cancelled' ? [] : this.deps.watchers(id)
    for (const userId of new Set([...before, ...this.players(match), ...watching]))
      if (ctx.online.has(userId)) send(userId, { type: 'match', matchId: id, match: this.viewOf(match, userId, ctx) })
  }

  /** A member came online or went away: their open matches being set up change readiness */
  presence(userId: string) {
    for (const id of this.store.idsOf(userId))
      if (this.store.get(id)?.status === 'setup') this.push(id)
  }

  private async notify(userId: string, kind: NotificationKind, matchId: string, by: string) {
    await this.deps.notify(userId, kind, { matchId, username: this.deps.userById(by)?.username ?? '' })
  }

  /**
   * Creates a match (`POST /api/matches`): optional settings (`parseTeamMatchSettings`) and the
   * host's seat, one of team A's (default the open room's South). A member hosts one open match at
   * a time (`matchOpen`)
   */
  create(userId: string, body: { settings?: unknown; seat?: unknown }): TeamMatchView {
    this.limit(userId)
    const parsed = parseTeamMatchSettings(body.settings)
    if ('field' in parsed) throw new ClubError('badMatchSettings', { field: parsed.field })
    if (parsed.settings.robotKind === 'tku' && !this.deps.mayUseTku(userId)) throw new ClubError('tkuSystemOnly', {}, 403)
    const seat = parseHostSeat(body.seat)
    if (!seat) throw new ClubError('badMatchSettings', { field: 'seat' })
    if (this.store.openHostedBy(userId).length) throw new ClubError('matchOpen')
    const match = newTeamMatch({ id: this.deps.newId(), hostId: userId, now: this.deps.now(), settings: parsed.settings, seat })
    this.store.create(match)
    return this.view(match.id, userId)
  }

  /** The host changes settings before the start (`POST /api/matches/:id/settings`) */
  update(userId: string, id: string, settings: unknown): TeamMatchView {
    this.limit(userId)
    const match = this.require(id, userId)
    const step = changeSettings(match, userId, settings)
    if ('error' in step) this.fail(step)
    // A match set up with the club's robots keeps them; switching to them needs `tkuSystem`
    if (step.settings.robotKind === 'tku' && match.settings.robotKind !== 'tku' && !this.deps.mayUseTku(userId))
      throw new ClubError('tkuSystemOnly', {}, 403)
    this.store.transaction(() => {
      this.store.setSettings(id, step.settings)
      for (const seat of step.freed) this.store.updateSeat(id, { ...seat, status: 'empty', robot: false })
      if (step.captainB !== undefined) this.store.setCaptainB(id, step.captainB)
    })
    this.push(id)
    return this.view(id, userId)
  }

  /** The host calls the match off before the start (`POST /api/matches/:id/cancel`); everyone in a seat is told */
  async cancel(userId: string, id: string): Promise<TeamMatchView> {
    this.limit(userId)
    const match = this.require(id, userId)
    const step = cancelMatch(match, userId)
    if ('error' in step) this.fail(step)
    this.store.setStatus(id, 'cancelled', this.deps.now())
    for (const other of this.players(match)) if (other !== userId) await this.notify(other, 'matchCancelled', id, userId)
    this.push(id)
    return this.view(id, userId)
  }

  /**
   * The match the host may start now (`e8-t07`): theirs, being set up, every seat taken and every
   * member online (`matchReady`); otherwise the reason it cannot start. The club opens the tables
   */
  startable(userId: string, id: unknown): TeamMatch {
    const match = this.require(id, userId)
    const online = this.online()
    const step = startMatch(match, userId, (member) => online.has(member))
    if ('error' in step) this.fail(step)
    return match
  }

  /** The match's two tables are open: it is being played. Everyone in it but the host is told, and sees it */
  async started(id: string, deals: DealSet, tables: Record<Room, string>) {
    const match = this.store.get(id)!
    this.store.setStarted(id, deals, tables, this.deps.now())
    for (const userId of matchMembers(match))
      if (userId !== match.hostId) await this.notify(userId, 'matchStarted', id, match.hostId)
    this.push(id)
  }

  /**
   * A room finished a board (`e8-t08`, `e8-t10`): its result is written once (the same report
   * again, or one for a match no longer played, changes nothing and answers null). Answers the
   * board's two records once both rooms played it (to be shown to everyone), and whether that was
   * the match's last board
   */
  addResult(id: string, seq: number, room: Room, result: RoomResult): { reveal: string[]; finished: boolean } | null {
    const match = this.store.get(id)
    const outcome = match && roomFinished(match, seq, room, result)
    if (!outcome) return null
    this.store.addResult(id, seq, room, result)
    const board = this.store.get(id)!.boards.find((b) => b.seq === seq)
    const reveal = outcome.complete && board?.open && board.closed ? [board.open.boardId, board.closed.boardId] : []
    return { reveal, finished: outcome.finished }
  }

  /** Every board of the match is done (`e8-t11`): it is finished, and everyone in it is told to come and see the result */
  async finish(id: string) {
    const match = this.store.get(id)
    if (match?.status !== 'playing') return
    this.store.setStatus(id, 'finished', this.deps.now())
    for (const userId of matchMembers(match)) await this.deps.notify(userId, 'matchFinished', { matchId: id })
  }

  // ── While it is played (e8-t14–e8-t16): the club tells the tables ────────────────────────────

  /**
   * The host rules on a board (`e8-t15`): checked against where the rooms are (`ruleBoard`) and
   * kept with its reason. Answers the board, the records of it to show to everyone now (the board
   * is done) and whether that was the match's last board
   */
  rule(userId: string, message: Extract<MatchPlayAction, { type: 'matchRule' }>): { seq: number; reveal: string[]; finished: boolean } {
    const match = this.require(message.matchId, userId)
    const step = ruleBoard(match, userId, message, this.deps.live(match.id).rooms, this.deps.now())
    if ('error' in step) this.fail(step)
    const finished = finishedWithRuling(match, step.seq)
    this.store.setRuling(match.id, step.seq, { ...step.ruling, reason: step.reason, by: userId, at: this.deps.now() })
    const board = this.store.get(match.id)!.boards.find((b) => b.seq === step.seq)
    const reveal = [board?.open?.boardId, board?.closed?.boardId].filter((id): id is string => id !== undefined)
    return { seq: step.seq, reveal, finished }
  }

  /** The host pauses or resumes (`e8-t16`); answers whether that changed anything */
  pause(userId: string, matchId: unknown, paused: boolean): { matchId: string; changed: boolean } {
    const match = this.require(matchId, userId)
    const step = pauseMatch(match, userId, paused)
    if ('error' in step) this.fail(step)
    if (step.changed) this.store.setPaused(match.id, paused ? this.deps.now() : null)
    return { matchId: match.id, changed: step.changed }
  }

  /** The host abandons a paused match (`e8-t16`): it ends here, its scored boards kept; everyone in it is told */
  async abandon(userId: string, matchId: unknown): Promise<string> {
    const match = this.require(matchId, userId)
    const step = abandonMatch(match, userId)
    if ('error' in step) this.fail(step)
    this.store.transaction(() => {
      this.store.setPaused(match.id, null)
      this.store.setStatus(match.id, 'abandoned', this.deps.now())
    })
    for (const other of matchMembers(match)) if (other !== userId) await this.notify(other, 'matchAbandoned', match.id, userId)
    return match.id
  }

  /**
   * A substitute takes a seat (替補, `e8-t16`): the host or the team's captain, while paused; the
   * newcomer must be a member, not in the match, not playing another, and neither they nor the
   * one arranging (or the host) blocked the other. The club has already checked they are not
   * watching the match. They and whoever left the seat are told
   */
  async replace(userId: string, message: Extract<MatchPlayAction, { type: 'matchReplace' }>): Promise<Replaced> {
    const match = this.require(message.matchId, userId)
    const at = parseMatchSeat({ room: message.room, seat: message.seat })
    if (!at) throw new ClubError('badSeat')
    const newcomer = message.userId
    if (typeof newcomer !== 'string' || (newcomer !== userId && !this.deps.isMember(newcomer))) throw new ClubError('userGone', {}, 404)
    const step = replaceSeat(match, userId, at, newcomer, this.deps.now())
    if ('error' in step) this.fail(step)
    const { blocked } = this.deps
    if ([userId, match.hostId].some((id) => blocked(newcomer, id) || blocked(id, newcomer)))
      throw new ClubError('cannotInvite', { name: this.deps.userById(newcomer)?.username ?? '' }, 403)
    if (this.store.playingIdOf(newcomer))
      throw new ClubError('matchPlayerBusy', { name: this.deps.userById(newcomer)?.username ?? '' })
    const target = match.seats.find((s) => s.room === at.room && s.seat === at.seat)!
    const before = !target.robot ? target.userId : undefined
    this.store.transaction(() => {
      for (const seat of step.seats) this.store.updateSeat(match.id, seat)
      if (before !== undefined && match.captains.B === before) this.store.setCaptainB(match.id, newcomer)
    })
    await this.notify(newcomer, 'matchSubIn', match.id, userId)
    if (before !== undefined && before !== userId) await this.notify(before, 'matchRemoved', match.id, userId)
    const now = this.store.get(match.id)!
    const players = Object.fromEntries(
      ROOMS.map((room) => [room, now.seats.flatMap((s) => (s.room === room && !s.robot && s.userId !== undefined ? [s.userId] : []))]),
    ) as Record<Room, string[]>
    return { matchId: match.id, room: at.room, seat: at.seat, newcomer, ...(before !== undefined && { before }), players }
  }

  /** The host has a robot sit in for a member (代打, `e8-t14`); answers the seat */
  sitIn(userId: string, message: Extract<MatchPlayAction, { type: 'matchSitIn' }>): { matchId: string; at: MatchSeat } {
    const match = this.require(message.matchId, userId)
    const at = parseMatchSeat({ room: message.room, seat: message.seat })
    if (!at) throw new ClubError('badSeat')
    const step = sitInFor(match, userId, at)
    if ('error' in step) this.fail(step)
    return { matchId: match.id, at }
  }

  /** The match a member is playing now, if any (§5.8) */
  playingOf(userId: string): TeamMatch | null {
    const id = this.store.playingIdOf(userId)
    return id ? this.store.get(id) : null
  }

  /**
   * A seat action (`e8-t04`, `e8-t05`), from the socket (rate-limited there) or `request`. Checks
   * who may (`team-match-flow.ts`), writes the seats and team B's captain in one transaction, tells
   * whom it concerns through the notification centre and pushes the match
   */
  async act(userId: string, message: MatchAction): Promise<string> {
    const match = this.require(message.matchId, userId)
    const now = this.deps.now()
    const seatOf = (value: unknown) => {
      const seat = parseMatchSeat(value)
      if (!seat) throw new ClubError('badSeat')
      return seat
    }
    const notices: { to: string; kind: NotificationKind }[] = []
    /** Whom an answer or a departure from a seat is news to: the captain who arranges that team, or the host */
    const captainFor = (at: MatchSeat) => {
      const captain = arrangerOf(match, teamAt(at.room, at.seat))
      return captain === userId ? match.hostId : captain
    }
    let step: FlowError | SeatChange
    switch (message.type) {
      case 'matchInvite': {
        const at = seatOf({ room: message.room, seat: message.seat })
        const invitee = message.userId
        if (typeof invitee !== 'string' || (invitee !== userId && !this.deps.isMember(invitee)))
          throw new ClubError('userGone', {}, 404)
        step = inviteToSeat(match, userId, at, invitee, now)
        if ('error' in step) break
        // Whether the invitee blocked the inviter (or the host) stays private: only that they cannot be invited
        const { blocked } = this.deps
        if ([userId, match.hostId].some((id) => blocked(invitee, id) || blocked(id, invitee)))
          throw new ClubError('cannotInvite', { name: this.deps.userById(invitee)?.username ?? '' }, 403)
        notices.push({ to: invitee, kind: 'matchInvited' })
        break
      }
      case 'matchAnswer': {
        if (typeof message.accept !== 'boolean') throw new ClubError('unknownCommand')
        step = answerSeat(match, userId, message.accept, now)
        const mine = match.seats.find((s) => s.userId === userId)
        if (!('error' in step) && mine) notices.push({ to: captainFor(mine), kind: message.accept ? 'matchAccepted' : 'matchDeclined' })
        break
      }
      case 'matchMove':
        step = moveSeat(match, userId, seatOf(message.from), seatOf(message.to))
        break
      case 'matchLeave': {
        step = leaveSeat(match, userId)
        const mine = match.seats.find((s) => s.userId === userId)
        if (!('error' in step) && mine)
          notices.push({ to: captainFor(mine), kind: mine.status === 'invited' ? 'matchDeclined' : 'matchLeft' })
        break
      }
      case 'matchClear': {
        const at = seatOf({ room: message.room, seat: message.seat })
        step = clearSeat(match, userId, at)
        const target = match.seats.find((s) => s.room === at.room && s.seat === at.seat)
        if (!('error' in step) && target?.userId !== undefined && target.userId !== userId)
          notices.push({ to: target.userId, kind: 'matchRemoved' })
        break
      }
      case 'matchRobot':
        step = robotSeat(match, userId, seatOf({ room: message.room, seat: message.seat }), now)
        break
      default:
        throw new ClubError('unknownCommand')
    }
    if ('error' in step) this.fail(step)
    const change = step
    this.store.transaction(() => {
      for (const seat of change.seats) this.store.updateSeat(match.id, seat)
      if (change.captainB !== undefined) this.store.setCaptainB(match.id, change.captainB)
    })
    for (const { to, kind } of notices) if (to !== userId) await this.notify(to, kind, match.id, userId)
    this.push(match.id, this.players(match))
    return match.id
  }

  /**
   * A seat action over HTTP (`POST /api/matches/:id/<action>`): the same shape checks and rate
   * limit as a socket message, and the page hears back at once with the match as the member now
   * sees it (null once they may not: they declined or left)
   */
  async request(userId: string, message: MatchAction): Promise<TeamMatchView | null> {
    const parsed = parseClientMessage(JSON.stringify(message))
    if ('error' in parsed) throw new ClubError(parsed.error)
    this.limit(userId)
    const id = await this.act(userId, parsed.message as MatchAction)
    return this.get(id, userId)
  }

  /**
   * The matches a member hosts or has a seat in, newest first (`GET /api/matches`). Cancelled ones
   * are left out: they never happened. Their prep room stays reachable by its link (`get`)
   */
  list(userId: string): TeamMatchView[] {
    const online = this.online()
    return this.store.idsOf(userId).flatMap((id) => {
      const match = this.store.get(id)
      const view = match && match.status !== 'cancelled' && this.viewOf(match, userId, { online })
      return view ? [view] : []
    })
  }

  /** One match as the member may see it (`GET /api/matches/:id`), null if they may not */
  get(id: string, userId: string): TeamMatchView | null {
    const match = this.store.get(id)
    return match && this.viewOf(match, userId)
  }
}
