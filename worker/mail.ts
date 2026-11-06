/**
 * Email (e1-t29, e1-t30; ARCHITECTURE.md §5.20): binding an address to an account, and resetting a
 * forgotten password through it. The club's service only sees `Mailer`; the Durable Object makes
 * one from the Worker's settings (`mailerFrom`), and without them there is none and email is off.
 *
 * The mail goes through Resend's HTTP API (one `fetch`, no parsing beyond the status), so it costs
 * the Worker almost no CPU; ARCHITECTURE.md §5.20 has why Resend and not Cloudflare Email Service.
 */

import { formatMessage, isLang, type Lang, type MessageCode, type MessageParams } from '../shared/messages.ts'
import { toHalfWidth } from '../shared/halfwidth.ts'

/** One plain-text message to one address */
export interface MailMessage {
  to: string
  subject: string
  text: string
}

/** Sends mail; throws when the provider refuses it */
export interface Mailer {
  send(message: MailMessage): Promise<void>
}

/** Longest address kept (RFC 5321 allows 254) */
export const EMAIL_MAX_CHARS = 254
/** How long a verification link works */
export const EMAIL_VERIFY_MS = 24 * 3_600_000
/** How long a password reset link works */
export const EMAIL_RESET_MS = 30 * 60_000

const RESEND_URL = 'https://api.resend.com/emails'

/**
 * Resend (https://resend.com): `RESEND_API_KEY` and `MAIL_FROM` (an address on a domain verified
 * there, e.g. `淡江牌桌 <no-reply@example.org>`). `fetcher` is for tests
 */
export function resendMailer(apiKey: string, from: string, fetcher: typeof fetch = fetch): Mailer {
  return {
    async send({ to, subject, text }) {
      const response = await fetcher(RESEND_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject, text }),
      })
      if (!response.ok) throw new Error(`Resend answered ${response.status}`)
    },
  }
}

/** The mailer the Worker's settings make, or none (email off) unless both are set */
export function mailerFrom(env: { RESEND_API_KEY?: string; MAIL_FROM?: string }): Mailer | undefined {
  return env.RESEND_API_KEY && env.MAIL_FROM ? resendMailer(env.RESEND_API_KEY, env.MAIL_FROM) : undefined
}

/** An address as kept and compared: trimmed and lower-cased */
/** An address as stored and compared: half-width (shared/halfwidth.ts), trimmed, lower case */
export const normalizeEmail = (value: unknown) => toHalfWidth(String(value ?? '')).trim().toLowerCase()

/**
 * Whether an address looks deliverable: one `@`, a dot in the domain, no spaces or angle brackets.
 * Only the link we send proves it is the member's
 */
export function isEmail(address: string): boolean {
  return address.length <= EMAIL_MAX_CHARS && /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;.]+$/.test(address)
}

/** A link's secret: 32 random bytes (256 bits), base64url */
export function emailToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** How a link's secret is kept: SHA-256 (hex); the secret itself only ever goes into the mail */
export async function hashEmailToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(token)))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** The language a mail is written in: the one the page asked for, else 繁體中文 */
export const mailLang = (value: unknown): Lang => (isLang(value) ? value : 'zh')

/** A mail's subject and body from `shared/messages.ts`, in one language */
export function composeMail(
  to: string,
  lang: Lang,
  subject: MessageCode,
  body: MessageCode,
  params: MessageParams,
): MailMessage {
  return { to, subject: formatMessage(subject, lang, params), text: formatMessage(body, lang, params) }
}
