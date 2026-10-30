import { deviceLabel, SESSION_SEEN_STEP_MS, type SessionInfo } from '../shared/account.ts'
import { randomId, SESSION_DAYS } from './auth.ts'
import type { Store } from './store.ts'

/**
 * Sessions (e11-t23): `session:<token>` in the club's storage. The token is only ever in the
 * member's HttpOnly cookie; the list on "My account" names each session by its own `id`, so ending
 * one never needs (or shows) a token. Sessions written before the list (no `id`) get one the first
 * time they are listed.
 */
export interface Session {
  userId: string
  expires: number
  id?: string
  createdAt?: number
  lastSeenAt?: number
  device?: string
}

const KEY = 'session:'

export class Sessions {
  private readonly store: Store
  private readonly now: () => number

  constructor(store: Store, now: () => number) {
    this.store = store
    this.now = now
  }

  /** A new session for a member signing in from `userAgent`; its token */
  async create(userId: string, userAgent = ''): Promise<string> {
    const token = randomId(32)
    const now = this.now()
    await this.store.put<Session>(KEY + token, {
      userId,
      expires: now + SESSION_DAYS * 86_400_000,
      id: randomId(8),
      createdAt: now,
      lastSeenAt: now,
      device: deviceLabel(userAgent),
    })
    return token
  }

  /** The member of a live session, or null; an expired one is removed. Notes when it was last used, once an hour at most */
  async userIdFor(token: string | null): Promise<string | null> {
    if (!token) return null
    const session = await this.store.get<Session>(KEY + token)
    if (!session) return null
    const now = this.now()
    if (session.expires < now) {
      await this.store.delete(KEY + token)
      return null
    }
    if (now - (session.lastSeenAt ?? 0) >= SESSION_SEEN_STEP_MS) {
      session.lastSeenAt = now
      await this.store.put(KEY + token, session)
    }
    return session.userId
  }

  async end(token: string) {
    await this.store.delete(KEY + token)
  }

  /** The member's live sessions, newest use first; `token` marks the one this request came with */
  async list(userId: string, token: string | null): Promise<SessionInfo[]> {
    const now = this.now()
    const sessions: SessionInfo[] = []
    for (const [key, session] of await this.store.list<Session>(KEY)) {
      if (session.userId !== userId || session.expires < now) continue
      if (!session.id) {
        session.id = randomId(8)
        await this.store.put(key, session)
      }
      const createdAt = session.createdAt ?? session.expires - SESSION_DAYS * 86_400_000
      sessions.push({
        id: session.id,
        device: session.device ?? '',
        createdAt,
        lastSeenAt: session.lastSeenAt ?? createdAt,
        current: key === KEY + token,
      })
    }
    return sessions.sort((a, b) => Number(b.current) - Number(a.current) || b.lastSeenAt - a.lastSeenAt)
  }

  /** Ends one of the member's sessions by its id; false when they have none by that id */
  async endById(userId: string, id: string): Promise<boolean> {
    for (const [key, session] of await this.store.list<Session>(KEY)) {
      if (session.userId === userId && session.id === id) {
        await this.store.delete(key)
        return true
      }
    }
    return false
  }

  /** Ends every session of the member but `keep` (a token; null ends them all); how many ended */
  async endAll(userId: string, keep: string | null = null): Promise<number> {
    let ended = 0
    for (const [key, session] of await this.store.list<Session>(KEY)) {
      if (session.userId !== userId || key === KEY + keep) continue
      await this.store.delete(key)
      ended++
    }
    return ended
  }

  /** Ends every session of everyone (after a restore, worker/backup.ts) */
  async endEveryone() {
    for (const key of (await this.store.list(KEY)).keys()) await this.store.delete(key)
  }
}
