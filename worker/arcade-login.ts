import { ARCADE_LOGIN_API, ARCADE_LOGIN_PAGE } from '../shared/arcade.ts'
import { DEFAULT_CLUB_ID } from '../shared/clubs.ts'
import { formatMessage, type MessageCode } from '../shared/messages.ts'
import { noLog, type Logger } from './log.ts'

/**
 * Signing a member in to TKU Arcade (e1-t37, ARCHITECTURE.md §5.2「TKU Arcade 的登入交接」): the
 * arcade sends the browser here with `return_to` (a page of the arcade) and `state` (its own
 * anti-CSRF value); a 淡江 member who is signed in is sent straight back with a short-lived token
 * signed with a secret the two Workers share, in the URL's fragment (never in a server log). The
 * arcade checks it and starts its own session: no session, cookie or account code is shared.
 *
 * Without the Cloudflare APIs (tests/worker/arcade-login.test.ts): `worker/routing.ts` gives the
 * club's answer to "whose session is this".
 */

export { ARCADE_LOGIN_API, ARCADE_LOGIN_PAGE }
/** How long a token is good for: at most five minutes, from the arcade's design */
export const ARCADE_TOKEN_SECONDS = 300
/** A shorter secret is treated as none: the endpoint stays off */
export const ARCADE_SECRET_MIN = 32
/** The fragment's key on the way back */
export const ARCADE_TOKEN_PARAM = 'overtrick_token'
/** The token's format, first in the token and in what is signed: the arcade refuses any other */
export const ARCADE_TOKEN_VERSION = 'v1'
/** Long enough for any arcade page; the sign-in page's way back (`safeReturn`) holds 300 characters */
const RETURN_MAX = 200
/** The arcade's `state`: base64url, 16–128 characters */
const STATE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/

/** What the token says (times in seconds since 1970) */
export interface ArcadeClaims {
  /** Always `overtrick` */
  iss: string
  /** The arcade's origin the token is for: the `return_to`'s */
  aud: string
  /** The member's account id */
  sub: string
  /** The name the member is shown by here: their profile's display name, else their username */
  name: string
  /** The member's club: only 淡江 for now */
  club: string
  iat: number
  exp: number
  /** A random id, so the arcade can take each token once */
  jti: string
  /** The arcade's `state`, sent back signed */
  nonce: string
}

export interface ArcadeLoginDeps {
  /** Worker secret `ARCADE_LOGIN_SECRET`; the arcade has the same value as `AUTH_SHARED_SECRET` */
  secret?: string
  /** Var `ARCADE_ORIGINS` (wrangler.jsonc): the arcade's origins, comma-separated */
  origins?: string
  /** 淡江's member signed in with this session token (the club's `arcadeIdentity`), or null */
  identity(sessionToken: string | null): Promise<{ id: string; name: string } | null>
  /** The 淡江 session token in the request's cookies */
  sessionToken: string | null
  now?: () => number
  log?: Logger
}

/**
 * The allow-list: exact origins (`https://tku-arcade.genelee-pro.workers.dev`), or one `*` in the
 * host standing for a pull request's number (`https://tku-arcade-pr-*.genelee-pro.workers.dev`).
 * Anything else in the list is ignored, so a typo makes the list narrower, never wider
 */
export function originPatterns(config: string | undefined): RegExp[] {
  const patterns: RegExp[] = []
  for (const entry of (config ?? '').split(',').map((part) => part.trim())) {
    const stars = entry.split('*').length - 1
    if (!entry || stars > 1) continue
    let sample: URL
    try {
      sample = new URL(entry.replace('*', '0'))
    } catch {
      continue
    }
    // Exactly an origin (no path, no user), https, or http only for a developer's localhost
    if (sample.origin !== entry.replace('*', '0')) continue
    if (sample.protocol !== 'https:' && !(sample.protocol === 'http:' && sample.hostname === 'localhost')) continue
    // The star only in the host's first label, beside something fixed, never standing for a dot
    const label = entry.slice(sample.protocol.length + 2).split('.')[0]
    if (stars === 1 && (label === '*' || !/^[a-z0-9-]*\*[a-z0-9-]*$/.test(label))) continue
    const escaped = entry.replace(/[.+?^${}()|[\]\\/]/g, '\\$&')
    patterns.push(new RegExp(`^${escaped.replace('*', '[0-9]{1,6}')}$`))
  }
  return patterns
}

/**
 * The page to go back to, when it is on the allow-list: an absolute URL with no user name,
 * password or fragment, at most RETURN_MAX characters. Never an open redirect: no relative path,
 * no other scheme, no host that is not listed
 */
export function allowedReturn(raw: string | null, patterns: readonly RegExp[]): URL | null {
  if (!raw || raw.length > RETURN_MAX) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.username || url.password || url.hash || raw.includes('#') || raw.includes('\\')) return null
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  return patterns.some((pattern) => pattern.test(url.origin)) ? url : null
}

const encoder = new TextEncoder()

export function base64url(bytes: Uint8Array): string {
  let text = ''
  for (const byte of bytes) text += String.fromCharCode(byte)
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** `v1.<claims as base64url JSON>.<HMAC-SHA256 of the first two parts, base64url>` */
export async function signArcadeToken(secret: string, claims: ArcadeClaims): Promise<string> {
  const body = `${ARCADE_TOKEN_VERSION}.${base64url(encoder.encode(JSON.stringify(claims)))}`
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(body)))
  return `${body}.${base64url(signature)}`
}

/** `GET /api/arcade/login?return_to=<arcade page>&state=<arcade's value>[&resume=1]` */
export async function arcadeLogin(request: Request, deps: ArcadeLoginDeps): Promise<Response> {
  const log = deps.log ?? noLog
  if (request.method !== 'GET') return errorAnswer('noSuchApi', 404)
  const patterns = originPatterns(deps.origins)
  if (!deps.secret || deps.secret.length < ARCADE_SECRET_MIN || patterns.length === 0) return errorAnswer('arcadeLoginOff', 404)
  const params = new URL(request.url).searchParams
  const back = allowedReturn(params.get('return_to'), patterns)
  const state = params.get('state') ?? ''
  if (!back || !STATE_PATTERN.test(state)) {
    log({ event: 'arcadeRefused', reason: back ? 'state' : 'returnTo' })
    return errorAnswer('arcadeReturnNotAllowed', 400)
  }
  const member = await deps.identity(deps.sessionToken)
  if (!member) {
    // Back from the sign-in page and still signed out: say so rather than go round again
    if (params.get('resume') === '1') return errorAnswer('signInFirst', 401)
    const signIn = new URLSearchParams({ return_to: back.href, state })
    return redirect(`${ARCADE_LOGIN_PAGE}?${signIn}`)
  }
  const now = Math.floor((deps.now ?? Date.now)() / 1000)
  const token = await signArcadeToken(deps.secret, {
    iss: 'overtrick',
    aud: back.origin,
    sub: member.id,
    name: member.name,
    club: DEFAULT_CLUB_ID,
    iat: now,
    exp: now + ARCADE_TOKEN_SECONDS,
    jti: base64url(crypto.getRandomValues(new Uint8Array(16))),
    nonce: state,
  })
  log({ event: 'arcadeToken' })
  return redirect(`${back.href}#${ARCADE_TOKEN_PARAM}=${token}`)
}

function redirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
  })
}

/** Shaped like the club's own errors (`worker/routing.ts`) */
function errorAnswer(code: MessageCode, status: number): Response {
  return new Response(JSON.stringify({ error: formatMessage(code, 'zh', {}), code, params: {} }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}
