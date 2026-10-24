import { SEATS, sideOf } from '../shared/cards.ts'
import { isRobotId, type BoardRecord } from '../shared/protocol.ts'
import type { Sql } from './store.ts'

/**
 * The history index in the Durable Object's SQLite database (ARCHITECTURE.md §5.3): one row per
 * board in `boards_index` and one per seat in `board_players`, so history can be filtered by
 * contract, declarer, players and partners. The full record stays in `board:<id>`; these tables
 * hold only what queries need and can always be rebuilt from the records.
 */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS boards_index (
    board_id TEXT PRIMARY KEY,
    played_at INTEGER NOT NULL,
    table_no INTEGER NOT NULL,
    mode TEXT NOT NULL,
    event_id TEXT,
    board_no INTEGER NOT NULL,
    dealer TEXT NOT NULL,
    vul TEXT NOT NULL,
    level INTEGER,
    strain TEXT,
    doubled INTEGER NOT NULL,
    declarer_seat TEXT,
    declarer_user TEXT,
    tricks INTEGER,
    score_ns INTEGER NOT NULL,
    claimed INTEGER NOT NULL,
    reveal_at INTEGER
  )`,
  'CREATE INDEX IF NOT EXISTS boards_by_time ON boards_index (played_at, board_id)',
  'CREATE INDEX IF NOT EXISTS boards_by_contract ON boards_index (level, strain, played_at)',
  'CREATE INDEX IF NOT EXISTS boards_by_declarer ON boards_index (declarer_user, played_at)',
  `CREATE TABLE IF NOT EXISTS board_players (
    board_id TEXT NOT NULL,
    seat TEXT NOT NULL,
    side TEXT NOT NULL,
    user_id TEXT,
    PRIMARY KEY (board_id, seat)
  ) WITHOUT ROWID`,
  'CREATE INDEX IF NOT EXISTS players_by_user ON board_players (user_id, board_id)',
]

/** Creates the tables and indexes if they are missing; safe to run on every load */
export function createHistoryIndex(sql: Sql) {
  sql.transaction(() => {
    for (const statement of SCHEMA) sql.exec(statement)
  })
}

/** A member's id, or null for a robot or an empty seat */
const memberId = (id: string | undefined) => (id && !isRobotId(id) ? id : null)

const DOUBLED = { '': 0, X: 1, XX: 2 } as const

/** Writes (or rewrites) one board's rows in one transaction; running it twice changes nothing */
export function indexRecord(sql: Sql, record: BoardRecord) {
  const { board } = record
  const contract = board.contract
  sql.transaction(() => {
    sql.exec(
      `INSERT OR REPLACE INTO boards_index (board_id, played_at, table_no, mode, event_id, board_no, dealer, vul,
        level, strain, doubled, declarer_seat, declarer_user, tricks, score_ns, claimed, reveal_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.id,
      record.finishedAt,
      record.tableNumber,
      // Every board so far is from a casual table; other modes will record theirs
      'casual',
      null,
      board.boardNo,
      board.dealer,
      board.vul,
      contract?.level ?? null,
      contract?.strain ?? null,
      contract ? DOUBLED[contract.doubled] : 0,
      contract?.declarer ?? null,
      contract ? memberId(record.players[contract.declarer]?.id) : null,
      contract ? (board.result?.declarerTricks ?? null) : null,
      board.result?.scoreNS ?? 0,
      board.result?.claimed ? 1 : 0,
      null,
    )
    sql.exec('DELETE FROM board_players WHERE board_id = ?', record.id)
    for (const seat of SEATS)
      sql.exec(
        'INSERT INTO board_players (board_id, seat, side, user_id) VALUES (?, ?, ?, ?)',
        record.id,
        seat,
        sideOf(seat),
        memberId(record.players[seat]?.id),
      )
  })
}

export function unindexRecord(sql: Sql, boardId: string) {
  sql.transaction(() => {
    sql.exec('DELETE FROM board_players WHERE board_id = ?', boardId)
    sql.exec('DELETE FROM boards_index WHERE board_id = ?', boardId)
  })
}

const ids = (rows: { board_id: string }[]) => rows.map((row) => row.board_id)

/** Boards a member played, newest first */
export function boardsPlayedBy(sql: Sql, userId: string): string[] {
  return ids(
    sql.exec(
      `SELECT b.board_id FROM board_players p JOIN boards_index b ON b.board_id = p.board_id
       WHERE p.user_id = ? ORDER BY b.played_at DESC, b.board_id DESC`,
      userId,
    ),
  )
}

/**
 * Boards a member played with another one, newest first: as partners (the same side) or, with
 * `partners` false, anywhere at the same table
 */
export function boardsPlayedWith(sql: Sql, userId: string, otherId: string, partners: boolean): string[] {
  return ids(
    sql.exec(
      `SELECT DISTINCT b.board_id, b.played_at FROM board_players me
       JOIN board_players other ON other.board_id = me.board_id AND other.seat <> me.seat
       JOIN boards_index b ON b.board_id = me.board_id
       WHERE me.user_id = ? AND other.user_id = ? AND (? = 0 OR other.side = me.side)
       ORDER BY b.played_at DESC, b.board_id DESC`,
      userId,
      otherId,
      partners ? 1 : 0,
    ),
  )
}
