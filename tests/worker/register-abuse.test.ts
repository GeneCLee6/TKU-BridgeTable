// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import type { ServerMessage } from '../../shared/protocol.ts'
import type { LogEntry } from '../../worker/log.ts'
import { REGISTRATION_WINDOW_MS, REGISTRATIONS_PER_ADDRESS } from '../../worker/register-limit.ts'
import { ClubError, ClubService, type Connections } from '../../worker/service.ts'
import type { MemoryStore } from '../../worker/store.ts'
import { requireTurnstile, TURNSTILE_VERIFY_URL, turnstileKeys } from '../../worker/turnstile.ts'
import { memoryStore } from './sqlite.ts'

/** 申請加入 against abuse (e1-t33, AC-1.9): registrations per address and Turnstile */

class NoConnections implements Connections {
  onlineUserIds() {
    return []
  }
  send(_userId: string, _message: ServerMessage) {}
  disconnect(_userId: string) {}
}

const SALT = 'test-salt-0123456789abcdef'
const HOME = '203.0.113.7'
let store: MemoryStore
let club: ClubService
let time: number
let logs: LogEntry[]

const newClub = (seenSalt?: string) =>
  new ClubService(store, new NoConnections(), {
    maxUsers: 100,
    inviteCode: 'tku',
    now: () => time,
    schedule: () => {},
    seenSalt,
    log: (entry) => logs.push(entry),
  })

beforeEach(async () => {
  store = memoryStore()
  time = 1_000_000_000
  logs = []
  club = newClub(SALT)
  await club.load()
  await club.register('admin', 'club-secret-1', 'tku', '', 'table', '', '198.51.100.1')
})

const apply = (name: string, address = HOME, invite = 'tku') => club.register(name, 'club-secret-1', invite, '', 'table', '', address)

async function codeOf(attempt: Promise<unknown>) {
  try {
    await attempt
  } catch (error) {
    if (error instanceof ClubError) return { code: error.code, status: error.status, params: error.params }
    throw error
  }
  return null
}

describe('registrations per address', () => {
  it('lets REGISTRATIONS_PER_ADDRESS through in the window, then says how long to wait', async () => {
    for (let i = 0; i < REGISTRATIONS_PER_ADDRESS; i++) expect(await apply(`amy${i}`)).toMatchObject({ pending: true })
    expect(await codeOf(apply('late'))).toEqual({ code: 'tooManyRegistrations', status: 429, params: { minutes: 60 } })
    expect(logs).toContainEqual({ event: 'registerLimited' })
    // Another address is not held up
    expect(await apply('elsewhere', '192.0.2.9')).toMatchObject({ pending: true })
    // The window ends
    time += REGISTRATION_WINDOW_MS
    expect(await apply('late')).toMatchObject({ pending: true })
  })

  it('counts wrong invite codes, but not a mistake in the form', async () => {
    for (let i = 0; i < 3; i++) expect((await codeOf(apply(`x${i}`, HOME, 'guess')))!.code).toBe('badInvite')
    for (let i = 0; i < 20; i++) expect((await codeOf(club.register('admin', 'club-secret-1', 'tku', '', 'table', '', HOME)))!.code).toBe('usernameTaken')
    for (let i = 0; i < REGISTRATIONS_PER_ADDRESS - 3; i++) await apply(`amy${i}`)
    expect((await codeOf(apply('late')))!.code).toBe('tooManyRegistrations')
  })

  it('keeps only a salted hash of the address, and only until its window ends', async () => {
    await apply('amy')
    const kept = await store.get<Record<string, { count: number; since: number }>>('meta:registrations')
    expect(Object.keys(kept!)).toHaveLength(2)
    expect(JSON.stringify([...(await store.list(''))])).not.toContain(HOME)
    for (const key of Object.keys(kept!)) expect(key).toMatch(/^[0-9a-f]{16}$/)
    // A new window drops the ended ones
    time += REGISTRATION_WINDOW_MS
    await apply('ben', '192.0.2.9')
    expect(Object.keys((await store.get<object>('meta:registrations'))!)).toHaveLength(1)
  })

  it('survives the object waking again when the salt is the secret', async () => {
    for (let i = 0; i < REGISTRATIONS_PER_ADDRESS; i++) await apply(`amy${i}`)
    club = newClub(SALT)
    await club.load()
    expect((await codeOf(apply('late')))!.code).toBe('tooManyRegistrations')
  })

  it('without SEEN_SALT still limits, in memory only, and writes nothing', async () => {
    club = newClub(undefined)
    await club.load()
    await store.delete('meta:registrations')
    for (let i = 0; i < REGISTRATIONS_PER_ADDRESS; i++) await apply(`amy${i}`)
    expect((await codeOf(apply('late')))!.code).toBe('tooManyRegistrations')
    expect(await store.get('meta:registrations')).toBeUndefined()
  })

  it('has no limit without an address (local development)', async () => {
    for (let i = 0; i < REGISTRATIONS_PER_ADDRESS + 2; i++) expect(await apply(`amy${i}`, '')).toMatchObject({ pending: true })
  })
})

describe('Turnstile', () => {
  const answer = (body: unknown) => async () => new Response(JSON.stringify(body))

  it('is off unless both the site key and the secret are set', () => {
    expect(turnstileKeys({})).toBeNull()
    expect(turnstileKeys({ TURNSTILE_SITE_KEY: '0x4AAA' })).toBeNull()
    expect(turnstileKeys({ TURNSTILE_SECRET_KEY: 'secret' })).toBeNull()
    expect(turnstileKeys({ TURNSTILE_SITE_KEY: ' 0x4AAA ', TURNSTILE_SECRET_KEY: 'secret' })).toEqual({ siteKey: '0x4AAA', secret: 'secret' })
  })

  it('sends the token, secret and address to Cloudflare and lets a good one through', async () => {
    let sent: { url: string; form: FormData } | null = null
    const fetcher = (async (url: string, init: RequestInit) => {
      sent = { url, form: init.body as FormData }
      return new Response(JSON.stringify({ success: true }))
    }) as unknown as typeof fetch
    await requireTurnstile('secret', 'token-1', HOME, (e) => logs.push(e), fetcher)
    expect(sent!.url).toBe(TURNSTILE_VERIFY_URL)
    expect(sent!.form.get('secret')).toBe('secret')
    expect(sent!.form.get('response')).toBe('token-1')
    expect(sent!.form.get('remoteip')).toBe(HOME)
  })

  it('turns away a missing, wrong or used token, and fails closed when Cloudflare cannot be reached', async () => {
    const log = (e: LogEntry) => logs.push(e)
    const never = (async () => {
      throw new Error('not called')
    }) as unknown as typeof fetch
    expect(await codeOf(requireTurnstile('secret', '', HOME, log, never))).toEqual({ code: 'captchaFailed', status: 403, params: {} })
    expect(await codeOf(requireTurnstile('secret', 'x'.repeat(2049), HOME, log, never))).toMatchObject({ code: 'captchaFailed' })
    const used = answer({ success: false, 'error-codes': ['timeout-or-duplicate'] }) as unknown as typeof fetch
    expect(await codeOf(requireTurnstile('secret', 'token-1', HOME, log, used))).toMatchObject({ code: 'captchaFailed' })
    expect(logs).toContainEqual({ event: 'turnstileFailed', codes: 'timeout-or-duplicate' })
    const down = (async () => {
      throw new TypeError('network')
    }) as unknown as typeof fetch
    expect(await codeOf(requireTurnstile('secret', 'token-1', HOME, log, down))).toMatchObject({ code: 'captchaFailed' })
    expect(logs).toContainEqual({ event: 'turnstileFailed', codes: 'unreachable' })
  })
})
