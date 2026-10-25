import type { Me, Permission } from '../shared/protocol.ts'
import { ClubError } from './service.ts'

/**
 * Who may use which API (decided 2026-10-25). Two roles above a member:
 *
 * - **Admins** manage everything, members' accounts included: registrations, adding and deleting
 *   accounts, passwords, the admin role, permissions, and the club settings (account limit,
 *   invite code), which are about who may join.
 * - **Editors** (`bookEdit`) manage everything else: TKU BridgeBook's conventions (saving,
 *   hiding, going back to the bundled one, versions), its categories and system profiles, and
 *   closing a stuck table.
 *
 * `bookImport` (AI import, which costs API credit) and `boardCurate` (featured boards) stay their
 * own permissions, granted one by one; admins have every permission.
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
  const convention = path.match(/^\/conventions\/[\w-]+(?:\/(hide|reset|revisions)(?:\/[\w-]+)?)?$/)
  if (convention) {
    const action = convention[1]
    if (method === 'PUT' && !action) return 'bookEdit'
    if (method === 'POST' && (action === 'hide' || action === 'reset')) return 'bookEdit'
    if (method === 'GET' && action === 'revisions') return 'bookEdit'
    return null
  }
  if (path === '/categories') return method === 'PUT' ? 'bookEdit' : null
  if (path === '/profiles') return method === 'GET' ? 'member' : method === 'POST' ? 'bookEdit' : null
  const profile = path.match(/^\/profiles\/[\w-]+(\/revisions(?:\/\d+)?)?$/)
  if (profile) {
    if (profile[1]) return method === 'GET' ? 'bookEdit' : null
    if (method === 'GET') return 'member'
    if (method === 'PUT' || method === 'DELETE') return 'bookEdit'
    return null
  }
  if (path === '/import/ticket') return method === 'POST' ? 'bookImport' : null
  if (path === '/drafts') return method === 'GET' || method === 'POST' ? 'bookImport' : null
  if (/^\/drafts\/[\w-]+$/.test(path)) return method === 'GET' || method === 'DELETE' ? 'bookImport' : null
  return null
}
