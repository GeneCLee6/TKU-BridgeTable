/**
 * How the seed and the load test act as an admin now that admins must have two-step sign-in on
 * (ClubService.actsAsAdmin, DEPLOY.md §2.1 and §4.15). Through the public API, the way a person does
 * on the account page: there is deliberately no switch in the Worker for this.
 *
 * The TOTP secret and the recovery codes stay in this process's memory, and only the server's
 * error code and message are ever thrown: nothing here may reach a log, this repository is public.
 */
import { TOTP_SETUP_MS, totpCode, totpStep } from '../worker/totp.ts'

type Answer = {
  status: number
  data: { code?: string; error?: string; user?: { id: string }; secret?: string; expiresAt?: number; recoveryCodes?: string[] }
}

/** POSTs JSON as the admin: keeps the session cookie the sign-in answers, like a browser */
export type AdminPost = (path: string, body: unknown) => Promise<Answer>

export type AdminAccess = {
  userId: string
  /** Whether this run turned two-step sign-in on, and so `release` turns it off again */
  turnedOn: boolean
  /** Call when the admin work is done, also after a failure */
  release: () => Promise<void>
}

const failure = (what: string, { status, data }: Answer) =>
  new Error(`${what} failed (${status} ${data.code ?? ''}): ${data.error ?? ''}`)

/**
 * Signs in and makes the account able to act as an admin:
 * - two-step sign-in off: turns it on for this run; `release` turns it off with a recovery code, so
 *   no secret outlives the run and a person can still sign in with the password alone
 * - on, with `totpSecret`: signs in with a code and leaves it on (it is someone's own setting)
 * - on, without one: null, the caller cannot act as an admin
 */
export async function adminAccess(
  post: AdminPost,
  { username, password, totpSecret }: { username: string; password: string; totpSecret?: string },
): Promise<AdminAccess | null> {
  const login = await post('/api/login', { username, password })
  if (login.data.code === 'twoFactorNeeded') {
    if (!totpSecret) return null
    const step = totpStep(Date.now())
    let signedIn = await post('/api/login', { username, password, code: await totpCode(totpSecret, step) })
    // A step signs in only once (someone may just have used it); the next one counts too
    if (signedIn.data.code === 'twoFactorWrong')
      signedIn = await post('/api/login', { username, password, code: await totpCode(totpSecret, step + 1) })
    if (signedIn.status !== 200 || !signedIn.data.user) throw failure(`Signing in as ${username} with a code`, signedIn)
    return { userId: signedIn.data.user.id, turnedOn: false, release: async () => {} }
  }
  if (login.status !== 200 || !login.data.user) throw failure(`Signing in as ${username}`, login)

  const setup = await post('/api/account/2fa/setup', { password })
  if (setup.status !== 200 || !setup.data.secret || !setup.data.expiresAt) throw failure(`Starting two-step sign-in for ${username}`, setup)
  // The server's own clock, so a wrong clock here does not matter
  const now = setup.data.expiresAt - TOTP_SETUP_MS
  const enabled = await post('/api/account/2fa/enable', { code: await totpCode(setup.data.secret, totpStep(now)) })
  const recovery = enabled.data.recoveryCodes?.[0]
  if (enabled.status !== 200 || !recovery) throw failure(`Turning two-step sign-in on for ${username}`, enabled)

  return {
    userId: login.data.user.id,
    turnedOn: true,
    release: async () => {
      const off = await post('/api/account/2fa/disable', { password, code: recovery })
      if (off.status !== 200) throw failure(`Turning two-step sign-in off for ${username} (it stays on, and this run's secret is gone)`, off)
    },
  }
}
