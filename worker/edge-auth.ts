/**
 * Edge passes (ARCHITECTURE.md §5.12, `e11-t19`): a short-lived, signed cookie that tells the Worker
 * who a request is from without asking the club's Durable Object. The session itself stays in the
 * club (`session:<token>`); the pass is only a copy of "this browser is signed in as X", good for
 * EDGE_PASS_MS. The club hands out a new one on any API answer when the old one is missing or more
 * than half used, so a member who uses the site keeps one; the Worker falls back to asking the club
 * whenever the pass is missing, expired, forged, revoked or the switch is off.
 *
 * Format: `<userId>.<session id>.<expiry, base 36>.<HMAC-SHA-256, base64url>`, signed with the
 * `EDGE_AUTH_SECRET` secret. WebCrypto only, so it runs in the Worker, the Durable Object and Node
 * tests alike.
 *
 * Revoking (e11-t28, docs/SECURITY.md): a pass names the session it was made for (the session's own
 * `id`, never its token). When a session ends (sign-out, 登出其他裝置, a new password, a deleted
 * account) the club writes that id to `pass_revocations` in D1, and the Worker trusts a pass only
 * after checking that table (`passRevoked`). Without D1, or when the check fails, the Worker asks
 * the club, as when there is no pass at all.
 */

import type { Statement } from './history-index.ts'
import type { ReplicaDb } from './history-replica.ts'

export const PASS_COOKIE = 'tbt_pass'
/** How long a pass is good for */
export const EDGE_PASS_MS = 10 * 60_000
/** The club hands out a new pass once the old one has less than this left */
export const EDGE_PASS_REFRESH_MS = EDGE_PASS_MS / 2

const encoder = new TextEncoder()
const USER_ID = /^[\w-]{1,64}$/
const SESSION_ID = /^[0-9a-f]{1,32}$/
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

// `pass2`: passes from before e11-t28 (`pass1`, no session) are no longer taken; the club hands out new ones
const signed = (userId: string, sessionId: string, expires: string) => encoder.encode(`pass2:${userId}:${sessionId}:${expires}`)

/** A pass for `userId` signed in with session `sessionId`, good until `now + EDGE_PASS_MS` */
export async function mintPass(secret: string, userId: string, sessionId: string, now: number): Promise<string> {
  if (!USER_ID.test(userId)) throw new Error('A pass needs a plain member id')
  if (!SESSION_ID.test(sessionId)) throw new Error('A pass needs a session id')
  const expires = (now + EDGE_PASS_MS).toString(36)
  const signature = await crypto.subtle.sign('HMAC', await keyFor(secret), signed(userId, sessionId, expires))
  return `${userId}.${sessionId}.${expires}.${toBase64Url(new Uint8Array(signature))}`
}

export interface Pass {
  userId: string
  sessionId: string
  expires: number
}

/** What a pass says, if its signature is right and it has not expired; null otherwise. Revoking is checked apart (`passRevoked`) */
export async function readPass(secret: string, pass: string | null, now: number): Promise<Pass | null> {
  if (!secret || !pass || pass.length > 240) return null
  const [userId, sessionId, expiresText, signatureText, ...rest] = pass.split('.')
  if (rest.length || !userId || !USER_ID.test(userId) || !SESSION_ID.test(sessionId ?? '')) return null
  if (!/^[0-9a-z]{1,12}$/.test(expiresText ?? '')) return null
  const expires = parseInt(expiresText, 36)
  // A pass never runs longer than EDGE_PASS_MS (a minute's leeway for clocks that differ)
  if (!(expires > now) || expires > now + EDGE_PASS_MS + 60_000) return null
  const signature = fromBase64Url(signatureText ?? '')
  if (!signature) return null
  const ok = await crypto.subtle.verify('HMAC', await keyFor(secret), signature, signed(userId, sessionId, expiresText))
  return ok ? { userId, sessionId, expires } : null
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

// ── Revoked passes (e11-t28) ──────────────────────────────────────────────────────────────────

/** How long a revoked session stays listed: as long as any pass made for it could still be good (with `readPass`'s leeway) */
export const REVOKED_FOR_MS = EDGE_PASS_MS + 2 * 60_000

const CREATE_REVOCATIONS = 'CREATE TABLE IF NOT EXISTS pass_revocations (session_id TEXT PRIMARY KEY, until INTEGER NOT NULL)'

/**
 * The statements that list `sessionIds` as revoked and drop the entries no pass can need any more,
 * in one D1 batch. The table is made by the first revocation: until then nothing was revoked
 */
export function revocationWrites(sessionIds: string[], now: number): Statement[] {
  const ids = [...new Set(sessionIds)].filter((id) => SESSION_ID.test(id))
  if (!ids.length) return []
  const until = now + REVOKED_FOR_MS
  const statements: Statement[] = [
    { sql: CREATE_REVOCATIONS, params: [] },
    { sql: 'DELETE FROM pass_revocations WHERE until < ?', params: [now] },
  ]
  // 40 ids a statement stays well under D1's 100 bound parameters
  for (let i = 0; i < ids.length; i += 40) {
    const part = ids.slice(i, i + 40)
    statements.push({
      sql: `INSERT OR REPLACE INTO pass_revocations (session_id, until) VALUES ${part.map(() => '(?, ?)').join(', ')}`,
      params: part.flatMap((id) => [id, until]),
    })
  }
  return statements
}

/**
 * Whether the session a pass names has ended. No table yet means nothing was ever revoked (the
 * first revocation makes it); any other failure throws, and the Worker then asks the club
 */
export async function passRevoked(db: ReplicaDb, sessionId: string, now: number): Promise<boolean> {
  try {
    const [rows] = await db.batch([
      { sql: 'SELECT 1 AS revoked FROM pass_revocations WHERE session_id = ? AND until >= ?', params: [sessionId, now] },
    ])
    return rows.length > 0
  } catch (error) {
    if (/no such table/i.test(String(error instanceof Error ? error.message : error))) return false
    throw error
  }
}
