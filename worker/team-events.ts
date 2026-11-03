import type { NotificationKind, PublicUser } from '../shared/protocol.ts'
import {
  eventStandings,
  formatFor,
  matchCounts,
  nextPairing,
  roundDone,
  TEAM_EVENT_LIMITS,
  type EventMatchScore,
  type TeamEvent,
  type TeamEventSettings,
  type TeamEventView,
} from '../shared/team-event.ts'
import { ClubError } from './errors.ts'
import { crashEntry, type Logger } from './log.ts'
import type { RankedEvent } from './rankings.ts'
import type { Store } from './store.ts'
import { teamEventView } from './views.ts'

/**
 * Multi-team events (多隊賽, `e9-t14`, AC-9.5, ARCHITECTURE.md §5.26): made from a tournament's
 * entries (§5.24), directed by the admin who started it. Each round pairs the teams (round robin
 * or Swiss, `shared/team-event.ts`) and makes one ordinary team match per pairing (§5.8), every
 * seat taken by the teams' line-ups; the matches are played, scored, refereed (§5.23) and kept
 * where every team match is (the club, or its own `EventObject` with `EVENT_OBJECTS`, H2c). The
 * event itself only changes between rounds, so it is one key (`teamev:<id>`), all of them in
 * memory, like the tournaments. Its standings are worked out whenever they are read, from the
 * matches as they stand. Like the other services it touches no Cloudflare API.
 */

const KEY = 'teamev:'

/** The two line-ups of a round's match: team A's first player hosts (open room South) */
export interface EventMatchInput {
  teamNames: [string, string]
  /** Each four: the open room pair, then the closed room pair */
  lineups: { A: string[]; B: string[] }
  boards: number
  boardMinutes: number
}

export interface TeamEventDeps {
  store: Store
  now: () => number
  newId: () => string
  log: Logger
  isAdmin: (userId: string) => boolean
  /** The member has the `tournaments` flag */
  featureOn: (userId: string) => boolean
  userById: (id: string) => PublicUser | null
  takeAction: (userId: string) => boolean
  notify: (userId: string, kind: NotificationKind, params: Record<string, string | number>) => Promise<unknown>
  /** Makes a round's team match, every seat taken, being set up for its host to start; answers its id */
  createMatch: (input: EventMatchInput) => Promise<string>
  /** Calls off a match just made (a round that could not be made whole) */
  cancelMatch: (matchId: string) => Promise<void>
  /** One match as the event counts it; null when there is none */
  matchScore: (matchId: string) => EventMatchScore | null
  /** The members who sat in a match for each of its teams */
  matchPlayers: (matchId: string) => { A: string[]; B: string[] }
  /** Records the finished event's points and ratings (`RankingsService.record`, once) */
  record: (event: RankedEvent) => void
  /** The event finished: the tournament made it hears (its results announcement) */
  ended: (eventId: string) => Promise<void>
}

export class TeamEventService {
  private readonly deps: TeamEventDeps
  private readonly all = new Map<string, TeamEvent>()
  /** Events a round is being made for: one at a time */
  private readonly busy = new Set<string>()

  constructor(deps: TeamEventDeps) {
    this.deps = deps
  }

  async load() {
    for (const e of (await this.deps.store.list<TeamEvent>(KEY)).values()) this.all.set(e.id, e)
  }

  private async save(e: TeamEvent) {
    this.all.set(e.id, e)
    await this.deps.store.put(KEY + e.id, e)
  }

  private limited(userId: string) {
    if (!this.deps.takeAction(userId)) throw new ClubError('slowDown', {}, 429)
  }

  private inEvent = (e: TeamEvent, userId: string) => e.teams.some((t) => t.players.includes(userId))

  private directs = (e: TeamEvent, userId: string) => e.directorId === userId || this.deps.isAdmin(userId)

  /** The event, or `teamEventGone` for one that does not exist or the member may not see (not told apart) */
  private require(id: unknown, userId: string): TeamEvent {
    const e = typeof id === 'string' ? this.all.get(id) : undefined
    if (!e || !this.mayView(e, userId)) throw new ClubError('teamEventGone', {}, 404)
    return e
  }

  /**
   * Who sees an event: members with the `tournaments` flag (its entries were listed to them), its
   * teams and its director (with or without the flag), admins; a cancelled one only its director and admins
   */
  private mayView(e: TeamEvent, userId: string) {
    if (e.status === 'cancelled') return this.directs(e, userId)
    return this.deps.featureOn(userId) || this.inEvent(e, userId) || this.directs(e, userId)
  }

  private scoreOf = (matchId: string) => this.deps.matchScore(matchId)

  // ── Made from a tournament (`e9-t16`) ──────────────────────────────────────────────────────

  /**
   * A new event from a tournament's teams (3–16, each 4–6, in the order they entered): the format
   * is decided now (round robin when everyone can meet within the most rounds allowed, otherwise
   * Swiss); each team's first four are its line-up until its captain changes it. Nobody plays
   * until the director starts round 1
   */
  async createFrom(directorId: string, settings: TeamEventSettings, teams: { name: string; players: string[] }[], tournamentId?: string): Promise<string> {
    const L = TEAM_EVENT_LIMITS
    if (teams.length < L.teamsMin || teams.length > L.teamsMax) throw new ClubError('tournamentTooFew', { count: teams.length, min: L.teamsMin })
    for (const t of teams) if (t.players.length < L.teamSizeMin || t.players.length > L.teamSizeMax) throw new ClubError('tournamentEntrySize')
    const { format, rounds } = formatFor(teams.length, settings.rounds)
    const event: TeamEvent = {
      id: this.deps.newId(),
      directorId,
      createdAt: this.deps.now(),
      settings,
      format,
      roundsTotal: rounds,
      teams: teams.map((t, i) => ({ id: `t${i + 1}`, name: t.name, players: [...t.players], lineup: t.players.slice(0, 4) })),
      played: [],
      status: 'ready',
      ...(tournamentId !== undefined && { tournamentId }),
    }
    await this.save(event)
    return event.id
  }

  // ── Pages ─────────────────────────────────────────────────────────────────────────────────

  /** `GET /api/team-events/:id`: the event as the member may see it (`views.ts` `teamEventView`) */
  view(id: string, userId: string): TeamEventView {
    const e = this.require(id, userId)
    void this.sync(e.id)
    return this.viewOf(this.all.get(e.id)!, userId)
  }

  private viewOf(e: TeamEvent, userId: string): TeamEventView {
    return teamEventView(e, userId, {
      userById: (id) => this.deps.userById(id),
      directs: this.directs(e, userId),
      scoreOf: this.scoreOf,
    })
  }

  /** Where an event stands, for the tournament made into it; null when there is none */
  statusOf(id: string): TeamEvent['status'] | null {
    return this.all.get(id)?.status ?? null
  }

  /** The event a team match was made for, with its two teams, if any (the match's own rules ask) */
  ofMatch(matchId: string): { event: TeamEvent; teams: { A: string[]; B: string[] } } | null {
    for (const e of this.all.values())
      for (const r of e.played)
        for (const m of r.matches)
          if (m.matchId === matchId) return { event: e, teams: { A: e.teams[m.a].players, B: e.teams[m.b].players } }
    return null
  }

  // ── Captains and the director ────────────────────────────────────────────────────────────

  /**
   * `POST /api/team-events/:id/lineup { team, players }`: who plays the next round, four of the
   * team in seat order (the open room pair, then the closed room pair). The team's captain (its
   * first player), the director or an admin; any time before the event ends, for the rounds made
   * after it
   */
  async setLineup(userId: string, id: string, team: unknown, players: unknown): Promise<TeamEventView> {
    this.limited(userId)
    const e = this.require(id, userId)
    if (e.status === 'finished' || e.status === 'cancelled') throw new ClubError('teamEventOver')
    const t = typeof team === 'number' && Number.isInteger(team) ? e.teams[team] : undefined
    if (!t) throw new ClubError('teamEventBadLineup')
    if (t.players[0] !== userId && !this.directs(e, userId)) throw new ClubError('teamEventCaptainOnly', {}, 403)
    if (
      !Array.isArray(players) ||
      players.length !== 4 ||
      new Set(players).size !== 4 ||
      !players.every((p) => typeof p === 'string' && t.players.includes(p))
    )
      throw new ClubError('teamEventBadLineup')
    const next: TeamEvent = { ...e, teams: e.teams.map((x) => (x === t ? { ...x, lineup: [...(players as string[])] } : x)) }
    await this.save(next)
    return this.viewOf(next, userId)
  }

  /** `POST /api/team-events/:id/cancel`: the director (or an admin) calls it off before round 1; the tournament is open again */
  async cancel(userId: string, id: string): Promise<TeamEventView> {
    this.limited(userId)
    const e = this.require(id, userId)
    if (!this.directs(e, userId)) throw new ClubError('teamEventDirectorOnly', {}, 403)
    if (e.status !== 'ready') throw new ClubError('teamEventStarted')
    const next: TeamEvent = { ...e, status: 'cancelled', cancelledAt: this.deps.now() }
    await this.save(next)
    await this.deps.ended(e.id)
    return this.viewOf(next, userId)
  }

  /**
   * `POST /api/team-events/:id/next`: the director (or an admin) starts the next round once every
   * match of the last one ended: the pairings (`nextPairing`), one team match each with the teams'
   * line-ups in their seats, and every player of the round told (`teamEventRound`) — the team with
   * the bye too. Each match's host starts it in its prep room when all eight are online, as any
   * match. A match that cannot be made calls off the ones made for the round, which is not kept
   */
  async nextRound(userId: string, id: string): Promise<TeamEventView> {
    this.limited(userId)
    const e = this.require(id, userId)
    if (!this.directs(e, userId)) throw new ClubError('teamEventDirectorOnly', {}, 403)
    if (e.status === 'finished' || e.status === 'cancelled') throw new ClubError('teamEventOver')
    const last = e.played.at(-1)
    if (last && !roundDone(last, this.scoreOf)) throw new ClubError('teamEventRoundOn')
    if (e.played.length >= e.roundsTotal) throw new ClubError('teamEventOver')
    if (this.busy.has(e.id)) throw new ClubError('slowDown', {}, 429)
    this.busy.add(e.id)
    try {
      const pairing = nextPairing(e, this.scoreOf)
      const made: string[] = []
      try {
        for (const [a, b] of pairing.pairs) {
          const A = e.teams[a]
          const B = e.teams[b]
          made.push(
            await this.deps.createMatch({
              teamNames: [A.name, B.name],
              lineups: { A: A.lineup, B: B.lineup },
              boards: e.settings.boards,
              boardMinutes: e.settings.boardMinutes,
            }),
          )
        }
      } catch (error) {
        for (const matchId of made) await this.deps.cancelMatch(matchId).catch(() => undefined)
        throw error
      }
      const n = e.played.length + 1
      const round = {
        n,
        matches: pairing.pairs.map(([a, b], i) => ({ a, b, matchId: made[i] })),
        ...(pairing.bye !== undefined && { bye: pairing.bye }),
        at: this.deps.now(),
      }
      const next: TeamEvent = { ...this.all.get(e.id)!, status: 'playing', played: [...e.played, round] }
      await this.save(next)
      const base = { teamEventId: e.id, title: e.settings.title, number: n }
      for (const m of round.matches)
        for (const team of [e.teams[m.a], e.teams[m.b]])
          for (const player of team.players) await this.deps.notify(player, 'teamEventRound', { ...base, matchId: m.matchId })
      if (round.bye !== undefined) for (const player of e.teams[round.bye].players) await this.deps.notify(player, 'teamEventRound', base)
      return this.viewOf(next, userId)
    } finally {
      this.busy.delete(e.id)
    }
  }

  // ── Finishing ────────────────────────────────────────────────────────────────────────────

  /** One of an event's matches ended (the club's `settleMatch`): the event catches up */
  async matchEnded(matchId: string) {
    const found = this.ofMatch(matchId)
    if (found) await this.sync(found.event.id)
  }

  /**
   * The last round over: the event is finished, once. Its points and ratings are recorded with the
   * standings as they are now (the director's penalties and rulings in them), each team one side,
   * its members who sat in at least one of its matches; then the tournament hears
   */
  async sync(id: string) {
    const e = this.all.get(id)
    if (!e || e.status !== 'playing' || e.played.length < e.roundsTotal) return
    try {
      if (!roundDone(e.played.at(-1)!, this.scoreOf)) return
      const next: TeamEvent = { ...e, status: 'finished', finishedAt: this.deps.now() }
      await this.save(next)
      this.deps.record(this.ranked(next))
      await this.deps.ended(e.id)
    } catch (error) {
      this.deps.log(crashEntry('teamEventSync', error))
    }
  }

  /** The finished event for the ledger: each team a side, placed by the standings */
  private ranked(e: TeamEvent): RankedEvent {
    const sat = e.teams.map(() => new Set<string>())
    for (const r of e.played)
      for (const m of r.matches) {
        if (!matchCounts(this.scoreOf(m.matchId))) continue
        const players = this.deps.matchPlayers(m.matchId)
        for (const p of players.A) sat[m.a].add(p)
        for (const p of players.B) sat[m.b].add(p)
      }
    return {
      id: e.id,
      kind: 'teams',
      at: e.finishedAt ?? this.deps.now(),
      sides: eventStandings(e, this.scoreOf).map((s) => ({
        userIds: [...(sat[s.team].size ? sat[s.team] : e.teams[s.team].players)],
        robots: 0,
        rank: s.rank,
      })),
    }
  }

  /** A member's account is deleted: off every team of an event not over (their seats in matches are the matches' own) */
  async forget(userId: string) {
    for (const e of this.all.values()) {
      if (e.status === 'finished' || e.status === 'cancelled' || !this.inEvent(e, userId)) continue
      const teams = e.teams.map((t) => {
        if (!t.players.includes(userId)) return t
        const players = t.players.filter((p) => p !== userId)
        const lineup = t.lineup.includes(userId) ? [...t.lineup.filter((p) => p !== userId), ...players.filter((p) => !t.lineup.includes(p))].slice(0, 4) : t.lineup
        return { ...t, players, lineup }
      })
      await this.save({ ...e, teams })
    }
  }
}
