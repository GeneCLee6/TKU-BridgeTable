// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { type Me, PERMISSIONS } from '../../shared/protocol.ts'
import { adminRouteNeed, allows, bookRouteNeed, clubRouteNeed, managesTeam, type Need, requireNeed } from '../../worker/roles.ts'

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
  ['PUT', '/profiles/club'],
  ['PUT', '/profiles/ab12'],
  ['DELETE', '/profiles/ab12'],
  ['GET', '/profiles/club/revisions'],
  ['GET', '/profiles/ab12/revisions/3'],
]
const MEMBER_BOOK_ROUTES: [string, string][] = [
  ['GET', '/profiles'],
  ['GET', '/profiles/club'],
  ['GET', '/profiles/ab12'],
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

  it('lets any member read the profiles', () => {
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
})
