import { parseClientMessage } from '../shared/message-guard.ts'
import type { MessageCode } from '../shared/messages.ts'
import type { ClientMessage, NotificationKind, PublicUser, ServerMessage } from '../shared/protocol.ts'
import { arrangerOf, parseTeamMatchSettings, teamAt, type MatchSeat, type TeamMatchView } from '../shared/team-match.ts'
import { ClubError } from './service.ts'
import {
  answerSeat,
  cancelMatch,
  changeSettings,
  clearSeat,
  inviteToSeat,
  leaveSeat,
  matchReady,
  moveSeat,
  newTeamMatch,
  parseHostSeat,
  parseMatchSeat,
  robotSeat,
  type FlowError,
  type SeatChange,
} from './team-match-flow.ts'
import { TeamMatchStore, type TeamMatch } from './team-matches.ts'
import { teamMatchView } from './views.ts'

/**
 * Team matches (ARCHITECTURE.md §5.8): creating one, changing its settings and cancelling it
 * before it starts (e8-t03), its seats — invitations, answers, moving, leaving, robots and the
 * captains (e8-t04, e8-t05) — and reading them back as each member may see them. It is kept out of
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
  notify: (userId: string, kind: NotificationKind, params: Record<string, string | number>) => Promise<unknown>
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

  /**
   * The match as the member may see it, with who is online in each seat and, while it is set up,
   * whether the host can start (`matchReady`); null if they may not see it
   */
  private viewOf(match: TeamMatch, userId: string, online = this.online()): TeamMatchView | null {
    const view = teamMatchView(match, userId, this.deps.userById)
    if (!view) return null
    return {
      ...view,
      seats: view.seats.map((s) => (s.userId !== undefined && !s.robot ? { ...s, online: online.has(s.userId) } : s)),
      ...(match.status === 'setup' && { ready: matchReady(match, (id) => online.has(id)) }),
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
   * `before` who may no longer see it (they left, declined or were taken off)
   */
  private push(id: string, before: string[] = []) {
    const { send } = this.deps
    const match = this.store.get(id)
    if (!match) return
    const online = this.online()
    for (const userId of new Set([...before, ...this.players(match)]))
      if (online.has(userId)) send(userId, { type: 'match', matchId: id, match: this.viewOf(match, userId, online) })
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

  /** The matches a member hosts or has a seat in, newest first (`GET /api/matches`) */
  list(userId: string): TeamMatchView[] {
    const online = this.online()
    return this.store.idsOf(userId).flatMap((id) => {
      const match = this.store.get(id)
      const view = match && this.viewOf(match, userId, online)
      return view ? [view] : []
    })
  }

  /** One match as the member may see it (`GET /api/matches/:id`), null if they may not */
  get(id: string, userId: string): TeamMatchView | null {
    const match = this.store.get(id)
    return match && this.viewOf(match, userId)
  }
}
