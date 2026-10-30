import { DEFAULT_CLUB_ID, requestClubId } from '../shared/clubs.ts'
import { formatMessage } from '../shared/messages.ts'
import { parseHistoryQuery, type HistoryQuery } from '../shared/history-query.ts'
import { TABLE_ID_PATTERN, TABLE_SOCKET_PREFIX } from '../shared/protocol.ts'
import { readCookie, SESSION_COOKIE } from './auth.ts'
import { PASS_COOKIE, readPass } from './edge-auth.ts'
import { listQuery } from './history-index.ts'
import { daysReplica, searchReplica, type ReplicaDb } from './history-replica.ts'
import { noLog, type Logger } from './log.ts'

/** The header the Worker puts on a table connection: who it is (ARCHITECTURE.md §5.10) */
export const TABLE_USER_HEADER = 'X-TBT-User'

interface Fetches {
  fetch(request: Request): Promise<Response>
}

/** Where the Worker sends requests; `worker/index.ts` gives the Durable Objects, the tests fakes */
export interface Routes {
  /** A club's object (shared/clubs.ts); the routing only asks for clubs that exist */
  club(clubId: string): Fetches & {
    /** The member signed in with this session token, or null (one call per table connection, not per message) */
    socketUser(token: string | null): Promise<string | null>
  }
  table(tableId: string): Fetches
  assets: Fetches
  /**
   * What the Worker answers by itself (§5.12): `secret` checks edge passes (`EDGE_AUTH_SECRET`),
   * `history` is the history index's D1 copy. Either missing (switched off, a PR preview) means the
   * club answers, as before
   */
  edge?: { secret?: string; history?: ReplicaDb; now?: () => number; log?: Logger }
}

/** The history pages the Worker may answer from D1 */
const EDGE_HISTORY = new Set(['/api/history', '/api/history/search', '/api/history/days'])

/**
 * The Worker's routing, without Cloudflare APIs: the API and the club's socket go to the club's
 * object; a table's socket (`/ws/table/<id>`) goes to that table's object once it is known whose
 * session it is: from the edge pass when it is good, else by asking the club. Durable Objects
 * cannot be reached from outside, so the member id in `X-TBT-User` can only come from here;
 * whatever a browser sent in that header is replaced. The history pages are answered from D1 when
 * the pass and the copy allow it (§5.12), else by the club
 */
export async function route(request: Request, routes: Routes): Promise<Response> {
  const url = new URL(request.url)
  const { pathname } = url
  // The club the request is for (e12-t02): `X-Club-Id` or `?club=`, none means 淡江
  const clubId = requestClubId(request)
  if (clubId === null && (pathname === '/ws' || pathname.startsWith('/api/') || pathname.startsWith(TABLE_SOCKET_PREFIX))) {
    return unknownClub()
  }
  const club = () => routes.club(clubId ?? '')
  const now = routes.edge?.now ?? Date.now
  const cookies = request.headers.get('Cookie')
  const passUser = async () => {
    const secret = routes.edge?.secret
    return secret ? ((await readPass(secret, readCookie(cookies, PASS_COOKIE), now()))?.userId ?? null) : null
  }
  if (pathname.startsWith(TABLE_SOCKET_PREFIX)) {
    const tableId = pathname.slice(TABLE_SOCKET_PREFIX.length)
    if (!TABLE_ID_PATTERN.test(tableId)) return new Response('Not found', { status: 404 })
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 })
    const userId = (await passUser()) ?? (await club().socketUser(readCookie(cookies, SESSION_COOKIE)))
    if (!userId) return new Response('Unauthorized', { status: 401 })
    const headers = new Headers(request.headers)
    headers.set(TABLE_USER_HEADER, userId)
    return routes.table(tableId).fetch(new Request(request, { headers }))
  }
  const history = routes.edge?.history
  // The D1 copy is 淡江's history index; another club's pages are its own object's
  if (history && clubId === DEFAULT_CLUB_ID && request.method === 'GET' && EDGE_HISTORY.has(pathname)) {
    const userId = await passUser()
    const answer = userId && (await edgeHistory(url, userId, history, now, routes.edge?.log ?? noLog))
    if (answer) return answer
  }
  if (pathname === '/ws' || pathname.startsWith('/api/')) return club().fetch(request)
  return routes.assets.fetch(request)
}

/** The answer for a club no one knows, shaped like the club's own errors */
function unknownClub(): Response {
  return new Response(JSON.stringify({ error: formatMessage('unknownClub', 'zh', {}), code: 'unknownClub', params: {} }), {
    status: 404,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

/**
 * A history page from the D1 copy, exactly as the club would answer it (`Club.api`), or null to let
 * the club answer: a query the club would refuse (it sends the error), one by favorite tag (the
 * tags are only in the club), a copy not complete, or D1 failing
 */
async function edgeHistory(url: URL, userId: string, db: ReplicaDb, now: () => number, log: Logger): Promise<Response | null> {
  const started = now()
  const params = url.searchParams
  let query: HistoryQuery
  try {
    query =
      url.pathname === '/api/history'
        ? listQuery(params.get('scope') === 'all', Number(params.get('page') ?? 1), Number(params.get('size') ?? 0))
        : parseHistoryQuery(params)
  } catch {
    return null
  }
  if (query.tag) return null
  try {
    const page =
      url.pathname === '/api/history/days'
        ? await daysReplica(db, query, userId, now()).then((days) => days && { days })
        : await searchReplica(db, query, userId, now())
    if (!page) {
      log({ event: 'edge', path: url.pathname, ms: now() - started, fallback: 'notReady' })
      return null
    }
    log({ event: 'edge', path: url.pathname, status: 200, ms: now() - started })
    return new Response(JSON.stringify(page), {
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    })
  } catch {
    log({ event: 'edge', path: url.pathname, ms: now() - started, fallback: 'error' })
    return null
  }
}
