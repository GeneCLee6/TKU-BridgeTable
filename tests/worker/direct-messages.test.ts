// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { FRIENDS_ENABLED } from '../../shared/features.ts'
import { parseClientMessage } from '../../shared/message-guard.ts'
import { DIRECT_KEPT, DIRECT_PAGE_SIZE, LIMITS, type ClientMessage, type ServerMessage } from '../../shared/protocol.ts'
import { DIRECT_BURST, FRIEND_ONLINE_QUIET_MS } from '../../worker/rate-limit.ts'
import { ClubService, type Connections } from '../../worker/service.ts'
import type { MemoryStore } from '../../worker/store.ts'
import { memoryStore } from './sqlite.ts'

class FakeConnections implements Connections {
  online = new Set<string>()
  inbox = new Map<string, ServerMessage[]>()
  onlineUserIds() {
    return [...this.online]
  }
  send(userId: string, message: ServerMessage) {
    this.inbox.set(userId, [...(this.inbox.get(userId) ?? []), message])
  }
  disconnect(userId: string) {
    this.online.delete(userId)
  }
  all<T extends ServerMessage['type']>(userId: string, type: T) {
    return (this.inbox.get(userId) ?? []).filter((m) => m.type === type) as Extract<ServerMessage, { type: T }>[]
  }
  last<T extends ServerMessage['type']>(userId: string, type: T) {
    return this.all(userId, type).at(-1)
  }
}

let store: MemoryStore
let connections: FakeConnections
let club: ClubService
let time: number
let admin: string

const tick = () => new Promise((resolve) => setImmediate(resolve))

beforeEach(async () => {
  store = memoryStore()
  connections = new FakeConnections()
  time = 1_000_000
  club = new ClubService(store, connections, { maxUsers: 20, now: () => time, schedule: () => undefined })
  await club.load()
  const founder = await club.register('admin', 'secret1', '')
  if (!('user' in founder)) throw new Error('the first account should sign in at once')
  admin = founder.user.id
})

/** Registers, approves, and connects a member */
async function member(name: string, online = true) {
  const result = await club.register(name, 'secret1', '')
  const user =
    'user' in result ? result.user : await club.adminApprove(club.adminApplications().find((a) => a.username === name)!.id)
  if (online) await connect(user.id)
  return user.id
}

async function connect(userId: string) {
  connections.online.add(userId)
  club.connected(userId)
  await tick()
}

async function disconnect(userId: string) {
  connections.online.delete(userId)
  await club.disconnected(userId)
}

const send = (userId: string, message: ClientMessage) => club.handle(userId, message)
/** As a message from the socket, with its shape check and rate limits */
const sendRaw = (userId: string, message: ClientMessage) => club.handleRaw(userId, JSON.stringify(message))
const error = (userId: string) => connections.last(userId, 'error')?.code
const directs = (userId: string) => connections.last(userId, 'directs')?.directs
const delivered = (userId: string) => connections.all(userId, 'direct').map((m) => m.message.text)

describe('direct messages (AC-1.7)', () => {
  it('go to the two members only, with unread counts, and are marked read', async () => {
    const amy = await member('amy')
    const ben = await member('ben')
    const cat = await member('cat')
    expect(directs(amy)).toEqual({ conversations: [], unread: 0 })

    await send(amy, { type: 'sendDirect', to: ben, text: '  hi ben  ' })
    time++
    await send(amy, { type: 'sendDirect', to: ben, text: 'are you there?' })
    expect(delivered(amy)).toEqual(['hi ben', 'are you there?'])
    expect(delivered(ben)).toEqual(['hi ben', 'are you there?'])
    expect(delivered(cat)).toEqual([])
    expect(connections.all(cat, 'directs').every((m) => m.directs.conversations.length === 0)).toBe(true)

    expect(directs(ben)).toMatchObject({
      unread: 2,
      conversations: [{ user: { id: amy, username: 'amy' }, unread: 2, last: { from: amy, to: ben, text: 'are you there?' } }],
    })
    // The sender has read their own
    expect(directs(amy)).toMatchObject({ unread: 0, conversations: [{ user: { username: 'ben' }, unread: 0 }] })

    await send(ben, { type: 'readDirect', userId: amy })
    expect(directs(ben)?.unread).toBe(0)
    // Nothing more to read: nothing is sent
    const before = connections.inbox.get(ben)!.length
    await send(ben, { type: 'readDirect', userId: amy })
    expect(connections.inbox.get(ben)!.length).toBe(before)

    // A newer conversation goes on top
    time++
    await send(cat, { type: 'sendDirect', to: ben, text: 'yo' })
    expect(directs(ben)?.conversations.map((c) => c.user.username)).toEqual(['cat', 'amy'])
    expect(directs(ben)?.unread).toBe(1)
  })

  it('are kept for a member who is offline and survive a reload', async () => {
    const amy = await member('amy')
    const ben = await member('ben', false)
    await send(amy, { type: 'sendDirect', to: ben, text: 'see you tonight' })
    expect(delivered(ben)).toEqual([])

    const reloaded = new ClubService(store, connections, { maxUsers: 20, now: () => time, schedule: () => undefined })
    await reloaded.load()
    connections.online.add(ben)
    reloaded.connected(ben)
    expect(directs(ben)).toMatchObject({ unread: 1, conversations: [{ user: { id: amy }, last: { text: 'see you tonight' } }] })
    expect(reloaded.directPage(ben, amy).messages.map((m) => m.text)).toEqual(['see you tonight'])
  })

  it('page back from the newest, and keep the newest DIRECT_KEPT of a conversation', async () => {
    const amy = await member('amy')
    const ben = await member('ben')
    const cat = await member('cat')
    for (let i = 0; i < DIRECT_KEPT + 5; i++) {
      time++
      await send(i % 2 ? ben : amy, { type: 'sendDirect', to: i % 2 ? amy : ben, text: `m${i}` })
    }
    await send(cat, { type: 'sendDirect', to: amy, text: 'other' })

    const first = club.directPage(amy, ben)
    expect(first.messages).toHaveLength(DIRECT_PAGE_SIZE)
    expect(first.messages.at(-1)?.text).toBe(`m${DIRECT_KEPT + 4}`)
    expect(first.more).toBe(true)
    const second = club.directPage(amy, ben, first.messages[0].id)
    expect(second.messages.at(-1)!.id).toBeLessThan(first.messages[0].id)
    expect(second.messages.at(-1)?.text).toBe(`m${DIRECT_KEPT + 4 - DIRECT_PAGE_SIZE}`)

    let all: string[] = []
    let before: number | undefined
    for (;;) {
      const page = club.directPage(ben, amy, before)
      all = [...page.messages.map((m) => m.text), ...all]
      if (!page.more) break
      before = page.messages[0].id
    }
    expect(all).toHaveLength(DIRECT_KEPT)
    expect(all[0]).toBe('m5')
    // Each page is only the pair's own conversation
    expect(all).not.toContain('other')
    expect(club.directPage(cat, amy).messages.map((m) => m.text)).toEqual(['other'])
  })

  it('refuse oneself, robots, unknown members and empty text', async () => {
    const amy = await member('amy')
    await send(amy, { type: 'sendDirect', to: amy, text: 'me' })
    expect(error(amy)).toBe('notSelf')
    await send(amy, { type: 'sendDirect', to: 'robot:tku:N', text: 'beep' })
    expect(error(amy)).toBe('userGone')
    await send(amy, { type: 'sendDirect', to: 'nobody', text: 'hello' })
    expect(error(amy)).toBe('userGone')
    expect(() => club.directPage(amy, 'nobody')).toThrow()
    const ben = await member('ben')
    await send(amy, { type: 'sendDirect', to: ben, text: '   ' })
    expect(delivered(ben)).toEqual([])
  })

  it('go with a deleted account, for both members', async () => {
    const amy = await member('amy')
    const ben = await member('ben')
    await send(amy, { type: 'sendDirect', to: ben, text: 'bye' })
    await club.adminDeleteUser(admin, amy)
    expect(directs(ben)).toEqual({ conversations: [], unread: 0 })
    expect(store.sql.exec('SELECT * FROM direct_messages')).toEqual([])
    expect(store.sql.exec('SELECT * FROM direct_threads')).toEqual([])
  })
})

describe('direct message abuse (e1-t27)', () => {
  it('blocks work both ways: the blocked member cannot write, and the blocker must unblock first', async () => {
    const amy = await member('amy')
    const ben = await member('ben')
    await send(amy, { type: 'setBlocked', userId: ben, blocked: true })

    await send(ben, { type: 'sendDirect', to: amy, text: 'please' })
    expect(error(ben)).toBe('cannotMessage')
    expect(connections.last(ben, 'error')?.params).toEqual({ name: 'amy' })
    await send(amy, { type: 'sendDirect', to: ben, text: 'hey' })
    expect(error(amy)).toBe('unblockToMessage')
    expect(delivered(amy)).toEqual([])
    expect(delivered(ben)).toEqual([])

    await send(amy, { type: 'setBlocked', userId: ben, blocked: false })
    await send(ben, { type: 'sendDirect', to: amy, text: 'thanks' })
    expect(delivered(amy)).toEqual(['thanks'])
  })

  it('limit the length', async () => {
    const amy = await member('amy')
    const ben = await member('ben')
    await send(amy, { type: 'sendDirect', to: ben, text: 'x'.repeat(LIMITS.directMax + 1) })
    expect(error(amy)).toBe('directTooLong')
    await send(amy, { type: 'sendDirect', to: ben, text: 'x'.repeat(LIMITS.directMax) })
    expect(delivered(ben)).toHaveLength(1)
  })

  it('limit how many a minute, separately from table chat', async () => {
    const amy = await member('amy')
    const ben = await member('ben')
    for (let i = 0; i < DIRECT_BURST + 3; i++) await sendRaw(amy, { type: 'sendDirect', to: ben, text: `n${i}` })
    expect(delivered(ben)).toHaveLength(DIRECT_BURST)
    expect(error(amy)).toBe('directTooFast')
    // 20 a minute: one more every 3 seconds
    time += 3000
    await sendRaw(amy, { type: 'sendDirect', to: ben, text: 'later' })
    expect(delivered(ben).at(-1)).toBe('later')
  })

  it('check the message shape before it reaches the club', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'sendDirect', to: 'x', text: 1 }))).toEqual({ error: 'badMessage' })
    expect(parseClientMessage(JSON.stringify({ type: 'sendDirect', text: 'hi' }))).toEqual({ error: 'badMessage' })
    expect(parseClientMessage(JSON.stringify({ type: 'readDirect', userId: 5 }))).toEqual({ error: 'badMessage' })
    expect('message' in parseClientMessage(JSON.stringify({ type: 'readDirect', userId: 'x' }))).toBe(true)
  })
})

describe('friend online notice (e1-t24)', () => {
  const kinds = (userId: string) =>
    (connections.last(userId, 'notifications')?.notifications.items ?? [])
      .filter((n) => n.kind === 'friendOnline')
      .map((n) => n.params.username)

  it.runIf(!FRIENDS_ENABLED)('says nothing while friends are hidden (FRIENDS_ENABLED)', async () => {
    const amy = await member('amy')
    const ben = await member('ben', false)
    await send(amy, { type: 'setFriend', userId: ben, friend: true })
    await connect(ben)
    expect(kinds(amy)).toEqual([])
  })

  it.skipIf(!FRIENDS_ENABLED)('tells online followers once when a friend comes online, not on a reconnect soon after', async () => {
    const amy = await member('amy')
    const cat = await member('cat')
    const ben = await member('ben', false)
    await send(amy, { type: 'setFriend', userId: ben, friend: true })

    await connect(ben)
    expect(kinds(amy)).toEqual(['ben'])
    // Cat does not follow Ben; Ben is not told about himself
    expect(kinds(cat)).toEqual([])
    expect(kinds(ben)).toEqual([])

    // A second tab, or a dropped connection that comes back, says nothing
    await connect(ben)
    await disconnect(ben)
    time += 60_000
    await connect(ben)
    expect(kinds(amy)).toEqual(['ben'])

    await disconnect(ben)
    time += FRIEND_ONLINE_QUIET_MS
    await connect(ben)
    expect(kinds(amy)).toEqual(['ben', 'ben'])
  })

  it.skipIf(!FRIENDS_ENABLED)('can be turned off on the account page, and is not sent to someone the friend blocked', async () => {
    const amy = await member('amy')
    const cat = await member('cat')
    const ben = await member('ben', false)
    await send(amy, { type: 'setFriend', userId: ben, friend: true })
    await send(cat, { type: 'setFriend', userId: ben, friend: true })
    await send(ben, { type: 'setBlocked', userId: cat, blocked: true })

    const me = await club.setAccountPreferences(amy, { friendOnlineNotice: false })
    expect(me.friendOnlineNotice).toBe(false)

    await connect(ben)
    expect(kinds(amy)).toEqual([])
    expect(kinds(cat)).toEqual([])

    expect((await club.setAccountPreferences(amy, { friendOnlineNotice: true })).friendOnlineNotice).toBe(true)
    await expect(club.setAccountPreferences(amy, { friendOnlineNotice: 'yes' })).rejects.toThrow()
  })

  it("keeps the handbook's system profile with the account, apart from the notice (TKU-BridgeBook e1-t16)", async () => {
    const amy = await member('amy')
    expect((await club.setAccountPreferences(amy, { friendOnlineNotice: false })).bookProfile).toBeUndefined()

    const me = await club.setAccountPreferences(amy, { bookProfile: 'a1b2c3' })
    expect(me.bookProfile).toBe('a1b2c3')
    expect(me.friendOnlineNotice).toBe(false)
    // Signing in on another device gets the same choice
    expect((await club.login('amy', 'secret1')).user.bookProfile).toBe('a1b2c3')

    expect((await club.setAccountPreferences(amy, { bookProfile: 'club' })).bookProfile).toBeUndefined()
    await club.setAccountPreferences(amy, { bookProfile: 'a1b2c3' })
    expect((await club.setAccountPreferences(amy, { bookProfile: '' })).bookProfile).toBeUndefined()

    for (const bad of ['../x', 'x'.repeat(41), 7, null])
      await expect(club.setAccountPreferences(amy, { bookProfile: bad })).rejects.toThrow()
    await expect(club.setAccountPreferences(amy, {})).rejects.toThrow()
  })

  it('keeps the notice about conventions one\'s profile plays apart from the others (BridgeHall F4)', async () => {
    const amy = await member('amy')
    expect(club.mutesAdoptedNotices(amy)).toBe(false)
    const muted = await club.setAccountPreferences(amy, { bookAdoptedNotice: false })
    expect(muted.bookAdoptedNotice).toBe(false)
    expect(muted.friendOnlineNotice).toBe(true)
    expect(club.mutesAdoptedNotices(amy)).toBe(true)
    expect((await club.login('amy', 'secret1')).user.bookAdoptedNotice).toBe(false)
    expect((await club.setAccountPreferences(amy, { bookAdoptedNotice: true })).bookAdoptedNotice).toBe(true)
    expect(club.mutesAdoptedNotices(amy)).toBe(false)
    await expect(club.setAccountPreferences(amy, { bookAdoptedNotice: 'no' })).rejects.toThrow()
  })
})
