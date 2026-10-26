// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { type ClubTeam, type Me, type Partnership, PERMISSIONS } from '../../shared/protocol.ts'
import { adminRouteNeed, allows, bookRouteNeed, clubRouteNeed, managesTeam, type Need, profileAccess, requireNeed } from '../../worker/roles.ts'

const admin: Me = { id: 'a', username: 'admin', admin: true, permissions: [...PERMISSIONS] }
const editor: Me = { id: 'e', username: 'editor', admin: false, permissions: ['bookEdit'] }
const member: Me = { id: 'm', username: 'member', admin: false, permissions: [] }

/** Every route in club.ts that checks a role, with what it needs */
const ADMIN_ROUTES: [string, string][] = [
  ['GET', '/users'],
  ['POST', '/users'],
  ['GET', '/applications'],
  ['POST', '/applications/x1/approve'],
  ['DELETE', '/applications/x1'],
  ['GET', '/settings'],
  ['POST', '/settings'],
  ['DELETE', '/users/u1'],
  ['POST', '/users/u1/password'],
  ['POST', '/users/u1/admin'],
  ['POST', '/users/u1/permissions'],
  ['POST', '/members'],
]
const EDITOR_BOOK_ROUTES: [string, string][] = [
  ['PUT', '/conventions/stayman'],
  ['POST', '/conventions/stayman/hide'],
  ['POST', '/conventions/stayman/reset'],
  ['GET', '/conventions/stayman/revisions'],
  ['GET', '/conventions/stayman/revisions/00000000000001-abc'],
  ['PUT', '/categories'],
  ['POST', '/profiles'],
  ['DELETE', '/profiles/ab12'],
]
/** Which member may use these on a given profile is profileAccess's (e2-t04) */
const MEMBER_BOOK_ROUTES: [string, string][] = [
  ['GET', '/profiles'],
  ['GET', '/profiles/club'],
  ['GET', '/profiles/ab12'],
  ['PUT', '/profiles/club'],
  ['PUT', '/profiles/ab12'],
  ['GET', '/profiles/club/revisions'],
  ['GET', '/profiles/ab12/revisions/3'],
]
const IMPORT_ROUTES: [string, string][] = [
  ['POST', '/import/ticket'],
  ['GET', '/drafts'],
  ['POST', '/drafts'],
  ['GET', '/drafts/d1'],
  ['DELETE', '/drafts/d1'],
]

const may = (me: Me, need: Need | null) => need !== null && allows(me, need)

describe('roles (2026-10-25: admins manage everything, editors everything but accounts)', () => {
  it('keeps accounts, registrations, passwords, roles, permissions and settings for admins', () => {
    for (const [method, path] of ADMIN_ROUTES) {
      expect(adminRouteNeed(method, path), `${method} ${path}`).toBe('admin')
      expect(may(admin, adminRouteNeed(method, path))).toBe(true)
      expect(may(editor, adminRouteNeed(method, path))).toBe(false)
      expect(() => requireNeed(editor, adminRouteNeed(method, path))).toThrow(expect.objectContaining({ code: 'adminOnly', status: 403 }))
    }
  })

  it('lets editors close a stuck table', () => {
    expect(adminRouteNeed('DELETE', '/tables/t1')).toBe('bookEdit')
    expect(may(editor, adminRouteNeed('DELETE', '/tables/t1'))).toBe(true)
    expect(may(admin, adminRouteNeed('DELETE', '/tables/t1'))).toBe(true)
    expect(() => requireNeed(member, adminRouteNeed('DELETE', '/tables/t1'))).toThrow(expect.objectContaining({ code: 'noPermission' }))
  })

  it('lets editors do everything in the handbook: conventions (hiding too), categories and profiles', () => {
    for (const [method, path] of EDITOR_BOOK_ROUTES) {
      expect(bookRouteNeed(method, path), `${method} ${path}`).toBe('bookEdit')
      expect(may(editor, bookRouteNeed(method, path))).toBe(true)
      expect(may(admin, bookRouteNeed(method, path))).toBe(true)
      expect(may(member, bookRouteNeed(method, path))).toBe(false)
    }
  })

  it('lets any member reach the profiles, which profileAccess then narrows', () => {
    for (const [method, path] of MEMBER_BOOK_ROUTES) {
      expect(bookRouteNeed(method, path), `${method} ${path}`).toBe('member')
      expect(may(member, bookRouteNeed(method, path))).toBe(true)
    }
  })

  it('keeps import its own permission, which admins have', () => {
    const importer: Me = { ...member, permissions: ['bookImport'] }
    for (const [method, path] of IMPORT_ROUTES) {
      expect(bookRouteNeed(method, path), `${method} ${path}`).toBe('bookImport')
      expect(may(editor, bookRouteNeed(method, path))).toBe(false)
      expect(may(importer, bookRouteNeed(method, path))).toBe(true)
      expect(may(admin, bookRouteNeed(method, path))).toBe(true)
    }
  })

  it('lets admins do everything', () => {
    for (const [method, path] of [...ADMIN_ROUTES, ['DELETE', '/tables/t1'] as [string, string]])
      expect(may(admin, adminRouteNeed(method, path))).toBe(true)
    for (const [method, path] of [...EDITOR_BOOK_ROUTES, ...MEMBER_BOOK_ROUTES, ...IMPORT_ROUTES])
      expect(may(admin, bookRouteNeed(method, path))).toBe(true)
    expect(requireNeed(admin, 'admin')).toBe(admin)
  })

  it('has no route for anything else', () => {
    for (const [method, path] of [
      ['GET', '/conventions/stayman'],
      ['DELETE', '/conventions/stayman'],
      ['GET', '/categories'],
      ['DELETE', '/profiles'],
      ['POST', '/profiles/club'],
      ['PUT', '/profiles/club/revisions'],
      ['GET', '/profiles/club/revisions/abc'],
      ['PUT', '/drafts/d1'],
      ['GET', '/nothing'],
    ])
      expect(bookRouteNeed(method, path), `${method} ${path}`).toBeNull()
  })

  it('lets editors make teams and any member use the rest of the team and partnership routes (e2-t02, e2-t03)', () => {
    expect(clubRouteNeed('POST', '/teams')).toBe('bookEdit')
    expect(may(member, clubRouteNeed('POST', '/teams'))).toBe(false)
    expect(may(editor, clubRouteNeed('POST', '/teams'))).toBe(true)
    for (const [method, path] of [
      ['GET', '/members'],
      ['GET', '/teams'],
      ['GET', '/teams/t1'],
      ['PATCH', '/teams/t1'],
      ['POST', '/teams/t1/members'],
      ['DELETE', '/teams/t1/members/u1'],
      ['GET', '/pairs'],
      ['POST', '/pairs'],
      ['GET', '/pairs/p1'],
      ['POST', '/pairs/p1/accept'],
      ['POST', '/pairs/p1/decline'],
      ['POST', '/pairs/p1/end'],
    ] as [string, string][])
      expect(clubRouteNeed(method, path), `${method} ${path}`).toBe('member')
    for (const [method, path] of [
      ['POST', '/members'],
      ['DELETE', '/teams'],
      ['PUT', '/teams/t1'],
      ['DELETE', '/teams/t1'],
      ['GET', '/teams/t1/members'],
      ['PUT', '/pairs/p1'],
      ['GET', '/pairs/p1/accept'],
      ['POST', '/pairs/p1/cancel'],
    ] as [string, string][])
      expect(clubRouteNeed(method, path), `${method} ${path}`).toBeNull()
  })

  it("leaves a team to its captain and the editors", () => {
    const team = { captainId: 'm' }
    expect(managesTeam(member, team)).toBe(true)
    expect(managesTeam({ ...member, id: 'x' }, team)).toBe(false)
    expect(managesTeam(editor, team)).toBe(true)
    expect(managesTeam(admin, team)).toBe(true)
  })

  describe('profileAccess (e2-t04, e2-t10)', () => {
    const cap: Me = { ...member, id: 'cap' }
    const mate: Me = { ...member, id: 'mate' }
    const other: Me = { ...member, id: 'other' }
    const team: ClubTeam = { id: 't1', name: 'A', captainId: 'cap', memberIds: ['cap', 'mate'], profileId: 'p1', createdAt: 0 }
    const pair: Partnership = { id: 'q1', userIds: ['cap', 'mate'], profileId: 'p2', createdAt: 0, status: 'active' }
    const teamProfile = { scope: 'team' as const }
    const pairProfile = { scope: 'partnership' as const }
    const everything = { read: true, notes: true, edit: true, share: true, history: true }

    it('lets editors and admins do everything with any profile', () => {
      for (const me of [editor, admin]) {
        expect(profileAccess(me, { scope: 'club' })).toEqual(everything)
        expect(profileAccess(me, { ...teamProfile, visibility: 'members' }, { team: { ...team, archived: true } })).toEqual(everything)
        expect(profileAccess(me, pairProfile, { pair: { ...pair, status: 'ended' } })).toEqual(everything)
        expect(profileAccess(me, teamProfile)).toEqual(everything)
      }
    })

    it("lets every member read the club's, notes too, but not save it", () => {
      expect(profileAccess(member, { scope: 'club' })).toEqual({ read: true, notes: true, edit: false, share: false, history: false })
    })

    it("leaves a team's to its captain, and to its members when the captain lets them", () => {
      expect(profileAccess(cap, teamProfile, { team })).toEqual(everything)
      expect(profileAccess(mate, teamProfile, { team })).toEqual({ read: true, notes: true, edit: false, share: false, history: true })
      expect(profileAccess(mate, teamProfile, { team: { ...team, membersEdit: true } })).toMatchObject({ edit: true, share: false })
      expect(profileAccess(other, teamProfile, { team: { ...team, membersEdit: true } })).toEqual({
        read: true,
        notes: false,
        edit: false,
        share: false,
        history: false,
      })
      // Archived: read-only for its members
      expect(profileAccess(cap, teamProfile, { team: { ...team, archived: true, membersEdit: true } })).toMatchObject({ edit: false, share: false, notes: true })
      expect(profileAccess(mate, teamProfile, { team: { ...team, archived: true, membersEdit: true } })).toMatchObject({ edit: false })
    })

    it("leaves a partnership's to the two partners while it lasts", () => {
      expect(profileAccess(mate, pairProfile, { pair })).toEqual(everything)
      expect(profileAccess(cap, pairProfile, { pair: { ...pair, status: 'ended' } })).toEqual({ read: true, notes: true, edit: false, share: false, history: true })
      expect(profileAccess(other, pairProfile, { pair })).toEqual({ read: true, notes: false, edit: false, share: false, history: false })
    })

    it('hides one for its members only from everyone else', () => {
      const hidden = { ...teamProfile, visibility: 'members' as const }
      expect(profileAccess(other, hidden, { team }).read).toBe(false)
      expect(profileAccess(mate, hidden, { team }).read).toBe(true)
      expect(profileAccess(other, { ...pairProfile, visibility: 'members' }, { pair }).read).toBe(false)
    })

    it('leaves a profile nobody owns to the editors', () => {
      expect(profileAccess(member, teamProfile)).toEqual({ read: true, notes: false, edit: false, share: false, history: false })
      expect(profileAccess(member, { ...pairProfile, visibility: 'members' }).read).toBe(false)
    })
  })
})
