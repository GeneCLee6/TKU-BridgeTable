/**
 * Test data for staging and PR previews (DEPLOY.md §2.1): the founding admin, a handful of members
 * and one application waiting for approval, created through the public API like a person would.
 * Safe to run again: accounts that already exist are left alone. Never runs against production.
 */

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
}

export type SeedResult = { created: string[]; existing: string[]; pending: string[] }

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
  const result: SeedResult = { created: [], existing: [], pending: [] }

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

  const login = await call('/api/login', { username: admin, password })
  if (!login.response.ok) throw fail(`Signing in as ${admin}`, login.data, login.response.status)
  const cookie = (login.response.headers.get('set-cookie') ?? '').split(';')[0]

  for (let i = 1; i <= (options.members ?? 8); i++) {
    const username = `${SEED_PREFIX}${i}`
    const added = await call('/api/admin/users', { username, password }, cookie)
    if (added.response.ok) result.created.push(username)
    else if (added.data.code === 'usernameTaken') result.existing.push(username)
    else throw fail(`Adding ${username}`, added.data, added.response.status)
  }

  // One application for the admin page's approval queue
  const applied = await call('/api/register', { username: SEED_APPLICANT, password, inviteCode, note: 'Seeded test application' })
  if (applied.response.status === 202) result.pending.push(SEED_APPLICANT)
  else if (applied.data.code === 'usernameTaken') result.existing.push(SEED_APPLICANT)
  else throw fail(`Applying as ${SEED_APPLICANT}`, applied.data, applied.response.status)

  return result
}
