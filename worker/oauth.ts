/**
 * Signing in with another site's account (Google e1-t31, LINE e1-t32; AC-1.9; ARCHITECTURE.md §5.2,
 * docs/SECURITY.md V2, DEPLOY.md §4.16, §4.18): what both providers share.
 *
 * OpenID Connect's authorization-code flow, run by the server: the page asks the Worker for the
 * provider's address (`POST /api/auth/<provider>/start`), the browser goes there, and the provider
 * sends it back to `/api/auth/<provider>/callback` with a one-time code. The club's Durable Object
 * exchanges the code at the provider's token endpoint (with the client secret and the PKCE
 * verifier) and reads the ID token it gets back. `state` is checked against an HttpOnly cookie (the
 * flow belongs to the browser that started it), `nonce` against the one sent, and PKCE (S256)
 * binds the code to this flow. The account is found by the provider's `sub`, never by an email or
 * a name.
 *
 * Each provider (`worker/google.ts`, `worker/line.ts`) is on only when both its secrets are set
 * (wrangler secrets); PR previews get none, so they have neither. The service only sees
 * `OAuthProvider`.
 */

import { BOOK_SITE } from '../shared/book-site.ts'
import { CLUB_PARAM, clubCookieName, DEFAULT_CLUB_ID } from '../shared/clubs.ts'
import type { OAuthName } from '../shared/protocol.ts'

export type { OAuthName }
export const OAUTH_NAMES: readonly OAuthName[] = ['google', 'line']

/** How long a flow may take at the provider (start → callback) */
export const OAUTH_START_MS = 10 * 60_000
/** How long the code step after the provider takes at most (兩步驟登入) */
export const OAUTH_CODE_MS = 5 * 60_000
/** How long an application with the provider may take to fill in */
export const OAUTH_APPLY_MS = 30 * 60_000

/** Who the provider says it is: the stable id, and the email (Google only) and name only as it gave them */
export interface OAuthIdentity {
  sub: string
  email: string
  name: string
}

/** What the service needs from a provider */
export interface OAuthProvider {
  name: OAuthName
  clientId: string
  /** The provider's sign-in page for one flow */
  authorizeUrl(flow: { redirectUri: string; state: string; nonce: string; challenge: string }): string
  /** The ID token's claims for an authorization code; throws when the provider refuses the code */
  exchange(flow: { code: string; verifier: string; redirectUri: string }): Promise<Record<string, unknown>>
  /** The identity in the claims, or null when they are not for us, not fresh or not for this nonce */
  identify(claims: Record<string, unknown>, expected: { nonce: string; now: number }): OAuthIdentity | null
}

/**
 * Where the provider sends the browser back, on whichever site started the flow. The provider's
 * redirect carries no header, so another club's callback names its club with `?club=<id>`
 * (e12-t04): that address is the one to register with the provider when the club gets Google or
 * LINE (only 淡江 has them today, DEPLOY.md §4.16); 淡江's stays as registered
 */
export const callbackPath = (name: OAuthName, clubId: string = DEFAULT_CLUB_ID) =>
  `/api/auth/${name}/callback${clubId === DEFAULT_CLUB_ID ? '' : `?${CLUB_PARAM}=${clubId}`}`
/** The cookie that ties a flow to the browser that started it; only `/api/` reads it. One per club (`tbt_google_<id>`, e12-t04) */
export const flowCookieName = (name: OAuthName, clubId: string = DEFAULT_CLUB_ID) => clubCookieName(`tbt_${name}`, clubId)

export const toBase64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')

export const fromBase64Url = (text: string) => Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0))

/** A JWT's header (part 0) or payload (part 1), read without checking its signature */
export function decodeJwtPart(token: string, part: 0 | 1 = 1): Record<string, unknown> {
  const parts = token.split('.')
  if (parts.length !== 3 || !/^[\w-]+$/.test(parts[part])) throw new Error('Not a JWT')
  const value = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[part]))) as unknown
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Not a JWT')
  return value as Record<string, unknown>
}

/** A JWT's payload, read without checking its signature (worker/google.ts says when that is enough) */
export const decodeJwtPayload = (token: string) => decodeJwtPart(token, 1)

/** A `sub` we keep: letters, digits, `_` and `-` (Google's digits, LINE's `U` and hex) */
export const validSub = (sub: unknown): sub is string => typeof sub === 'string' && /^[\w-]{1,255}$/.test(sub)

/** A random value for `state`, `nonce` or the PKCE verifier: 32 bytes, base64url (43 characters) */
export function oauthRandom(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)))
}

/** PKCE's S256 challenge for a verifier (RFC 7636) */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return toBase64Url(new Uint8Array(digest))
}

/**
 * The site a flow runs on, as the page says (`location.origin`), if it is one of ours: this
 * Worker's own address (淡江牌桌, staging) or 淡江橋館 (`BOOK_SITE`, whose `/api/*` Vercel passes
 * here, so its cookies stay on its own domain). On a Worker served from localhost any localhost
 * port goes too (橋館's dev server proxies to the table's). Anything else is refused: providers only
 * send browsers back to the callback addresses registered for the client, and this keeps every
 * address we hand out one of them
 */
export function oauthSite(pageOrigin: string, workerUrl: URL): { origin: string; site: 'table' | 'book' } | null {
  if (pageOrigin === workerUrl.origin) return { origin: pageOrigin, site: 'table' }
  if (pageOrigin === BOOK_SITE) return { origin: pageOrigin, site: 'book' }
  const local = (host: string) => host === 'localhost' || host === '127.0.0.1'
  try {
    const page = new URL(pageOrigin)
    if (local(workerUrl.hostname) && local(page.hostname) && page.protocol === 'http:' && page.origin === pageOrigin)
      return { origin: pageOrigin, site: 'book' }
  } catch {
    // not an origin
  }
  return null
}

/** Where to go back to: a path on the same site, never another site (`//host`, `/\host`) */
export function safeReturn(path: unknown): string {
  const text = String(path ?? '')
  return text.startsWith('/') && !text.startsWith('//') && !text.includes('\\') && text.length <= 300 ? text : '/'
}

/** A provider's flow cookie, or (with an empty id) the one that clears it */
export function flowCookie(name: OAuthName, id: string, secure: boolean, maxAgeMs = OAUTH_START_MS, clubId: string = DEFAULT_CLUB_ID): string {
  return [
    `${flowCookieName(name, clubId)}=${id}`,
    'Path=/api/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${id ? Math.floor(maxAgeMs / 1000) : 0}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ')
}

// ── Flows in the club's storage ─────────────────────────────────────────────────────────────────

/**
 * One flow, kept as `<provider>:<id>` (`google:…`, `line:…`) until it finishes or expires. The id is
 * the `state` sent to the provider and the value of the browser's `tbt_<provider>` cookie; each step
 * takes the record (it works once) and the next step gets a new id:
 * - `start`: on the way to the provider; `userId` when a signed-in member is binding it
 * - `code`: the provider named an account with 兩步驟登入; the code step signs in (`userId`)
 * - `apply`: the provider named no account; the application form may use it (`sub`, `email`, `name`)
 */
export type OAuthFlow =
  | {
      step: 'start'
      site: 'table' | 'book'
      returnTo: string
      redirectUri: string
      verifier: string
      nonce: string
      userId?: string
      expiresAt: number
    }
  | { step: 'code'; site: 'table' | 'book'; returnTo: string; userId: string; expiresAt: number }
  | { step: 'apply'; sub: string; email: string; name: string; expiresAt: number }

/** Live flows per provider at most; past it new ones are refused until some expire (a flood cannot fill storage) */
export const OAUTH_FLOWS_MAX = 500

interface FlowStore {
  get<T>(key: string): Promise<T | undefined>
  put<T>(key: string, value: T): Promise<void>
  delete(key: string): Promise<void>
  list<T>(prefix: string): Promise<Map<string, T>>
}

/** One provider's flows */
export class OAuthFlows {
  private readonly store: FlowStore
  private readonly now: () => number
  private readonly prefix: string

  constructor(store: FlowStore, now: () => number, name: OAuthName) {
    this.store = store
    this.now = now
    this.prefix = `${name}:`
  }

  /** Keeps a new flow; its id, or null when there are too many live ones. Expired ones are dropped first */
  async create(flow: OAuthFlow, id = oauthRandom()): Promise<string | null> {
    const now = this.now()
    let live = 0
    for (const [key, kept] of await this.store.list<OAuthFlow>(this.prefix)) {
      if (kept.expiresAt <= now) await this.store.delete(key)
      else live++
    }
    if (live >= OAUTH_FLOWS_MAX) return null
    await this.store.put(this.prefix + id, flow)
    return id
  }

  /** A live flow by its id, left in place (the code step may take several tries) */
  async peek(id: string | null): Promise<OAuthFlow | null> {
    if (!id || !/^[\w-]{20,64}$/.test(id)) return null
    const flow = await this.store.get<OAuthFlow>(this.prefix + id)
    if (!flow) return null
    if (flow.expiresAt <= this.now()) {
      await this.store.delete(this.prefix + id)
      return null
    }
    return flow
  }

  /** A live flow by its id, removed: it works once */
  async take(id: string | null): Promise<OAuthFlow | null> {
    const flow = await this.peek(id)
    if (flow) await this.store.delete(this.prefix + id)
    return flow
  }

  async drop(id: string) {
    await this.store.delete(this.prefix + id)
  }
}
