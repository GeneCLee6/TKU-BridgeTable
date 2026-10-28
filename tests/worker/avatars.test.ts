// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { AVATAR_BURST, AVATAR_MAX_BYTES, avatarUrl, sniffAvatar } from '../../shared/avatar.ts'
import type { ServerMessage } from '../../shared/protocol.ts'
import { AVATAR_CHECK_CACHE, AVATAR_LONG_CACHE, avatarResponse, readAvatarUpload } from '../../worker/avatars.ts'
import { ClubService, type Connections } from '../../worker/service.ts'
import type { MemoryStore } from '../../worker/store.ts'
import { memoryStore } from './sqlite.ts'
import { lobbyFrom } from './lobby-copy.ts'

const WEBP = [0x52, 0x49, 0x46, 0x46, 0x10, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]
const picture = (head: number[], size = 2000) => {
  const bytes = new Uint8Array(size)
  bytes.set(head)
  return bytes
}

let store: MemoryStore
let club: ClubService
let time: number
let admin: string
let online: string[]
const sent: { userId: string; message: ServerMessage }[] = []
const connections: Connections = {
  onlineUserIds: () => online,
  send: (userId, message) => void sent.push({ userId, message }),
  disconnect: () => undefined,
}

beforeEach(async () => {
  store = memoryStore()
  time = 1_000_000
  online = []
  sent.length = 0
  club = new ClubService(store, connections, { maxUsers: 20, now: () => time, schedule: () => undefined })
  await club.load()
  const founder = await club.register('admin', 'secret1', '')
  if (!('user' in founder)) throw new Error('the first account should sign in at once')
  admin = founder.user.id
})

async function member(name: string) {
  const result = await club.register(name, 'secret1', '')
  if ('user' in result) return result.user.id
  return (await club.adminApprove(club.adminApplications().find((a) => a.username === name)!.id)).id
}

describe('sniffAvatar', () => {
  it('knows WebP, JPEG and PNG by their first bytes, and nothing else', () => {
    expect(sniffAvatar(picture(WEBP))).toBe('image/webp')
    expect(sniffAvatar(picture(JPEG))).toBe('image/jpeg')
    expect(sniffAvatar(picture(PNG))).toBe('image/png')
    expect(sniffAvatar(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull()
    expect(sniffAvatar(new TextEncoder().encode('GIF89a......'))).toBeNull()
    // RIFF but not WebP (a WAV file)
    expect(sniffAvatar(picture([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]))).toBeNull()
    expect(sniffAvatar(new Uint8Array([0xff, 0xd8]))).toBeNull()
    expect(sniffAvatar(new Uint8Array())).toBeNull()
  })
})

describe('uploading an avatar', () => {
  it('keeps the picture, gives the member a version and shows it in views', async () => {
    const amy = await member('amy')
    const me = await club.setAvatar(amy, picture(WEBP))
    expect(me.avatar).toBe(time)
    const stored = await club.avatar(amy)
    expect(stored).toMatchObject({ version: time, type: 'image/webp' })
    expect([...stored!.bytes.slice(0, 4)]).toEqual(WEBP.slice(0, 4))
    expect((await club.memberProfile(admin, amy)).avatar).toBe(time)
    const lobby = club.lobbyView(admin, [admin, amy])
    expect(lobby.members.find((m) => m.id === amy)?.avatar).toBe(time)
    expect(lobby.members.find((m) => m.id === admin)?.avatar).toBeUndefined()
    expect(lobby.online.find((u) => u.id === amy)?.avatar).toBe(time)
    // Survives the object being evicted
    const again = new ClubService(store, connections, { maxUsers: 20, now: () => time, schedule: () => undefined })
    await again.load()
    expect((await again.avatar(amy))?.version).toBe(time)
  })

  it("puts the version and the display name in the handbook's member list (BridgeBook e11-t01)", async () => {
    const amy = await member('amy')
    await club.setProfile(amy, { displayName: '王小美' })
    await club.setAvatar(amy, picture(WEBP))
    const list = club.memberDirectory()
    expect(list.find((m) => m.id === amy)).toEqual({ id: amy, username: 'amy', displayName: '王小美', avatar: time })
    expect(list.find((m) => m.id === admin)).toEqual({ id: admin, username: 'admin' })
  })

  it('puts the display name on the lobby and tells the online members when it changes (e11-t19)', async () => {
    const amy = await member('amy')
    online = [admin]
    sent.length = 0
    await club.setProfile(amy, { displayName: '王小美', bio: '大三' })
    const lobby = lobbyFrom(sent.filter((s) => s.userId === admin).map((s) => s.message))!
    expect(lobby.members.find((m) => m.id === amy)?.displayName).toBe('王小美')
    expect(club.lobbyView(admin, [admin, amy]).online.find((u) => u.id === amy)?.displayName).toBe('王小美')
    // Only the bio changed: nothing to tell the lobby
    sent.length = 0
    await club.setProfile(amy, { displayName: '王小美', bio: '大四' })
    expect(sent).toEqual([])
    await club.setProfile(amy, {})
    expect(club.lobbyView(admin, [admin, amy]).members.find((m) => m.id === amy)).not.toHaveProperty('displayName')
  })

  it('tells the online members the new version at once', async () => {
    const amy = await member('amy')
    online = [admin]
    await club.setAvatar(amy, picture(JPEG))
    const lobby = lobbyFrom(sent.filter((s) => s.userId === admin).map((s) => s.message))!
    expect(lobby.members.find((m) => m.id === amy)?.avatar).toBe(time)
  })

  it('takes a new version every time, even in the same millisecond', async () => {
    const amy = await member('amy')
    const first = (await club.setAvatar(amy, picture(WEBP))).avatar!
    const second = (await club.setAvatar(amy, picture(PNG))).avatar!
    expect(second).toBeGreaterThan(first)
    expect((await club.avatar(amy))?.type).toBe('image/png')
  })

  it('refuses a picture too large or not an image', async () => {
    const amy = await member('amy')
    await expect(club.setAvatar(amy, picture(WEBP, AVATAR_MAX_BYTES + 1))).rejects.toMatchObject({ code: 'avatarTooLarge', status: 413 })
    await expect(club.setAvatar(amy, new TextEncoder().encode('<svg onload="alert(1)"/>'))).rejects.toMatchObject({
      code: 'avatarBadFormat',
      status: 415,
    })
    await expect(club.setAvatar(amy, picture(WEBP, AVATAR_MAX_BYTES))).resolves.toHaveProperty('avatar')
  })

  it('reads an upload only up to the limit', async () => {
    const put = (body: Uint8Array<ArrayBuffer>, headers: Record<string, string> = {}) =>
      new Request('https://club.test/api/account/avatar', { method: 'PUT', body, headers })
    expect((await readAvatarUpload(put(picture(JPEG, 100)))).length).toBe(100)
    await expect(readAvatarUpload(put(picture(JPEG, AVATAR_MAX_BYTES + 1)))).rejects.toMatchObject({ code: 'avatarTooLarge' })
    await expect(
      readAvatarUpload(put(picture(JPEG, 10), { 'Content-Length': String(AVATAR_MAX_BYTES + 1) })),
    ).rejects.toMatchObject({ code: 'avatarTooLarge' })
  })

  it('limits how often a member changes it', async () => {
    const amy = await member('amy')
    for (let i = 0; i < AVATAR_BURST; i++) await club.setAvatar(amy, picture(WEBP))
    await expect(club.setAvatar(amy, picture(WEBP))).rejects.toMatchObject({ code: 'slowDown', status: 429 })
    await expect(club.deleteAvatar(amy)).rejects.toMatchObject({ code: 'slowDown' })
    time += 60_000
    await expect(club.setAvatar(amy, picture(WEBP))).resolves.toHaveProperty('avatar')
  })
})

describe('removing an avatar', () => {
  it('goes back to the default avatar', async () => {
    const amy = await member('amy')
    await club.setAvatar(amy, picture(WEBP))
    const me = await club.deleteAvatar(amy)
    expect(me.avatar).toBeUndefined()
    expect(await club.avatar(amy)).toBeUndefined()
    expect(store.data.has(`avatar:${amy}`)).toBe(false)
    expect((await club.memberProfile(admin, amy)).avatar).toBeUndefined()
    // Removing none is fine
    await expect(club.deleteAvatar(amy)).resolves.not.toHaveProperty('avatar')
  })

  it('only ever changes the member’s own picture', async () => {
    const amy = await member('amy')
    const bob = await member('bob')
    await club.setAvatar(amy, picture(WEBP))
    await club.setAvatar(bob, picture(JPEG))
    await club.deleteAvatar(bob)
    expect((await club.avatar(amy))?.type).toBe('image/webp')
    expect(await club.avatar(bob)).toBeUndefined()
  })

  it('goes with a deleted account', async () => {
    const amy = await member('amy')
    await club.setAvatar(amy, picture(WEBP))
    await club.adminDeleteUser(admin, amy)
    expect(store.data.has(`avatar:${amy}`)).toBe(false)
  })
})

describe('GET /api/avatar/:id', () => {
  const get = (url: string, headers: Record<string, string> = {}) => new Request(`https://club.test${url}`, { headers })

  it('keeps the current version for a year and checks any other each time', async () => {
    const amy = await member('amy')
    const { avatar: version } = await club.setAvatar(amy, picture(WEBP))
    const stored = await club.avatar(amy)
    const current = avatarResponse(stored, get(avatarUrl(amy, version!)))
    expect(current.status).toBe(200)
    expect(current.headers.get('Content-Type')).toBe('image/webp')
    expect(current.headers.get('Cache-Control')).toBe(AVATAR_LONG_CACHE)
    expect(current.headers.get('ETag')).toBe(`"avatar-${version}"`)
    expect(current.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect((await current.arrayBuffer()).byteLength).toBe(2000)
    const old = avatarResponse(stored, get(avatarUrl(amy, version! - 5)))
    expect(old.headers.get('Cache-Control')).toBe(AVATAR_CHECK_CACHE)
    expect(avatarResponse(stored, get(`/api/avatar/${amy}`)).headers.get('Cache-Control')).toBe(AVATAR_CHECK_CACHE)
  })

  it('answers 304 when the browser has this version', async () => {
    const amy = await member('amy')
    const { avatar: version } = await club.setAvatar(amy, picture(PNG))
    const stored = await club.avatar(amy)
    const same = avatarResponse(stored, get(`/api/avatar/${amy}`, { 'If-None-Match': `W/"avatar-${version}"` }))
    expect(same.status).toBe(304)
    expect(same.headers.get('ETag')).toBe(`"avatar-${version}"`)
    expect(avatarResponse(stored, get(`/api/avatar/${amy}`, { 'If-None-Match': '"avatar-1"' })).status).toBe(200)
  })

  it('is 404 for a member without a picture or no member at all', async () => {
    const amy = await member('amy')
    expect(() => avatarResponse(undefined, get(`/api/avatar/${amy}`))).toThrow(expect.objectContaining({ code: 'noAvatar', status: 404 }))
    expect(await club.avatar(amy)).toBeUndefined()
    expect(await club.avatar('nobody')).toBeUndefined()
  })
})
