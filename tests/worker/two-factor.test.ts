// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import type { MailMessage } from '../../worker/mail.ts'
import { ClubService, type Connections } from '../../worker/service.ts'
import type { MemoryStore } from '../../worker/store.ts'
import {
  base32Decode,
  base32Encode,
  otpauthUri,
  RECOVERY_CODES,
  TOTP_SETUP_MS,
  totpCode,
  totpStep,
  verifyTotp,
} from '../../worker/totp.ts'
import { memoryStore } from './sqlite.ts'

const PASSWORD = 'club-secret-1'
const ORIGIN = 'https://table.example'
let store: MemoryStore
let club: ClubService
let time: number
let sent: MailMessage[]
let disconnected: string[]
let adminId: string

const connections: Connections = {
  onlineUserIds: () => [],
  send: () => undefined,
  disconnect: (id) => void disconnected.push(id),
}

beforeEach(async () => {
  time = 1_700_000_000_000
  sent = []
  disconnected = []
  store = memoryStore()
  club = new ClubService(store, connections, {
    maxUsers: 20,
    inviteCode: 'tku',
    now: () => time,
    schedule: () => undefined,
    mailer: { send: async (message) => void sent.push(message) },
  })
  await club.load()
  const founder = await club.register('admin', PASSWORD, 'tku')
  if (!('user' in founder)) throw new Error('the first account is the admin')
  adminId = founder.user.id
})

async function member(name: string) {
  await club.register(name, PASSWORD, 'tku')
  return (await club.adminApprove(club.adminApplications().find((a) => a.username === name)!.id)).id
}

/** The code the app shows now, or `steps` periods from now */
const codeNow = (secret: string, steps = 0) => totpCode(secret, totpStep(time) + steps)

/** Turns the second step on for an admin; the secret and the recovery codes */
async function turnOn(userId = adminId) {
  const { secret } = await club.startTwoFactor(userId, PASSWORD)
  const { recoveryCodes } = await club.enableTwoFactor(userId, await codeNow(secret), null)
  time += 30_000
  return { secret, recoveryCodes }
}

describe('TOTP (RFC 6238)', () => {
  it('matches the RFC test vectors (SHA-1, 6 digits of the 8-digit values)', async () => {
    const secret = base32Encode(new TextEncoder().encode('12345678901234567890'))
    expect(secret).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
    expect(await totpCode(secret, totpStep(59_000))).toBe('287082')
    expect(await totpCode(secret, totpStep(1_111_111_109_000))).toBe('081804')
    expect(await totpCode(secret, totpStep(1_234_567_890_000))).toBe('005924')
    expect(await totpCode(secret, totpStep(20_000_000_000_000))).toBe('353130')
  })

  it('reads base32 back, accepts a step either side, and never the same step twice', async () => {
    expect(base32Decode('gezd gnbv')).toEqual(base32Decode('GEZDGNBV'))
    expect(base32Decode('GEZ1')).toBeNull()
    const secret = 'JBSWY3DPEHPK3PXP'
    const now = 1_700_000_000_000
    const step = totpStep(now)
    expect(await verifyTotp(secret, await totpCode(secret, step - 1), now)).toBe(step - 1)
    expect(await verifyTotp(secret, await totpCode(secret, step + 1), now)).toBe(step + 1)
    expect(await verifyTotp(secret, await totpCode(secret, step - 2), now)).toBeNull()
    expect(await verifyTotp(secret, await totpCode(secret, step), now, step)).toBeNull()
    expect(await verifyTotp(secret, '12345', now)).toBeNull()
  })

  it('builds the address authenticator apps read', () => {
    expect(otpauthUri('JBSWY3DPEHPK3PXP', 'amy')).toBe(
      'otpauth://totp/TKU%20BridgeTable%3Aamy?secret=JBSWY3DPEHPK3PXP&issuer=TKU%20BridgeTable&algorithm=SHA1&digits=6&period=30',
    )
  })
})

describe('turning 兩步驟登入 on (e11-t31)', () => {
  it('is for admins, takes the password, and counts only after the first code', async () => {
    const amy = await member('amy')
    await expect(club.startTwoFactor(amy, PASSWORD)).rejects.toMatchObject({ code: 'adminOnly' })
    expect((await club.userForToken((await club.login('amy', PASSWORD)).token))?.twoFactor).toBeUndefined()
    await expect(club.startTwoFactor(adminId, 'wrong-password')).rejects.toMatchObject({ code: 'wrongPassword' })
    const setup = await club.startTwoFactor(adminId, PASSWORD)
    expect(setup.secret).toMatch(/^[A-Z2-7]{32}$/)
    expect(setup.uri).toContain(`secret=${setup.secret}`)
    // Not on yet: the password alone still signs in
    expect((await club.login('admin', PASSWORD)).user.twoFactor).toEqual({ enabled: false, recoveryLeft: 0 })
    await expect(club.enableTwoFactor(adminId, '000000', null)).rejects.toMatchObject({ code: 'twoFactorWrong' })
    const { user, recoveryCodes } = await club.enableTwoFactor(adminId, await codeNow(setup.secret), null)
    expect(user.twoFactor).toEqual({ enabled: true, recoveryLeft: RECOVERY_CODES })
    expect(recoveryCodes).toHaveLength(RECOVERY_CODES)
    expect(new Set(recoveryCodes).size).toBe(RECOVERY_CODES)
    // Only hashes of the recovery codes are kept
    const stored = JSON.stringify(await store.get(`user:${adminId}`))
    for (const code of recoveryCodes) expect(stored).not.toContain(code)
    await expect(club.startTwoFactor(adminId, PASSWORD)).rejects.toMatchObject({ code: 'twoFactorOn' })
  })

  it('lets the secret wait only TOTP_SETUP_MS', async () => {
    const { secret } = await club.startTwoFactor(adminId, PASSWORD)
    time += TOTP_SETUP_MS
    await expect(club.enableTwoFactor(adminId, await codeNow(secret), null)).rejects.toMatchObject({ code: 'twoFactorSetupGone' })
  })

  it('signs every other device out', async () => {
    const other = (await club.login('admin', PASSWORD)).token
    const here = (await club.login('admin', PASSWORD)).token
    const { secret } = await club.startTwoFactor(adminId, PASSWORD)
    await club.enableTwoFactor(adminId, await codeNow(secret), here)
    expect(await club.userForToken(other)).toBeNull()
    expect(await club.userForToken(here)).not.toBeNull()
    expect(disconnected).toContain(adminId)
  })
})

describe('signing in with 兩步驟登入', () => {
  it('asks for a code only after the right password, and takes each code once', async () => {
    const { secret } = await turnOn()
    await expect(club.login('admin', 'wrong-password', '1.1.1.1')).rejects.toMatchObject({ code: 'badLogin' })
    await expect(club.login('admin', PASSWORD, '1.1.1.1')).rejects.toMatchObject({ code: 'twoFactorNeeded', status: 401 })
    await expect(club.login('admin', PASSWORD, '1.1.1.1', '', '123456')).rejects.toMatchObject({ code: 'twoFactorWrong' })
    const code = await codeNow(secret)
    const { user, token } = await club.login('admin', PASSWORD, '1.1.1.1', '', code)
    expect(user.username).toBe('admin')
    expect(await club.userForToken(token)).not.toBeNull()
    // The same code again is refused, even inside its 30 seconds
    await expect(club.login('admin', PASSWORD, '1.1.1.1', '', code)).rejects.toMatchObject({ code: 'twoFactorWrong' })
    time += 30_000
    await club.login('admin', PASSWORD, '1.1.1.1', '', ` ${(await codeNow(secret)).slice(0, 3)} ${(await codeNow(secret)).slice(3)} `)
  })

  it('takes each recovery code once and tells the verified email', async () => {
    const { recoveryCodes } = await turnOn()
    await club.setEmail(adminId, 'admin@example.org', PASSWORD, ORIGIN, 'en')
    await club.verifyEmail(sent[sent.length - 1].text.match(/#([\w-]+)/)![1])
    sent = []
    const { user } = await club.login('admin', PASSWORD, '', '', recoveryCodes[0].toLowerCase(), 'en')
    expect(user.twoFactor).toEqual({ enabled: true, recoveryLeft: RECOVERY_CODES - 1 })
    expect(sent).toHaveLength(1)
    expect(sent[0].subject).toBe('TKU BridgeTable: account security notice')
    expect(sent[0].text).toContain(`${RECOVERY_CODES - 1} are left`)
    await expect(club.login('admin', PASSWORD, '', '', recoveryCodes[0])).rejects.toMatchObject({ code: 'twoFactorWrong' })
  })

  it('locks the account after 5 wrong codes from anywhere, and mails a warning', async () => {
    const { secret } = await turnOn()
    await club.setEmail(adminId, 'admin@example.org', PASSWORD, ORIGIN)
    await club.verifyEmail(sent[sent.length - 1].text.match(/#([\w-]+)/)![1])
    sent = []
    for (let i = 0; i < 5; i++)
      await expect(club.login('admin', PASSWORD, `10.0.0.${i}`, '', '000000')).rejects.toMatchObject({ code: 'twoFactorWrong' })
    expect(sent).toHaveLength(1)
    expect(sent[0].text).toContain('知道你的密碼')
    await expect(club.login('admin', PASSWORD, '10.0.0.9', '', await codeNow(secret))).rejects.toMatchObject({ code: 'tooManyLogins' })
    time += 15 * 60_000
    await club.login('admin', PASSWORD, '10.0.0.9', '', await codeNow(secret))
  })

  it('leaves members without it as before', async () => {
    await turnOn()
    await member('amy')
    const { user } = await club.login('amy', PASSWORD)
    expect(user.twoFactor).toBeUndefined()
  })

  it('still needs the code after a password reset by email', async () => {
    const { secret } = await turnOn()
    await club.setEmail(adminId, 'admin@example.org', PASSWORD, ORIGIN)
    await club.verifyEmail(sent[sent.length - 1].text.match(/#([\w-]+)/)![1])
    await club.requestEmailReset('admin', ORIGIN)
    await club.resetPasswordByEmail(sent[sent.length - 1].text.match(/#([\w-]+)/)![1], 'a-brand-new-secret')
    await expect(club.login('admin', 'a-brand-new-secret')).rejects.toMatchObject({ code: 'twoFactorNeeded' })
    await club.login('admin', 'a-brand-new-secret', '', '', await codeNow(secret))
  })
})

describe('managing 兩步驟登入', () => {
  it('makes new recovery codes with the password and a code; the old ones stop working', async () => {
    const { secret, recoveryCodes } = await turnOn()
    await expect(club.renewRecoveryCodes(adminId, 'wrong-password', await codeNow(secret))).rejects.toMatchObject({ code: 'wrongPassword' })
    await expect(club.renewRecoveryCodes(adminId, PASSWORD, '000000')).rejects.toMatchObject({ code: 'twoFactorWrong' })
    const renewed = await club.renewRecoveryCodes(adminId, PASSWORD, await codeNow(secret))
    expect(renewed.recoveryCodes).toHaveLength(RECOVERY_CODES)
    await expect(club.login('admin', PASSWORD, '', '', recoveryCodes[1])).rejects.toMatchObject({ code: 'twoFactorWrong' })
    await club.login('admin', PASSWORD, '', '', renewed.recoveryCodes[1])
  })

  it('turns off with the password and a code (or a recovery code)', async () => {
    const { recoveryCodes } = await turnOn()
    await expect(club.disableTwoFactor(adminId, PASSWORD, 'AAAAA-AAAAA')).rejects.toMatchObject({ code: 'twoFactorWrong' })
    const me = await club.disableTwoFactor(adminId, PASSWORD, recoveryCodes[2])
    expect(me.twoFactor).toEqual({ enabled: false, recoveryLeft: 0 })
    await club.login('admin', PASSWORD)
    await expect(club.disableTwoFactor(adminId, PASSWORD, '000000')).rejects.toMatchObject({ code: 'twoFactorOff' })
  })

  it('limits wrong codes on "My account" too', async () => {
    const { secret } = await turnOn()
    for (let i = 0; i < 5; i++) await expect(club.disableTwoFactor(adminId, PASSWORD, '000000')).rejects.toMatchObject({ code: 'twoFactorWrong' })
    await expect(club.disableTwoFactor(adminId, PASSWORD, await codeNow(secret))).rejects.toMatchObject({ code: 'tooManyLogins' })
  })

  it('lets another admin turn it off for someone who lost the phone, not for themselves', async () => {
    const bob = await member('bob')
    await club.adminSetAdmin(adminId, bob, true)
    await turnOn(bob)
    expect((await club.adminUsers()).find((u) => u.id === bob)?.twoFactor).toBe(true)
    await expect(club.login('bob', PASSWORD)).rejects.toMatchObject({ code: 'twoFactorNeeded' })
    await expect(club.adminClearTwoFactor(bob, bob)).rejects.toMatchObject({ code: 'notSelf' })
    await club.adminClearTwoFactor(adminId, bob)
    expect((await club.adminUsers()).find((u) => u.id === bob)?.twoFactor).toBe(false)
    await club.login('bob', PASSWORD)
    await expect(club.adminClearTwoFactor(adminId, bob)).rejects.toMatchObject({ code: 'twoFactorOff' })
  })

  it('keeps the secret and the recovery hashes out of the download', async () => {
    const { secret } = await turnOn()
    const data = await club.exportAccount(adminId, null)
    const text = JSON.stringify(data)
    expect(text).not.toContain(secret)
    expect(text).not.toContain('recovery')
    expect(data.account).toMatchObject({ twoFactorEnabledAt: expect.any(Number) })
  })
})
