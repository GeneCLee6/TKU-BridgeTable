// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { EMAIL_RESET_MS, EMAIL_VERIFY_MS, hashEmailToken, isEmail, mailerFrom, resendMailer, type MailMessage } from '../../worker/mail.ts'
import { ClubService, type Connections } from '../../worker/service.ts'
import type { MemoryStore } from '../../worker/store.ts'
import { memoryStore } from './sqlite.ts'

const ORIGIN = 'https://table.example'
let store: MemoryStore
let club: ClubService
let time: number
let sent: MailMessage[]
let failing: boolean
let disconnected: string[]

const connections: Connections = {
  onlineUserIds: () => [],
  send: () => undefined,
  disconnect: (id) => void disconnected.push(id),
}

async function open(mail = true) {
  store = memoryStore()
  club = new ClubService(store, connections, {
    maxUsers: 20,
    inviteCode: 'tku',
    now: () => time,
    schedule: () => undefined,
    mailer: mail
      ? {
          send: async (message) => {
            if (failing) throw new Error('refused')
            sent.push(message)
          },
        }
      : undefined,
  })
  await club.load()
  await club.register('admin', 'club-secret-1', 'tku')
}

beforeEach(async () => {
  time = 1_000_000
  sent = []
  failing = false
  disconnected = []
  await open()
})

async function member(name: string) {
  await club.register(name, 'club-secret-1', 'tku')
  return (await club.adminApprove(club.adminApplications().find((a) => a.username === name)!.id)).id
}

/** The secret in the last mail's link */
const lastToken = () => sent[sent.length - 1].text.match(/#([\w-]+)/)![1]

async function verified(name: string, address: string) {
  const id = await member(name)
  await club.setEmail(id, address, 'club-secret-1', ORIGIN, 'en')
  await club.verifyEmail(lastToken())
  return id
}

describe('binding an email (e1-t29)', () => {
  it('sends a one-time link and keeps only its hash; the address counts once the link is opened', async () => {
    const amy = await member('amy')
    await expect(club.setEmail(amy, 'amy@example.org', 'wrong-password', ORIGIN)).rejects.toThrow('密碼不正確')
    await expect(club.setEmail(amy, 'not-an-email', 'club-secret-1', ORIGIN)).rejects.toThrow('Email 格式不正確')
    const me = await club.setEmail(amy, ' Amy@Example.org ', 'club-secret-1', ORIGIN, 'en')
    expect(me.email).toEqual({ address: null, verifiedAt: null, pending: 'amy@example.org' })
    expect(sent).toHaveLength(1)
    expect(sent[0].to).toBe('amy@example.org')
    expect(sent[0].subject).toBe('TKU BridgeTable: verify your email')
    expect(sent[0].text).toContain(`${ORIGIN}/email/verify#`)
    const token = lastToken()
    const stored = JSON.stringify(await store.get(`user:${amy}`))
    expect(stored).not.toContain(token)
    expect(stored).toContain(await hashEmailToken(token))

    expect(await club.verifyEmail(token)).toEqual({ username: 'amy', address: 'amy@example.org' })
    const after = (await club.login('amy', 'club-secret-1')).user
    expect(after.email).toEqual({ address: 'amy@example.org', verifiedAt: time, pending: null })
    // Once only
    await expect(club.verifyEmail(token)).rejects.toThrow('連結不正確')
    await expect(club.verifyEmail('made-up')).rejects.toThrow('連結不正確')
  })

  it('lets a link expire, resends a fresh one and limits how many go out', async () => {
    const amy = await member('amy')
    await club.setEmail(amy, 'amy@example.org', 'club-secret-1', ORIGIN)
    const first = lastToken()
    time += EMAIL_VERIFY_MS
    await expect(club.verifyEmail(first)).rejects.toThrow('連結不正確')
    await club.resendEmailVerification(amy, ORIGIN)
    // The new link replaces the old one
    expect(lastToken()).not.toBe(first)
    // Three at once (a day refilled the account's allowance), then one every ten minutes
    await club.resendEmailVerification(amy, ORIGIN)
    await club.resendEmailVerification(amy, ORIGIN)
    await expect(club.resendEmailVerification(amy, ORIGIN)).rejects.toThrow('太快')
    await club.verifyEmail(lastToken())
    await expect(club.resendEmailVerification(amy, ORIGIN)).rejects.toThrow('沒有等待驗證')
  })

  it('refuses an address another account verified, and removes an address with the password', async () => {
    await verified('amy', 'shared@example.org')
    const bob = await member('bob')
    await club.setEmail(bob, 'shared@example.org', 'club-secret-1', ORIGIN)
    await expect(club.verifyEmail(lastToken())).rejects.toThrow('另一個帳號')
    expect((await club.login('bob', 'club-secret-1')).user.email).toEqual({ address: null, verifiedAt: null, pending: null })

    const amy = (await club.login('amy', 'club-secret-1')).user.id
    await expect(club.setEmail(amy, 'shared@example.org', 'club-secret-1', ORIGIN)).rejects.toThrow('已經驗證過')
    expect((await club.setEmail(amy, '', 'club-secret-1', ORIGIN)).email).toEqual({ address: null, verifiedAt: null, pending: null })
  })

  it('keeps nothing when the mail does not go out', async () => {
    const amy = await member('amy')
    failing = true
    await expect(club.setEmail(amy, 'amy@example.org', 'club-secret-1', ORIGIN)).rejects.toThrow('寄不出去')
    expect((await club.login('amy', 'club-secret-1')).user.email!.pending).toBeNull()
  })

  it('goes in the data export without any link, and goes with the account', async () => {
    const amy = await verified('amy', 'amy@example.org')
    await club.setEmail(amy, 'new@example.org', 'club-secret-1', ORIGIN)
    await club.requestEmailReset('amy', ORIGIN)
    const data = await club.exportAccount(amy, null)
    expect(data.account).toMatchObject({ email: 'amy@example.org', emailPending: 'new@example.org' })
    const text = JSON.stringify(data)
    expect(text).not.toContain('tokenHash')
    expect(text).not.toContain('emailReset')
    await club.deleteOwnAccount(amy, 'club-secret-1')
    expect(await store.get(`user:${amy}`)).toBeUndefined()
  })
})

describe('忘記密碼 by email (e1-t30)', () => {
  it('mails a one-time link to the verified address that sets a new password and signs out everywhere', async () => {
    const amy = await verified('amy', 'amy@example.org')
    const { token: session } = await club.login('amy', 'club-secret-1')
    sent = []
    await club.requestEmailReset('AMY', ORIGIN, 'zh')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ to: 'amy@example.org', subject: '淡江牌桌：重設密碼' })
    expect(sent[0].text).toContain(`${ORIGIN}/email/reset#`)
    const token = lastToken()
    expect(JSON.stringify(await store.get(`user:${amy}`))).not.toContain(token)

    // The password rules hold, and a refused password keeps the link
    await expect(club.resetPasswordByEmail(token, 'short')).rejects.toThrow()
    expect(await club.resetPasswordByEmail(token, 'brand-new-passphrase')).toEqual({ username: 'amy' })
    expect(await club.userForToken(session)).toBeNull()
    expect(disconnected).toContain(amy)
    await club.login('amy', 'brand-new-passphrase')
    // Once only
    await expect(club.resetPasswordByEmail(token, 'another-passphrase-2')).rejects.toThrow('連結不正確')
  })

  it('finds the account by its verified address too, and the link expires', async () => {
    await verified('amy', 'amy@example.org')
    sent = []
    await club.requestEmailReset(' AMY@example.org ', ORIGIN)
    expect(sent).toHaveLength(1)
    time += EMAIL_RESET_MS
    await expect(club.resetPasswordByEmail(lastToken(), 'brand-new-passphrase')).rejects.toThrow('連結不正確')
  })

  it('answers the same whether or not the account or the address exists', async () => {
    await member('nomail')
    const bob = await member('bob')
    // An address waiting for its link is not good enough
    await club.setEmail(bob, 'bob@example.org', 'club-secret-1', ORIGIN)
    sent = []
    for (const account of ['nomail', 'nobody', 'nobody@example.org', 'bob@example.org', 'bob', '']) {
      await expect(club.requestEmailReset(account, ORIGIN, 'zh', `10.0.0.${account.length}`)).resolves.toBeUndefined()
    }
    expect(sent).toEqual([])
    // A mail that does not go out is not told either
    await verified('amy', 'amy@example.org')
    failing = true
    await expect(club.requestEmailReset('amy', ORIGIN, 'zh', '10.0.1.1')).resolves.toBeUndefined()
  })

  it('limits requests per network address, mail per account and wrong links', async () => {
    await verified('amy', 'amy@example.org')
    sent = []
    for (let i = 0; i < 5; i++) await club.requestEmailReset('amy', ORIGIN, 'zh', '10.0.0.1')
    await expect(club.requestEmailReset('amy', ORIGIN, 'zh', '10.0.0.1')).rejects.toThrow('太快')
    // The verification mail used one of the account's three
    expect(sent).toHaveLength(2)
    for (let i = 0; i < 20; i++) await expect(club.resetPasswordByEmail(`guess-${i}`, 'brand-new-passphrase', '10.0.0.2')).rejects.toThrow('連結不正確')
    await expect(club.resetPasswordByEmail(lastToken(), 'brand-new-passphrase', '10.0.0.2')).rejects.toMatchObject({ code: 'tooManyLogins' })
  })

  it('stops working once the password changes or the address goes; the admins’ reset stays', async () => {
    const amy = await verified('amy', 'amy@example.org')
    await club.requestEmailReset('amy', ORIGIN)
    const token = lastToken()
    await club.changePassword(amy, 'club-secret-1', 'changed-passphrase-1')
    await expect(club.resetPasswordByEmail(token, 'brand-new-passphrase')).rejects.toThrow('連結不正確')

    await club.requestEmailReset('amy', ORIGIN, 'zh', '10.0.0.9')
    await club.setEmail(amy, '', 'changed-passphrase-1', ORIGIN)
    await expect(club.resetPasswordByEmail(lastToken(), 'brand-new-passphrase')).rejects.toThrow('連結不正確')
    // e1-t36 still works for everyone
    await expect(club.requestPasswordReset('amy', 'tku')).resolves.toBeUndefined()
  })
})

describe('without a mail provider', () => {
  it('is off: no email on Me, and every email call answers emailOff', async () => {
    await open(false)
    const amy = await member('amy')
    expect(club.emailStatus()).toEqual({ enabled: false })
    expect((await club.login('amy', 'club-secret-1')).user.email).toBeUndefined()
    await expect(club.setEmail(amy, 'amy@example.org', 'club-secret-1', ORIGIN)).rejects.toMatchObject({ code: 'emailOff', status: 503 })
    await expect(club.requestEmailReset('amy', ORIGIN)).rejects.toMatchObject({ code: 'emailOff' })
    await expect(club.verifyEmail('x')).rejects.toMatchObject({ code: 'emailOff' })
    await expect(club.resetPasswordByEmail('x', 'brand-new-passphrase')).rejects.toMatchObject({ code: 'emailOff' })
  })

  it('needs both the key and the sender', () => {
    expect(mailerFrom({})).toBeUndefined()
    expect(mailerFrom({ RESEND_API_KEY: 'k' })).toBeUndefined()
    expect(mailerFrom({ RESEND_API_KEY: 'k', MAIL_FROM: 'a@b.org' })).toBeDefined()
  })
})

describe('Resend', () => {
  it('posts one plain-text message with the key, and throws when refused', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    let status = 200
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response('{}', { status })
    }) as unknown as typeof fetch
    const mailer = resendMailer('re_key', 'TKU <no-reply@example.org>', fake)
    await mailer.send({ to: 'amy@example.org', subject: 's', text: 't' })
    expect(calls[0].url).toBe('https://api.resend.com/emails')
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer re_key')
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ from: 'TKU <no-reply@example.org>', to: ['amy@example.org'], subject: 's', text: 't' })
    status = 422
    await expect(mailer.send({ to: 'amy@example.org', subject: 's', text: 't' })).rejects.toThrow('422')
  })

  it('checks the shape of an address', () => {
    expect(isEmail('amy@example.org')).toBe(true)
    expect(isEmail('amy@localhost')).toBe(false)
    expect(isEmail('a b@example.org')).toBe(false)
    expect(isEmail('<a>@example.org')).toBe(false)
    expect(isEmail(`${'a'.repeat(250)}@example.org`)).toBe(false)
  })
})
