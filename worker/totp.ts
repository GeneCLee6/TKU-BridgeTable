/**
 * Time-based one-time passwords (RFC 6238, e11-t31): the admins' second sign-in step. WebCrypto
 * only (HMAC-SHA-1), so the same code runs in the club's Durable Object and in Node tests. One
 * check is at most three HMACs over 8 bytes, far under the free plan's CPU budget.
 *
 * The parameters are the ones every authenticator app takes without asking: SHA-1, 6 digits, 30
 * seconds. A code from the step before or after also counts (a phone's clock a little off), and a
 * step that signed in once never signs in again (`lastStep`), so a code seen over a shoulder cannot
 * be replayed.
 */

import { hashResetCode, resetCode } from './auth.ts'
import { toHalfWidth } from '../shared/halfwidth.ts'

export const TOTP_DIGITS = 6
export const TOTP_PERIOD_S = 30
/** Steps before and after the current one that still count */
export const TOTP_DRIFT = 1
/** Bytes of a new secret: 160 bits, as RFC 4226 recommends */
export const TOTP_SECRET_BYTES = 20
/** How long a secret shown at setup waits for its first code */
export const TOTP_SETUP_MS = 10 * 60_000
/** Recovery codes made at once; each signs in once in place of a code */
export const RECOVERY_CODES = 10
/** The name authenticator apps show above the code */
export const TOTP_ISSUER = 'TKU BridgeTable'

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** RFC 4648 base32 without padding, the form authenticator apps take */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

/** Reads base32, ignoring case, spaces and padding; null when a character is not base32 */
export function base32Decode(text: string): Uint8Array<ArrayBuffer> | null {
  const clean = text.toUpperCase().replace(/[\s=]/g, '')
  const out: number[] = []
  let bits = 0
  let value = 0
  for (const char of clean) {
    const index = BASE32.indexOf(char)
    if (index < 0) return null
    value = ((value << 5) | index) & 0xffff
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Uint8Array.from(out)
}

/** A new random secret, in base32 (32 characters) */
export function newTotpSecret(): string {
  return base32Encode(crypto.getRandomValues(new Uint8Array(TOTP_SECRET_BYTES)))
}

/** The 30-second step a time (ms) falls in */
export const totpStep = (now: number) => Math.floor(now / 1000 / TOTP_PERIOD_S)

/** The code for one step (RFC 4226's HOTP with the step as the counter) */
export async function totpCode(secret: string, step: number): Promise<string> {
  const key = base32Decode(secret)
  if (!key || !key.length) throw new Error('bad TOTP secret')
  const counter = new Uint8Array(8)
  new DataView(counter.buffer).setBigUint64(0, BigInt(step))
  const hmacKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, counter))
  const offset = mac[mac.length - 1] & 0x0f
  const binary =
    ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3]
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0')
}

/** Whether text is shaped like a code from the app (6 digits, spaces allowed) rather than a recovery code */
export const looksLikeTotp = (text: string) => /^\d{6}$/.test(toHalfWidth(text).replace(/\s/g, ''))

/**
 * The step a code matches, newer than `lastStep` and within TOTP_DRIFT of now; null when it does
 * not. Every candidate step is compared, so the time taken does not say which one matched
 */
export async function verifyTotp(secret: string, code: string, now: number, lastStep = -1): Promise<number | null> {
  const wanted = toHalfWidth(String(code ?? '')).replace(/\s/g, '')
  if (!/^\d{6}$/.test(wanted)) return null
  const current = totpStep(now)
  let found: number | null = null
  for (let step = current - TOTP_DRIFT; step <= current + TOTP_DRIFT; step++) {
    const actual = await totpCode(secret, step)
    let diff = 0
    for (let i = 0; i < TOTP_DIGITS; i++) diff |= actual.charCodeAt(i) ^ wanted.charCodeAt(i)
    if (diff === 0 && step > lastStep && found === null) found = step
  }
  return found
}

/**
 * The `otpauth://` address authenticator apps read (from a link on the phone, or typed in): the
 * club's name and the account above the code
 */
export function otpauthUri(secret: string, account: string, issuer = TOTP_ISSUER): string {
  const label = encodeURIComponent(`${issuer}:${account}`)
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_S),
  })
  return `otpauth://totp/${label}?${params.toString().replace(/\+/g, '%20')}`
}

/** New recovery codes (`XXXXX-XXXXX`, about 49 bits each) and the SHA-256 kept of each */
export async function newRecoveryCodes(count = RECOVERY_CODES): Promise<{ codes: string[]; hashes: string[] }> {
  const codes = Array.from({ length: count }, () => resetCode())
  return { codes, hashes: await Promise.all(codes.map(hashResetCode)) }
}

/** How a recovery code is kept: as a reset code is (dashes, spaces and case ignored) */
export const hashRecoveryCode = hashResetCode
