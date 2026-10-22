import { DurableObject } from 'cloudflare:workers'
import { AppError } from '../shared/messages.ts'
import type { ClientMessage, Me, ServerMessage } from '../shared/protocol.ts'
import { readCookie, SESSION_COOKIE, sessionCookie } from './auth.ts'
import { ClubError, ClubService, type Connections } from './service.ts'
import type { Store } from './store.ts'

export interface Env {
  CLUB: DurableObjectNamespace<Club>
  ASSETS: Fetcher
  MAX_USERS?: string
  INVITE_CODE?: string
}

interface Attachment {
  userId: string
}

type Body = Record<string, unknown>
const text = (value: unknown) => String(value ?? '')

/**
 * The whole club lives in one Durable Object: a handful of members and tables fit easily, and a
 * single object means every action is applied in order with no coordination. WebSockets use the
 * hibernation API, so an idle club costs nothing and wakes up with its sockets still attached.
 */
export class Club extends DurableObject<Env> implements Connections {
  private readonly service: ClubService

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
    }
    this.service = new ClubService(store, this, {
      maxUsers: Number(env.MAX_USERS ?? 10),
      inviteCode: env.INVITE_CODE || undefined,
    })
    // Browsers send "ping" every few seconds to keep phone connections alive and to notice a dead
    // one quickly; the runtime answers without waking the object
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
    ctx.blockConcurrencyWhile(() => this.service.load())
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

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const token = readCookie(request.headers.get('Cookie'), SESSION_COOKIE)
    try {
      if (url.pathname === '/ws') return await this.upgrade(request, token)
      return await this.api(request, url, token)
    } catch (error) {
      if (error instanceof AppError)
        return json({ error: error.message, code: error.code, params: error.params }, error.status)
      console.error(error)
      return json({ error: '伺服器發生錯誤', code: 'serverError', params: {} }, 500)
    }
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
    const body = async () => (await request.json().catch(() => ({}))) as Body

    if (route === 'POST /api/register') {
      const b = await body()
      const { user, token: newToken } = await this.service.register(text(b.username), text(b.password), text(b.inviteCode))
      return json({ user }, 200, sessionCookie(newToken, secure))
    }
    if (route === 'POST /api/login') {
      const b = await body()
      const { user, token: newToken } = await this.service.login(text(b.username), text(b.password))
      return json({ user }, 200, sessionCookie(newToken, secure))
    }
    if (route === 'POST /api/logout') {
      if (token) await this.service.logout(token)
      return json({ ok: true }, 200, sessionCookie('', secure))
    }

    const user = await this.service.userForToken(token)
    if (!user) throw new ClubError('signInFirst', {}, 401)
    if (route === 'GET /api/me') return json({ user })
    if (route === 'POST /api/account/password') {
      const b = await body()
      await this.service.changePassword(user.id, text(b.current), text(b.next))
      return json({ ok: true })
    }
    if (route === 'GET /api/history') {
      const query = url.searchParams
      const all = query.get('scope') === 'all'
      return json(await this.service.history(user.id, all, Number(query.get('page') ?? 1), Number(query.get('size') ?? 0) || undefined))
    }
    const record = url.pathname.match(/^\/api\/history\/([\w-]+)$/)
    if (request.method === 'GET' && record) {
      const found = await this.service.record(record[1])
      if (!found) throw new ClubError('boardGone', {}, 404)
      return json({ record: found })
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
    if (method === 'GET' && path === '/settings') return json({ settings: this.service.clubSettings })
    if (method === 'POST' && path === '/settings') {
      const b = await body()
      const settings = await this.service.adminUpdateSettings({
        maxUsers: b.maxUsers === undefined ? undefined : Number(b.maxUsers),
        inviteCode: b.inviteCode === undefined ? undefined : text(b.inviteCode),
      })
      return json({ settings })
    }
    const member = path.match(/^\/users\/(\w+)(\/password|\/admin)?$/)
    if (member) {
      const [, id, action] = member
      if (method === 'DELETE' && !action) await this.service.adminDeleteUser(user.id, id)
      else if (method === 'POST' && action === '/password')
        await this.service.adminResetPassword(id, text((await body()).password))
      else if (method === 'POST' && action === '/admin')
        await this.service.adminSetAdmin(user.id, id, Boolean((await body()).admin))
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

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    const { userId } = ws.deserializeAttachment() as Attachment
    let message: ClientMessage
    try {
      message = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data))
    } catch {
      return
    }
    await this.service.handle(userId, message)
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
