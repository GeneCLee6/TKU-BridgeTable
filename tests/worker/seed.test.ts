// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { AppError } from '../../shared/messages.ts'
import { ClubService, type Connections } from '../../worker/service.ts'
import { checkTarget, seed } from '../../scripts/seed.ts'
import { memoryStore } from './sqlite.ts'

const connections: Connections = { onlineUserIds: () => [], send: () => {}, disconnect: () => {} }
const STAGING = 'https://tku-bridge-table-staging.example.workers.dev'

let club: ClubService

/** The few routes the seed uses, answered by the real service the way worker/club.ts does */
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
      const { token: session } = await club.login(body.username, body.password)
      return reply({}, 200, { 'Set-Cookie': `tbt_session=${session}; Path=/; HttpOnly` })
    }
    if (path === '/api/admin/users') {
      const user = await club.userForToken(token)
      if (!user?.admin) return reply({ code: 'signInFirst' }, 401)
      return reply({ user: await club.adminCreateUser(body.username, body.password) })
    }
    return reply({ code: 'noSuchApi' }, 404)
  } catch (error) {
    if (error instanceof AppError) return reply({ code: error.code, error: error.message }, error.status)
    throw error
  }
}

beforeEach(async () => {
  club = new ClubService(memoryStore(), connections, { maxUsers: 30, inviteCode: 'staging-code', schedule: () => {} })
  await club.load()
})

describe('seed (e11-t15)', () => {
  it('creates the admin, members and one application', async () => {
    const result = await seed({ url: STAGING, password: 'secret1', inviteCode: 'staging-code', members: 3 }, fetcher)
    expect(result).toEqual({ created: ['admin', 'tester1', 'tester2', 'tester3'], existing: [], pending: ['applicant1'] })
    const users = await club.adminUsers()
    expect(users.map((u) => u.username).sort()).toEqual(['admin', 'tester1', 'tester2', 'tester3'])
    expect(users.find((u) => u.username === 'admin')?.admin).toBe(true)
    expect(club.adminApplications().map((a) => a.username)).toEqual(['applicant1'])
  })

  it('can run again without duplicating anything', async () => {
    await seed({ url: STAGING, password: 'secret1', inviteCode: 'staging-code', members: 2 }, fetcher)
    const again = await seed({ url: STAGING, password: 'secret1', inviteCode: 'staging-code', members: 3 }, fetcher)
    expect(again).toEqual({ created: ['tester3'], existing: ['admin', 'tester1', 'tester2', 'applicant1'], pending: [] })
  })

  it('stops on a wrong invite code', async () => {
    await expect(seed({ url: STAGING, password: 'secret1', inviteCode: 'nope' }, fetcher)).rejects.toThrow(/badInvite/)
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
