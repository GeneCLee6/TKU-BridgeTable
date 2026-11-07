/**
 * Test data for staging and PR previews (DEPLOY.md §2.1): the founding admin, a handful of members
 * and one application waiting for approval, created through the public API like a person would.
 * Safe to run again: accounts that already exist are left alone. Never runs against production.
 * Adding members takes an admin with two-step sign-in on: `adminAccess` turns it on for the run and
 * off again, and leaves it alone when someone has turned it on themselves.
 */
import { adminAccess, type AdminPost } from './admin-access.ts'

export const PRODUCTION_HOST = 'tku-bridge-table.genelee-pro.workers.dev'

export type SeedOptions = {
  /** The staging or preview site, e.g. https://tku-bridge-table-staging.<subdomain>.workers.dev */
  url: string
  /** Password for every seeded account */
  password: string
  /** The site's INVITE_CODE ('' when it has none) */
  inviteCode: string
  /** How many members besides the admin (default 8) */
  members?: number
  admin?: string
  /** The admin's TOTP secret, when someone turned two-step sign-in on and members are still missing */
  totpSecret?: string
}

export type SeedResult = {
  created: string[]
  existing: string[]
  pending: string[]
  /** How the run left the admin: 'off' signs in with the password alone, 'on' also takes a code */
  adminTwoFactor: 'on' | 'off'
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export const SEED_PREFIX = 'tester'
export const SEED_APPLICANT = 'applicant1'

/** Refuses production: by host name, and any Worker that is not a staging or PR preview one */
export function checkTarget(url: string) {
  let host: string
  try {
    host = new URL(url).host
  } catch {
    throw new Error(`Not a URL: ${url}`)
  }
  const local = host.startsWith('localhost') || host.startsWith('127.0.0.1')
  const ours = /^tku-bridge-table-(staging|pr-\d+)\./.test(host)
  if (host === PRODUCTION_HOST || !(local || ours))
    throw new Error(`Refusing to seed ${host}: only localhost, tku-bridge-table-staging and tku-bridge-table-pr-<n>`)
  return new URL(url).origin
}

export async function seed(options: SeedOptions, fetcher: Fetch = fetch): Promise<SeedResult> {
  const origin = checkTarget(options.url)
  const admin = options.admin ?? 'admin'
  const { password, inviteCode } = options
  const result: SeedResult = { created: [], existing: [], pending: [], adminTwoFactor: 'on' }

  const call = async (path: string, body: unknown, cookie?: string) => {
    const response = await fetcher(`${origin}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body),
    })
    const data = (await response.json().catch(() => ({}))) as { code?: string; error?: string; pending?: boolean }
    return { response, data }
  }
  const fail = (what: string, data: { code?: string; error?: string }, status: number) =>
    new Error(`${what} failed (${status} ${data.code ?? ''}): ${data.error ?? ''}`)

  // The first account on an empty site is the admin, created at once
  const founder = await call('/api/register', { username: admin, password, inviteCode })
  if (founder.response.status === 200) result.created.push(admin)
  else if (founder.data.code === 'usernameTaken') result.existing.push(admin)
  else if (founder.response.status === 202)
    throw new Error(`${admin} was sent as an application: this site already has an admin, so seed it with that account (--admin)`)
  else throw fail(`Registering ${admin}`, founder.data, founder.response.status)

  let cookie = ''
  const post: AdminPost = async (path, body) => {
    const { response, data } = await call(path, body, cookie)
    if (path === '/api/login' && response.ok) cookie = (response.headers.get('set-cookie') ?? '').split(';')[0]
    return { status: response.status, data }
  }
  const memberNames = Array.from({ length: options.members ?? 8 }, (_, i) => `${SEED_PREFIX}${i + 1}`)
  const access = await adminAccess(post, { username: admin, password, totpSecret: options.totpSecret })
  if (access) {
    try {
      for (const username of memberNames) {
        const added = await call('/api/admin/users', { username, password }, cookie)
        if (added.response.ok) result.created.push(username)
        else if (added.data.code === 'usernameTaken') result.existing.push(username)
        else throw fail(`Adding ${username}`, added.data, added.response.status)
      }
    } finally {
      await access.release()
    }
    if (access.turnedOn) result.adminTwoFactor = 'off'
  } else {
    // Two-step sign-in is on and the secret is not here. Nothing to do if the members are already
    // there (a person using the site, a later push); stops at the first one that is not, since
    // each miss counts against this address's failed sign-ins
    for (const username of memberNames) {
      const member = await call('/api/login', { username, password })
      if (!member.response.ok)
        throw new Error(`${admin} has two-step sign-in on, so ${username} cannot be added (sign-in answered ${member.response.status} ${member.data.code ?? ''}): set SEED_TOTP_SECRET (DEPLOY.md §2.1)`)
      result.existing.push(username)
    }
  }

  // One application for the admin page's approval queue
  const applied = await call('/api/register', { username: SEED_APPLICANT, password, inviteCode, note: 'Seeded test application' })
  if (applied.response.status === 202) result.pending.push(SEED_APPLICANT)
  else if (applied.data.code === 'usernameTaken') result.existing.push(SEED_APPLICANT)
  else throw fail(`Applying as ${SEED_APPLICANT}`, applied.data, applied.response.status)

  return result
}
