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
  /** System profiles */
  | 'profile:create'
  | 'profile:save'
  | 'profile:delete'

export interface AuditEntry {
  id: string
  at: number
  /** The member's username, as in BookRevision.by */
  by: string
  action: AuditAction
  /** A convention's slug, a profile's id, or 'categories' */
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
