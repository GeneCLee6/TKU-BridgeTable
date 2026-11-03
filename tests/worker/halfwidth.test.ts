// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { toFullWidth } from '../../shared/halfwidth.ts'
import { ITERATIONS, matchPassword, verifyPassword } from '../../worker/auth.ts'
import { ClubService, type Connections } from '../../worker/service.ts'
import type { MemoryStore } from '../../worker/store.ts'
import { totpCode, totpStep, verifyTotp } from '../../worker/totp.ts'
import { memoryStore } from './sqlite.ts'

/**
 * Full-width ASCII in sign-in names, passwords and codes (社長 2026-11-03, shared/halfwidth.ts):
 * the server reads them half-width, and a password saved full-width before still signs in
 */

let store: MemoryStore
let club: ClubService

const connections: Connections = { onlineUserIds: () => [], send: () => undefined, disconnect: () => undefined }
const service = async () => {
  const next = new ClubService(store, connections, { maxUsers: 20, inviteCode: 'tku', now: () => 1_000_000, schedule: () => undefined })
  await next.load()
  return next
}

beforeEach(async () => {
  store = memoryStore()
  club = await service()
  await club.register('admin', 'club-secret-1', 'tku')
})

async function member(name: string, password = 'club-secret-1') {
  await club.register(name, password, 'tku')
  return (await club.adminApprove(club.adminApplications().find((a) => a.username === name)!.id)).id
}

/** A PBKDF2 hash of the text exactly as given, the way passwords were saved before 2026-11-03 */
async function hashAsTyped(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, key, 256))
  const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
  return `pbkdf2$${ITERATIONS}$${b64(salt)}$${b64(bits)}`
}

/** Saves the member's password hash (or name) as an older version would have, and starts the club again */
async function legacy(userId: string, change: { passwordHash?: string; username?: string }) {
  const user = (await store.get<Record<string, unknown>>(`user:${userId}`))!
  await store.put(`user:${userId}`, { ...user, ...change })
  club = await service()
}

describe('full-width sign-in details', () => {
  it('registers and signs in with a full-width name, password and invite code as the half-width ones', async () => {
    await club.register('ａｍｙ', toFullWidth('club-secret-2'), 'ｔｋｕ')
    expect(club.adminApplications().map((a) => a.username)).toContain('amy')
    await club.adminApprove(club.adminApplications().find((a) => a.username === 'amy')!.id)
    await expect(club.login('amy', 'club-secret-2')).resolves.toMatchObject({ user: { username: 'amy' } })
    await expect(club.login('ＡＭＹ', 'ｃｌｕｂ－ｓｅｃｒｅｔ－２')).resolves.toMatchObject({ user: { username: 'amy' } })
    // A name that only differs in width is taken
    await expect(club.register('ＡＭＹ', 'club-secret-3', 'tku')).rejects.toThrow()
  })

  it('checks the current password half-width on every re-check, and sets new ones half-width', async () => {
    const amy = await member('amy')
    await club.changePassword(amy, toFullWidth('club-secret-1'), toFullWidth('new-passphrase-1'))
    await expect(club.login('amy', 'new-passphrase-1')).resolves.toBeTruthy()
    await expect(club.deleteOwnAccount(amy, 'wrong-password-1')).rejects.toThrow()
    await club.deleteOwnAccount(amy, toFullWidth('new-passphrase-1'))
    await expect(club.login('amy', 'new-passphrase-1')).rejects.toThrow()
  })

  it('takes a full-width reset code and invite code', async () => {
    const amy = await member('amy')
    const adminId = (await club.login('admin', 'club-secret-1')).user.id
    await club.requestPasswordReset('ＡＭＹ', 'ｔｋｕ')
    const { code } = (await club.adminAnswerPasswordReset(adminId, amy, true))!
    await club.resetForgottenPassword('amy', toFullWidth(code.toLowerCase()), toFullWidth('new-passphrase-1'))
    await expect(club.login('amy', 'new-passphrase-1')).resolves.toBeTruthy()
  })

  it('reads an app code typed full-width', async () => {
    const secret = 'JBSWY3DPEHPK3PXP'
    const now = 1_700_000_000_000
    const code = await totpCode(secret, totpStep(now))
    await expect(verifyTotp(secret, toFullWidth(code), now)).resolves.toBe(totpStep(now))
  })

  it('still signs in a member whose password was saved full-width, typed either way, and rehashes it', async () => {
    const amy = await member('amy')
    const typed = toFullWidth('club-secret-9')
    await legacy(amy, { passwordHash: await hashAsTyped(typed) })
    // As an older page or another client sends it
    await expect(club.login('amy', typed)).resolves.toBeTruthy()
    // The hash is now of the half-width form
    const after = (await store.get<{ passwordHash: string }>(`user:${amy}`))!.passwordHash
    await expect(verifyPassword('club-secret-9', after)).resolves.toBe(true)

    // As today's sign-in page sends it: converted to half-width while typing
    const bob = await member('bob')
    await legacy(bob, { passwordHash: await hashAsTyped(typed) })
    await expect(club.login('bob', 'club-secret-9')).resolves.toBeTruthy()
    await expect(club.login('bob', typed)).resolves.toBeTruthy()
    await expect(club.login('bob', 'club-secret-8')).rejects.toThrow()
  })

  it('accepts a saved full-width password on the re-checks too', async () => {
    const amy = await member('amy')
    await legacy(amy, { passwordHash: await hashAsTyped(toFullWidth('club-secret-9')) })
    await club.changePassword(amy, 'club-secret-9', 'new-passphrase-1')
    await expect(club.login('amy', 'new-passphrase-1')).resolves.toBeTruthy()
  })

  it('tells a match on the half-width form from a legacy one', async () => {
    const hash = await hashAsTyped(toFullWidth('abc12345'))
    await expect(matchPassword('abc12345', hash)).resolves.toBe('legacy')
    await expect(matchPassword(toFullWidth('abc12345'), hash)).resolves.toBe('legacy')
    await expect(matchPassword('abc12346', hash)).resolves.toBe(null)
    await expect(matchPassword(toFullWidth('abc12345'), await hashAsTyped('abc12345'))).resolves.toBe('normalized')
  })

  it('still finds an older account whose name has full-width letters, either way', async () => {
    const amy = await member('amy')
    await legacy(amy, { username: 'ＡＭＩ' })
    await expect(club.login('ami', 'club-secret-1')).resolves.toMatchObject({ user: { username: 'ＡＭＩ' } })
    await expect(club.login('ＡＭＩ', 'club-secret-1')).resolves.toMatchObject({ user: { username: 'ＡＭＩ' } })
  })
})
