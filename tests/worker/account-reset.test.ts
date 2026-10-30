// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { hashPassword, hashResetCode, ITERATIONS, needsRehash, RESET_CODE_MS, resetCode, verifyPassword } from '../../worker/auth.ts'
import { readBytes, readForm, readJson, readText } from '../../worker/body.ts'
import { passRevoked } from '../../worker/edge-auth.ts'
import { ClubError, ClubService, type Connections } from '../../worker/service.ts'
import type { MemoryStore } from '../../worker/store.ts'
import { memoryD1, type MemoryD1 } from './d1.ts'
import { memoryStore } from './sqlite.ts'

let store: MemoryStore
let d1: MemoryD1
let club: ClubService
let time: number
let disconnected: string[]
let adminId: string

const connections: Connections = {
  onlineUserIds: () => [],
  send: () => undefined,
  disconnect: (id) => void disconnected.push(id),
}

beforeEach(async () => {
  store = memoryStore()
  d1 = memoryD1()
  time = 1_000_000
  disconnected = []
  club = new ClubService(store, connections, {
    maxUsers: 20,
    inviteCode: 'tku',
    now: () => time,
    schedule: () => undefined,
    // The D1 binding: the history copy and the list of ended sessions (e11-t28)
    historyReplica: d1,
  })
  await club.load()
  const founder = await club.register('admin', 'secret1', 'tku')
  if (!('user' in founder)) throw new Error('the first account should sign in at once')
  adminId = founder.user.id
})

async function member(name: string) {
  await club.register(name, 'secret1', 'tku')
  return (await club.adminApprove(club.adminApplications().find((a) => a.username === name)!.id)).id
}

/** The ids of the member's sessions, as edge passes name them */
const sessionIds = async (tokens: string[]) => Promise.all(tokens.map(async (t) => (await club.passIdentity(t))!.sessionId))
const revoked = (id: string) => passRevoked(d1, id, time)
const notices = async (userId: string) => (await club.notifications.view(userId)).items
const resetOf = async (userId: string) => (await club.adminUsers()).find((u) => u.id === userId)!.passwordReset

describe('忘記密碼 with an admin’s approval (e1-t36)', () => {
  it('asks the admins, who hand over a one-time code that sets the new password and signs the member out everywhere', async () => {
    const amy = await member('amy')
    const { token } = await club.login('amy', 'secret1')
    const [session] = await sessionIds([token])
    // Asking needs the club's invite code, and changes nothing yet
    await expect(club.requestPasswordReset('amy', 'nope')).rejects.toThrow('邀請碼不正確')
    await club.requestPasswordReset('AMY', 'tku')
    expect(await club.userForToken(token)).not.toBeNull()
    await club.login('amy', 'secret1')
    // The admins hear about it once, however often it is asked
    await club.requestPasswordReset('amy', 'tku')
    expect((await notices(adminId)).filter((n) => n.kind === 'passwordResetRequested')).toEqual([
      expect.objectContaining({ params: { username: 'amy' } }),
    ])
    expect(await resetOf(amy)).toEqual({ state: 'requested', at: time })

    // Whoever asked has no code until an admin approves; then only the admin sees it
    await expect(club.resetForgottenPassword('amy', 'AAAAA-AAAAA', 'newpass1')).rejects.toThrow('重設代碼不正確')
    time += 60_000
    const answer = await club.adminAnswerPasswordReset(adminId, amy, true)
    expect(answer!.code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/)
    expect(answer!.expiresAt).toBe(time + RESET_CODE_MS)
    expect(await resetOf(amy)).toEqual({ state: 'approved', at: time, until: time + RESET_CODE_MS })
    // Only the code's hash is kept
    expect(JSON.stringify(await store.get(`user:${amy}`))).not.toContain(answer!.code)
    await expect(club.adminAnswerPasswordReset(adminId, amy, true).then(() => 'again')).resolves.toBe('again')
    const { code } = (await club.adminAnswerPasswordReset(adminId, amy, true))!

    await expect(club.resetForgottenPassword('amy', code, '123')).rejects.toThrow('密碼至少')
    time += 60_000
    // Typed in lower case without the dash works
    await club.resetForgottenPassword('amy', code.toLowerCase().replace('-', ' '), 'newpass1')
    expect(await club.userForToken(token)).toBeNull()
    expect(disconnected).toContain(amy)
    expect(await revoked(session)).toBe(true)
    await expect(club.login('amy', 'secret1')).rejects.toThrow('帳號或密碼錯誤')
    expect((await club.login('amy', 'newpass1')).user.id).toBe(amy)
    const listed = (await club.adminUsers()).find((u) => u.id === amy)!
    expect(listed).toMatchObject({ passwordResetAt: time, passwordReset: null })
    // The code worked once
    await expect(club.resetForgottenPassword('amy', code, 'another1')).rejects.toThrow('重設代碼不正確')
    // The export never carries it
    expect(JSON.stringify(await club.exportAccount(amy, null))).not.toContain('codeHash')
  })

  it('lets an older code run out, declines a request, and counts wrong codes as failed sign-ins', async () => {
    const amy = await member('amy')
    await club.requestPasswordReset('amy', 'tku')
    const { code } = (await club.adminAnswerPasswordReset(adminId, amy, true))!
    time += RESET_CODE_MS
    await expect(club.resetForgottenPassword('amy', code, 'newpass1')).rejects.toThrow('重設代碼不正確')
    expect(await resetOf(amy)).toBeNull()
    // Once it ran out, asking again tells the admins again
    await club.requestPasswordReset('amy', 'tku')
    expect((await notices(adminId)).filter((n) => n.kind === 'passwordResetRequested')).toHaveLength(2)
    await club.adminAnswerPasswordReset(adminId, amy, false)
    expect(await resetOf(amy)).toBeNull()
    await expect(club.adminAnswerPasswordReset(adminId, amy, false)).rejects.toThrow('沒有待核准')
    // Five wrong codes from one place and the name is locked there for a while, like sign-ins
    const { code: fresh } = (await club.adminAnswerPasswordReset(adminId, amy, true))!
    for (let i = 0; i < 5; i++)
      await expect(club.resetForgottenPassword('amy', 'WRONG-CODE0', 'newpass1', '1.2.3.4')).rejects.toThrow('重設代碼不正確')
    await expect(club.resetForgottenPassword('amy', fresh, 'newpass1', '1.2.3.4')).rejects.toThrow(ClubError)
    await club.resetForgottenPassword('amy', fresh, 'newpass1', '5.6.7.8')
  })

  it('leaves admin accounts to other admins, and a registration still waiting to the admins', async () => {
    await expect(club.requestPasswordReset('admin', 'tku')).rejects.toThrow('其他管理員')
    await expect(club.adminAnswerPasswordReset(adminId, adminId, true)).rejects.toThrow('其他管理員')
    await expect(club.requestPasswordReset('nobody', 'tku')).rejects.toThrow('找不到這個帳號')
    await club.register('ben', 'secret1', 'tku')
    await expect(club.requestPasswordReset('ben', 'tku')).rejects.toThrow('還沒核准')
  })
})

describe('edge passes stop when their session ends (e11-t28)', () => {
  it('lists ended sessions in D1: sign-out, one device, the other devices, a new password, a deleted account', async () => {
    const ben = await member('ben')
    const tokens = await Promise.all([1, 2, 3, 4].map(async () => (await club.login('ben', 'secret1')).token))
    const [a, b, c, d] = await sessionIds(tokens)
    expect(await club.passIdentity('no-such-token')).toBeNull()

    await club.logout(tokens[0])
    expect(await revoked(a)).toBe(true)
    expect(await revoked(b)).toBe(false)

    await club.endSession(ben, tokens[1], c)
    expect(await revoked(c)).toBe(true)
    expect(disconnected).toEqual([ben])

    await club.endOtherSessions(ben, tokens[1])
    expect(await revoked(d)).toBe(true)
    expect(await revoked(b)).toBe(false)

    const { token: again } = await club.login('ben', 'secret1')
    const [e] = await sessionIds([again])
    await club.changePassword(ben, 'secret1', 'newpass1', tokens[1])
    expect([await revoked(e), await revoked(b)]).toEqual([true, false])

    await club.deleteOwnAccount(ben, 'newpass1')
    expect(await revoked(b)).toBe(true)
  })

  it('tries once more when D1 fails, and an admin’s reset signs the member out too', async () => {
    const ben = await member('ben')
    const { token } = await club.login('ben', 'secret1')
    const [id] = await sessionIds([token])
    d1.fail = new Error('D1 is down')
    await club.adminResetPassword(ben, 'newpass1')
    expect(await club.userForToken(token)).toBeNull()
    d1.fail = null
    expect(await revoked(id)).toBe(false)
  })
})

describe('password hashes (e11-t30)', () => {
  it('makes new hashes with ITERATIONS and upgrades an older one at the next sign-in', async () => {
    expect(ITERATIONS).toBe(100_000)
    const fresh = await hashPassword('secret1')
    expect(fresh.split('$')[1]).toBe('100000')
    expect(needsRehash(fresh)).toBe(false)

    const ben = await member('ben')
    const user = (await store.get<{ passwordHash: string }>(`user:${ben}`))!
    // A hash from before: 50,000 iterations, as accounts made until now have
    const salt = btoa(String.fromCharCode(...new Uint8Array(16)))
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('secret1'), 'PBKDF2', false, ['deriveBits'])
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new Uint8Array(16), iterations: 50_000 }, key, 256)
    const old = `pbkdf2$50000$${salt}$${btoa(String.fromCharCode(...new Uint8Array(bits)))}`
    expect(needsRehash(old)).toBe(true)
    expect(await verifyPassword('secret1', old)).toBe(true)
    await store.put(`user:${ben}`, { ...user, passwordHash: old })
    await club.load()

    await expect(club.login('ben', 'wrong11')).rejects.toThrow('帳號或密碼錯誤')
    expect((await store.get<{ passwordHash: string }>(`user:${ben}`))!.passwordHash).toBe(old)
    await club.login('ben', 'secret1')
    const upgraded = (await store.get<{ passwordHash: string }>(`user:${ben}`))!.passwordHash
    expect(upgraded.split('$')[1]).toBe('100000')
    expect(await verifyPassword('secret1', upgraded)).toBe(true)
    await club.login('ben', 'secret1')
  })

  it('makes reset codes that are hard to mistake, kept only as their hash', async () => {
    const codes = new Set(Array.from({ length: 200 }, resetCode))
    expect(codes.size).toBe(200)
    for (const code of codes) expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{5}-[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{5}$/)
    expect(await hashResetCode('abcde fgh23')).toBe(await hashResetCode('ABCDE-FGH23'))
    expect(await hashResetCode('ABCDE-FGH23')).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('request bodies counted as they arrive (e11-t32)', () => {
  const tooLarge = () => new ClubError('messageTooLarge', {}, 413)
  /** A body sent in pieces with no Content-Length (chunked), as a client may */
  const streamed = (chunks: string[], headers: Record<string, string> = {}) =>
    new Request('https://example.org/api/x', {
      method: 'POST',
      headers,
      body: new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
          controller.close()
        },
      }),
      duplex: 'half',
    } as RequestInit)

  it('stops at the limit whatever Content-Length says, or without one', async () => {
    expect(await readText(streamed(['ab', 'cd']), 4, tooLarge)).toBe('abcd')
    await expect(readText(streamed(['ab', 'cde']), 4, tooLarge)).rejects.toThrow(ClubError)
    // A Content-Length that lies is not believed
    await expect(readBytes(streamed(['abc', 'def'], { 'Content-Length': '2' }), 4, tooLarge)).rejects.toThrow(ClubError)
    // One that says too much is refused before anything is read
    await expect(readBytes(new Request('https://example.org/', { method: 'POST', body: 'x', headers: { 'Content-Length': '99' } }), 4, tooLarge)).rejects.toThrow(ClubError)
    expect((await readBytes(new Request('https://example.org/'), 4, tooLarge)).length).toBe(0)
    expect(await readJson(streamed(['{"a"', ':1}']), 100, tooLarge)).toEqual({ a: 1 })
    expect(await readJson(streamed(['not json']), 100, tooLarge)).toEqual({})
  })

  it('counts a multipart form as it is parsed', async () => {
    const form = new FormData()
    form.set('ticket', 't1')
    form.set('file', new Blob(['x'.repeat(5000)]), 'a.pdf')
    const encoded = new Response(form)
    const type = encoded.headers.get('Content-Type')!
    const bytes = await encoded.text()
    const parsed = await readForm(streamed([bytes], { 'Content-Type': type }), 10_000, tooLarge)
    expect(parsed.get('ticket')).toBe('t1')
    await expect(readForm(streamed([bytes.slice(0, 3000), bytes.slice(3000)], { 'Content-Type': type }), 4000, tooLarge)).rejects.toThrow(ClubError)
  })
})
