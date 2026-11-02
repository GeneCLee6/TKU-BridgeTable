// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { googleAuth } from '../../worker/google.ts'
import { checkLineIdToken, LINE_TOKEN_URL, lineAuth, lineFrom, verifyHs256 } from '../../worker/line.ts'
import { callbackPath, flowCookie, OAUTH_CODE_MS, OAUTH_START_MS, pkceChallenge, toBase64Url } from '../../worker/oauth.ts'
import { ClubService, type Connections, type OAuthOutcome } from '../../worker/service.ts'
import type { MemoryStore } from '../../worker/store.ts'
import { totpCode, totpStep } from '../../worker/totp.ts'
import { adminWithTwoFactor } from './admin-two-factor.ts'
import { memoryStore } from './sqlite.ts'

const PASSWORD = 'club-secret-1'
const CHANNEL_ID = '2001234567'
const CHANNEL_SECRET = 'line-channel-secret'
const ORIGIN = 'https://table.example'
const REDIRECT = `${ORIGIN}${callbackPath('line')}`

const part = (value: unknown) => toBase64Url(new TextEncoder().encode(JSON.stringify(value)))

/** An ID token as LINE's token endpoint returns it for web login: HS256 with the channel secret */
async function lineJwt(
  claims: Record<string, unknown>,
  secret = CHANNEL_SECRET,
  header: Record<string, unknown> = { typ: 'JWT', alg: 'HS256' },
) {
  const signed = `${part(header)}.${part(claims)}`
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signed)))
  return `${signed}.${toBase64Url(signature)}`
}

let store: MemoryStore
let club: ClubService
let time: number
/** What the fake token endpoint got, and the claims it answers with (by authorization code) */
let exchanged: URLSearchParams[]
let lineUsers: Record<string, Record<string, unknown>>
let signWith: string

const connections: Connections = {
  onlineUserIds: () => [],
  send: () => undefined,
  disconnect: () => undefined,
}

/** LINE's token endpoint: the code names the LINE account; the nonce is the one the flow sent */
const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  expect(String(input)).toBe(LINE_TOKEN_URL)
  const form = new URLSearchParams(String(init?.body))
  exchanged.push(form)
  const claims = lineUsers[form.get('code') ?? '']
  if (!claims) return new Response('{"error":"invalid_grant"}', { status: 400 })
  return new Response(
    JSON.stringify({
      access_token: 'a',
      token_type: 'Bearer',
      id_token: await lineJwt(claims, signWith),
    }),
    { status: 200 },
  )
}) as typeof fetch

/** Claims for a LINE account; `nonce` is filled in by `viaLine` */
const account = (sub: string, more: Record<string, unknown> = {}) => ({
  iss: 'https://access.line.me',
  aud: CHANNEL_ID,
  sub,
  name: `LINE ${sub}`,
  picture: 'https://profile.line-scdn.net/x',
  amr: ['linesso'],
  iat: Math.floor(time / 1000),
  exp: Math.floor(time / 1000) + 3600,
  ...more,
})

async function open(line = true, keep = false) {
  if (!keep) store = memoryStore()
  club = new ClubService(store, connections, {
    maxUsers: 20,
    inviteCode: 'tku',
    now: () => time,
    schedule: () => undefined,
    line: line ? lineAuth(CHANNEL_ID, CHANNEL_SECRET, fakeFetch) : undefined,
    google: googleAuth('google-client', 'google-secret', (async () => new Response('{}', { status: 400 })) as typeof fetch),
  })
  await club.load()
  if (!keep) await club.register('admin', PASSWORD, 'tku')
}

beforeEach(async () => {
  time = 1_700_000_000_000
  exchanged = []
  lineUsers = {}
  signWith = CHANNEL_SECRET
  await open()
})

async function member(name: string) {
  await club.register(name, PASSWORD, 'tku')
  return (await club.adminApprove(club.adminApplications().find((a) => a.username === name)!.id)).id
}

/** The whole way through LINE: start, LINE answers with a code for `claims` (with the start's nonce), the callback */
async function viaLine(
  claims: Record<string, unknown>,
  options: {
    site?: 'table' | 'book'
    link?: { userId: string; password: string }
    session?: string | null
    returnTo?: string
  } = {},
): Promise<OAuthOutcome> {
  const { url, flowId } = await club.startOAuth(
    'line',
    REDIRECT,
    options.site ?? 'table',
    options.returnTo ?? '/lobby',
    '1.2.3.4',
    options.link,
  )
  const nonce = new URL(url).searchParams.get('nonce')!
  const code = `code-${exchanged.length}-${Math.random()}`
  lineUsers[code] = { nonce, ...claims }
  return club.finishOAuth('line', flowId, { state: flowId, code, error: '' }, options.session ?? options.link?.userId ?? null)
}

describe('LINE login helpers (e1-t32)', () => {
  it('checks the HS256 signature with the channel secret, and refuses other algorithms', async () => {
    const claims = account('U1')
    expect(await verifyHs256(await lineJwt(claims), CHANNEL_SECRET)).toBe(true)
    expect(await verifyHs256(await lineJwt(claims, 'another-secret'), CHANNEL_SECRET)).toBe(false)
    expect(await verifyHs256(await lineJwt(claims, CHANNEL_SECRET, { alg: 'none' }), CHANNEL_SECRET)).toBe(false)
    expect(await verifyHs256(await lineJwt(claims, CHANNEL_SECRET, { alg: 'ES256', kid: 'k' }), CHANNEL_SECRET)).toBe(false)
    const [header, , signature] = (await lineJwt(claims)).split('.')
    expect(await verifyHs256(`${header}.${part({ ...claims, sub: 'U2' })}.${signature}`, CHANNEL_SECRET)).toBe(false)
    expect(await verifyHs256('nope', CHANNEL_SECRET)).toBe(false)
  })

  it('takes an ID token only from LINE, for this channel, fresh and with the nonce', () => {
    const now = time
    const good = { ...account('U1'), nonce: 'n1' }
    const check = (claims: Record<string, unknown>) => checkLineIdToken(claims, { channelId: CHANNEL_ID, nonce: 'n1', now })
    expect(check(good)).toEqual({ sub: 'U1', email: '', name: 'LINE U1' })
    expect(check({ ...good, iss: 'https://accounts.google.com' })).toBeNull()
    expect(check({ ...good, aud: 'other-channel' })).toBeNull()
    expect(check({ ...good, aud: [CHANNEL_ID, 'other'] })).toBeNull()
    expect(check({ ...good, exp: Math.floor(now / 1000) })).toBeNull()
    expect(check({ ...good, iat: Math.floor(now / 1000) + 3600 })).toBeNull()
    expect(check({ ...good, nonce: 'n2' })).toBeNull()
    expect(check({ ...good, sub: 'U 1' })).toBeNull()
    expect(checkLineIdToken(good, { channelId: CHANNEL_ID, nonce: '', now })).toBeNull()
    // The name only fills in the display name: cut, and an email in the claims is never taken
    expect(check({ ...good, name: 'x'.repeat(300), email: 'a@b.c' })).toEqual({
      sub: 'U1',
      email: '',
      name: 'x'.repeat(100),
    })
  })

  it('is off unless both secrets are set, and keeps its own flow cookie', () => {
    expect(lineFrom({})).toBeUndefined()
    expect(lineFrom({ LINE_CHANNEL_ID: 'id' })).toBeUndefined()
    expect(lineFrom({ LINE_CHANNEL_ID: 'id', LINE_CHANNEL_SECRET: ' ' })).toBeUndefined()
    expect(lineFrom({ LINE_CHANNEL_ID: 'id', LINE_CHANNEL_SECRET: 's' })?.clientId).toBe('id')
    expect(callbackPath('line')).toBe('/api/auth/line/callback')
    expect(flowCookie('line', 'abc', true)).toBe(
      `tbt_line=abc; Path=/api/; HttpOnly; SameSite=Lax; Max-Age=${OAUTH_START_MS / 1000}; Secure`,
    )
  })
})

describe('the LINE flow (e1-t32)', () => {
  it('sends the browser to LINE with openid profile, state, nonce and S256, and exchanges the code with the verifier', async () => {
    const amy = await member('amy')
    const { url, flowId } = await club.startOAuth('line', REDIRECT, 'table', '/lobby', '1.2.3.4')
    const params = new URL(url).searchParams
    expect(url.startsWith('https://access.line.me/oauth2/v2.1/authorize?')).toBe(true)
    expect(Object.fromEntries(params)).toMatchObject({
      response_type: 'code',
      client_id: CHANNEL_ID,
      redirect_uri: REDIRECT,
      scope: 'openid profile',
      state: flowId,
      code_challenge_method: 'S256',
    })
    expect(params.get('nonce')).toMatch(/^[\w-]{43}$/)
    const kept = (await store.get<{ verifier: string }>(`line:${flowId}`))!
    expect(params.get('code_challenge')).toBe(await pkceChallenge(kept.verifier))
    expect(url).not.toContain(kept.verifier)

    expect((await viaLine(account('U-amy'), { link: { userId: amy, password: PASSWORD } })).kind).toBe('linked')
    const form = exchanged.at(-1)!
    expect(form.get('grant_type')).toBe('authorization_code')
    expect(form.get('client_secret')).toBe(CHANNEL_SECRET)
    expect(form.get('redirect_uri')).toBe(REDIRECT)
    expect(form.get('code_verifier')).toMatch(/^[\w-]{43}$/)
    const outcome = await viaLine(account('U-amy'), { returnTo: '/history' })
    expect(outcome).toMatchObject({ kind: 'signedIn', returnTo: '/history', site: 'table' })
    if (outcome.kind !== 'signedIn') return
    expect(outcome.user.username).toBe('amy')
    expect((await club.userForToken(outcome.token))?.id).toBe(amy)
  })

  it('refuses an ID token LINE did not sign with our secret, a cancelled login and a reused state', async () => {
    const amy = await member('amy')
    await viaLine(account('U-amy'), { link: { userId: amy, password: PASSWORD } })
    signWith = 'forged-secret'
    expect(await viaLine(account('U-amy'))).toMatchObject({ kind: 'failed', code: 'lineFailed' })
    signWith = CHANNEL_SECRET
    expect(await viaLine(account('U-amy', { nonce: 'replayed' }))).toMatchObject({
      kind: 'failed',
      code: 'lineFailed',
    })
    const cancelled = await club.startOAuth('line', REDIRECT, 'table', '/', '1.2.3.4')
    expect(
      await club.finishOAuth('line', cancelled.flowId, { state: cancelled.flowId, code: '', error: 'ACCESS_DENIED' }, null),
    ).toMatchObject({
      kind: 'failed',
      code: 'lineFailed',
    })
    // A Google flow's state is no LINE flow
    const google = await club.startOAuth('google', `${ORIGIN}/api/auth/google/callback`, 'table', '/', '1.2.3.4')
    expect(await club.finishOAuth('line', google.flowId, { state: google.flowId, code: 'c', error: '' }, null)).toMatchObject({
      kind: 'failed',
      code: 'lineFailed',
    })
  })

  it('answers lineOff everywhere when the club has no LINE, while Google still works', async () => {
    await open(false)
    const amy = await member('amy')
    expect(club.oauthStatus('line')).toEqual({ enabled: false })
    expect(club.oauthStatus('google')).toEqual({ enabled: true })
    const me = (await club.userForToken((await club.login('amy', PASSWORD)).token))!
    expect(me.line).toBeUndefined()
    expect(me.google).toBeNull()
    await expect(club.startOAuth('line', REDIRECT, 'table', '/', '')).rejects.toMatchObject({
      code: 'lineOff',
    })
    await expect(club.unlinkOAuth('line', amy, PASSWORD)).rejects.toMatchObject({ code: 'lineOff' })
    await expect(club.finishOAuthCode('line', 'x'.repeat(43), '123456')).rejects.toMatchObject({
      code: 'lineOff',
    })
    await expect(
      club.register('bob', PASSWORD, 'tku', '', 'table', '', '', {
        oauth: { name: 'line', flow: 'x' },
      }),
    ).rejects.toMatchObject({
      code: 'lineOff',
    })
    expect(await club.oauthPending('line', 'x')).toEqual({ step: null })
  })
})

describe('binding LINE on My account (e1-t32)', () => {
  it('asks for the password, keeps only sub and the LINE name for the owner, and refuses one LINE account on two', async () => {
    const amy = await member('amy')
    const bob = await member('bob')
    await expect(
      club.startOAuth('line', REDIRECT, 'table', '/', '', {
        userId: amy,
        password: 'wrong-password',
      }),
    ).rejects.toMatchObject({
      code: 'wrongPassword',
    })
    expect((await viaLine(account('U-amy'), { link: { userId: amy, password: PASSWORD } })).kind).toBe('linked')
    expect(await store.get(`user:${amy}`)).toMatchObject({
      line: { sub: 'U-amy', name: 'LINE U-amy', linkedAt: time },
    })
    expect(JSON.stringify(await store.get(`user:${amy}`))).not.toContain('profile.line-scdn.net')
    const me = (await club.userForToken((await club.login('amy', PASSWORD)).token))!
    expect(me.line).toEqual({ name: 'LINE U-amy', linkedAt: time })
    expect(me.username).toBe('amy')
    expect(me.profile?.displayName).toBeUndefined()
    expect(JSON.stringify(await club.memberProfile(bob, amy))).not.toContain('LINE U-amy')
    expect(JSON.stringify(await club.adminUsers())).not.toContain('LINE U-amy')
    await expect(club.startOAuth('line', REDIRECT, 'table', '/', '', { userId: amy, password: PASSWORD })).rejects.toMatchObject({
      code: 'lineLinked',
    })
    expect(await viaLine(account('U-amy'), { link: { userId: bob, password: PASSWORD } })).toMatchObject({
      kind: 'failed',
      code: 'lineTaken',
      link: true,
    })
    expect(await viaLine(account('U-amy'), { link: { userId: bob, password: PASSWORD }, session: amy })).toMatchObject({
      kind: 'failed',
      code: 'lineFailed',
    })
  })

  it('binds LINE and Google side by side, and unbinds each on its own', async () => {
    const amy = await member('amy')
    await viaLine(account('U-amy'), { link: { userId: amy, password: PASSWORD } })
    const stored = await store.get<Record<string, unknown>>(`user:${amy}`)
    await store.put(`user:${amy}`, {
      ...stored,
      google: { sub: 'g-amy', email: 'amy@gmail.com', linkedAt: time },
    })
    await open(true, true)
    await expect(club.unlinkOAuth('line', amy, 'wrong-password')).rejects.toMatchObject({
      code: 'wrongPassword',
    })
    const me = await club.unlinkOAuth('line', amy, PASSWORD)
    expect(me.line).toBeNull()
    expect(me.google).toEqual({ email: 'amy@gmail.com', linkedAt: time })
    await expect(club.unlinkOAuth('line', amy, PASSWORD)).rejects.toMatchObject({
      code: 'lineNotLinked',
    })
    expect((await viaLine(account('U-amy'))).kind).toBe('apply')
  })

  it('exports the binding and deletes it with the account', async () => {
    const amy = await member('amy')
    await viaLine(account('U-amy'), { link: { userId: amy, password: PASSWORD } })
    expect((await club.exportAccount(amy, null)).account.line).toEqual({
      sub: 'U-amy',
      name: 'LINE U-amy',
      linkedAt: time,
    })
    await club.deleteOwnAccount(amy, PASSWORD)
    expect((await viaLine(account('U-amy'))).kind).toBe('apply')
  })
})

describe('applying with LINE (e1-t32)', () => {
  it('fills in only the display name, still needs a username, a password and an admin’s approval', async () => {
    const outcome = await viaLine(account('U-cat', { name: '陳小貓' }))
    if (outcome.kind !== 'apply') throw new Error('expected the form')
    const flow = outcome.flowId
    expect(await club.oauthPending('line', flow)).toEqual({ step: 'apply', name: '陳小貓' })
    // The flow is LINE's: Google's form cannot use it
    await expect(
      club.register('cat', PASSWORD, 'tku', '', 'table', '', '', {
        oauth: { name: 'google', flow },
      }),
    ).rejects.toMatchObject({
      code: 'googleFailed',
    })
    const result = await club.register('cat', PASSWORD, 'tku', '', 'table', '', '', {
      oauth: { name: 'line', flow },
      displayName: '小貓',
    })
    expect(result).toEqual({ pending: true, username: 'cat' })
    expect(await club.oauthPending('line', flow)).toEqual({ step: null })
    expect(await viaLine(account('U-cat'))).toMatchObject({
      kind: 'failed',
      code: 'awaitingApproval',
    })
    const approved = await club.adminApprove(club.adminApplications().find((a) => a.username === 'cat')!.id)
    expect(approved.profile).toEqual({ displayName: '小貓' })
    expect(approved.line).toEqual({ name: '陳小貓', linkedAt: time })
    expect(approved.google).toBeNull()
    expect(await viaLine(account('U-cat'))).toMatchObject({ kind: 'signedIn' })
  })

  it('on 淡江橋館 a LINE account with no club account is told to bind it or apply', async () => {
    expect(await viaLine(account('U-new'), { site: 'book' })).toMatchObject({
      kind: 'failed',
      code: 'lineNotLinked',
      site: 'book',
    })
  })
})

describe('two-step sign-in after LINE (e1-t32)', () => {
  it('asks for the code; LINE never replaces it', async () => {
    const admin = club.adminIds()[0]
    const { secret } = await adminWithTwoFactor(club, admin)
    await viaLine(account('U-admin'), { link: { userId: admin, password: PASSWORD } })
    time += 60_000
    const outcome = await viaLine(account('U-admin'), { returnTo: '/admin' })
    if (outcome.kind !== 'code') throw new Error('expected the code step')
    expect(await club.oauthPending('line', outcome.flowId)).toEqual({ step: 'code' })
    await expect(club.finishOAuthCode('line', outcome.flowId, '', '1.2.3.4')).rejects.toMatchObject({ code: 'twoFactorNeeded' })
    await expect(club.finishOAuthCode('line', outcome.flowId, '000000', '1.2.3.4')).rejects.toMatchObject({ code: 'twoFactorWrong' })
    // Google's code step does not take LINE's flow
    await expect(club.finishOAuthCode('google', outcome.flowId, await totpCode(secret, totpStep(time)), '1.2.3.4')).rejects.toMatchObject({
      code: 'googleFailed',
    })
    const signed = await club.finishOAuthCode('line', outcome.flowId, await totpCode(secret, totpStep(time)), '1.2.3.4')
    expect(signed.returnTo).toBe('/admin')
    expect((await club.userForToken(signed.token))?.id).toBe(admin)
    time += OAUTH_CODE_MS
    await expect(club.finishOAuthCode('line', outcome.flowId, '123456', '1.2.3.4')).rejects.toMatchObject({ code: 'lineFailed' })
  })
})
