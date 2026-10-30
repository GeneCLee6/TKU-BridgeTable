/**
 * Password hashing and session cookies with WebCrypto only, so the same code runs in the Worker
 * and in Node tests. Hashes are stored as `pbkdf2$<iterations>$<salt>$<hash>` (base64), which lets
 * the iteration count change later without breaking existing accounts.
 */

/**
 * PBKDF2-SHA-256 iterations for new hashes (e11-t30, docs/SECURITY.md V2.4.1). 100,000 is the most
 * Cloudflare's runtime takes for PBKDF2 (more is refused there), twice the 50,000 used before. A
 * hash takes about 12 ms of CPU (Node, measured 2026-10-30); it runs in the club's Durable Object,
 * not the Worker's 10 ms request, and sign-ins are rate-limited (worker/rate-limit.ts)
 */
export const ITERATIONS = 100_000
const encoder = new TextEncoder()

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0))

async function derive(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    256,
  )
  return new Uint8Array(bits)
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const hash = await derive(password, salt, ITERATIONS)
  return `pbkdf2$${ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iterations, salt, expected] = stored.split('$')
  if (scheme !== 'pbkdf2') return false
  const actual = await derive(password, fromBase64(salt), Number(iterations))
  const wanted = fromBase64(expected)
  if (actual.length !== wanted.length) return false
  // Constant-time comparison
  let diff = 0
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ wanted[i]
  return diff === 0
}

/** Whether a stored hash was made with fewer iterations than now (or another scheme): rehash it at the next sign-in */
export function needsRehash(stored: string): boolean {
  const [scheme, iterations] = stored.split('$')
  return scheme !== 'pbkdf2' || Number(iterations) < ITERATIONS
}

export function randomId(bytes = 16): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** How long an approved password reset's code works (e1-t36): time for the admin to reach the member */
export const RESET_CODE_MS = 3 * 86_400_000
/** Letters and digits that cannot be mistaken for one another when read out (no 0/O, 1/I/L) */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

/**
 * A one-time password reset code: 10 characters (about 49 bits), shown as `XXXXX-XXXXX`. Guessing is
 * bounded by the sign-in limits, and the code dies after RESET_CODE_MS or its first use
 */
export function resetCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10))
  // 31 characters: the small bias of `% 31` costs well under a bit
  const text = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('')
  return `${text.slice(0, 5)}-${text.slice(5)}`
}

/** How a reset code is kept: SHA-256 (hex) of the code, with dashes, spaces and case ignored */
export async function hashResetCode(code: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(code.toUpperCase().replace(/[\s-]/g, '')))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export const SESSION_COOKIE = 'tbt_session'
export const SESSION_DAYS = 30

export function readCookie(header: string | null, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return decodeURIComponent(rest.join('='))
  }
  return null
}

export function sessionCookie(token: string, secure: boolean): string {
  const maxAge = token ? SESSION_DAYS * 86_400 : 0
  return [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ')
}
