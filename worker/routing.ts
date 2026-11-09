import { CLUB_HEADER, CLUB_IDS, CLUB_PARAM, DEFAULT_CLUB_ID, requestClubId } from '../shared/clubs.ts'
import { NOTICES_API, noticeLive, type ClubBanner, type NoticesView, type PlatformNotice } from '../shared/notices.ts'
import { CLUB_APPLY_API, type ClubStatus } from '../shared/platform.ts'
import { formatMessage, type MessageCode } from '../shared/messages.ts'
import type { GuestTable, PublicLobby, PublicTable } from '../shared/public-lobby.ts'
import { parseHistoryQuery, type HistoryQuery } from '../shared/history-query.ts'
import { TABLE_ID_PATTERN, TABLE_SOCKET_PREFIX } from '../shared/protocol.ts'
import { ARCADE_LOGIN_API, arcadeLogin } from './arcade-login.ts'
import { readCookie, sessionCookieName } from './auth.ts'
import { passCookieName, passRevoked, readPass } from './edge-auth.ts'
import { listQuery, namesOthers } from './history-index.ts'
import { daysReplica, searchReplica, type ReplicaDb } from './history-replica.ts'
import { noLog, type Logger } from './log.ts'
import { manifestAnswer, manifestClub } from './manifest.ts'

/** The header the Worker puts on a table connection: who it is (ARCHITECTURE.md §5.10) */
export const TABLE_USER_HEADER = 'X-TBT-User'
/** And which club's member it is (e12-t03): a table takes sockets only for its own club */
export const TABLE_CLUB_HEADER = 'X-TBT-Club'

interface Fetches {
  fetch(request: Request): Promise<Response>
}

/** Where the Worker sends requests; `worker/index.ts` gives the Durable Objects, the tests fakes */
export interface Routes {
  /** The clubs served (shared/clubs.ts `knownClubs`); 淡江 alone when not given */
  clubs?: readonly string[]
  /**
   * A club the platform opened (e12-t06, worker/clubs.ts `ClubRegistryCache`), asked only for a
   * club not in `clubs`: its status, or null when there is none. A suspended club's API and
   * sockets are answered `clubSuspended` here (its object refuses them too, e12-t05)
   */
  findClub?(clubId: string): Promise<ClubStatus | null>
  /** The clubs the platform opened that are not suspended (the registry), for the cross-club lobby (e12-t07) */
  openClubs?(): Promise<string[]>
  /** The platform's notices that are out (e12-t15), from the same cached read as the registry; never one call per page view */
  platformNotices?(): Promise<PlatformNotice[]>
  /** A club's object (shared/clubs.ts); the routing only asks for clubs that exist */
  club(clubId: string): Fetches & {
    /** The member signed in with this session token, or null (one call per table connection, not per message) */
    socketUser(token: string | null): Promise<string | null>
    /**
     * The cross-club lobby (e12-t07): whether the club's member may use it, the club's tables shown
     * to other clubs, one of them as a guest watches it. Left out (tests that do not need it): off
     */
    publicViewer?(userId: string): Promise<boolean>
    publicTables?(): Promise<PublicTable[]>
    guestTable?(tableId: string): Promise<GuestTable | null>
    /** The name the club is shown by (its `meta:club`), for its home-screen app's manifest; its id when left out */
    clubName?(): Promise<string>
    /** Whether this session is a member's, and the club's banner (e12-t15): one call, for `GET /api/notices` */
    memberNotices?(token: string | null): Promise<{ signedIn: boolean; banner: ClubBanner | null }>
    /** The member signed in with this session token and the name they are shown by, for TKU Arcade (e1-t37) */
    arcadeIdentity?(token: string | null): Promise<{ id: string; name: string } | null>
  }
  /** A club's table's object: `tableObjectName(clubId, tableId)`, so one club never reaches another's (e12-t03) */
  table(clubId: string, tableId: string): Fetches
  assets: Fetches
  /**
   * What the Worker answers by itself (§5.12): `secret` checks edge passes (`EDGE_AUTH_SECRET`),
   * `revocations` the D1 list of ended sessions (e11-t28): a pass is trusted only once it is checked
   * there, so without it (a PR preview) the club decides. `history` is the history index's D1 copy.
   * Any of them missing (switched off, a PR preview) means the club answers, as before. A pass and
   * the copy's rows are a club's (e12-t03): another club's pass is never taken, and a club's pages
   * are read from its own rows only
   */
  edge?: { secret?: string; revocations?: ReplicaDb; history?: ReplicaDb; now?: () => number; log?: Logger }
  /**
   * Signing in to TKU Arcade (e1-t37, worker/arcade-login.ts): the shared secret and the arcade's
   * origins. Either missing: the endpoint answers `arcadeLoginOff`
   */
  arcade?: { secret?: string; origins?: string; log?: Logger }
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
  // Club applications (e12-t06) always reach 淡江's object, which keeps the platform's registry,
  // whichever club the page was opened in (even one that does not exist or is suspended)
  if (pathname === CLUB_APPLY_API) {
    const headers = new Headers(request.headers)
    headers.delete(CLUB_HEADER)
    return routes.club(DEFAULT_CLUB_ID).fetch(new Request(request, { headers }))
  }
  // TKU Arcade's sign-in (e1-t37) is for 淡江's members only, whatever club the request names: only
  // 淡江's session cookie is read and only 淡江's object is asked
  if (pathname === ARCADE_LOGIN_API) {
    const tku = routes.club(DEFAULT_CLUB_ID)
    return arcadeLogin(request, {
      ...routes.arcade,
      identity: (token) => tku.arcadeIdentity?.(token) ?? Promise.resolve(null),
      sessionToken: readCookie(request.headers.get('Cookie'), sessionCookieName(DEFAULT_CLUB_ID)),
      now: routes.edge?.now,
    })
  }
  // Another club's home-screen app (`/c/<id>/manifest.webmanifest`): the club is in the path
  const manifestOf = manifestClub(pathname)
  if (manifestOf !== null && request.method === 'GET') return clubManifestAnswer(manifestOf, url, routes)
  // The club the request is for (e12-t02): `X-Club-Id` or `?club=`, none means 淡江
  let clubId = requestClubId(request, routes.clubs ?? CLUB_IDS)
  const served = pathname === '/ws' || pathname.startsWith('/api/') || pathname.startsWith(TABLE_SOCKET_PREFIX)
  // A club the platform opened (e12-t06): the registry says whether it is there and whether suspended
  let suspended = false
  if (clubId === null && routes.findClub) {
    const named = request.headers.get(CLUB_HEADER) ?? url.searchParams.get(CLUB_PARAM) ?? ''
    const status = await routes.findClub(named)
    if (status) {
      clubId = named
      suspended = status === 'suspended'
    }
  }
  if (clubId === null && served) return errorAnswer('unknownClub', 404)
  // The app itself is the same for every club
  if (clubId === null) return routes.assets.fetch(request)
  if (suspended && served) return errorAnswer('clubSuspended', 403)
  // A socket opened by another site's page is turned away (cross-site WebSocket hijacking, ASVS
  // 13.2; docs/SECURITY.md): browsers always send Origin on a WebSocket, other clients may leave it out
  if ((pathname === '/ws' || pathname.startsWith(TABLE_SOCKET_PREFIX)) && !sameOrigin(request, url)) {
    return new Response('Forbidden', { status: 403 })
  }
  const club = () => routes.club(clubId)
  const now = routes.edge?.now ?? Date.now
  const cookies = request.headers.get('Cookie')
  // Who the pass is for, if it is good, made by this club (e12-t03) and its session has not ended
  // (e11-t28); otherwise null and the club decides
  const passUser = async () => {
    const { secret, revocations, log = noLog } = routes.edge ?? {}
    if (!secret || !revocations) return null
    const pass = await readPass(secret, readCookie(cookies, passCookieName(clubId)), now(), clubId)
    if (!pass) return null
    const started = now()
    try {
      if (!(await passRevoked(revocations, pass.sessionId, now()))) return pass.userId
      log({ event: 'edge', path: pathname, ms: now() - started, fallback: 'revoked' })
    } catch {
      log({ event: 'edge', path: pathname, ms: now() - started, fallback: 'error' })
    }
    return null
  }
  if (pathname.startsWith(TABLE_SOCKET_PREFIX)) {
    const tableId = pathname.slice(TABLE_SOCKET_PREFIX.length)
    if (!TABLE_ID_PATTERN.test(tableId)) return new Response('Not found', { status: 404 })
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 })
    const userId = (await passUser()) ?? (await club().socketUser(readCookie(cookies, sessionCookieName(clubId))))
    if (!userId) return new Response('Unauthorized', { status: 401 })
    const headers = new Headers(request.headers)
    headers.set(TABLE_USER_HEADER, userId)
    headers.set(TABLE_CLUB_HEADER, clubId)
    return routes.table(clubId, tableId).fetch(new Request(request, { headers }))
  }
  const history = routes.edge?.history
  // Each club's pages from its own rows of the D1 copy (e12-t03)
  if (history && request.method === 'GET' && EDGE_HISTORY.has(pathname)) {
    const userId = await passUser()
    const answer = userId && (await edgeHistory(url, clubId, userId, history, now, routes.edge?.log ?? noLog))
    if (answer) return answer
  }
  if (pathname === NOTICES_API && request.method === 'GET') return noticesAnswer(cookies, clubId, routes, now)
  if (pathname.startsWith(PUBLIC_API)) {
    const userId = (await passUser()) ?? (await club().socketUser(readCookie(cookies, sessionCookieName(clubId))))
    return publicApi(pathname, request.method, clubId, userId, routes)
  }
  if (pathname === '/ws' || pathname.startsWith('/api/')) return club().fetch(request)
  return routes.assets.fetch(request)
}

/**
 * A club's web app manifest (worker/manifest.ts): 淡江's static one for `/c/tku/`, the static one
 * made the club's for a club that is served, 404 for a club no one knows, 403 for a suspended one
 */
async function clubManifestAnswer(clubId: string, url: URL, routes: Routes): Promise<Response> {
  const own = new Request(new URL('/manifest.webmanifest', url))
  if (clubId === DEFAULT_CLUB_ID) return routes.assets.fetch(own)
  if (!(routes.clubs ?? CLUB_IDS).includes(clubId)) {
    const status = (await routes.findClub?.(clubId)) ?? null
    if (status === null) return errorAnswer('unknownClub', 404)
    if (status === 'suspended') return errorAnswer('clubSuspended', 403)
  }
  const base = await routes.assets.fetch(own)
  if (!base.ok) return base
  const name = (await routes.club(clubId).clubName?.().catch(() => null)) ?? clubId
  return manifestAnswer((await base.json()) as Record<string, unknown>, clubId, name)
}

/**
 * What a member's page shows on top (e12-t15, ARCHITECTURE.md §1「公告」): their club's banner, asked
 * of their own club with the session in one call, and the platform's notices, from this isolate's
 * copy of the registry. Other clubs' objects are never asked, and 淡江's at most once per copy
 */
async function noticesAnswer(cookies: string | null, clubId: string, routes: Routes, now: () => number): Promise<Response> {
  const own = await routes.club(clubId).memberNotices?.(readCookie(cookies, sessionCookieName(clubId)))
  if (!own?.signedIn) return errorAnswer('signInFirst', 401)
  const platform = (await routes.platformNotices?.().catch(() => [])) ?? []
  return jsonAnswer({ platform: platform.filter((notice) => noticeLive(notice, now())), club: own.banner } satisfies NoticesView)
}

/** The cross-club lobby's API, answered by the Worker from every club (e12-t07) */
const PUBLIC_API = '/api/public/'

/**
 * The cross-club lobby (e12-t07, ARCHITECTURE.md §1「跨社團大廳」): `GET /api/public/lobby` lists the
 * tables every other club shows to other clubs, `GET /api/public/tables/<club>/<id>` is one of them
 * as a guest watches it. Only for a member signed in to their own club (the request's), whose club
 * joined it and who has it (`publicViewer`, the `publicLobby` flag); each other club decides what
 * it shows (`ClubService.publicTables`, `guestTable`). Never a seat, a chat or a member id: the
 * guest is only shown the table. A club's own tables are in its own lobby, not here
 */
async function publicApi(pathname: string, method: string, clubId: string, userId: string | null, routes: Routes): Promise<Response> {
  if (method !== 'GET') return errorAnswer('noSuchApi', 404)
  if (!userId) return errorAnswer('signInFirst', 401)
  const own = routes.club(clubId)
  if (!(await own.publicViewer?.(userId))) return errorAnswer('publicLobbyOff', 403)
  // Every club served: 淡江, `CLUBS`'s and the ones the platform opened and did not suspend
  const clubs = [...new Set([...(routes.clubs ?? CLUB_IDS), ...((await routes.openClubs?.().catch(() => [])) ?? [])])]
  if (pathname === `${PUBLIC_API}lobby`) {
    const lists = await Promise.all(
      clubs
        .filter((id) => id !== clubId)
        .map((id) => Promise.resolve(routes.club(id).publicTables?.() ?? []).catch((): PublicTable[] => [])),
    )
    const tables = lists.flat().sort((a, b) => a.clubName.localeCompare(b.clubName) || a.number - b.number)
    return jsonAnswer({ tables } satisfies PublicLobby)
  }
  const watched = /^\/api\/public\/tables\/([a-z][a-z0-9-]*)\/([^/]+)$/.exec(pathname)
  if (!watched) return errorAnswer('noSuchApi', 404)
  const [, hostClub, tableId] = watched
  if (!clubs.includes(hostClub)) return errorAnswer('unknownClub', 404)
  if (hostClub === clubId || !TABLE_ID_PATTERN.test(tableId)) return errorAnswer('tableGone', 404)
  const table = (await routes.club(hostClub).guestTable?.(tableId)) ?? null
  return table ? jsonAnswer({ table }) : errorAnswer('tableGone', 404)
}

const jsonAnswer = (data: unknown) =>
  new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } })


/** Whether a request came from a page of this site, or names no page at all (no Origin) */
function sameOrigin(request: Request, url: URL): boolean {
  const origin = request.headers.get('Origin')
  if (origin === null) return true
  try {
    return new URL(origin).host === url.host
  } catch {
    return false
  }
}

/** The answer for a club no one knows or one suspended, shaped like the club's own errors */
function errorAnswer(code: MessageCode, status: number): Response {
  return new Response(JSON.stringify({ error: formatMessage(code, 'zh', {}), code, params: {} }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

/**
 * A history page from the D1 copy, exactly as the club would answer it (`Club.api`), or null to let
 * the club answer: a query the club would refuse (it sends the error), one by favorite tag (the
 * tags are only in the club), one for another member as player or declarer (whether they keep their
 * boards off their profile is only in the club, e13-t08), a copy not complete, or D1 failing
 */
async function edgeHistory(url: URL, clubId: string, userId: string, db: ReplicaDb, now: () => number, log: Logger): Promise<Response | null> {
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
  if (query.tag || namesOthers(query, userId)) return null
  try {
    const page =
      url.pathname === '/api/history/days'
        ? await daysReplica(db, clubId, query, userId, now()).then((days) => days && { days })
        : await searchReplica(db, clubId, query, userId, now())
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
