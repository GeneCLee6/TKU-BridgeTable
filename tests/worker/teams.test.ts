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
    members: () => ['cat', 'amy', 'ben'].map((id) => ({ id, username: `n${id}` })),
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

describe("the team's own settings (e2-t10) and the member directory", () => {
  it('lets the captain open the team profile to its members, and close it again', async () => {
    const team = await newTeam()
    await expect(teams.updateTeam(ben, team.id, { membersEdit: true })).rejects.toMatchObject({ code: 'noPermission' })
    await expect(teams.updateTeam(amy, team.id, { membersEdit: 'yes' })).rejects.toMatchObject({ code: 'badContent' })
    expect(await teams.updateTeam(amy, team.id, { membersEdit: true })).toMatchObject({ membersEdit: true })
    expect(await teams.updateTeam(editor, team.id, { membersEdit: false })).not.toHaveProperty('membersEdit')
    await teams.updateTeam(amy, team.id, { archived: true })
    await expect(teams.updateTeam(amy, team.id, { membersEdit: true })).rejects.toMatchObject({ code: 'teamArchived' })
  })

  it('lists the members by name', () => {
    expect(teams.members().map((m) => m.username)).toEqual(['namy', 'nben', 'ncat'])
  })

  it("gives a member's teams and active partnerships for their profile page (BridgeHall e11-t04)", async () => {
    const team = await newTeam()
    const active = await teams.invite(ben, { partnerId: 'amy', teamId: team.id })
    await teams.accept(amy, active.id)
    // An invitation stays between the two
    await teams.invite(ben, { partnerId: 'cat' })
    const benTeams = await teams.memberTeams('ben')
    expect(benTeams.teams.map((t) => t.id)).toEqual([team.id])
    expect(benTeams.pairs.map((p) => p.id)).toEqual([active.id])
    expect(await teams.memberTeams('cat')).toEqual({ teams: [], pairs: [] })
  })
})

describe("profiles' member rights (e2-t04, AC-2.3)", () => {
  const input = (profile: { name: string; scope: string; parentId?: string; visibility?: string }, extra: Record<string, unknown> = {}) => ({
    ...profile,
    adopted: { bergen: 'off' },
    overrides: [],
    notes: [{ slug: 'bergen', text: '記得', by: 'amy', at: 1 }],
    ...extra,
  })
  const save = (who: Me, id: string, profile: Record<string, unknown>, baseVersion: number) => teams.saveProfile(who, id, { profile, baseVersion })

  it("lets a team's captain save its profile, and its members only when the captain lets them", async () => {
    const team = await newTeam()
    const base = { name: 'A 隊', scope: 'team', parentId: 'club' }
    await expect(save(ben, team.profileId, input(base), 1)).rejects.toMatchObject({ code: 'noPermission', status: 403 })
    await expect(save(cat, team.profileId, input(base), 1)).rejects.toMatchObject({ code: 'noPermission', status: 403 })
    expect(await save(amy, team.profileId, input(base), 1)).toMatchObject({ version: 2, updatedBy: 'amy' })
    await teams.updateTeam(amy, team.id, { membersEdit: true })
    expect(await save(ben, team.profileId, input(base), 2)).toMatchObject({ version: 3, updatedBy: 'ben' })
    await expect(save(cat, team.profileId, input(base), 3)).rejects.toMatchObject({ code: 'noPermission' })
    expect(await save(editor, team.profileId, input(base), 3)).toMatchObject({ version: 4 })
  })

  it("leaves who reads a team's profile to its captain, and what it is to the editors", async () => {
    const team = await newTeam({ memberIds: ['ben'] })
    await teams.updateTeam(amy, team.id, { membersEdit: true })
    const base = { name: 'A 隊', scope: 'team', parentId: 'club' }
    await expect(save(ben, team.profileId, input({ ...base, visibility: 'members' }), 1)).rejects.toMatchObject({ code: 'noPermission' })
    expect(await save(amy, team.profileId, input({ ...base, visibility: 'members' }), 1)).toMatchObject({ visibility: 'members' })
    // A member keeping the visibility as it is may save
    expect(await save(ben, team.profileId, input({ ...base, visibility: 'members' }), 2)).toMatchObject({ version: 3 })
    await expect(save(amy, team.profileId, input({ ...base, scope: 'partnership' }), 3)).rejects.toMatchObject({ code: 'noPermission' })
    const other = await teams.createTeam(editor, { name: 'B 隊', captainId: 'cat' })
    await expect(save(amy, team.profileId, input({ ...base, visibility: 'members', parentId: other.profileId }), 3)).rejects.toMatchObject({
      code: 'noPermission',
    })
    expect(await save(editor, team.profileId, input({ ...base, name: '新名' }), 3)).toMatchObject({ name: '新名' })
  })

  it("lets both partners save their profile while the partnership lasts, read-only once it ends", async () => {
    const pair = await teams.accept(ben, (await teams.invite(amy, { partnerId: 'ben' })).id)
    const base = { name: 'namy＋nben', scope: 'partnership', parentId: 'club', visibility: 'members' }
    expect(await save(amy, pair.profileId, input(base), 1)).toMatchObject({ version: 2, visibility: 'members' })
    expect(await save(ben, pair.profileId, input(base), 2)).toMatchObject({ version: 3 })
    await expect(save(cat, pair.profileId, input(base), 3)).rejects.toMatchObject({ code: 'noPermission' })
    await teams.end(amy, pair.id)
    await expect(save(ben, pair.profileId, input(base), 3)).rejects.toMatchObject({ code: 'noPermission' })
    // Its versions stay theirs to look at
    expect(await teams.profileRevisions(ben, pair.profileId)).toHaveLength(3)
    await expect(teams.profileRevisions(cat, pair.profileId)).rejects.toMatchObject({ code: 'noPermission' })
    expect((await teams.profileRevision(amy, pair.profileId, 2)).profile).toMatchObject({ version: 2 })
    await expect(teams.profileRevision(cat, pair.profileId, 2)).rejects.toMatchObject({ code: 'noPermission' })
  })

  it("lets only the editors save the club's", async () => {
    await expect(save(amy, 'club', input({ name: '社團預設', scope: 'club' }), 0)).rejects.toMatchObject({ code: 'noPermission' })
    expect(await save(editor, 'club', input({ name: '社團預設', scope: 'club' }), 0)).toMatchObject({ version: 1 })
    expect((await teams.readProfile(cat, 'club')).profile.notes).toHaveLength(1)
    await expect(teams.profileRevisions(cat, 'club')).rejects.toMatchObject({ code: 'noPermission' })
  })

  it('hides the notes from those outside, and a members-only profile altogether', async () => {
    const team = await newTeam()
    await save(amy, team.profileId, input({ name: 'A 隊', scope: 'team', parentId: 'club' }), 1)
    const outside = await teams.readProfile(cat, team.profileId)
    expect(outside.profile.notes).toEqual([])
    expect(outside.access).toEqual({ notes: false, edit: false, share: false })
    expect(await teams.readProfile(ben, team.profileId)).toMatchObject({ access: { notes: true, edit: false, share: false } })
    expect((await teams.readProfile(ben, team.profileId)).profile.notes).toHaveLength(1)
    expect((await teams.readProfile(amy, team.profileId)).access).toEqual({ notes: true, edit: true, share: true })
    const listed = (who: Me) => teams.readableProfiles(who).then((list) => list.find((p) => p.id === team.profileId))
    expect((await listed(cat))?.counts.notes).toBe(0)
    expect((await listed(ben))?.counts.notes).toBe(1)

    await save(amy, team.profileId, input({ name: 'A 隊', scope: 'team', parentId: 'club', visibility: 'members' }), 2)
    await expect(teams.readProfile(cat, team.profileId)).rejects.toMatchObject({ code: 'noPermission', status: 403 })
    expect(await listed(cat)).toBeUndefined()
    expect(await listed(ben)).toMatchObject({ visibility: 'members' })
    expect(await listed(editor)).toMatchObject({ counts: { notes: 1 } })
    expect((await teams.readProfile(editor, team.profileId)).profile.notes).toHaveLength(1)
    await expect(teams.readProfile(cat, 'nothing')).rejects.toMatchObject({ code: 'profileGone', status: 404 })
  })

  it("hides a partnership's profile from those who may not read its team's", async () => {
    const team = await newTeam()
    await save(amy, team.profileId, input({ name: 'A 隊', scope: 'team', parentId: 'club', visibility: 'members' }), 1)
    const pair = await teams.accept(ben, (await teams.invite(amy, { partnerId: 'ben', teamId: team.id })).id)
    await expect(teams.readProfile(cat, pair.profileId)).rejects.toMatchObject({ code: 'noPermission' })
    expect((await teams.readableProfiles(cat)).map((p) => p.id)).toEqual(['club'])
    expect((await teams.readableProfiles(ben)).map((p) => p.id)).toEqual(['club', team.profileId, pair.profileId])
  })

  it('keeps a profile nobody owns to the editors', async () => {
    const made = await profiles.create(editor, { profile: input({ name: '自由', scope: 'team' }) })
    await expect(save(amy, made.id, input({ name: '自由', scope: 'team', parentId: 'club' }), 1)).rejects.toMatchObject({ code: 'noPermission' })
    expect((await teams.readProfile(amy, made.id)).profile.notes).toEqual([])
  })
})
