/**
 * Edge passes (ARCHITECTURE.md §5.12, `e11-t19`): a short-lived, signed cookie that tells the Worker
 * who a request is from without asking the club's Durable Object. The session itself stays in the
 * club (`session:<token>`); the pass is only a copy of "this browser is signed in as X", good for
 * EDGE_PASS_MS. The club hands out a new one on any API answer when the old one is missing or more
 * than half used, so a member who uses the site keeps one; the Worker falls back to asking the club
 * whenever the pass is missing, expired, forged or the switch is off.
 *
 * Format: `<userId>.<expiry, base 36>.<HMAC-SHA-256, base64url>`, signed with the `EDGE_AUTH_SECRET`
 * secret. WebCrypto only, so it runs in the Worker, the Durable Object and Node tests alike.
 */

export const PASS_COOKIE = 'tbt_pass'
/** How long a pass is good for: also the longest a pass outlives a revoked session (§5.12) */
export const EDGE_PASS_MS = 10 * 60_000
/** The club hands out a new pass once the old one has less than this left */
export const EDGE_PASS_REFRESH_MS = EDGE_PASS_MS / 2

const encoder = new TextEncoder()
const USER_ID = /^[\w-]{1,64}$/
const keys = new Map<string, Promise<CryptoKey>>()

function keyFor(secret: string): Promise<CryptoKey> {
  let key = keys.get(secret)
  if (!key) {
    key = crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
    keys.set(secret, key)
  }
  return key
}

const toBase64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[\w-]+$/.test(text)) return null
  try {
    return Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0))
  } catch {
    return null
  }
}

const signed = (userId: string, expires: string) => encoder.encode(`pass1:${userId}:${expires}`)

/** A pass for `userId`, good until `now + EDGE_PASS_MS` */
export async function mintPass(secret: string, userId: string, now: number): Promise<string> {
  if (!USER_ID.test(userId)) throw new Error('A pass needs a plain member id')
  const expires = (now + EDGE_PASS_MS).toString(36)
  const signature = await crypto.subtle.sign('HMAC', await keyFor(secret), signed(userId, expires))
  return `${userId}.${expires}.${toBase64Url(new Uint8Array(signature))}`
}

/** What a pass says, if its signature is right and it has not expired; null otherwise */
export async function readPass(secret: string, pass: string | null, now: number): Promise<{ userId: string; expires: number } | null> {
  if (!secret || !pass || pass.length > 200) return null
  const [userId, expiresText, signatureText, ...rest] = pass.split('.')
  if (rest.length || !userId || !USER_ID.test(userId) || !/^[0-9a-z]{1,12}$/.test(expiresText ?? '')) return null
  const expires = parseInt(expiresText, 36)
  // A pass never runs longer than EDGE_PASS_MS (a minute's leeway for clocks that differ)
  if (!(expires > now) || expires > now + EDGE_PASS_MS + 60_000) return null
  const signature = fromBase64Url(signatureText ?? '')
  if (!signature) return null
  const ok = await crypto.subtle.verify('HMAC', await keyFor(secret), signature, signed(userId, expiresText))
  return ok ? { userId, expires } : null
}

/** Whether the club should hand out a new pass with its answer: none, a bad one, or one more than half used */
export async function passNeedsRefresh(secret: string, pass: string | null, now: number): Promise<boolean> {
  const read = await readPass(secret, pass, now)
  return !read || read.expires - now < EDGE_PASS_REFRESH_MS
}

/** The pass cookie, or (with an empty pass) the cookie that clears it; HttpOnly like the session's */
export function passCookie(pass: string, secure: boolean): string {
  return [
    `${PASS_COOKIE}=${pass}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${pass ? Math.floor(EDGE_PASS_MS / 1000) : 0}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ')
}

/** The secret edge passes are signed with, unless switched off (`EDGE_AUTH=off`) or not set: then there are none */
export function edgeSecret(env: { EDGE_AUTH?: string; EDGE_AUTH_SECRET?: string }): string | undefined {
  return env.EDGE_AUTH === 'off' ? undefined : env.EDGE_AUTH_SECRET || undefined
}
