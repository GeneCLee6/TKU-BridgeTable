// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import {
  allowedReturn,
  ARCADE_TOKEN_SECONDS,
  arcadeLogin,
  base64url,
  originPatterns,
  type ArcadeClaims,
  type ArcadeLoginDeps,
} from '../../worker/arcade-login.ts'
import type { LogEntry } from '../../worker/log.ts'
import { route, type Routes } from '../../worker/routing.ts'

/** Signing in to TKU Arcade (e1-t37, worker/arcade-login.ts, ARCHITECTURE.md §5.2) */

const SECRET = 'a-test-secret-that-is-long-enough-0123456789'
const ORIGINS = 'https://tku-arcade.genelee-pro.workers.dev,https://tku-arcade-pr-*.genelee-pro.workers.dev'
const ARCADE = 'https://tku-arcade.genelee-pro.workers.dev'
const STATE = 'Zm9vYmFyYmF6cXV4MTIzNDU2'
const NOW = Date.UTC(2026, 10, 9, 12)

let logs: LogEntry[]
let deps: ArcadeLoginDeps

beforeEach(() => {
  logs = []
  deps = {
    secret: SECRET,
    origins: ORIGINS,
    sessionToken: 'good-token',
    identity: async (token) => (token === 'good-token' ? { id: 'u-amy', name: '小艾' } : null),
    now: () => NOW,
    log: (entry) => logs.push(entry),
  }
})

const login = (query: Record<string, string>, init?: RequestInit) =>
  arcadeLogin(new Request(`https://bridge.example/api/arcade/login?${new URLSearchParams(query)}`, init), deps)

const fromBase64url = (text: string) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))

/** What the arcade does with the token: check the HMAC, then read the claims */
async function readToken(token: string, secret = SECRET): Promise<ArcadeClaims | null> {
  const [version, payload, signature] = token.split('.')
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
  const ok = await crypto.subtle.verify('HMAC', key, fromBase64url(signature), new TextEncoder().encode(`${version}.${payload}`))
  return ok && version === 'v1' ? (JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as ArcadeClaims) : null
}

describe('the allow-list', () => {
  const patterns = originPatterns(ORIGINS)

  it('takes the arcade and its pull request previews', () => {
    expect(allowedReturn(`${ARCADE}/`, patterns)?.origin).toBe(ARCADE)
    expect(allowedReturn(`${ARCADE}/r/abc?x=1`, patterns)?.href).toBe(`${ARCADE}/r/abc?x=1`)
    expect(allowedReturn('https://tku-arcade-pr-42.genelee-pro.workers.dev/', patterns)).not.toBeNull()
  })

  it('never anything else (no open redirect)', () => {
    for (const raw of [
      null,
      '',
      '/r/abc',
      '//evil.example/',
      'javascript:alert(1)',
      'http://tku-arcade.genelee-pro.workers.dev/',
      'https://evil.example/',
      'https://tku-arcade.genelee-pro.workers.dev.evil.example/',
      'https://tku-arcade-pr-x.genelee-pro.workers.dev/',
      'https://tku-arcade-pr-1.evil.genelee-pro.workers.dev/',
      'https://tku-arcade-pr-.genelee-pro.workers.dev/',
      'https://tku-arcade-pr-1234567.genelee-pro.workers.dev/',
      'https://tku-arcade.genelee-pro.workers.dev:8443/',
      'https://user:pass@tku-arcade.genelee-pro.workers.dev/',
      'https://tku-arcade.genelee-pro.workers.dev/#x',
      'https://tku-arcade.genelee-pro.workers.dev\\@evil.example/',
      `${ARCADE}/${'a'.repeat(200)}`,
    ]) {
      expect(allowedReturn(raw, patterns), String(raw)).toBeNull()
    }
  })

  it('ignores entries that are not plain origins, so a typo only narrows the list', () => {
    expect(originPatterns('')).toEqual([])
    expect(originPatterns('https://a.example/path, http://b.example, https://*.example, https://*-*.c.example, nonsense')).toEqual([])
    expect(originPatterns('http://localhost:5178').length).toBe(1)
    expect(allowedReturn('http://localhost:5178/', originPatterns('http://localhost:5178'))).not.toBeNull()
    expect(allowedReturn('http://localhost:5179/', originPatterns('http://localhost:5178'))).toBeNull()
  })
})

describe('GET /api/arcade/login', () => {
  it('is off until the secret and the origins are both set', async () => {
    for (const change of [{ secret: undefined }, { secret: 'short' }, { origins: undefined }, { origins: 'nonsense' }]) {
      Object.assign(deps, { secret: SECRET, origins: ORIGINS }, change)
      const response = await login({ return_to: `${ARCADE}/`, state: STATE })
      expect(response.status).toBe(404)
      expect(await response.json()).toMatchObject({ code: 'arcadeLoginOff' })
    }
  })

  it('only answers GET', async () => {
    const response = await login({ return_to: `${ARCADE}/`, state: STATE }, { method: 'POST' })
    expect(response.status).toBe(404)
  })

  it('refuses a return_to that is not listed, or a missing or malformed state', async () => {
    const queries: Record<string, string>[] = [
      { return_to: 'https://evil.example/', state: STATE },
      { state: STATE },
      { return_to: `${ARCADE}/` },
      { return_to: `${ARCADE}/`, state: 'short' },
      { return_to: `${ARCADE}/`, state: `${STATE}!` },
    ]
    for (const query of queries) {
      const response = await login(query)
      expect(response.status).toBe(400)
      expect(response.headers.get('Location')).toBeNull()
      expect(await response.json()).toMatchObject({ code: 'arcadeReturnNotAllowed' })
    }
    expect(logs).toContainEqual({ event: 'arcadeRefused', reason: 'returnTo' })
    expect(logs).toContainEqual({ event: 'arcadeRefused', reason: 'state' })
  })

  it('sends a signed-out visitor to sign in, and stops instead of going round again', async () => {
    deps.sessionToken = null
    const response = await login({ return_to: `${ARCADE}/r/abc`, state: STATE })
    expect(response.status).toBe(302)
    const to = new URL(response.headers.get('Location') ?? '', 'https://bridge.example')
    expect(to.pathname).toBe('/arcade')
    expect(to.searchParams.get('return_to')).toBe(`${ARCADE}/r/abc`)
    expect(to.searchParams.get('state')).toBe(STATE)
    const again = await login({ return_to: `${ARCADE}/r/abc`, state: STATE, resume: '1' })
    expect(again.status).toBe(401)
    expect(await again.json()).toMatchObject({ code: 'signInFirst' })
  })

  it('sends a member back with a signed five-minute token in the fragment', async () => {
    const response = await login({ return_to: `${ARCADE}/r/abc`, state: STATE })
    expect(response.status).toBe(302)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer')
    const location = response.headers.get('Location') ?? ''
    expect(location.startsWith(`${ARCADE}/r/abc#overtrick_token=v1.`)).toBe(true)
    const token = location.split('#overtrick_token=')[1]
    const claims = await readToken(token)
    expect(claims).toMatchObject({
      iss: 'overtrick',
      aud: ARCADE,
      sub: 'u-amy',
      name: '小艾',
      club: 'tku',
      iat: NOW / 1000,
      exp: NOW / 1000 + ARCADE_TOKEN_SECONDS,
      nonce: STATE,
    })
    expect(ARCADE_TOKEN_SECONDS).toBeLessThanOrEqual(300)
    expect(claims?.jti).toMatch(/^[A-Za-z0-9_-]{22}$/)
    // Another secret, or a changed claim, does not verify
    expect(await readToken(token, `${SECRET}x`)).toBeNull()
    const [version, payload, signature] = token.split('.')
    const forged = base64url(new TextEncoder().encode(new TextDecoder().decode(fromBase64url(payload)).replace('u-amy', 'u-bob')))
    expect(await readToken(`${version}.${forged}.${signature}`)).toBeNull()
    expect(logs).toContainEqual({ event: 'arcadeToken' })
  })

  it('gives each token its own id and binds it to the preview it goes to', async () => {
    const one = (await login({ return_to: `${ARCADE}/`, state: STATE })).headers.get('Location') ?? ''
    const two = (await login({ return_to: 'https://tku-arcade-pr-7.genelee-pro.workers.dev/', state: STATE })).headers.get('Location') ?? ''
    const a = await readToken(one.split('#overtrick_token=')[1])
    const b = await readToken(two.split('#overtrick_token=')[1])
    expect(a?.jti).not.toBe(b?.jti)
    expect(b?.aud).toBe('https://tku-arcade-pr-7.genelee-pro.workers.dev')
  })
})

describe('the Worker routing for TKU Arcade', () => {
  let asked: { club: string; token: string | null }[]
  let routes: Routes

  beforeEach(() => {
    asked = []
    const nobody = { fetch: async () => new Response('nobody') }
    routes = {
      club: (clubId) => ({
        ...nobody,
        socketUser: async () => null,
        arcadeIdentity: async (token) => {
          asked.push({ club: clubId, token })
          return token === 'tku-token' ? { id: 'u-amy', name: 'Amy' } : null
        },
      }),
      table: () => nobody,
      assets: nobody,
      arcade: { secret: SECRET, origins: ORIGINS },
    }
  })

  const request = (headers: Record<string, string>, query = '') =>
    new Request(`https://bridge.example/api/arcade/login?return_to=${encodeURIComponent(`${ARCADE}/`)}&state=${STATE}${query}`, { headers })

  it('asks only 淡江 with 淡江 session cookie, whatever club the request names', async () => {
    const response = await route(request({ Cookie: 'tbt_session=tku-token', 'X-Club-Id': 'ntu' }, '&club=ntu'), routes)
    expect(response.headers.get('Location')).toContain('#overtrick_token=')
    expect(asked).toEqual([{ club: 'tku', token: 'tku-token' }])
  })

  it('never takes another club session as 淡江', async () => {
    const response = await route(request({ Cookie: 'tbt_session_ntu=tku-token' }), routes)
    expect(response.headers.get('Location')).toMatch(/^\/arcade\?/)
    expect(asked).toEqual([{ club: 'tku', token: null }])
  })

  it('is off without the configuration', async () => {
    delete routes.arcade
    const response = await route(request({ Cookie: 'tbt_session=tku-token' }), routes)
    expect(response.status).toBe(404)
    expect(asked).toEqual([])
  })
})
