import { SEATS } from '../shared/cards.ts'
import { parseFeaturedInput, type FeaturedBoard, type FeaturedInput } from '../shared/featured.ts'
import { summarize, type BoardRecord, type BoardSummary, type NotificationKind, type PublicUser } from '../shared/protocol.ts'
import { ClubError } from './service.ts'
import type { Store } from './store.ts'
import { recordVisible } from './views.ts'

/**
 * Featured boards (精選牌局, AC-4.5, `e4-t29`; ARCHITECTURE.md §5.9). Members with the
 * `boardCurate` permission feature a finished board, edit it and take it off again; every member
 * reads them. Each is kept under `featured:<boardId>` with a summary of the board taken when it
 * was featured, so the list never reads the records. Only a board already public may be featured
 * (`revealAt` passed, §4), and every read applies `recordVisible` again. Like `ClubService` this
 * never touches a Cloudflare API.
 */

interface StoredFeatured extends FeaturedInput {
  boardId: string
  /** The member who featured it first */
  by: string
  at: number
  updatedAt: number
  board: BoardSummary
}

export interface FeaturedDeps {
  now: () => number
  userById: (id: string) => PublicUser | undefined
  /** Throws `noPermission` unless the member may feature boards */
  requireCurator: (userId: string) => void
  notify: (userId: string, kind: NotificationKind, params: Record<string, string | number>) => Promise<unknown>
  /** Takes one action from the member's rate limit (AC-11.7); false when they are over it */
  takeAction: (userId: string) => boolean
}

const GONE: PublicUser = { id: '', username: '—' }

export class FeaturedService {
  private readonly store: Store
  private readonly deps: FeaturedDeps
  /** Every featured board by board id, read from the store the first time it is needed */
  private loaded: Map<string, StoredFeatured> | null = null

  constructor(store: Store, deps: FeaturedDeps) {
    this.store = store
    this.deps = deps
  }

  private async all() {
    if (!this.loaded) {
      const stored = await this.store.list<StoredFeatured>('featured:')
      this.loaded = new Map([...stored.values()].map((f) => [f.boardId, f]))
    }
    return this.loaded
  }

  private view(featured: StoredFeatured): FeaturedBoard {
    const { by, ...rest } = featured
    return { ...rest, by: this.deps.userById(by) ?? GONE }
  }

  private visible(featured: StoredFeatured, userId: string) {
    return recordVisible(featured.board, userId, this.deps.now())
  }

  /** Every featured board the member may see, newest first (`GET /api/featured`) */
  async list(userId: string): Promise<FeaturedBoard[]> {
    return [...(await this.all()).values()]
      .filter((f) => this.visible(f, userId))
      .sort((a, b) => b.at - a.at || a.boardId.localeCompare(b.boardId))
      .map((f) => this.view(f))
  }

  /** One board's feature, or null when it has none the member may see (`GET /api/featured/:id`) */
  async get(boardId: string, userId: string): Promise<FeaturedBoard | null> {
    const featured = (await this.all()).get(boardId)
    return featured && this.visible(featured, userId) ? this.view(featured) : null
  }

  /**
   * Features a board or edits its feature (`POST /api/featured/:id`). The board must exist and be
   * public already; the members who played it (not the curator) are told the first time
   */
  async set(userId: string, boardId: string, body: unknown): Promise<FeaturedBoard> {
    this.deps.requireCurator(userId)
    if (!this.deps.takeAction(userId)) throw new ClubError('slowDown', {}, 429)
    const parsed = parseFeaturedInput(body)
    if ('field' in parsed) throw new ClubError('badFeatured', { field: parsed.field })
    const record = /^[\w-]+$/.test(boardId) ? await this.store.get<BoardRecord>(`board:${boardId}`) : undefined
    if (!record) throw new ClubError('boardGone', {}, 404)
    const now = this.deps.now()
    if (record.revealAt !== undefined && record.revealAt > now) {
      // Not told apart from a missing board for someone who may not see it at all
      if (!recordVisible(record, userId, now)) throw new ClubError('boardGone', {}, 404)
      throw new ClubError('featuredNotRevealed', {}, 403)
    }
    const all = await this.all()
    const before = all.get(record.id)
    const featured: StoredFeatured = {
      ...parsed.input,
      boardId: record.id,
      by: before?.by ?? userId,
      at: before?.at ?? now,
      updatedAt: now,
      board: summarize(record),
    }
    await this.store.put(`featured:${record.id}`, featured)
    all.set(record.id, featured)
    if (!before) {
      const curator = this.deps.userById(userId)?.username ?? ''
      // Members still on the club; robots and empty seats are left out
      const players = new Set(SEATS.flatMap((seat) => {
        const player = this.deps.userById(record.players[seat]?.id ?? '')
        return player && !player.robot ? [player.id] : []
      }))
      players.delete(userId)
      for (const player of players) await this.deps.notify(player, 'boardFeatured', { boardId: record.id, username: curator })
    }
    return this.view(featured)
  }

  /** Takes a board off the featured list (`DELETE /api/featured/:id`) */
  async remove(userId: string, boardId: string) {
    this.deps.requireCurator(userId)
    const all = await this.all()
    if (!all.has(boardId)) throw new ClubError('featuredGone', {}, 404)
    await this.store.delete(`featured:${boardId}`)
    all.delete(boardId)
  }
}
