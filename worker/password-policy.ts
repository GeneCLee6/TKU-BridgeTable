/**
 * The rules for a new password (e11-t29, docs/SECURITY.md V2.1): at least `LIMITS.passwordMin`
 * (12) characters, at most `LIMITS.passwordMax`, not the username or containing it, and not a
 * known breached password. Only passwords being set are checked (registering, changing it, a
 * reset); signing in with an older, shorter password still works. No outside service is asked:
 * the list ships with the Worker and a lookup is one `Set.has`.
 */
import { LIMITS } from '../shared/protocol.ts'
import { ClubError } from './errors.ts'
import { COMMON_PASSWORDS } from './common-passwords.ts'

/** Names this short are left out of the "contains the username" check, or too much would match */
const USERNAME_IN_PASSWORD_MIN = 3

/** Words anyone would guess for this club's site, on top of the breached list */
const CLUB_WORDS = ['overtrick123', 'overtrick1234', 'overtrickbridge', 'tkubridgetable', 'tkubridgebook', 'tamkangbridge', 'tamkanguniversity', 'bridgetable', 'bridgebook']

let common: Set<string> | undefined

export function isCommonPassword(password: string): boolean {
  common ??= new Set([...COMMON_PASSWORDS.split('\n'), ...CLUB_WORDS])
  const lower = password.toLowerCase()
  // One character over and over (aaaaaaaaaaaa) is as weak as anything on the list
  return common.has(lower) || new Set(lower).size === 1
}

/** Throws the `ClubError` a form shows, or returns when the password may be used */
export function checkNewPassword(password: string, username: string): void {
  if (password.length < LIMITS.passwordMin) throw new ClubError('shortPassword', { min: LIMITS.passwordMin })
  if (password.length > LIMITS.passwordMax) throw new ClubError('longPassword', { max: LIMITS.passwordMax })
  const name = username.trim().toLowerCase()
  const lower = password.toLowerCase()
  if (name && (lower === name || (name.length >= USERNAME_IN_PASSWORD_MIN && lower.includes(name))))
    throw new ClubError('passwordHasUsername')
  if (isCommonPassword(password)) throw new ClubError('commonPassword')
}
