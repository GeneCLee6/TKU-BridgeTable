// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { pushDeviceId } from '../../shared/push.ts'
import type { PushMessage } from '../../shared/push-texts.ts'
import { ClubService, type Connections } from '../../worker/service.ts'
import type { MemoryStore } from '../../worker/store.ts'
import { base64url, type PushSender, type PushTarget, type PushUrgency } from '../../worker/web-push.ts'
import { memoryStore } from './sqlite.ts'

const PASSWORD = 'club-secret-1'

/** A push service that records what it got; `status` per endpoint (201 unless set) */
class FakePush implements PushSender {
  readonly publicKey = 'BPublicKey'
  sent: { endpoint: string; message: PushMessage; urgency?: PushUrgency; ttl?: number }[] = []
  status = new Map<string, number>()
  async send(target: PushTarget, message: string, options: { urgency?: PushUrgency; ttl?: number } = {}) {
    this.sent.push({ endpoint: target.endpoint, message: JSON.parse(message), ...options })
    return { status: this.status.get(target.endpoint) ?? 201 }
  }
}

let store: MemoryStore
let club: ClubService
let sender: FakePush
let online: Set<string>
let time: number
let deferred: Promise<unknown>[]

const connections: Connections = {
  onlineUserIds: () => [...online],
  send: () => undefined,
  disconnect: () => undefined,
}

async function open(withPush = true) {
  store = memoryStore()
  club = new ClubService(store, connections, {
    maxUsers: 20,
    inviteCode: 'tku',
    now: () => time,
    schedule: () => undefined,
    push: withPush ? sender : undefined,
    defer: (task) => void deferred.push(task),
  })
  await club.load()
  await club.register('admin', PASSWORD, 'tku')
}

beforeEach(async () => {
  time = 1_700_000_000_000
  sender = new FakePush()
  online = new Set()
  deferred = []
  await open()
})

async function member(name: string) {
  await club.register(name, PASSWORD, 'tku')
  return (await club.adminApprove(club.adminApplications().find((a) => a.username === name)!.id)).id
}

/** A browser's subscription with real-sized keys */
async function subscription(endpoint = `https://fcm.googleapis.com/fcm/send/${Math.random().toString(36).slice(2)}`) {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair
  const p256dh = base64url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)))
  return { endpoint, keys: { p256dh, auth: base64url(crypto.getRandomValues(new Uint8Array(16))) } }
}

const CHROME = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36'

async function settle() {
  await club.push.idle()
}

describe('push notifications (e1-t28)', () => {
  it('is off without the VAPID keys: the view says so and the rest answers pushOff', async () => {
    await open(false)
    const amy = await member('amy')
    expect(await club.push.view(amy)).toMatchObject({ enabled: false, devices: [] })
    await expect(club.push.subscribe(amy, await subscription(), CHROME)).rejects.toMatchObject({ code: 'pushOff', status: 503 })
    await expect(club.push.test(amy)).rejects.toMatchObject({ code: 'pushOff' })
    await club.notifications.notify(amy, 'challengeInvited', { username: 'ben', challengeId: 'c1' })
    await settle()
    expect(sender.sent).toEqual([])
  })

  it('subscribes a device, lists it by the hash of its endpoint and gives the key', async () => {
    const amy = await member('amy')
    const sub = await subscription()
    const view = await club.push.subscribe(amy, { ...sub, lang: 'en' }, CHROME)
    expect(view.enabled).toBe(true)
    expect(view.publicKey).toBe('BPublicKey')
    expect(view.devices).toEqual([{ id: await pushDeviceId(sub.endpoint), name: expect.stringContaining('Chrome'), createdAt: time }])
    // Nothing about the endpoint or its keys goes back to the page
    expect(JSON.stringify(view)).not.toContain(sub.endpoint)
    expect(JSON.stringify(view)).not.toContain(sub.keys.auth)
    // The same endpoint again updates it, not a second device
    time += 1000
    expect((await club.push.subscribe(amy, { ...sub, lang: 'ja' }, CHROME)).devices).toHaveLength(1)
  })

  it('refuses an endpoint that is no push service, or keys of the wrong size', async () => {
    const amy = await member('amy')
    const sub = await subscription()
    await expect(club.push.subscribe(amy, { ...sub, endpoint: 'https://evil.example/hook' }, CHROME)).rejects.toMatchObject({
      code: 'pushBadSubscription',
    })
    await expect(club.push.subscribe(amy, { ...sub, keys: { ...sub.keys, auth: 'abc' } }, CHROME)).rejects.toMatchObject({
      code: 'pushBadSubscription',
    })
    await expect(club.push.subscribe(amy, { endpoint: sub.endpoint }, CHROME)).rejects.toMatchObject({ code: 'pushBadSubscription' })
  })

  it("pushes a new notification to every device of an offline member, in the device's language", async () => {
    const amy = await member('amy')
    const phone = await subscription()
    const laptop = await subscription('https://updates.push.services.mozilla.com/wpush/v2/xyz')
    await club.push.subscribe(amy, { ...phone, lang: 'zh' }, CHROME)
    await club.push.subscribe(amy, { ...laptop, lang: 'en' }, 'Mozilla/5.0 (Windows NT 10.0; rv:131.0) Gecko/20100101 Firefox/131.0')
    const n = await club.notifications.notify(amy, 'challengeInvited', { username: 'ben', challengeId: 'c1' })
    await settle()
    expect(sender.sent).toHaveLength(2)
    const byEndpoint = new Map(sender.sent.map((s) => [s.endpoint, s]))
    expect(byEndpoint.get(phone.endpoint)).toMatchObject({
      message: { title: '淡江牌桌', body: 'ben 邀請你參加挑戰', url: '/challenges/c1', tag: n.id },
      urgency: 'high',
      ttl: 86_400,
    })
    expect(byEndpoint.get(laptop.endpoint)?.message.title).toBe('TKU BridgeTable')
    expect(deferred.length).toBeGreaterThan(0)
  })

  it('pushes to every member notified at once', async () => {
    const ids = [await member('amy'), await member('ben'), await member('cat')]
    for (const id of ids) await club.push.subscribe(id, await subscription(), CHROME)
    await Promise.all(ids.map((id) => club.notifications.notify(id, 'challengeWeekly', { challengeId: 'w1' })))
    await settle()
    expect(sender.sent.map((s) => s.message.url)).toEqual(['/challenges/w1', '/challenges/w1', '/challenges/w1'])
  })

  it('does not push while the member has the site open', async () => {
    const amy = await member('amy')
    await club.push.subscribe(amy, await subscription(), CHROME)
    online.add(amy)
    await club.notifications.notify(amy, 'tableInvited', { username: 'ben', tableId: 't1', number: 4 })
    await settle()
    expect(sender.sent).toEqual([])
    online.delete(amy)
    await club.notifications.notify(amy, 'tableInvited', { username: 'ben', tableId: 't1', number: 4 })
    await settle()
    expect(sender.sent).toHaveLength(1)
    expect(sender.sent[0]).toMatchObject({ message: { body: 'ben 邀請你到第 4 桌', url: '/table/t1' }, ttl: 3_600 })
  })

  it('pushes the kinds the member chose: friends coming online only when turned on', async () => {
    const amy = await member('amy')
    await club.push.subscribe(amy, await subscription(), CHROME)
    expect((await club.push.view(amy)).kinds).toMatchObject({ friendOnline: false, matchInvited: true })
    await club.notifications.notify(amy, 'friendOnline', { username: 'ben' })
    await settle()
    expect(sender.sent).toEqual([])

    const view = await club.push.setKinds(amy, { friendOnline: true, matchInvited: false, nonsense: true, forumReply: 'yes' })
    expect(view.kinds).toMatchObject({ friendOnline: true, matchInvited: false, forumReply: true })
    expect(view.kinds).not.toHaveProperty('nonsense')
    await club.notifications.notify(amy, 'matchInvited', { username: 'ben', matchId: 'm1' })
    await club.notifications.notify(amy, 'friendOnline', { username: 'ben' })
    await settle()
    expect(sender.sent.map((s) => s.message.body)).toEqual(['ben 上線了'])
    // The choice outlives the object
    await club.load()
    expect((await club.push.view(amy)).kinds.matchInvited).toBe(false)
  })

  it('removes a device the push service no longer knows (404, 410), keeps one that failed otherwise', async () => {
    const amy = await member('amy')
    const gone = await subscription()
    const expired = await subscription()
    const busy = await subscription()
    for (const s of [gone, expired, busy]) await club.push.subscribe(amy, s, CHROME)
    sender.status.set(gone.endpoint, 410)
    sender.status.set(expired.endpoint, 404)
    sender.status.set(busy.endpoint, 429)
    await club.notifications.notify(amy, 'challengeResults', { challengeId: 'c1' })
    await settle()
    expect((await club.push.view(amy)).devices.map((d) => d.id)).toEqual([await pushDeviceId(busy.endpoint)])
    expect(((await store.get(`push:${amy}`)) as { devices: unknown[] }).devices).toHaveLength(1)
  })

  it('pushes an admin about an application', async () => {
    const admin = club.adminIds()[0]
    await club.push.subscribe(admin, await subscription(), CHROME)
    await club.register('newbie', PASSWORD, 'tku')
    await settle()
    expect(sender.sent.map((s) => s.message)).toEqual([expect.objectContaining({ body: 'newbie 申請加入，等你核准', url: '/admin' })])
  })

  it('removes a device, sends a test push even while online, at most every 10 seconds', async () => {
    const amy = await member('amy')
    const one = await subscription()
    const two = await subscription()
    await club.push.subscribe(amy, one, CHROME)
    await club.push.subscribe(amy, two, CHROME)
    online.add(amy)
    expect(await club.push.test(amy)).toBe(2)
    await settle()
    expect(sender.sent.map((s) => s.message.tag)).toEqual(['push-test', 'push-test'])
    await expect(club.push.test(amy)).rejects.toMatchObject({ code: 'slowDown' })
    time += 10_000
    expect((await club.push.unsubscribe(amy, await pushDeviceId(one.endpoint))).devices).toHaveLength(1)
    expect(await club.push.test(amy, await pushDeviceId(two.endpoint))).toBe(1)
  })

  it('keeps at most ten devices, dropping the oldest', async () => {
    const amy = await member('amy')
    const first = await subscription()
    await club.push.subscribe(amy, first, CHROME)
    for (let i = 0; i < 10; i++) await club.push.subscribe(amy, await subscription(), CHROME)
    const ids = (await club.push.view(amy)).devices.map((d) => d.id)
    expect(ids).toHaveLength(10)
    expect(ids).not.toContain(await pushDeviceId(first.endpoint))
  })

  it('forgets the devices when the member is signed out everywhere, and everything with the account', async () => {
    const amy = await member('amy')
    await club.push.subscribe(amy, await subscription(), CHROME)
    await club.push.setKinds(amy, { friendOnline: true })
    const exported = await club.exportAccount(amy, null)
    expect(exported.push).toEqual({ devices: [{ name: expect.any(String), createdAt: time }], kinds: expect.objectContaining({ friendOnline: true }) })
    expect(JSON.stringify(exported.push)).not.toContain('fcm.googleapis.com')

    // An admin resets the password: signed out everywhere
    await club.adminResetPassword(amy, 'another-secret-2')
    expect((await club.push.view(amy)).devices).toEqual([])
    expect((await club.push.view(amy)).kinds.friendOnline).toBe(true)

    await club.push.subscribe(amy, await subscription(), CHROME)
    await club.deleteOwnAccount(amy, 'another-secret-2')
    expect(await store.get(`push:${amy}`)).toBeUndefined()
  })
})
