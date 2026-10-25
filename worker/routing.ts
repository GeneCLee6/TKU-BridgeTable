import { TABLE_ID_PATTERN, TABLE_SOCKET_PREFIX } from '../shared/protocol.ts'
import { readCookie, SESSION_COOKIE } from './auth.ts'

/** The header the Worker puts on a table connection: who it is (ARCHITECTURE.md §5.10) */
export const TABLE_USER_HEADER = 'X-TBT-User'

interface Fetches {
  fetch(request: Request): Promise<Response>
}

/** Where the Worker sends requests; `worker/index.ts` gives the Durable Objects, the tests fakes */
export interface Routes {
  club(): Fetches & {
    /** The member signed in with this session token, or null (one call per table connection, not per message) */
    socketUser(token: string | null): Promise<string | null>
  }
  table(tableId: string): Fetches
  assets: Fetches
}

/**
 * The Worker's routing, without Cloudflare APIs: the API and the club's socket go to the club's
 * object; a table's socket (`/ws/table/<id>`) goes to that table's object once the club has said
 * whose session it is. Durable Objects cannot be reached from outside, so the member id in
 * `X-TBT-User` can only come from here; whatever a browser sent in that header is replaced
 */
export async function route(request: Request, routes: Routes): Promise<Response> {
  const { pathname } = new URL(request.url)
  if (pathname.startsWith(TABLE_SOCKET_PREFIX)) {
    const tableId = pathname.slice(TABLE_SOCKET_PREFIX.length)
    if (!TABLE_ID_PATTERN.test(tableId)) return new Response('Not found', { status: 404 })
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 })
    const userId = await routes.club().socketUser(readCookie(request.headers.get('Cookie'), SESSION_COOKIE))
    if (!userId) return new Response('Unauthorized', { status: 401 })
    const headers = new Headers(request.headers)
    headers.set(TABLE_USER_HEADER, userId)
    return routes.table(tableId).fetch(new Request(request, { headers }))
  }
  if (pathname === '/ws' || pathname.startsWith('/api/')) return routes.club().fetch(request)
  return routes.assets.fetch(request)
}
