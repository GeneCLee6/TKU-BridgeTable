/**
 * Rate limits, kept in memory. The club's Durable Object is the only place messages arrive, so
 * one map per limit is enough; if the object is evicted the counts start over, which only ever
 * lets a little more through
 */

/** A token bucket per key: `burst` actions at once, then `perSecond` */
export class TokenBuckets {
  private readonly buckets = new Map<string, { tokens: number; at: number }>()
  private readonly burst: number
  private readonly perSecond: number
  private readonly now: () => number

  constructor(burst: number, perSecond: number, now: () => number) {
    this.burst = burst
    this.perSecond = perSecond
    this.now = now
  }

  /** Takes one token; false when the key has none left */
  take(key: string): boolean {
    const now = this.now()
    const bucket = this.buckets.get(key) ?? { tokens: this.burst, at: now }
    bucket.tokens = Math.min(this.burst, bucket.tokens + ((now - bucket.at) / 1000) * this.perSecond)
    bucket.at = now
    if (bucket.tokens < 1) {
      this.buckets.set(key, bucket)
      return false
    }
    bucket.tokens -= 1
    this.buckets.set(key, bucket)
    if (this.buckets.size > 10_000) this.prune(now)
    return true
  }

  forget(key: string) {
    this.buckets.delete(key)
  }

  /** Drops buckets that have refilled; they behave the same as a new one */
  private prune(now: number) {
    for (const [key, bucket] of this.buckets) {
      if (bucket.tokens + ((now - bucket.at) / 1000) * this.perSecond >= this.burst) this.buckets.delete(key)
    }
  }
}

/** Counts failures per key in a window; `blocked` once there are `max` of them */
export class FailureWindow {
  private readonly failures = new Map<string, { count: number; since: number }>()
  private readonly max: number
  private readonly windowMs: number
  private readonly now: () => number

  constructor(max: number, windowMs: number, now: () => number) {
    this.max = max
    this.windowMs = windowMs
    this.now = now
  }

  blocked(key: string): boolean {
    const entry = this.current(key)
    return !!entry && entry.count >= this.max
  }

  fail(key: string) {
    const now = this.now()
    const entry = this.current(key) ?? { count: 0, since: now }
    entry.count += 1
    this.failures.set(key, entry)
    if (this.failures.size > 10_000) {
      for (const [k, e] of this.failures) if (now - e.since >= this.windowMs) this.failures.delete(k)
    }
  }

  clear(key: string) {
    this.failures.delete(key)
  }

  private current(key: string) {
    const entry = this.failures.get(key)
    if (entry && this.now() - entry.since >= this.windowMs) {
      this.failures.delete(key)
      return undefined
    }
    return entry
  }
}

/** Per member, across their tabs: a burst of 30 messages (a reconnect replays what was queued), then 10 a second */
export const ACTION_BURST = 30
export const ACTIONS_PER_SECOND = 10
/** Chat lines per member: 5 at once, then one every 2 seconds */
export const CHAT_BURST = 5
export const CHATS_PER_SECOND = 0.5
/** Wrong passwords: 5 for one username from one address, or 20 from one address, then wait 15 minutes */
export const LOGIN_FAILURES_PER_NAME = 5
export const LOGIN_FAILURES_PER_ADDRESS = 20
export const LOGIN_WINDOW_MS = 15 * 60_000
/** Error reports from browsers, for the whole club */
export const CLIENT_ERROR_BURST = 20
export const CLIENT_ERRORS_PER_SECOND = 1
/** Direct messages per member (e1-t27): 10 at once, then 20 a minute */
export const DIRECT_BURST = 10
export const DIRECTS_PER_SECOND = 20 / 60
/** A friend coming online is announced at most once in this long, so reconnects stay quiet (e1-t24) */
export const FRIEND_ONLINE_QUIET_MS = 30 * 60_000
