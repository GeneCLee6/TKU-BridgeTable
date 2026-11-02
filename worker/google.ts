/**
 * Google sign-in (e1-t31, AC-1.9; ARCHITECTURE.md §5.2, docs/SECURITY.md V2, DEPLOY.md §4.16). The
 * flow itself (state, PKCE, nonce, the flows in storage, the sites) is `worker/oauth.ts`'s.
 *
 * The ID token's signature is not checked against Google's keys: OpenID Connect Core §3.1.3.7
 * (6) lets a client that got the token straight from the token endpoint over TLS rely on that
 * connection instead. The request is ours, to Google's fixed address, authenticated with the
 * client secret, so nobody else could have put a token in the answer. That saves fetching and
 * caching the JWKS and an RSA check; `iss`, `aud`, `exp`, `iat`, `nonce` and `email_verified` are
 * still checked (`checkIdToken`).
 *
 * Google is on only when both `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set (wrangler
 * secrets); PR previews get neither, so they have no Google sign-in. `fetcher` is for tests.
 */

import { decodeJwtPayload, validSub, type OAuthIdentity, type OAuthProvider } from './oauth.ts'

export const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
/** The issuers Google's ID tokens name (both spellings are in use) */
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com']
/** Clock leeway for `iat` */
const SKEW_S = 300

export function googleAuth(clientId: string, clientSecret: string, fetcher: typeof fetch = fetch): OAuthProvider {
  return {
    name: 'google',
    clientId,
    authorizeUrl({ redirectUri, state, nonce, challenge }) {
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        state,
        nonce,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        prompt: 'select_account',
      })
      return `${GOOGLE_AUTHORIZE_URL}?${params}`
    },
    async exchange({ code, verifier, redirectUri }) {
      const response = await fetcher(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
          code_verifier: verifier,
        }),
      })
      if (!response.ok) throw new Error(`Google's token endpoint answered ${response.status}`)
      const body = (await response.json()) as { id_token?: unknown }
      if (typeof body.id_token !== 'string') throw new Error('No ID token')
      return decodeJwtPayload(body.id_token)
    },
    identify: (claims, { nonce, now }) => checkIdToken(claims, { clientId, nonce, now }),
  }
}

/** Google, unless either secret is missing */
export function googleFrom(env: { GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string }): OAuthProvider | undefined {
  const id = env.GOOGLE_CLIENT_ID?.trim()
  const secret = env.GOOGLE_CLIENT_SECRET?.trim()
  return id && secret ? googleAuth(id, secret) : undefined
}

/**
 * The identity in an ID token's claims, or null when they are not for us or not fresh: the
 * issuer is Google, the audience is our client (`azp` too when there are several), it has not
 * expired and was not issued in the future, the nonce is this flow's, the email is verified and
 * there is a `sub`
 */
export function checkIdToken(
  claims: Record<string, unknown>,
  expected: { clientId: string; nonce: string; now: number },
): OAuthIdentity | null {
  const now = Math.floor(expected.now / 1000)
  const aud = claims.aud
  const audiences = Array.isArray(aud) ? aud : [aud]
  if (!GOOGLE_ISSUERS.includes(String(claims.iss))) return null
  if (!audiences.includes(expected.clientId)) return null
  if (audiences.length > 1 && claims.azp !== expected.clientId) return null
  if (typeof claims.exp !== 'number' || claims.exp <= now) return null
  if (typeof claims.iat === 'number' && claims.iat > now + SKEW_S) return null
  if (!expected.nonce || claims.nonce !== expected.nonce) return null
  if (claims.email_verified !== true && claims.email_verified !== 'true') return null
  if (!validSub(claims.sub)) return null
  return {
    sub: claims.sub,
    email: typeof claims.email === 'string' ? claims.email.trim().toLowerCase().slice(0, 254) : '',
    name: typeof claims.name === 'string' ? claims.name.trim() : '',
  }
}
