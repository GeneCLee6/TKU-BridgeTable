import type { Card, Seat } from '../shared/cards.ts'
import { decodeDealSet, encodeDealSet, type DealSet } from '../shared/deal-set.ts'
import { defaultTeamMatchSettings, MATCH_SEATS, teamAt, type MatchStatus, type Room, type SeatStatus, type TeamMatchSettings } from '../shared/team-match.ts'
import type { ScoreRuling } from '../shared/ruling-scoring.ts'
import type { Ruling, RulingKind, Team, TeamBoardScores } from '../shared/team-scoring.ts'
import type { Sql, SqlValue } from './store.ts'

/**
 * Two-table team matches in the Durable Object's SQLite database (ARCHITECTURE.md §5.8, e8-t03).
 * Like challenges these tables are where matches live, not an index: every read goes to SQL, so
 * nothing is cached and an eviction loses nothing; a change to several rows runs in a transaction.
 */

export interface TeamMatchSeat {
  room: Room
  seat: Seat
  status: SeatStatus
  /** The member invited to or sitting in the seat; absent when empty or a robot */
  userId?: string
  robot: boolean
  invitedAt?: number
  answeredAt?: number
}

/** One room's result on a board */
export interface RoomResult {
  /** The board record (`board:<id>`): contract, play and the replay come from there */
  boardId: string
  scoreNS: number
  playedAt: number
  /** The opening lead, for the result page (`e8-t12`); absent when nobody led (passed out) */
  lead?: Card
}

export interface MatchRuling extends Ruling {
  reason: string
  by: string
  at: number
}

/** A board of the match: each room's result once played there, and the host's ruling if any */
export interface TeamMatchBoard {
  /** The board's place in the deal set, 1-based */
  seq: number
  open?: RoomResult
  closed?: RoomResult
  ruling?: MatchRuling
}

export interface TeamMatch {
  id: string
  hostId: string
  createdAt: number
  status: MatchStatus
  startedAt?: number
  endedAt?: number
  settings: TeamMatchSettings
  /** Team A's captain is the host; team B's is set when the host names one (`e8-t05`) */
  captains: { A: string; B?: string }
  /** Dealt when the match starts (`e8-t07`), so changing the number of boards before then is free */
  deals?: DealSet
  /** The two tables, once started */
  tables?: Record<Room, string>
  /** The host paused it (`e8-t16`): since when; absent while it runs */
  pausedAt?: number
  /** The segment being played (`e8-t21`), 1-based; absent for the first (and a match without segments) */
  segment?: number
  /** Both rooms finished the segment and wait for the host to start the next (中場): since when */
  breakAt?: number
  /** Always all eight, in `MATCH_SEATS` order */
  seats: TeamMatchSeat[]
  /** Only boards at least one room has finished or the host ruled on, by `seq` */
  boards: TeamMatchBoard[]
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS matches (
    match_id TEXT PRIMARY KEY,
    host_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    started_at INTEGER,
    ended_at INTEGER,
    settings TEXT NOT NULL,
    captain_a TEXT NOT NULL,
    captain_b TEXT,
    deals TEXT,
    open_table TEXT,
    closed_table TEXT,
    paused_at INTEGER,
    segment INTEGER,
    break_at INTEGER
  )`,
  'CREATE INDEX IF NOT EXISTS matches_by_status ON matches (status, created_at)',
  `CREATE TABLE IF NOT EXISTS match_seats (
    match_id TEXT NOT NULL,
    room TEXT NOT NULL,
    seat TEXT NOT NULL,
    status TEXT NOT NULL,
    user_id TEXT,
    robot INTEGER NOT NULL,
    invited_at INTEGER,
    answered_at INTEGER,
    PRIMARY KEY (match_id, room, seat)
  ) WITHOUT ROWID`,
  'CREATE INDEX IF NOT EXISTS match_seats_by_user ON match_seats (user_id, match_id)',
  `CREATE TABLE IF NOT EXISTS match_boards (
    match_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    open_board_id TEXT,
    open_score_ns INTEGER,
    open_at INTEGER,
    closed_board_id TEXT,
    closed_score_ns INTEGER,
    closed_at INTEGER,
    open_lead TEXT,
    closed_lead TEXT,
    ruling TEXT,
    ruling_team TEXT,
    ruling_reason TEXT,
    ruled_by TEXT,
    ruled_at INTEGER,
    PRIMARY KEY (match_id, seq)
  ) WITHOUT ROWID`,
  // The watchers' chat on the Vugraph page (`e8-t18`): the players never get it
  `CREATE TABLE IF NOT EXISTS match_chat (
    match_id TEXT NOT NULL,
    id TEXT NOT NULL,
    at INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    text TEXT NOT NULL,
    PRIMARY KEY (match_id, at, id)
  ) WITHOUT ROWID`,
  // Who looked at the match on the Vugraph page while it was played: they saw both rooms, so they never come in as a substitute
  `CREATE TABLE IF NOT EXISTS match_watchers (
    match_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    PRIMARY KEY (match_id, user_id)
  ) WITHOUT ROWID`,
]

/** The Vugraph chat a match keeps: the latest this many lines */
export const MATCH_CHAT_KEEP = 100

/** One line of a match's Vugraph chat as stored (the name is looked up when it is shown) */
export interface MatchChatLine {
  id: string
  at: number
  userId: string
  text: string
}

interface MatchRow extends Record<string, SqlValue> {
  match_id: string
  host_id: string
  created_at: number
  status: string
  started_at: number | null
  ended_at: number | null
  settings: string
  captain_a: string
  captain_b: string | null
  deals: string | null
  open_table: string | null
  closed_table: string | null
  paused_at: number | null
  segment: number | null
  break_at: number | null
}

interface SeatRow extends Record<string, SqlValue> {
  room: string
  seat: string
  status: string
  user_id: string | null
  robot: number
  invited_at: number | null
  answered_at: number | null
}

interface BoardRow extends Record<string, SqlValue> {
  seq: number
  open_board_id: string | null
  open_score_ns: number | null
  open_at: number | null
  closed_board_id: string | null
  closed_score_ns: number | null
  closed_at: number | null
  open_lead: string | null
  closed_lead: string | null
  ruling: string | null
  ruling_team: string | null
  ruling_reason: string | null
  ruled_by: string | null
  ruled_at: number | null
}

/** Optional values are left out rather than kept as undefined, so a match reads back as it was written */
const optional = <K extends string, V>(key: K, value: V | null) =>
  (value === null ? {} : { [key]: value }) as Partial<Record<K, V>>

const OPEN = "('setup', 'playing')"

const seatOrder = (room: string, seat: string) => MATCH_SEATS.findIndex((s) => s.room === room && s.seat === seat)

function roomResult(boardId: string | null, scoreNS: number | null, at: number | null, lead: string | null): RoomResult | undefined {
  if (boardId === null || scoreNS === null || at === null) return undefined
  return { boardId, scoreNS, playedAt: at, ...(lead !== null && { lead: lead as Card }) }
}

/** Columns added after the tables were first made (F5): tables made before get them on load */
const ADDED_COLUMNS: { table: string; column: string; type: string }[] = [
  { table: 'matches', column: 'paused_at', type: 'INTEGER' },
  { table: 'matches', column: 'segment', type: 'INTEGER' },
  { table: 'matches', column: 'break_at', type: 'INTEGER' },
  { table: 'match_boards', column: 'open_lead', type: 'TEXT' },
  { table: 'match_boards', column: 'closed_lead', type: 'TEXT' },
]

/**
 * A board's two scores for `scoreTeamMatch`, with the host's ruling and a director's ruling on
 * each room's board record (`rulingOf`, from the history index, `e2-t36`)
 */
export function boardScores(
  board: TeamMatchBoard | undefined,
  rulingOf: (boardId: string) => ScoreRuling | undefined = () => undefined,
): TeamBoardScores {
  const open = board?.open && rulingOf(board.open.boardId)
  const closed = board?.closed && rulingOf(board.closed.boardId)
  return {
    open: board?.open?.scoreNS ?? null,
    closed: board?.closed?.scoreNS ?? null,
    ...(board?.ruling && { ruling: { kind: board.ruling.kind, team: board.ruling.team } }),
    ...((open || closed) && { rooms: { ...(open && { open }), ...(closed && { closed }) } }),
  }
}

export class TeamMatchStore {
  private readonly sql: Sql

  constructor(sql: Sql) {
    this.sql = sql
  }

  /** Creates the tables and indexes if they are missing; safe to run on every load */
  createTables() {
    this.sql.transaction(() => {
      for (const statement of SCHEMA) this.sql.exec(statement)
      for (const { table, column, type } of ADDED_COLUMNS) {
        const columns = this.sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name)
        if (!columns.includes(column)) this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
      }
    })
  }

  /** Runs several writes as one: all of them or none */
  transaction<T>(fn: () => T): T {
    return this.sql.transaction(fn)
  }

  /** Saves a new match with its eight seats; it has no boards yet */
  create(match: TeamMatch) {
    const m = match
    this.sql.transaction(() => {
      this.sql.exec(
        `INSERT INTO matches (match_id, host_id, created_at, status, started_at, ended_at, settings, captain_a, captain_b,
          deals, open_table, closed_table) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        m.id,
        m.hostId,
        m.createdAt,
        m.status,
        m.startedAt ?? null,
        m.endedAt ?? null,
        JSON.stringify(m.settings),
        m.captains.A,
        m.captains.B ?? null,
        m.deals ? encodeDealSet(m.deals) : null,
        m.tables?.open ?? null,
        m.tables?.closed ?? null,
      )
      for (const seat of m.seats)
        this.sql.exec(
          `INSERT INTO match_seats (match_id, room, seat, status, user_id, robot, invited_at, answered_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          m.id,
          seat.room,
          seat.seat,
          ...this.seatValues(seat),
        )
    })
  }

  private seatValues(s: TeamMatchSeat): SqlValue[] {
    return [s.status, s.userId ?? null, s.robot ? 1 : 0, s.invitedAt ?? null, s.answeredAt ?? null]
  }

  get(id: string): TeamMatch | null {
    const row = this.sql.exec<MatchRow>('SELECT * FROM matches WHERE match_id = ?', id)[0]
    if (!row) return null
    let deals: DealSet | undefined
    if (row.deals !== null) {
      const decoded = decodeDealSet(row.deals)
      if (!decoded) throw new Error(`match ${id} has a broken deal set`)
      deals = decoded
    }
    const seats = this.sql
      .exec<SeatRow>('SELECT * FROM match_seats WHERE match_id = ?', id)
      .sort((a, b) => seatOrder(a.room, a.seat) - seatOrder(b.room, b.seat))
      .map(
        (s): TeamMatchSeat => ({
          room: s.room as Room,
          seat: s.seat as Seat,
          status: s.status as SeatStatus,
          ...optional('userId', s.user_id),
          robot: s.robot === 1,
          ...optional('invitedAt', s.invited_at),
          ...optional('answeredAt', s.answered_at),
        }),
      )
    const boards = this.sql
      .exec<BoardRow>('SELECT * FROM match_boards WHERE match_id = ? ORDER BY seq', id)
      .map((b): TeamMatchBoard => {
        const open = roomResult(b.open_board_id, b.open_score_ns, b.open_at, b.open_lead)
        const closed = roomResult(b.closed_board_id, b.closed_score_ns, b.closed_at, b.closed_lead)
        return {
          seq: b.seq,
          ...(open && { open }),
          ...(closed && { closed }),
          ...(b.ruling !== null && {
            ruling: {
              kind: b.ruling as RulingKind,
              team: (b.ruling_team ?? 'A') as Team,
              reason: b.ruling_reason ?? '',
              by: b.ruled_by ?? '',
              at: b.ruled_at ?? 0,
            },
          }),
        }
      })
    return {
      id: row.match_id,
      hostId: row.host_id,
      createdAt: row.created_at,
      status: row.status as MatchStatus,
      ...optional('startedAt', row.started_at),
      ...optional('endedAt', row.ended_at),
      // A match saved before a setting existed has its default (`delay`, e8-t19)
      settings: { ...defaultTeamMatchSettings(), ...(JSON.parse(row.settings) as Partial<TeamMatchSettings>) },
      captains: { A: row.captain_a, ...optional('B', row.captain_b) },
      ...(deals && { deals }),
      ...(row.open_table !== null && row.closed_table !== null && { tables: { open: row.open_table, closed: row.closed_table } }),
      ...optional('pausedAt', row.paused_at),
      ...(row.segment !== null && row.segment > 1 && { segment: row.segment }),
      ...optional('breakAt', row.break_at),
      seats,
      boards,
    }
  }

  /** The matches a member hosts or has a seat in (invited or sitting), newest first */
  idsOf(userId: string): string[] {
    return this.sql
      .exec<{ match_id: string }>(
        `SELECT m.match_id FROM matches m WHERE m.host_id = ?
           OR m.match_id IN (SELECT match_id FROM match_seats WHERE user_id = ?)
         ORDER BY m.created_at DESC, m.match_id DESC`,
        userId,
        userId,
      )
      .map((r) => r.match_id)
  }

  /** Matches being set up or played, oldest first: jobs are scheduled again from these after a load */
  openIds(): string[] {
    return this.sql
      .exec<{ match_id: string }>(`SELECT match_id FROM matches WHERE status IN ${OPEN} ORDER BY created_at`)
      .map((r) => r.match_id)
  }

  /**
   * The match being played that a member has a seat in, if any (§5.8): they play there and nowhere
   * else until it ends. Starting a match checks no one in it is already playing another
   */
  playingIdOf(userId: string): string | null {
    return (
      this.sql.exec<{ match_id: string }>(
        `SELECT m.match_id FROM matches m JOIN match_seats s ON s.match_id = m.match_id
         WHERE s.user_id = ? AND s.status = 'seated' AND m.status = 'playing' LIMIT 1`,
        userId,
      )[0]?.match_id ?? null
    )
  }

  /** The open matches a member hosts (one at a time, §5.8) */
  openHostedBy(userId: string): string[] {
    return this.sql
      .exec<{ match_id: string }>(`SELECT match_id FROM matches WHERE host_id = ? AND status IN ${OPEN}`, userId)
      .map((r) => r.match_id)
  }

  /** Moves a match on: `playing` stamps when it started, the three endings when it ended */
  setStatus(id: string, status: MatchStatus, at: number) {
    if (status === 'playing')
      this.sql.exec('UPDATE matches SET status = ?, started_at = COALESCE(started_at, ?) WHERE match_id = ?', status, at, id)
    else if (status === 'setup') this.sql.exec('UPDATE matches SET status = ? WHERE match_id = ?', status, id)
    else this.sql.exec('UPDATE matches SET status = ?, ended_at = ? WHERE match_id = ?', status, at, id)
  }

  /** Pauses (`at`) or resumes (null) a match being played (`e8-t16`) */
  setPaused(id: string, at: number | null) {
    this.sql.exec('UPDATE matches SET paused_at = ? WHERE match_id = ?', at, id)
  }

  /** Both rooms finished the segment (`e8-t21`): the match waits between segments from `at` */
  setBreak(id: string, at: number) {
    this.sql.exec('UPDATE matches SET break_at = ? WHERE match_id = ?', at, id)
  }

  /** The host starts the next segment (`e8-t21`): the break is over */
  setSegment(id: string, segment: number) {
    this.sql.exec('UPDATE matches SET segment = ?, break_at = NULL WHERE match_id = ?', segment, id)
  }

  /** The host changes (`e8-t16`: the host's account was deleted while the match is played) */
  setHost(id: string, userId: string) {
    this.sql.exec('UPDATE matches SET host_id = ?, captain_a = ? WHERE match_id = ?', userId, userId, id)
  }

  setSettings(id: string, settings: TeamMatchSettings) {
    this.sql.exec('UPDATE matches SET settings = ? WHERE match_id = ?', JSON.stringify(settings), id)
  }

  setCaptainB(id: string, userId: string | null) {
    this.sql.exec('UPDATE matches SET captain_b = ? WHERE match_id = ?', userId, id)
  }

  /** Keeps the deal set and the two tables when the match starts */
  setStarted(id: string, deals: DealSet, tables: Record<Room, string>, at: number) {
    this.sql.transaction(() => {
      this.sql.exec(
        'UPDATE matches SET deals = ?, open_table = ?, closed_table = ? WHERE match_id = ?',
        encodeDealSet(deals),
        tables.open,
        tables.closed,
        id,
      )
      this.setStatus(id, 'playing', at)
    })
  }

  /** Writes one seat: an invitation, an answer, someone sitting or leaving, a robot */
  updateSeat(id: string, seat: TeamMatchSeat) {
    this.sql.exec(
      `UPDATE match_seats SET status = ?, user_id = ?, robot = ?, invited_at = ?, answered_at = ?
       WHERE match_id = ? AND room = ? AND seat = ?`,
      ...this.seatValues(seat),
      id,
      seat.room,
      seat.seat,
    )
  }

  /**
   * Keeps one room's result on a board. Each room plays a board once, so a second result for the
   * same room throws, and nothing is written
   */
  addResult(id: string, seq: number, room: Room, result: RoomResult) {
    this.sql.transaction(() => {
      this.sql.exec('INSERT OR IGNORE INTO match_boards (match_id, seq) VALUES (?, ?)', id, seq)
      const taken = this.sql.exec<{ board_id: string | null }>(
        `SELECT ${room}_board_id AS board_id FROM match_boards WHERE match_id = ? AND seq = ?`,
        id,
        seq,
      )[0]
      if (taken.board_id !== null) throw new Error(`match ${id} board ${seq} already has a result in the ${room} room`)
      this.sql.exec(
        `UPDATE match_boards SET ${room}_board_id = ?, ${room}_score_ns = ?, ${room}_at = ?, ${room}_lead = ?
         WHERE match_id = ? AND seq = ?`,
        result.boardId,
        result.scoreNS,
        result.playedAt,
        result.lead ?? null,
        id,
        seq,
      )
    })
  }

  /** The host's ruling on a board (`e8-t15`); a later ruling replaces it, null takes it back */
  setRuling(id: string, seq: number, ruling: MatchRuling | null) {
    this.sql.transaction(() => {
      this.sql.exec('INSERT OR IGNORE INTO match_boards (match_id, seq) VALUES (?, ?)', id, seq)
      this.sql.exec(
        `UPDATE match_boards SET ruling = ?, ruling_team = ?, ruling_reason = ?, ruled_by = ?, ruled_at = ?
         WHERE match_id = ? AND seq = ?`,
        ruling?.kind ?? null,
        ruling?.team ?? null,
        ruling?.reason ?? null,
        ruling?.by ?? null,
        ruling?.at ?? null,
        id,
        seq,
      )
    })
  }

  /**
   * A deleted account leaves every match still open: a match they host that has not started is
   * cancelled; otherwise their seat is emptied while setting up, or handed to a robot while playing
   * (the boards they played stay). Ended matches keep them, so results never change. Returns the
   * matches it changed
   */
  forget(userId: string, now: number): string[] {
    return this.sql.transaction(() => {
      const ids = this.sql
        .exec<{ match_id: string }>(
          `SELECT match_id FROM matches WHERE status IN ${OPEN}
             AND (host_id = ? OR match_id IN (SELECT match_id FROM match_seats WHERE user_id = ?))`,
          userId,
          userId,
        )
        .map((r) => r.match_id)
      // What they said on the Vugraph pages goes with the account
      this.sql.exec('DELETE FROM match_chat WHERE user_id = ?', userId)
      for (const id of ids) {
        const match = this.get(id)!
        if (match.status === 'setup' && match.hostId === userId) {
          this.setStatus(id, 'cancelled', now)
          continue
        }
        if (match.captains.B === userId) this.setCaptainB(id, null)
        // A match being played goes on under a new host: team A's first member, else team B's
        // captain, else anyone still seated; with nobody left the robots finish it hostless
        if (match.status === 'playing' && match.hostId === userId) {
          const people = match.seats.filter((s) => s.userId !== undefined && s.userId !== userId && !s.robot && s.status === 'seated')
          const next =
            people.find((s) => teamAt(s.room, s.seat) === 'A')?.userId ??
            (match.captains.B !== userId ? match.captains.B : undefined) ??
            people[0]?.userId
          if (next !== undefined) this.setHost(id, next)
        }
        for (const seat of match.seats.filter((s) => s.userId === userId))
          this.updateSeat(
            id,
            match.status === 'playing'
              ? { room: seat.room, seat: seat.seat, status: 'seated', robot: true }
              : { room: seat.room, seat: seat.seat, status: 'empty', robot: false },
          )
      }
      return ids
    })
  }

  // ── The Vugraph page (`e8-t18`) ──────────────────────────────────────────────────────────────

  /** Adds a line to a match's watchers' chat, keeping the latest `MATCH_CHAT_KEEP` */
  addChat(matchId: string, line: MatchChatLine) {
    this.sql.transaction(() => {
      this.sql.exec('INSERT INTO match_chat (match_id, id, at, user_id, text) VALUES (?, ?, ?, ?, ?)', matchId, line.id, line.at, line.userId, line.text)
      this.sql.exec(
        `DELETE FROM match_chat WHERE match_id = ? AND (at, id) NOT IN
           (SELECT at, id FROM match_chat WHERE match_id = ? ORDER BY at DESC, id DESC LIMIT ?)`,
        matchId,
        matchId,
        MATCH_CHAT_KEEP,
      )
    })
  }

  /** A match's watchers' chat, oldest first */
  chat(matchId: string): MatchChatLine[] {
    return this.sql
      .exec<{ id: string; at: number; user_id: string; text: string }>(
        'SELECT id, at, user_id, text FROM match_chat WHERE match_id = ? ORDER BY at, id',
        matchId,
      )
      .map((r) => ({ id: r.id, at: r.at, userId: r.user_id, text: r.text }))
  }

  /** Notes that a member watched the match on the Vugraph page */
  watched(matchId: string, userId: string) {
    this.sql.exec('INSERT OR IGNORE INTO match_watchers (match_id, user_id) VALUES (?, ?)', matchId, userId)
  }

  /** Whether a member ever watched the match on the Vugraph page */
  hasWatched(matchId: string, userId: string): boolean {
    return this.sql.exec('SELECT 1 FROM match_watchers WHERE match_id = ? AND user_id = ?', matchId, userId).length > 0
  }
}
