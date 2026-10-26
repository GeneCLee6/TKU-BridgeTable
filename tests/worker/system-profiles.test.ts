// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { type Me, PROFILE_LIMITS, type ProfileInput } from '../../shared/protocol.ts'
import { anonymousProfileResponse, checkProfileInput, emptyClubProfile, ProfileService } from '../../worker/profiles.ts'
import { MemoryStore } from '../../worker/store.ts'

const amy: Me = { id: 'u1', username: 'amy', admin: false, permissions: ['bookEdit'] }
const ben: Me = { id: 'u2', username: 'ben', admin: false, permissions: ['bookEdit'] }
const NAMES: Record<string, string> = { u1: 'amy', u2: 'ben' }

const input = (extra: Partial<ProfileInput> = {}): ProfileInput => ({
  name: 'A 隊',
  scope: 'team',
  adopted: { lebensohl: 'off' },
  overrides: [{ kind: 'row', slug: 'stayman', sectionId: 'responses', blockIndex: 0, rowIndex: 1, meaning: '4♥' }],
  notes: [{ slug: 'stayman', text: '記得問', by: 'u1', at: 1 }],
  ...extra,
})

let store: MemoryStore
let profiles: ProfileService
let time: number

beforeEach(() => {
  store = new MemoryStore()
  time = 1_000_000
  profiles = new ProfileService(store, () => time, (id) => NAMES[id])
})

describe('system profile storage', () => {
  it("always has the club's profile, empty at version 0 until it is saved", async () => {
    expect(await profiles.list()).toEqual([
      { id: 'club', name: '社團預設', scope: 'club', version: 0, updatedAt: 0, updatedBy: '', counts: { adopted: 0, overrides: 0, notes: 0 } },
    ])
    expect(await profiles.get('club')).toEqual(emptyClubProfile())
    const saved = await profiles.save(amy, 'club', { profile: input({ name: '社團預設', scope: 'club' }), baseVersion: 0 })
    expect(saved).toMatchObject({ id: 'club', scope: 'club', version: 1, updatedBy: 'u1', updatedAt: time })
    expect(saved).not.toHaveProperty('parentId')
    expect((await profiles.list())[0].counts).toEqual({ adopted: 1, overrides: 1, notes: 1 })
  })

  it('creates, saves with baseVersion and refuses a save made from an old version (409)', async () => {
    const team = await profiles.create(amy, { profile: input(), note: '開隊' })
    expect(team).toMatchObject({ name: 'A 隊', scope: 'team', parentId: 'club', version: 1, updatedBy: 'u1' })
    expect(team.id).toMatch(/^[0-9a-f]{12}$/)

    time += 1000
    const changed = input({ name: 'A 隊（新）' })
    await expect(profiles.save(ben, team.id, { profile: changed, baseVersion: 0 })).rejects.toMatchObject({
      code: 'profileConflict',
      status: 409,
      params: { name: 'amy' },
    })
    const second = await profiles.save(ben, team.id, { profile: changed, baseVersion: 1 })
    expect(second).toMatchObject({ version: 2, updatedBy: 'u2', name: 'A 隊（新）' })
    await expect(profiles.save(amy, team.id, { profile: changed, baseVersion: 1 })).rejects.toMatchObject({ params: { name: 'ben' } })

    // Read back after a reload, from storage
    const reloaded = new ProfileService(store, () => time)
    expect(await reloaded.get(team.id)).toEqual(second)
    expect((await reloaded.list()).map((p) => p.id)).toEqual(['club', team.id])
  })

  it('keeps every version and loads an old one', async () => {
    const team = await profiles.create(amy, { profile: input(), note: '開隊' })
    await profiles.save(ben, team.id, { profile: input({ adopted: {} }), baseVersion: 1, note: '全採用' })
    const revisions = await profiles.revisions(team.id)
    expect(revisions.map((r) => [r.version, r.by, r.note])).toEqual([
      [2, 'u2', '全採用'],
      [1, 'u1', '開隊'],
    ])
    expect(revisions[0]).not.toHaveProperty('profile')
    expect((await profiles.revision(team.id, 1)).profile).toMatchObject({ version: 1, adopted: { lebensohl: 'off' } })
    await expect(profiles.revision(team.id, 9)).rejects.toMatchObject({ code: 'profileGone', status: 404 })
    expect(await profiles.revisions('club')).toEqual([])
  })

  it('keeps large profiles in parts', async () => {
    const section = { id: 'big', title: '大段落', blocks: [{ kind: 'paragraph', text: '字'.repeat(50_000) }] }
    const big = input({ overrides: [{ kind: 'section', slug: 'stayman', sectionId: 'big', section }] })
    const team = await profiles.create(amy, { profile: big })
    expect([...(await store.list('bookpart:book:profile:')).keys()].length).toBeGreaterThan(1)
    expect(await new ProfileService(store).get(team.id)).toEqual(team)
  })

  it('never deletes the club, nor a profile another one inherits', async () => {
    await expect(profiles.remove('club', { baseVersion: 0 })).rejects.toMatchObject({ code: 'profileProtected', status: 403 })
    const team = await profiles.create(amy, { profile: input() })
    const pair = await profiles.create(amy, { profile: input({ name: '小明＋小華', scope: 'partnership', parentId: team.id }) })
    await expect(profiles.remove(team.id, { baseVersion: 1 })).rejects.toMatchObject({ code: 'profileInUse', status: 409, params: { name: '小明＋小華' } })
    // Nor turn a team with partnerships into a partnership
    await expect(profiles.save(amy, team.id, { profile: input({ scope: 'partnership' }), baseVersion: 1 })).rejects.toMatchObject({ code: 'profileInUse' })

    await expect(profiles.remove(pair.id, { baseVersion: 0 })).rejects.toMatchObject({ code: 'profileConflict' })
    await profiles.remove(pair.id, { baseVersion: 1 })
    await profiles.remove(team.id, { baseVersion: 1 })
    expect((await profiles.list()).map((p) => p.id)).toEqual(['club'])
    expect([...(await store.list('book:profile')).keys()]).toEqual([])
    expect([...(await store.list('bookpart:book:profile')).keys()]).toEqual([])
    await expect(profiles.get(team.id)).rejects.toMatchObject({ code: 'profileGone', status: 404 })
    await expect(profiles.remove(team.id, { baseVersion: 1 })).rejects.toMatchObject({ code: 'profileGone' })
  })

  it('keeps the layers: a team under the club, a partnership under the club or a team', async () => {
    const team = await profiles.create(amy, { profile: input() })
    const pair = await profiles.create(amy, { profile: input({ scope: 'partnership', parentId: team.id }) })
    await profiles.create(amy, { profile: input({ scope: 'partnership' }) })
    const bad = (profile: ProfileInput) => expect(profiles.create(amy, { profile })).rejects.toMatchObject({ code: 'badContent' })
    await bad(input({ parentId: team.id }))
    await bad(input({ scope: 'partnership', parentId: pair.id }))
    await bad(input({ parentId: 'nobody' }))
    await bad(input({ scope: 'club' }))
    await expect(profiles.save(amy, 'club', { profile: input(), baseVersion: 0 })).rejects.toMatchObject({ code: 'badContent' })
    await expect(profiles.save(amy, team.id, { profile: input({ scope: 'club' }), baseVersion: 1 })).rejects.toMatchObject({ code: 'badContent' })
    await expect(profiles.save(amy, 'nobody', { profile: input(), baseVersion: 0 })).rejects.toMatchObject({ code: 'profileGone' })
  })

  it('enforces the size and count limits', async () => {
    const row = { kind: 'row' as const, slug: 'stayman', sectionId: 'r', blockIndex: 0, rowIndex: 0, meaning: 'x' }
    const tooMany = input({ overrides: Array.from({ length: PROFILE_LIMITS.overridesMax + 1 }, () => row) })
    await expect(profiles.create(amy, { profile: tooMany })).rejects.toMatchObject({ code: 'badContent' })
    await profiles.create(amy, { profile: input({ overrides: Array.from({ length: PROFILE_LIMITS.overridesMax }, () => row) }) })

    // 200 kB of UTF-8: a Chinese character is 3 bytes
    const huge = input({ notes: [{ slug: 'a', text: '字'.repeat(1_900), by: 'u1', at: 1 }] })
    huge.notes = Array.from({ length: 40 }, () => huge.notes[0])
    await expect(profiles.create(amy, { profile: huge })).rejects.toMatchObject({ code: 'contentTooLarge', status: 413 })

    for (let i = 1; i < PROFILE_LIMITS.profilesMax; i++) await profiles.create(amy, { profile: input({ overrides: [] }) })
    await expect(profiles.create(amy, { profile: input() })).rejects.toMatchObject({ code: 'badContent', params: { reason: `制度集最多 ${PROFILE_LIMITS.profilesMax} 個` } })
  })
})

describe('checkProfileInput', () => {
  const reason = (value: unknown) => {
    try {
      checkProfileInput(value)
      return ''
    } catch (error) {
      return (error as { params: { reason: string } }).params.reason
    }
  }

  it('keeps only the editable fields', () => {
    const value = { ...input(), id: 'sneaky', version: 99, updatedBy: 'x', extra: 1 }
    expect(checkProfileInput(value)).toEqual(input())
  })

  it('checks every field', () => {
    expect(reason(null)).toBe('不是一個制度集')
    expect(reason(input({ name: ' ' }))).toMatch('名稱')
    expect(reason(input({ name: '字'.repeat(PROFILE_LIMITS.nameMax + 1) }))).toMatch('名稱')
    expect(reason({ ...input(), scope: 'pair' })).toMatch('scope')
    expect(reason({ ...input(), adopted: { Lebensohl: 'on' } })).toMatch('採用')
    expect(reason({ ...input(), adopted: { lebensohl: true } })).toMatch('採用')
    expect(reason({ ...input(), overrides: [{ kind: 'row', slug: 's', sectionId: 'r', blockIndex: -1, rowIndex: 0, meaning: '' }] })).toMatch('位置')
    expect(reason({ ...input(), overrides: [{ kind: 'section', slug: 's', sectionId: 'a', section: { id: 'b', title: 'x' } }] })).toMatch('sectionId')
    expect(reason({ ...input(), overrides: [{ kind: 'section', slug: 's', sectionId: 'a', section: { id: 'a', title: 'x', blocks: [{ kind: 'video' }] } }] })).toBe('不明的內容區塊')
    expect(reason({ ...input(), overrides: [{ kind: 'meta', slug: 's', tags: 'x' }] })).toMatch('標籤')
    expect(reason({ ...input(), overrides: [{ kind: 'other', slug: 's' }] })).toBe('不明的覆寫種類')
    expect(reason({ ...input(), notes: [{ slug: 's', text: '', by: 'u1', at: 1 }] })).toMatch('文字')
    expect(reason({ ...input(), notes: [{ slug: 's', text: '字'.repeat(PROFILE_LIMITS.noteMax + 1), by: 'u1', at: 1 }] })).toMatch('最多')
    expect(reason({ ...input(), notes: [{ slug: 's', text: 'x' }] })).toMatch('作者')
    expect(reason(input({ overrides: [{ kind: 'meta', slug: 's', summary: '新摘要' }] }))).toBe('')
  })

  it('keeps who may read it: for its members only, or the whole club when absent (e2-t04)', () => {
    expect(checkProfileInput(input({ visibility: 'members' }))).toEqual(input({ visibility: 'members' }))
    expect(checkProfileInput(input({ visibility: 'club' }))).toEqual(input())
    expect(reason({ ...input(), visibility: 'team' })).toMatch('visibility')
    expect(reason(input({ scope: 'club', visibility: 'members' }))).toMatch('全社團')
  })
})

describe('reading without signing in', () => {
  const get = (path: string) => anonymousProfileResponse(profiles, new Request(`https://x${path}`), path)

  it("gets the club's profile only, without its private notes", async () => {
    await profiles.save(amy, 'club', { profile: input({ name: '社團預設', scope: 'club' }), baseVersion: 0 })
    const team = await profiles.create(amy, { profile: input() })
    expect(await get('/api/book/profiles')).toEqual([expect.objectContaining({ id: 'club', counts: { adopted: 1, overrides: 1, notes: 0 } })])
    expect(await get('/api/book/profiles/club')).toMatchObject({ id: 'club', notes: [], overrides: [expect.anything()] })
    expect(await get(`/api/book/profiles/${team.id}`)).toBeNull()
    expect(await get('/api/book/profiles/club/revisions')).toBeNull()
    expect(await anonymousProfileResponse(profiles, new Request('https://x/api/book/profiles', { method: 'POST' }), '/api/book/profiles')).toBeNull()
  })
})
