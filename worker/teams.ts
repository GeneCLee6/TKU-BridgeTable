import {
  CLUB_PROFILE_ID,
  type ClubMember,
  type Me,
  type Notification,
  type NotificationKind,
  type Partnership,
  type ProfileAccess,
  type ProfileRevision,
  type ProfileSummary,
  type SystemProfile,
  TEAM_LIMITS,
  type ClubTeam,
} from '../shared/protocol.ts'
import { isObject, isString } from './book.ts'
import { checkProfileInput, type ProfileService } from './profiles.ts'
import { allows, managesTeam, profileAccess, type ProfileOwner, type ProfileRights } from './roles.ts'
import { ClubError } from './service.ts'
import type { Store } from './store.ts'

/**
 * Teams and partnerships (隊伍與搭檔, TKU BridgeBook E2): who owns which system profile. A team is
 * made by an editor with its own profile (inheriting the club's); its captain and the editors
 * manage it. A partnership starts as one member's invitation to another (a notification) and gets
 * its profile, inheriting its team's or the club's, when it is accepted. Ending it keeps the
 * profile, read-only.
 *
 * Reading and saving one profile goes through here too (e2-t04): the profile's owner, found by
 * the teams' and partnerships' `profileId`, decides what a member may do (roles.ts `profileAccess`).
 *
 * Keys: `team:<id>` and `pair:<id>` hold a ClubTeam and a Partnership; `userteam:<userId>:<teamId>`
 * and `userpair:<userId>:<pairId>` (value `true`) find a member's. Nothing is cached, so a backup
 * restore needs no reload. Who may call each route is in roles.ts (`clubRouteNeed`); who may
 * change a given team or partnership is checked here.
 */

export interface TeamDeps {
  now: () => number
  newId: () => string
  usernameOf: (userId: string) => string | undefined
  /** Every member, for picking a team's members or a partner */
  members: () => ClubMember[]
  notify: (userId: string, kind: NotificationKind, params: Notification['params']) => Promise<unknown>
  /** The Club replaces its ProfileService after a backup is restored, so it is asked for each time */
  profiles: () => ProfileService
}

const teamKey = (id: string) => `team:${id}`
const pairKey = (id: string) => `pair:${id}`
const userTeamKey = (userId: string, teamId: string) => `userteam:${userId}:${teamId}`
const userPairKey = (userId: string, pairId: string) => `userpair:${userId}:${pairId}`
const lastPart = (key: string) => key.slice(key.lastIndexOf(':') + 1)

const fail = (reason: string): never => {
  throw new ClubError('badContent', { reason })
}

export class TeamService {
  private readonly store: Store
  private readonly deps: TeamDeps

  constructor(store: Store, deps: TeamDeps) {
    this.store = store
    this.deps = deps
  }

  // ── Teams (e2-t02) ─────────────────────────────────────────────────────────────────────────

  /** Every team, archived ones last, each group by name */
  async teams(): Promise<ClubTeam[]> {
    const teams = [...(await this.store.list<ClubTeam>('team:')).values()]
    return teams.sort((a, b) => Number(!!a.archived) - Number(!!b.archived) || a.name.localeCompare(b.name, 'zh-Hant') || a.id.localeCompare(b.id))
  }

  /** A team and its active partnerships */
  async team(id: string): Promise<{ team: ClubTeam; pairs: Partnership[] }> {
    const team = await this.requireTeam(id)
    const pairs = [...(await this.store.list<Partnership>('pair:')).values()]
      .filter((p) => p.teamId === id && p.status === 'active')
      .sort((a, b) => a.createdAt - b.createdAt)
    return { team, pairs }
  }

  /** An editor makes a team (the route checks that) with its captain, members and own profile */
  async createTeam(actor: Me, body: unknown): Promise<ClubTeam> {
    if (!isObject(body)) return fail('不是一個隊伍')
    const name = this.checkName(body.name)
    const captainId = this.checkUser(body.captainId)
    if (body.memberIds !== undefined && !(Array.isArray(body.memberIds) && body.memberIds.every(isString)))
      fail('隊員（memberIds）要是使用者 id 的清單')
    const memberIds = [...new Set([captainId, ...((body.memberIds as string[] | undefined) ?? []).map((id) => this.checkUser(id))])]
    if (memberIds.length > TEAM_LIMITS.membersMax) throw new ClubError('teamFull', { max: TEAM_LIMITS.membersMax }, 409)

    let id = this.deps.newId()
    while (await this.store.get(teamKey(id))) id = this.deps.newId()
    // The profile first: if the club already has as many as it may, no team is left without one
    const profile = await this.deps.profiles().createOwned(actor.id, name, 'team', CLUB_PROFILE_ID, '開隊')
    const team: ClubTeam = { id, name, captainId, memberIds, profileId: profile.id, createdAt: this.deps.now() }
    await this.store.put(teamKey(id), team)
    for (const userId of memberIds) await this.store.put(userTeamKey(userId, id), true)
    return team
  }

  /**
   * Rename, a new captain (one of the members), letting the members edit the team's profile
   * (`membersEdit`, e2-t10) or archiving; an archived team can only be brought back
   */
  async updateTeam(actor: Me, id: string, body: unknown): Promise<ClubTeam> {
    const team = await this.requireManaged(actor, id, true)
    if (!isObject(body)) return fail('不是一個隊伍')
    if (team.archived && (body.archived !== false || body.name !== undefined || body.captainId !== undefined || body.membersEdit !== undefined))
      throw new ClubError('teamArchived', {}, 409)
    if (body.membersEdit !== undefined) {
      if (typeof body.membersEdit !== 'boolean') fail('開放隊員編輯（membersEdit）要是 true 或 false')
      if (body.membersEdit) team.membersEdit = true
      else delete team.membersEdit
    }
    if (body.name !== undefined) team.name = this.checkName(body.name)
    if (body.captainId !== undefined) {
      if (!isString(body.captainId) || !team.memberIds.includes(body.captainId)) fail('隊長要是這一隊的隊員')
      team.captainId = body.captainId as string
    }
    if (body.archived !== undefined) {
      if (typeof body.archived !== 'boolean') fail('封存（archived）要是 true 或 false')
      if (body.archived) team.archived = true
      else delete team.archived
    }
    await this.store.put(teamKey(id), team)
    return team
  }

  async addMember(actor: Me, id: string, body: unknown): Promise<ClubTeam> {
    const team = await this.requireManaged(actor, id)
    const userId = this.checkUser(isObject(body) ? body.userId : undefined)
    if (team.memberIds.includes(userId)) return team
    if (team.memberIds.length >= TEAM_LIMITS.membersMax) throw new ClubError('teamFull', { max: TEAM_LIMITS.membersMax }, 409)
    team.memberIds.push(userId)
    await this.store.put(teamKey(id), team)
    await this.store.put(userTeamKey(userId, id), true)
    return team
  }

  /** The captain or an editor takes a member off the team, or a member leaves; never the captain */
  async removeMember(actor: Me, id: string, userId: string): Promise<ClubTeam> {
    const team = await this.requireTeam(id)
    if (actor.id !== userId && !managesTeam(actor, team)) throw new ClubError('noPermission', {}, 403)
    if (team.archived) throw new ClubError('teamArchived', {}, 409)
    if (!team.memberIds.includes(userId)) return team
    if (team.captainId === userId) fail('隊長不能離隊，請先換一位隊長')
    team.memberIds = team.memberIds.filter((m) => m !== userId)
    await this.store.put(teamKey(id), team)
    await this.store.delete(userTeamKey(userId, id))
    return team
  }

  /** The ids of the teams a member is in */
  async teamIdsOf(userId: string): Promise<string[]> {
    return [...(await this.store.list(`userteam:${userId}:`)).keys()].map(lastPart)
  }

  // ── Partnerships (e2-t03) ──────────────────────────────────────────────────────────────────

  /** A member's partnerships, newest first, whatever their status */
  async pairsOf(userId: string): Promise<Partnership[]> {
    const pairs: Partnership[] = []
    for (const key of (await this.store.list(`userpair:${userId}:`)).keys()) {
      const pair = await this.store.get<Partnership>(pairKey(lastPart(key)))
      if (pair) pairs.push(pair)
    }
    return pairs.sort((a, b) => b.createdAt - a.createdAt)
  }

  async pair(id: string): Promise<Partnership> {
    const pair = await this.store.get<Partnership>(pairKey(id))
    if (!pair) throw new ClubError('pairGone', {}, 404)
    return pair
  }

  /** `actor` invites `partnerId`; with `teamId`, as partners in a team both are in */
  async invite(actor: Me, body: unknown): Promise<Partnership> {
    if (!isObject(body)) return fail('不是一個搭檔邀請')
    const partnerId = this.checkUser(body.partnerId)
    if (partnerId === actor.id) fail('不能和自己組搭檔')
    let teamId: string | undefined
    if (body.teamId !== undefined) {
      const team = await this.requireTeam(isString(body.teamId) ? body.teamId : '')
      if (team.archived) throw new ClubError('teamArchived', {}, 409)
      if (!team.memberIds.includes(actor.id) || !team.memberIds.includes(partnerId)) fail('兩個人都要是這一隊的隊員')
      teamId = team.id
    }
    const mine = (await this.pairsOf(actor.id)).filter((p) => p.status !== 'ended')
    if (mine.some((p) => p.userIds.includes(partnerId) && p.teamId === teamId)) throw new ClubError('pairExists', {}, 409)
    for (const userId of [actor.id, partnerId]) {
      const current = userId === actor.id ? mine : (await this.pairsOf(userId)).filter((p) => p.status !== 'ended')
      if (current.length >= TEAM_LIMITS.pairsMax)
        throw new ClubError('pairLimit', { max: TEAM_LIMITS.pairsMax, name: this.deps.usernameOf(userId) ?? '' }, 409)
    }

    let id = this.deps.newId()
    while (await this.store.get(pairKey(id))) id = this.deps.newId()
    const pair: Partnership = { id, userIds: [actor.id, partnerId], profileId: '', createdAt: this.deps.now(), status: 'pending' }
    if (teamId) pair.teamId = teamId
    await this.store.put(pairKey(id), pair)
    for (const userId of pair.userIds) await this.store.put(userPairKey(userId, id), true)
    await this.deps.notify(partnerId, 'pairInvited', { pairId: id, username: actor.username })
    return pair
  }

  /** The invited member accepts: the partnership is active and gets its profile */
  async accept(actor: Me, id: string): Promise<Partnership> {
    const pair = await this.pair(id)
    const [inviterId, inviteeId] = pair.userIds
    if (actor.id !== inviteeId) throw new ClubError('noPermission', {}, 403)
    if (pair.status !== 'pending') throw new ClubError('pairAnswered', {}, 409)
    const team = pair.teamId ? await this.store.get<ClubTeam>(teamKey(pair.teamId)) : undefined
    const name = `${this.deps.usernameOf(inviterId) ?? '?'}＋${this.deps.usernameOf(inviteeId) ?? '?'}`
    const profile = await this.deps.profiles().createOwned(actor.id, name, 'partnership', team?.profileId ?? CLUB_PROFILE_ID, '組成搭檔')
    const accepted: Partnership = { ...pair, profileId: profile.id, status: 'active', acceptedAt: this.deps.now() }
    await this.store.put(pairKey(id), accepted)
    await this.deps.notify(inviterId, 'pairAccepted', { pairId: id, username: actor.username })
    return accepted
  }

  /** The invited member says no: the invitation is gone and the inviter is told */
  async decline(actor: Me, id: string) {
    const pair = await this.pair(id)
    if (actor.id !== pair.userIds[1]) throw new ClubError('noPermission', {}, 403)
    if (pair.status !== 'pending') throw new ClubError('pairAnswered', {}, 409)
    await this.drop(pair)
    await this.deps.notify(pair.userIds[0], 'pairDeclined', { pairId: id, username: actor.username })
  }

  /**
   * Either member ends an active partnership, which keeps its profile, and the other is told. On a
   * pending one, the inviter takes the invitation back (nobody is told) and the invited member declines it.
   */
  async end(actor: Me, id: string): Promise<Partnership | null> {
    const pair = await this.pair(id)
    if (!pair.userIds.includes(actor.id)) throw new ClubError('noPermission', {}, 403)
    if (pair.status === 'pending') {
      if (actor.id === pair.userIds[1]) await this.decline(actor, id)
      else await this.drop(pair)
      return null
    }
    if (pair.status === 'ended') throw new ClubError('pairAnswered', {}, 409)
    const ended: Partnership = { ...pair, status: 'ended', endedAt: this.deps.now() }
    await this.store.put(pairKey(id), ended)
    const other = pair.userIds.find((u) => u !== actor.id)!
    await this.deps.notify(other, 'pairEnded', { pairId: id, username: actor.username })
    return ended
  }

  /** Every member by username, for picking a team's members or a partner */
  members(): ClubMember[] {
    return this.deps.members().sort((a, b) => a.username.localeCompare(b.username, 'zh-Hant') || a.id.localeCompare(b.id))
  }

  // ── The profiles' member rights (e2-t04) ───────────────────────────────────────────────────

  /** Which team or partnership owns each profile, by profile id */
  async profileOwners(): Promise<Map<string, ProfileOwner>> {
    const owners = new Map<string, ProfileOwner>()
    for (const team of (await this.store.list<ClubTeam>('team:')).values()) owners.set(team.profileId, { team })
    for (const pair of (await this.store.list<Partnership>('pair:')).values()) if (pair.profileId) owners.set(pair.profileId, { pair })
    return owners
  }

  async profileRights(actor: Me, profile: Pick<ProfileSummary, 'id' | 'scope' | 'visibility'>): Promise<ProfileRights> {
    return profileAccess(actor, profile, (await this.profileOwners()).get(profile.id))
  }

  /**
   * The profiles `actor` may read, with their rights: those the profile's owner lets them read, and
   * whose parents they may read too, since the handbook needs every layer to show one
   */
  private async readable(actor: Me): Promise<{ summaries: ProfileSummary[]; rights: Map<string, ProfileRights> }> {
    const owners = await this.profileOwners()
    const summaries = await this.deps.profiles().list()
    const byId = new Map(summaries.map((p) => [p.id, p]))
    const rights = new Map<string, ProfileRights>()
    const readable = (profile: ProfileSummary, depth = 0): boolean => {
      const own = profileAccess(actor, profile, owners.get(profile.id))
      if (!own.read) return false
      const parent = profile.scope === 'club' ? undefined : byId.get(profile.parentId ?? CLUB_PROFILE_ID)
      if (parent && depth < 3 && !readable(parent, depth + 1)) return false
      rights.set(profile.id, own)
      return true
    }
    for (const profile of summaries) readable(profile)
    return { summaries: summaries.filter((p) => rights.has(p.id)), rights }
  }

  /** GET /api/book/profiles: the ones `actor` may read, not counting the notes of those they may not see */
  async readableProfiles(actor: Me): Promise<ProfileSummary[]> {
    const { summaries, rights } = await this.readable(actor)
    return summaries.map((p) => (rights.get(p.id)!.notes ? p : { ...p, counts: { ...p.counts, notes: 0 } }))
  }

  /** GET /api/book/profiles/:id: 403 when `actor` may not read it or its parent; without the notes unless they may see them */
  async readProfile(actor: Me, id: string): Promise<{ profile: SystemProfile; access: ProfileAccess }> {
    const profile = await this.deps.profiles().get(id)
    const rights = (await this.readable(actor)).rights.get(id)
    if (!rights) throw new ClubError('noPermission', {}, 403)
    const { notes, edit, share } = rights
    return { profile: notes ? profile : { ...profile, notes: [] }, access: { notes, edit, share } }
  }

  /**
   * PUT /api/book/profiles/:id by whoever may edit it. Only editors change what a profile is (its
   * scope and parent); a team's members who may edit it leave who reads it to the captain.
   */
  async saveProfile(actor: Me, id: string, body: { profile?: unknown; baseVersion?: unknown; note?: unknown }): Promise<SystemProfile> {
    const profiles = this.deps.profiles()
    const current = await profiles.get(id)
    const rights = await this.profileRights(actor, current)
    if (!rights.edit) throw new ClubError('noPermission', {}, 403)
    if (!allows(actor, 'bookEdit')) {
      const input = checkProfileInput(body.profile)
      if (input.scope !== current.scope || (input.parentId ?? CLUB_PROFILE_ID) !== (current.parentId ?? CLUB_PROFILE_ID))
        throw new ClubError('noPermission', {}, 403)
      if ((input.visibility ?? 'club') !== (current.visibility ?? 'club') && !rights.share) throw new ClubError('noPermission', {}, 403)
    }
    return profiles.save(actor, id, body)
  }

  /** A profile's versions, newest first: the editors' and its members' */
  async profileRevisions(actor: Me, id: string): Promise<ProfileRevision[]> {
    await this.requireHistory(actor, id)
    return this.deps.profiles().revisions(id)
  }

  async profileRevision(actor: Me, id: string, version: number): Promise<ProfileRevision> {
    await this.requireHistory(actor, id)
    return this.deps.profiles().revision(id, version)
  }

  // ── Checks ─────────────────────────────────────────────────────────────────────────────────

  private async requireHistory(actor: Me, id: string) {
    const profile = await this.deps.profiles().get(id)
    if (!(await this.profileRights(actor, profile)).history) throw new ClubError('noPermission', {}, 403)
  }

  private async drop(pair: Partnership) {
    await this.store.delete(pairKey(pair.id))
    for (const userId of pair.userIds) await this.store.delete(userPairKey(userId, pair.id))
  }

  private async requireTeam(id: string) {
    const team = await this.store.get<ClubTeam>(teamKey(id))
    if (!team) throw new ClubError('teamGone', {}, 404)
    return team
  }

  private async requireManaged(actor: Me, id: string, evenArchived = false) {
    const team = await this.requireTeam(id)
    if (!managesTeam(actor, team)) throw new ClubError('noPermission', {}, 403)
    if (team.archived && !evenArchived) throw new ClubError('teamArchived', {}, 409)
    return team
  }

  private checkName(value: unknown) {
    const name = isString(value) ? value.trim() : ''
    if (!name || name.length > TEAM_LIMITS.nameMax) fail(`隊名要有 1 到 ${TEAM_LIMITS.nameMax} 個字`)
    return name
  }

  /** A member's id, or `badContent` */
  private checkUser(value: unknown) {
    if (!isString(value) || this.deps.usernameOf(value) === undefined) fail('找不到這位社員')
    return value as string
  }
}
