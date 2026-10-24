import type { ChallengeSettings, ChallengeStatus, PlayerStatus } from '../shared/challenge.ts'
import { decodeDealSet, encodeDealSet, type DealSet } from '../shared/deal-set.ts'
import type { Sql, SqlValue } from './store.ts'

/**
 * Challenges in the Durable Object's SQLite database (ARCHITECTURE.md §5.5, e7-t03). Unlike the
 * history index these tables are not rebuilt from anything: they are where challenges live. All
 * reads go to SQL (it is synchronous and in the same object), so nothing is cached in memory and
 * an eviction loses nothing; every change that touches more than one row runs in a transaction.
 */

export interface ChallengePlayer {
  userId: string
  status: PlayerStatus
  invitedAt: number
  answeredAt?: number
  /** Their first board was dealt; once anyone has started, the creator can no longer cancel */
  startedAt?: number
  /** They played every board */
  finishedAt?: number
  /**
   * The creator of a challenge made from boards they already played (「用這副牌挑戰」): they do not
   * play again, their results from those boards are copied in and ranked like everyone's
   */
  knownDeals: boolean
}

/** One participant's result on one board of the challenge */
export interface ChallengeResult {
  userId: string
  /** The board's place in the deal set, 1-based */
  seq: number
  /** The board record (`board:<id>`): contract, play and the replay come from there */
  boardId: string
  scoreNS: number
  playedAt: number
}

export interface Challenge {
  id: string
  creatorId: string
  createdAt: number
  status: ChallengeStatus
  /** The one deadline for answering and playing (`challengeDeadline`; column `accept_by`) */
  deadline: number
  /** When someone besides the creator accepted */
  startedAt?: number
  /** When it was finished, cancelled or expired */
  endedAt?: number
  settings: ChallengeSettings
  deals: DealSet
  /** In the order they were invited, the creator first */
  players: ChallengePlayer[]
  /** By participant, then board */
  results: ChallengeResult[]
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS challenges (
    challenge_id TEXT PRIMARY KEY,
    creator_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    accept_by INTEGER NOT NULL,
    started_at INTEGER,
    ended_at INTEGER,
    settings TEXT NOT NULL,
    deals TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS challenges_by_status ON challenges (status, accept_by)',
  `CREATE TABLE IF NOT EXISTS challenge_players (
    challenge_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    status TEXT NOT NULL,
    invited_at INTEGER NOT NULL,
    answered_at INTEGER,
    started_at INTEGER,
    finish_by INTEGER,
    finished_at INTEGER,
    known_deals INTEGER NOT NULL,
    PRIMARY KEY (challenge_id, user_id)
  ) WITHOUT ROWID`,
  'CREATE INDEX IF NOT EXISTS challenge_players_by_user ON challenge_players (user_id, challenge_id)',
  `CREATE TABLE IF NOT EXISTS challenge_results (
    challenge_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    board_id TEXT NOT NULL,
    score_ns INTEGER NOT NULL,
    played_at INTEGER NOT NULL,
    PRIMARY KEY (challenge_id, user_id, seq)
  ) WITHOUT ROWID`,
]

interface ChallengeRow extends Record<string, SqlValue> {
  challenge_id: string
  creator_id: string
  created_at: number
  status: string
  accept_by: number
  started_at: number | null
  ended_at: number | null
  settings: string
  deals: string
}

interface PlayerRow extends Record<string, SqlValue> {
  user_id: string
  status: string
  invited_at: number
  answered_at: number | null
  started_at: number | null
  finish_by: number | null
  finished_at: number | null
  known_deals: number
}

interface ResultRow extends Record<string, SqlValue> {
  user_id: string
  seq: number
  board_id: string
  score_ns: number
  played_at: number
}

/** Optional numbers are left out rather than kept as undefined, so a challenge reads back as it was written */
const optional = <K extends string>(key: K, value: number | null) =>
  (value === null ? {} : { [key]: value }) as Partial<Record<K, number>>

const OPEN = "('pending', 'active')"

export class ChallengeStore {
  private readonly sql: Sql

  constructor(sql: Sql) {
    this.sql = sql
  }

  /** Creates the tables and indexes if they are missing; safe to run on every load */
  createTables() {
    this.sql.transaction(() => {
      for (const statement of SCHEMA) this.sql.exec(statement)
    })
  }

  /** Runs several writes as one: all of them or none */
  transaction<T>(fn: () => T): T {
    return this.sql.transaction(fn)
  }

  /** Saves a new challenge with its participants; it has no results yet */
  create(challenge: Challenge) {
    const c = challenge
    this.sql.transaction(() => {
      this.sql.exec(
        `INSERT INTO challenges (challenge_id, creator_id, created_at, status, accept_by, started_at, ended_at, settings, deals)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        c.id,
        c.creatorId,
        c.createdAt,
        c.status,
        c.deadline,
        c.startedAt ?? null,
        c.endedAt ?? null,
        JSON.stringify(c.settings),
        encodeDealSet(c.deals),
      )
      for (const [position, player] of c.players.entries())
        this.sql.exec(
          `INSERT INTO challenge_players (challenge_id, user_id, position, status, invited_at, answered_at, started_at,
            finish_by, finished_at, known_deals) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          c.id,
          player.userId,
          position,
          ...this.playerValues(player),
        )
    })
  }

  private playerValues(p: ChallengePlayer): SqlValue[] {
    return [
      p.status,
      p.invitedAt,
      p.answeredAt ?? null,
      p.startedAt ?? null,
      // finish_by: per-player deadlines were dropped for the one deadline; the column stays unused
      null,
      p.finishedAt ?? null,
      p.knownDeals ? 1 : 0,
    ]
  }

  get(id: string): Challenge | null {
    const row = this.sql.exec<ChallengeRow>('SELECT * FROM challenges WHERE challenge_id = ?', id)[0]
    if (!row) return null
    const deals = decodeDealSet(row.deals)
    if (!deals) throw new Error(`challenge ${id} has a broken deal set`)
    const players = this.sql
      .exec<PlayerRow>('SELECT * FROM challenge_players WHERE challenge_id = ? ORDER BY position', id)
      .map(
        (p): ChallengePlayer => ({
          userId: p.user_id,
          status: p.status as PlayerStatus,
          invitedAt: p.invited_at,
          ...optional('answeredAt', p.answered_at),
          ...optional('startedAt', p.started_at),
          ...optional('finishedAt', p.finished_at),
          knownDeals: p.known_deals === 1,
        }),
      )
    const order = new Map(players.map((p, i) => [p.userId, i]))
    const results = this.sql
      .exec<ResultRow>('SELECT * FROM challenge_results WHERE challenge_id = ?', id)
      .map((r): ChallengeResult => ({
        userId: r.user_id,
        seq: r.seq,
        boardId: r.board_id,
        scoreNS: r.score_ns,
        playedAt: r.played_at,
      }))
      .sort((a, b) => (order.get(a.userId) ?? 0) - (order.get(b.userId) ?? 0) || a.seq - b.seq)
    return {
      id: row.challenge_id,
      creatorId: row.creator_id,
      createdAt: row.created_at,
      status: row.status as ChallengeStatus,
      deadline: row.accept_by,
      ...optional('startedAt', row.started_at),
      ...optional('endedAt', row.ended_at),
      settings: JSON.parse(row.settings) as ChallengeSettings,
      deals,
      players,
      results,
    }
  }

  /** The challenges a member is in (invited, declined or playing), newest first */
  idsOf(userId: string): string[] {
    return this.sql
      .exec<{ challenge_id: string }>(
        `SELECT c.challenge_id FROM challenge_players p JOIN challenges c ON c.challenge_id = p.challenge_id
         WHERE p.user_id = ? ORDER BY c.created_at DESC, c.challenge_id DESC`,
        userId,
      )
      .map((r) => r.challenge_id)
  }

  /** Challenges that can still change, for the deadlines to be scheduled again after a load (`e7-t13`) */
  openIds(): string[] {
    return this.sql
      .exec<{ challenge_id: string }>(`SELECT challenge_id FROM challenges WHERE status IN ${OPEN} ORDER BY accept_by`)
      .map((r) => r.challenge_id)
  }

  /** Moves a challenge on: `active` stamps when it started, the three endings when it ended */
  setStatus(id: string, status: ChallengeStatus, at: number) {
    if (status === 'active')
      this.sql.exec(
        'UPDATE challenges SET status = ?, started_at = COALESCE(started_at, ?) WHERE challenge_id = ?',
        status,
        at,
        id,
      )
    else if (status === 'pending') this.sql.exec('UPDATE challenges SET status = ? WHERE challenge_id = ?', status, id)
    else this.sql.exec('UPDATE challenges SET status = ?, ended_at = ? WHERE challenge_id = ?', status, at, id)
  }

  /** Writes a participant's answer, start or finish */
  updatePlayer(id: string, player: ChallengePlayer) {
    this.sql.exec(
      `UPDATE challenge_players SET status = ?, invited_at = ?, answered_at = ?, started_at = ?, finish_by = ?,
        finished_at = ?, known_deals = ? WHERE challenge_id = ? AND user_id = ?`,
      ...this.playerValues(player),
      id,
      player.userId,
    )
  }

  /** Keeps one board's result; a board is played only once, so a second result for it throws */
  addResult(id: string, result: ChallengeResult) {
    this.sql.exec(
      `INSERT INTO challenge_results (challenge_id, user_id, seq, board_id, score_ns, played_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      result.userId,
      result.seq,
      result.boardId,
      result.scoreNS,
      result.playedAt,
    )
  }

  /**
   * A deleted account leaves every challenge still going: their place and results are removed, and
   * one left with fewer than two participants (who have not declined) is cancelled. Challenges that
   * already ended keep them, so final standings never change. Returns the challenges it changed
   */
  forget(userId: string, now: number): string[] {
    return this.sql.transaction(() => {
      const ids = this.sql
        .exec<{ challenge_id: string }>(
          `SELECT c.challenge_id FROM challenge_players p JOIN challenges c ON c.challenge_id = p.challenge_id
           WHERE p.user_id = ? AND c.status IN ${OPEN}`,
          userId,
        )
        .map((r) => r.challenge_id)
      for (const id of ids) {
        this.sql.exec('DELETE FROM challenge_results WHERE challenge_id = ? AND user_id = ?', id, userId)
        this.sql.exec('DELETE FROM challenge_players WHERE challenge_id = ? AND user_id = ?', id, userId)
        const left = this.sql.exec<{ n: number }>(
          "SELECT COUNT(*) AS n FROM challenge_players WHERE challenge_id = ? AND status <> 'declined'",
          id,
        )[0].n
        if (left < 2) this.setStatus(id, 'cancelled', now)
      }
      return ids
    })
  }
}
