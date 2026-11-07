import { legalPlays, puzzleEdges, puzzleState, splitCards, type AdminPuzzle, type PuzzleProgress, type PuzzleSummary, type PuzzleView } from '../shared/puzzles.ts'
import { PUZZLES, type Puzzle } from '../shared/puzzle-sets/index.ts'
import type { AuditLog } from './audit.ts'
import { ClubError } from './errors.ts'
import type { Sql, SqlValue } from './store.ts'
import { adminPuzzleView, puzzleSummary, puzzleView } from './views.ts'

/**
 * 謎題 (`e10-t13`, `e10-t14`, AC-10.9, ARCHITECTURE.md §5.11), in the club object's SQLite database:
 * which puzzles this club's admins published, and each member's progress. Nothing is solved here:
 * every card is looked up in the data `npm run puzzles` stored, so a request is a row read, a small
 * string split and a row written, well inside the free plan's 10 ms. Puzzles touch no table, no
 * record, no ranking and no points. Who sees what is `worker/views.ts`'s.
 *
 * A publication names the puzzle's revision: when its text or deal changes in the code it is a draft
 * again until an admin has read the new version, and a member's attempt on the old one starts over.
 */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS puzzle_publications (
    puzzle_id TEXT PRIMARY KEY,
    revision TEXT NOT NULL,
    published_by TEXT NOT NULL,
    published_at INTEGER NOT NULL
  ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS puzzle_progress (
    user_id TEXT NOT NULL,
    puzzle_id TEXT NOT NULL,
    revision TEXT NOT NULL,
    status TEXT NOT NULL,
    played TEXT NOT NULL,
    node INTEGER NOT NULL,
    wrong TEXT,
    hints INTEGER NOT NULL,
    attempts INTEGER NOT NULL,
    failures INTEGER NOT NULL,
    solved_at INTEGER,
    clean INTEGER NOT NULL,
    revealed_at INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, puzzle_id)
  ) WITHOUT ROWID`,
]

interface PublicationRow extends Record<string, SqlValue> {
  puzzle_id: string
  revision: string
  published_by: string
  published_at: number
}

interface ProgressRow extends Record<string, SqlValue> {
  user_id: string
  puzzle_id: string
  revision: string
  status: string
  played: string
  node: number
  wrong: string | null
  hints: number
  attempts: number
  failures: number
  solved_at: number | null
  clean: number
  /** Null on rows from before 看答案, and on every puzzle whose answer was not viewed */
  revealed_at: number | null
  updated_at: number
}

const toProgress = (row: ProgressRow): PuzzleProgress => ({
  puzzleId: row.puzzle_id,
  revision: row.revision,
  status: row.status as PuzzleProgress['status'],
  played: splitCards(row.played),
  node: row.node,
  wrong: row.wrong,
  hints: row.hints,
  attempts: row.attempts,
  failures: row.failures,
  solvedAt: row.solved_at,
  clean: row.clean === 1,
  revealedAt: row.revealed_at,
  updatedAt: row.updated_at,
})

export interface PuzzleDeps {
  sql: Sql
  now: () => number
  audit: AuditLog
  takeAction: (id: string) => boolean
  /** A member solved a puzzle for the first time (e12-t17) */
  solved?: () => void
  /** The puzzles in the code; tests give their own */
  puzzles?: readonly Puzzle[]
}

export class PuzzleService {
  private readonly deps: PuzzleDeps
  private readonly sql: Sql
  private readonly puzzles: readonly Puzzle[]

  constructor(deps: PuzzleDeps) {
    this.deps = deps
    this.sql = deps.sql
    this.puzzles = deps.puzzles ?? PUZZLES
  }

  createTables() {
    for (const statement of SCHEMA) this.sql.exec(statement)
    // 看答案 added `revealed_at`; progress from before it gets the column here, with no answer viewed
    const columns = this.sql.exec<{ name: string }>('PRAGMA table_info(puzzle_progress)').map((c) => c.name)
    if (!columns.includes('revealed_at')) this.sql.exec('ALTER TABLE puzzle_progress ADD COLUMN revealed_at INTEGER')
  }

  // ── Reading ─────────────────────────────────────────────────────────────────────────────────

  private publication(puzzle: Puzzle): { by: string; at: number } | null {
    const [row] = this.sql.exec<PublicationRow>('SELECT * FROM puzzle_publications WHERE puzzle_id = ?', puzzle.source.id)
    return row && row.revision === puzzle.solution.revision ? { by: row.published_by, at: row.published_at } : null
  }

  /** A puzzle the member may play; anything else, a draft included, does not exist for them */
  private published(id: unknown): Puzzle {
    const puzzle = this.puzzles.find((p) => p.source.id === id)
    if (!puzzle || !this.publication(puzzle)) throw new ClubError('puzzleGone', {}, 404)
    return puzzle
  }

  /** The member's progress on this version of the puzzle */
  private progress(userId: string, puzzle: Puzzle): PuzzleProgress | null {
    const [row] = this.sql.exec<ProgressRow>('SELECT * FROM puzzle_progress WHERE user_id = ? AND puzzle_id = ?', userId, puzzle.source.id)
    return row && row.revision === puzzle.solution.revision ? toProgress(row) : null
  }

  private save(userId: string, progress: PuzzleProgress) {
    this.sql.exec(
      `INSERT OR REPLACE INTO puzzle_progress (user_id, puzzle_id, revision, status, played, node, wrong, hints, attempts, failures, solved_at, clean, revealed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      userId,
      progress.puzzleId,
      progress.revision,
      progress.status,
      progress.played.join(''),
      progress.node,
      progress.wrong,
      progress.hints,
      progress.attempts,
      progress.failures,
      progress.solvedAt,
      progress.clean ? 1 : 0,
      progress.revealedAt,
      progress.updatedAt,
    )
  }

  /** An attempt not begun yet: the defenders' cards before the first decision are already played */
  private begun(puzzle: Puzzle, previous: PuzzleProgress | null): PuzzleProgress {
    return {
      puzzleId: puzzle.source.id,
      revision: puzzle.solution.revision,
      status: 'playing',
      played: splitCards(puzzle.solution.start),
      node: 0,
      wrong: null,
      hints: previous?.hints ?? 0,
      attempts: (previous?.attempts ?? 0) + 1,
      failures: previous?.failures ?? 0,
      solvedAt: previous?.solvedAt ?? null,
      clean: previous?.clean ?? false,
      // Starting over does not take back having seen the answer
      revealedAt: previous?.revealedAt ?? null,
      updatedAt: this.deps.now(),
    }
  }

  /** `GET /api/puzzles`: the published puzzles with the member's progress; no cards */
  list(userId: string): PuzzleSummary[] {
    const rows = this.sql.exec<ProgressRow>('SELECT * FROM puzzle_progress WHERE user_id = ?', userId)
    const published = this.sql.exec<PublicationRow>('SELECT * FROM puzzle_publications')
    const revision = new Map(published.map((row) => [row.puzzle_id, row.revision]))
    const mine = new Map(rows.map((row) => [row.puzzle_id, row]))
    return this.puzzles
      .filter((puzzle) => revision.get(puzzle.source.id) === puzzle.solution.revision)
      .map((puzzle) => {
        const row = mine.get(puzzle.source.id)
        return puzzleSummary(puzzle, row && row.revision === puzzle.solution.revision ? toProgress(row) : null)
      })
  }

  /** `GET /api/puzzles/:id` */
  get(userId: string, id: unknown): PuzzleView {
    const puzzle = this.published(id)
    return puzzleView(puzzle, this.progress(userId, puzzle))
  }

  // ── Playing ─────────────────────────────────────────────────────────────────────────────────

  /**
   * `POST /api/puzzles/:id/play { card }` (rule 1): only a legal card of North or South on their turn.
   * A card the stored data does not list lost the contract: nothing is applied and the attempt waits
   * for `retry`. A right one is played with the defence's stored answers.
   */
  play(userId: string, id: unknown, card: unknown): PuzzleView {
    if (!this.deps.takeAction(userId)) throw new ClubError('slowDown', {}, 429)
    const puzzle = this.published(id)
    const progress = this.progress(userId, puzzle) ?? this.begun(puzzle, null)
    if (progress.status !== 'playing') throw new ClubError('puzzleAttemptOver')
    const state = puzzleState(puzzle.source, [...puzzle.source.opening, ...progress.played])
    if (typeof card !== 'string' || !legalPlays(state).includes(card)) throw new ClubError('puzzleIllegalCard')
    const edge = puzzleEdges(puzzle.solution, progress.node).find((e) => e.card === card)
    const now = this.deps.now()
    const finished = edge !== undefined && edge.next < 0
    // Only a solve before viewing the answer counts: after it, the right line changes nothing that is kept
    const counts = finished && progress.revealedAt === null
    const next: PuzzleProgress = edge
      ? {
          ...progress,
          played: [...progress.played, edge.card, ...edge.replies],
          node: edge.next,
          status: !finished ? 'playing' : counts || progress.solvedAt !== null ? 'solved' : 'revealed',
          // A later try does not change when it was first solved
          solvedAt: counts ? (progress.solvedAt ?? now) : progress.solvedAt,
          clean: progress.clean || (counts && progress.solvedAt === null && progress.failures === 0 && progress.hints === 0),
          updatedAt: now,
        }
      : { ...progress, status: 'failed', wrong: card, failures: progress.failures + 1, updatedAt: now }
    this.save(userId, next)
    if (counts && progress.solvedAt === null) this.deps.solved?.()
    return puzzleView(puzzle, next)
  }

  /** `POST /api/puzzles/:id/retry { from }`: back to before the wrong card, or from the start, a solved puzzle too */
  retry(userId: string, id: unknown, from: unknown): PuzzleView {
    if (!this.deps.takeAction(userId)) throw new ClubError('slowDown', {}, 429)
    const puzzle = this.published(id)
    const progress = this.progress(userId, puzzle)
    let next: PuzzleProgress
    if (from === 'mistake') {
      if (progress?.status !== 'failed') throw new ClubError('puzzleNothingToRetry')
      next = { ...progress, status: 'playing', wrong: null, updatedAt: this.deps.now() }
    } else if (from === 'start') {
      next = this.begun(puzzle, progress)
    } else throw new ClubError('puzzleNothingToRetry')
    this.save(userId, next)
    return puzzleView(puzzle, next)
  }

  /** `POST /api/puzzles/:id/hint`: the next hint, counted */
  hint(userId: string, id: unknown): PuzzleView {
    if (!this.deps.takeAction(userId)) throw new ClubError('slowDown', {}, 429)
    const puzzle = this.published(id)
    const progress = this.progress(userId, puzzle) ?? this.begun(puzzle, null)
    if (progress.hints >= puzzle.source.hints.length) throw new ClubError('puzzleNoMoreHints')
    const next = { ...progress, hints: progress.hints + 1, updatedAt: this.deps.now() }
    this.save(userId, next)
    return puzzleView(puzzle, next)
  }

  /**
   * `POST /api/puzzles/:id/reveal`: 看答案. The attempt ends, the view opens with the answer, and the
   * member keeps `revealedAt` from now on, so the puzzle no longer counts unless it was already solved
   * (`solvedAt` and `clean` are left as they are). Asking again keeps the first time.
   */
  reveal(userId: string, id: unknown): PuzzleView {
    if (!this.deps.takeAction(userId)) throw new ClubError('slowDown', {}, 429)
    const puzzle = this.published(id)
    const progress = this.progress(userId, puzzle) ?? this.begun(puzzle, null)
    const now = this.deps.now()
    const next: PuzzleProgress = { ...progress, status: 'revealed', wrong: null, revealedAt: progress.revealedAt ?? now, updatedAt: now }
    this.save(userId, next)
    return puzzleView(puzzle, next)
  }

  // ── The account ─────────────────────────────────────────────────────────────────────────────

  /** The member's progress for their data export, puzzles since unpublished too; the cards they played are theirs */
  exportOf(userId: string) {
    return this.sql.exec<ProgressRow>('SELECT * FROM puzzle_progress WHERE user_id = ? ORDER BY puzzle_id', userId).map((row) => {
      const { revision: _revision, node: _node, clean: _clean, ...progress } = toProgress(row)
      return progress
    })
  }

  /** A deleted account's progress goes with it; a publication keeps the name, as the audit log does */
  forget(userId: string) {
    this.sql.exec('DELETE FROM puzzle_progress WHERE user_id = ?', userId)
  }

  /** After a backup was restored: progress of someone who is not a member any more goes */
  reload(isMember: (id: string) => boolean) {
    for (const { user_id: id } of this.sql.exec<{ user_id: string }>('SELECT DISTINCT user_id FROM puzzle_progress')) if (!isMember(id)) this.forget(id)
  }

  // ── The admin page ──────────────────────────────────────────────────────────────────────────

  /** `GET /api/admin/puzzles`: every puzzle, in full, for an admin to read before publishing */
  adminList(): AdminPuzzle[] {
    return this.puzzles.map((puzzle) => adminPuzzleView(puzzle, this.publication(puzzle)))
  }

  /** `POST /api/admin/puzzles/:id/publish { published }`: this club's members see it, or no longer do; `by` is the admin's name */
  async setPublished(by: string, id: unknown, published: unknown): Promise<AdminPuzzle[]> {
    const puzzle = this.puzzles.find((p) => p.source.id === id)
    if (!puzzle) throw new ClubError('puzzleGone', {}, 404)
    if (typeof published !== 'boolean') throw new ClubError('puzzleNothingToRetry')
    if (published === (this.publication(puzzle) !== null)) return this.adminList()
    const target = `${puzzle.source.id}@${puzzle.solution.revision}`
    if (published) {
      this.sql.exec(
        'INSERT OR REPLACE INTO puzzle_publications (puzzle_id, revision, published_by, published_at) VALUES (?, ?, ?, ?)',
        puzzle.source.id,
        puzzle.solution.revision,
        by,
        this.deps.now(),
      )
      await this.deps.audit.record({ by, action: 'puzzle:publish', target })
    } else {
      this.sql.exec('DELETE FROM puzzle_publications WHERE puzzle_id = ?', puzzle.source.id)
      await this.deps.audit.record({ by, action: 'puzzle:unpublish', target })
    }
    return this.adminList()
  }
}
