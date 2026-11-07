// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '../../shared/messages.ts'
import { ClubService, type Connections } from '../../worker/service.ts'
import { checkTarget, seed } from '../../scripts/seed.ts'
import { adminWithTwoFactor } from './admin-two-factor.ts'
import { memoryStore } from './sqlite.ts'

const connections: Connections = { onlineUserIds: () => [], send: () => {}, disconnect: () => {} }
const STAGING = 'https://tku-bridge-table-staging.example.workers.dev'
const PASSWORD = 'club-secret-1'

let club: ClubService
/** Every secret the fake site handed the seed, to check none of them comes out again */
let handedOut: string[]

/** The few routes the seed uses, answered by the real service the way worker/club.ts does, the admin check included */
const fetcher = async (input: string, init?: RequestInit) => {
  const path = new URL(input).pathname
  const body = JSON.parse(String(init?.body ?? '{}'))
  const token = (init?.headers as Record<string, string>)?.Cookie?.split('=')[1] ?? null
  const reply = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(data), { status, headers })
  try {
    if (path === '/api/register') {
      const result = await club.register(body.username, body.password, body.inviteCode, body.note)
      return 'pending' in result ? reply(result, 202) : reply({ user: result.user })
    }
    if (path === '/api/login') {
      const { user, token: session } = await club.login(body.username, body.password, '', '', body.code)
      handedOut.push(session)
      return reply({ user }, 200, { 'Set-Cookie': `tbt_session=${session}; Path=/; HttpOnly` })
    }
    const user = await club.userForToken(token)
    if (!user) return reply({ code: 'signInFirst' }, 401)
    if (path === '/api/admin/users') {
      club.requireAdmin(user.id)
      return reply({ user: await club.adminCreateUser(body.username, body.password) })
    }
    if (path === '/api/account/2fa/setup') {
      const setup = await club.startTwoFactor(user.id, body.password)
      handedOut.push(setup.secret)
      return reply(setup)
    }
    if (path === '/api/account/2fa/enable') {
      const enabled = await club.enableTwoFactor(user.id, body.code, token)
      handedOut.push(...enabled.recoveryCodes)
      return reply(enabled)
    }
    if (path === '/api/account/2fa/disable') return reply({ user: await club.disableTwoFactor(user.id, body.password, body.code) })
    return reply({ code: 'noSuchApi' }, 404)
  } catch (error) {
    if (error instanceof AppError) return reply({ code: error.code, error: error.message }, error.status)
    throw error
  }
}

const options = { url: STAGING, password: PASSWORD, inviteCode: 'staging-code' }

/** Whether the password alone signs the account in */
const signsInWithPassword = (username = 'admin') =>
  club.login(username, PASSWORD).then(
    () => true,
    (error: AppError) => {
      expect(error.code).toBe('twoFactorNeeded')
      return false
    },
  )

/** An admin who turned the second step on, as a person does on the account page */
async function adminWhoTurnedItOn() {
  const founder = await club.register('admin', PASSWORD, 'staging-code')
  if ('pending' in founder) throw new Error('the first account should not wait for approval')
  return adminWithTwoFactor(club, founder.user.id, PASSWORD)
}

beforeEach(async () => {
  handedOut = []
  club = new ClubService(memoryStore(), connections, { maxUsers: 30, inviteCode: 'staging-code', schedule: () => {} })
  await club.load()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('seed (e11-t15)', () => {
  it('creates the admin, members and one application', async () => {
    const result = await seed({ ...options, members: 3 }, fetcher)
    expect(result).toEqual({ created: ['admin', 'tester1', 'tester2', 'tester3'], existing: [], pending: ['applicant1'], adminTwoFactor: 'off' })
    const users = await club.adminUsers()
    expect(users.map((u) => u.username).sort()).toEqual(['admin', 'tester1', 'tester2', 'tester3'])
    expect(users.find((u) => u.username === 'admin')?.admin).toBe(true)
    expect(club.adminApplications().map((a) => a.username)).toEqual(['applicant1'])
  })

  it('can run again without duplicating anything', async () => {
    await seed({ ...options, members: 2 }, fetcher)
    const again = await seed({ ...options, members: 3 }, fetcher)
    expect(again).toEqual({ created: ['tester3'], existing: ['admin', 'tester1', 'tester2', 'applicant1'], pending: [], adminTwoFactor: 'off' })
  })

  it('stops on a wrong invite code', async () => {
    await expect(seed({ ...options, inviteCode: 'nope' }, fetcher)).rejects.toThrow(/badInvite/)
  })

  it('never seeds production or an unknown site', () => {
    expect(() => checkTarget('https://tku-bridge-table.genelee-pro.workers.dev')).toThrow(/Refusing/)
    expect(() => checkTarget('https://example.com')).toThrow(/Refusing/)
    expect(() => checkTarget('not a url')).toThrow(/Not a URL/)
    expect(checkTarget('https://tku-bridge-table-pr-12.genelee-pro.workers.dev/lobby')).toBe(
      'https://tku-bridge-table-pr-12.genelee-pro.workers.dev',
    )
    expect(checkTarget('http://localhost:5173')).toBe('http://localhost:5173')
  })
})

describe('seed with two-step sign-in enforced', () => {
  it('this fake site refuses an admin without it, as the real one does', async () => {
    await club.register('admin', PASSWORD, 'staging-code')
    const { token } = await club.login('admin', PASSWORD)
    const answer = await fetcher(`${STAGING}/api/admin/users`, {
      method: 'POST',
      headers: { Cookie: `tbt_session=${token}` },
      body: JSON.stringify({ username: 'tester1', password: PASSWORD }),
    })
    expect(answer.status).toBe(403)
    expect(((await answer.json()) as { code: string }).code).toBe('adminTwoFactorRequired')
  })

  it('leaves the admin able to sign in with the password alone', async () => {
    await seed({ ...options, members: 1 }, fetcher)
    expect(await signsInWithPassword()).toBe(true)
  })

  it('turns it off again when adding a member fails half way', async () => {
    club = new ClubService(memoryStore(), connections, { maxUsers: 2, inviteCode: 'staging-code', schedule: () => {} })
    await club.load()
    await expect(seed({ ...options, members: 3 }, fetcher)).rejects.toThrow(/memberCap/)
    expect(await signsInWithPassword()).toBe(true)
  })

  it('never lets a secret out: not in the result, an error or the console', async () => {
    const lines: unknown[][] = []
    for (const method of ['log', 'error', 'warn', 'info'] as const)
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void lines.push(args))
    club = new ClubService(memoryStore(), connections, { maxUsers: 2, inviteCode: 'staging-code', schedule: () => {} })
    await club.load()
    const error = await seed({ ...options, members: 3 }, fetcher).catch((e: Error) => e)
    const output = JSON.stringify([String(error), lines])
    // The secret, the recovery codes and the session all went by
    expect(handedOut.length).toBeGreaterThan(10)
    for (const secret of handedOut) expect(output).not.toContain(secret)
    club = new ClubService(memoryStore(), connections, { maxUsers: 30, inviteCode: 'staging-code', schedule: () => {} })
    await club.load()
    const result = await seed({ ...options, members: 1 }, fetcher)
    for (const secret of handedOut) expect(JSON.stringify(result)).not.toContain(secret)
  })

  it('with the secret, adds members and leaves a person\'s two-step sign-in on', async () => {
    const { secret } = await adminWhoTurnedItOn()
    const result = await seed({ ...options, members: 2, totpSecret: secret }, fetcher)
    expect(result).toEqual({ created: ['tester1', 'tester2'], existing: ['admin'], pending: ['applicant1'], adminTwoFactor: 'on' })
    expect(await signsInWithPassword()).toBe(false)
  })

  it('without the secret, is done when the members are already there', async () => {
    await seed({ ...options, members: 2 }, fetcher)
    const admin = (await club.adminUsers()).find((u) => u.username === 'admin')!
    await adminWithTwoFactor(club, admin.id, PASSWORD)
    const result = await seed({ ...options, members: 2 }, fetcher)
    expect(result).toEqual({ created: [], existing: ['admin', 'tester1', 'tester2', 'applicant1'], pending: [], adminTwoFactor: 'on' })
    expect(await signsInWithPassword()).toBe(false)
  })

  it('without the secret, says so when members are missing', async () => {
    await adminWhoTurnedItOn()
    await expect(seed({ ...options, members: 2 }, fetcher)).rejects.toThrow(/two-step sign-in on.*SEED_TOTP_SECRET/)
    expect(await signsInWithPassword()).toBe(false)
  })
})
