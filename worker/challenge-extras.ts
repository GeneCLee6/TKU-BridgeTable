import {
  CHALLENGE_COMMENT_MAX,
  CHALLENGE_COMMENTS_SHOWN,
  type ChallengeComment,
  type ChallengeCommentsView,
} from '../shared/challenge-comments.ts'
import { challengeStats, type ChallengeStatsView, type StatsChallenge } from '../shared/challenge-stats.ts'
import type { PublicUser } from '../shared/protocol.ts'
import type { ScoreRuling } from '../shared/ruling-scoring.ts'
import { challengeStandings, hasFinished } from './challenge-flow.ts'
import type { Challenge, ChallengeStore } from './challenges.ts'
import { ClubError } from './errors.ts'
import type { EventBoard } from './history-index.ts'
import type { Sql, SqlValue } from './store.ts'
import { challengeThreadAccess } from './views.ts'

/**
 * What the challenges have on top of playing them (M2, `e7-t27`, `e7-t29`; ARCHITECTURE.md §5.5):
 * each board's discussion thread and a member's challenge record. Both read the club's copy of the
 * challenges (`ChallengeStore`, the replica when `EVENT_OBJECTS` is on), and the comments are kept
 * in the club's SQLite, not in the challenge's object: they do not change the challenge, and who may
 * read them is the traveller's rule (`challengeThreadAccess` in `views.ts`, §4). No Cloudflare API here.
 */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS challenge_comments (
    id INTEGER PRIMARY KEY,
    challenge_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    text TEXT NOT NULL,
    at INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS challenge_comments_by_board ON challenge_comments (challenge_id, seq, id)',
  'CREATE INDEX IF NOT EXISTS challenge_comments_by_user ON challenge_comments (user_id)',
]

interface CommentRow extends Record<string, SqlValue> {
  id: number
  challenge_id: string
  seq: number
  user_id: string
  text: string
  at: number
}

export interface ChallengeExtrasDeps {
  sql: Sql
  challenges: ChallengeStore
  now: () => number
  userById: (id: string) => PublicUser | undefined
  isAdmin: (id: string) => boolean
  /** The member's action rate limit: false when they are sending too fast */
  takeAction: (id: string) => boolean
  /** The history index's rows of an event: each board's contract, tricks and ruling */
  boardsOf: (eventId: string) => Map<string, EventBoard>
}

export class ChallengeExtras {
  private readonly deps: ChallengeExtrasDeps

  constructor(deps: ChallengeExtrasDeps) {
    this.deps = deps
  }

  createTables() {
    for (const statement of SCHEMA) this.deps.sql.exec(statement)
  }

  // ── Each board's discussion thread (e7-t27) ──────────────────────────────────────────────

  /**
   * The challenge when the member may read board `seq`'s thread (`challengeThreadAccess`, §4: when
   * they see that board's traveller). Anyone else is told there is no such challenge, so nothing
   * about it shows
   */
  private readable(challengeId: string, seq: number, userId: string): Challenge {
    const challenge = this.deps.challenges.get(challengeId)
    if (!challenge || !challengeThreadAccess(challenge, seq, userId).read) throw new ClubError('challengeGone', {}, 404)
    return challenge
  }

  private mayPost(challenge: Challenge, seq: number, userId: string): boolean {
    return challengeThreadAccess(challenge, seq, userId).write
  }

  /** `GET /api/challenges/:id/boards/:seq/comments` */
  comments(challengeId: string, seq: number, userId: string): ChallengeCommentsView {
    const challenge = this.readable(challengeId, seq, userId)
    const admin = this.deps.isAdmin(userId)
    const rows = this.deps.sql
      .exec<CommentRow>(
        `SELECT * FROM (SELECT id, challenge_id, seq, user_id, text, at FROM challenge_comments
         WHERE challenge_id = ? AND seq = ? ORDER BY id DESC LIMIT ?) ORDER BY id`,
        challengeId,
        seq,
        CHALLENGE_COMMENTS_SHOWN,
      )
      .map((row): ChallengeComment => {
        const user = this.deps.userById(row.user_id)
        return {
          id: row.id,
          userId: row.user_id,
          ...(user && { user }),
          text: row.text,
          at: row.at,
          removable: admin || row.user_id === userId,
        }
      })
    return { comments: rows, canPost: this.mayPost(challenge, seq, userId) }
  }

  /**
   * `POST /api/challenges/:id/boards/:seq/comments { text }`: only a participant who played every
   * board (the known-deals creator too) writes; before the end those are exactly the ones who
   * already see every result, so nothing leaks
   */
  addComment(challengeId: string, seq: number, userId: string, text: unknown): ChallengeCommentsView {
    const challenge = this.readable(challengeId, seq, userId)
    if (!this.mayPost(challenge, seq, userId)) throw new ClubError('challengeCommentFinishFirst', {}, 403)
    const clean = typeof text === 'string' ? text.trim() : ''
    if (!clean) throw new ClubError('challengeCommentEmpty')
    if (clean.length > CHALLENGE_COMMENT_MAX) throw new ClubError('challengeCommentTooLong', { max: CHALLENGE_COMMENT_MAX })
    if (!this.deps.takeAction(userId)) throw new ClubError('slowDown', {}, 429)
    this.deps.sql.exec(
      'INSERT INTO challenge_comments (challenge_id, seq, user_id, text, at) VALUES (?, ?, ?, ?, ?)',
      challengeId,
      seq,
      userId,
      clean,
      this.deps.now(),
    )
    return this.comments(challengeId, seq, userId)
  }

  /** `DELETE /api/challenges/:id/boards/:seq/comments/:commentId`: the writer, or an admin */
  removeComment(challengeId: string, seq: number, userId: string, commentId: number): ChallengeCommentsView {
    this.readable(challengeId, seq, userId)
    const [row] = this.deps.sql.exec<{ user_id: string }>(
      'SELECT user_id FROM challenge_comments WHERE id = ? AND challenge_id = ? AND seq = ?',
      commentId,
      challengeId,
      seq,
    )
    if (!row) throw new ClubError('challengeCommentGone', {}, 404)
    if (row.user_id !== userId && !this.deps.isAdmin(userId)) throw new ClubError('challengeCommentGone', {}, 404)
    this.deps.sql.exec('DELETE FROM challenge_comments WHERE id = ?', commentId)
    return this.comments(challengeId, seq, userId)
  }

  /** A deleted account's comments go with it */
  forget(userId: string) {
    this.deps.sql.exec('DELETE FROM challenge_comments WHERE user_id = ?', userId)
  }

  /** The member's own comments, for their data export */
  commentsOf(userId: string): { challengeId: string; seq: number; text: string; at: number }[] {
    return this.deps.sql
      .exec<CommentRow>('SELECT id, challenge_id, seq, user_id, text, at FROM challenge_comments WHERE user_id = ? ORDER BY id', userId)
      .map((row) => ({ challengeId: row.challenge_id, seq: row.seq, text: row.text, at: row.at }))
  }

  // ── A member's challenge record (e7-t29) ─────────────────────────────────────────────────

  /**
   * `GET /api/challenges/stats`: the member's own record over the finished challenges they were
   * ranked in (`challengeStats`). Once a challenge is finished every participant sees all of it
   * (§4), so a head to head only uses what both already see. The daily and weekly club events are
   * left out: they are the whole club against the robots, not a challenge between members
   */
  stats(userId: string): ChallengeStatsView {
    const list: StatsChallenge[] = []
    for (const id of this.deps.challenges.idsOf(userId)) {
      const c = this.deps.challenges.get(id)
      if (!c || c.status !== 'finished' || c.settings.daily || c.settings.weekly) continue
      const me = c.players.find((p) => p.userId === userId)
      if (!me || !hasFinished(c, me)) continue
      const boards = this.deps.boardsOf(id)
      const rulingOf = (boardId: string) => boards.get(boardId)?.ruling
      const standings = challengeStandings(c, rulingOf)
      if (standings.ranked.length < 2) continue
      const scores: Record<string, number[]> = {}
      const rulings: Record<string, (ScoreRuling | undefined)[]> = {}
      for (const r of standings.ranked) {
        scores[r.userId] = new Array<number>(c.deals.boards.length).fill(0)
        rulings[r.userId] = new Array<ScoreRuling | undefined>(c.deals.boards.length)
      }
      for (const r of c.results) {
        if (!scores[r.userId]) continue
        scores[r.userId][r.seq - 1] = r.scoreNS
        rulings[r.userId][r.seq - 1] = rulingOf(r.boardId)
      }
      list.push({
        id,
        at: c.endedAt ?? c.deadline,
        scoring: standings.scoring,
        scores,
        rulings,
        ranks: Object.fromEntries(standings.ranked.map((r) => [r.userId, r.rank])),
      })
    }
    const stats = challengeStats(userId, list)
    return {
      ...stats,
      opponents: stats.opponents.map((o) => {
        const user = this.deps.userById(o.opponent)
        return { ...o, ...(user && { user }) }
      }),
    }
  }
}
