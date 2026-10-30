import { randomId } from './auth.ts'
import type { Store } from './store.ts'

/**
 * Who changed what in TKU BridgeHall's content, and when (BridgeHall e8-t09, AC-8.6): one record
 * per change at `audit:<time>-<id>`, so the keys sort by time. The admin page lists the newest
 * (GET /api/book/audit). Records are small and never edited; they are not trimmed.
 */

export type AuditAction =
  /** A convention's draft saved, or saved and sent for review (BridgeHall e8-t02) */
  | 'book:draft'
  | 'book:submit'
  /** A draft sent back to its editor, or thrown away */
  | 'book:reject'
  | 'book:discard'
  /** A convention published (from its draft or straight away), hidden, or back to the bundled one */
  | 'book:publish'
  | 'book:hide'
  | 'book:reset'
  | 'book:categories'
  /** The built-in conventions seeded from BridgeHall (L0, e10-t20); `target` is 'builtin', `version` the built-in one */
  | 'book:builtin'
  /** A 待確認 note's status, assignee, remark or closing grounds changed (BridgeHall e8-t06); `target` is `<slug>/<sectionId>/<n>` */
  | 'book:pending'
  /** The glossary saved (BridgeHall e4-t07); `target` is 'glossary' */
  | 'book:glossary'
  /** An article published or hidden (BridgeHall e5-t04) */
  | 'article:publish'
  | 'article:hide'
  /** An article's draft saved, sent for review, sent back or thrown away (BridgeHall e5-t07) */
  | 'article:draft'
  | 'article:submit'
  | 'article:reject'
  | 'article:discard'
  /** An e-book added or changed, or taken down (BridgeHall e5-t09); `target` is its id */
  | 'ebook:save'
  | 'ebook:remove'
  /** The library's series changed (BridgeHall e5-t06) */
  | 'article:series'
  /** System profiles */
  | 'profile:create'
  | 'profile:save'
  | 'profile:delete'
  /** A convention card version published or deleted (BridgeHall e3-t09); `target` is `<profile>/<template>` */
  | 'card:publish'
  | 'card:delete'
  /** A practice question fixed or written by hand, or the fix removed (BridgeHall e6-t06) */
  | 'quiz:fix'
  | 'quiz:unfix'
  /** A learning path saved, or back to the handbook's bundled one (BridgeHall e4-t12); `target` is the path's id */
  | 'path:save'
  | 'path:reset'
  /**
   * The forum's officers (BridgeHall e11-t09; `target` is the post's id, or the board's): a post
   * pinned or taken down, locked or opened; someone else's post or comment deleted (`note` says
   * whose and what); a report dismissed; a board added, changed or deleted
   */
  | 'forum:pin'
  | 'forum:unpin'
  | 'forum:lock'
  | 'forum:unlock'
  | 'forum:removePost'
  | 'forum:removeComment'
  | 'forum:dismiss'
  | 'forum:board'
  | 'forum:boardDelete'

export interface AuditEntry {
  id: string
  at: number
  /** The member's username, as in BookRevision.by */
  by: string
  action: AuditAction
  /** A convention's or an article's slug, a profile's id, `<profile>/<template>` for a card, 'categories' or 'series', a forum post's or board's id */
  target: string
  /** The version the change made (a published convention's, a profile's, the categories'); a draft has none */
  version?: number
  /** The saved version's id (`book:rev:<slug>:<id>`), so the record links to it */
  revisionId?: string
  /** The note given with the change, or the reason a draft was sent back */
  note?: string
}

export const AUDIT_LIMITS = { listed: 200 }

export class AuditLog {
  private readonly store: Store
  private readonly now: () => number
  private lastStamp = 0

  constructor(store: Store, now: () => number = Date.now) {
    this.store = store
    this.now = now
  }

  async record(entry: Omit<AuditEntry, 'id' | 'at'>): Promise<AuditEntry> {
    // Ids that sort by time, strictly increasing even within one millisecond
    this.lastStamp = Math.max(this.now(), this.lastStamp + 1)
    const full: AuditEntry = { id: `${String(this.lastStamp).padStart(14, '0')}-${randomId(3)}`, at: this.now(), ...entry }
    if (!full.note) delete full.note
    await this.store.put(`audit:${full.id}`, full)
    return full
  }

  /** Newest first */
  async list(limit = AUDIT_LIMITS.listed): Promise<AuditEntry[]> {
    const list = await this.store.list<AuditEntry>('audit:', { reverse: true, limit: Math.min(limit, AUDIT_LIMITS.listed) })
    return [...list.values()]
  }
}
