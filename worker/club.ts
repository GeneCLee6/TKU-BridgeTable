import { DurableObject } from 'cloudflare:workers'
import { AppError } from '../shared/messages.ts'
import type { ChallengeSettings } from '../shared/challenge.ts'
import { parseHistoryQuery } from '../shared/history-query.ts'
import { MESSAGE_MAX_CHARS } from '../shared/message-guard.ts'
import type { Me, ServerMessage } from '../shared/protocol.ts'
import { readCookie, SESSION_COOKIE, sessionCookie } from './auth.ts'
import { BookService, importRequestFrom, publicBookResponse } from './book.ts'
import { claudeImporter } from './importer.ts'
import { CLIENT_ERROR_MAX_CHARS } from './client-errors.ts'
import { crashEntry, jsonLog } from './log.ts'
import { type ChallengeRequest, ClubError, ClubService, type Connections } from './service.ts'
import type { Store } from './store.ts'
import type { MatchAction } from './team-match-service.ts'

export interface Env {
  CLUB: DurableObjectNamespace<Club>
  ASSETS: Fetcher
  MAX_USERS?: string
  INVITE_CODE?: string
  /** For TKU BridgeBook's AI import (wrangler secret put ANTHROPIC_API_KEY) */
  ANTHROPIC_API_KEY?: string
  IMPORT_MODEL?: string
  /** Only for tests or an API gateway */
  ANTHROPIC_BASE_URL?: string
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
 * The whole club lives in one Durable Object: a handful of members and tables fit easily, and a
 * single object means every action is applied in order with no coordination. WebSockets use the
 * hibernation API, so an idle club costs nothing and wakes up with its sockets still attached.
 */
export class Club extends DurableObject<Env> implements Connections {
  private readonly service: ClubService
  private readonly book: BookService

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    const storage = ctx.storage
    const store: Store = {
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
    }
    this.service = new ClubService(store, this, {
      maxUsers: Number(env.MAX_USERS ?? 10),
      inviteCode: env.INVITE_CODE || undefined,
      // One alarm wakes the object for every robot move and deal, so it can hibernate in between
      wake: (at) => void storage.setAlarm(at),
      log: jsonLog,
    })
    this.book = new BookService(store)
    // Browsers send "ping" every few seconds to keep phone connections alive and to notice a dead
    // one quickly; the runtime answers without waking the object
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
    ctx.blockConcurrencyWhile(() => this.service.load())
  }

  async alarm() {
    await this.service.runDue()
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
    return response
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
      return json({ user: result.user }, 200, sessionCookie(result.token, secure))
    }
    if (route === 'POST /api/login') {
      const b = await body()
      const { user, token: newToken } = await this.service.login(
        text(b.username),
        text(b.password),
        request.headers.get('CF-Connecting-IP') ?? '',
      )
      return json({ user }, 200, sessionCookie(newToken, secure))
    }
    if (route === 'POST /api/logout') {
      if (token) await this.service.logout(token)
      return json({ ok: true }, 200, sessionCookie('', secure))
    }
    if (route === 'POST /api/password/reset') {
      const b = await body()
      await this.service.resetForgottenPassword(text(b.username), text(b.inviteCode), text(b.password))
      return json({ ok: true })
    }
    const open = await publicBookResponse(this.book, request, url.pathname)
    if (open) return open

    const user = await this.service.userForToken(token)
    if (!user) throw new ClubError('signInFirst', {}, 401)
    if (route === 'GET /api/me') return json({ user })
    if (url.pathname.startsWith('/api/book/')) return this.bookApi(request, url, user, body)
    if (route === 'POST /api/account/password') {
      const b = await body()
      await this.service.changePassword(user.id, text(b.current), text(b.next))
      return json({ ok: true })
    }
    if (route === 'POST /api/account/preferences') {
      const b = await body()
      return json({ user: await this.service.setAccountPreferences(user.id, { friendOnlineNotice: b.friendOnlineNotice }) })
    }
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
      const found = this.service.challengeFor(challenge[1], user.id)
      if (!found) throw new ClubError('challengeGone', {}, 404)
      return json({ challenge: found })
    }
    // Team matches (§5.8): set up (e8-t03) and seated (e8-t04, e8-t05) over HTTP; start and play come in F4
    if (route === 'GET /api/matches') return json({ matches: this.service.matches.list(user.id) })
    if (route === 'POST /api/matches') {
      const b = await body()
      return json({ match: this.service.matches.create(user.id, { settings: b.settings, seat: b.seat }) })
    }
    const matchAction = url.pathname.match(/^\/api\/matches\/([\w-]+)\/(settings|cancel|invite|answer|move|leave|clear|robot)$/)
    if (request.method === 'POST' && matchAction) {
      const [, matchId, action] = matchAction
      if (action === 'settings') return json({ match: this.service.matches.update(user.id, matchId, (await body()).settings) })
      if (action === 'cancel') return json({ match: await this.service.matches.cancel(user.id, matchId) })
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
    this.service.requireAdmin(user.id)
    const path = url.pathname.slice('/api/admin'.length)
    const method = request.method

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
    if (method === 'GET' && path === '/settings') return json({ settings: this.service.clubSettings })
    if (method === 'POST' && path === '/settings') {
      const b = await body()
      const settings = await this.service.adminUpdateSettings({
        maxUsers: b.maxUsers === undefined ? undefined : Number(b.maxUsers),
        inviteCode: b.inviteCode === undefined ? undefined : text(b.inviteCode),
      })
      return json({ settings })
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

  /** TKU BridgeBook's online editing; reading it (publicBookResponse) needs no sign-in */
  private async bookApi(request: Request, url: URL, user: Me, body: () => Promise<Body>) {
    const path = url.pathname.slice('/api/book'.length)
    const method = request.method
    const editor = () => this.service.requirePermission(user.id, 'bookEdit')
    const importer = () => this.service.requirePermission(user.id, 'bookImport')

    const convention = path.match(/^\/conventions\/([\w-]+)(?:\/(hide|reset|revisions)(?:\/([\w-]+))?)?$/)
    if (convention) {
      const [, slug, action, revisionId] = convention
      if (method === 'PUT' && !action) return json({ entry: await this.book.save(editor(), slug, await body()) })
      if (method === 'POST' && action === 'hide') {
        this.service.requireAdmin(user.id)
        return json({ entry: await this.book.hide(user, slug, await body()) })
      }
      if (method === 'POST' && action === 'reset') {
        await this.book.reset(editor(), slug, await body())
        return json({ ok: true })
      }
      if (method === 'GET' && action === 'revisions' && revisionId) {
        editor()
        return json({ revision: await this.book.revision(slug, revisionId) })
      }
      if (method === 'GET' && action === 'revisions') {
        editor()
        return json({ revisions: await this.book.revisions(slug) })
      }
      throw new ClubError('noSuchApi', {}, 404)
    }
    if (method === 'POST' && path === '/import/ticket') {
      const ticket = await this.book.createTicket(importer())
      return json({ ticket, url: `${url.origin}/api/book/import`, ready: !!this.env.ANTHROPIC_API_KEY })
    }
    if (method === 'GET' && path === '/drafts') {
      importer()
      return json({ drafts: await this.book.drafts() })
    }
    if (method === 'POST' && path === '/drafts') return json({ draft: await this.book.saveDraft(importer(), await body()) })
    const draft = path.match(/^\/drafts\/([\w-]+)$/)
    if (draft && method === 'GET') {
      importer()
      return json({ draft: await this.book.draft(draft[1]) })
    }
    if (draft && method === 'DELETE') {
      importer()
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

function json(data: unknown, status = 200, cookie?: string) {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  if (cookie) headers.set('Set-Cookie', cookie)
  return new Response(JSON.stringify(data), { status, headers })
}

function errorResponse(error: unknown) {
  if (error instanceof AppError) return json({ error: error.message, code: error.code, params: error.params }, error.status)
  jsonLog(crashEntry('http', error))
  return json({ error: '伺服器發生錯誤', code: 'serverError', params: {} }, 500)
}
