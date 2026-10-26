import type { Contract } from '../shared/auction.ts'
import { SEATS, sideOf, type Card, type Seat, type Strain } from '../shared/cards.ts'
import {
  DAY_MS,
  DEFAULT_HISTORY_QUERY,
  TAIWAN_OFFSET_MS,
  taiwanDayEnd,
  taiwanDayStart,
  type HistoryQuery,
  type HistorySort,
} from '../shared/history-query.ts'
import { HISTORY_PAGE_SIZES, isRobotId, LIMITS, type BoardRecord, type HistoryDay } from '../shared/protocol.ts'
import type { Sql, SqlValue } from './store.ts'

/**
 * The history index in the Durable Object's SQLite database (ARCHITECTURE.md §5.3): one row per
 * board in `boards_index` and one per seat in `board_players`, so history can be filtered by
 * contract, declarer, players and partners. The full record stays in `board:<id>`; these tables
 * hold only what queries need and can always be rebuilt from the records.
 */

/** The index tables themselves: the same in the club's SQLite and in the D1 copy (§5.12) */
export const INDEX_SCHEMA = [
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
  // A challenge's travellers and bringing its boards forward when it ends (§5.5)
  'CREATE INDEX IF NOT EXISTS boards_by_event ON boards_index (event_id)',
  `CREATE TABLE IF NOT EXISTS board_players (
    board_id TEXT NOT NULL,
    seat TEXT NOT NULL,
    side TEXT NOT NULL,
    user_id TEXT,
    PRIMARY KEY (board_id, seat)
  ) WITHOUT ROWID`,
  'CREATE INDEX IF NOT EXISTS players_by_user ON board_players (user_id, board_id)',
]

const SCHEMA = [
  ...INDEX_SCHEMA,
  // Favorites (AC-4.4, `worker/favorites.ts`): one row per member and board, the tags again one
  // row each so searches can filter by them
  `CREATE TABLE IF NOT EXISTS favorites (
    user_id TEXT NOT NULL,
    board_id TEXT NOT NULL,
    note TEXT NOT NULL,
    tags TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, board_id)
  ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS favorite_tags (
    user_id TEXT NOT NULL,
    tag TEXT NOT NULL COLLATE NOCASE,
    board_id TEXT NOT NULL,
    PRIMARY KEY (user_id, tag, board_id)
  ) WITHOUT ROWID`,
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

/** The columns of `boards_index`, in the order `indexRow` gives their values */
export const INDEX_COLUMNS = [
  'board_id',
  'played_at',
  'table_no',
  'mode',
  'event_id',
  'board_no',
  'dealer',
  'vul',
  'level',
  'strain',
  'doubled',
  'declarer_seat',
  'declarer_user',
  'tricks',
  'score_ns',
  'claimed',
  'reveal_at',
] as const

/** One `board_players` row: board id, seat, side, member id (null for a robot or an empty seat) */
export type PlayerRow = [string, string, string, string | null]

/**
 * One board's rows: its `boards_index` values (in INDEX_COLUMNS order) and one `board_players` row
 * per seat. The club's own index and the D1 copy (`worker/history-replica.ts`) write the same rows
 */
export function indexRow(record: BoardRecord): { board: SqlValue[]; players: PlayerRow[] } {
  const { board } = record
  const contract = board.contract
  return {
    board: [
      record.id,
      record.finishedAt,
      record.tableNumber,
      record.mode ?? 'casual',
      record.eventId ?? null,
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
      record.revealAt ?? null,
    ],
    players: SEATS.map((seat): PlayerRow => [record.id, seat, sideOf(seat), memberId(record.players[seat]?.id)]),
  }
}

/** Writes (or rewrites) one board's rows in one transaction; running it twice changes nothing */
export function indexRecord(sql: Sql, record: BoardRecord) {
  const { board, players } = indexRow(record)
  sql.transaction(() => {
    sql.exec(
      `INSERT OR REPLACE INTO boards_index (${INDEX_COLUMNS.join(', ')}) VALUES (${INDEX_COLUMNS.map(() => '?').join(', ')})`,
      ...board,
    )
    sql.exec('DELETE FROM board_players WHERE board_id = ?', record.id)
    for (const row of players) sql.exec('INSERT INTO board_players (board_id, seat, side, user_id) VALUES (?, ?, ?, ?)', ...row)
  })
}

export function unindexRecord(sql: Sql, boardId: string) {
  sql.transaction(() => {
    sql.exec('DELETE FROM board_players WHERE board_id = ?', boardId)
    sql.exec('DELETE FROM boards_index WHERE board_id = ?', boardId)
  })
}

const ids = (rows: { board_id: string }[]) => rows.map((row) => row.board_id)

/** What a challenge's traveller shows of one board, read from the index */
export interface EventBoard {
  contract: Contract | null
  declarerTricks: number | null
  /**
   * The opening lead, which the index does not keep: read from the record when the results page
   * asks for it (`ClubService.challengeDetail`), absent otherwise
   */
  lead?: Card | null
}

interface EventRow extends Record<string, SqlValue> {
  board_id: string
  level: number | null
  strain: string | null
  doubled: number
  declarer_seat: string | null
  tricks: number | null
}

const DOUBLED_TEXT = ['', 'X', 'XX'] as const

/** The boards of a challenge or match (`event_id`), by board id: contract and tricks for its travellers */
export function eventBoards(sql: Sql, eventId: string): Map<string, EventBoard> {
  const rows = sql.exec<EventRow>(
    'SELECT board_id, level, strain, doubled, declarer_seat, tricks FROM boards_index WHERE event_id = ?',
    eventId,
  )
  return new Map(
    rows.map((r) => [
      r.board_id,
      {
        contract:
          r.level === null || r.strain === null || r.declarer_seat === null
            ? null
            : {
                level: r.level,
                strain: r.strain as Strain,
                doubled: DOUBLED_TEXT[r.doubled] ?? '',
                declarer: r.declarer_seat as Seat,
              },
        declarerTricks: r.tricks,
      },
    ]),
  )
}

/**
 * Shows some boards from `at` on (a team match board once both rooms played it, §5.8): each of
 * them still kept back later than that is brought forward. Returns the ids changed, for their
 * records to follow
 */
export function revealBoards(sql: Sql, boardIds: string[], at: number): string[] {
  return sql.transaction(() =>
    boardIds.filter((id) => {
      const held = sql.exec<{ board_id: string }>('SELECT board_id FROM boards_index WHERE board_id = ? AND reveal_at > ?', id, at)
      if (!held.length) return false
      sql.exec('UPDATE boards_index SET reveal_at = ? WHERE board_id = ?', at, id)
      return true
    }),
  )
}

/**
 * Shows an event's boards from `at` on, once it ended (§5.5): every board of it still kept back
 * later than that is brought forward. Returns the ids changed, for their records to follow
 */
export function revealEvent(sql: Sql, eventId: string, at: number): string[] {
  return sql.transaction(() => {
    const changed = ids(
      sql.exec<{ board_id: string }>(
        'SELECT board_id FROM boards_index WHERE event_id = ? AND reveal_at > ?',
        eventId,
        at,
      ),
    )
    sql.exec('UPDATE boards_index SET reveal_at = ? WHERE event_id = ? AND reveal_at > ?', at, eventId, at)
    return changed
  })
}

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

// ── Search ─────────────────────────────────────────────────────────────────────────────────────

/** The declarer's side, for "my partner declared" and "the opponents declared" */
const DECLARER_SIDE = "CASE WHEN b.declarer_seat IN ('N', 'S') THEN 'NS' ELSE 'EW' END"
const GAME = "((b.strain = 'N' AND b.level >= 3) OR (b.strain IN ('H', 'S') AND b.level >= 4) OR b.level >= 5)"
const SEATED = (who: string) => `EXISTS (SELECT 1 FROM board_players ${who} WHERE ${who}.board_id = b.board_id AND ${who}.user_id = ?)`

const ORDER: Record<HistorySort, string> = {
  date_desc: 'b.played_at DESC, b.board_id DESC',
  date_asc: 'b.played_at ASC, b.board_id ASC',
  score_desc: 'b.score_ns DESC, b.played_at DESC, b.board_id DESC',
  score_asc: 'b.score_ns ASC, b.played_at DESC, b.board_id DESC',
  // Passed-out boards have no tricks: they go last either way
  tricks_desc: 'b.tricks IS NULL, b.tricks DESC, b.played_at DESC, b.board_id DESC',
  tricks_asc: 'b.tricks IS NULL, b.tricks ASC, b.played_at DESC, b.board_id DESC',
}

/**
 * The WHERE clause of a search and its parameters. Every value goes in as a `?` parameter; only
 * fixed pieces of SQL are joined into the text. Boards still kept back (`reveal_at` in the future)
 * are left out unless the member asking played them, whatever the search (AC-4.9)
 */
function where(query: HistoryQuery, viewer: string, now: number, favorites: boolean): [string, SqlValue[]] {
  const parts: string[] = [`(b.reveal_at IS NULL OR b.reveal_at <= ? OR ${SEATED('v')})`]
  const params: SqlValue[] = [now, viewer]
  const add = (part: string, ...values: SqlValue[]) => {
    parts.push(part)
    params.push(...values)
  }
  if (favorites)
    add('EXISTS (SELECT 1 FROM favorites f WHERE f.user_id = ? AND f.board_id = b.board_id)', viewer)
  else if (query.scope === 'mine') add(SEATED('m'), viewer)
  if (query.tag)
    add(
      'EXISTS (SELECT 1 FROM favorite_tags ft WHERE ft.user_id = ? AND ft.tag = ? AND ft.board_id = b.board_id)',
      viewer,
      query.tag,
    )
  if (query.level !== undefined) add('b.level = ?', query.level)
  if (query.strain) add('b.strain = ?', query.strain)
  if (query.doubled === 'undoubled') add('b.level IS NOT NULL AND b.doubled = 0')
  if (query.doubled === 'X') add('b.doubled = 1')
  if (query.doubled === 'XX') add('b.doubled = 2')
  if (query.doubled === 'doubled') add('b.doubled > 0')
  if (query.bracket === 'passout') add('b.level IS NULL')
  if (query.bracket === 'partial') add(`b.level IS NOT NULL AND NOT ${GAME}`)
  if (query.bracket === 'game') add(`${GAME} AND b.level < 6`)
  if (query.bracket === 'slam') add('b.level = 6')
  if (query.bracket === 'grand') add('b.level = 7')
  if (query.declarer) add('b.declarer_user = ?', query.declarer)
  if (query.declarerSeat) add('b.declarer_seat = ?', query.declarerSeat)
  if (query.declarerSide === 'me') add('b.declarer_user = ?', viewer)
  if (query.declarerSide === 'partner')
    add(
      `b.declarer_seat IS NOT NULL AND EXISTS (SELECT 1 FROM board_players p WHERE p.board_id = b.board_id
        AND p.user_id = ? AND p.side = ${DECLARER_SIDE} AND p.seat <> b.declarer_seat)`,
      viewer,
    )
  if (query.declarerSide === 'opponents')
    add(
      `b.declarer_seat IS NOT NULL AND EXISTS (SELECT 1 FROM board_players p WHERE p.board_id = b.board_id
        AND p.user_id = ? AND p.side <> ${DECLARER_SIDE})`,
      viewer,
    )
  if (query.player) add(SEATED('x'), query.player)
  if (query.partner)
    add(
      `EXISTS (SELECT 1 FROM board_players me JOIN board_players other
        ON other.board_id = me.board_id AND other.side = me.side AND other.seat <> me.seat
        WHERE me.board_id = b.board_id AND me.user_id = ? AND other.user_id = ?)`,
      viewer,
      query.partner,
    )
  if (query.from) add('b.played_at >= ?', taiwanDayStart(query.from))
  if (query.to) add('b.played_at < ?', taiwanDayEnd(query.to))
  if (query.result === 'made') add('b.level IS NOT NULL AND b.tricks >= b.level + 6')
  if (query.result === 'down') add('b.level IS NOT NULL AND b.tricks < b.level + 6')
  if (query.result === 'overtricks') add('b.level IS NOT NULL AND b.tricks > b.level + 6')
  if (query.vul) add('b.vul = ?', query.vul)
  if (query.boardNo !== undefined) add('b.board_no = ?', query.boardNo)
  if (query.table !== undefined) add('b.table_no = ?', query.table)
  if (query.mode) add('b.mode = ?', query.mode)
  // Practice boards (§5.11) stay out of the club's list, and so of profile cards, unless asked for
  else if (query.scope === 'all' && !favorites) add("b.mode <> 'practice'")
  return [parts.join(' AND '), params]
}

/** A statement and its `?` parameters */
export interface Statement {
  sql: string
  params: SqlValue[]
}

/**
 * The two statements of a search: how many boards match, and one page of them (`columns` of
 * `boards_index b`, in order). The club's index and the D1 copy run the same SQL
 */
export function searchStatements(
  query: HistoryQuery,
  viewer: string,
  now: number,
  favorites: boolean,
  columns = 'b.board_id',
): { count: Statement; page: (page: number) => Statement } {
  const [condition, params] = where(query, viewer, now, favorites)
  return {
    count: { sql: `SELECT COUNT(*) AS n FROM boards_index b WHERE ${condition}`, params },
    page: (page) => ({
      sql: `SELECT ${columns} FROM boards_index b WHERE ${condition} ORDER BY ${ORDER[query.sort]} LIMIT ? OFFSET ?`,
      params: [...params, query.size, (page - 1) * query.size],
    }),
  }
}

/**
 * How many boards a search finds per Taiwan date, newest day first, at most LIMITS.historyDaysMax
 * days (`sort`, `page` and `size` play no part). The same WHERE as the search, so boards kept back
 * count only for their own players. The club's index and the D1 copy run the same SQL
 */
export function dayStatement(query: HistoryQuery, viewer: string, now: number): Statement {
  const [condition, params] = where(query, viewer, now, false)
  return {
    sql: `SELECT (b.played_at + ${TAIWAN_OFFSET_MS}) / ${DAY_MS} AS day, COUNT(*) AS n FROM boards_index b
      WHERE ${condition} GROUP BY day ORDER BY day DESC LIMIT ?`,
    params: [...params, LIMITS.historyDaysMax],
  }
}

/** The rows of `dayStatement` as dates and counts */
export const dayRows = (rows: Record<string, SqlValue>[]): HistoryDay[] =>
  rows.map((row) => ({ date: new Date(Number(row.day) * DAY_MS).toISOString().slice(0, 10), count: Number(row.n) }))

/** How many boards a search finds per Taiwan date, from the club's index (`dayStatement`) */
export function searchDays(sql: Sql, query: HistoryQuery, viewer: string, now: number): HistoryDay[] {
  const { sql: text, params } = dayStatement(query, viewer, now)
  return dayRows(sql.exec(text, ...params))
}

/** The page shown for a search with `total` matches: a page past the end shows the last one */
export const shownPage = (query: HistoryQuery, total: number) => Math.min(query.page, Math.max(1, Math.ceil(total / query.size)))

/**
 * One page of a search: the board ids in order, how many boards match, and the page shown (a page
 * past the end shows the last one). With `favorites`, only the viewer's favorites, whoever played
 * them (`scope` is then ignored); boards kept back stay out all the same
 */
export function searchBoards(
  sql: Sql,
  query: HistoryQuery,
  viewer: string,
  now: number,
  favorites = false,
): { ids: string[]; total: number; page: number } {
  const statements = searchStatements(query, viewer, now, favorites)
  const total = sql.exec<{ n: number }>(statements.count.sql, ...statements.count.params)[0].n
  const page = shownPage(query, total)
  const { sql: text, params } = statements.page(page)
  return { ids: ids(sql.exec<{ board_id: string }>(text, ...params)), total, page }
}

/**
 * The query of the plain history list (`GET /api/history`): everyone's boards or the member's own,
 * newest first, one page of `size` (one of HISTORY_PAGE_SIZES, else the default)
 */
export function listQuery(all: boolean, page: number, size: number): HistoryQuery {
  return {
    ...DEFAULT_HISTORY_QUERY,
    scope: all ? 'all' : 'mine',
    page: Math.max(1, Math.floor(page) || 1),
    size: (HISTORY_PAGE_SIZES as readonly number[]).includes(size) ? size : LIMITS.historyPageDefault,
  }
}
