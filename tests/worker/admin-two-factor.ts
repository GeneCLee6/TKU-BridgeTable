/**
 * Admins act as admins only once two-step sign-in is on (社長 2026-11-02, ARCHITECTURE.md §5.2).
 * Tests whose admin does admin things turn it on here through the real setup, as the account page
 * does, instead of switching the rule off: enforcement stays on in every test.
 */
import type { ClubService } from '../../worker/service.ts'
import { TOTP_SETUP_MS, totpCode, totpStep } from '../../worker/totp.ts'

/**
 * Turns two-step sign-in on for an admin (the password is the tests' usual one). Like the account
 * page, it signs the admin out on every other session; `token` is the one to keep
 */
export async function adminWithTwoFactor(club: ClubService, userId: string, password = 'club-secret-1', token: string | null = null) {
  const setup = await club.startTwoFactor(userId, password)
  const now = setup.expiresAt - TOTP_SETUP_MS
  const { recoveryCodes } = await club.enableTwoFactor(userId, await totpCode(setup.secret, totpStep(now)), token)
  return { secret: setup.secret, recoveryCodes }
}
