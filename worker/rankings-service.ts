import type { FeatureFlag } from '../shared/features.ts'
import {
  DEFAULT_POINTS_RULES,
  parsePointsRules,
  periodOf,
  POINTS_LIMITS,
  seasonAt,
  taiwanMonth,
  type LeaderboardView,
  type LedgerEntry,
  type PeriodKey,
  type PointsRules,
} from '../shared/points.ts'
import type { PublicUser } from '../shared/protocol.ts'
import type { RatingView } from '../shared/rating.ts'
import type { Challenge } from './challenges.ts'
import { ClubError } from './errors.ts'
import { eventBoards } from './history-index.ts'
import { crashEntry, type Logger } from './log.ts'
import { challengeEvent, matchEvent } from './ranking-events.ts'
import { POINTS_KEY, RankingStore, type RankedEvent } from './rankings.ts'
import type { Store } from './store.ts'
import type { TeamMatch } from './team-matches.ts'

/**
 * Club points and ratings as the club serves them (J2: `e9-t04`–`e9-t08`, ARCHITECTURE.md §5.20).
 * Kept apart from `ClubService`, which only tells it of every finished event and routes the pages'
 * requests here. Nothing here touches Cloudflare: the store and the clock come in.
 */
export interface RankingsDeps {
  store: Store
  now: () => number
  log: Logger
  /** Whether the member exists and is an admin */
  isAdmin: (userId: string) => boolean
  exists: (userId: string) => boolean
  userById: (userId: string) => PublicUser | undefined
  featureOn: (flag: FeatureFlag, userId: string) => boolean
}

export class RankingsService {
  private readonly deps: RankingsDeps
  readonly ledger: RankingStore
  private rules: PointsRules = DEFAULT_POINTS_RULES

  constructor(deps: RankingsDeps) {
    this.deps = deps
    this.ledger = new RankingStore(deps.store.sql)
  }

  async load() {
    this.ledger.createTables()
    const saved = await this.deps.store.get<PointsRules>(POINTS_KEY)
    // A kind added later (pairs, J3) takes its default
    if (saved) this.rules = { ...saved, kinds: { ...DEFAULT_POINTS_RULES.kinds, ...saved.kinds } }
  }

  get pointsRules(): PointsRules {
    return this.rules
  }

  // ── Recording (e9-t05) ─────────────────────────────────────────────────────────────────────

  /**
   * Records a finished event once (points and ratings); any kind of event may call it (the pairs
   * event, J3). Recording runs whether or not the `rankings` flag is on, so opening the pages later
   * shows every event since J2. Never fails the settlement it rides on
   */
  record(event: RankedEvent | null) {
    if (!event) return
    try {
      this.ledger.record(event, this.rules)
    } catch (error) {
      this.deps.log(crashEntry('recordPoints', error))
    }
  }

  challengeFinished(c: Challenge) {
    const boards = eventBoards(this.deps.store.sql, c.id)
    this.record(challengeEvent(c, (b) => boards.get(b)?.ruling, this.deps.now()))
  }

  matchFinished(m: TeamMatch) {
    const boards = eventBoards(this.deps.store.sql, m.id)
    this.record(matchEvent(m, (b) => boards.get(b)?.ruling, this.deps.now()))
  }

  // ── The pages (e9-t06, e9-t08) ─────────────────────────────────────────────────────────────

  /** Members with the flag, and admins (who set the rules before opening it) */
  private requireAccess(userId: string) {
    if (!this.deps.featureOn('rankings', userId) && !this.deps.isAdmin(userId)) throw new ClubError('rankingsOff', {}, 403)
  }

  /** The period a request names (`month`, `year` or `season`); this month when it names none */
  private period(query: URLSearchParams) {
    const month = query.get('month')
    const year = query.get('year')
    const season = query.get('season')
    const key: PeriodKey =
      season !== null ? { season } : year !== null ? { year } : { month: month ?? taiwanMonth(this.deps.now()) }
    const period = periodOf(key, this.rules.seasons)
    if (!period) throw new ClubError('badPeriod', {}, 404)
    return period
  }

  /** `GET /api/rankings`: one period's board (月榜、年榜、賽季) */
  leaderboard(userId: string, query: URLSearchParams): LeaderboardView {
    this.requireAccess(userId)
    const period = this.period(query)
    const rows = this.ledger.leaderboard(period).flatMap((r) => {
      const user = this.deps.userById(r.userId)
      return user ? [{ ...r, user }] : []
    })
    return { period, rows, rules: this.rules }
  }

  /** `GET /api/rankings/ledger?user=`: one member's entries in the period, every point traced to its event */
  memberLedger(userId: string, query: URLSearchParams): LedgerEntry[] {
    this.requireAccess(userId)
    const target = query.get('user') ?? userId
    return this.ledger.ledger(target, this.period(query))
  }

  /** The season this moment falls in, for the page's default year board */
  currentSeason() {
    return seasonAt(this.deps.now(), this.rules.seasons)
  }

  /** `POST /api/admin/points`: the rules and the seasons (`parsePointsRules`) */
  async adminSetRules(adminId: string, value: unknown): Promise<PointsRules> {
    if (!this.deps.isAdmin(adminId)) throw new ClubError('adminOnly', {}, 403)
    const parsed = parsePointsRules(value, this.rules)
    if ('field' in parsed) throw new ClubError('badPointsRules', { field: parsed.field })
    this.rules = parsed.rules
    await this.deps.store.put(POINTS_KEY, this.rules)
    return this.rules
  }

  /** `POST /api/admin/points/adjust { eventId, userId, points, reason }`: an admin corrects one entry */
  adminAdjust(adminId: string, value: unknown): LedgerEntry {
    if (!this.deps.isAdmin(adminId)) throw new ClubError('adminOnly', {}, 403)
    const { eventId, userId, points, reason } = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
    if (typeof eventId !== 'string' || typeof userId !== 'string') throw new ClubError('pointsEntryMissing', {}, 404)
    if (typeof points !== 'number' || !Number.isFinite(points) || Math.abs(points) > 10 * POINTS_LIMITS.points)
      throw new ClubError('badPointsRules', { field: 'points' })
    const why = typeof reason === 'string' ? reason.trim() : ''
    if (!why || why.length > POINTS_LIMITS.reason) throw new ClubError('pointsReason', { max: POINTS_LIMITS.reason })
    const entry = this.ledger.adjust(eventId, userId, points, why, adminId, this.deps.now())
    if (!entry) throw new ClubError('pointsEntryMissing', {}, 404)
    return entry
  }

  /**
   * `GET /api/ratings/:userId`: a member's rating and trend. One who chose 不公開 shows it only to
   * themselves; anyone else gets that it is hidden, nothing more (admins too)
   */
  rating(viewerId: string, userId: string): RatingView {
    this.requireAccess(viewerId)
    if (!this.deps.exists(userId)) throw new ClubError('unknownMember', {}, 404)
    const view = this.ledger.rating(userId)
    if (!view.hidden || viewerId === userId) return view
    return { userId, rating: null, rd: null, provisional: true, events: 0, hidden: true, history: [] }
  }

  /** `POST /api/ratings/visibility { hidden }`: the member shows or hides their own rating */
  setHidden(userId: string, hidden: unknown): RatingView {
    this.requireAccess(userId)
    if (typeof hidden !== 'boolean') throw new ClubError('unknownCommand')
    this.ledger.setHidden(userId, hidden, this.deps.now())
    return this.ledger.rating(userId)
  }

  exportOf(userId: string) {
    return this.ledger.exportOf(userId)
  }

  forget(userId: string) {
    this.ledger.deleteUser(userId)
  }
}
