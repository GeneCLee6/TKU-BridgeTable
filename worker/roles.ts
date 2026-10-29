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
 * route. Reading the content is publicBookResponse's (book.ts), for any member: since 2026-10-29
 * BridgeHall is for signed-in members only, so nothing of it is read without signing in.
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
  // An article (BridgeHall e5-t04, e5-t07): publishing, hiding and sending a draft back are the
  // reviewers', its draft and versions every editor's; reading one or the list is articleReadRoute's
  const article = path.match(/^\/articles\/[\w-]+(?:\/(hide|reject|draft|revisions)(?:\/[\w-]+)?)?$/)
  if (article) {
    const action = article[1]
    const sub = /\/(?:hide|reject|draft|revisions)\/[\w-]+$/.test(path)
    if (sub && action !== 'revisions') return null
    if (method === 'PUT' && !action) return 'bookReview'
    if (method === 'POST' && (action === 'hide' || action === 'reject')) return 'bookReview'
    if (action === 'draft' && (method === 'GET' || method === 'PUT' || method === 'DELETE')) return 'bookEdit'
    if (method === 'GET' && action === 'revisions') return 'bookEdit'
    return null
  }
  // An e-book (BridgeHall e5-t09): uploading, adding, changing and taking one down are the reviewers';
  // reading one or the list is ebookReadRoute's, without signing in
  if (path === '/ebooks/ticket' || path === '/ebooks') return method === 'POST' ? 'bookReview' : null
  if (/^\/ebooks\/[\w-]+$/.test(path)) return method === 'PUT' || method === 'DELETE' ? 'bookReview' : null
  // Following a convention (關注, BridgeHall e8-t10): each member's own
  if (/^\/follows\/[\w-]+$/.test(path)) return method === 'GET' || method === 'PUT' ? 'member' : null
  // Every draft and what is waiting for review (e8-t02); who changed what (e8-t09)
  if (path === '/reviews' || path === '/audit') return method === 'GET' ? 'bookEdit' : null
  if (path === '/categories') return method === 'PUT' ? 'bookEdit' : null
  // The 待確認 panel (BridgeHall e8-t06): every member reads it, editors assign and track the notes
  if (path === '/pending') return method === 'GET' ? 'member' : null
  if (/^\/pending\/[\w-]+\/[\w-]+\/\d+$/.test(path)) return method === 'PUT' ? 'bookEdit' : null
  // The library's series (BridgeHall e5-t06), as the categories; reading them comes with the article list
  if (path === '/series') return method === 'PUT' ? 'bookEdit' : null
  // The glossary (BridgeHall e4-t07); reading it is publicGlossaryResponse's, for any member
  if (path === '/glossary') return method === 'PUT' ? 'bookEdit' : null
  if (path === '/profiles') return method === 'GET' ? 'member' : method === 'POST' ? 'bookEdit' : null
  // One profile: which member may read it, save it or see its versions is profileAccess's (below)
  const profile = path.match(/^\/profiles\/[\w-]+(\/revisions(?:\/\d+)?)?$/)
  if (profile) {
    if (profile[1]) return method === 'GET' ? 'member' : null
    if (method === 'GET' || method === 'PUT') return 'member'
    if (method === 'DELETE') return 'bookEdit'
    return null
  }
  // A profile's convention card versions (BridgeHall e3-t09): the profile's rights decide (club.ts)
  if (/^\/cards\/[\w-]+$/.test(path)) return method === 'GET' || method === 'POST' ? 'member' : null
  if (/^\/cards\/[\w-]+\/[\w-]+\/\d+$/.test(path)) return ['GET', 'PATCH', 'DELETE'].includes(method) ? 'member' : null
  if (/^\/cards\/[\w-]+\/[\w-]+\/\d+\/docx$/.test(path)) return method === 'GET' ? 'member' : null
  // 淡江橋館 → TKB (BridgeHall e7-t03, e7-t04): the report page is the editors'
  if (path === '/system-spec') return method === 'GET' ? 'bookEdit' : null
  if (/^\/system-spec\/[\w-]+$/.test(path)) return method === 'PUT' ? 'bookEdit' : null
  if (path === '/robot-meanings') return method === 'POST' ? 'bookEdit' : null
  // 練習 (BridgeHall E6): a member's own results; fixing the questions is the editors' (reading the fixes needs no sign-in)
  if (path === '/quiz/rounds') return method === 'GET' || method === 'POST' || method === 'DELETE' ? 'member' : null
  if (path === '/quiz/fixes') return method === 'PUT' || method === 'DELETE' ? 'bookEdit' : null
  // 學習路徑 (BridgeHall e4-t11, e4-t12): a member's own progress; editing a path is the editors' (reading needs no sign-in)
  if (path === '/paths/progress') return method === 'GET' || method === 'PUT' ? 'member' : null
  if (path === '/paths') return method === 'PUT' || method === 'DELETE' ? 'bookEdit' : null
  // 閱讀進度 (BridgeHall e5-t14): a member's own places in articles and e-books
  if (path === '/reading') return ['GET', 'PUT', 'DELETE'].includes(method) ? 'member' : null
  if (path === '/import/ticket') return method === 'POST' ? 'bookImport' : null
  if (path === '/drafts') return method === 'GET' || method === 'POST' ? 'bookImport' : null
  if (/^\/drafts\/[\w-]+$/.test(path)) return method === 'GET' || method === 'DELETE' ? 'bookImport' : null
  return null
}

/** `GET /api/book/ebooks` and `GET /api/book/ebooks/:id` (BridgeHall e5-t09): as articles, EbookService decides */
export function ebookReadRoute(method: string, pathname: string): { id?: string } | null {
  if (method !== 'GET') return null
  if (pathname === '/api/book/ebooks') return {}
  const one = pathname.match(/^\/api\/book\/ebooks\/([\w-]+)$/)
  return one ? { id: one[1] } : null
}

/**
 * `GET /api/book/articles` and `GET /api/book/articles/:slug` (BridgeHall e5-t04): anyone reads them,
 * signed in or not; which articles each reader gets is ArticleService's. Null for any other request.
 */
export function articleReadRoute(method: string, pathname: string): { slug?: string } | null {
  if (method !== 'GET') return null
  if (pathname === '/api/book/articles') return {}
  const one = pathname.match(/^\/api\/book\/articles\/([\w-]+)$/)
  return one ? { slug: one[1] } : null
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
  // 建議統一 (BridgeHall e2-t08): the team's captain's and the editors' (book-notices.ts checks which team)
  if (/^\/teams\/[\w-]+\/suggest-unify$/.test(path)) return method === 'POST' ? 'member' : null
  if (/^\/teams\/[\w-]+\/members\/[\w-]+$/.test(path)) return method === 'DELETE' ? 'member' : null
  if (path === '/pairs') return method === 'GET' || method === 'POST' ? 'member' : null
  if (/^\/pairs\/[\w-]+$/.test(path)) return method === 'GET' ? 'member' : null
  if (/^\/pairs\/[\w-]+\/(accept|decline|end)$/.test(path)) return method === 'POST' ? 'member' : null
  return null
}

/**
 * The forum's officers (幹部): they post on officers-only boards (the news board), pin, lock and
 * delete anyone's posts and comments. Admins until e11-t09 brings the `forumModerate` permission
 */
const FORUM_MODERATE: Need = 'admin'
export const moderatesForum = (me: Me) => allows(me, FORUM_MODERATE)

/**
 * `/api/forum/*` (`path` without that prefix; TKU-BridgeHall E11, e11-t06, e11-t07): only members
 * who are signed in read or write the forum (M1). Boards are the admins'; pinning and locking are
 * the officers'. Who may edit or delete a given post or comment, and post on an officers-only
 * board, is ForumService's check (worker/forum.ts). Null when there is no such route.
 */
export function forumRouteNeed(method: string, path: string): Need | null {
  if (path === '/boards') return method === 'GET' ? 'member' : method === 'POST' ? 'admin' : null
  if (/^\/boards\/[\w-]+$/.test(path)) return method === 'PATCH' || method === 'DELETE' ? 'admin' : null
  if (/^\/boards\/[\w-]+\/posts$/.test(path)) return method === 'GET' || method === 'POST' ? 'member' : null
  if (path === '/latest') return method === 'GET' ? 'member' : null
  if (/^\/posts\/[\w-]+$/.test(path)) return method === 'GET' || method === 'PATCH' || method === 'DELETE' ? 'member' : null
  if (/^\/posts\/[\w-]+\/(pin|lock)$/.test(path)) return method === 'POST' ? FORUM_MODERATE : null
  if (/^\/posts\/[\w-]+\/comments$/.test(path)) return method === 'POST' ? 'member' : null
  if (/^\/comments\/[\w-]+$/.test(path)) return method === 'PATCH' || method === 'DELETE' ? 'member' : null
  if (/^\/(posts|comments)\/[\w-]+\/reaction$/.test(path)) return method === 'PUT' || method === 'DELETE' ? 'member' : null
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
