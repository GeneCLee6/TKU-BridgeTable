import type { Contract } from './auction.ts'
import { imps } from './imp.ts'
import type { PublicUser } from './protocol.ts'
import type { MatchStatus } from './team-match.ts'
import { matchVictoryPoints, VP_TOTAL } from './vp.ts'

/**
 * Multi-team events (多隊賽, `e9-t14`, AC-9.5, ARCHITECTURE.md §5.26): three or more teams of 4–6
 * play rounds; every round pairs the teams two by two (a round robin when the field is small enough
 * for everyone to meet everyone in the rounds allowed, otherwise Swiss), and every pairing is one
 * ordinary two-table team match (§5.8), played on its own page. Each match's IMPs become Victory
 * Points on the WBF scale (`shared/vp.ts`, `e8-t22`); the standings are the VP totals. A team left
 * over in a round with an odd number of teams has a bye. Pure functions only; the service is
 * `worker/team-events.ts`.
 */

export const TEAM_EVENT_LIMITS = {
  teamsMin: 3,
  teamsMax: 16,
  /** Four play each round; up to two more may come in between rounds (or as substitutes) */
  teamSizeMin: 4,
  teamSizeMax: 6,
  /** The most rounds a Swiss event plays; a round robin plays as many as everyone meeting needs */
  roundsMin: 3,
  roundsMax: 9,
  roundsDefault: 5,
  boardsMin: 4,
  boardsMax: 32,
  boardsDefault: 8,
} as const

/** A team with a bye gets this many of the 20 Victory Points (the WBF's usual 12) */
export const BYE_VP = 12

export const TEAM_EVENT_FORMATS = ['roundRobin', 'swiss'] as const
export type TeamEventFormat = (typeof TEAM_EVENT_FORMATS)[number]

/**
 * What the admin chose on the announcement (§5.26, 社長 2026-11-03): a round robin, Swiss, or
 * `auto` (decided at the start from the teams there are, `formatFor`; the form's suggestion)
 */
export const TEAM_EVENT_FORMAT_CHOICES = ['auto', 'roundRobin', 'swiss'] as const
export type TeamEventFormatChoice = (typeof TEAM_EVENT_FORMAT_CHOICES)[number]

/**
 * - `ready`: made from a tournament's entries; captains set their line-ups, the director starts round 1
 * - `playing`: a round is on, or between rounds waiting for the director to start the next
 * - `finished`: every match of the last round ended; the standings are final, points given
 * - `cancelled`: the director called it off before round 1
 */
export const TEAM_EVENT_STATUSES = ['ready', 'playing', 'finished', 'cancelled'] as const
export type TeamEventStatus = (typeof TEAM_EVENT_STATUSES)[number]

export interface TeamEventSettings {
  title: string
  /** Boards of each match (each round) */
  boards: number
  /** Each board's time limit (the team match's, 0 for none) */
  boardMinutes: number
  /**
   * The most rounds: with `auto`, a round robin needing more than this is played Swiss over this
   * many; with `swiss`, the rounds played (at most one fewer than the teams); with `roundRobin`,
   * every team meeting every other (`roundRobinRounds` of the places)
   */
  rounds: number
  /** The format the admin chose; absent (events before it could be chosen) is `auto` */
  format?: TeamEventFormatChoice
}

/**
 * Round robin when everyone can meet everyone within `maxRounds`; Swiss otherwise. Both decided at
 * the start, from the teams there are
 */
export function formatFor(teams: number, maxRounds: number): { format: TeamEventFormat; rounds: number } {
  const full = roundRobinRounds(teams)
  return full <= maxRounds ? { format: 'roundRobin', rounds: full } : { format: 'swiss', rounds: Math.min(maxRounds, teams - 1) }
}

/** A round robin of n teams: n − 1 rounds, n with an odd number (every team has one bye) */
export const roundRobinRounds = (teams: number) => (teams % 2 ? teams : teams - 1)

/**
 * Whether the rounds fit the chosen format for up to `capacity` teams (the announcement's check):
 * a round robin plays exactly `roundRobinRounds(capacity)` (so at most 10 teams within the 9
 * rounds allowed); Swiss at most one fewer than the teams; `auto` anything allowed
 */
export function roundsFit(format: TeamEventFormatChoice, rounds: number, capacity: number): boolean {
  if (format === 'roundRobin') return rounds === roundRobinRounds(capacity)
  if (format === 'swiss') return rounds <= capacity - 1
  return true
}

/**
 * The format and rounds an event plays with the teams there are at the start: the admin's choice
 * (a round robin of however many came; Swiss over the rounds asked, at most one fewer than the
 * teams), or `auto` (`formatFor`)
 */
export function eventFormat(teams: number, settings: Pick<TeamEventSettings, 'rounds' | 'format'>): { format: TeamEventFormat; rounds: number } {
  if (settings.format === 'roundRobin') return { format: 'roundRobin', rounds: roundRobinRounds(teams) }
  if (settings.format === 'swiss') return { format: 'swiss', rounds: Math.min(settings.rounds, teams - 1) }
  return formatFor(teams, settings.rounds)
}

// ── Pairings ─────────────────────────────────────────────────────────────────────────────────

/** One round's pairings, by index into the teams: `[a, b]` (a is team A: its captain hosts), and the bye */
export interface RoundPairing {
  pairs: [number, number][]
  bye?: number
}

/**
 * The whole round robin (the circle method): team 0 stays, the others turn one place a round; with
 * an odd number a phantom joins and whoever meets it has the bye. Every two teams meet exactly
 * once; who is team A alternates so that each team hosts about half its matches
 */
export function roundRobinSchedule(teams: number): RoundPairing[] {
  const n = teams % 2 ? teams + 1 : teams
  const phantom = teams % 2 ? teams : -1
  const ring = Array.from({ length: n }, (_, i) => i)
  const rounds: RoundPairing[] = []
  for (let r = 0; r < n - 1; r++) {
    const round: RoundPairing = { pairs: [] }
    for (let i = 0; i < n / 2; i++) {
      const x = ring[i]
      const y = ring[n - 1 - i]
      if (x === phantom || y === phantom) {
        round.bye = x === phantom ? y : x
        continue
      }
      // The fixed team alternates by round, the others by place, so hosting evens out
      round.pairs.push(i === 0 ? (r % 2 ? [y, x] : [x, y]) : i % 2 ? [y, x] : [x, y])
    }
    rounds.push(round)
    // Keep ring[0], turn the rest one place
    ring.splice(1, 0, ring.pop()!)
  }
  return rounds
}

const pairKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`)

/** How far the search for a pairing without repeats goes before settling for one with them (CPU per request is short) */
const SEARCH_STEPS = 20_000

/**
 * Pairs `order` top down, each with the highest-placed one left it has not met, going back when
 * that leaves someone with nobody; null if none can be found (or the search ran out of `budget`)
 */
function pairUp(order: number[], met: Set<string>, allowRepeats: boolean, budget = { steps: SEARCH_STEPS }): [number, number][] | null {
  if (!order.length) return []
  const [first, ...rest] = order
  for (let i = 0; i < rest.length; i++) {
    if (--budget.steps < 0) return null
    const other = rest[i]
    if (!allowRepeats && met.has(pairKey(first, other))) continue
    const tail = pairUp([...rest.slice(0, i), ...rest.slice(i + 1)], met, allowRepeats, budget)
    if (tail) return [[first, other], ...tail]
  }
  return null
}

/**
 * One Swiss round (`order`: every team by the standings, best first). With an odd number the bye
 * goes to the lowest-placed team that has not had one (if everyone has, the lowest), as long as
 * the others can still be paired without a repeat; then the teams are paired top down, each with
 * the highest-placed one left it has not met, going back when that leaves someone with nobody new
 * (so a repeat happens only when no pairing at all avoids one, and then the bye's rule still holds)
 */
export function swissPairing(order: number[], history: RoundPairing[]): RoundPairing {
  const met = new Set(history.flatMap((r) => r.pairs.map(([a, b]) => pairKey(a, b))))
  const byes = new Set(history.flatMap((r) => (r.bye === undefined ? [] : [r.bye])))
  const candidates = order.length % 2 ? [...order].reverse() : [undefined]
  // Who may have the bye, lowest first: those without one, then (all had one) everyone
  const fresh = candidates.filter((c) => c === undefined || !byes.has(c))
  const pool = fresh.length ? fresh : candidates
  for (const allowRepeats of [false, true])
    for (const bye of pool) {
      const pairs = pairUp(order.filter((t) => t !== bye), met, allowRepeats)
      if (pairs) return bye === undefined ? { pairs } : { pairs, bye }
    }
  return { pairs: [] }
}

// ── Standings ────────────────────────────────────────────────────────────────────────────────

/** One match as the standings count it: its IMP totals (with the director's penalties) and VP */
export interface TeamEventMatchScore {
  /** Indexes into the teams */
  a: number
  b: number
  imps: { A: number; B: number }
  vp: { A: number; B: number }
}

/**
 * A match's Victory Points from its IMPs (penalties already taken off): the WBF scale over the
 * match's boards, as the team match page shows them. An abandoned match counts what was scored
 */
export const eventMatchVp = (imps: { A: number; B: number }, boards: number) => matchVictoryPoints(imps, boards)

export interface TeamStanding {
  /** Index into the teams */
  team: number
  /** 1-based; tied teams share it */
  rank: number
  vp: number
  /** Matches counted (byes not) */
  played: number
  byes: number
  impsFor: number
  impsAgainst: number
}

const SAME = 1e-9
const round2 = (n: number) => Math.round(n * 100) / 100

/** IMPs won over IMPs lost (the WBF's quotient): none lost is best of all, none either way is 1 */
export function impQuotient(s: Pick<TeamStanding, 'impsFor' | 'impsAgainst'>): number {
  if (s.impsAgainst > 0) return s.impsFor / s.impsAgainst
  return s.impsFor > 0 ? Number.POSITIVE_INFINITY : 1
}

/**
 * The standings (ARCHITECTURE.md §5.26): Victory Points, then for two teams level on VP the
 * VP of their own matches against each other, then the IMP quotient (IMPs won ÷ IMPs lost); still
 * level, they share the place. Every match given (finished, or abandoned with what was scored)
 * counts; each bye is worth `BYE_VP`. Teams level everywhere keep their entry order on the list
 */
export function teamStandings(teams: number, matches: TeamEventMatchScore[], byes: number[]): TeamStanding[] {
  const rows: TeamStanding[] = Array.from({ length: teams }, (_, team) => ({ team, rank: 0, vp: 0, played: 0, byes: 0, impsFor: 0, impsAgainst: 0 }))
  for (const m of matches) {
    const a = rows[m.a]
    const b = rows[m.b]
    a.vp += m.vp.A
    b.vp += m.vp.B
    a.played++
    b.played++
    a.impsFor += m.imps.A
    a.impsAgainst += m.imps.B
    b.impsFor += m.imps.B
    b.impsAgainst += m.imps.A
  }
  for (const t of byes) {
    rows[t].vp += BYE_VP
    rows[t].byes++
  }
  for (const r of rows) {
    r.vp = round2(r.vp)
    r.impsFor = round2(r.impsFor)
    r.impsAgainst = round2(r.impsAgainst)
  }
  /** VP a team got against another, over every match the two played */
  const headToHead = (x: number, y: number) =>
    matches.reduce((sum, m) => sum + (m.a === x && m.b === y ? m.vp.A : m.a === y && m.b === x ? m.vp.B : 0), 0)
  const met = (x: number, y: number) => matches.some((m) => (m.a === x && m.b === y) || (m.a === y && m.b === x))
  const levelVp = (x: TeamStanding, y: TeamStanding) => Math.abs(x.vp - y.vp) < SAME
  // Each team's tie-break among those level with it on VP: only a tie of exactly two looks at their own matches
  const h2h = new Map<number, number>()
  for (const r of rows) {
    const level = rows.filter((o) => levelVp(o, r))
    if (level.length === 2) {
      const other = level.find((o) => o !== r)!
      if (met(r.team, other.team)) h2h.set(r.team, headToHead(r.team, other.team) - headToHead(other.team, r.team))
    }
  }
  const compare = (x: TeamStanding, y: TeamStanding) => {
    if (!levelVp(x, y)) return y.vp - x.vp
    const hx = h2h.get(x.team) ?? 0
    const hy = h2h.get(y.team) ?? 0
    if (Math.abs(hx - hy) > SAME) return hy - hx
    const qx = impQuotient(x)
    const qy = impQuotient(y)
    if (qx !== qy && Math.abs(qx - qy) > SAME) return qy > qx ? 1 : -1
    return 0
  }
  const sorted = [...rows].sort((x, y) => compare(x, y) || x.team - y.team)
  sorted.forEach((r, i) => {
    r.rank = i > 0 && compare(sorted[i - 1], r) === 0 ? sorted[i - 1].rank : i + 1
  })
  return sorted
}

/** Every match gives out 20 VP between its two teams */
export const VP_PER_MATCH = VP_TOTAL

// ── The event as kept (`teamev:<id>`) and how it goes on ─────────────────────────────────

export interface TeamEventTeam {
  id: string
  /** Empty: shown as 「第 n 隊」 */
  name: string
  /** Everyone on the team (4–6), its captain first */
  players: string[]
  /** The four who play the next round: open room pair first, then the closed room pair */
  lineup: string[]
}

/** One pairing of a round and the team match made for it */
export interface TeamEventPairing {
  /** Indexes into the teams; `a` is team A (its first player hosts the match) */
  a: number
  b: number
  matchId: string
}

export interface TeamEventRound {
  n: number
  matches: TeamEventPairing[]
  bye?: number
  at: number
  /**
   * Every match of the round plays the same deals (社長 2026-11-03), made when the round is: kept
   * under their own key (`teamevdeal:<event>:<n>`, never sent to a browser); absent for rounds
   * made before (each match dealt its own)
   */
  sameDeals?: boolean
}

export interface TeamEvent {
  id: string
  directorId: string
  createdAt: number
  settings: TeamEventSettings
  format: TeamEventFormat
  /** How many rounds it plays (a round robin's every round, or the Swiss rounds) */
  roundsTotal: number
  teams: TeamEventTeam[]
  /** The rounds made so far, in order */
  played: TeamEventRound[]
  status: TeamEventStatus
  finishedAt?: number
  cancelledAt?: number
  /** The tournament it was made from (`e9-t16`) */
  tournamentId?: string
}

/** One room's result on a board, as the round's comparison shows it */
export interface EventRoomResult {
  scoreNS: number
  /** Null for a passed-out board; absent when the index has no row for it */
  contract?: Contract | null
  declarerTricks?: number | null
}

/** A board one of the event's matches has done: both rooms played it, or it was ruled on */
export interface EventMatchBoard {
  /** The board's place in the match, 1-based: the same deal in every match of the round */
  seq: number
  open?: EventRoomResult
  closed?: EventRoomResult
  /** What each team won on it (IMPs) */
  result: { A: number; B: number }
  /** A ruling decided it (on the whole board, or on a room's record) */
  ruled: boolean
}

/** What the event needs of one of its matches: where it stands and its score (the director's penalties taken off) */
export interface EventMatchScore {
  status: MatchStatus
  imps: { A: number; B: number }
  /** The match's boards (the VP scale's) */
  boards: number
  /** The boards it has done so far (the round's comparison, and what may be shown of it) */
  played?: EventMatchBoard[]
}

/** A match that will not change any more: finished, abandoned, called off, or gone */
export const matchOver = (s: EventMatchScore | null) => !s || s.status === 'finished' || s.status === 'abandoned' || s.status === 'cancelled'

/** A match that counts in the standings: finished, or abandoned with the boards it scored */
export const matchCounts = (s: EventMatchScore | null): s is EventMatchScore => !!s && (s.status === 'finished' || s.status === 'abandoned')

export const roundDone = (round: TeamEventRound, scoreOf: (matchId: string) => EventMatchScore | null) =>
  round.matches.every((m) => matchOver(scoreOf(m.matchId)))

/**
 * Whether a board of a round may be shown to people outside the match that played it (§5.26,
 * 社長 2026-11-03): every match of the round plays the same deals, so a board is shown across
 * them only once every match of the round has done it (both rooms, or ruled on) or will not play
 * it any more (finished, abandoned, called off). Until then a player of one match could learn the
 * deal from another's result
 */
export function roundBoardShown(round: TeamEventRound, seq: number, scoreOf: (matchId: string) => EventMatchScore | null): boolean {
  return round.matches.every((m) => {
    const s = scoreOf(m.matchId)
    return matchOver(s) || !!s?.played?.some((b) => b.seq === seq)
  })
}

/** One match's line in a board's comparison */
export interface TeamEventBoardRow {
  matchId: string
  /** Indexes into the teams; team A sat North-South in the open room */
  a: number
  b: number
  open?: EventRoomResult
  closed?: EventRoomResult
  /** What each team won on the board (IMPs) */
  result: { A: number; B: number }
  ruled: boolean
  /** Each room's North-South score against the datum, in IMPs (not for a ruled board) */
  vsDatum?: { open?: number; closed?: number }
}

/** One board of a round across its matches (the same deal everywhere) */
export interface TeamEventBoardView {
  seq: number
  /** The field's datum: the mean North-South score of the rooms that played it (boards not ruled), to the nearest 10; null with fewer than two */
  datum: number | null
  rows: TeamEventBoardRow[]
}

/**
 * A round's boards compared across its matches (§5.26): only the boards `roundBoardShown`, each
 * with every match's two rooms, what each team won, and every room against the field's datum (the
 * mean of the North-South scores played, to the nearest 10: the Butler datum without dropping the
 * extremes). A match that never played a board (abandoned before it) has no line for it
 */
export function roundComparison(round: TeamEventRound, boards: number, scoreOf: (matchId: string) => EventMatchScore | null): TeamEventBoardView[] {
  const views: TeamEventBoardView[] = []
  for (let seq = 1; seq <= boards; seq++) {
    if (!roundBoardShown(round, seq, scoreOf)) continue
    const lines = round.matches.flatMap((m) => {
      const board = scoreOf(m.matchId)?.played?.find((b) => b.seq === seq)
      return board ? [{ m, board }] : []
    })
    if (!lines.length) continue
    const scores = lines.flatMap(({ board }) =>
      board.ruled ? [] : [board.open?.scoreNS, board.closed?.scoreNS].filter((x): x is number => x !== undefined),
    )
    const datum = scores.length >= 2 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length / 10) * 10 : null
    const against = (room?: EventRoomResult) => (room && datum !== null ? imps(room.scoreNS - datum) : undefined)
    views.push({
      seq,
      datum,
      rows: lines.map(({ m, board }) => {
        const open = board.ruled ? undefined : against(board.open)
        const closed = board.ruled ? undefined : against(board.closed)
        return {
          matchId: m.matchId,
          a: m.a,
          b: m.b,
          ...(board.open && { open: board.open }),
          ...(board.closed && { closed: board.closed }),
          result: board.result,
          ruled: board.ruled,
          ...((open !== undefined || closed !== undefined) && {
            vsDatum: { ...(open !== undefined && { open }), ...(closed !== undefined && { closed }) },
          }),
        }
      }),
    })
  }
  return views
}

/**
 * A match's score as people outside it may see it while its round is on (§5.26): the boards not
 * shown across the round yet taken out (their IMPs would hint at the deal); the director's
 * penalties stay in. A match that is over, as it is
 */
export function shownImps(round: TeamEventRound, s: EventMatchScore, scoreOf: (matchId: string) => EventMatchScore | null): { A: number; B: number } {
  if (matchOver(s) || !s.played) return s.imps
  const hidden = s.played.filter((b) => !roundBoardShown(round, b.seq, scoreOf))
  return {
    A: round2(s.imps.A - hidden.reduce((sum, b) => sum + b.result.A, 0)),
    B: round2(s.imps.B - hidden.reduce((sum, b) => sum + b.result.B, 0)),
  }
}

/**
 * The standings now: every match that counts (finished or abandoned), and the byes of the rounds
 * that are over (a bye counts when the others' matches do, so the table compares like with like).
 * A match called off before it was played gives neither team anything
 */
export function eventStandings(event: TeamEvent, scoreOf: (matchId: string) => EventMatchScore | null): TeamStanding[] {
  const matches: TeamEventMatchScore[] = []
  const byes: number[] = []
  for (const round of event.played) {
    for (const m of round.matches) {
      const s = scoreOf(m.matchId)
      if (matchCounts(s)) matches.push({ a: m.a, b: m.b, imps: s.imps, vp: eventMatchVp(s.imps, s.boards) })
    }
    if (round.bye !== undefined && roundDone(round, scoreOf)) byes.push(round.bye)
  }
  return teamStandings(event.teams.length, matches, byes)
}

/** The next round's pairings: the round robin's next round, or a Swiss round from the standings */
export function nextPairing(event: TeamEvent, scoreOf: (matchId: string) => EventMatchScore | null): RoundPairing {
  if (event.format === 'roundRobin') return roundRobinSchedule(event.teams.length)[event.played.length]
  const order = eventStandings(event, scoreOf).map((s) => s.team)
  const history = event.played.map((r) => ({ pairs: r.matches.map((m): [number, number] => [m.a, m.b]), ...(r.bye !== undefined && { bye: r.bye }) }))
  return swissPairing(order, history)
}

// ── What the page sees (`GET /api/team-events/:id`) ─────────────────────────────────────────

export interface TeamEventTeamView {
  id: string
  /** Empty: the page shows 「第 n 隊」 */
  name: string
  players: PublicUser[]
  /** The four who play the next round: open room pair first, then the closed room pair */
  lineup: string[]
  /** The viewer may set this team's line-up (its captain, the director, an admin) */
  canLineup: boolean
}

export interface TeamEventMatchView {
  matchId: string
  /** Indexes into `teams` */
  a: number
  b: number
  status: MatchStatus | 'gone'
  /**
   * The score so far, with the director's penalties: to people outside the match only the boards
   * shown across the round (`shownImps`) while it is played; its own players and the director see
   * every board both rooms played
   */
  imps: { A: number; B: number }
  /** Once the match ended: its VP */
  vp?: { A: number; B: number }
}

export interface TeamEventRoundView {
  n: number
  matches: TeamEventMatchView[]
  bye?: number
  /** Every match of the round ended */
  done: boolean
  /** Its matches play the same deals (rounds made before each dealt their own) */
  sameDeals: boolean
  /** The round's boards compared across its matches, each once every match has done it (`roundComparison`) */
  boards: TeamEventBoardView[]
}

export interface TeamStandingView extends TeamStanding {
  quotient: number | null
}

export interface TeamEventView {
  id: string
  title: string
  status: TeamEventStatus
  format: TeamEventFormat
  /** How many rounds it plays */
  rounds: number
  settings: TeamEventSettings
  director: PublicUser
  createdAt: number
  finishedAt?: number
  teams: TeamEventTeamView[]
  played: TeamEventRoundView[]
  standings: TeamStandingView[]
  /** The viewer's team, if any */
  myTeam?: number
  /** The viewer's match in the round on, if any */
  myMatch?: string
  /** The viewer may start the next round (the director or an admin, the round over) */
  canNext: boolean
  /** The viewer may call it off (before round 1) */
  canCancel: boolean
  /** The tournament it was made from */
  tournamentId?: string
}

export const teamEventLink = (id: string) => `/team-events/${encodeURIComponent(id)}`
