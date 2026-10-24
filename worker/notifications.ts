import {
  NOTIFICATIONS_KEPT,
  NOTIFICATIONS_SHOWN,
  type Notification,
  type NotificationKind,
  type NotificationsView,
} from '../shared/protocol.ts'
import { randomId } from './auth.ts'
import type { Store } from './store.ts'

/**
 * The notification centre (AC-1.8): other services call `notify(userId, kind, params)`; each
 * member keeps their newest NOTIFICATIONS_KEPT under `notif:<userId>:<time>-<id>`, older ones are
 * dropped. A member's notifications are read from the store the first time they are needed and
 * kept in memory after that. Whenever they change, `onChange` is told so the member is sent the
 * new view.
 */
export class NotificationService {
  private readonly store: Store
  private readonly now: () => number
  private readonly onChange: (userId: string) => void
  /** Each member's notifications, oldest first, with their keys */
  private readonly loaded = new Map<string, { key: string; item: Notification }[]>()

  constructor(store: Store, now: () => number, onChange: (userId: string) => void) {
    this.store = store
    this.now = now
    this.onChange = onChange
  }

  private async entries(userId: string) {
    let entries = this.loaded.get(userId)
    if (!entries) {
      const stored = await this.store.list<Notification>(`notif:${userId}:`)
      entries = [...stored].map(([key, item]) => ({ key, item }))
      this.loaded.set(userId, entries)
    }
    return entries
  }

  async notify(userId: string, kind: NotificationKind, params: Notification['params'] = {}): Promise<Notification> {
    const entries = await this.entries(userId)
    const item: Notification = { id: randomId(6), at: this.now(), kind, params, read: false }
    // Zero-padded time keeps the keys in order
    const key = `notif:${userId}:${String(item.at).padStart(14, '0')}-${item.id}`
    await this.store.put(key, item)
    entries.push({ key, item })
    for (const old of entries.splice(0, Math.max(0, entries.length - NOTIFICATIONS_KEPT))) await this.store.delete(old.key)
    this.onChange(userId)
    return item
  }

  /** The newest notifications, newest first, and how many are unread */
  async view(userId: string): Promise<NotificationsView> {
    const entries = await this.entries(userId)
    return {
      items: entries.slice(-NOTIFICATIONS_SHOWN).reverse().map((e) => e.item),
      unread: entries.filter((e) => !e.item.read).length,
    }
  }

  /** Marks the given notifications read, or every one when `ids` is left out; unknown ids are ignored */
  async markRead(userId: string, ids?: string[]) {
    const wanted = ids && new Set(ids)
    let changed = false
    for (const entry of await this.entries(userId)) {
      if (entry.item.read || (wanted && !wanted.has(entry.item.id))) continue
      entry.item = { ...entry.item, read: true }
      await this.store.put(entry.key, entry.item)
      changed = true
    }
    if (changed) this.onChange(userId)
  }

  /** Removes everything a deleted account kept */
  async forget(userId: string) {
    for (const entry of await this.entries(userId)) await this.store.delete(entry.key)
    this.loaded.delete(userId)
  }
}
