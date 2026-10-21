/**
 * Password hashing and session cookies with WebCrypto only, so the same code runs in the Worker
 * and in Node tests. Hashes are stored as `pbkdf2$<iterations>$<salt>$<hash>` (base64), which lets
 * the iteration count change later without breaking existing accounts.
 */

// Workers on the free plan have a small CPU budget per request; this keeps a login well inside it
const ITERATIONS = 50_000
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

export function randomId(bytes = 16): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
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
