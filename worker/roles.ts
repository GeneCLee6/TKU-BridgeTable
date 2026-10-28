import type { ClubTeam, Me, Partnership, Permission, ProfileAccess, ProfileSummary } from '../shared/protocol.ts'
import { ClubError } from './service.ts'

/**
 * Who may use which API (decided 2026-10-25). Two roles above a member:
 *
 * - **Admins** manage everything, members' accounts included: registrations, adding and deleting
 *   accounts, passwords, the admin role, permissions, and the club settings (account limit,
 *   invite code), which are about who may join.
 * - **Editors** (`bookEdit`) manage everything else: TKU BridgeBook's conventions (drafts, sending
 *   them for review, versions), its categories and system profiles, and closing a stuck table.
 * - **Reviewers** (`bookReview`, BridgeHall e8-t01) are editors who also publish a convention
 *   (straight away or a draft sent for review), send a draft back, hide one or go back to the
 *   bundled one. A reviewer is always an editor too (`withImpliedPermissions`).
 *
 * Teams and partnerships (TKU BridgeBook E2): editors make teams; a team's captain and the editors
 * manage it (`managesTeam`); any member invites a partner, and only the two of them answer or end it.
 * A team's or partnership's system profile is its members' (`profileAccess`, e2-t04).
 *
 * `bookImport` (AI import, which costs API credit), `boardCurate` (featured boards) and
 * `tkuSystem` (TKB in the club's system, ROBOT.md §7) stay their own permissions, granted one by
 * one; admins have every permission.
 * `Need` is what a route asks for: 'member' is anyone signed in.
 */
export type Need = 'member' | 'admin' | Permission

export const allows = (me: Me, need: Need) =>
  me.admin || need === 'member' || (need !== 'admin' && me.permissions.includes(need))

/** Throws 403 unless `me` may use a route that needs `need` */
export function requireNeed(me: Me, need: Need) {
  if (!allows(me, need)) throw new ClubError(need === 'admin' ? 'adminOnly' : 'noPermission', {}, 403)
  return me
}

/** `/api/admin/*` (`path` without that prefix): accounts and settings are admins'; closing a table is an editor's */
export function adminRouteNeed(method: string, path: string): Need {
  if (method === 'DELETE' && /^\/tables\/\w+$/.test(path)) return 'bookEdit'
  return 'admin'
}

/**
 * `/api/book/*` for someone signed in (`path` without that prefix); null when there is no such
 * route. Reading without signing in is publicBookResponse's (book.ts) and anonymousProfileResponse's (profiles.ts).
 */
export function bookRouteNeed(method: string, path: string): Need | null {
  // A convention: publishing, hiding and going back to the bundled one are the reviewers'; its
  // draft (one per convention, e8-t02) and its versions are every editor's
  const convention = path.match(/^\/conventions\/[\w-]+(?:\/(hide|reset|reject|draft|revisions)(?:\/[\w-]+)?)?$/)
  if (convention) {
    const action = convention[1]
    const sub = /\/(?:hide|reset|reject|draft|revisions)\/[\w-]+$/.test(path)
    if (sub && action !== 'revisions') return null
    if (method === 'PUT' && !action) return 'bookReview'
    if (method === 'POST' && (action === 'hide' || action === 'reset' || action === 'reject')) return 'bookReview'
    if (action === 'draft' && (method === 'GET' || method === 'PUT' || method === 'DELETE')) return 'bookEdit'
    if (method === 'GET' && action === 'revisions') return 'bookEdit'
    return null
  }
  // Every draft and what is waiting for review (e8-t02); who changed what (e8-t09)
  if (path === '/reviews' || path === '/audit') return method === 'GET' ? 'bookEdit' : null
  if (path === '/categories') return method === 'PUT' ? 'bookEdit' : null
  if (path === '/profiles') return method === 'GET' ? 'member' : method === 'POST' ? 'bookEdit' : null
  // One profile: which member may read it, save it or see its versions is profileAccess's (below)
  const profile = path.match(/^\/profiles\/[\w-]+(\/revisions(?:\/\d+)?)?$/)
  if (profile) {
    if (profile[1]) return method === 'GET' ? 'member' : null
    if (method === 'GET' || method === 'PUT') return 'member'
    if (method === 'DELETE') return 'bookEdit'
    return null
  }
  // 淡江橋館 → TKB (BridgeHall e7-t03, e7-t04): the report page is the editors'
  if (path === '/system-spec') return method === 'GET' ? 'bookEdit' : null
  if (/^\/system-spec\/[\w-]+$/.test(path)) return method === 'PUT' ? 'bookEdit' : null
  if (path === '/robot-meanings') return method === 'POST' ? 'bookEdit' : null
  // 練習 (BridgeHall E6): a member's own results; fixing the questions is the editors' (reading the fixes needs no sign-in)
  if (path === '/quiz/rounds') return method === 'GET' || method === 'POST' || method === 'DELETE' ? 'member' : null
  if (path === '/quiz/fixes') return method === 'PUT' || method === 'DELETE' ? 'bookEdit' : null
  if (path === '/import/ticket') return method === 'POST' ? 'bookImport' : null
  if (path === '/drafts') return method === 'GET' || method === 'POST' ? 'bookImport' : null
  if (/^\/drafts\/[\w-]+$/.test(path)) return method === 'GET' || method === 'DELETE' ? 'bookImport' : null
  return null
}

/**
 * `/api/club/*` (`path` without that prefix): teams and partnerships; null when there is no such
 * route. Which team or partnership a member may change is TeamService's check (worker/teams.ts).
 */
export function clubRouteNeed(method: string, path: string): Need | null {
  if (path === '/members') return method === 'GET' ? 'member' : null
  if (/^\/members\/[\w-]+\/teams$/.test(path)) return method === 'GET' ? 'member' : null
  if (path === '/teams') return method === 'GET' ? 'member' : method === 'POST' ? 'bookEdit' : null
  if (/^\/teams\/[\w-]+$/.test(path)) return method === 'GET' || method === 'PATCH' ? 'member' : null
  if (/^\/teams\/[\w-]+\/members$/.test(path)) return method === 'POST' ? 'member' : null
  if (/^\/teams\/[\w-]+\/members\/[\w-]+$/.test(path)) return method === 'DELETE' ? 'member' : null
  if (path === '/pairs') return method === 'GET' || method === 'POST' ? 'member' : null
  if (/^\/pairs\/[\w-]+$/.test(path)) return method === 'GET' ? 'member' : null
  if (/^\/pairs\/[\w-]+\/(accept|decline|end)$/.test(path)) return method === 'POST' ? 'member' : null
  return null
}

/** Renaming a team, a new captain, its members, archiving: its captain's and the editors' */
export const managesTeam = (me: Me, team: Pick<ClubTeam, 'captainId'>) => allows(me, 'bookEdit') || team.captainId === me.id

/** Who owns a team's or partnership's profile; nobody owns the club's, nor one an editor made by hand */
export type ProfileOwner = { team: ClubTeam; pair?: never } | { pair: Partnership; team?: never }

/** ProfileAccess, plus whether the member may read the profile at all and see its versions */
export interface ProfileRights extends ProfileAccess {
  read: boolean
  history: boolean
}

/**
 * What `me` may do with a profile (e2-t04, e2-t10; AC-2.3). Editors may do everything, as with the
 * rest of the handbook. Otherwise:
 *
 * - The club's: every member reads it, notes too; only editors save it or see its versions.
 * - A team's: its captain saves it and sets who reads it; its members save it too when the captain
 *   lets them (`membersEdit`). Once the team is archived only editors save it.
 * - A partnership's: both partners save it and set who reads it while it is active; ended, it is read-only.
 * - Anyone else reads a team's or partnership's unless it is for its members only (`visibility`), and
 *   never sees its private notes or versions. A profile no team or partnership owns is the editors'.
 */
export function profileAccess(me: Me, profile: Pick<ProfileSummary, 'scope' | 'visibility'>, owner?: ProfileOwner): ProfileRights {
  if (allows(me, 'bookEdit')) return { read: true, notes: true, edit: true, share: true, history: true }
  if (profile.scope === 'club') return { read: true, notes: true, edit: false, share: false, history: false }
  const { team, pair } = owner ?? {}
  const member = team ? team.memberIds.includes(me.id) : !!pair?.userIds.includes(me.id)
  const read = member || profile.visibility !== 'members'
  if (team) {
    const captain = team.captainId === me.id && !team.archived
    const edit = captain || (member && !!team.membersEdit && !team.archived)
    return { read, notes: member, edit, share: captain, history: member }
  }
  const active = member && pair?.status === 'active'
  return { read, notes: member, edit: active, share: active, history: member }
}
