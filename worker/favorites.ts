import type { Favorite, FavoriteTag } from '../shared/protocol.ts'
import type { Sql, SqlValue } from './store.ts'

/**
 * Members' favorites (AC-4.4, ARCHITECTURE.md §5.3) in the SQL tables next to the history index
 * (`favorites`, `favorite_tags`, created with it in `createHistoryIndex`). Only the member's own
 * rows are ever read: no query here takes another member's id. Whether a board may be kept at all
 * is the service's call (`recordVisible`); lists go through `searchBoards`, which keeps boards that
 * are not revealed yet out as it does for history.
 */

interface FavoriteRow extends Record<string, SqlValue> {
  board_id: string
  note: string
  tags: string
  created_at: number
  updated_at: number
}

const toFavorite = (row: FavoriteRow): Favorite => ({
  boardId: row.board_id,
  note: row.note,
  tags: JSON.parse(row.tags) as string[],
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const COLUMNS = 'board_id, note, tags, created_at, updated_at'

export function getFavorite(sql: Sql, userId: string, boardId: string): Favorite | null {
  const row = sql.exec<FavoriteRow>(`SELECT ${COLUMNS} FROM favorites WHERE user_id = ? AND board_id = ?`, userId, boardId)[0]
  return row ? toFavorite(row) : null
}

/**
 * The member's favorites among these boards, by board id (for one page of the list). One lookup
 * each: a Durable Object query takes at most 100 bound parameters, and a page can hold 100 boards
 */
export function favoritesAmong(sql: Sql, userId: string, boardIds: string[]): Map<string, Favorite> {
  const found = new Map<string, Favorite>()
  for (const id of boardIds) {
    const favorite = getFavorite(sql, userId, id)
    if (favorite) found.set(id, favorite)
  }
  return found
}

/** Every board the member keeps, newest favorite first (the star buttons read this once) */
export function favoriteIds(sql: Sql, userId: string): string[] {
  return sql
    .exec<{ board_id: string }>('SELECT board_id FROM favorites WHERE user_id = ? ORDER BY created_at DESC, board_id', userId)
    .map((row) => row.board_id)
}

export function countFavorites(sql: Sql, userId: string): number {
  return sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM favorites WHERE user_id = ?', userId)[0].n
}

/** The member's tags with how many favorites carry each, most used first */
export function favoriteTags(sql: Sql, userId: string): FavoriteTag[] {
  return sql.exec<{ tag: string; n: number }>(
    'SELECT tag, COUNT(*) AS n FROM favorite_tags WHERE user_id = ? GROUP BY tag ORDER BY n DESC, tag',
    userId,
  ).map((row) => ({ tag: row.tag, count: row.n }))
}

/** Adds a favorite or changes its note and tags (already checked by `checkFavorite`), in one transaction */
export function saveFavorite(sql: Sql, userId: string, boardId: string, note: string, tags: string[], now: number): Favorite {
  return sql.transaction(() => {
    const createdAt = getFavorite(sql, userId, boardId)?.createdAt ?? now
    sql.exec(
      `INSERT OR REPLACE INTO favorites (user_id, board_id, note, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      userId,
      boardId,
      note,
      JSON.stringify(tags),
      createdAt,
      now,
    )
    sql.exec('DELETE FROM favorite_tags WHERE user_id = ? AND board_id = ?', userId, boardId)
    for (const tag of tags) sql.exec('INSERT INTO favorite_tags (user_id, tag, board_id) VALUES (?, ?, ?)', userId, tag, boardId)
    return { boardId, note, tags, createdAt, updatedAt: now }
  })
}

export function removeFavorite(sql: Sql, userId: string, boardId: string) {
  sql.transaction(() => {
    sql.exec('DELETE FROM favorite_tags WHERE user_id = ? AND board_id = ?', userId, boardId)
    sql.exec('DELETE FROM favorites WHERE user_id = ? AND board_id = ?', userId, boardId)
  })
}

/** A deleted account's favorites go with it */
export function removeFavoritesOf(sql: Sql, userId: string) {
  sql.transaction(() => {
    sql.exec('DELETE FROM favorite_tags WHERE user_id = ?', userId)
    sql.exec('DELETE FROM favorites WHERE user_id = ?', userId)
  })
}
