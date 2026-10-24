import type { Store } from './store.ts'

/**
 * One member's list of other members, one key per pair: `friend:<userId>:<friendId>` for the
 * members someone follows (好友, AC-1.6) and `block:<userId>:<otherId>` for the ones they blocked.
 * Both lists are one-way: the other member is never asked and never told. Everything is read once
 * when the club loads and kept in memory; every change is written through to the store.
 */
export class Relations {
  private readonly store: Store
  private readonly prefix: string
  private readonly now: () => number
  private readonly lists = new Map<string, Set<string>>()

  constructor(store: Store, kind: 'friend' | 'block', now: () => number) {
    this.store = store
    this.prefix = `${kind}:`
    this.now = now
  }

  async load() {
    for (const key of (await this.store.list(this.prefix)).keys()) {
      const [userId, otherId] = key.slice(this.prefix.length).split(':')
      if (userId && otherId) this.listOf(userId).add(otherId)
    }
  }

  private listOf(userId: string) {
    let list = this.lists.get(userId)
    if (!list) this.lists.set(userId, (list = new Set()))
    return list
  }

  private key(userId: string, otherId: string) {
    return `${this.prefix}${userId}:${otherId}`
  }

  has(userId: string, otherId: string) {
    return !!this.lists.get(userId)?.has(otherId)
  }

  /** The ids on a member's list, in the order they were added */
  of(userId: string): string[] {
    return [...(this.lists.get(userId) ?? [])]
  }

  async set(userId: string, otherId: string, on: boolean) {
    if (on === this.has(userId, otherId)) return
    if (on) {
      this.listOf(userId).add(otherId)
      await this.store.put(this.key(userId, otherId), { at: this.now() })
    } else {
      this.lists.get(userId)?.delete(otherId)
      await this.store.delete(this.key(userId, otherId))
    }
  }

  /** Removes a deleted account from every list, its own and everyone else's */
  async forget(userId: string) {
    for (const otherId of this.of(userId)) await this.store.delete(this.key(userId, otherId))
    this.lists.delete(userId)
    for (const [ownerId, list] of this.lists) if (list.has(userId)) await this.set(ownerId, userId, false)
  }
}
