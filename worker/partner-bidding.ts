import { isCall, type Call } from '../shared/auction.ts'
import { deal as shuffle, type RandomInt } from '../shared/board.ts'
import type { Seat } from '../shared/cards.ts'
import { endBidding, makeCall, newBoard, turnOf, type BoardState } from '../shared/game.ts'
import {
  parsePartnerBidSettings,
  PARTNER_BID_ACTIVE_MAX,
  PARTNER_BID_IDLE_MS,
  PARTNER_BID_INVITE_MS,
  PARTNER_BID_INVITER_SEAT,
  PARTNER_BID_KEEP_MS,
  PARTNER_BID_KEPT,
  PARTNER_BID_PARTNER_SEAT,
  PARTNER_BID_QUIET_MS,
  PARTNER_BID_SILENT,
  partnerBidOpen,
  type PartnerBidBoard,
  type PartnerBidSession,
  type PartnerBidSettings,
  type PartnerBidStatus,
  type PartnerBidSummary,
  type PartnerBidView,
} from '../shared/partner-bidding.ts'
import { practiceBoardNo } from '../shared/practice.ts'
import { PRACTICE_SETS } from '../shared/practice-sets/index.ts'
import type { Notification, NotificationKind, RobotKind, ServerMessage } from '../shared/protocol.ts'
import { ruleBrain, type RobotBrain } from '../shared/robot/brain.ts'
import { inferredMeaning } from '../shared/robot/robots.ts'
import { ClubError } from './errors.ts'
import { practiceBoard } from './modes.ts'
import { reviewSteps, robotBidding } from './practice-review.ts'
import type { Scheduler } from './scheduler.ts'
import type { Sql, SqlValue } from './store.ts'
import { partnerBidSummary, partnerBidView } from './views.ts'

/**
 * 搭檔非同步叫牌練習 (`e10-t08`, AC-10.6, ARCHITECTURE.md §5.11), in the club object's SQLite
 * database: a row per session and a row per dealt board, read when needed and never kept in memory,
 * so an evicted object loses nothing. Every call is one small transaction. What takes CPU is spread
 * out for the free plan's 10 ms: a board is dealt only when it is reached, one per request, and
 * 檢討 is worked out afterwards in scheduled jobs (`robot`), as at a practice table. After an
 * eviction the sweep is armed again by `load()` and a missing review by the next read.
 *
 * Who sees what is `worker/views.ts`'s; like `ClubService` this never touches a Cloudflare API.
 */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS partner_bid_sessions (
    id TEXT PRIMARY KEY,
    inviter_id TEXT NOT NULL,
    partner_id TEXT NOT NULL,
    status TEXT NOT NULL,
    settings TEXT NOT NULL,
    set_offset INTEGER NOT NULL,
    done INTEGER NOT NULL,
    turn_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS partner_bid_by_inviter ON partner_bid_sessions (inviter_id, updated_at)',
  'CREATE INDEX IF NOT EXISTS partner_bid_by_partner ON partner_bid_sessions (partner_id, updated_at)',
  'CREATE INDEX IF NOT EXISTS partner_bid_by_expiry ON partner_bid_sessions (expires_at)',
  `CREATE TABLE IF NOT EXISTS partner_bid_boards (
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    state TEXT NOT NULL,
    category TEXT,
    note TEXT,
    review TEXT,
    PRIMARY KEY (session_id, seq)
  ) WITHOUT ROWID`,
]

interface SessionRow extends Record<string, SqlValue> {
  id: string
  inviter_id: string
  partner_id: string
  status: string
  settings: string
  set_offset: number
  done: number
  turn_id: string | null
  created_at: number
  updated_at: number
  expires_at: number
}

interface BoardRow extends Record<string, SqlValue> {
  session_id: string
  seq: number
  state: string
  category: string | null
  note: string | null
  review: string | null
}

const toSession = (row: SessionRow): PartnerBidSession => ({
  id: row.id,
  inviterId: row.inviter_id,
  partnerId: row.partner_id,
  status: row.status as PartnerBidStatus,
  settings: JSON.parse(row.settings) as PartnerBidSettings,
  offset: row.set_offset,
  done: row.done,
  turnId: row.turn_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  expiresAt: row.expires_at,
})

const toBoard = (row: BoardRow): PartnerBidBoard => ({
  seq: row.seq,
  state: JSON.parse(row.state) as BoardState,
  ...(row.category !== null && { category: row.category }),
  ...(row.note !== null && { note: row.note }),
  ...(row.review !== null && { review: JSON.parse(row.review) as PartnerBidBoard['review'] }),
})

const OPEN_STATUSES = "('invited', 'active')"
/** How many ended sessions one sweep handles; the next wakes at once */
const SWEEP_BATCH = 20
const SWEEP_KEY = 'partnerBid:sweep'

export interface PartnerBidDeps {
  sql: Sql
  now: () => number
  newId: () => string
  random: RandomInt
  scheduler: Scheduler
  brain?: RobotBrain
  /** Another member of this club, never oneself: throws `notSelf` or `userGone` otherwise */
  otherMember: (userId: string, otherId: unknown) => string
  name: (id: string) => string
  blocked: (by: string, other: string) => boolean
  takeAction: (id: string) => boolean
  notify: (id: string, kind: NotificationKind, params: Notification['params']) => Promise<unknown>
  send: (id: string, message: ServerMessage) => void
  online: () => string[]
  /** The member's own robots: TKB in the club's system if they may use it */
  defaultKind: (id: string) => RobotKind
  /** Throws when the member may not ask for this system */
  checkKind: (id: string, kind: unknown) => void
}

const seatOf = (session: PartnerBidSession, userId: string): Seat =>
  userId === session.inviterId ? PARTNER_BID_INVITER_SEAT : PARTNER_BID_PARTNER_SEAT

const otherOf = (session: PartnerBidSession, userId: string) => (userId === session.inviterId ? session.partnerId : session.inviterId)

/** The board with East and West's passes made: they never bid, so the auction waits only for a member */
function passSilentSeats(state: BoardState): BoardState {
  let board = state
  for (let turn = turnOf(board); board.phase === 'auction' && turn && PARTNER_BID_SILENT.includes(turn); turn = turnOf(board))
    board = makeCall(board, turn, 'P')
  return endBidding(board)
}

export class PartnerBidService {
  private readonly deps: PartnerBidDeps
  private readonly sql: Sql
  /** When each member last called in a session, for `notifyTurn`; losing it only means one more bell */
  private readonly lastCall = new Map<string, { sessionId: string; at: number }>()
  /** When the earliest sweep waiting wakes */
  private armedAt: number | null = null

  constructor(deps: PartnerBidDeps) {
    this.deps = deps
    this.sql = deps.sql
  }

  createTables() {
    for (const statement of SCHEMA) this.sql.exec(statement)
    this.armSweep()
  }

  // ── Reading ─────────────────────────────────────────────────────────────────────────────────

  private row(id: string): PartnerBidSession | null {
    const [row] = this.sql.exec<SessionRow>('SELECT * FROM partner_bid_sessions WHERE id = ?', id)
    return row ? toSession(row) : null
  }

  /** The session, for one of its two members; anyone else hears it does not exist */
  private ownSession(userId: string, id: string): PartnerBidSession {
    const session = this.row(id)
    if (!session || (session.inviterId !== userId && session.partnerId !== userId)) throw new ClubError('partnerBidGone', {}, 404)
    return session
  }

  private boards(id: string): PartnerBidBoard[] {
    return this.sql.exec<BoardRow>('SELECT * FROM partner_bid_boards WHERE session_id = ? ORDER BY seq', id).map(toBoard)
  }

  private board(id: string, seq: number): PartnerBidBoard | null {
    const [row] = this.sql.exec<BoardRow>('SELECT * FROM partner_bid_boards WHERE session_id = ? AND seq = ?', id, seq)
    return row ? toBoard(row) : null
  }

  private sessionsOf(userId: string): PartnerBidSession[] {
    return this.sql
      .exec<SessionRow>('SELECT * FROM partner_bid_sessions WHERE inviter_id = ? OR partner_id = ? ORDER BY updated_at DESC, id', userId, userId)
      .map(toSession)
  }

  private view(session: PartnerBidSession, userId: string): PartnerBidView {
    return partnerBidView(session, this.boards(session.id), userId, this.deps.name)
  }

  /** `GET /api/partner-bidding`: the member's sessions, the latest first, no cards */
  list(userId: string): PartnerBidSummary[] {
    return this.sessionsOf(userId).map((session) => partnerBidSummary(session, userId, this.deps.name))
  }

  /** `GET /api/partner-bidding/:id`; a review an evicted object lost is scheduled again here */
  get(userId: string, id: string): PartnerBidView {
    const session = this.ownSession(userId, id)
    const boards = this.boards(id)
    for (const board of boards) if (board.state.phase !== 'auction' && !(board.review?.steps && board.review.robot)) this.scheduleReview(id, board.seq)
    return partnerBidView(session, boards, userId, this.deps.name)
  }

  /** The member's sessions for their data export: as they may see them, never the partner's hand on a board still being bid */
  exportOf(userId: string) {
    return this.sessionsOf(userId).map((session) => {
      const { sessionBoards, ...summary } = this.view(session, userId)
      return { ...summary, sessionBoards: sessionBoards.map(({ review: _review, legalCalls: _legal, ...board }) => board) }
    })
  }

  // ── Starting ────────────────────────────────────────────────────────────────────────────────

  private openCount(userId: string): number {
    const [row] = this.sql.exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM partner_bid_sessions WHERE (inviter_id = ? OR partner_id = ?) AND status IN ${OPEN_STATUSES}`,
      userId,
      userId,
    )
    return row?.n ?? 0
  }

  /**
   * `POST /api/partner-bidding { partnerId, settings }`: invites another member of this club (each
   * club only knows its own, so another club's id is `userGone`). Blocks as for any invitation: the
   * inviter hears to unblock, a member the partner blocked only that they cannot be invited
   */
  async create(userId: string, body: unknown): Promise<PartnerBidView> {
    if (!this.deps.takeAction(userId)) throw new ClubError('slowDown', {}, 429)
    const { partnerId, settings: rawSettings } = (body ?? {}) as { partnerId?: unknown; settings?: unknown }
    const partner = this.deps.otherMember(userId, partnerId)
    const name = this.deps.name(partner)
    if (this.deps.blocked(userId, partner)) throw new ClubError('unblockToInvite')
    if (this.deps.blocked(partner, userId)) throw new ClubError('cannotInvite', { name }, 403)
    const parsed = parsePartnerBidSettings(rawSettings ?? {}, this.deps.defaultKind(userId))
    if ('field' in parsed) throw new ClubError('badPartnerBidSettings', { field: parsed.field })
    this.deps.checkKind(userId, parsed.settings.robotKind)
    const settings = { ...parsed.settings }
    let offset = 0
    if (settings.deal === 'set') {
      const set = PRACTICE_SETS.get(settings.setId ?? '')
      if (!set?.problems.length) throw new ClubError('practiceSetGone', {}, 404)
      settings.boards = Math.min(settings.boards, set.problems.length)
      offset = this.deps.random(set.problems.length)
    }
    if (this.openCount(userId) >= PARTNER_BID_ACTIVE_MAX) throw new ClubError('partnerBidTooMany', { max: PARTNER_BID_ACTIVE_MAX })
    if (this.openCount(partner) >= PARTNER_BID_ACTIVE_MAX) throw new ClubError('partnerBidPartnerBusy', { name })
    const now = this.deps.now()
    const id = this.deps.newId()
    this.sql.exec(
      `INSERT INTO partner_bid_sessions (id, inviter_id, partner_id, status, settings, set_offset, done, turn_id, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, 'invited', ?, ?, 0, NULL, ?, ?, ?)`,
      id,
      userId,
      partner,
      JSON.stringify(settings),
      offset,
      now,
      now,
      now + PARTNER_BID_INVITE_MS,
    )
    this.armSweep()
    await this.deps.notify(partner, 'partnerBidInvited', { username: this.deps.name(userId), sessionId: id })
    const session = this.row(id)!
    this.push(session)
    return this.view(session, userId)
  }

  /** The session's next board: dealt only now, one per request, and East and West's passes made */
  private dealt(session: PartnerBidSession, seq: number): PartnerBidBoard {
    const { settings } = session
    const problems = settings.deal === 'set' ? PRACTICE_SETS.get(settings.setId ?? '')?.problems : undefined
    if (problems?.length) {
      const problem = problems[(session.offset + seq) % problems.length]
      return {
        seq,
        state: passSilentSeats(newBoard(problem.boardNo, structuredClone(problem.hands))),
        category: problem.category,
        ...(problem.note && { note: problem.note }),
      }
    }
    // A set taken off the site since the invitation: any deal, so the session never gets stuck
    const deal = settings.deal === 'set' ? 'random' : settings.deal
    const boardNo = practiceBoardNo({ deal }, seq)
    const made = practiceBoard({ deal, robotKind: settings.robotKind, justDeclare: false }, boardNo, this.deps.random)
    return { seq, state: passSilentSeats(newBoard(boardNo, made?.hands ?? shuffle(this.deps.random))) }
  }

  private writeBoard(sessionId: string, board: PartnerBidBoard) {
    this.sql.exec(
      `INSERT INTO partner_bid_boards (session_id, seq, state, category, note, review) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (session_id, seq) DO UPDATE SET state = excluded.state, review = excluded.review`,
      sessionId,
      board.seq,
      JSON.stringify(board.state),
      board.category ?? null,
      board.note ?? null,
      board.review ? JSON.stringify(board.review) : null,
    )
  }

  private writeSession(session: PartnerBidSession) {
    this.sql.exec(
      'UPDATE partner_bid_sessions SET status = ?, done = ?, turn_id = ?, updated_at = ?, expires_at = ? WHERE id = ?',
      session.status,
      session.done,
      session.turnId,
      session.updatedAt,
      session.expiresAt,
      session.id,
    )
  }

  /** Who calls next on a board being bid */
  private turnIdOf(session: PartnerBidSession, board: BoardState): string | null {
    const turn = turnOf(board)
    if (board.phase !== 'auction') return null
    return turn === PARTNER_BID_INVITER_SEAT ? session.inviterId : session.partnerId
  }

  /**
   * After a call: whose call it is now, or, on a board that just ended, the next board dealt (it
   * cannot be over at once: at most one silent seat passes before a member's call), or the session done
   */
  private settle(session: PartnerBidSession, board: PartnerBidBoard): { session: PartnerBidSession; finished: boolean; over: boolean } {
    const now = this.deps.now()
    const over = board.state.phase !== 'auction'
    let next: PartnerBidSession = { ...session, updatedAt: now, expiresAt: now + PARTNER_BID_IDLE_MS }
    if (!over) return { session: { ...next, turnId: this.turnIdOf(next, board.state) }, finished: false, over }
    next = { ...next, done: session.done + 1 }
    if (next.done >= session.settings.boards)
      return { session: { ...next, status: 'finished', turnId: null, expiresAt: now + PARTNER_BID_KEEP_MS }, finished: true, over }
    const following = this.dealt(next, next.done)
    this.writeBoard(next.id, following)
    return { session: { ...next, turnId: this.turnIdOf(next, following.state) }, finished: false, over }
  }

  /** `POST /api/partner-bidding/:id/answer { accept }`: only the invited partner, while the invitation stands */
  async answer(userId: string, id: string, accept: unknown): Promise<PartnerBidView> {
    if (!this.deps.takeAction(userId)) throw new ClubError('slowDown', {}, 429)
    if (typeof accept !== 'boolean') throw new ClubError('unknownCommand')
    const session = this.ownSession(userId, id)
    if (session.partnerId !== userId || session.status !== 'invited') throw new ClubError('partnerBidNotInvited')
    if (!accept) {
      const ended = this.end(session, 'declined')
      await this.deps.notify(session.inviterId, 'partnerBidDeclined', { username: this.deps.name(userId), sessionId: id })
      return this.view(ended, userId)
    }
    const started = this.sql.transaction(() => {
      const first = this.dealt(session, 0)
      this.writeBoard(id, first)
      const now = this.deps.now()
      const next: PartnerBidSession = {
        ...session,
        status: 'active',
        turnId: this.turnIdOf(session, first.state),
        updatedAt: now,
        expiresAt: now + PARTNER_BID_IDLE_MS,
      }
      this.writeSession(next)
      return next
    })
    await this.deps.notify(session.inviterId, 'partnerBidAccepted', { username: this.deps.name(userId), sessionId: id })
    this.push(started)
    return this.view(started, userId)
  }

  // ── Bidding ─────────────────────────────────────────────────────────────────────────────────

  /**
   * `POST /api/partner-bidding/:id/call { call }`: the member's own seat only, checked here by the
   * same `makeCall` as at any table (`notYourCall`, `illegalCall`). The board, the next one and the
   * session are written in one transaction
   */
  async call(userId: string, id: string, rawCall: unknown): Promise<PartnerBidView> {
    if (!this.deps.takeAction(userId)) throw new ClubError('slowDown', {}, 429)
    const session = this.ownSession(userId, id)
    if (session.status !== 'active') throw new ClubError('partnerBidOver')
    if (!isCall(rawCall)) throw new ClubError('unknownCommand')
    const call: Call = rawCall
    const current = this.board(id, session.done)
    if (!current) throw new ClubError('partnerBidOver')
    const state = passSilentSeats(makeCall(current.state, seatOf(session, userId), call))
    const board: PartnerBidBoard = { ...current, state }
    const { session: next, finished, over } = this.sql.transaction(() => {
      this.writeBoard(id, board)
      const moved = this.settle(session, board)
      this.writeSession(moved.session)
      if (moved.finished) this.trimEnded(session)
      return moved
    })
    this.lastCall.set(userId, { sessionId: id, at: this.deps.now() })
    this.armSweep()
    if (over) this.scheduleReview(id, board.seq)
    const other = otherOf(session, userId)
    if (finished) {
      this.forgetCalls(id, session)
      await this.deps.notify(other, 'partnerBidFinished', { username: this.deps.name(userId), sessionId: id })
    } else if (next.turnId === other) await this.notifyTurn(other, userId, id)
    this.push(next)
    return this.view(next, userId)
  }

  /** A turn's bell, unless the member is at it right now: online, and called in this session moments ago */
  private async notifyTurn(to: string, from: string, sessionId: string) {
    const last = this.lastCall.get(to)
    if (last?.sessionId === sessionId && this.deps.now() - last.at < PARTNER_BID_QUIET_MS && this.deps.online().includes(to)) return
    await this.deps.notify(to, 'partnerBidTurn', { username: this.deps.name(from), sessionId })
  }

  private forgetCalls(id: string, session: PartnerBidSession) {
    for (const member of [session.inviterId, session.partnerId]) if (this.lastCall.get(member)?.sessionId === id) this.lastCall.delete(member)
  }

  // ── Ending ──────────────────────────────────────────────────────────────────────────────────

  private end(session: PartnerBidSession, status: PartnerBidStatus): PartnerBidSession {
    const now = this.deps.now()
    const ended: PartnerBidSession = { ...session, status, turnId: null, updatedAt: now, expiresAt: now + PARTNER_BID_KEEP_MS }
    this.sql.transaction(() => {
      this.writeSession(ended)
      this.trimEnded(session)
    })
    this.forgetCalls(session.id, session)
    this.armSweep()
    this.push(ended)
    return ended
  }

  /**
   * `POST /api/partner-bidding/:id/abandon`: either member, any time before the end. The inviter
   * takes the invitation back this way; the invited partner saying this declines it. Boards already
   * over keep their review; the board being bid never shows the other hand
   */
  async abandon(userId: string, id: string): Promise<PartnerBidView> {
    if (!this.deps.takeAction(userId)) throw new ClubError('slowDown', {}, 429)
    const session = this.ownSession(userId, id)
    if (!partnerBidOpen(session.status)) throw new ClubError('partnerBidOver')
    if (session.status === 'invited' && session.partnerId === userId) return this.answer(userId, id, false)
    const ended = this.end(session, 'abandoned')
    await this.deps.notify(otherOf(session, userId), 'partnerBidAbandoned', { username: this.deps.name(userId), sessionId: id })
    return this.view(ended, userId)
  }

  /**
   * A block ends what the two have open (`ClubService.setBlocked`). The other member sees the session
   * abandoned, as if either had stopped, and gets no bell: they are never told about a block
   */
  endBetween(userId: string, otherId: string) {
    const rows = this.sql.exec<SessionRow>(
      `SELECT * FROM partner_bid_sessions
       WHERE ((inviter_id = ? AND partner_id = ?) OR (inviter_id = ? AND partner_id = ?)) AND status IN ${OPEN_STATUSES}`,
      userId,
      otherId,
      otherId,
      userId,
    )
    for (const row of rows) this.end(toSession(row), 'abandoned')
  }

  /** Keeps PARTNER_BID_KEPT ended sessions for each of the two members; called as one more ends */
  private trimEnded(session: PartnerBidSession) {
    for (const member of [session.inviterId, session.partnerId]) {
      const old = this.sql.exec<{ id: string }>(
        `SELECT id FROM partner_bid_sessions WHERE (inviter_id = ? OR partner_id = ?) AND status NOT IN ${OPEN_STATUSES}
         ORDER BY updated_at DESC, id LIMIT -1 OFFSET ?`,
        member,
        member,
        PARTNER_BID_KEPT,
      )
      for (const { id } of old) if (id !== session.id) this.remove(id)
    }
  }

  private remove(id: string) {
    this.sql.exec('DELETE FROM partner_bid_boards WHERE session_id = ?', id)
    this.sql.exec('DELETE FROM partner_bid_sessions WHERE id = ?', id)
  }

  /** Everything of a deleted account goes: a session is both members', and its calls are theirs too */
  forget(userId: string) {
    const sessions = this.sessionsOf(userId)
    this.sql.transaction(() => {
      for (const session of sessions) this.remove(session.id)
    })
    for (const session of sessions) this.deps.send(otherOf(session, userId), { type: 'partnerBid', id: session.id, session: null })
    this.lastCall.delete(userId)
  }

  /** After a backup was restored: sessions naming someone who is not a member any more go */
  reload(isMember: (id: string) => boolean) {
    const rows = this.sql.exec<{ id: string; inviter_id: string; partner_id: string }>('SELECT id, inviter_id, partner_id FROM partner_bid_sessions')
    for (const row of rows) if (!isMember(row.inviter_id) || !isMember(row.partner_id)) this.remove(row.id)
  }

  // ── The sweep and the review ────────────────────────────────────────────────────────────────

  /**
   * One job at the first session due, and another only when something falls due before the one
   * waiting (a new invitation, when only an ended session was left): a job that wakes too early finds
   * nothing and arms the next, so the calls of a session being bid add none. `load()` arms it again
   * after an eviction, one query
   */
  private armSweep() {
    const [row] = this.sql.exec<{ at: number | null }>('SELECT MIN(expires_at) AS at FROM partner_bid_sessions')
    const at = row?.at
    if (at === null || at === undefined || (this.armedAt !== null && this.armedAt <= at)) return
    this.armedAt = at
    this.deps.scheduler.add(`${SWEEP_KEY}:${at}`, 'partnerBid', Math.max(0, at - this.deps.now()), () => {
      if (this.armedAt === at) this.armedAt = null
      return this.sweep()
    })
  }

  /** Open sessions past their time end; ended ones past theirs are deleted, reviews and all */
  async sweep() {
    const due = this.sql
      .exec<SessionRow>('SELECT * FROM partner_bid_sessions WHERE expires_at <= ? ORDER BY expires_at LIMIT ?', this.deps.now(), SWEEP_BATCH)
      .map(toSession)
    for (const session of due) {
      if (!partnerBidOpen(session.status)) {
        this.remove(session.id)
        continue
      }
      this.end(session, 'expired')
      const { inviterId, partnerId, id } = session
      await this.deps.notify(inviterId, 'partnerBidExpired', { username: this.deps.name(partnerId), sessionId: id })
      if (session.status === 'active') await this.deps.notify(partnerId, 'partnerBidExpired', { username: this.deps.name(inviterId), sessionId: id })
    }
    this.armSweep()
  }

  /** 檢討 of a board whose auction ended: in the scheduler, never in the request of the last call */
  private scheduleReview(id: string, seq: number) {
    this.deps.scheduler.add(`partnerBid:review:${id}:${seq}`, 'robot', 0, () => this.review(id, seq))
  }

  /**
   * One part per job, as at a practice table: first what TKB would call at each of the auction's
   * steps and what the members' calls mean, then TKB bidding the board from the start with East
   * and West silent, the way the members bid it. Each question gives the brain one hand only
   * (`askedState`, hard rule 6). Stored in the board's row, so an eviction loses at most a part
   */
  private async review(id: string, seq: number) {
    const session = this.row(id)
    const board = this.board(id, seq)
    if (!session || !board || board.state.phase === 'auction') return
    const kind = session.settings.robotKind
    const ask = async <T>(work: (brain: RobotBrain) => Promise<T>): Promise<T> => {
      try {
        return await work(this.deps.brain ?? ruleBrain)
      } catch (error) {
        if (!this.deps.brain) throw error
        console.warn('robot brain failed, the rule robot reviews', error)
        return work(ruleBrain)
      }
    }
    const before = board.review ?? {}
    let next: PartnerBidBoard
    if (!before.steps) {
      const steps = await ask((brain) => reviewSteps(brain, kind, board.state, PARTNER_BID_SILENT))
      next = { ...board, state: this.withMeanings(board.state, kind), review: { ...before, steps } }
    } else if (!before.robot) {
      next = { ...board, review: { ...before, robot: await ask((brain) => robotBidding(brain, kind, board.state, PARTNER_BID_SILENT)) } }
    } else return
    // The session may have gone while the brain thought
    if (!this.row(id)) return
    this.writeBoard(id, next)
    if (!next.review?.robot) this.scheduleReview(id, seq)
    this.push(this.row(id)!)
  }

  /** The members' calls with what the engine reads them as in the system compared with: from the auction alone */
  private withMeanings(state: BoardState, kind: RobotKind): BoardState {
    const auction = state.auction.map((call, i) => {
      if (PARTNER_BID_SILENT.includes(call.seat)) return call
      const meaning = inferredMeaning(kind, state.auction.slice(0, i + 1), state.dealer, state.vul)
      return meaning ? { ...call, meaning, inferred: kind } : call
    })
    return { ...state, auction }
  }

  /** Tells both members' pages, each what that member may see */
  private push(session: PartnerBidSession) {
    const online = this.deps.online()
    for (const member of [session.inviterId, session.partnerId])
      if (online.includes(member)) this.deps.send(member, { type: 'partnerBid', id: session.id, session: this.view(session, member) })
  }
}
