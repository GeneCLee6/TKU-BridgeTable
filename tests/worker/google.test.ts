// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { BOOK_SITE } from '../../shared/book-site.ts'
import {
  checkIdToken,
  decodeJwtPayload,
  GOOGLE_APPLY_MS,
  GOOGLE_CODE_MS,
  GOOGLE_START_MS,
  GOOGLE_TOKEN_URL,
  googleAuth,
  googleCookie,
  googleFrom,
  googleSite,
  pkceChallenge,
  safeReturn,
} from '../../worker/google.ts'
import { ClubService, type Connections, type GoogleOutcome } from '../../worker/service.ts'
import type { MemoryStore } from '../../worker/store.ts'
import { totpCode, totpStep } from '../../worker/totp.ts'
import { adminWithTwoFactor } from './admin-two-factor.ts'
import { memoryStore } from './sqlite.ts'

const PASSWORD = 'club-secret-1'
const CLIENT_ID = 'client-123.apps.googleusercontent.com'
const ORIGIN = 'https://table.example'
const REDIRECT = `${ORIGIN}/api/auth/google/callback`

const encode = (value: unknown) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
/** An ID token as Google's token endpoint returns it (the signature is never read, see worker/google.ts) */
const jwt = (claims: Record<string, unknown>) => `${encode({ alg: 'RS256', kid: 'k' })}.${encode(claims)}.c2lnbmF0dXJl`

let store: MemoryStore
let club: ClubService
let time: number
/** What the fake token endpoint got, and the claims it answers with next (by authorization code) */
let exchanged: URLSearchParams[]
let googleUsers: Record<string, Record<string, unknown>>
let tokenStatus: number

const connections: Connections = { onlineUserIds: () => [], send: () => undefined, disconnect: () => undefined }

/** Google's token endpoint: the code names the Google account; the nonce is the one the flow sent */
const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  expect(String(input)).toBe(GOOGLE_TOKEN_URL)
  const form = new URLSearchParams(String(init?.body))
  exchanged.push(form)
  if (tokenStatus !== 200) return new Response('{"error":"invalid_grant"}', { status: tokenStatus })
  const claims = googleUsers[form.get('code') ?? '']
  return new Response(JSON.stringify({ access_token: 'a', id_token: jwt(claims) }), { status: 200 })
}) as typeof fetch

/** Claims for a Google account; `nonce` is filled in by `signIn` */
const account = (sub: string, more: Record<string, unknown> = {}) => ({
  iss: 'https://accounts.google.com',
  aud: CLIENT_ID,
  sub,
  email: `${sub}@gmail.com`,
  email_verified: true,
  name: `Google ${sub}`,
  iat: Math.floor(time / 1000),
  exp: Math.floor(time / 1000) + 3600,
  ...more,
})

async function open(google = true) {
  store = memoryStore()
  club = new ClubService(store, connections, {
    maxUsers: 20,
    inviteCode: 'tku',
    now: () => time,
    schedule: () => undefined,
    google: google ? googleAuth(CLIENT_ID, 'secret-xyz', fakeFetch) : undefined,
  })
  await club.load()
  await club.register('admin', PASSWORD, 'tku')
}

beforeEach(async () => {
  time = 1_700_000_000_000
  exchanged = []
  googleUsers = {}
  tokenStatus = 200
  await open()
})

async function member(name: string) {
  await club.register(name, PASSWORD, 'tku')
  return (await club.adminApprove(club.adminApplications().find((a) => a.username === name)!.id)).id
}

/**
 * The whole way through Google: start, Google answers with a code for `claims` (the nonce the
 * start sent), the callback. `link` binds for a signed-in member
 */
async function viaGoogle(
  claims: Record<string, unknown>,
  options: { site?: 'table' | 'book'; link?: { userId: string; password: string }; session?: string | null; returnTo?: string } = {},
): Promise<GoogleOutcome> {
  const { url, flowId } = await club.startGoogle(REDIRECT, options.site ?? 'table', options.returnTo ?? '/lobby', '1.2.3.4', options.link)
  const nonce = new URL(url).searchParams.get('nonce')!
  const code = `code-${exchanged.length}-${Math.random()}`
  googleUsers[code] = { nonce, ...claims }
  return club.finishGoogle(flowId, { state: flowId, code, error: '' }, options.session ?? options.link?.userId ?? null)
}

describe('Google sign-in helpers (e1-t31)', () => {
  it('makes the PKCE challenge of RFC 7636', async () => {
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })

  it('reads a JWT payload and refuses what is not one', () => {
    expect(decodeJwtPayload(jwt({ sub: '1', name: '王小美' }))).toEqual({ sub: '1', name: '王小美' })
    expect(() => decodeJwtPayload('nope')).toThrow()
    expect(() => decodeJwtPayload(`a.${encode([1])}.c`)).toThrow()
  })

  it('takes an ID token only from Google, for this client, fresh, with the nonce and a verified email', () => {
    const now = time
    const good = { ...account('111'), nonce: 'n1' }
    const check = (claims: Record<string, unknown>) => checkIdToken(claims, { clientId: CLIENT_ID, nonce: 'n1', now })
    expect(check(good)).toEqual({ sub: '111', email: '111@gmail.com', name: 'Google 111' })
    expect(check({ ...good, iss: 'accounts.google.com' })).not.toBeNull()
    expect(check({ ...good, iss: 'https://evil.example' })).toBeNull()
    expect(check({ ...good, aud: 'someone-else' })).toBeNull()
    expect(check({ ...good, aud: [CLIENT_ID, 'other'], azp: 'other' })).toBeNull()
    expect(check({ ...good, aud: [CLIENT_ID, 'other'], azp: CLIENT_ID })).not.toBeNull()
    expect(check({ ...good, exp: Math.floor(now / 1000) })).toBeNull()
    expect(check({ ...good, exp: undefined })).toBeNull()
    expect(check({ ...good, iat: Math.floor(now / 1000) + 3600 })).toBeNull()
    expect(check({ ...good, nonce: 'n2' })).toBeNull()
    expect(check({ ...good, email_verified: false })).toBeNull()
    expect(check({ ...good, sub: '' })).toBeNull()
    expect(checkIdToken(good, { clientId: CLIENT_ID, nonce: '', now })).toBeNull()
  })

  it('runs only on our own sites, and returns only to a path on them', () => {
    const worker = new URL('https://tku-bridge-table.example.dev/api/auth/google/start')
    expect(googleSite('https://tku-bridge-table.example.dev', worker)).toEqual({ origin: 'https://tku-bridge-table.example.dev', site: 'table' })
    expect(googleSite(BOOK_SITE, worker)).toEqual({ origin: BOOK_SITE, site: 'book' })
    expect(googleSite('https://evil.example', worker)).toBeNull()
    expect(googleSite('http://localhost:5174', worker)).toBeNull()
    expect(googleSite('', worker)).toBeNull()
    // Development: 橋館's dev server on another localhost port
    expect(googleSite('http://localhost:5174', new URL('http://localhost:5173/api/x'))).toEqual({ origin: 'http://localhost:5174', site: 'book' })
    expect(safeReturn('/history?x=1')).toBe('/history?x=1')
    for (const bad of ['//evil.example', 'https://evil.example', '/\\evil.example', '', undefined, `/${'a'.repeat(400)}`])
      expect(safeReturn(bad)).toBe('/')
  })

  it('keeps the flow cookie HttpOnly, Lax and on /api/ only', () => {
    expect(googleCookie('abc', true)).toBe(`tbt_google=abc; Path=/api/; HttpOnly; SameSite=Lax; Max-Age=${GOOGLE_START_MS / 1000}; Secure`)
    expect(googleCookie('', false)).toContain('Max-Age=0')
  })

  it('is off unless both secrets are set', () => {
    expect(googleFrom({})).toBeUndefined()
    expect(googleFrom({ GOOGLE_CLIENT_ID: 'id' })).toBeUndefined()
    expect(googleFrom({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: ' ' })).toBeUndefined()
    expect(googleFrom({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 's' })?.clientId).toBe('id')
  })
})

describe('the flow (e1-t31)', () => {
  it('sends the browser to Google with state, nonce and an S256 challenge, and exchanges the code with the verifier', async () => {
    const amy = await member('amy')
    const { url, flowId } = await club.startGoogle(REDIRECT, 'table', '/lobby', '1.2.3.4')
    const params = new URL(url).searchParams
    expect(url.startsWith('https://accounts.google.com/o/oauth2/v2/auth?')).toBe(true)
    expect(Object.fromEntries(params)).toMatchObject({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      response_type: 'code',
      scope: 'openid email profile',
      state: flowId,
      code_challenge_method: 'S256',
    })
    expect(params.get('nonce')).toMatch(/^[\w-]{43}$/)
    // Nothing secret goes to the browser: the verifier stays in storage
    const kept = (await store.get<{ verifier: string }>(`google:${flowId}`))!
    expect(params.get('code_challenge')).toBe(await pkceChallenge(kept.verifier))
    expect(url).not.toContain(kept.verifier)

    // amy binds Google, then signs in with it
    expect((await viaGoogle(account('g-amy'), { link: { userId: amy, password: PASSWORD } })).kind).toBe('linked')
    const form = exchanged.at(-1)!
    expect(form.get('grant_type')).toBe('authorization_code')
    expect(form.get('client_secret')).toBe('secret-xyz')
    expect(form.get('redirect_uri')).toBe(REDIRECT)
    expect(form.get('code_verifier')).toMatch(/^[\w-]{43}$/)
    const outcome = await viaGoogle(account('g-amy'), { returnTo: '/history' })
    expect(outcome).toMatchObject({ kind: 'signedIn', returnTo: '/history', site: 'table' })
    if (outcome.kind !== 'signedIn') return
    expect(outcome.user.username).toBe('amy')
    expect((await club.userForToken(outcome.token))?.id).toBe(amy)
  })

  it('finds the account by sub, never by email', async () => {
    const amy = await member('amy')
    await viaGoogle(account('g-amy'), { link: { userId: amy, password: PASSWORD } })
    // Another Google account that claims amy's address is not amy
    expect((await viaGoogle(account('g-other', { email: 'g-amy@gmail.com' }))).kind).toBe('apply')
    // amy's Google account with a new address still is
    expect(await viaGoogle(account('g-amy', { email: 'new@gmail.com' }))).toMatchObject({ kind: 'signedIn' })
  })

  it('refuses a callback without the browser’s cookie, with another state, used twice or expired', async () => {
    const amy = await member('amy')
    await viaGoogle(account('g-amy'), { link: { userId: amy, password: PASSWORD } })
    const { url, flowId } = await club.startGoogle(REDIRECT, 'table', '/', '1.2.3.4')
    googleUsers.c1 = { ...account('g-amy'), nonce: new URL(url).searchParams.get('nonce') }
    const failed = { kind: 'failed', code: 'googleFailed' }
    expect(await club.finishGoogle(null, { state: flowId, code: 'c1', error: '' }, null)).toMatchObject(failed)
    expect(await club.finishGoogle('x'.repeat(43), { state: flowId, code: 'c1', error: '' }, null)).toMatchObject(failed)
    expect(await club.finishGoogle(flowId, { state: flowId, code: 'c1', error: '' }, null)).toMatchObject({ kind: 'signedIn' })
    expect(await club.finishGoogle(flowId, { state: flowId, code: 'c1', error: '' }, null)).toMatchObject(failed)
    const late = await club.startGoogle(REDIRECT, 'table', '/', '1.2.3.4')
    time += GOOGLE_START_MS + 1
    expect(await club.finishGoogle(late.flowId, { state: late.flowId, code: 'c1', error: '' }, null)).toMatchObject(failed)
  })

  it('refuses a cancelled sign-in, a refused code and an ID token for another nonce or client', async () => {
    const cancelled = await club.startGoogle(REDIRECT, 'table', '/', '1.2.3.4')
    expect(await club.finishGoogle(cancelled.flowId, { state: cancelled.flowId, code: '', error: 'access_denied' }, null)).toMatchObject({
      kind: 'failed',
      code: 'googleFailed',
    })
    expect(await viaGoogle(account('g1', { nonce: 'replayed' }))).toMatchObject({ kind: 'failed', code: 'googleFailed' })
    expect(await viaGoogle(account('g1', { aud: 'other-client' }))).toMatchObject({ kind: 'failed', code: 'googleFailed' })
    tokenStatus = 400
    expect(await viaGoogle(account('g1'))).toMatchObject({ kind: 'failed', code: 'googleFailed' })
  })

  it('limits how many flows one network address starts', async () => {
    for (let i = 0; i < 10; i++) await club.startGoogle(REDIRECT, 'table', '/', '9.9.9.9')
    await expect(club.startGoogle(REDIRECT, 'table', '/', '9.9.9.9')).rejects.toMatchObject({ code: 'slowDown' })
    await club.startGoogle(REDIRECT, 'table', '/', '8.8.8.8')
  })

  it('answers googleOff everywhere when the club has no Google', async () => {
    await open(false)
    const amy = await member('amy')
    expect(club.googleStatus()).toEqual({ enabled: false })
    expect((await club.userForToken((await club.login('amy', PASSWORD)).token))?.google).toBeUndefined()
    await expect(club.startGoogle(REDIRECT, 'table', '/', '')).rejects.toMatchObject({ code: 'googleOff' })
    await expect(club.unlinkGoogle(amy, PASSWORD)).rejects.toMatchObject({ code: 'googleOff' })
    await expect(club.register('bob', PASSWORD, 'tku', '', 'table', '', '', { google: 'x' })).rejects.toMatchObject({ code: 'googleOff' })
    expect(await club.googlePending('x')).toEqual({ step: null })
  })
})

describe('binding and unbinding on My account (e1-t31)', () => {
  it('asks for the password, keeps only sub and the address for the owner, and refuses one Google account on two', async () => {
    const amy = await member('amy')
    const bob = await member('bob')
    await expect(club.startGoogle(REDIRECT, 'table', '/', '', { userId: amy, password: 'wrong-password' })).rejects.toMatchObject({
      code: 'wrongPassword',
    })
    expect((await viaGoogle(account('g-amy'), { link: { userId: amy, password: PASSWORD } })).kind).toBe('linked')
    expect(await store.get(`user:${amy}`)).toMatchObject({ google: { sub: 'g-amy', email: 'g-amy@gmail.com', linkedAt: time } })
    const me = (await club.userForToken((await club.login('amy', PASSWORD)).token))!
    expect(me.google).toEqual({ email: 'g-amy@gmail.com', linkedAt: time })
    // Google's name and picture are never kept; the username and display name stay as they were
    expect(JSON.stringify(await store.get(`user:${amy}`))).not.toContain('Google g-amy')
    expect(me.username).toBe('amy')
    // Nobody else sees the address
    expect(JSON.stringify(await club.memberProfile(bob, amy))).not.toContain('gmail')
    expect(JSON.stringify(await club.adminUsers())).not.toContain('gmail')
    // Already bound, or bound to someone else
    await expect(club.startGoogle(REDIRECT, 'table', '/', '', { userId: amy, password: PASSWORD })).rejects.toMatchObject({ code: 'googleLinked' })
    expect(await viaGoogle(account('g-amy'), { link: { userId: bob, password: PASSWORD } })).toMatchObject({
      kind: 'failed',
      code: 'googleTaken',
      link: true,
    })
  })

  it('binds only for the member still signed in on that browser', async () => {
    const amy = await member('amy')
    const bob = await member('bob')
    expect(await viaGoogle(account('g-amy'), { link: { userId: amy, password: PASSWORD }, session: bob })).toMatchObject({
      kind: 'failed',
      code: 'googleFailed',
      link: true,
    })
    expect((await store.get<{ google?: unknown }>(`user:${amy}`))?.google).toBeUndefined()
  })

  it('unbinds with the password; the password still signs in', async () => {
    const amy = await member('amy')
    await viaGoogle(account('g-amy'), { link: { userId: amy, password: PASSWORD } })
    await expect(club.unlinkGoogle(amy, 'wrong-password')).rejects.toMatchObject({ code: 'wrongPassword' })
    expect((await club.unlinkGoogle(amy, PASSWORD)).google).toBeNull()
    await expect(club.unlinkGoogle(amy, PASSWORD)).rejects.toMatchObject({ code: 'googleNotLinked' })
    expect((await viaGoogle(account('g-amy'))).kind).toBe('apply')
    expect((await club.login('amy', PASSWORD)).user.username).toBe('amy')
  })

  it('exports the binding with the member’s data and deletes it with the account', async () => {
    const amy = await member('amy')
    await viaGoogle(account('g-amy'), { link: { userId: amy, password: PASSWORD } })
    const data = await club.exportAccount(amy, null)
    expect(data.account.google).toEqual({ sub: 'g-amy', email: 'g-amy@gmail.com', linkedAt: time })
    await club.deleteOwnAccount(amy, PASSWORD)
    expect(await store.get(`user:${amy}`)).toBeUndefined()
    expect((await viaGoogle(account('g-amy'))).kind).toBe('apply')
  })
})

describe('applying with Google (e1-t31)', () => {
  async function applyFlow(sub: string, name?: string) {
    const outcome = await viaGoogle(account(sub, name === undefined ? {} : { name }))
    expect(outcome.kind).toBe('apply')
    return outcome.kind === 'apply' ? outcome.flowId : ''
  }

  it('fills in only the display name, still needs a username, a password and an admin’s approval', async () => {
    const flow = await applyFlow('g-cat', '陳小貓 Google 帳號名字很長很長很長')
    // The page reads Google's name to prefill the display name, cut to its limit
    expect(await club.googlePending(flow)).toEqual({ step: 'apply', name: '陳小貓 Google 帳號名字很' })
    await expect(club.register('cat', PASSWORD, 'wrong-invite', '', 'table', '', '5.5.5.5', { google: flow })).rejects.toMatchObject({
      code: 'badInvite',
    })
    await expect(club.register('cat', 'short', 'tku', '', 'table', '', '', { google: flow })).rejects.toThrow()
    const result = await club.register('cat', PASSWORD, 'tku', '新生', 'table', '', '', { google: flow, displayName: '小貓' })
    expect(result).toEqual({ pending: true, username: 'cat' })
    // The flow is used up; Google sign-in now says the application waits
    expect(await club.googlePending(flow)).toEqual({ step: null })
    expect(await viaGoogle(account('g-cat'))).toMatchObject({ kind: 'failed', code: 'awaitingApproval' })
    // Nobody may apply again with the same Google account
    const again = await applyFlow('g-cat2')
    await store.put(`google:${again}`, { ...(await store.get<object>(`google:${again}`)), sub: 'g-cat' })
    await expect(club.register('cat2', PASSWORD, 'tku', '', 'table', '', '', { google: again })).rejects.toMatchObject({ code: 'googleTaken' })

    const approved = await club.adminApprove(club.adminApplications().find((a) => a.username === 'cat')!.id)
    expect(approved.username).toBe('cat')
    expect(approved.profile).toEqual({ displayName: '小貓' })
    expect(approved.google).toEqual({ email: 'g-cat@gmail.com', linkedAt: time })
    expect(await viaGoogle(account('g-cat'))).toMatchObject({ kind: 'signedIn' })
    expect((await club.login('cat', PASSWORD)).user.id).toBe(approved.id)
  })

  it('needs the flow from Google, unexpired', async () => {
    await expect(club.register('cat', PASSWORD, 'tku', '', 'table', '', '', { google: null })).rejects.toMatchObject({ code: 'googleFailed' })
    const flow = await applyFlow('g-cat')
    time += GOOGLE_APPLY_MS + 1
    await expect(club.register('cat', PASSWORD, 'tku', '', 'table', '', '', { google: flow })).rejects.toMatchObject({ code: 'googleFailed' })
  })

  it('on 淡江橋館 a Google account with no club account is told to bind it or apply', async () => {
    expect(await viaGoogle(account('g-new'), { site: 'book' })).toMatchObject({ kind: 'failed', code: 'googleNotLinked', site: 'book' })
  })

  it('the club’s first account may bind Google as it signs up', async () => {
    store = memoryStore()
    club = new ClubService(store, connections, { maxUsers: 5, now: () => time, schedule: () => undefined, google: googleAuth(CLIENT_ID, 's', fakeFetch) })
    await club.load()
    const outcome = await viaGoogle(account('g-founder'))
    if (outcome.kind !== 'apply') throw new Error('expected the form')
    const result = await club.register('founder', PASSWORD, '', '', 'table', '', '', { google: outcome.flowId, displayName: '社長' })
    if (!('user' in result)) throw new Error('expected an account')
    expect(result.user.google).toEqual({ email: 'g-founder@gmail.com', linkedAt: time })
    expect(result.user.profile).toEqual({ displayName: '社長' })
  })
})

describe('two-step sign-in after Google (e1-t31)', () => {
  it('asks for the code; Google never replaces it, and wrong codes count as they do with the password', async () => {
    const admin = club.adminIds()[0]
    const { secret, recoveryCodes } = await adminWithTwoFactor(club, admin)
    await viaGoogle(account('g-admin'), { link: { userId: admin, password: PASSWORD } })
    time += 60_000
    const outcome = await viaGoogle(account('g-admin'), { returnTo: '/admin' })
    expect(outcome.kind).toBe('code')
    if (outcome.kind !== 'code') return
    const flow = outcome.flowId
    expect(await club.googlePending(flow)).toEqual({ step: 'code' })
    await expect(club.finishGoogleCode(flow, '', '1.2.3.4')).rejects.toMatchObject({ code: 'twoFactorNeeded' })
    await expect(club.finishGoogleCode(flow, '000000', '1.2.3.4')).rejects.toMatchObject({ code: 'twoFactorWrong' })
    await expect(club.finishGoogleCode('y'.repeat(43), await totpCode(secret, totpStep(time)), '1.2.3.4')).rejects.toMatchObject({
      code: 'googleFailed',
    })
    const signed = await club.finishGoogleCode(flow, await totpCode(secret, totpStep(time)), '1.2.3.4')
    expect(signed.returnTo).toBe('/admin')
    expect(signed.user.permissions.length).toBeGreaterThan(0)
    expect((await club.userForToken(signed.token))?.id).toBe(admin)
    // The flow works once
    await expect(club.finishGoogleCode(flow, recoveryCodes[0], '1.2.3.4')).rejects.toMatchObject({ code: 'googleFailed' })
  })

  it('locks the account after five wrong codes, and the code step expires', async () => {
    const admin = club.adminIds()[0]
    const { secret } = await adminWithTwoFactor(club, admin)
    await viaGoogle(account('g-admin'), { link: { userId: admin, password: PASSWORD } })
    const outcome = await viaGoogle(account('g-admin'))
    if (outcome.kind !== 'code') throw new Error('expected the code step')
    for (let i = 0; i < 5; i++) await expect(club.finishGoogleCode(outcome.flowId, '000000', `10.0.0.${i}`)).rejects.toMatchObject({ code: 'twoFactorWrong' })
    time += 60_000
    await expect(club.finishGoogleCode(outcome.flowId, await totpCode(secret, totpStep(time)), '10.0.1.1')).rejects.toMatchObject({
      code: 'tooManyLogins',
    })
    // The password path is locked the same way
    await expect(club.login('admin', PASSWORD, '10.0.2.2', '', await totpCode(secret, totpStep(time)))).rejects.toMatchObject({ code: 'tooManyLogins' })
    time += GOOGLE_CODE_MS
    await expect(club.finishGoogleCode(outcome.flowId, '123456', '10.0.1.1')).rejects.toMatchObject({ code: 'googleFailed' })
  })
})
