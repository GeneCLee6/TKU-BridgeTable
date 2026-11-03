import { individualSizeFor, INDIVIDUAL_PLAYERS, MOVEMENT_PAIRS } from './movement.ts'
import { parsePairsSettings, type PairsSettings } from './pairs.ts'
import type { PublicUser } from './protocol.ts'
import { TEAM_EVENT_LIMITS, type TeamEventSettings } from './team-event.ts'
import { parseTeamMatchSettings, TEAM_MATCH_LIMITS, type TeamMatchSettings } from './team-match.ts'
import type { MatchScoring } from './team-scoring.ts'

/**
 * Tournament announcements and entries (比賽公告與報名, `e9-t16`, AC-9.7, ARCHITECTURE.md §5.24).
 * A tournament is not an event engine of its own: an admin announces it (which existing event it
 * runs as, when, the deadline, how many may enter), members enter (alone or with a partner, or as
 * a team of four, each partner confirming), and when it is time the admin turns the entries into
 * the event itself: a pairs event (§5.22) or a team match (§5.8), set up the way those pages
 * would. Pure functions; the service is `worker/tournaments.ts`.
 */

/**
 * The existing events a tournament can run as; `individual` is a pairs event of the individual format
 * (`e9-t15`), `teams` the multi-team event (`e9-t14`, §5.26)
 */
export const TOURNAMENT_KINDS = ['pairs', 'match', 'individual', 'teams'] as const
export type TournamentKind = (typeof TOURNAMENT_KINDS)[number]

/**
 * - `open`: announced, taking entries until the deadline; the admin may start it any time
 * - `started`: the event was made from the entries (`eventId`); it is played on its own page
 * - `finished`: the event finished; everyone who entered was told, the page links the results
 * - `cancelled`: the admin called it off before the start
 */
export const TOURNAMENT_STATUSES = ['open', 'started', 'finished', 'cancelled'] as const
export type TournamentStatus = (typeof TOURNAMENT_STATUSES)[number]

export const TOURNAMENT_LIMITS = {
  titleMax: 40,
  descriptionMax: 2000,
  /** Pairs in a pairs event (the Mitchell movement's 5–20, `MOVEMENT_PAIRS`) */
  pairsMin: MOVEMENT_PAIRS.min,
  pairsMax: MOVEMENT_PAIRS.max,
  /** Players in an individual event (`e9-t15`): it starts with 8, 12, 16 or 20 of them */
  playersMin: INDIVIDUAL_PLAYERS.min,
  playersMax: INDIVIDUAL_PLAYERS.max,
  /** A team match is two teams of four */
  teams: 2,
  teamSize: 4,
  teamNameMax: TEAM_MATCH_LIMITS.nameMax,
  /** A multi-team event (`e9-t14`): 3–16 teams of 4–6 */
  teamsMin: TEAM_EVENT_LIMITS.teamsMin,
  teamsMax: TEAM_EVENT_LIMITS.teamsMax,
  teamSizeMax: TEAM_EVENT_LIMITS.teamSizeMax,
  /** The reminder goes this long before the start */
  reminderMs: 60 * 60_000,
  /**
   * The day-before reminder goes this long before the start, when the start was set at least this
   * long ahead (an announcement or a move less than a day before has only the hour's); not at all
   * once less than `dayReminderLateMs` is left (the club's object slept through its time)
   */
  dayReminderMs: 24 * 60 * 60_000,
  dayReminderLateMs: 12 * 60 * 60_000,
  /** Announced at most this far ahead */
  aheadMaxMs: 366 * 86_400_000,
} as const

/** The event's own settings a tournament keeps, checked by that event's parser */
export interface TournamentPairsSettings {
  boardsPerRound: number
  boardMinutes: number
}
export interface TournamentMatchSettings {
  boards: number
  scoring: MatchScoring
  boardMinutes: number
}
/** A multi-team event's (`e9-t14`): boards per match, the time limit, the most rounds; always IMP (VP needs IMPs) */
export interface TournamentTeamsSettings {
  boards: number
  boardMinutes: number
  rounds: number
}

export interface TournamentSettings {
  kind: TournamentKind
  title: string
  description: string
  /** When play starts (the reminder goes `reminderMs` before) */
  startsAt: number
  /** Entries and withdrawals close; at most `startsAt` */
  deadline: number
  /**
   * Most entries: pairs for a pairs event (5–20), always 2 teams for a team match, players for an
   * individual event (8–20), 3–16 teams for a multi-team event
   */
  capacity: number
  /** A pairs event's settings; an individual event (`e9-t15`) plays with these too */
  pairs: TournamentPairsSettings
  match: TournamentMatchSettings
  /** A multi-team event's settings; absent in tournaments kept from before `e9-t14` (read as the defaults) */
  teams?: TournamentTeamsSettings
}

const DEFAULT_PAIRS: TournamentPairsSettings = { boardsPerRound: 3, boardMinutes: 8 }
const DEFAULT_MATCH: TournamentMatchSettings = { boards: 8, scoring: 'imp', boardMinutes: 10 }
export const DEFAULT_TEAMS: TournamentTeamsSettings = {
  boards: TEAM_EVENT_LIMITS.boardsDefault,
  boardMinutes: 10,
  rounds: TEAM_EVENT_LIMITS.roundsDefault,
}

/** A multi-team event's settings, or null when a field is wrong (every field required, nothing else) */
function parseTeamsSettings(value: unknown): TournamentTeamsSettings | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { boards, boardMinutes, rounds, ...rest } = value as Record<string, unknown>
  if (Object.keys(rest).length) return null
  const L = TEAM_EVENT_LIMITS
  if (!Number.isInteger(boards) || (boards as number) < L.boardsMin || (boards as number) > L.boardsMax) return null
  if (!Number.isInteger(rounds) || (rounds as number) < L.roundsMin || (rounds as number) > L.roundsMax) return null
  // The team match's own check of the time limit (0, or 3–30)
  const match = parseTeamMatchSettings({ boardMinutes })
  if ('field' in match) return null
  return { boards: boards as number, boardMinutes: match.settings.boardMinutes, rounds: rounds as number }
}

/**
 * Checks what an admin sent: every field, against `base` when changing a tournament. `now` is when
 * it is sent: the start and the deadline must be ahead of it. Returns the settings, or the first
 * field that is wrong
 */
export function parseTournamentSettings(
  value: unknown,
  now: number,
  base?: TournamentSettings,
): { settings: TournamentSettings } | { field: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { field: 'settings' }
  const input = value as Record<string, unknown>
  const kind = input.kind ?? base?.kind
  if (!TOURNAMENT_KINDS.includes(kind as TournamentKind)) return { field: 'kind' }
  const title = input.title ?? base?.title
  if (typeof title !== 'string' || !title.trim() || title.trim().length > TOURNAMENT_LIMITS.titleMax || /\p{Cc}/u.test(title))
    return { field: 'title' }
  const description = input.description ?? base?.description ?? ''
  if (typeof description !== 'string' || description.length > TOURNAMENT_LIMITS.descriptionMax) return { field: 'description' }
  // A time kept from before may have passed (an admin fixing the text after the deadline); a new one may not
  const startsAt = input.startsAt ?? base?.startsAt
  const newStart = startsAt !== base?.startsAt
  if (!Number.isInteger(startsAt) || (newStart && ((startsAt as number) <= now || (startsAt as number) > now + TOURNAMENT_LIMITS.aheadMaxMs)))
    return { field: 'startsAt' }
  const deadline = input.deadline ?? base?.deadline
  const newDeadline = deadline !== base?.deadline
  if (!Number.isInteger(deadline) || (newDeadline && (deadline as number) <= now) || (deadline as number) > (startsAt as number))
    return { field: 'deadline' }
  let capacity: number
  if (kind === 'match') capacity = TOURNAMENT_LIMITS.teams
  else if (kind === 'individual') {
    const asked = input.capacity ?? (base?.kind === 'individual' ? base.capacity : TOURNAMENT_LIMITS.playersMax)
    if (!Number.isInteger(asked) || (asked as number) < TOURNAMENT_LIMITS.playersMin || (asked as number) > TOURNAMENT_LIMITS.playersMax)
      return { field: 'capacity' }
    capacity = asked as number
  } else if (kind === 'teams') {
    const asked = input.capacity ?? (base?.kind === 'teams' ? base.capacity : TOURNAMENT_LIMITS.teamsMax)
    if (!Number.isInteger(asked) || (asked as number) < TOURNAMENT_LIMITS.teamsMin || (asked as number) > TOURNAMENT_LIMITS.teamsMax)
      return { field: 'capacity' }
    capacity = asked as number
  } else {
    const asked = input.capacity ?? (base?.kind === 'pairs' ? base.capacity : TOURNAMENT_LIMITS.pairsMax)
    if (!Number.isInteger(asked) || (asked as number) < TOURNAMENT_LIMITS.pairsMin || (asked as number) > TOURNAMENT_LIMITS.pairsMax)
      return { field: 'capacity' }
    capacity = asked as number
  }
  const pairsIn = input.pairs ?? base?.pairs ?? DEFAULT_PAIRS
  const pairs = parsePairsSettings(pairsIn)
  if (!pairs || typeof pairsIn !== 'object' || 'title' in (pairsIn as object)) return { field: 'pairs' }
  const matchIn = input.match ?? base?.match ?? DEFAULT_MATCH
  if (!matchIn || typeof matchIn !== 'object' || Array.isArray(matchIn)) return { field: 'match' }
  const { boards, scoring, boardMinutes, ...rest } = matchIn as Record<string, unknown>
  if (Object.keys(rest).length) return { field: 'match' }
  const match = parseTeamMatchSettings({ boards: boards ?? DEFAULT_MATCH.boards, scoring: scoring ?? DEFAULT_MATCH.scoring, boardMinutes: boardMinutes ?? DEFAULT_MATCH.boardMinutes })
  if ('field' in match) return { field: 'match' }
  const teamsIn = input.teams ?? base?.teams ?? DEFAULT_TEAMS
  const teams = parseTeamsSettings(typeof teamsIn === 'object' && teamsIn ? { ...DEFAULT_TEAMS, ...teamsIn } : teamsIn)
  if (!teams) return { field: 'teams' }
  return {
    settings: {
      kind: kind as TournamentKind,
      title: title.trim(),
      description: description.trim(),
      startsAt: startsAt as number,
      deadline: deadline as number,
      capacity,
      pairs: { boardsPerRound: pairs.boardsPerRound, boardMinutes: pairs.boardMinutes },
      match: { boards: match.settings.boards, scoring: match.settings.scoring, boardMinutes: match.settings.boardMinutes },
      teams,
    },
  }
}

/** The pairs event's settings for a tournament (its title is the tournament's) */
export const pairsSettingsOf = (s: TournamentSettings): PairsSettings => ({ title: s.title, ...s.pairs })

/** The team match's settings for a tournament: every seat invited by the host, no robots (the teams' names are added) */
export const matchSettingsOf = (s: TournamentSettings): Partial<TeamMatchSettings> => ({ ...s.match, invite: 'direct', robots: false })

/** The multi-team event's settings for a tournament (its title is the tournament's) */
export const teamEventSettingsOf = (s: TournamentSettings): TeamEventSettings => ({ title: s.title, ...(s.teams ?? DEFAULT_TEAMS) })

/** How many players an entry has: one or two (a pairs event), one (an individual event), four (a team match), four to six (a multi-team event) */
export function entrySizes(kind: TournamentKind): number[] {
  if (kind === 'pairs') return [1, 2]
  if (kind === 'individual') return [1]
  if (kind === 'match') return [TOURNAMENT_LIMITS.teamSize]
  return Array.from({ length: TOURNAMENT_LIMITS.teamSizeMax - TOURNAMENT_LIMITS.teamSize + 1 }, (_, i) => TOURNAMENT_LIMITS.teamSize + i)
}

// ── Entries ───────────────────────────────────────────────────────────────────────────────

export interface TournamentPlayer {
  userId: string
  /** The one who entered is; a partner or teammate is once they confirm */
  confirmed: boolean
}

/**
 * One entry: a member alone (a pairs event only: paired with another member alone at the start),
 * a pair, or a team of four (a team match). The first player entered it
 */
export interface TournamentEntry {
  id: string
  players: TournamentPlayer[]
  /** A team's name (a team match or a multi-team event), empty for 「A 隊」/「B 隊」 */
  teamName?: string
  at: number
}

export interface Tournament {
  id: string
  createdBy: string
  createdAt: number
  settings: TournamentSettings
  status: TournamentStatus
  entries: TournamentEntry[]
  /** The event made from the entries: a pairs event's or a team match's id */
  eventId?: string
  startedAt?: number
  finishedAt?: number
  cancelledAt?: number
  /** The start the reminder already went out for (a changed start reminds again) */
  remindedFor?: number
  /** The start a day-before reminder is due for: set when the start was set a day or more ahead */
  dayReminderFor?: number
  /** The start the day-before reminder already went out for */
  dayRemindedFor?: number
  /**
   * The admin's order of the members alone (a pairs event; 2026-11-03): two by two they make the
   * pairs. Kept as set; members alone since are added in the order they entered (`singlesOrder`)
   */
  pairing?: string[]
}

/** Whether every player of an entry confirmed */
export const entryComplete = (e: TournamentEntry) => e.players.every((p) => p.confirmed)

/** The entry a member is in, if any */
export const entryOf = (t: Tournament, userId: string) => t.entries.find((e) => e.players.some((p) => p.userId === userId))

/** Everyone in an entry, confirmed or not */
export const tournamentPlayers = (t: Tournament) => t.entries.flatMap((e) => e.players.map((p) => p.userId))

/**
 * How full it is, in entries as capacity counts them: a pair or a team is one, a member alone half
 * a pair (two alone make one at the start); in an individual event (`e9-t15`) every member alone is one
 */
export const entriesUsed = (t: Tournament) =>
  t.entries.reduce((n, e) => n + (e.players.length === 1 && t.settings.kind !== 'individual' ? 0.5 : 1), 0)

/** The members who entered alone, in the order they entered */
const aloneOf = (t: Tournament) => t.entries.filter((e) => e.players.length === 1).map((e) => e.players[0].userId)

/**
 * The members alone in the order they are paired (2026-11-03): the admin's order (`pairing`) for
 * those still alone, then everyone alone since, in the order they entered. With no order set, the
 * order they entered
 */
export function singlesOrder(t: Tournament): string[] {
  const alone = aloneOf(t)
  const kept = (t.pairing ?? []).filter((id) => alone.includes(id))
  return [...kept, ...alone.filter((id) => !kept.includes(id))]
}

/**
 * Whether `order` may be the admin's pairing: every member alone exactly once, nobody else. A
 * member alone in no order at all (`null`) goes back to the order they entered
 */
export function isPairingOrder(t: Tournament, order: unknown): order is string[] | null {
  if (order === null) return true
  const alone = aloneOf(t)
  return (
    Array.isArray(order) &&
    order.length === alone.length &&
    new Set(order).size === order.length &&
    order.every((id) => typeof id === 'string' && alone.includes(id))
  )
}

/**
 * The members alone two by two (`singlesOrder`): the proposed pairs and the one left over. What
 * the admin sees, and changes, before the start
 */
export function singlesPairs(t: Tournament): { pairs: [string, string][]; leftOver: string[] } {
  const alone = singlesOrder(t)
  const pairs: [string, string][] = []
  for (let i = 0; i + 1 < alone.length; i += 2) pairs.push([alone[i], alone[i + 1]])
  return { pairs, leftOver: alone.length % 2 ? [alone.at(-1)!] : [] }
}

/**
 * The pairs a pairs event starts with: every pair whose partner confirmed, in the order they
 * entered, then the members alone two by two (`singlesPairs`: the admin's pairing, else the order
 * they entered; one left over plays not)
 */
export function pairsFromEntries(t: Tournament): { pairs: [string, string][]; leftOver: string[] } {
  const pairs: [string, string][] = []
  for (const e of t.entries) if (e.players.length === 2 && entryComplete(e)) pairs.push([e.players[0].userId, e.players[1].userId])
  const singles = singlesPairs(t)
  return { pairs: [...pairs, ...singles.pairs], leftOver: singles.leftOver }
}

/**
 * The players an individual event (`e9-t15`) starts with: the members who entered, in order, as
 * many as the movement seats (8, 12, 16 or 20: the largest not above the number entered); the
 * rest are left over and play not
 */
export function playersFromEntries(t: Tournament): { players: string[]; leftOver: string[] } {
  const all = t.entries.filter((e) => e.players.length === 1).map((e) => e.players[0].userId)
  const size = individualSizeFor(all.length)
  return { players: all.slice(0, size), leftOver: all.slice(size) }
}

/** The teams a team match starts with: every team of four all confirmed, in the order they entered */
export const teamsFromEntries = (t: Tournament) =>
  t.entries.filter((e) => e.players.length === TOURNAMENT_LIMITS.teamSize && entryComplete(e))

/** The teams a multi-team event starts with (`e9-t14`): every team of 4–6 all confirmed, in the order they entered */
export const eventTeamsFromEntries = (t: Tournament) =>
  t.entries.filter((e) => e.players.length >= TOURNAMENT_LIMITS.teamSize && e.players.length <= TOURNAMENT_LIMITS.teamSizeMax && entryComplete(e))

// ── What the pages see (`GET /api/tournaments`, `GET /api/tournaments/:id`) ────────────────

export interface TournamentEntryView {
  id: string
  players: (PublicUser & { confirmed: boolean })[]
  teamName?: string
  complete: boolean
  at: number
}

export interface TournamentSummary {
  id: string
  title: string
  kind: TournamentKind
  status: TournamentStatus
  startsAt: number
  deadline: number
  capacity: number
  /** As `entriesUsed` counts */
  used: number
  /** The viewer is in an entry */
  mine: boolean
}

export interface TournamentView extends TournamentSummary {
  description: string
  createdBy: PublicUser
  createdAt: number
  settings: TournamentSettings
  entries: TournamentEntryView[]
  /** The viewer's entry, and whether they still have to confirm it */
  myEntry?: string
  myPending?: boolean
  /** Entries and withdrawals are still taken (open, before the deadline) */
  entriesOpen: boolean
  eventId?: string
  /** Where the event is played, and once finished its results: `/pairs/:id`, `/matches/:id` or `/team-events/:id` */
  eventLink?: string
  startedAt?: number
  finishedAt?: number
  /** The viewer may change, cancel or start it, remove entries and change the singles' pairing (an admin) */
  canManage: boolean
  /**
   * A pairs event's members alone as they will be paired at the start (`singlesPairs`), while it
   * is open: the admin may change it (`POST …/pairing`). `adjusted` once the admin changed it
   */
  singles?: { pairs: [PublicUser, PublicUser][]; leftOver: PublicUser[]; adjusted: boolean }
}

/** The page of a tournament's event (and its results); an individual event's is a pairs event's page */
export const tournamentEventLink = (kind: TournamentKind, eventId: string) =>
  kind === 'pairs' || kind === 'individual'
    ? `/pairs/${encodeURIComponent(eventId)}`
    : kind === 'teams'
      ? `/team-events/${encodeURIComponent(eventId)}`
      : `/matches/${encodeURIComponent(eventId)}`
