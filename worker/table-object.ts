import { DurableObject } from 'cloudflare:workers'
import { secureRandomInt } from '../shared/board.ts'
import type { Seat } from '../shared/cards.ts'
import { MESSAGE_MAX_CHARS } from '../shared/message-guard.ts'
import { TABLE_SOCKET_REFUSED, type BoardRecord, type RobotSpeed, type ServerMessage, type TableAction, type TableSettings } from '../shared/protocol.ts'
import type { Env } from './club.ts'
import { homeClubStub } from './clubs.ts'
import { jsonLog, sampleActions } from './log.ts'
import type { TableStats } from './metrics.ts'
import type { EventReport } from './modes.ts'
import { AlarmQueue } from './scheduler.ts'
import { TableHost, type TableSockets } from './table-host.ts'
import type { ClubLink, MatchTableUpdate, Named, Person, TableRpc } from './tables.ts'
import type { Table } from './views.ts'
import { TABLE_USER_HEADER } from './routing.ts'

interface Attachment {
  userId: string
}

/**
 * One table in its own Durable Object (`idFromName(<table id>)`, ARCHITECTURE.md §5.10). This is
 * only the glue to Cloudflare: storage, the alarm, the table's WebSockets (hibernation API) and
 * the club's stub. What the table does is `TableHost` and `TableService`, which never touch a
 * Cloudflare API. The club calls the RPC methods below; browsers connect to `/ws/table/<id>`,
 * which the Worker forwards here with the member's id in `X-TBT-User` after checking the session.
 */
export class TableObject extends DurableObject<Env> implements TableRpc, TableSockets {
  private readonly host: TableHost
  private readonly queue: AlarmQueue
  /** The socket being closed in `webSocketClose`: `getWebSockets()` still lists it */
  private closing: WebSocket | null = null

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    const storage = ctx.storage
    this.queue = new AlarmQueue(Date.now, (at) => void storage.setAlarm(at))
    // One stub, so the reports reach the club in the order they were made
    const club = homeClubStub(env)
    const link: ClubLink = {
      changed: (entry) => club.tableChanged(entry),
      closed: (tableId) => club.tableClosed(tableId),
      boardFinished: (record: BoardRecord, event: EventReport | null, stats?: TableStats) => club.tableBoardFinished(record, event, stats),
      mayUseTku: (userId) => club.tableMayUseTku(userId),
      bookNotes: (known) => club.tableBookNotes(known),
    }
    this.host = new TableHost({
      storage: {
        get: (key) => storage.get(key),
        put: (key, value) => storage.put(key, value),
        clear: async () => {
          await storage.deleteAlarm()
          await storage.deleteAll()
        },
      },
      sockets: this,
      club: link,
      config: { now: Date.now, random: secureRandomInt, scheduler: this.queue },
      // Actions sampled (H3b); the table's counts for the status page still count every one
      log: sampleActions(jsonLog),
    })
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
    ctx.blockConcurrencyWhile(() => this.host.load())
  }

  async alarm() {
    await this.queue.runDue()
  }

  // ── The club's calls ────────────────────────────────────────────────────────────────────────

  open(table: Table) {
    return this.host.open(table)
  }
  adopt(table: Table) {
    return this.host.adopt(table)
  }
  join(person: Person, director?: boolean) {
    return this.host.join(person, director)
  }
  director(userId: string, call: boolean) {
    return this.host.director(userId, call)
  }
  sit(person: Person, seat: Seat) {
    return this.host.sit(person, seat)
  }
  leave(userId: string) {
    return this.host.leave(userId)
  }
  configure(userId: string, settings: Partial<TableSettings>, invited?: Named[]) {
    return this.host.configure(userId, settings, invited)
  }
  request(person: Person, muted: boolean) {
    return this.host.request(person, muted)
  }
  answerRequest(hostId: string, userId: string, accept: boolean) {
    return this.host.answerRequest(hostId, userId, accept)
  }
  resume(person: Person) {
    return this.host.resume(person)
  }
  reclaim(userId: string, reseat: boolean) {
    return this.host.reclaim(userId, reseat)
  }
  presence(userId: string, online: boolean) {
    return this.host.presence(userId, online)
  }
  blocked(userId: string, blocked: string[]) {
    return this.host.blocked(userId, blocked)
  }
  robotSpeed(userId: string, speed: RobotSpeed) {
    return this.host.robotSpeed(userId, speed)
  }
  signOut(userId: string) {
    return this.host.signOut(userId)
  }
  forget(userId: string) {
    return this.host.forget(userId)
  }
  challengeEnded() {
    return this.host.challengeEnded()
  }
  matchEnded() {
    return this.host.matchEnded()
  }
  matchUpdate(update: MatchTableUpdate) {
    return this.host.matchUpdate(update)
  }
  vugraph(userId: string) {
    return this.host.vugraph(userId)
  }
  close() {
    return this.host.close()
  }
  act(userId: string, message: TableAction) {
    return this.host.act(userId, message)
  }
  handOver() {
    return this.host.handOver()
  }
  release() {
    return this.host.release()
  }

  // ── The table's WebSockets ──────────────────────────────────────────────────────────────────

  onlineUserIds(): string[] {
    const ids = this.ctx
      .getWebSockets()
      .filter((ws) => ws !== this.closing && ws.readyState === WebSocket.OPEN)
      .map((ws) => (ws.deserializeAttachment() as Attachment).userId)
    return [...new Set(ids)]
  }

  send(userId: string, message: ServerMessage) {
    const payload = JSON.stringify(message)
    for (const ws of this.ctx.getWebSockets(userId)) {
      if (ws === this.closing) continue
      try {
        ws.send(payload)
      } catch {
        // The socket is closing; webSocketClose cleans up
      }
    }
  }

  dismiss(userId: string, code: number, reason: string) {
    for (const ws of this.ctx.getWebSockets(userId)) {
      try {
        ws.close(code, reason)
      } catch {
        // Already closed
      }
    }
  }

  /** Only `/ws/table/<id>` from the Worker, which has checked the session and says who it is */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 })
    const userId = request.headers.get(TABLE_USER_HEADER)
    if (!userId) return new Response('Unauthorized', { status: 401 })
    const { 0: client, 1: server } = new WebSocketPair()
    // Someone not at this table (or a table that is not here) is let go with TABLE_SOCKET_REFUSED,
    // so the browser stops trying. A plain accepted socket sends that close once the upgrade is
    // done; a hibernatable one closed before the 101 goes out stays open in workerd
    if (!this.host.admits(userId)) {
      server.accept()
      server.close(TABLE_SOCKET_REFUSED, 'not at this table')
      return new Response(null, { status: 101, webSocket: client })
    }
    this.ctx.acceptWebSocket(server, [userId])
    server.serializeAttachment({ userId } satisfies Attachment)
    await this.host.connected(userId)
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    const { userId } = ws.deserializeAttachment() as Attachment
    // As at the club: a binary frame is decoded only as far as the size limit needs
    const raw = typeof data === 'string' ? data : new TextDecoder().decode(data.slice(0, MESSAGE_MAX_CHARS * 3 + 3))
    await this.host.message(userId, raw)
  }

  async webSocketClose(ws: WebSocket) {
    const { userId } = ws.deserializeAttachment() as Attachment
    try {
      ws.close()
    } catch {
      // Already closed
    }
    this.closing = ws
    try {
      // getWebSockets() still lists a closing socket, so check for another open one
      const stillOpen = this.ctx.getWebSockets(userId).some((other) => other !== ws && other.readyState === WebSocket.OPEN)
      if (!stillOpen) await this.host.disconnected(userId)
    } finally {
      this.closing = null
    }
  }

  async webSocketError(ws: WebSocket) {
    await this.webSocketClose(ws)
  }
}
