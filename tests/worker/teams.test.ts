// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { type Me, type NotificationKind, PROFILE_LIMITS, TEAM_LIMITS } from '../../shared/protocol.ts'
import { ProfileService } from '../../worker/profiles.ts'
import { MemoryStore } from '../../worker/store.ts'
import { TeamService } from '../../worker/teams.ts'

const me = (id: string, permissions: Me['permissions'] = []): Me => ({ id, username: `n${id}`, admin: false, permissions })
const editor = me('ed', ['bookEdit'])
const amy = me('amy')
const ben = me('ben')
const cat = me('cat')
const USERS = new Set(['ed', 'amy', 'ben', 'cat', ...Array.from({ length: 20 }, (_, i) => `x${i}`)])

let store: MemoryStore
let profiles: ProfileService
let teams: TeamService
let sent: { to: string; kind: NotificationKind; params: Record<string, string | number> }[]
let time: number
let ids: number

beforeEach(() => {
  store = new MemoryStore()
  time = 1_000
  ids = 0
  sent = []
  profiles = new ProfileService(store, () => time)
  teams = new TeamService(store, {
    now: () => time,
    newId: () => `id${++ids}`,
    usernameOf: (id) => (USERS.has(id) ? `n${id}` : undefined),
    notify: async (to, kind, params) => void sent.push({ to, kind, params }),
    profiles: () => profiles,
  })
})

const newTeam = (extra: Record<string, unknown> = {}) => teams.createTeam(editor, { name: 'A 隊', captainId: 'amy', memberIds: ['ben'], ...extra })

describe('teams (e2-t01, e2-t02)', () => {
  it('makes a team with its captain among the members and its own profile inheriting the club', async () => {
    const team = await newTeam()
    expect(team).toEqual({ id: 'id1', name: 'A 隊', captainId: 'amy', memberIds: ['amy', 'ben'], profileId: team.profileId, createdAt: 1_000 })
    expect(await profiles.get(team.profileId)).toMatchObject({ name: 'A 隊', scope: 'team', parentId: 'club', version: 1, updatedBy: 'ed' })
    expect(await store.get('team:id1')).toEqual(team)
    expect(await teams.teamIdsOf('ben')).toEqual(['id1'])
    expect(await teams.teams()).toEqual([team])
  })

  it('checks the name, the members and the size of the team', async () => {
    await expect(newTeam({ name: ' ' })).rejects.toMatchObject({ code: 'badContent' })
    await expect(newTeam({ name: 'x'.repeat(TEAM_LIMITS.nameMax + 1) })).rejects.toMatchObject({ code: 'badContent' })
    await expect(newTeam({ captainId: 'ghost' })).rejects.toMatchObject({ code: 'badContent' })
    await expect(newTeam({ memberIds: ['ghost'] })).rejects.toMatchObject({ code: 'badContent' })
    const nine = Array.from({ length: TEAM_LIMITS.membersMax }, (_, i) => `x${i}`)
    await expect(newTeam({ memberIds: nine })).rejects.toMatchObject({ code: 'teamFull', status: 409 })
    // Nothing was written by the refused ones
    expect(await teams.teams()).toEqual([])
    expect(await profiles.list()).toHaveLength(1)
  })

  it('makes no team when the club has as many profiles as it may', async () => {
    for (let i = 0; i < PROFILE_LIMITS.profilesMax; i++) await profiles.createOwned('ed', `p${i}`, 'team', 'club', '')
    await expect(newTeam()).rejects.toMatchObject({ code: 'badContent' })
    expect(await teams.teams()).toEqual([])
  })

  it("lets the captain and the editors rename, change captain, add and remove members, but not other members", async () => {
    const team = await newTeam()
    await expect(teams.updateTeam(ben, team.id, { name: 'B' })).rejects.toMatchObject({ code: 'noPermission', status: 403 })
    await expect(teams.addMember(ben, team.id, { userId: 'cat' })).rejects.toMatchObject({ code: 'noPermission' })
    expect(await teams.updateTeam(amy, team.id, { name: ' 新 A 隊 ' })).toMatchObject({ name: '新 A 隊' })
    expect(await teams.addMember(amy, team.id, { userId: 'cat' })).toMatchObject({ memberIds: ['amy', 'ben', 'cat'] })
    await expect(teams.updateTeam(amy, team.id, { captainId: 'ed' })).rejects.toMatchObject({ code: 'badContent' })
    expect(await teams.updateTeam(editor, team.id, { captainId: 'ben' })).toMatchObject({ captainId: 'ben' })
    // amy is no longer captain
    await expect(teams.removeMember(amy, team.id, 'cat')).rejects.toMatchObject({ code: 'noPermission' })
    await expect(teams.removeMember(editor, team.id, 'ben')).rejects.toMatchObject({ code: 'badContent' })
    expect(await teams.removeMember(ben, team.id, 'cat')).toMatchObject({ memberIds: ['amy', 'ben'] })
    expect(await teams.teamIdsOf('cat')).toEqual([])
  })

  it('lets a member leave a team themselves', async () => {
    const team = await newTeam()
    expect(await teams.removeMember(ben, team.id, 'ben')).toMatchObject({ memberIds: ['amy'] })
  })

  it('stops at TEAM_LIMITS.membersMax members', async () => {
    const team = await newTeam({ memberIds: Array.from({ length: TEAM_LIMITS.membersMax - 1 }, (_, i) => `x${i}`) })
    await expect(teams.addMember(amy, team.id, { userId: 'cat' })).rejects.toMatchObject({ code: 'teamFull', params: { max: 8 } })
  })

  it('archives a team, which then only can be brought back, and lists it last', async () => {
    const a = await newTeam({ name: 'A' })
    const b = await newTeam({ name: 'B' })
    expect(await teams.updateTeam(amy, a.id, { archived: true })).toMatchObject({ archived: true })
    expect((await teams.teams()).map((t) => t.name)).toEqual(['B', 'A'])
    await expect(teams.updateTeam(amy, a.id, { name: 'C' })).rejects.toMatchObject({ code: 'teamArchived', status: 409 })
    await expect(teams.addMember(amy, a.id, { userId: 'cat' })).rejects.toMatchObject({ code: 'teamArchived' })
    await expect(teams.removeMember(amy, a.id, 'ben')).rejects.toMatchObject({ code: 'teamArchived' })
    const back = await teams.updateTeam(amy, a.id, { archived: false })
    expect(back).not.toHaveProperty('archived')
    expect(b.archived).toBeUndefined()
  })

  it('answers 404 for a team that is not there', async () => {
    await expect(teams.team('nope')).rejects.toMatchObject({ code: 'teamGone', status: 404 })
  })
})

describe('partnerships (e2-t01, e2-t03)', () => {
  it('invites with a notification; accepting makes it active with a profile inheriting the club', async () => {
    const pair = await teams.invite(amy, { partnerId: 'ben' })
    expect(pair).toEqual({ id: 'id1', userIds: ['amy', 'ben'], profileId: '', createdAt: 1_000, status: 'pending' })
    expect(sent).toEqual([{ to: 'ben', kind: 'pairInvited', params: { pairId: 'id1', username: 'namy' } }])
    expect(await teams.pairsOf('ben')).toEqual([pair])
    expect(await profiles.list()).toHaveLength(1)

    await expect(teams.accept(amy, pair.id)).rejects.toMatchObject({ code: 'noPermission' })
    time = 2_000
    const active = await teams.accept(ben, pair.id)
    expect(active).toMatchObject({ status: 'active', acceptedAt: 2_000 })
    expect(await profiles.get(active.profileId)).toMatchObject({ name: 'namy＋nben', scope: 'partnership', parentId: 'club' })
    expect(sent.at(-1)).toEqual({ to: 'amy', kind: 'pairAccepted', params: { pairId: 'id1', username: 'nben' } })
    await expect(teams.accept(ben, pair.id)).rejects.toMatchObject({ code: 'pairAnswered', status: 409 })
  })

  it("gives a team's partnership a profile inheriting the team's, and lists it on the team", async () => {
    const team = await newTeam()
    const pair = await teams.invite(ben, { partnerId: 'amy', teamId: team.id })
    const active = await teams.accept(amy, pair.id)
    expect(await profiles.get(active.profileId)).toMatchObject({ parentId: team.profileId })
    expect((await teams.team(team.id)).pairs).toEqual([active])
    // Both have to be on the team
    await expect(teams.invite(amy, { partnerId: 'cat', teamId: team.id })).rejects.toMatchObject({ code: 'badContent' })
  })

  it('refuses a second invitation between the same two, yourself and members who are not there', async () => {
    await teams.invite(amy, { partnerId: 'ben' })
    await expect(teams.invite(ben, { partnerId: 'amy' })).rejects.toMatchObject({ code: 'pairExists', status: 409 })
    await expect(teams.invite(amy, { partnerId: 'amy' })).rejects.toMatchObject({ code: 'badContent' })
    await expect(teams.invite(amy, { partnerId: 'ghost' })).rejects.toMatchObject({ code: 'badContent' })
    // The same two may also be partners for a team
    const team = await newTeam()
    expect(await teams.invite(amy, { partnerId: 'ben', teamId: team.id })).toMatchObject({ teamId: team.id })
  })

  it('lets one member have several partners, up to TEAM_LIMITS.pairsMax pending or active', async () => {
    for (let i = 0; i < TEAM_LIMITS.pairsMax; i++) await teams.invite(amy, { partnerId: `x${i}` })
    await expect(teams.invite(amy, { partnerId: 'ben' })).rejects.toMatchObject({ code: 'pairLimit', params: { max: 10, name: 'namy' } })
    await expect(teams.invite(ben, { partnerId: 'amy' })).rejects.toMatchObject({ code: 'pairLimit', params: { name: 'namy' } })
    // An ended partnership no longer counts
    const first = (await teams.pairsOf('amy')).at(-1)!
    await teams.accept(me(first.userIds[1]), first.id)
    await teams.end(amy, first.id)
    expect(await teams.invite(amy, { partnerId: 'ben' })).toMatchObject({ status: 'pending' })
  })

  it('declining removes the invitation and tells the inviter', async () => {
    const pair = await teams.invite(amy, { partnerId: 'ben' })
    await expect(teams.decline(amy, pair.id)).rejects.toMatchObject({ code: 'noPermission' })
    await teams.decline(ben, pair.id)
    expect(sent.at(-1)).toEqual({ to: 'amy', kind: 'pairDeclined', params: { pairId: 'id1', username: 'nben' } })
    await expect(teams.pair(pair.id)).rejects.toMatchObject({ code: 'pairGone', status: 404 })
    expect(await teams.pairsOf('amy')).toEqual([])
    expect(await teams.pairsOf('ben')).toEqual([])
  })

  it('lets the inviter take an invitation back without telling anyone', async () => {
    const pair = await teams.invite(amy, { partnerId: 'ben' })
    expect(await teams.end(amy, pair.id)).toBeNull()
    expect(sent).toHaveLength(1)
    expect(await teams.pairsOf('ben')).toEqual([])
  })

  it('ending keeps the partnership and its profile, tells the other, and cannot be done twice', async () => {
    const pair = await teams.invite(amy, { partnerId: 'ben' })
    const active = await teams.accept(ben, pair.id)
    await expect(teams.end(cat, pair.id)).rejects.toMatchObject({ code: 'noPermission' })
    time = 5_000
    const ended = await teams.end(ben, pair.id)
    expect(ended).toMatchObject({ status: 'ended', endedAt: 5_000, profileId: active.profileId })
    expect(sent.at(-1)).toEqual({ to: 'amy', kind: 'pairEnded', params: { pairId: 'id1', username: 'nben' } })
    expect(await profiles.get(active.profileId)).toMatchObject({ scope: 'partnership' })
    expect(await teams.pairsOf('amy')).toEqual([ended])
    await expect(teams.end(amy, pair.id)).rejects.toMatchObject({ code: 'pairAnswered' })
  })
})
