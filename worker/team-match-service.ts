import type { PublicUser } from '../shared/protocol.ts'
import { parseTeamMatchSettings, type TeamMatchView } from '../shared/team-match.ts'
import { ClubError } from './service.ts'
import { cancelMatch, changeSettings, newTeamMatch, parseHostSeat, type FlowError } from './team-match-flow.ts'
import { TeamMatchStore, type TeamMatch } from './team-matches.ts'
import { teamMatchView } from './views.ts'

/**
 * Team matches over HTTP (ARCHITECTURE.md §5.7, e8-t03): creating one, changing its settings and
 * cancelling it before it starts, and reading them back as each member may see them. It is kept
 * out of `ClubService`, which only builds it and hands it what it needs from the club: the clock,
 * ids, who members are and the per-member rate limit. Like `ClubService` it never touches a
 * Cloudflare API: the matches are in `Store.sql` through `TeamMatchStore`.
 */

export interface TeamMatchDeps {
  now: () => number
  newId: () => string
  /** A member or robot as others see them; undefined for an account that no longer exists */
  userById: (id: string) => PublicUser | undefined
  /** Takes one action from the member's rate limit (AC-11.7); false when they are over it */
  takeAction: (userId: string) => boolean
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
    throw new ClubError(step.error, step.params ?? {}, step.error === 'matchHostOnly' ? 403 : 400)
  }

  /** The match, or `matchGone` for one that does not exist or the member may not see (not told apart) */
  private require(id: string, userId: string): TeamMatch {
    const match = this.store.get(id)
    if (!match || !teamMatchView(match, userId, this.deps.userById)) throw new ClubError('matchGone', {}, 404)
    return match
  }

  private view(id: string, userId: string): TeamMatchView {
    return teamMatchView(this.store.get(id)!, userId, this.deps.userById)!
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
    })
    return this.view(id, userId)
  }

  /** The host calls the match off before the start (`POST /api/matches/:id/cancel`) */
  cancel(userId: string, id: string): TeamMatchView {
    this.limit(userId)
    const match = this.require(id, userId)
    const step = cancelMatch(match, userId)
    if ('error' in step) this.fail(step)
    this.store.setStatus(id, 'cancelled', this.deps.now())
    return this.view(id, userId)
  }

  /** The matches a member hosts or has a seat in, newest first (`GET /api/matches`) */
  list(userId: string): TeamMatchView[] {
    return this.store.idsOf(userId).flatMap((id) => {
      const match = this.store.get(id)
      const view = match && teamMatchView(match, userId, this.deps.userById)
      return view ? [view] : []
    })
  }

  /** One match as the member may see it (`GET /api/matches/:id`), null if they may not */
  get(id: string, userId: string): TeamMatchView | null {
    const match = this.store.get(id)
    return match && teamMatchView(match, userId, this.deps.userById)
  }
}
