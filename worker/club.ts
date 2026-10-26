import { DurableObject } from 'cloudflare:workers'
import { AppError } from '../shared/messages.ts'
import type { ChallengeSettings } from '../shared/challenge.ts'
import { parseHistoryQuery } from '../shared/history-query.ts'
import { MESSAGE_MAX_CHARS } from '../shared/message-guard.ts'
import type { BoardRecord, Me, ServerMessage } from '../shared/protocol.ts'
import { TKU } from '../shared/robot/system/tku/index.ts'
import { bookSync } from '../shared/robot/system/tku/sources.ts'
import { randomId, readCookie, SESSION_COOKIE, sessionCookie } from './auth.ts'
import { backupAdmin, runBackup } from './backup.ts'
import { BookService, importRequestFrom, publicBookResponse } from './book.ts'
import { claudeImporter } from './importer.ts'
import { anonymousProfileResponse, ProfileService } from './profiles.ts'
import { adminRouteNeed, bookRouteNeed, clubRouteNeed, requireNeed } from './roles.ts'
import { CLIENT_ERROR_MAX_CHARS } from './client-errors.ts'
import { d1Replica } from './d1.ts'
import { edgeSecret, mintPass, PASS_COOKIE, passCookie, passNeedsRefresh } from './edge-auth.ts'
import { crashEntry, jsonLog } from './log.ts'
import { type ChallengeRequest, ClubError, ClubService, type Connections } from './service.ts'
import type { EventReport } from './modes.ts'
import type { Store } from './store.ts'
import { TeamService } from './teams.ts'
import type { TableObject } from './table-object.ts'
import type { EventObject } from './event-object.ts'
import { RemoteEvents, type EventRpc, type EventSnapshot } from './events.ts'
import { RemoteTables, type TableEntry, type TableRpc } from './tables.ts'
import type { MatchAction, MatchPlayAction } from './team-match-service.ts'

export interface Env {
  CLUB: DurableObjectNamespace<Club>
  /** Each table's own object (ARCHITECTURE.md §5.10) */
  TABLE: DurableObjectNamespace<TableObject>
  /** "off" keeps the tables in the club's object and brings back any moved out (DEPLOY.md, the switch back) */
  TABLE_OBJECTS?: string
  /** Each challenge's own object (H2b, ARCHITECTURE.md §5.12) */
  EVENT: DurableObjectNamespace<EventObject>
  /**
   * "on" moves the challenges into their own objects; anything else (the default) keeps them in
   * the club's object and brings back any moved out (DEPLOY.md §4.6, the switch back)
   */
  EVENT_OBJECTS?: string
  ASSETS: Fetcher
  MAX_USERS?: string
  INVITE_CODE?: string
  /** For TKU BridgeBook's AI import (wrangler secret put ANTHROPIC_API_KEY) */
  ANTHROPIC_API_KEY?: string
  IMPORT_MODEL?: string
  /** Only for tests or an API gateway */
  ANTHROPIC_BASE_URL?: string
  /** Daily backups (worker/backup.ts); the bucket is created by hand before deploying (DEPLOY.md §4.4) */
  BACKUPS?: R2Bucket
  /**
   * The history index's D1 copy (ARCHITECTURE.md §5.12): its own database per environment, created
   * by hand before deploying (DEPLOY.md §4.5); none in PR previews
   */
  HISTORY?: D1Database
  /** "off" stops keeping and reading the D1 copy: the switch back (DEPLOY.md §4.5) */
  HISTORY_D1?: string
  /** Signs edge passes (wrangler secret put EDGE_AUTH_SECRET); without it the Worker asks the club every time */
  EDGE_AUTH_SECRET?: string
  /** "off" stops handing out and reading edge passes: the switch back (DEPLOY.md §4.5) */
  EDGE_AUTH?: string
}

/** The import upload comes straight from TKU BridgeBook's page; its single-use pass is the check */
const IMPORT_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
}

interface Attachment {
  userId: string
}

type Body = Record<string, unknown>
/** The largest JSON body an API reads (TKU BridgeBook's convention saves are the big ones) */
const BODY_MAX_BYTES = 2 * 1024 * 1024
const text = (value: unknown) => String(value ?? '')

/**
 * The club's Durable Object: accounts, the lobby and its table directory, history, challenges,
 * matches and TKU BridgeBook. Each table runs in its own `TableObject` (ARCHITECTURE.md §5.10),
 * which reports back through the RPC methods below. WebSockets use the hibernation API, so an idle
 * club costs nothing and wakes up with its sockets still attached.
 */
export class Club extends DurableObject<Env> implements Connections {
  private readonly service: ClubService
  /** Replaced after a backup is restored, so nothing they cached survives */
  private book: BookService
  private profiles: ProfileService
  /** TKU BridgeBook's teams and partnerships (E2); keeps nothing in memory, so it outlives a restore */
  private readonly teams: TeamService
  private readonly store: Store
  /** Signs edge passes (§5.12); none when switched off */
  private readonly edgeSecret: string | undefined

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    const storage = ctx.storage
    const store: Store = (this.store = {
      get: (key) => storage.get(key),
      put: (key, value) => storage.put(key, value),
      delete: async (key) => {
        await storage.delete(key)
      },
      list: (prefix, options = {}) => storage.list({ prefix, ...options }),
      sql: {
        exec: (query, ...params) => storage.sql.exec(query, ...params).toArray() as never,
        transaction: (fn) => storage.transactionSync(fn),
      },
    })
    this.service = new ClubService(store, this, {
      maxUsers: Number(env.MAX_USERS ?? 10),
      inviteCode: env.INVITE_CODE || undefined,
      // One alarm wakes the object for every robot move and deal, so it can hibernate in between
      wake: (at) => void storage.setAlarm(at),
      log: jsonLog,
      // Each table in its own object (§5.10), unless switched back with TABLE_OBJECTS=off
      tableObjects: new RemoteTables((tableId) => env.TABLE.get(env.TABLE.idFromName(tableId)) as unknown as TableRpc),
      tablesInClub: env.TABLE_OBJECTS === 'off',
      // Each challenge in its own object (H2b, §5.12) only when switched on; off by default
      eventObjects: new RemoteEvents(
        (challengeId) => env.EVENT.get(env.EVENT.idFromName(`challenge:${challengeId}`)) as unknown as EventRpc,
      ),
      eventObjectsOn: env.EVENT_OBJECTS === 'on',
      // The history pages' copy in D1, read by the Worker (§5.12)
      historyReplica: env.HISTORY ? d1Replica(env.HISTORY) : undefined,
      historyReplicaOff: env.HISTORY_D1 === 'off',
    })
    this.edgeSecret = edgeSecret(env)
    this.book = new BookService(store)
    this.profiles = new ProfileService(store, Date.now, (id) => this.service.usernameOf(id))
    this.teams = new TeamService(store, {
      now: Date.now,
      newId: () => randomId(6),
      usernameOf: (id) => this.service.usernameOf(id),
      members: () => this.service.memberDirectory(),
      notify: (id, kind, params) => this.service.notifications.notify(id, kind, params),
      profiles: () => this.profiles,
    })
    // Browsers send "ping" every few seconds to keep phone connections alive and to notice a dead
    // one quickly; the runtime answers without waking the object
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
    ctx.blockConcurrencyWhile(() => this.service.load())
  }

  async alarm() {
    await this.service.runDue()
  }

  /** The daily backup to R2, called by the cron trigger (worker/index.ts `scheduled`) */
  async backup() {
    if (!this.env.BACKUPS) {
      jsonLog({ event: 'backup', ok: false, error: 'no BACKUPS binding' })
      return null
    }
    try {
      const result = await runBackup(this.store, this.env.BACKUPS, Date.now())
      jsonLog({ event: 'backup', ok: true, name: result.name, keys: result.keys, bytes: result.bytes, deleted: result.deleted.length })
      return result
    } catch (error) {
      jsonLog({ event: 'backup', ok: false, error: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }

  // ── What the tables and the Worker ask over RPC (ARCHITECTURE.md §5.10) ────────────────────

  /** A table's lobby entry changed (`ClubLink.changed`) */
  async tableChanged(entry: TableEntry) {
    await this.service.link.changed(entry)
  }

  /** A table closed (`ClubLink.closed`) */
  async tableClosed(tableId: string) {
    await this.service.link.closed(tableId)
  }

  /** A table finished a board (`ClubLink.boardFinished`); a failure makes the table offer it again */
  async tableBoardFinished(record: BoardRecord, event: EventReport | null) {
    await this.service.link.boardFinished(record, event)
  }

  /** Whether a member may seat TKB in the club's system (`ClubLink.mayUseTku`) */
  async tableMayUseTku(userId: string): Promise<boolean> {
    return this.service.link.mayUseTku(userId)
  }

  /** A challenge in its own object changed on its own (`EventLink.changed`, H2b); a failure makes it tell again */
  async eventChanged(snapshot: EventSnapshot) {
    await this.service.eventLink.changed(snapshot)
  }

  /** Whose session this is, for a table's connection: the Worker asks once per connection */
  async socketUser(token: string | null): Promise<string | null> {
    return (await this.service.userForToken(token))?.id ?? null
  }

  onlineUserIds(): string[] {
    const ids = this.ctx
      .getWebSockets()
      .filter((ws) => ws.readyState === WebSocket.OPEN)
      .map((ws) => (ws.deserializeAttachment() as Attachment).userId)
    return [...new Set(ids)]
  }

  send(userId: string, message: ServerMessage) {
    const payload = JSON.stringify(message)
    for (const ws of this.ctx.getWebSockets(userId)) {
      try {
        ws.send(payload)
      } catch {
        // The socket is closing; webSocketClose cleans up
      }
    }
  }

  disconnect(userId: string) {
    for (const ws of this.ctx.getWebSockets(userId)) ws.close(4001, 'signed out')
  }

  /** Every request is logged as one `http` entry: method, path (no query), status, time, error code */
  async fetch(request: Request): Promise<Response> {
    const started = Date.now()
    const url = new URL(request.url)
    let response: Response
    let code: string | undefined
    try {
      response = await this.route(request, url)
    } catch (error) {
      code = error instanceof AppError ? error.code : 'serverError'
      response = errorResponse(error)
    }
    jsonLog({ event: 'http', method: request.method, path: url.pathname, status: response.status, ms: Date.now() - started, ...(code ? { code } : {}) })
    await this.edgePass(request, url, response)
    return response
  }

  /**
   * Hands out an edge pass (§5.12) with an API answer when the browser's is missing or more than
   * half used, and clears it when its session is gone. Signing in and out set their own; answers a
   * cache may keep (TKU BridgeBook's content, with an ETag) never carry one
   */
  private async edgePass(request: Request, url: URL, response: Response) {
    const secret = this.edgeSecret
    if (!secret || !url.pathname.startsWith('/api/') || url.pathname === '/api/book/import') return
    if (response.headers.has('Set-Cookie') || response.headers.get('Cache-Control') !== 'no-store') return
    const cookies = request.headers.get('Cookie')
    const token = readCookie(cookies, SESSION_COOKIE)
    const pass = readCookie(cookies, PASS_COOKIE)
    if (!token && !pass) return
    try {
      if (!(await passNeedsRefresh(secret, pass, Date.now()))) return
      const user = await this.service.userForToken(token)
      const secure = url.protocol === 'https:'
      if (user) response.headers.append('Set-Cookie', passCookie(await mintPass(secret, user.id, Date.now()), secure))
      else if (pass) response.headers.append('Set-Cookie', passCookie('', secure))
    } catch (error) {
      // An answer whose headers cannot change (none of ours): the Worker asks the club instead
      jsonLog(crashEntry('edgePass', error))
    }
  }

  /** The cookies of a sign-in: the session, and its first edge pass when passes are on */
  private async signedIn(token: string, userId: string, secure: boolean): Promise<string[]> {
    const cookies = [sessionCookie(token, secure)]
    if (this.edgeSecret) cookies.push(passCookie(await mintPass(this.edgeSecret, userId, Date.now()), secure))
    return cookies
  }

  private async route(request: Request, url: URL): Promise<Response> {
    const token = readCookie(request.headers.get('Cookie'), SESSION_COOKIE)
    if (url.pathname === '/api/book/import') return this.importUpload(request)
    if (url.pathname === '/ws') return this.upgrade(request, token)
    return this.api(request, url, token)
  }

  /** TKU BridgeBook's AI import: streams Claude's reply straight back to the page */
  private async importUpload(request: Request): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: IMPORT_CORS })
    let response: Response
    try {
      if (request.method !== 'POST') throw new ClubError('noSuchApi', {}, 404)
      const form = await request.formData().catch(() => null)
      const { ticket, request: job } = importRequestFrom(form)
      this.service.requirePermission(await this.book.useTicket(ticket), 'bookImport')
      if (!this.env.ANTHROPIC_API_KEY) throw new ClubError('importOff', {}, 503)
      const importer = claudeImporter(this.env.ANTHROPIC_API_KEY, this.env.IMPORT_MODEL || undefined, this.env.ANTHROPIC_BASE_URL || undefined)
      const upstream = await importer(job)
      response = new Response(upstream.body, {
        headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' },
      })
    } catch (error) {
      response = errorResponse(error)
    }
    for (const [key, value] of Object.entries(IMPORT_CORS)) response.headers.set(key, value)
    return response
  }

  private async upgrade(request: Request, token: string | null) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 })
    const user = await this.service.userForToken(token)
    if (!user) return new Response('Unauthorized', { status: 401 })
    const { 0: client, 1: server } = new WebSocketPair()
    this.ctx.acceptWebSocket(server, [user.id])
    server.serializeAttachment({ userId: user.id } satisfies Attachment)
    this.service.connected(user.id)
    return new Response(null, { status: 101, webSocket: client })
  }

  private async api(request: Request, url: URL, token: string | null) {
    const secure = url.protocol === 'https:'
    const route = `${request.method} ${url.pathname}`
    const body = async () => {
      if (Number(request.headers.get('Content-Length') ?? 0) > BODY_MAX_BYTES) throw new ClubError('messageTooLarge', {}, 413)
      return (await request.json().catch(() => ({}))) as Body
    }

    if (route === 'GET /api/health') return json(this.service.health())
    if (route === 'POST /api/client-errors') {
      // Reports come before sign-in too, so this needs none; the service cleans and rate-limits them
      if (Number(request.headers.get('Content-Length') ?? 0) > CLIENT_ERROR_MAX_CHARS * 4)
        throw new ClubError('messageTooLarge', {}, 413)
      if (!this.service.reportClientError(await request.text())) throw new ClubError('badMessage')
      return new Response(null, { status: 204 })
    }
    if (route === 'POST /api/register') {
      const b = await body()
      const result = await this.service.register(
        text(b.username),
        text(b.password),
        text(b.inviteCode),
        text(b.note),
        b.site === 'book' ? 'book' : 'table',
      )
      if ('pending' in result) return json(result, 202)
      return json({ user: result.user }, 200, ...(await this.signedIn(result.token, result.user.id, secure)))
    }
    if (route === 'POST /api/login') {
      const b = await body()
      const { user, token: newToken } = await this.service.login(
        text(b.username),
        text(b.password),
        request.headers.get('CF-Connecting-IP') ?? '',
      )
      return json({ user }, 200, ...(await this.signedIn(newToken, user.id, secure)))
    }
    if (route === 'POST /api/logout') {
      if (token) await this.service.logout(token)
      return json({ ok: true }, 200, sessionCookie('', secure), passCookie('', secure))
    }
    if (route === 'POST /api/password/reset') {
      const b = await body()
      await this.service.resetForgottenPassword(text(b.username), text(b.inviteCode), text(b.password))
      return json({ ok: true })
    }
    const open = await publicBookResponse(this.book, request, url.pathname)
    if (open) return open

    const user = await this.service.userForToken(token)
    if (!user) {
      // Without signing in, only the club's own system profile
      const profiles = await anonymousProfileResponse(this.profiles, request, url.pathname)
      if (profiles) return json(Array.isArray(profiles) ? { profiles } : { profile: profiles })
      throw new ClubError('signInFirst', {}, 401)
    }
    if (route === 'GET /api/me') return json({ user })
    if (url.pathname.startsWith('/api/book/')) return this.bookApi(request, url, user, body)
    if (url.pathname.startsWith('/api/club/')) return this.clubApi(request, url, user, body)
    if (route === 'POST /api/account/password') {
      const b = await body()
      await this.service.changePassword(user.id, text(b.current), text(b.next))
      return json({ ok: true })
    }
    if (route === 'POST /api/account/preferences') {
      const b = await body()
      return json({ user: await this.service.setAccountPreferences(user.id, { friendOnlineNotice: b.friendOnlineNotice, bookProfile: b.bookProfile }) })
    }
    if (route === 'PATCH /api/account/profile') return json({ user: await this.service.setProfile(user.id, await body()) })
    // Another member's profile card (AC-1.5)
    const member = url.pathname.match(/^\/api\/members\/([\w-]+)$/)
    if (request.method === 'GET' && member) return json({ member: await this.service.memberProfile(user.id, member[1]) })
    // A page of the member's own conversation with another member (AC-1.7); new messages come over the socket
    const conversation = url.pathname.match(/^\/api\/messages\/([\w-]+)$/)
    if (request.method === 'GET' && conversation) {
      const before = url.searchParams.get('before')
      return json(this.service.directPage(user.id, conversation[1], before === null ? undefined : Number(before)))
    }
    if (route === 'GET /api/history') {
      const query = url.searchParams
      const all = query.get('scope') === 'all'
      return json(await this.service.history(user.id, all, Number(query.get('page') ?? 1), Number(query.get('size') ?? 0) || undefined))
    }
    if (route === 'GET /api/history/search') return json(await this.service.search(user.id, parseHistoryQuery(url.searchParams)))
    const record = url.pathname.match(/^\/api\/history\/([\w-]+)$/)
    if (request.method === 'GET' && record) {
      const found = await this.service.record(record[1], user.id)
      if (!found) throw new ClubError('boardGone', {}, 404)
      return json({ record: found })
    }
    // A board's traveller (e4-t32): null when it has none the member may see
    const traveller = url.pathname.match(/^\/api\/history\/([\w-]+)\/traveller$/)
    if (request.method === 'GET' && traveller) return json({ traveller: await this.service.traveller(traveller[1], user.id) })
    // Featured boards (e4-t29): everyone reads them, members with `boardCurate` feature, edit and remove
    if (route === 'GET /api/featured') return json({ featured: await this.service.featured.list(user.id) })
    const featured = url.pathname.match(/^\/api\/featured\/([\w-]+)$/)
    if (featured && request.method === 'GET') return json({ featured: await this.service.featured.get(featured[1], user.id) })
    if (featured && request.method === 'POST')
      return json({ featured: await this.service.featured.set(user.id, featured[1], await body()) })
    if (featured && request.method === 'DELETE') {
      await this.service.featured.remove(user.id, featured[1])
      return json({ ok: true })
    }
    // Favorites (AC-4.4): the list filters as history does, plus `tag`; one board's note and tags
    if (route === 'GET /api/favorites') return json(await this.service.favorites(user.id, parseHistoryQuery(url.searchParams)))
    if (route === 'GET /api/favorites/ids') return json({ ids: this.service.favoriteIds(user.id) })
    const favorite = url.pathname.match(/^\/api\/favorites\/([\w-]+)$/)
    if (favorite && request.method === 'GET') return json(await this.service.favorite(user.id, favorite[1]))
    if (favorite && request.method === 'PUT') {
      const b = await body()
      return json({ favorite: await this.service.saveFavorite(user.id, favorite[1], { note: b.note, tags: b.tags }) })
    }
    if (favorite && request.method === 'DELETE') {
      this.service.removeFavorite(user.id, favorite[1])
      return json({ ok: true })
    }
    if (route === 'GET /api/challenges') return json({ challenges: this.service.challengeList(user.id) })
    // The challenge pages create, answer and cancel over HTTP to hear back at once (e7-t16, e7-t17)
    if (route === 'POST /api/challenges') {
      const b = await body()
      return json({
        challenge: await this.service.challengeRequest(user.id, {
          type: 'createChallenge',
          invitees: b.invitees as string[],
          boards: b.boards as number | undefined,
          settings: b.settings as Partial<ChallengeSettings> | undefined,
          fromBoards: b.fromBoards as string[] | undefined,
        }),
      })
    }
    const challengeAction = url.pathname.match(/^\/api\/challenges\/([\w-]+)\/(answer|cancel|rematch)$/)
    if (request.method === 'POST' && challengeAction) {
      const [, challengeId, action] = challengeAction
      // A rematch answers with the new challenge
      const message: ChallengeRequest =
        action === 'answer'
          ? { type: 'answerChallenge', challengeId, accept: (await body()).accept as boolean }
          : action === 'cancel'
            ? { type: 'cancelChallenge', challengeId }
            : { type: 'rematchChallenge', challengeId }
      return json({ challenge: await this.service.challengeRequest(user.id, message) })
    }
    const challenge = url.pathname.match(/^\/api\/challenges\/([\w-]+)$/)
    if (request.method === 'GET' && challenge) {
      const found = await this.service.challengeDetail(challenge[1], user.id)
      if (!found) throw new ClubError('challengeGone', {}, 404)
      return json({ challenge: found })
    }
    // Team matches (§5.8): set up (e8-t03), seated (e8-t04, e8-t05) and started (e8-t07) over HTTP
    if (route === 'GET /api/matches') return json({ matches: this.service.matches.list(user.id) })
    if (route === 'POST /api/matches') {
      const b = await body()
      return json({ match: this.service.matches.create(user.id, { settings: b.settings, seat: b.seat }) })
    }
    const matchAction = url.pathname.match(
      /^\/api\/matches\/([\w-]+)\/(settings|cancel|start|invite|answer|move|leave|clear|robot|rule|pause|abandon|replace|sitin)$/,
    )
    if (request.method === 'POST' && matchAction) {
      const [, matchId, action] = matchAction
      // While it is played (e8-t14–e8-t16): rulings, the pause, abandoning, substitutes, robots sitting in
      const play = { rule: 'matchRule', pause: 'matchPause', abandon: 'matchAbandon', replace: 'matchReplace', sitin: 'matchSitIn' } as const
      if (action in play) {
        const message = { ...(await body()), type: play[action as keyof typeof play], matchId } as MatchPlayAction
        return json({ match: await this.service.matchPlayRequest(user.id, message) })
      }
      if (action === 'settings') return json({ match: this.service.matches.update(user.id, matchId, (await body()).settings) })
      if (action === 'cancel') return json({ match: await this.service.matches.cancel(user.id, matchId) })
      if (action === 'start') return json({ match: await this.service.startMatchRequest(user.id, matchId) })
      const type = `match${action[0].toUpperCase()}${action.slice(1)}`
      const message = { ...(await body()), type, matchId } as MatchAction
      return json({ match: await this.service.matches.request(user.id, message) })
    }
    const match = url.pathname.match(/^\/api\/matches\/([\w-]+)$/)
    if (request.method === 'GET' && match) {
      const found = this.service.matches.get(match[1], user.id)
      if (!found) throw new ClubError('matchGone', {}, 404)
      return json({ match: found })
    }
    if (url.pathname.startsWith('/api/admin/')) return this.admin(request, url, user, body)
    throw new ClubError('noSuchApi', {}, 404)
  }

  private async admin(request: Request, url: URL, user: Me, body: () => Promise<Body>) {
    const path = url.pathname.slice('/api/admin'.length)
    const method = request.method
    // Accounts are admins'; the rest is editors' too (roles.ts)
    requireNeed(user, adminRouteNeed(method, path))

    if (path === '/backups' || path.startsWith('/backups/'))
      return json(
        await backupAdmin(method, path, body, {
          bucket: this.env.BACKUPS,
          store: this.store,
          now: Date.now(),
          restored: () => {
            this.book = new BookService(this.store)
            this.profiles = new ProfileService(this.store, Date.now, (id) => this.service.usernameOf(id))
          },
        }),
      )
    if (method === 'GET' && path === '/users') return json({ users: await this.service.adminUsers() })
    if (method === 'POST' && path === '/users') {
      const b = await body()
      return json({ user: await this.service.adminCreateUser(text(b.username), text(b.password)) })
    }
    if (method === 'GET' && path === '/applications') return json({ applications: this.service.adminApplications() })
    const application = path.match(/^\/applications\/(\w+)(\/approve)?$/)
    if (application) {
      const [, id, approve] = application
      if (method === 'POST' && approve) return json({ user: await this.service.adminApprove(id) })
      if (method === 'DELETE' && !approve) {
        await this.service.adminReject(id)
        return json({ ok: true })
      }
      throw new ClubError('noSuchApi', {}, 404)
    }
    if (method === 'GET' && path === '/weekly-challenge') return json({ weekly: this.service.weeklyChallenge() })
    if (method === 'POST' && path === '/weekly-challenge')
      return json({ weekly: await this.service.adminSetWeeklyChallenge(user.id, await body()) })
    if (method === 'GET' && path === '/settings') return json({ settings: this.service.clubSettings })
    // The club's robot against 淡江橋館: articles edited online since its rules were checked (e5-t45)
    if (method === 'GET' && path === '/book-sync') return json({ sync: bookSync(TKU.books, await this.book.onlineArticles()) })
    if (method === 'POST' && path === '/settings') {
      const b = await body()
      const settings = await this.service.adminUpdateSettings({
        maxUsers: b.maxUsers === undefined ? undefined : Number(b.maxUsers),
        inviteCode: b.inviteCode === undefined ? undefined : text(b.inviteCode),
      })
      return json({ settings })
    }
    // Every role and permission change from the admin page's members section, in one request
    if (method === 'POST' && path === '/members') {
      await this.service.adminUpdateMembers(user.id, (await body()).changes)
      return json({ ok: true })
    }
    const member = path.match(/^\/users\/(\w+)(\/password|\/admin|\/permissions)?$/)
    if (member) {
      const [, id, action] = member
      if (method === 'DELETE' && !action) await this.service.adminDeleteUser(user.id, id)
      else if (method === 'POST' && action === '/password')
        await this.service.adminResetPassword(id, text((await body()).password))
      else if (method === 'POST' && action === '/admin')
        await this.service.adminSetAdmin(user.id, id, Boolean((await body()).admin))
      else if (method === 'POST' && action === '/permissions')
        await this.service.adminSetPermissions(id, (await body()).permissions)
      else throw new ClubError('noSuchApi', {}, 404)
      return json({ ok: true })
    }
    const table = path.match(/^\/tables\/(\w+)$/)
    if (method === 'DELETE' && table) {
      await this.service.adminCloseTable(table[1])
      return json({ ok: true })
    }
    throw new ClubError('noSuchApi', {}, 404)
  }

  /** TKU BridgeBook's teams and partnerships (E2). Who may use each route is in roles.ts */
  private async clubApi(request: Request, url: URL, user: Me, body: () => Promise<Body>) {
    const path = url.pathname.slice('/api/club'.length)
    const method = request.method
    const need = clubRouteNeed(method, path)
    if (!need) throw new ClubError('noSuchApi', {}, 404)
    requireNeed(user, need)

    if (path === '/members') return json({ members: this.teams.members() })
    if (path === '/teams') {
      if (method === 'GET') return json({ teams: await this.teams.teams() })
      return json({ team: await this.teams.createTeam(user, await body()) })
    }
    const member = path.match(/^\/teams\/([\w-]+)\/members(?:\/([\w-]+))?$/)
    if (member) {
      const [, teamId, userId] = member
      if (userId) return json({ team: await this.teams.removeMember(user, teamId, userId) })
      return json({ team: await this.teams.addMember(user, teamId, await body()) })
    }
    const team = path.match(/^\/teams\/([\w-]+)$/)
    if (team) {
      if (method === 'GET') return json(await this.teams.team(team[1]))
      return json({ team: await this.teams.updateTeam(user, team[1], await body()) })
    }
    if (path === '/pairs') {
      if (method === 'GET') return json({ pairs: await this.teams.pairsOf(user.id) })
      return json({ pair: await this.teams.invite(user, await body()) })
    }
    const pair = path.match(/^\/pairs\/([\w-]+)(?:\/(accept|decline|end))?$/)
    if (pair) {
      const [, pairId, action] = pair
      if (action === 'accept') return json({ pair: await this.teams.accept(user, pairId) })
      if (action === 'decline') {
        await this.teams.decline(user, pairId)
        return json({ ok: true })
      }
      if (action === 'end') return json({ pair: await this.teams.end(user, pairId) })
      return json({ pair: await this.teams.pair(pairId) })
    }
    throw new ClubError('noSuchApi', {}, 404)
  }

  /**
   * TKU BridgeBook's online editing and system profiles; reading the content (publicBookResponse)
   * needs no sign-in. Who may use each route is in roles.ts.
   */
  private async bookApi(request: Request, url: URL, user: Me, body: () => Promise<Body>) {
    const path = url.pathname.slice('/api/book'.length)
    const method = request.method
    const need = bookRouteNeed(method, path)
    if (!need) throw new ClubError('noSuchApi', {}, 404)
    requireNeed(user, need)

    const convention = path.match(/^\/conventions\/([\w-]+)(?:\/(hide|reset|revisions)(?:\/([\w-]+))?)?$/)
    if (convention) {
      const [, slug, action, revisionId] = convention
      if (method === 'PUT') return json({ entry: await this.book.save(user, slug, await body()) })
      if (action === 'hide') return json({ entry: await this.book.hide(user, slug, await body()) })
      if (action === 'reset') {
        await this.book.reset(user, slug, await body())
        return json({ ok: true })
      }
      if (revisionId) return json({ revision: await this.book.revision(slug, revisionId) })
      return json({ revisions: await this.book.revisions(slug) })
    }
    if (path === '/categories') return json(await this.book.saveCategories(user, await body()))

    if (path === '/profiles') {
      if (method === 'GET') return json({ profiles: await this.teams.readableProfiles(user) })
      return json({ profile: await this.profiles.create(user, await body()) })
    }
    // Which member may read, save or see the versions of a team's or partnership's profile: TeamService (e2-t04)
    const profile = path.match(/^\/profiles\/([\w-]+)(\/revisions(?:\/(\d+))?)?$/)
    if (profile) {
      const [, id, revisions, version] = profile
      if (revisions && version) return json({ revision: await this.teams.profileRevision(user, id, Number(version)) })
      if (revisions) return json({ revisions: await this.teams.profileRevisions(user, id) })
      if (method === 'GET') return json(await this.teams.readProfile(user, id))
      if (method === 'PUT') return json({ profile: await this.teams.saveProfile(user, id, await body()) })
      await this.profiles.remove(id, await body())
      return json({ ok: true })
    }

    if (path === '/import/ticket') {
      const ticket = await this.book.createTicket(user)
      return json({ ticket, url: `${url.origin}/api/book/import`, ready: !!this.env.ANTHROPIC_API_KEY })
    }
    if (path === '/drafts') {
      if (method === 'GET') return json({ drafts: await this.book.drafts() })
      return json({ draft: await this.book.saveDraft(user, await body()) })
    }
    const draft = path.match(/^\/drafts\/([\w-]+)$/)
    if (draft && method === 'GET') return json({ draft: await this.book.draft(draft[1]) })
    if (draft) {
      await this.book.deleteDraft(draft[1])
      return json({ ok: true })
    }
    throw new ClubError('noSuchApi', {}, 404)
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    const { userId } = ws.deserializeAttachment() as Attachment
    // Binary frames are decoded only up to 3 bytes per allowed character (UTF-8 never takes more per
    // UTF-16 unit), so a huge frame still decodes to an over-long string at little cost
    const raw = typeof data === 'string' ? data : new TextDecoder().decode(data.slice(0, MESSAGE_MAX_CHARS * 3 + 3))
    await this.service.handleRaw(userId, raw)
  }

  async webSocketClose(ws: WebSocket) {
    const { userId } = ws.deserializeAttachment() as Attachment
    ws.close()
    // getWebSockets() still lists a closing socket, so check for another open one
    const stillOpen = this.ctx
      .getWebSockets(userId)
      .some((other) => other !== ws && other.readyState === WebSocket.OPEN)
    if (!stillOpen) await this.service.disconnected(userId)
  }

  async webSocketError(ws: WebSocket) {
    await this.webSocketClose(ws)
  }
}

function json(data: unknown, status = 200, ...cookies: string[]) {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  for (const cookie of cookies) headers.append('Set-Cookie', cookie)
  return new Response(JSON.stringify(data), { status, headers })
}

function errorResponse(error: unknown) {
  if (error instanceof AppError) return json({ error: error.message, code: error.code, params: error.params }, error.status)
  jsonLog(crashEntry('http', error))
  return json({ error: '伺服器發生錯誤', code: 'serverError', params: {} }, 500)
}
