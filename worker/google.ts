/**
 * Google sign-in (e1-t31, AC-1.9; ARCHITECTURE.md §5.2, docs/SECURITY.md V2, DEPLOY.md §4.16).
 *
 * OpenID Connect's authorization-code flow, run by the server: the page asks the Worker for
 * Google's address (`POST /api/auth/google/start`), the browser goes there, and Google sends it
 * back to `/api/auth/google/callback` with a one-time code. The club's Durable Object exchanges the
 * code at Google's token endpoint (with the client secret and the PKCE verifier) and reads the ID
 * token it gets back. `state` is checked against an HttpOnly cookie (the flow belongs to the
 * browser that started it), `nonce` against the one sent, and PKCE (S256) binds the code to this
 * flow. The account is found by Google's `sub`, never by the email.
 *
 * The ID token's signature is not checked against Google's keys: OpenID Connect Core §3.1.3.7
 * (6) lets a client that got the token straight from the token endpoint over TLS rely on that
 * connection instead. The request is ours, to Google's fixed address, authenticated with the
 * client secret, so nobody else could have put a token in the answer. That saves fetching and
 * caching the JWKS and an RSA check; `iss`, `aud`, `exp`, `iat`, `nonce` and `email_verified` are
 * still checked (`checkIdToken`).
 *
 * Google is on only when both `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set (wrangler
 * secrets); PR previews get neither, so they have no Google sign-in. The service only sees
 * `GoogleAuth`; `fetcher` is for tests.
 */

import { BOOK_SITE } from '../shared/book-site.ts'

export const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
/** The issuers Google's ID tokens name (both spellings are in use) */
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com']
/** Where Google sends the browser back, on whichever site started the flow */
export const GOOGLE_CALLBACK_PATH = '/api/auth/google/callback'
/** The cookie that ties a flow to the browser that started it; only `/api/` reads it */
export const GOOGLE_COOKIE = 'tbt_google'
/** How long a flow may take at Google (start → callback) */
export const GOOGLE_START_MS = 10 * 60_000
/** How long the code step after Google takes at most (兩步驟登入) */
export const GOOGLE_CODE_MS = 5 * 60_000
/** How long an application with Google may take to fill in */
export const GOOGLE_APPLY_MS = 30 * 60_000
/** Clock leeway for `iat` */
const SKEW_S = 300

/** What the service needs from Google */
export interface GoogleAuth {
  clientId: string
  /** Google's sign-in page for one flow */
  authorizeUrl(flow: { redirectUri: string; state: string; nonce: string; challenge: string }): string
  /** The ID token's claims for an authorization code; throws when Google refuses the code */
  exchange(flow: { code: string; verifier: string; redirectUri: string }): Promise<Record<string, unknown>>
}

/** Who Google says it is: the stable id, and the email and name only as Google gave them */
export interface GoogleIdentity {
  sub: string
  email: string
  name: string
}

export function googleAuth(clientId: string, clientSecret: string, fetcher: typeof fetch = fetch): GoogleAuth {
  return {
    clientId,
    authorizeUrl({ redirectUri, state, nonce, challenge }) {
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        state,
        nonce,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        prompt: 'select_account',
      })
      return `${GOOGLE_AUTHORIZE_URL}?${params}`
    },
    async exchange({ code, verifier, redirectUri }) {
      const response = await fetcher(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
          code_verifier: verifier,
        }),
      })
      if (!response.ok) throw new Error(`Google's token endpoint answered ${response.status}`)
      const body = (await response.json()) as { id_token?: unknown }
      if (typeof body.id_token !== 'string') throw new Error('No ID token')
      return decodeJwtPayload(body.id_token)
    },
  }
}

/** Google, unless either secret is missing */
export function googleFrom(env: { GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string }): GoogleAuth | undefined {
  const id = env.GOOGLE_CLIENT_ID?.trim()
  const secret = env.GOOGLE_CLIENT_SECRET?.trim()
  return id && secret ? googleAuth(id, secret) : undefined
}

const toBase64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')

/** A JWT's payload, read without checking its signature (see the top of this file for why) */
export function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.')
  if (parts.length !== 3 || !/^[\w-]+$/.test(parts[1])) throw new Error('Not a JWT')
  const binary = atob(parts[1].replaceAll('-', '+').replaceAll('_', '/'))
  const text = new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)))
  const payload = JSON.parse(text) as unknown
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Not a JWT')
  return payload as Record<string, unknown>
}

/**
 * The identity in an ID token's claims, or null when they are not for us or not fresh: the
 * issuer is Google, the audience is our client (`azp` too when there are several), it has not
 * expired and was not issued in the future, the nonce is this flow's, the email is verified and
 * there is a `sub`
 */
export function checkIdToken(
  claims: Record<string, unknown>,
  expected: { clientId: string; nonce: string; now: number },
): GoogleIdentity | null {
  const now = Math.floor(expected.now / 1000)
  const aud = claims.aud
  const audiences = Array.isArray(aud) ? aud : [aud]
  if (!GOOGLE_ISSUERS.includes(String(claims.iss))) return null
  if (!audiences.includes(expected.clientId)) return null
  if (audiences.length > 1 && claims.azp !== expected.clientId) return null
  if (typeof claims.exp !== 'number' || claims.exp <= now) return null
  if (typeof claims.iat === 'number' && claims.iat > now + SKEW_S) return null
  if (!expected.nonce || claims.nonce !== expected.nonce) return null
  if (claims.email_verified !== true && claims.email_verified !== 'true') return null
  const sub = typeof claims.sub === 'string' ? claims.sub : ''
  if (!/^[\w-]{1,255}$/.test(sub)) return null
  return {
    sub,
    email: typeof claims.email === 'string' ? claims.email.trim().toLowerCase().slice(0, 254) : '',
    name: typeof claims.name === 'string' ? claims.name.trim() : '',
  }
}

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
 * port goes too (橋館's dev server proxies to the table's). Anything else is refused: Google only
 * sends browsers back to the redirect addresses registered for the client, and this keeps every
 * address we hand out one of them
 */
export function googleSite(pageOrigin: string, workerUrl: URL): { origin: string; site: 'table' | 'book' } | null {
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

/** The flow cookie, or (with an empty id) the one that clears it */
export function googleCookie(id: string, secure: boolean, maxAgeMs = GOOGLE_START_MS): string {
  return [
    `${GOOGLE_COOKIE}=${id}`,
    'Path=/api/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${id ? Math.floor(maxAgeMs / 1000) : 0}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ')
}

// ── Flows in the club's storage ─────────────────────────────────────────────────────────────────

/**
 * One Google flow, kept as `google:<id>` until it finishes or expires. The id is the `state` sent
 * to Google and the value of the browser's `tbt_google` cookie; each step takes the record (it
 * works once) and the next step gets a new id:
 * - `start`: on the way to Google; `userId` when a signed-in member is binding Google
 * - `code`: Google named an account with 兩步驟登入; the code step signs in (`userId`)
 * - `apply`: Google named no account; the application form may use it (`sub`, `email`, `name`)
 */
export type GoogleFlow =
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

const FLOW_KEY = 'google:'
/** Live flows at most; past it new ones are refused until some expire (a flood cannot fill storage) */
export const GOOGLE_FLOWS_MAX = 500

interface FlowStore {
  get<T>(key: string): Promise<T | undefined>
  put<T>(key: string, value: T): Promise<void>
  delete(key: string): Promise<void>
  list<T>(prefix: string): Promise<Map<string, T>>
}

export class GoogleFlows {
  private readonly store: FlowStore
  private readonly now: () => number

  constructor(store: FlowStore, now: () => number) {
    this.store = store
    this.now = now
  }

  /** Keeps a new flow; its id, or null when there are too many live ones. Expired ones are dropped first */
  async create(flow: GoogleFlow, id = oauthRandom()): Promise<string | null> {
    const now = this.now()
    let live = 0
    for (const [key, kept] of await this.store.list<GoogleFlow>(FLOW_KEY)) {
      if (kept.expiresAt <= now) await this.store.delete(key)
      else live++
    }
    if (live >= GOOGLE_FLOWS_MAX) return null
    await this.store.put(FLOW_KEY + id, flow)
    return id
  }

  /** A live flow by its id, left in place (the code step may take several tries) */
  async peek(id: string | null): Promise<GoogleFlow | null> {
    if (!id || !/^[\w-]{20,64}$/.test(id)) return null
    const flow = await this.store.get<GoogleFlow>(FLOW_KEY + id)
    if (!flow) return null
    if (flow.expiresAt <= this.now()) {
      await this.store.delete(FLOW_KEY + id)
      return null
    }
    return flow
  }

  /** A live flow by its id, removed: it works once */
  async take(id: string | null): Promise<GoogleFlow | null> {
    const flow = await this.peek(id)
    if (flow) await this.store.delete(FLOW_KEY + id)
    return flow
  }

  async drop(id: string) {
    await this.store.delete(FLOW_KEY + id)
  }
}
