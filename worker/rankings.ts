import {
  placePoints,
  rankRows,
  type LeaderboardRow,
  type LedgerEntry,
  type Period,
  type PointKind,
  type PointsAdjustment,
  type PointsRules,
} from '../shared/points.ts'
import {
  eventGames,
  glicko2,
  idle,
  IDLE_PERIOD_DAYS,
  INITIAL_RATING,
  isProvisional,
  RATING_HISTORY,
  type RatedSide,
  type Rating,
  type RatingView,
} from '../shared/rating.ts'
import type { Sql, SqlValue } from './store.ts'

/**
 * The points ledger and the ratings (`e9-t05`, `e9-t08`, ARCHITECTURE.md §5.20), in the club
 * object's SQLite next to the challenges and matches they come from. An event is recorded once
 * (`ranked_events`): the points of each member, then the ratings, all in one transaction, so an
 * event heard of again (a late report, a settlement run twice) changes nothing.
 */

/** The admins' rules, in the store (KV), as the daily event's settings are */
export const POINTS_KEY = 'meta:points'

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ranked_events (
    event_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS points_entries (
    event_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    at INTEGER NOT NULL,
    rank INTEGER NOT NULL,
    field INTEGER NOT NULL,
    points REAL NOT NULL,
    PRIMARY KEY (event_id, user_id)
  )`,
  'CREATE INDEX IF NOT EXISTS points_entries_at ON points_entries (at)',
  'CREATE INDEX IF NOT EXISTS points_entries_user ON points_entries (user_id, at)',
  `CREATE TABLE IF NOT EXISTS points_adjustments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    delta REAL NOT NULL,
    reason TEXT NOT NULL,
    by_id TEXT NOT NULL,
    made_at INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS points_adjustments_entry ON points_adjustments (event_id, user_id)',
  `CREATE TABLE IF NOT EXISTS ratings (
    user_id TEXT PRIMARY KEY,
    rating REAL NOT NULL,
    rd REAL NOT NULL,
    vol REAL NOT NULL,
    events INTEGER NOT NULL,
    last_at INTEGER NOT NULL,
    hidden INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS rating_history (
    user_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    at INTEGER NOT NULL,
    rating REAL NOT NULL,
    rd REAL NOT NULL,
    PRIMARY KEY (user_id, event_id)
  )`,
  'CREATE INDEX IF NOT EXISTS rating_history_user ON rating_history (user_id, at)',
]

/** A finished event as the ledger takes it: who placed where, robots counted for the ratings */
export interface RankedEvent {
  id: string
  kind: PointKind
  /** When it counts: the month and year boards place it by this */
  at: number
  /** Every side ranked; a side without members (all robots) still counts as an opponent */
  sides: RatedSide[]
}

interface RatingRow extends Record<string, SqlValue> {
  user_id: string
  rating: number
  rd: number
  vol: number
  events: number
  last_at: number
  hidden: number
}

const round = (n: number, places = 1) => Math.round(n * 10 ** places) / 10 ** places

export class RankingStore {
  private readonly sql: Sql

  constructor(sql: Sql) {
    this.sql = sql
  }

  createTables() {
    this.sql.transaction(() => {
      for (const statement of SCHEMA) this.sql.exec(statement)
    })
  }

  /** Whether an event was recorded already */
  recorded(eventId: string): boolean {
    return this.sql.exec('SELECT 1 FROM ranked_events WHERE event_id = ?', eventId).length > 0
  }

  /**
   * Records a finished event once: each member's points under the kind's rule and everyone's new
   * rating. False when it was recorded before (nothing changes)
   */
  record(event: RankedEvent, rules: PointsRules): boolean {
    return this.sql.transaction(() => {
      if (this.recorded(event.id)) return false
      this.sql.exec('INSERT INTO ranked_events (event_id, kind, at) VALUES (?, ?, ?)', event.id, event.kind, event.at)
      for (const p of placePoints(rules.kinds[event.kind], event.sides))
        this.sql.exec(
          'INSERT OR IGNORE INTO points_entries (event_id, user_id, kind, at, rank, field, points) VALUES (?, ?, ?, ?, ?, ?, ?)',
          event.id,
          p.userId,
          event.kind,
          event.at,
          p.rank,
          p.field,
          p.points,
        )
      this.rate(event)
      return true
    })
  }

  /** Every member's rating before the event, grown for the months they sat out */
  private before(userId: string, at: number): Rating {
    const row = this.row(userId)
    if (!row) return INITIAL_RATING
    const periods = Math.floor((at - row.last_at) / (IDLE_PERIOD_DAYS * 86_400_000))
    return idle({ rating: row.rating, rd: row.rd, vol: row.vol }, Math.max(0, periods))
  }

  private row(userId: string): RatingRow | undefined {
    return this.sql.exec<RatingRow>('SELECT * FROM ratings WHERE user_id = ?', userId)[0]
  }

  private rate(event: RankedEvent) {
    const members = [...new Set(event.sides.flatMap((s) => s.userIds))]
    const start = new Map(members.map((id) => [id, this.before(id, event.at)]))
    const games = eventGames(event.sides, (id) => start.get(id) ?? INITIAL_RATING)
    for (const [userId, list] of games) {
      const next = glicko2(start.get(userId)!, list)
      const old = this.row(userId)
      this.sql.exec(
        `INSERT INTO ratings (user_id, rating, rd, vol, events, last_at, hidden) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET rating = excluded.rating, rd = excluded.rd, vol = excluded.vol,
           events = excluded.events, last_at = excluded.last_at`,
        userId,
        next.rating,
        next.rd,
        next.vol,
        (old?.events ?? 0) + 1,
        Math.max(event.at, old?.last_at ?? 0),
        old?.hidden ?? 0,
      )
      this.sql.exec(
        'INSERT OR REPLACE INTO rating_history (user_id, event_id, kind, at, rating, rd) VALUES (?, ?, ?, ?, ?, ?)',
        userId,
        event.id,
        event.kind,
        event.at,
        next.rating,
        next.rd,
      )
    }
  }

  // ── The boards ─────────────────────────────────────────────────────────────────────────────

  /** Everyone's points in a period, corrections counted, ranked */
  leaderboard(period: Pick<Period, 'from' | 'to'>): LeaderboardRow[] {
    const rows = this.sql.exec<{ user_id: string; points: number; events: number }>(
      `SELECT e.user_id AS user_id, SUM(e.points + COALESCE(a.delta, 0)) AS points, COUNT(*) AS events
       FROM points_entries e
       LEFT JOIN (SELECT event_id, user_id, SUM(delta) AS delta FROM points_adjustments GROUP BY event_id, user_id) a
         ON a.event_id = e.event_id AND a.user_id = e.user_id
       WHERE e.at >= ? AND e.at < ?
       GROUP BY e.user_id`,
      period.from,
      period.to,
    )
    return rankRows(rows.map((r) => ({ userId: r.user_id, points: round(r.points), events: r.events })))
  }

  /** One member's entries in a period, newest first, each with its corrections */
  ledger(userId: string, period: Pick<Period, 'from' | 'to'>): LedgerEntry[] {
    const entries = this.sql.exec<{ event_id: string; kind: PointKind; at: number; rank: number; field: number; points: number }>(
      'SELECT event_id, kind, at, rank, field, points FROM points_entries WHERE user_id = ? AND at >= ? AND at < ? ORDER BY at DESC, event_id',
      userId,
      period.from,
      period.to,
    )
    return entries.map((e) => {
      const adjustments = this.adjustmentsOf(e.event_id, userId)
      return {
        eventId: e.event_id,
        kind: e.kind,
        at: e.at,
        rank: e.rank,
        field: e.field,
        base: e.points,
        points: round(e.points + adjustments.reduce((s, a) => s + a.delta, 0)),
        adjustments,
      }
    })
  }

  private adjustmentsOf(eventId: string, userId: string): PointsAdjustment[] {
    return this.sql
      .exec<{ delta: number; reason: string; by_id: string; made_at: number }>(
        'SELECT delta, reason, by_id, made_at FROM points_adjustments WHERE event_id = ? AND user_id = ? ORDER BY id',
        eventId,
        userId,
      )
      .map((a) => ({ delta: a.delta, reason: a.reason, by: a.by_id, at: a.made_at }))
  }

  /**
   * An admin sets an entry's points (更正): kept as a correction beside the entry (the rule's
   * points stay), with who, when and why. Null when the member has no entry for that event
   */
  adjust(eventId: string, userId: string, points: number, reason: string, by: string, now: number): LedgerEntry | null {
    return this.sql.transaction(() => {
      const entry = this.sql.exec<{ points: number; at: number }>(
        'SELECT points, at FROM points_entries WHERE event_id = ? AND user_id = ?',
        eventId,
        userId,
      )[0]
      if (!entry) return null
      const current = entry.points + this.adjustmentsOf(eventId, userId).reduce((s, a) => s + a.delta, 0)
      const delta = round(points - current)
      if (delta !== 0)
        this.sql.exec(
          'INSERT INTO points_adjustments (event_id, user_id, delta, reason, by_id, made_at) VALUES (?, ?, ?, ?, ?, ?)',
          eventId,
          userId,
          delta,
          reason,
          by,
          now,
        )
      return this.ledger(userId, { from: entry.at, to: entry.at + 1 }).find((e) => e.eventId === eventId) ?? null
    })
  }

  // ── Ratings ────────────────────────────────────────────────────────────────────────────────

  /** A member's rating and its history; `hidden` is theirs to read, the caller decides who sees it */
  rating(userId: string): RatingView {
    const row = this.row(userId)
    const history = this.sql
      .exec<{ event_id: string; kind: string; at: number; rating: number; rd: number }>(
        `SELECT event_id, kind, at, rating, rd FROM
           (SELECT * FROM rating_history WHERE user_id = ? ORDER BY at DESC, event_id DESC LIMIT ?)
         ORDER BY at, event_id`,
        userId,
        RATING_HISTORY,
      )
      .map((h) => ({ eventId: h.event_id, kind: h.kind, at: h.at, rating: Math.round(h.rating), rd: Math.round(h.rd) }))
    const rated = row && row.events > 0 ? row : undefined
    return {
      userId,
      rating: rated ? Math.round(rated.rating) : null,
      rd: rated ? Math.round(rated.rd) : null,
      provisional: !rated || isProvisional(rated),
      events: rated?.events ?? 0,
      hidden: row?.hidden === 1,
      history,
    }
  }

  /** The member's choice to show their rating or not (不公開); kept before they have one too */
  setHidden(userId: string, hidden: boolean, now: number) {
    this.sql.exec(
      `INSERT INTO ratings (user_id, rating, rd, vol, events, last_at, hidden) VALUES (?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET hidden = excluded.hidden`,
      userId,
      INITIAL_RATING.rating,
      INITIAL_RATING.rd,
      INITIAL_RATING.vol,
      now,
      hidden ? 1 : 0,
    )
  }

  /** What an account export carries (個資匯出) */
  exportOf(userId: string) {
    return {
      points: this.ledger(userId, { from: 0, to: Number.MAX_SAFE_INTEGER }),
      rating: this.rating(userId),
    }
  }

  /** A deleted account's points and rating go; others' places in those events stay as they were */
  deleteUser(userId: string) {
    this.sql.transaction(() => {
      this.sql.exec('DELETE FROM points_entries WHERE user_id = ?', userId)
      this.sql.exec('DELETE FROM points_adjustments WHERE user_id = ?', userId)
      this.sql.exec('DELETE FROM ratings WHERE user_id = ?', userId)
      this.sql.exec('DELETE FROM rating_history WHERE user_id = ?', userId)
    })
  }
}
