// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import type { Me, NotificationKind, ProfileOverride, SystemProfile } from '../../shared/protocol.ts'
import { BookNotices, overrideRef } from '../../worker/book-notices.ts'
import { ProfileService } from '../../worker/profiles.ts'
import { MemoryStore } from '../../worker/store.ts'
import { TeamService } from '../../worker/teams.ts'

const me = (id: string, permissions: Me['permissions'] = []): Me => ({ id, username: `n${id}`, admin: false, permissions })
const editor = me('ed', ['bookEdit', 'bookReview'])
const amy = me('amy')
const ben = me('ben')
const cat = me('cat')
const dan = me('dan')
const IDS = ['ed', 'amy', 'ben', 'cat', 'dan', 'eve']

let store: MemoryStore
let profiles: ProfileService
let teams: TeamService
let notices: BookNotices
let sent: { to: string; kind: NotificationKind; params: Record<string, string | number> }[]
let ids: number

beforeEach(() => {
  store = new MemoryStore()
  ids = 0
  sent = []
  profiles = new ProfileService(store, () => 1_000)
  const members = () => IDS.map((id) => ({ id, username: `n${id}` }))
  const notify = async (to: string, kind: NotificationKind, params: Record<string, string | number>) => void sent.push({ to, kind, params })
  teams = new TeamService(store, {
    now: () => 1_000,
    newId: () => `id${++ids}`,
    usernameOf: (id) => (IDS.includes(id) ? `n${id}` : undefined),
    members,
    notify,
    profiles: () => profiles,
  })
  notices = new BookNotices(store, { notify, members, reviewerIds: () => ['ed', 'eve'], teams: () => teams, profiles: () => profiles })
})

const row = (slug: string, sectionId: string): ProfileOverride => ({ kind: 'row', slug, sectionId, blockIndex: 0, rowIndex: 1, meaning: '改過' })

async function change(id: string, patch: Partial<Pick<SystemProfile, 'adopted' | 'overrides'>>) {
  const p = await profiles.get(id)
  const { name, scope, parentId, visibility, adopted, overrides, notes } = { ...p, ...patch }
  await profiles.save(editor, id, { profile: { name, scope, parentId, visibility, adopted, overrides, notes }, baseVersion: p.version })
}

/** Team A (captain amy, ben, cat) with the partnership amy + ben in it; dan in no team */
async function club() {
  sent = []
  const team = await teams.createTeam(editor, { name: 'A 隊', captainId: 'amy', memberIds: ['ben', 'cat'] })
  const invited = await teams.invite(amy, { partnerId: 'ben', teamId: team.id })
  const pair = await teams.accept(ben, invited.id)
  sent = []
  return { team, pair }
}

const publish = (changedSections: unknown, extra: { requestedBy?: string } = {}) =>
  notices.published(editor, { slug: 'stayman', name: '斯台曼', version: 3, changedSections, ...extra })

describe('publishing (e8-t10, e8-t11)', () => {
  it('tells the followers and the members of the profiles that play it, not the one who published', async () => {
    await club()
    await notices.setFollowing('dan', 'stayman', { following: true })
    await notices.setFollowing('ed', 'stayman', { following: true })
    await publish([])
    const to = sent.map((s) => s.to).sort()
    expect(to).toEqual(['amy', 'ben', 'cat', 'dan'])
    expect(sent.every((s) => s.kind === 'bookPublished')).toBe(true)
    expect(sent[0].params).toEqual({ slug: 'stayman', name: '斯台曼', version: 3, username: 'ned' })
  })

  it('says nothing when the handbook names no changed sections', async () => {
    await club()
    await notices.setFollowing('dan', 'stayman', { following: true })
    await publish(undefined)
    expect(sent).toEqual([])
  })

  it('leaves out the members of a profile that does not play it, and follows the nearest layer that says', async () => {
    const { team, pair } = await club()
    await change(team.profileId, { adopted: { stayman: 'off' } })
    await publish([])
    expect(sent).toEqual([])
    await change(pair.profileId, { adopted: { stayman: 'on' } })
    await publish([])
    expect(sent.map((s) => s.to).sort()).toEqual(['amy', 'ben'])
  })

  it('tells the members of a profile that overrides a changed section that their override is touched, once', async () => {
    const { team, pair } = await club()
    await change(pair.profileId, { overrides: [row('stayman', 's2')] })
    await publish(['s1'])
    expect(sent.every((s) => s.kind === 'bookPublished')).toBe(true)
    sent = []
    await publish(['s2'])
    const override = sent.filter((s) => s.kind === 'bookOverrideChanged')
    expect(override.map((s) => s.to).sort()).toEqual(['amy', 'ben'])
    expect(override[0].params).toMatchObject({ slug: 'stayman', profileId: pair.profileId, profile: 'namy＋nben' })
    // amy and ben are in the team too, but hear about it once
    expect(sent.filter((s) => s.kind === 'bookPublished').map((s) => s.to)).toEqual(['cat'])
    expect(team.memberIds).toContain('amy')
  })

  it('tells whoever sent the draft for review', async () => {
    await publish([], { requestedBy: 'neve' })
    expect(sent).toEqual([{ to: 'eve', kind: 'bookPublished', params: { slug: 'stayman', name: '斯台曼', version: 3, username: 'ned' } }])
  })

  it('leaves out ended partnerships and archived teams', async () => {
    const { team, pair } = await club()
    await teams.end(amy, pair.id)
    await teams.updateTeam(editor, team.id, { archived: true })
    sent = []
    await publish([])
    expect(sent).toEqual([])
  })
})

describe('following (e8-t10)', () => {
  it('follows and stops following a convention', async () => {
    expect(await notices.following('amy', 'stayman')).toBe(false)
    expect(await notices.setFollowing('amy', 'stayman', { following: true })).toBe(true)
    expect(await notices.following('amy', 'stayman')).toBe(true)
    expect(await store.get('bookfollow:stayman:amy')).toBe(true)
    await notices.setFollowing('amy', 'stayman', { following: false })
    expect(await notices.following('amy', 'stayman')).toBe(false)
    await expect(notices.setFollowing('amy', 'stayman', { following: 'yes' })).rejects.toMatchObject({ code: 'badContent' })
  })
})

describe('review (e8-t10)', () => {
  it('tells the reviewers about a draft sent for review, and who sent it when it comes back', async () => {
    await notices.reviewRequested(me('eve'), { slug: 'stayman', name: '斯台曼' })
    expect(sent).toEqual([{ to: 'ed', kind: 'bookReviewRequested', params: { slug: 'stayman', name: '斯台曼', username: 'neve' } }])
    sent = []
    await notices.returned(editor, { slug: 'stayman', name: '斯台曼', requestedBy: 'neve' })
    expect(sent).toEqual([{ to: 'eve', kind: 'bookReturned', params: { slug: 'stayman', name: '斯台曼', username: 'ned' } }])
    sent = []
    await notices.returned(editor, { slug: 'stayman', name: '斯台曼' })
    expect(sent).toEqual([])
  })
})

describe('建議統一 (e2-t08)', () => {
  it("lets the captain point a partnership at one of its overrides, and tells both partners", async () => {
    const { team, pair } = await club()
    const override = row('stayman', 's2')
    await change(pair.profileId, { overrides: [override] })
    await notices.suggestUnify(cat, team.id, { pairId: pair.id, ref: overrideRef(override) }).then(
      () => expect.unreachable(),
      (e) => expect(e).toMatchObject({ code: 'noPermission', status: 403 }),
    )
    await expect(notices.suggestUnify(dan, team.id, { pairId: pair.id, ref: overrideRef(override) })).rejects.toMatchObject({ code: 'noPermission' })
    await expect(notices.suggestUnify(amy, team.id, { pairId: pair.id, ref: 'row:stayman:s9:0:0' })).rejects.toMatchObject({ code: 'badContent' })
    await expect(notices.suggestUnify(amy, team.id, { pairId: 'nope', ref: overrideRef(override) })).rejects.toMatchObject({ code: 'pairGone' })
    await notices.suggestUnify(amy, team.id, { pairId: pair.id, ref: overrideRef(override), name: '斯台曼' })
    // amy is one of the two: only ben hears it
    expect(sent).toEqual([
      {
        to: 'ben',
        kind: 'bookSuggestUnify',
        params: { pairId: pair.id, profileId: pair.profileId, ref: 'row:stayman:s2:0:1', slug: 'stayman', name: '斯台曼', team: 'A 隊', username: 'namy' },
      },
    ])
    sent = []
    await notices.suggestUnify(editor, team.id, { pairId: pair.id, ref: overrideRef(override) })
    expect(sent.map((s) => s.to)).toEqual(['amy', 'ben'])
    expect(sent[0].params.name).toBe('stayman')
  })

  it('names each kind of override', () => {
    expect(overrideRef({ kind: 'section', slug: 'a', sectionId: 'b', section: {} })).toBe('section:a:b')
    expect(overrideRef({ kind: 'meta', slug: 'a', summary: 'x' })).toBe('meta:a')
  })
})
