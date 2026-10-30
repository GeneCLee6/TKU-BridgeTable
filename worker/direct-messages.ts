import { DIRECT_CONVERSATIONS_SHOWN, DIRECT_KEPT, DIRECT_PAGE_SIZE, type DirectMessage, type DirectPage } from '../shared/protocol.ts'
import type { Sql, SqlValue } from './store.ts'

/**
 * Direct messages (私訊, AC-1.7) in the Durable Object's SQLite database (ARCHITECTURE.md §5.7).
 * `direct_messages` holds every message, keyed by the pair of members; `direct_threads` has one
 * row per member per conversation with the newest message and how far they have read, so the
 * conversation list and unread counts are one query. Nothing is cached in memory.
 *
 * This class only stores: who may write to whom (blocks, rate, length) is `ClubService`'s job.
 */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS direct_messages (
    id INTEGER PRIMARY KEY,
    pair TEXT NOT NULL,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    text TEXT NOT NULL,
    at INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS direct_messages_by_pair ON direct_messages (pair, id)',
  `CREATE TABLE IF NOT EXISTS direct_threads (
    user_id TEXT NOT NULL,
    other_id TEXT NOT NULL,
    last_id INTEGER NOT NULL,
    read_id INTEGER NOT NULL,
    PRIMARY KEY (user_id, other_id)
  ) WITHOUT ROWID`,
  'CREATE INDEX IF NOT EXISTS direct_threads_by_user ON direct_threads (user_id, last_id)',
]

interface MessageRow extends Record<string, SqlValue> {
  id: number
  from_id: string
  to_id: string
  text: string
  at: number
}

const COLUMNS = 'id, from_id, to_id, text, at'

const toMessage = (row: MessageRow): DirectMessage => ({
  id: row.id,
  from: row.from_id,
  to: row.to_id,
  text: row.text,
  at: row.at,
})

/** The same key whoever writes first */
export const pairOf = (a: string, b: string) => (a < b ? `${a}:${b}` : `${b}:${a}`)

export interface ConversationRow {
  otherId: string
  last: DirectMessage
  unread: number
}

export class DirectMessageStore {
  private readonly sql: Sql

  constructor(sql: Sql) {
    this.sql = sql
  }

  createTables() {
    for (const statement of SCHEMA) this.sql.exec(statement)
  }

  /** Stores a message; the sender has read it, the recipient has not. Older than DIRECT_KEPT in the pair are dropped */
  add(from: string, to: string, text: string, at: number): DirectMessage {
    return this.sql.transaction(() => {
      const pair = pairOf(from, to)
      const [row] = this.sql.exec<MessageRow>(
        `INSERT INTO direct_messages (pair, from_id, to_id, text, at) VALUES (?, ?, ?, ?, ?) RETURNING ${COLUMNS}`,
        pair,
        from,
        to,
        text,
        at,
      )
      const message = toMessage(row)
      this.sql.exec(
        `INSERT INTO direct_threads (user_id, other_id, last_id, read_id) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id, other_id) DO UPDATE SET last_id = excluded.last_id, read_id = excluded.read_id`,
        from,
        to,
        message.id,
        message.id,
      )
      this.sql.exec(
        `INSERT INTO direct_threads (user_id, other_id, last_id, read_id) VALUES (?, ?, ?, 0)
         ON CONFLICT (user_id, other_id) DO UPDATE SET last_id = excluded.last_id`,
        to,
        from,
        message.id,
      )
      const [oldest] = this.sql.exec<{ id: number }>(
        'SELECT id FROM direct_messages WHERE pair = ? ORDER BY id DESC LIMIT 1 OFFSET ?',
        pair,
        DIRECT_KEPT,
      )
      if (oldest) this.sql.exec('DELETE FROM direct_messages WHERE pair = ? AND id <= ?', pair, oldest.id)
      return message
    })
  }

  /** Up to DIRECT_PAGE_SIZE messages between the two before message `before` (newest when left out), oldest first */
  page(userId: string, otherId: string, before?: number): DirectPage {
    const rows = this.sql.exec<MessageRow>(
      `SELECT ${COLUMNS} FROM direct_messages WHERE pair = ? AND id < ? ORDER BY id DESC LIMIT ?`,
      pairOf(userId, otherId),
      before ?? Number.MAX_SAFE_INTEGER,
      DIRECT_PAGE_SIZE + 1,
    )
    return { messages: rows.slice(0, DIRECT_PAGE_SIZE).reverse().map(toMessage), more: rows.length > DIRECT_PAGE_SIZE }
  }

  /** Every message the member sent or received that is still kept, oldest first (their data export, e11-t27) */
  everyMessage(userId: string): DirectMessage[] {
    return this.sql
      .exec<MessageRow>(`SELECT ${COLUMNS} FROM direct_messages WHERE from_id = ? OR to_id = ? ORDER BY id`, userId, userId)
      .map(toMessage)
  }

  /** Marks everything the other member sent read; false when nothing was unread */
  markRead(userId: string, otherId: string): boolean {
    const [thread] = this.sql.exec<{ last_id: number; read_id: number }>(
      'SELECT last_id, read_id FROM direct_threads WHERE user_id = ? AND other_id = ?',
      userId,
      otherId,
    )
    if (!thread || thread.read_id >= thread.last_id) return false
    this.sql.exec('UPDATE direct_threads SET read_id = last_id WHERE user_id = ? AND other_id = ?', userId, otherId)
    return true
  }

  /** The member's conversations, newest first, each with its newest message and unread count */
  conversations(userId: string): ConversationRow[] {
    const rows = this.sql.exec<MessageRow & { other_id: string; unread: number }>(
      `SELECT t.other_id, m.id, m.from_id, m.to_id, m.text, m.at,
        (SELECT COUNT(*) FROM direct_messages u WHERE u.pair = m.pair AND u.to_id = ? AND u.id > t.read_id) AS unread
       FROM direct_threads t JOIN direct_messages m ON m.id = t.last_id
       WHERE t.user_id = ? ORDER BY t.last_id DESC LIMIT ?`,
      userId,
      userId,
      DIRECT_CONVERSATIONS_SHOWN,
    )
    return rows.map((row) => ({ otherId: row.other_id, last: toMessage(row), unread: row.unread }))
  }

  /** Every unread message the member has, in all conversations (not only the ones listed) */
  unread(userId: string): number {
    const [row] = this.sql.exec<{ unread: number }>(
      `SELECT COUNT(*) AS unread FROM direct_threads t JOIN direct_messages m
         ON m.pair = CASE WHEN t.user_id < t.other_id THEN t.user_id || ':' || t.other_id ELSE t.other_id || ':' || t.user_id END
        AND m.to_id = t.user_id AND m.id > t.read_id
       WHERE t.user_id = ?`,
      userId,
    )
    return row?.unread ?? 0
  }

  /** The members a deleted account had conversations with; their messages and threads go too */
  forget(userId: string): string[] {
    return this.sql.transaction(() => {
      const others = this.sql
        .exec<{ other_id: string }>('SELECT other_id FROM direct_threads WHERE user_id = ?', userId)
        .map((row) => row.other_id)
      this.sql.exec('DELETE FROM direct_messages WHERE from_id = ? OR to_id = ?', userId, userId)
      this.sql.exec('DELETE FROM direct_threads WHERE user_id = ? OR other_id = ?', userId, userId)
      return others
    })
  }
}
