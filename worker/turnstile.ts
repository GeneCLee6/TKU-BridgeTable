import { ClubError } from './errors.ts'
import type { LogEntry } from './log.ts'

/**
 * Cloudflare Turnstile on 申請加入 (`e1-t33`, AC-1.9; docs/SECURITY.md §2, DEPLOY.md §4.13). It is on
 * only when both the site key (`TURNSTILE_SITE_KEY`, a plain variable the page reads from
 * `GET /api/register/options`) and the secret (`wrangler secret put TURNSTILE_SECRET_KEY`) are
 * set; otherwise the page shows no widget and the Worker checks nothing, so development, tests and
 * PR previews work as before. The check is a fetch to Cloudflare, so it stays in the club's
 * Durable Object (`club.ts`), never in `ClubService`.
 */

export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
/** Turnstile's tokens are at most 2048 characters */
const TOKEN_MAX = 2048

export interface TurnstileKeys {
  siteKey: string
  secret: string
}

/** The keys, or null (Turnstile off) unless both are set */
export function turnstileKeys(env: { TURNSTILE_SITE_KEY?: string; TURNSTILE_SECRET_KEY?: string }): TurnstileKeys | null {
  const siteKey = env.TURNSTILE_SITE_KEY?.trim()
  const secret = env.TURNSTILE_SECRET_KEY?.trim()
  return siteKey && secret ? { siteKey, secret } : null
}

/**
 * Asks Cloudflare whether `token` is a fresh pass for this site; throws `captchaFailed` (403) when
 * it is missing, wrong, used or expired, or when Cloudflare cannot be reached (failing closed: the
 * form says to try again). Each token is good once, so the page makes a new one after every try
 */
export async function requireTurnstile(
  secret: string,
  token: string,
  address: string,
  log: (entry: LogEntry) => void,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  if (!token || token.length > TOKEN_MAX) throw new ClubError('captchaFailed', {}, 403)
  const form = new FormData()
  form.append('secret', secret)
  form.append('response', token)
  if (address) form.append('remoteip', address)
  let codes: string
  try {
    const response = await fetcher(TURNSTILE_VERIFY_URL, { method: 'POST', body: form })
    const result = (await response.json()) as { success?: boolean; 'error-codes'?: unknown }
    if (result.success === true) return
    codes = Array.isArray(result['error-codes']) ? result['error-codes'].map(String).join(',').slice(0, 200) : ''
  } catch {
    codes = 'unreachable'
  }
  log({ event: 'turnstileFailed', codes })
  throw new ClubError('captchaFailed', {}, 403)
}
