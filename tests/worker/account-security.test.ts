// @vitest-environment node
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import { deviceLabel, SESSION_SEEN_STEP_MS } from '../../shared/account.ts'
import { enabledFeatures, featureEnabled, FEATURE_DEFAULTS } from '../../shared/features.ts'
import type { BoardState } from '../../shared/game.ts'
import type { BoardRecord } from '../../shared/protocol.ts'
import { indexRecord } from '../../worker/history-index.ts'
import { headersFile, PAGE_CSP, withSecurityHeaders } from '../../worker/security-headers.ts'
import { ClubService, type Connections } from '../../worker/service.ts'
import type { MemoryStore } from '../../worker/store.ts'
import { memoryStore } from './sqlite.ts'

const CHROME_WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'

let store: MemoryStore
let club: ClubService
let time: number
let disconnected: string[]
let adminId: string

const connections: Connections = {
  onlineUserIds: () => [],
  send: () => undefined,
  disconnect: (id) => void disconnected.push(id),
}

beforeEach(async () => {
  store = memoryStore()
  time = 1_000_000
  disconnected = []
  club = new ClubService(store, connections, { maxUsers: 20, now: () => time, schedule: () => undefined })
  await club.load()
  const founder = await club.register('admin', 'secret1', '')
  if (!('user' in founder)) throw new Error('the first account should sign in at once')
  adminId = founder.user.id
})

async function member(name: string) {
  await club.register(name, 'secret1', '')
  return (await club.adminApprove(club.adminApplications().find((a) => a.username === name)!.id)).id
}

describe('deviceLabel', () => {
  it('names the browser and the system, and nothing it does not know', () => {
    expect(deviceLabel(CHROME_WINDOWS)).toBe('Chrome · Windows')
    expect(deviceLabel(SAFARI_IPHONE)).toBe('Safari · iPhone')
    expect(deviceLabel(`${CHROME_WINDOWS} Edg/130.0.0.0`)).toBe('Edge · Windows')
    expect(deviceLabel('curl/8.0')).toBe('')
    expect(deviceLabel(null)).toBe('')
  })
})

describe('sessions (e11-t23)', () => {
  it('lists where the member is signed in, this device first, without any token', async () => {
    const ben = await member('ben')
    const { token: phone } = await club.login('ben', 'secret1', '', SAFARI_IPHONE)
    time += 5 * SESSION_SEEN_STEP_MS
    const { token: laptop } = await club.login('ben', 'secret1', '', CHROME_WINDOWS)
    const sessions = await club.accountSessions(ben, laptop)
    expect(sessions.map((s) => [s.device, s.current])).toEqual([
      ['Chrome · Windows', true],
      ['Safari · iPhone', false],
    ])
    expect(JSON.stringify(sessions)).not.toContain(phone)
    expect(JSON.stringify(sessions)).not.toContain(laptop)
    // Another member's sessions are not in the list
    expect((await club.accountSessions(adminId, null)).every((s) => !s.current)).toBe(true)
    expect(await club.accountSessions(adminId, null)).toHaveLength(1)
  })

  it('notes the last use at most once an hour', async () => {
    const ben = await member('ben')
    const { token } = await club.login('ben', 'secret1', '', CHROME_WINDOWS)
    const started = time
    time += SESSION_SEEN_STEP_MS / 2
    await club.userForToken(token)
    expect((await club.accountSessions(ben, token))[0].lastSeenAt).toBe(started)
    time += SESSION_SEEN_STEP_MS
    await club.userForToken(token)
    expect((await club.accountSessions(ben, token))[0].lastSeenAt).toBe(time)
  })

  it('signs other devices out and keeps this one, closing the member’s sockets', async () => {
    const ben = await member('ben')
    const { token: phone } = await club.login('ben', 'secret1', '', SAFARI_IPHONE)
    const { token: tablet } = await club.login('ben', 'secret1', '', SAFARI_IPHONE)
    const { token: laptop } = await club.login('ben', 'secret1', '', CHROME_WINDOWS)
    const { token: admins } = await club.login('admin', 'secret1')
    expect(await club.endOtherSessions(ben, laptop)).toBe(2)
    expect(await club.userForToken(phone)).toBeNull()
    expect(await club.userForToken(tablet)).toBeNull()
    expect((await club.userForToken(laptop))?.id).toBe(ben)
    expect((await club.userForToken(admins))?.id).toBe(adminId)
    expect(disconnected).toEqual([ben])
    // Nothing left to end: the sockets stay
    expect(await club.endOtherSessions(ben, laptop)).toBe(0)
    expect(disconnected).toEqual([ben])
  })

  it('signs one device out by its id, only the member’s own and never this one', async () => {
    const ben = await member('ben')
    const { token: phone } = await club.login('ben', 'secret1', '', SAFARI_IPHONE)
    const { token: laptop } = await club.login('ben', 'secret1', '', CHROME_WINDOWS)
    const [current, other] = await club.accountSessions(ben, laptop)
    await expect(club.endSession(ben, laptop, current.id)).rejects.toMatchObject({ code: 'notSelf' })
    // Someone else cannot end it, and learns nothing about whether it exists
    await expect(club.endSession(adminId, null, other.id)).rejects.toMatchObject({ code: 'sessionGone', status: 404 })
    await club.endSession(ben, laptop, other.id)
    expect(await club.userForToken(phone)).toBeNull()
    await expect(club.endSession(ben, laptop, other.id)).rejects.toMatchObject({ code: 'sessionGone' })
  })

  it('signs the other devices out when the password changes (ASVS 3.3.3)', async () => {
    const ben = await member('ben')
    const { token: phone } = await club.login('ben', 'secret1', '', SAFARI_IPHONE)
    const { token: laptop } = await club.login('ben', 'secret1', '', CHROME_WINDOWS)
    await club.changePassword(ben, 'secret1', 'secret2', laptop)
    expect(await club.userForToken(phone)).toBeNull()
    expect((await club.userForToken(laptop))?.id).toBe(ben)
    expect(disconnected).toEqual([ben])
  })

  it('takes passwords up to LIMITS.passwordMax (ASVS 2.1.2)', async () => {
    const ben = await member('ben')
    await expect(club.changePassword(ben, 'secret1', 'x'.repeat(129))).rejects.toMatchObject({ code: 'longPassword', params: { max: 128 } })
    await club.changePassword(ben, 'secret1', 'x'.repeat(128))
    await expect(club.register('cal', 'y'.repeat(129), '')).rejects.toMatchObject({ code: 'longPassword' })
  })

  it('lists a session written before the list, giving it an id once', async () => {
    const ben = await member('ben')
    await store.put('session:old-token', { userId: ben, expires: time + 86_400_000 })
    const [first] = await club.accountSessions(ben, 'old-token')
    expect(first).toMatchObject({ device: '', current: true, createdAt: time + 86_400_000 - 30 * 86_400_000 })
    expect((await club.accountSessions(ben, 'old-token'))[0].id).toBe(first.id)
  })
})

describe('feature flags (e11-t26)', () => {
  const member1 = { id: 'm', admin: false, permissions: [] }
  const officer = { id: 'o', admin: false, permissions: ['bookEdit'] }
  const admin = { id: 'a', admin: true, permissions: [] }

  it('decides by the club’s state, else the site-wide default, and names members who get it anyway', () => {
    expect(featureEnabled('friends', {}, admin)).toBe(FEATURE_DEFAULTS.friends === 'on')
    const officers = { friends: { state: 'officers' as const, users: ['m'] } }
    expect([officer, admin, member1, { ...member1, id: 'x' }].map((m) => featureEnabled('friends', officers, m))).toEqual([true, true, true, false])
    expect(enabledFeatures({ friends: { state: 'on', users: [] } }, member1)).toEqual(['friends'])
    expect(enabledFeatures({ friends: { state: 'off', users: [] } }, admin)).toEqual([])
  })

  it('lets admins open a flag to the officers and some members, and sends each member their flags', async () => {
    const ben = await member('ben')
    const cal = await member('cal')
    await club.adminSetPermissions(cal, ['bookEdit'])
    const dan = await member('dan')
    const views = await club.adminSetFeature({ flag: 'friends', state: 'officers', usernames: ['Dan', 'dan'] })
    expect(views.find((v) => v.flag === 'friends')).toEqual({
      flag: 'friends',
      default: FEATURE_DEFAULTS.friends,
      state: 'officers',
      custom: true,
      users: [{ id: dan, username: 'dan' }],
    })
    const features = async (id: string) => {
      const { token } = await club.login(club.usernameOf(id)!, 'secret1')
      return (await club.userForToken(token))?.features
    }
    expect(await features(adminId)).toEqual(['friends'])
    expect(await features(cal)).toEqual(['friends'])
    expect(await features(dan)).toEqual(['friends'])
    expect(await features(ben)).toEqual([])
    expect(club.featureOn('friends', ben)).toBe(false)
    // Kept across a restart of the object
    const again = new ClubService(store, connections, { maxUsers: 20, now: () => time, schedule: () => undefined })
    await again.load()
    expect(again.featureOn('friends', cal)).toBe(true)
    // Back to the default
    await club.adminSetFeature({ flag: 'friends', state: null, usernames: [] })
    expect(club.adminFeatures()[0]).toMatchObject({ custom: false, state: FEATURE_DEFAULTS.friends, users: [] })
  })

  it('turns away unknown flags, states and members', async () => {
    await expect(club.adminSetFeature({ flag: 'teleport', state: 'on', usernames: [] })).rejects.toMatchObject({ code: 'badFeature' })
    await expect(club.adminSetFeature({ flag: 'friends', state: 'maybe', usernames: [] })).rejects.toMatchObject({ code: 'badFeature' })
    await expect(club.adminSetFeature({ flag: 'friends', state: 'on', usernames: 'ben' })).rejects.toMatchObject({ code: 'badFeature' })
    await expect(club.adminSetFeature({ flag: 'friends', state: 'on', usernames: ['nobody'] })).rejects.toMatchObject({
      code: 'unknownMember',
      params: { name: 'nobody' },
    })
  })
})

describe('the member’s own data (e11-t27)', () => {
  async function played(id: string, players: string[]) {
    const [N, E, S, W] = players.map((x) => ({ id: x, username: club.usernameOf(x) ?? x }))
    const record: BoardRecord = {
      id,
      tableNumber: 1,
      finishedAt: time,
      players: { N, E, S, W },
      board: { boardNo: 1, dealer: 'N', vul: 'None', contract: null, result: { declarerTricks: 0, scoreNS: 0, claimed: false } } as unknown as BoardState,
    }
    await store.put(`board:${id}`, record)
    indexRecord(store.sql, record)
  }

  it('exports everything kept about the member, without the password hash or any token', async () => {
    const ben = await member('ben')
    const amy = await member('amy')
    const { token } = await club.login('ben', 'secret1', '', CHROME_WINDOWS)
    await club.setProfile(ben, { displayName: '小明' })
    await club.handle(ben, { type: 'sendDirect', to: amy, text: 'hi amy' })
    await played('b1', [ben, amy, adminId, 'robot:N'])
    await played('b2', [amy, adminId, 'x', 'y'])
    await club.saveFavorite(ben, 'b1', { note: 'nice squeeze' })
    const data = await club.exportAccount(ben, token)
    expect(data).toMatchObject({
      format: 'tku-bridge-table-account',
      version: 1,
      account: { id: ben, username: 'ben', profile: { displayName: '小明' } },
      sessions: [{ device: 'Chrome · Windows', current: true }],
      directMessages: [{ from: 'ben', to: 'amy', text: 'hi amy' }],
      favorites: [{ boardId: 'b1', note: 'nice squeeze' }],
    })
    expect(data.boards.map((b) => b.id)).toEqual(['b1'])
    const text = JSON.stringify(data)
    expect(text).not.toContain('passwordHash')
    expect(text).not.toContain('pbkdf2')
    expect(text).not.toContain(token)
  })

  it('deletes the member’s own account with their password, signing them out everywhere', async () => {
    const ben = await member('ben')
    const { token } = await club.login('ben', 'secret1')
    await expect(club.deleteOwnAccount(ben, 'wrong')).rejects.toMatchObject({ code: 'wrongPassword' })
    expect(club.usernameOf(ben)).toBe('ben')
    await club.deleteOwnAccount(ben, 'secret1')
    expect(club.usernameOf(ben)).toBeUndefined()
    expect(await club.userForToken(token)).toBeNull()
    expect(disconnected).toContain(ben)
    await expect(club.login('ben', 'secret1')).rejects.toMatchObject({ code: 'badLogin' })
  })

  it('keeps the club’s last admin', async () => {
    await expect(club.deleteOwnAccount(adminId, 'secret1')).rejects.toMatchObject({ code: 'lastAdminLeaving' })
    const ben = await member('ben')
    await club.adminSetAdmin(adminId, ben, true)
    await club.deleteOwnAccount(adminId, 'secret1')
    expect(club.usernameOf(adminId)).toBeUndefined()
  })
})

describe('security headers (e11-t23)', () => {
  it('public/_headers gives every page the same headers as the code', () => {
    expect(readFileSync('public/_headers', 'utf8').replace(/\r\n/g, '\n')).toBe(headersFile())
  })

  it('the page’s policy allows only the site itself, plus what DDS and styled-components need', () => {
    expect(PAGE_CSP).toContain("default-src 'self'")
    expect(PAGE_CSP).toContain("script-src 'self' 'wasm-unsafe-eval'")
    expect(PAGE_CSP).not.toMatch(/script-src[^;]*'unsafe-inline'/)
    expect(PAGE_CSP).toContain("connect-src 'self'")
    expect(PAGE_CSP).toContain("frame-ancestors 'none'")
    expect(PAGE_CSP).toContain("object-src 'none'")
  })

  it('adds the API’s headers, keeps what an answer set, and leaves a WebSocket upgrade alone', () => {
    const api = withSecurityHeaders(new Response('{}', { headers: { 'Content-Type': 'application/json' } }), '/api/me')
    expect(api.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(api.headers.get('Content-Security-Policy')).toContain("default-src 'none'")
    expect(api.headers.get('X-Frame-Options')).toBe('DENY')
    expect(api.headers.get('Strict-Transport-Security')).toContain('max-age=')
    // A file by its signed address may be framed (BridgeHall's PDF reader)
    const file = withSecurityHeaders(new Response('x'), '/api/files/ebook/a.pdf')
    expect(file.headers.get('X-Frame-Options')).toBeNull()
    expect(file.headers.get('X-Content-Type-Options')).toBe('nosniff')
    const page = withSecurityHeaders(new Response('<!doctype html>'), '/')
    expect(page.headers.get('Content-Security-Policy')).toBe(PAGE_CSP)
    const own = withSecurityHeaders(new Response('', { headers: { 'Referrer-Policy': 'no-referrer' } }), '/api/me')
    expect(own.headers.get('Referrer-Policy')).toBe('no-referrer')
  })
})
