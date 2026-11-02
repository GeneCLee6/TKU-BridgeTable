/**
 * LINE login (e1-t32, AC-1.9; ARCHITECTURE.md §5.2, docs/SECURITY.md V2, DEPLOY.md §4.17): LINE
 * Login v2.1's authorization-code flow with PKCE, `state` and `nonce`, the same flow as Google's
 * (`worker/oauth.ts`). Only the `openid profile` scope: LINE gives the email only to channels it
 * approved, and the account is found by the ID token's `sub` (LINE's user id) anyway.
 *
 * LINE signs a web login's ID token with HS256 and the channel secret, so the signature is checked
 * here too (one HMAC, cheap enough for the free plan's 10 ms), on top of the direct TLS answer from
 * LINE's token endpoint that would already do (OpenID Connect Core §3.1.3.7 (6)); then `iss`
 * (https://access.line.me), `aud` (the channel id), `exp`, `iat` and `nonce`.
 *
 * LINE is on only when both `LINE_CHANNEL_ID` and `LINE_CHANNEL_SECRET` are set (wrangler secrets);
 * PR previews get neither, so they have no LINE login. `fetcher` is for tests.
 */

import { decodeJwtPart, fromBase64Url, validSub, type OAuthIdentity, type OAuthProvider } from './oauth.ts'

export const LINE_AUTHORIZE_URL = 'https://access.line.me/oauth2/v2.1/authorize'
export const LINE_TOKEN_URL = 'https://api.line.me/oauth2/v2.1/token'
export const LINE_ISSUER = 'https://access.line.me'
/** Clock leeway for `iat` */
const SKEW_S = 300
/** The longest LINE name kept (it only fills in the display name and labels the binding for its owner) */
const NAME_MAX = 100

export function lineAuth(channelId: string, channelSecret: string, fetcher: typeof fetch = fetch): OAuthProvider {
  return {
    name: 'line',
    clientId: channelId,
    authorizeUrl({ redirectUri, state, nonce, challenge }) {
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: channelId,
        redirect_uri: redirectUri,
        state,
        scope: 'openid profile',
        nonce,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      })
      return `${LINE_AUTHORIZE_URL}?${params}`
    },
    async exchange({ code, verifier, redirectUri }) {
      const response = await fetcher(LINE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: channelId,
          client_secret: channelSecret,
          code_verifier: verifier,
        }),
      })
      if (!response.ok) throw new Error(`LINE's token endpoint answered ${response.status}`)
      const body = (await response.json()) as { id_token?: unknown }
      if (typeof body.id_token !== 'string') throw new Error('No ID token')
      if (!(await verifyHs256(body.id_token, channelSecret))) throw new Error('Bad ID token signature')
      return decodeJwtPart(body.id_token, 1)
    },
    identify: (claims, { nonce, now }) => checkLineIdToken(claims, { channelId, nonce, now }),
  }
}

/** LINE, unless either secret is missing */
export function lineFrom(env: { LINE_CHANNEL_ID?: string; LINE_CHANNEL_SECRET?: string }): OAuthProvider | undefined {
  const id = env.LINE_CHANNEL_ID?.trim()
  const secret = env.LINE_CHANNEL_SECRET?.trim()
  return id && secret ? lineAuth(id, secret) : undefined
}

/** Whether a JWT is HS256 and signed with `secret` (the header must say HS256: no `none`, no other algorithm) */
export async function verifyHs256(token: string, secret: string): Promise<boolean> {
  try {
    if (decodeJwtPart(token, 0).alg !== 'HS256') return false
    const [header, payload, signature] = token.split('.')
    if (!/^[\w-]+$/.test(signature)) return false
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
    return await crypto.subtle.verify('HMAC', key, fromBase64Url(signature), new TextEncoder().encode(`${header}.${payload}`))
  } catch {
    return false
  }
}

/**
 * The identity in a LINE ID token's claims, or null when they are not for us or not fresh: the
 * issuer is LINE, the audience is our channel, it has not expired and was not issued in the
 * future, the nonce is this flow's and there is a `sub`. No email (the scope is not asked for)
 */
export function checkLineIdToken(
  claims: Record<string, unknown>,
  expected: { channelId: string; nonce: string; now: number },
): OAuthIdentity | null {
  const now = Math.floor(expected.now / 1000)
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (claims.iss !== LINE_ISSUER) return null
  if (audiences.length !== 1 || audiences[0] !== expected.channelId) return null
  if (typeof claims.exp !== 'number' || claims.exp <= now) return null
  if (typeof claims.iat === 'number' && claims.iat > now + SKEW_S) return null
  if (!expected.nonce || claims.nonce !== expected.nonce) return null
  if (!validSub(claims.sub)) return null
  return {
    sub: claims.sub,
    email: '',
    name: typeof claims.name === 'string' ? [...claims.name.trim()].slice(0, NAME_MAX).join('') : '',
  }
}
