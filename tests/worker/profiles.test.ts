// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import type { BoardState } from '../../shared/game.ts'
import { parseProfile, PROFILE_LIMITS, PROFILE_RECENT } from '../../shared/profile.ts'
import type { BoardRecord } from '../../shared/protocol.ts'
import { indexRecord } from '../../worker/history-index.ts'
import { ClubService, type Connections } from '../../worker/service.ts'
import type { MemoryStore } from '../../worker/store.ts'
import { memoryStore } from './sqlite.ts'

const connections: Connections = { onlineUserIds: () => [], send: () => undefined, disconnect: () => undefined }

let store: MemoryStore
let club: ClubService
let time: number
let admin: string

beforeEach(async () => {
  store = memoryStore()
  time = 1_000_000
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

/** A finished board with these four players, saved and indexed as the service does */
async function finished(id: string, at: number, ids: [string, string, string, string], revealAt?: number) {
  const [N, E, S, W] = ids.map((x) => ({ id: x, username: x }))
  const record: BoardRecord = {
    id,
    tableNumber: 1,
    finishedAt: at,
    players: { N, E, S, W },
    board: {
      boardNo: 1,
      dealer: 'N',
      vul: 'None',
      contract: null,
      result: { declarerTricks: 0, scoreNS: 0, claimed: false },
    } as unknown as BoardState,
    ...(revealAt !== undefined && { revealAt }),
  }
  await store.put(`board:${id}`, record)
  indexRecord(store.sql, record)
}

describe('parseProfile', () => {
  it('keeps the four fields, trimmed, and drops empty ones', () => {
    expect(parseProfile({ displayName: '  王 小明 ', level: 'open', system: ' 2/1 ', bio: 'line one\n\n\n\nline  two ' })).toEqual({
      profile: { displayName: '王 小明', level: 'open', system: '2/1', bio: 'line one\n\nline two' },
    })
    expect(parseProfile({ displayName: '', level: '', system: '   ', bio: '' })).toEqual({ profile: {} })
    expect(parseProfile({})).toEqual({ profile: {} })
  })

  it('turns away unknown fields, wrong types, unknown levels and long text', () => {
    expect(parseProfile(null)).toMatchObject({ error: 'badMessage' })
    expect(parseProfile([])).toMatchObject({ error: 'badMessage' })
    expect(parseProfile({ admin: true })).toMatchObject({ error: 'badMessage' })
    expect(parseProfile({ level: 'grandmaster' })).toMatchObject({ error: 'badMessage' })
    expect(parseProfile({ displayName: 5 })).toMatchObject({ error: 'profileNameTooLong' })
    expect(parseProfile({ displayName: '字'.repeat(PROFILE_LIMITS.displayNameMax + 1) })).toMatchObject({
      error: 'profileNameTooLong',
      params: { max: PROFILE_LIMITS.displayNameMax },
    })
    expect(parseProfile({ displayName: '字'.repeat(PROFILE_LIMITS.displayNameMax) })).toHaveProperty('profile')
    expect(parseProfile({ system: 'x'.repeat(PROFILE_LIMITS.systemMax + 1) })).toMatchObject({ error: 'profileSystemTooLong' })
    expect(parseProfile({ bio: 'x'.repeat(PROFILE_LIMITS.bioMax + 1) })).toMatchObject({ error: 'profileBioTooLong' })
  })

  it('removes control characters and keeps line breaks only in the bio', () => {
    expect(parseProfile({ displayName: 'a\nb\u0007c', bio: 'a\r\nb\u0000' })).toEqual({ profile: { displayName: 'a bc', bio: 'a\nb' } })
  })
})

describe('profiles (AC-1.5)', () => {
  it('saves the member’s own profile, returns it with /api/me and keeps it after a reload', async () => {
    const amy = await member('amy')
    const me = await club.setProfile(amy, { displayName: '陳怡君', level: 'college', system: '淡江制度', bio: '大三，打了兩年' })
    expect(me.profile).toEqual({ displayName: '陳怡君', level: 'college', system: '淡江制度', bio: '大三，打了兩年' })

    const again = new ClubService(store, connections, { maxUsers: 20, now: () => time, schedule: () => undefined })
    await again.load()
    expect((await again.memberProfile(admin, amy)).profile.displayName).toBe('陳怡君')

    // Saving empty fields clears them
    expect((await club.setProfile(amy, { displayName: '' })).profile).toBeUndefined()
  })

  it('rejects a bad profile without changing the saved one', async () => {
    const amy = await member('amy')
    await club.setProfile(amy, { displayName: 'Amy' })
    await expect(club.setProfile(amy, { bio: 'x'.repeat(PROFILE_LIMITS.bioMax + 1) })).rejects.toMatchObject({
      code: 'profileBioTooLong',
    })
    await expect(club.setProfile(amy, { username: 'root' })).rejects.toMatchObject({ code: 'badMessage' })
    expect((await club.memberProfile(admin, amy)).profile).toEqual({ displayName: 'Amy' })
  })

  it('shows another member only the public fields', async () => {
    const amy = await member('amy')
    await club.setProfile(amy, { displayName: 'Amy', level: 'master' })
    const card = await club.memberProfile(admin, amy)
    expect(Object.keys(card).sort()).toEqual(['id', 'profile', 'recent', 'username'])
    expect(card).toMatchObject({ id: amy, username: 'amy', profile: { displayName: 'Amy', level: 'master' }, recent: [] })
    // The admin's own card has no admin flag, permissions or settings either
    const adminCard = await club.memberProfile(amy, admin)
    expect(Object.keys(adminCard).sort()).toEqual(['id', 'profile', 'recent', 'username'])
    expect(JSON.stringify(adminCard)).not.toMatch(/passwordHash|admin":|permissions|friendOnlineNotice|lastLoginAt/)
  })

  it('lists the member’s latest ten boards the viewer may see, newest first', async () => {
    const amy = await member('amy')
    const ben = await member('ben')
    const cat = await member('cat')
    for (let i = 0; i < 12; i++) await finished(`b${i}`, 100 + i, [amy, ben, cat, 'robot:gib:W'])
    await finished('other', 200, [ben, cat, admin, 'robot:gib:W'])
    // A board kept back until later: only its players see it
    await finished('kept', 300, [amy, cat, 'robot:gib:E', 'robot:gib:W'], time + 60_000)

    const seenByBen = await club.memberProfile(ben, amy)
    expect(seenByBen.recent).toHaveLength(PROFILE_RECENT)
    expect(seenByBen.recent.map((b) => b.id)).toEqual(['b11', 'b10', 'b9', 'b8', 'b7', 'b6', 'b5', 'b4', 'b3', 'b2'])
    expect((await club.memberProfile(cat, amy)).recent[0].id).toBe('kept')

    time += 120_000
    expect((await club.memberProfile(ben, amy)).recent[0].id).toBe('kept')
  })

  it('turns away unknown members and robots, and asks for a sign-in', async () => {
    await expect(club.memberProfile(admin, 'nobody')).rejects.toMatchObject({ code: 'userGone' })
    await expect(club.memberProfile(admin, 'robot:gib:N')).rejects.toMatchObject({ code: 'userGone' })
    await expect(club.memberProfile('nobody', admin)).rejects.toThrow()
    await expect(club.setProfile('nobody', {})).rejects.toThrow()
  })
})
