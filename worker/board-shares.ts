import { SEATS } from '../shared/cards.ts'
import { isRobotId, LIMITS, type BoardRecord, type BoardShare, type PublicUser, type SharedBoard } from '../shared/protocol.ts'
import { FailureWindow, TokenBuckets } from './rate-limit.ts'
import { ClubError } from './service.ts'
import type { Sql, SqlValue } from './store.ts'
import { sharedBoardView } from './views.ts'

/**
 * Exports and public links of finished boards (ARCHITECTURE.md §4, §5.3):
 *
 * - **A session** (e4-t37, `sessionOf`): the boards played one after another at one table, for
 *   one LIN file.
 * - **Public links** (e4-t38, `BoardShares`): a board's players and the admins make a link with a
 *   random token (`board_shares`, one per board), which shows that one board to anyone, signed in
 *   or not (`sharedBoardView`), until one of them takes it back. Only a board already public may
 *   be shared (`revealAt` passed or none); each read checks it again. Looking a token up is rate
 *   limited per network address, wrong tokens more strictly, so tokens cannot be guessed.
 *
 * Like `ClubService` this never touches a Cloudflare API.
 */

// ── Sessions (e4-t37) ──────────────────────────────────────────────────────────────────────────

/** How far before and after a board its session's boards are looked for */
export const SESSION_WINDOW_MS = 12 * 3600_000
/** Boards more than this far apart (one finished to the next finished) are not one session */
export const SESSION_GAP_MS = 60 * 60_000

const members = (record: BoardRecord) => SEATS.flatMap((seat) => (record.players[seat]?.id && !isRobotId(record.players[seat].id) ? [record.players[seat].id] : []))

/**
 * The session of `target` among `candidates` (`sessionCandidates`, any order): the boards of the
 * same table (`tableId`; a record from before it, one without it that a member of `target` played),
 * each finished at most SESSION_GAP_MS after the one before, oldest first, at most
 * LIMITS.sessionBoardsMax around `target`
 */
export function sessionOf(target: BoardRecord, candidates: readonly BoardRecord[]): BoardRecord[] {
  const mine = members(target)
  const same = (r: BoardRecord) =>
    target.tableId ? r.tableId === target.tableId : !r.tableId && members(r).some((id) => mine.includes(id))
  const list = [target, ...candidates.filter((r) => r.id !== target.id && same(r))].sort(
    (a, b) => a.finishedAt - b.finishedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
  const at = list.indexOf(target)
  let start = at
  let end = at
  while (start > 0 && list[start].finishedAt - list[start - 1].finishedAt <= SESSION_GAP_MS) start--
  while (end < list.length - 1 && list[end + 1].finishedAt - list[end].finishedAt <= SESSION_GAP_MS) end++
  const max = LIMITS.sessionBoardsMax
  const from = Math.max(start, Math.min(at, end + 1 - max))
  return list.slice(from, Math.min(end + 1, from + max))
}

// ── Public links (e4-t38) ──────────────────────────────────────────────────────────────────────

/** A share token: 128 random bits as hex */
export const SHARE_TOKEN = /^[0-9a-f]{32}$/
/** Token lookups per network address: 30 at once, then one every 2 seconds */
export const SHARE_LOOKUP_BURST = 30
export const SHARE_LOOKUPS_PER_SECOND = 0.5
/** Wrong or revoked tokens per network address: 10, then wait 15 minutes */
export const SHARE_MISSES = 10
export const SHARE_MISS_WINDOW_MS = 15 * 60_000

interface ShareRow extends Record<string, SqlValue> {
  token: string
  board_id: string
  created_by: string
  created_at: number
}

export interface BoardSharesDeps {
  now: () => number
  newToken: () => string
  /** The board's record, if there is one (whoever asks) */
  record: (boardId: string) => Promise<BoardRecord | undefined>
  /** The board's record if this member may see it (`ClubService.record`), else null */
  visibleRecord: (boardId: string, userId: string) => Promise<BoardRecord | null>
  isAdmin: (userId: string) => boolean
  /** Whether a member keeps their boards off their profile (「不公開打過的牌局」, e13-t08) */
  hidesBoards: (userId: string) => boolean
  userById: (id: string) => PublicUser | undefined
}

const GONE: PublicUser = { id: '', username: '—' }

export class BoardShares {
  private readonly sql: Sql
  private readonly deps: BoardSharesDeps
  private readonly lookups: TokenBuckets
  private readonly misses: FailureWindow

  constructor(sql: Sql, deps: BoardSharesDeps) {
    this.sql = sql
    this.deps = deps
    this.lookups = new TokenBuckets(SHARE_LOOKUP_BURST, SHARE_LOOKUPS_PER_SECOND, deps.now)
    this.misses = new FailureWindow(SHARE_MISSES, SHARE_MISS_WINDOW_MS, deps.now)
  }

  /** The table, created on every load; one link per board */
  createTables() {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS board_shares (
      token TEXT PRIMARY KEY,
      board_id TEXT NOT NULL UNIQUE,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) WITHOUT ROWID`)
  }

  private row(boardId: string): ShareRow | undefined {
    return this.sql.exec<ShareRow>('SELECT token, board_id, created_by, created_at FROM board_shares WHERE board_id = ?', boardId)[0]
  }

  private view(row: ShareRow): BoardShare {
    return { token: row.token, createdAt: row.created_at, createdBy: this.deps.userById(row.created_by) ?? GONE }
  }

  /**
   * The board, if this member may manage its link: one who played it, or an admin. Anyone who may
   * not see the board gets `boardGone`, as if it did not exist; one who may see it but neither
   * played it nor is an admin gets `shareNotPlayer`
   */
  private async manageable(userId: string, boardId: string): Promise<BoardRecord> {
    const record = /^[\w-]+$/.test(boardId) ? await this.deps.visibleRecord(boardId, userId) : null
    if (!record) throw new ClubError('boardGone', {}, 404)
    const played = SEATS.some((seat) => record.players[seat]?.id === userId)
    if (!played && !this.deps.isAdmin(userId)) throw new ClubError('shareNotPlayer', {}, 403)
    return record
  }

  /** `GET /api/history/:id/share`: the board's link, or null */
  async get(userId: string, boardId: string): Promise<BoardShare | null> {
    await this.manageable(userId, boardId)
    const row = this.row(boardId)
    return row ? this.view(row) : null
  }

  /**
   * `POST /api/history/:id/share`: makes the board's link, or gives the one it has. A board still
   * kept back (a challenge or match not over) cannot be shared yet: `shareHeldBack`
   */
  async create(userId: string, boardId: string): Promise<BoardShare> {
    const record = await this.manageable(userId, boardId)
    if (record.revealAt !== undefined && record.revealAt > this.deps.now()) throw new ClubError('shareHeldBack', {}, 409)
    const had = this.row(boardId)
    if (had) return this.view(had)
    const token = this.deps.newToken()
    this.sql.exec(
      'INSERT INTO board_shares (token, board_id, created_by, created_at) VALUES (?, ?, ?, ?)',
      token,
      boardId,
      userId,
      this.deps.now(),
    )
    return this.view(this.row(boardId)!)
  }

  /** `DELETE /api/history/:id/share`: the link stops working at once; nothing happens if there is none */
  async revoke(userId: string, boardId: string) {
    await this.manageable(userId, boardId)
    this.sql.exec('DELETE FROM board_shares WHERE board_id = ?', boardId)
  }

  /**
   * `GET /api/share/:token`, signed in or not: the board as `sharedBoardView` shows it. `address`
   * is the network address the request came from (CF-Connecting-IP): too many lookups from it get
   * `slowDown`; a wrong or revoked token, or a board no longer there, `shareGone`
   */
  async open(token: string, address: string): Promise<SharedBoard> {
    const key = address || 'unknown'
    if (this.misses.blocked(key) || !this.lookups.take(key)) throw new ClubError('slowDown', {}, 429)
    const row = SHARE_TOKEN.test(token)
      ? this.sql.exec<ShareRow>('SELECT token, board_id, created_by, created_at FROM board_shares WHERE token = ?', token)[0]
      : undefined
    const record = row && (await this.deps.record(row.board_id))
    const view = record && sharedBoardView(record, row.created_by, this.deps.hidesBoards, this.deps.now())
    if (!view) {
      this.misses.fail(key)
      throw new ClubError('shareGone', {}, 404)
    }
    return view
  }

  /** The links a member made, for their data export (e11-t27) */
  madeBy(userId: string): { boardId: string; createdAt: number }[] {
    return this.sql
      .exec<ShareRow>('SELECT board_id, created_at FROM board_shares WHERE created_by = ? ORDER BY created_at', userId)
      .map((row) => ({ boardId: row.board_id, createdAt: row.created_at }))
  }

  /** A deleted account's links go with it */
  removeMadeBy(userId: string) {
    this.sql.exec('DELETE FROM board_shares WHERE created_by = ?', userId)
  }
}
