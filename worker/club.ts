import { DurableObject } from 'cloudflare:workers'
import type { ClientMessage, ServerMessage } from '../shared/protocol.ts'
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
      list: (prefix) => storage.list({ prefix }),
    }
    this.service = new ClubService(store, this, {
      maxUsers: Number(env.MAX_USERS ?? 10),
      inviteCode: env.INVITE_CODE || undefined,
    })
    ctx.blockConcurrencyWhile(() => this.service.load())
  }

  onlineUserIds(): string[] {
    const ids = this.ctx.getWebSockets().map((ws) => (ws.deserializeAttachment() as Attachment).userId)
    return [...new Set(ids)]
  }

  send(userId: string, message: ServerMessage) {
    const text = JSON.stringify(message)
    for (const ws of this.ctx.getWebSockets(userId)) {
      try {
        ws.send(text)
      } catch {
        // The socket is closing; webSocketClose cleans up
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const token = readCookie(request.headers.get('Cookie'), SESSION_COOKIE)
    try {
      if (url.pathname === '/ws') return await this.upgrade(request, token)
      return await this.api(request, url, token)
    } catch (error) {
      if (error instanceof ClubError) return json({ error: error.message }, error.status)
      console.error(error)
      return json({ error: '伺服器發生錯誤' }, 500)
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
    const body = async () => (await request.json().catch(() => ({}))) as Record<string, string>

    if (route === 'POST /api/register') {
      const { username, password, inviteCode } = await body()
      const { user, token: newToken } = await this.service.register(username, password, inviteCode)
      return json({ user }, 200, sessionCookie(newToken, secure))
    }
    if (route === 'POST /api/login') {
      const { username, password } = await body()
      const { user, token: newToken } = await this.service.login(username, password)
      return json({ user }, 200, sessionCookie(newToken, secure))
    }
    if (route === 'POST /api/logout') {
      if (token) await this.service.logout(token)
      return json({ ok: true }, 200, sessionCookie('', secure))
    }

    const user = await this.service.userForToken(token)
    if (!user) throw new ClubError('signInFirst', {}, 401)
    if (route === 'GET /api/me') return json({ user })
    if (route === 'GET /api/history')
      return json({ boards: await this.service.history(user.id, url.searchParams.get('scope') === 'all') })
    const match = url.pathname.match(/^\/api\/history\/([\w-]+)$/)
    if (request.method === 'GET' && match) {
      const record = await this.service.record(match[1])
      if (!record) throw new ClubError('boardGone', {}, 404)
      return json({ record })
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
