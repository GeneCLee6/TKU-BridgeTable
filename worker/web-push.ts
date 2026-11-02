/**
 * Web Push (e1-t28; ARCHITECTURE.md §5.4, docs/SECURITY.md): sending one message to one browser's
 * push service, with WebCrypto only.
 *
 * - **Encryption**: RFC 8291 (Message Encryption for Web Push) in the `aes128gcm` content coding of
 *   RFC 8188: a new P-256 key pair and salt per message, ECDH with the browser's `p256dh`, HKDF with
 *   its `auth` secret, AES-128-GCM over the message and the 0x02 delimiter, in one record.
 * - **VAPID**: RFC 8292: an ES256 JWT (`aud` the push service's origin, `exp`, `sub` a contact)
 *   signed with the club's private key, sent as `Authorization: vapid t=<jwt>, k=<public key>`. One
 *   JWT per push service origin is kept until shortly before it expires, so a push to a hundred
 *   members on the same service signs once.
 *
 * Nothing here knows about members or storage: `worker/push.ts` decides who gets what. The keys are
 * Worker secrets (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`; DEPLOY.md §4.17).
 */

const encoder = new TextEncoder()

export function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const clean = text.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(clean + '='.repeat((4 - (clean.length % 4)) % 4))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/** A browser's subscription as `PushSubscription.toJSON()` gives it */
export interface PushTarget {
  endpoint: string
  /** The browser's P-256 public key, uncompressed (65 bytes), base64url */
  p256dh: string
  /** The browser's 16-byte authentication secret, base64url */
  auth: string
}

/** The record size written in the header; one record holds the whole message */
export const RECORD_SIZE = 4096

/** Whether `p256dh` and `auth` are the sizes RFC 8291 requires */
export function validKeys(p256dh: string, auth: string): boolean {
  try {
    const key = fromBase64url(p256dh)
    return key.length === 65 && key[0] === 4 && fromBase64url(auth).length === 16
  } catch {
    return false
  }
}

/** A raw uncompressed P-256 public key (and the private scalar, if given) as a JWK */
function p256Jwk(publicKey: Uint8Array, d?: Uint8Array): JsonWebKey {
  return {
    kty: 'EC',
    crv: 'P-256',
    x: base64url(publicKey.slice(1, 33)),
    y: base64url(publicKey.slice(33, 65)),
    ...(d ? { d: base64url(d) } : {}),
    ext: true,
  }
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm as BufferSource, 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: info as BufferSource },
    key,
    length * 8,
  )
  return new Uint8Array(bits)
}

/** For tests only: the RFC's fixed sender key and salt instead of fresh ones */
export interface FixedKeys {
  /** The sender's (application server's) key pair, raw: 65-byte public, 32-byte private */
  publicKey: Uint8Array
  privateKey: Uint8Array
  salt: Uint8Array
}

/**
 * RFC 8291 §3–4: `plaintext` encrypted for one browser, as the `aes128gcm` body (the 86-byte header
 * then the one record). Throws when the message would not fit in one record
 */
export async function encryptPush(plaintext: Uint8Array, target: Pick<PushTarget, 'p256dh' | 'auth'>, fixed?: FixedKeys): Promise<Uint8Array> {
  if (plaintext.length + 17 > RECORD_SIZE) throw new Error('push message too long')
  const uaPublic = fromBase64url(target.p256dh)
  const authSecret = fromBase64url(target.auth)
  let asPublic: Uint8Array
  let asPrivate: CryptoKey
  if (fixed) {
    asPublic = fixed.publicKey
    asPrivate = await crypto.subtle.importKey('jwk', p256Jwk(fixed.publicKey, fixed.privateKey), { name: 'ECDH', namedCurve: 'P-256' }, false, [
      'deriveBits',
    ])
  } else {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair
    asPublic = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer)
    asPrivate = pair.privateKey
  }
  const salt = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16))
  const uaKey = await crypto.subtle.importKey('raw', uaPublic as BufferSource, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  // The standard name is `public` (workers-types spells it `$public`, which no runtime reads)
  const ecdh = { name: 'ECDH', public: uaKey } as unknown as Parameters<SubtleCrypto['deriveBits']>[0]
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits(ecdh, asPrivate, 256))
  // IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info" || 0x00 || ua_public || as_public, 32)
  const keyInfo = concat(encoder.encode('WebPush: info\0'), uaPublic, asPublic)
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32)
  const cek = await hkdf(salt, ikm, encoder.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, encoder.encode('Content-Encoding: nonce\0'), 12)
  const aesKey = await crypto.subtle.importKey('raw', cek as BufferSource, 'AES-GCM', false, ['encrypt'])
  // The last (and only) record ends with the 0x02 delimiter and no padding
  const padded = concat(plaintext, new Uint8Array([2]))
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, aesKey, padded as BufferSource))
  const header = new Uint8Array(21)
  header.set(salt, 0)
  new DataView(header.buffer).setUint32(16, RECORD_SIZE)
  header[20] = asPublic.length
  return concat(header, asPublic, ciphertext)
}

/** The club's VAPID key pair, as made by `npm run vapid` (both raw, base64url) */
export interface VapidKeys {
  publicKey: string
  privateKey: string
  /** Who runs the server, for the push services to reach: `mailto:` or `https:` */
  subject: string
}

/** How long a VAPID JWT is valid (RFC 8292 allows up to 24 hours) */
export const VAPID_JWT_MS = 12 * 3_600_000
/** A cached JWT is replaced this long before it expires */
const VAPID_RENEW_MS = 3_600_000

/** What one push came back with */
export interface PushResult {
  status: number
}

/** How urgent a push is (RFC 8030 §5.3): invitations wake a phone, the rest may wait for it */
export type PushUrgency = 'very-low' | 'low' | 'normal' | 'high'

/** Sends one encrypted push; `worker/push.ts` only sees this */
export interface PushSender {
  readonly publicKey: string
  send(target: PushTarget, message: string, options?: { urgency?: PushUrgency; ttl?: number }): Promise<PushResult>
}

/** Whether the keys look right: a 65-byte P-256 public key and a 32-byte private key */
export function validVapid(keys: Partial<VapidKeys>): keys is VapidKeys {
  try {
    return (
      !!keys.subject &&
      /^(mailto:|https:)/.test(keys.subject) &&
      fromBase64url(keys.publicKey ?? '').length === 65 &&
      fromBase64url(keys.privateKey ?? '').length === 32
    )
  } catch {
    return false
  }
}

/** Web Push to any push service, signing with the club's VAPID key */
export class WebPush implements PushSender {
  readonly publicKey: string
  private readonly keys: VapidKeys
  private readonly fetcher: typeof fetch
  private readonly now: () => number
  private signingKey?: Promise<CryptoKey>
  /** One JWT per push service origin, until shortly before it expires */
  private readonly jwts = new Map<string, { jwt: string; expires: number }>()

  constructor(keys: VapidKeys, fetcher: typeof fetch = (input, init) => fetch(input, init), now: () => number = Date.now) {
    this.keys = keys
    this.publicKey = keys.publicKey
    this.fetcher = fetcher
    this.now = now
  }

  private key() {
    this.signingKey ??= crypto.subtle.importKey(
      'jwk',
      p256Jwk(fromBase64url(this.keys.publicKey), fromBase64url(this.keys.privateKey)),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    )
    return this.signingKey
  }

  /** RFC 8292 §2: the JWT for one push service origin, signed once and kept */
  async jwtFor(audience: string): Promise<string> {
    const now = this.now()
    const kept = this.jwts.get(audience)
    if (kept && kept.expires - VAPID_RENEW_MS > now) return kept.jwt
    const expires = now + VAPID_JWT_MS
    const header = base64url(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
    const claims = base64url(encoder.encode(JSON.stringify({ aud: audience, exp: Math.floor(expires / 1000), sub: this.keys.subject })))
    const signed = `${header}.${claims}`
    // WebCrypto's ECDSA signature is already JWS's r || s
    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await this.key(), encoder.encode(signed))
    const jwt = `${signed}.${base64url(new Uint8Array(signature))}`
    this.jwts.set(audience, { jwt, expires })
    return jwt
  }

  async send(target: PushTarget, message: string, options: { urgency?: PushUrgency; ttl?: number } = {}): Promise<PushResult> {
    const audience = new URL(target.endpoint).origin
    const [jwt, body] = await Promise.all([this.jwtFor(audience), encryptPush(encoder.encode(message), target)])
    const response = await this.fetcher(target.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `vapid t=${jwt}, k=${this.keys.publicKey}`,
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(options.ttl ?? 86_400),
        Urgency: options.urgency ?? 'normal',
      },
      body: body as BodyInit,
    })
    // Only the status matters; the body is dropped unread
    await response.body?.cancel().catch(() => undefined)
    return { status: response.status }
  }
}

/** The sender the Worker's settings make, or none (push off) unless all three are set and well formed */
export function pushFrom(env: { VAPID_PUBLIC_KEY?: string; VAPID_PRIVATE_KEY?: string; VAPID_SUBJECT?: string }): PushSender | undefined {
  const keys = { publicKey: env.VAPID_PUBLIC_KEY?.trim(), privateKey: env.VAPID_PRIVATE_KEY?.trim(), subject: env.VAPID_SUBJECT?.trim() }
  return validVapid(keys) ? new WebPush(keys) : undefined
}

/**
 * The push services browsers use: a subscription must point at one of them, so the club never
 * posts to an address a member made up (Chrome/Edge/Android through FCM, Firefox's autopush,
 * Windows' WNS for Edge, Apple's for Safari)
 */
const PUSH_HOSTS = ['fcm.googleapis.com', 'android.googleapis.com', '.push.services.mozilla.com', '.notify.windows.com', '.push.apple.com']

/** Longest endpoint accepted */
export const ENDPOINT_MAX = 1024

export function allowedEndpoint(endpoint: string): boolean {
  if (endpoint.length > ENDPOINT_MAX) return false
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false
  return PUSH_HOSTS.some((host) => (host.startsWith('.') ? url.hostname.endsWith(host) : url.hostname === host))
}
