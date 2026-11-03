import type { NotificationKind, PublicUser } from '../shared/protocol.ts'
import {
  entriesUsed,
  entryComplete,
  entryOf,
  matchSettingsOf,
  pairsFromEntries,
  pairsSettingsOf,
  parseTournamentSettings,
  teamsFromEntries,
  tournamentEventLink,
  tournamentPlayers,
  TOURNAMENT_LIMITS,
  type Tournament,
  type TournamentEntry,
  type TournamentKind,
  type TournamentSettings,
  type TournamentSummary,
  type TournamentView,
} from '../shared/tournament.ts'
import type { PairsSettings } from '../shared/pairs.ts'
import type { TeamMatchSettings } from '../shared/team-match.ts'
import { ClubError } from './errors.ts'
import { crashEntry, type Logger } from './log.ts'
import type { Scheduler } from './scheduler.ts'
import type { Store } from './store.ts'

/**
 * Tournament announcements and entries (比賽公告與報名, `e9-t16`, AC-9.7, ARCHITECTURE.md §5.24).
 * An admin announces one; members with the `tournaments` flag enter alone, with a partner or as a
 * team (each partner confirms), withdraw before the deadline and see who entered; an hour before
 * the start everyone in an entry is reminded; the admin turns the entries into the event (a pairs
 * event or a team match, made through those services as their own pages would); when that event
 * ends everyone in it is told and the page links the results. Each tournament is one key
 * (`tourn:<id>`), all of them kept in memory. Like the other services it touches no Cloudflare API.
 */

const KEY = 'tourn:'

/** Where an event made from a tournament stands, as the tournament needs to know */
export type EventState = 'on' | 'finished' | 'cancelled'

export interface TournamentDeps {
  store: Store
  now: () => number
  newId: () => string
  log: Logger
  scheduler: Scheduler
  isAdmin: (userId: string) => boolean
  /** The member has the `tournaments` flag */
  featureOn: (userId: string) => boolean
  /** Every member's id */
  members: () => string[]
  userById: (id: string) => PublicUser | null
  userByName: (username: string) => string | null
  blocked: (by: string, other: string) => boolean
  takeAction: (userId: string) => boolean
  notify: (userId: string, kind: NotificationKind, params: Record<string, string>) => Promise<unknown>
  /** Makes the pairs event (its director the admin) with these pairs entered, and answers its id */
  createPairs: (directorId: string, settings: PairsSettings, pairs: [string, string][]) => Promise<string>
  /** Makes the team match (hosted by the first team's first player, every other seat invited), and answers its id */
  createMatch: (teams: { name: string; players: string[] }[], settings: Partial<TeamMatchSettings>) => Promise<string>
  /** Where the event stands; null when there is none */
  eventState: (kind: TournamentKind, eventId: string) => EventState | null
}

export class TournamentService {
  private readonly deps: TournamentDeps
  private readonly all = new Map<string, Tournament>()

  constructor(deps: TournamentDeps) {
    this.deps = deps
  }

  async load() {
    for (const t of (await this.deps.store.list<Tournament>(KEY)).values()) this.all.set(t.id, t)
    // Jobs are not stored: each reminder still to come is scheduled again
    for (const t of this.all.values()) this.scheduleReminder(t)
  }

  private async save(t: Tournament) {
    this.all.set(t.id, t)
    await this.deps.store.put(KEY + t.id, t)
  }

  private allowed(userId: string) {
    if (!this.deps.featureOn(userId) && !this.deps.isAdmin(userId)) throw new ClubError('tournamentsOff', {}, 403)
  }

  private admin(userId: string) {
    if (!this.deps.isAdmin(userId)) throw new ClubError('tournamentAdminOnly', {}, 403)
  }

  private limited(userId: string) {
    if (!this.deps.takeAction(userId)) throw new ClubError('slowDown', {}, 429)
  }

  private require(id: unknown): Tournament {
    const t = typeof id === 'string' ? this.all.get(id) : undefined
    if (!t) throw new ClubError('tournamentGone', {}, 404)
    return t
  }

  private open(t: Tournament) {
    if (t.status !== 'open') throw new ClubError('tournamentNotOpen')
  }

  /** Entries and withdrawals close at the deadline */
  private beforeDeadline(t: Tournament) {
    this.open(t)
    if (this.deps.now() >= t.settings.deadline) throw new ClubError('tournamentClosed')
  }

  private name = (userId: string) => this.deps.userById(userId)?.username ?? ''

  private async tell(userIds: Iterable<string>, kind: NotificationKind, t: Tournament, extra: Record<string, string> = {}) {
    for (const userId of new Set(userIds))
      await this.deps.notify(userId, kind, { tournamentId: t.id, title: t.settings.title, ...extra })
  }

  // ── Pages ─────────────────────────────────────────────────────────────────────────────────

  /** `GET /api/tournaments`: soonest first; cancelled ones only to admins */
  list(userId: string): TournamentSummary[] {
    this.allowed(userId)
    const admin = this.deps.isAdmin(userId)
    for (const t of this.all.values()) void this.sync(t.id)
    return [...this.all.values()]
      .filter((t) => t.status !== 'cancelled' || admin)
      .sort((a, b) => a.settings.startsAt - b.settings.startsAt || a.createdAt - b.createdAt)
      .map((t) => this.summary(t, userId))
  }

  /** `GET /api/tournaments/:id` */
  view(id: string, userId: string): TournamentView {
    this.allowed(userId)
    const t = this.require(id)
    if (t.status === 'cancelled' && !this.deps.isAdmin(userId)) throw new ClubError('tournamentGone', {}, 404)
    void this.sync(t.id)
    return this.viewOf(t, userId)
  }

  private summary(t: Tournament, userId: string): TournamentSummary {
    return {
      id: t.id,
      title: t.settings.title,
      kind: t.settings.kind,
      status: t.status,
      startsAt: t.settings.startsAt,
      deadline: t.settings.deadline,
      capacity: t.settings.capacity,
      used: entriesUsed(t),
      mine: !!entryOf(t, userId),
    }
  }

  private viewOf(t: Tournament, userId: string): TournamentView {
    const user = (id: string): PublicUser => this.deps.userById(id) ?? { id, username: '' }
    const mine = entryOf(t, userId)
    return {
      ...this.summary(t, userId),
      description: t.settings.description,
      createdBy: user(t.createdBy),
      createdAt: t.createdAt,
      settings: t.settings,
      entries: t.entries.map((e) => ({
        id: e.id,
        players: e.players.map((p) => ({ ...user(p.userId), confirmed: p.confirmed })),
        ...(e.teamName !== undefined && { teamName: e.teamName }),
        complete: entryComplete(e),
        at: e.at,
      })),
      ...(mine && { myEntry: mine.id, myPending: mine.players.some((p) => p.userId === userId && !p.confirmed) }),
      entriesOpen: t.status === 'open' && this.deps.now() < t.settings.deadline,
      ...(t.eventId && { eventId: t.eventId, eventLink: tournamentEventLink(t.settings.kind, t.eventId) }),
      ...(t.startedAt !== undefined && { startedAt: t.startedAt }),
      ...(t.finishedAt !== undefined && { finishedAt: t.finishedAt }),
      canManage: this.deps.isAdmin(userId),
    }
  }

  // ── The admin's announcement ─────────────────────────────────────────────────────────────

  private parse(value: unknown, base?: TournamentSettings): TournamentSettings {
    const parsed = parseTournamentSettings(value, this.deps.now(), base)
    if ('field' in parsed) throw new ClubError('badTournament', { field: parsed.field })
    return parsed.settings
  }

  /** `POST /api/tournaments { settings }`: announced to every member who has the flag */
  async create(adminId: string, value: unknown): Promise<TournamentView> {
    this.admin(adminId)
    this.limited(adminId)
    const settings = this.parse(value)
    const t: Tournament = { id: this.deps.newId(), createdBy: adminId, createdAt: this.deps.now(), settings, status: 'open', entries: [] }
    await this.save(t)
    this.scheduleReminder(t)
    await this.tell(
      this.deps.members().filter((id) => id !== adminId && this.deps.featureOn(id)),
      'tournamentAnnounced',
      t,
    )
    return this.viewOf(t, adminId)
  }

  /** `POST /api/tournaments/:id/settings { settings }`: changed before the start; the kind only while nobody entered */
  async update(adminId: string, id: string, value: unknown): Promise<TournamentView> {
    this.admin(adminId)
    this.limited(adminId)
    const t = this.require(id)
    this.open(t)
    const settings = this.parse(value, t.settings)
    if (settings.kind !== t.settings.kind && t.entries.length) throw new ClubError('badTournament', { field: 'kind' })
    if (entriesUsed(t) > settings.capacity) throw new ClubError('badTournament', { field: 'capacity' })
    const next = { ...t, settings }
    await this.save(next)
    this.scheduleReminder(next)
    return this.viewOf(next, adminId)
  }

  /** `POST /api/tournaments/:id/cancel`: called off before the start; everyone who entered is told */
  async cancel(adminId: string, id: string): Promise<TournamentView> {
    this.admin(adminId)
    this.limited(adminId)
    const t = this.require(id)
    this.open(t)
    const next: Tournament = { ...t, status: 'cancelled', cancelledAt: this.deps.now() }
    await this.save(next)
    await this.tell(tournamentPlayers(t), 'tournamentCancelled', next)
    return this.viewOf(next, adminId)
  }

  /** `POST /api/tournaments/:id/remove { entryId }`: an admin takes an entry off before the start; its players are told */
  async remove(adminId: string, id: string, entryId: unknown): Promise<TournamentView> {
    this.admin(adminId)
    this.limited(adminId)
    const t = this.require(id)
    this.open(t)
    const entry = t.entries.find((e) => e.id === entryId)
    if (!entry) throw new ClubError('tournamentNoEntry', {}, 404)
    const next = { ...t, entries: t.entries.filter((e) => e !== entry) }
    await this.save(next)
    await this.tell(
      entry.players.map((p) => p.userId).filter((u) => u !== adminId),
      'tournamentRemoved',
      next,
      { username: this.name(adminId) },
    )
    return this.viewOf(next, adminId)
  }

  // ── Members' entries ─────────────────────────────────────────────────────────────────────

  /**
   * `POST /api/tournaments/:id/enter { partners, teamName? }`: the member enters with partners by
   * username: none (alone) or one for a pairs event, three for a team match. Each partner is told
   * and confirms; until then the entry does not count at the start
   */
  async enter(userId: string, id: string, body: { partners?: unknown; teamName?: unknown }): Promise<TournamentView> {
    this.allowed(userId)
    this.limited(userId)
    const t = this.require(id)
    this.beforeDeadline(t)
    const names = body.partners ?? []
    if (!Array.isArray(names) || !names.every((n) => typeof n === 'string')) throw new ClubError('tournamentBadPartner')
    const kind = t.settings.kind
    const wanted = kind === 'pairs' ? [0, 1] : [TOURNAMENT_LIMITS.teamSize - 1]
    if (!wanted.includes(names.length)) throw new ClubError('tournamentEntrySize')
    const partners: string[] = []
    for (const raw of names as string[]) {
      const partner = this.deps.userByName(raw.trim())
      if (!partner || partner === userId || partners.includes(partner) || this.deps.blocked(userId, partner) || this.deps.blocked(partner, userId))
        throw new ClubError('tournamentBadPartner')
      partners.push(partner)
    }
    for (const member of [userId, ...partners])
      if (entryOf(t, member)) throw new ClubError('tournamentAlreadyIn', { name: this.name(member) })
    let teamName: string | undefined
    if (kind === 'match') {
      const asked = typeof body.teamName === 'string' ? body.teamName.trim() : ''
      if (body.teamName !== undefined && typeof body.teamName !== 'string') throw new ClubError('badTournament', { field: 'teamName' })
      if (asked.length > TOURNAMENT_LIMITS.teamNameMax || /\p{Cc}/u.test(asked)) throw new ClubError('badTournament', { field: 'teamName' })
      teamName = asked
    }
    const entry: TournamentEntry = {
      id: this.deps.newId(),
      players: [{ userId, confirmed: true }, ...partners.map((p) => ({ userId: p, confirmed: false }))],
      ...(teamName !== undefined && { teamName }),
      at: this.deps.now(),
    }
    const next = { ...t, entries: [...t.entries, entry] }
    if (entriesUsed(next) > t.settings.capacity) throw new ClubError('tournamentFull', { max: t.settings.capacity })
    await this.save(next)
    await this.tell(partners, 'tournamentPartner', next, { username: this.name(userId) })
    return this.viewOf(next, userId)
  }

  /**
   * `POST /api/tournaments/:id/answer { accept }`: a partner confirms (until the start) or says no
   * (before the deadline): saying no takes the whole entry off, and the others in it are told
   */
  async answer(userId: string, id: string, accept: unknown): Promise<TournamentView> {
    this.allowed(userId)
    this.limited(userId)
    if (typeof accept !== 'boolean') throw new ClubError('unknownCommand')
    const t = this.require(id)
    const entry = entryOf(t, userId)
    if (!entry?.players.some((p) => p.userId === userId && !p.confirmed)) throw new ClubError('tournamentNoInvite')
    if (!accept) return this.drop(userId, t, entry)
    this.open(t)
    const confirmed = { ...entry, players: entry.players.map((p) => (p.userId === userId ? { ...p, confirmed: true } : p)) }
    const next = { ...t, entries: t.entries.map((e) => (e === entry ? confirmed : e)) }
    await this.save(next)
    return this.viewOf(next, userId)
  }

  /** `POST /api/tournaments/:id/withdraw`: anyone in an entry takes it off before the deadline; the others in it are told */
  async withdraw(userId: string, id: string): Promise<TournamentView> {
    this.allowed(userId)
    this.limited(userId)
    const t = this.require(id)
    const entry = entryOf(t, userId)
    if (!entry) throw new ClubError('tournamentNotEntered', {}, 404)
    return this.drop(userId, t, entry)
  }

  private async drop(userId: string, t: Tournament, entry: TournamentEntry): Promise<TournamentView> {
    this.beforeDeadline(t)
    const next = { ...t, entries: t.entries.filter((e) => e !== entry) }
    await this.save(next)
    await this.tell(
      entry.players.map((p) => p.userId).filter((u) => u !== userId),
      'tournamentWithdrawn',
      next,
      { username: this.name(userId) },
    )
    return this.viewOf(next, userId)
  }

  // ── The event ────────────────────────────────────────────────────────────────────────────

  /**
   * `POST /api/tournaments/:id/start`: the admin makes the event from the entries, through the
   * event's own service. A pairs event: every confirmed pair and the members alone two by two
   * (5–20 pairs), directed by the admin, who starts it on its page once everyone is online. A
   * team match: the first two complete teams, hosted by the first team's first player, every other
   * player invited to their seat (they accept in the invitation dialog as for any match, and the
   * host starts it). Entries that do not count (a partner who did not confirm, one alone left over)
   * stay listed and are not in the event
   */
  async start(adminId: string, id: string): Promise<TournamentView> {
    this.admin(adminId)
    this.limited(adminId)
    const t = this.require(id)
    this.open(t)
    let eventId: string
    if (t.settings.kind === 'pairs') {
      const { pairs } = pairsFromEntries(t)
      if (pairs.length < TOURNAMENT_LIMITS.pairsMin)
        throw new ClubError('tournamentTooFew', { count: pairs.length, min: TOURNAMENT_LIMITS.pairsMin })
      eventId = await this.deps.createPairs(adminId, pairsSettingsOf(t.settings), pairs.slice(0, TOURNAMENT_LIMITS.pairsMax))
    } else {
      const teams = teamsFromEntries(t)
      if (teams.length < TOURNAMENT_LIMITS.teams) throw new ClubError('tournamentTooFew', { count: teams.length, min: TOURNAMENT_LIMITS.teams })
      eventId = await this.deps.createMatch(
        teams.slice(0, TOURNAMENT_LIMITS.teams).map((e) => ({ name: e.teamName ?? '', players: e.players.map((p) => p.userId) })),
        matchSettingsOf(t.settings),
      )
    }
    // Saved again from what is kept now: an entry may have changed while the event was made
    const next: Tournament = { ...this.all.get(id)!, status: 'started', eventId, startedAt: this.deps.now() }
    await this.save(next)
    return this.viewOf(next, adminId)
  }

  /**
   * The event of a started tournament ended or was called off (the club hears it from the pairs
   * and team match services, and checks again whenever a page is read). Finished: the tournament
   * is too, and everyone in its entries is told, with a link to the results. Called off before it
   * was played: the tournament is open again, so the admin can start it once more
   */
  async sync(id: string) {
    const t = this.all.get(id)
    if (!t || t.status !== 'started' || !t.eventId) return
    try {
      const state = this.deps.eventState(t.settings.kind, t.eventId)
      if (state === 'finished') {
        const next: Tournament = { ...t, status: 'finished', finishedAt: this.deps.now() }
        await this.save(next)
        await this.tell(tournamentPlayers(t), 'tournamentResults', next, { eventKind: t.settings.kind, eventId: t.eventId })
      } else if (state === 'cancelled' || state === null) {
        const next: Tournament = { ...t, status: 'open' }
        delete next.eventId
        delete next.startedAt
        await this.save(next)
      }
    } catch (error) {
      this.deps.log(crashEntry('tournamentSync', error))
    }
  }

  /** An event ended: the tournament made from it, if any, catches up */
  async eventEnded(kind: TournamentKind, eventId: string) {
    for (const t of this.all.values()) if (t.settings.kind === kind && t.eventId === eventId) await this.sync(t.id)
  }

  // ── The reminder ─────────────────────────────────────────────────────────────────────────

  /** An hour before the start (at once when that has passed), once per start time, unless it is over */
  private scheduleReminder(t: Tournament) {
    if (t.status === 'cancelled' || t.status === 'finished' || t.remindedFor === t.settings.startsAt) return
    const now = this.deps.now()
    if (now >= t.settings.startsAt) return
    const at = t.settings.startsAt - TOURNAMENT_LIMITS.reminderMs
    this.deps.scheduler.add(`tournament:${t.id}:${t.settings.startsAt}`, 'tournament', Math.max(0, at - now), () =>
      this.remind(t.id, t.settings.startsAt),
    )
  }

  private async remind(id: string, startsAt: number) {
    const t = this.all.get(id)
    // Changed since (a new start has its own job), over, or already reminded
    if (!t || t.settings.startsAt !== startsAt || t.remindedFor === startsAt) return
    if (t.status === 'cancelled' || t.status === 'finished') return
    const next = { ...t, remindedFor: startsAt }
    await this.save(next)
    await this.tell(tournamentPlayers(t), 'tournamentReminder', next)
  }
}
