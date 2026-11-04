import type { Store } from './store.ts'

/**
 * Registrations per address (`e1-t33`, AC-1.9; ARCHITECTURE.md §5.2). Every application sent and
 * every wrong invite code counts for the address it came from; once there are
 * REGISTRATIONS_PER_ADDRESS in REGISTRATION_WINDOW_MS, more wait for the window to end.
 *
 * The address itself is never kept: only a salted SHA-256 of it (16 hex characters), and only
 * until its window ends. With the Worker secret `SEEN_SALT` (the anti-cheating report's salt,
 * §5.17) the counts are written to `meta:registrations`, so an evicted object still remembers them,
 * and a copy of the storage alone cannot be walked back to addresses. Without it the salt is made
 * up when the object wakes and the counts stay in memory: an unsalted hash of an IPv4 address is
 * easy to walk back, so nothing is written, at the price of starting over after an eviction.
 * Not in the backup (BACKUP_PREFIXES), not anyone's personal data.
 */

/** 10 applications or wrong invite codes from one address in an hour (a club's sign-up night on one campus Wi-Fi still fits) */
export const REGISTRATIONS_PER_ADDRESS = 10
export const REGISTRATION_WINDOW_MS = 60 * 60_000
/** At most this many addresses are kept; the oldest go first */
const MAX_ADDRESSES = 2_000
const KEY = 'meta:registrations'

/**
 * Another count of the same kind (the club applications, e12-t06): its own storage key, hash
 * label and limit; the registrations' when not given
 */
export interface LimitOptions {
  key?: string
  label?: string
  max?: number
  windowMs?: number
}

type Counts = Record<string, { count: number; since: number }>

export class RegistrationLimit {
  private readonly store: Store
  private readonly now: () => number
  private readonly salt: string
  /** Whether the counts are written (the salt is the secret, not one made up in memory) */
  private readonly persist: boolean
  private memory: Counts = {}
  private readonly storageKey: string
  private readonly label: string
  private readonly max: number
  private readonly windowMs: number

  constructor(store: Store, now: () => number, secretSalt: string | null, options: LimitOptions = {}) {
    this.store = store
    this.now = now
    this.storageKey = options.key ?? KEY
    this.label = options.label ?? 'register'
    this.max = options.max ?? REGISTRATIONS_PER_ADDRESS
    this.windowMs = options.windowMs ?? REGISTRATION_WINDOW_MS
    this.persist = secretSalt !== null
    this.salt = secretSalt ?? [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('')
  }

  /** The address's hash, or '' when there is no address (local development, tests): no limit then */
  async key(address: string): Promise<string> {
    if (!address) return ''
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${this.salt}:${this.label}:${address}`))
    return [...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('')
  }

  /** Whether the address has used up its window */
  async blocked(key: string): Promise<boolean> {
    if (!key) return false
    const entry = (await this.read())[key]
    return !!entry && this.now() - entry.since < this.windowMs && entry.count >= this.max
  }

  /** Counts one more for the address; ended windows are dropped on the way */
  async count(key: string) {
    if (!key) return
    const now = this.now()
    const counts: Counts = {}
    for (const [k, e] of Object.entries(await this.read())) if (now - e.since < this.windowMs) counts[k] = e
    const entry = counts[key] ?? { count: 0, since: now }
    counts[key] = { count: entry.count + 1, since: entry.since }
    const keys = Object.keys(counts)
    if (keys.length > MAX_ADDRESSES)
      for (const k of keys.sort((a, b) => counts[a].since - counts[b].since).slice(0, keys.length - MAX_ADDRESSES)) delete counts[k]
    if (!this.persist) this.memory = counts
    else await this.store.put(this.storageKey, counts)
  }

  private async read(): Promise<Counts> {
    return this.persist ? ((await this.store.get<Counts>(this.storageKey)) ?? {}) : this.memory
  }
}
