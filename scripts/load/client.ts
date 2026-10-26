import type { Seat } from '../../shared/cards.ts'
import { TABLE_SOCKET_PREFIX, TABLE_SOCKET_REFUSED, type ClientMessage, type LobbyView, type ServerMessage, type TableWire } from '../../shared/protocol.ts'
import { decide, progressOf, type Random } from './player.ts'
import type { Recorder } from './stats.ts'

/**
 * One simulated member (docs/LOAD.md): signs in over HTTP, holds the club's WebSocket (`/ws`) and,
 * while at a table, the table's own (`/ws/table/<id>`) as the browser does (ARCHITECTURE.md §5.10),
 * pings every 15 s like `src/lib/liveSocket.ts`, and plays its turns from what the server sends.
 * Every action is timed from sending it to the message that shows it took effect (or an error)
 */

const PING_EVERY = 15_000
const ANSWER_TIMEOUT = 15_000

export interface SiteOptions {
  origin: string
  recorder: Recorder
  /** Mean thinking time of a person per call or card (ms); 0 plays at once */
  thinkMs: number
  random: Random
  log: (line: string) => void
}

interface Waiting {
  kind: string
  at: number
  socket: 'club' | 'table'
  done: (message: ServerMessage) => boolean
  resolve: (ok: boolean) => void
  timer: ReturnType<typeof setTimeout>
}

export class SimUser {
  readonly username: string
  private readonly password: string
  private readonly site: SiteOptions
  private cookie = ''
  id = ''
  private club: WebSocket | null = null
  private table: WebSocket | null = null
  private tableSocketId: string | null = null
  private pings: ReturnType<typeof setInterval> | null = null
  private waiting: Waiting[] = []
  private stopped = false
  private thinkTimer: ReturnType<typeof setTimeout> | null = null
  private actedAt = -1
  lobby: LobbyView | null = null
  view: TableWire | null = null
  /** Plays its turns by itself */
  autoplay = false
  /** Counts the robots' moves on each finished board (one member per table does) */
  countRobots = false
  private countedBoards = new Set<number>()

  constructor(username: string, password: string, site: SiteOptions) {
    this.username = username
    this.password = password
    this.site = site
  }

  private get rec() {
    return this.site.recorder
  }

  // ── HTTP ────────────────────────────────────────────────────────────────────────────────────

  async http<T = unknown>(method: string, path: string, body?: unknown, kind = `http ${method} ${path.replace(/\/[\w-]{6,}(?=\/|$)/g, '/:id').split('?')[0]}`) {
    const started = performance.now()
    this.rec.count('http')
    let response: Response
    try {
      response = await fetch(`${this.site.origin}${path}`, {
        method,
        headers: { ...(body !== undefined && { 'Content-Type': 'application/json' }), ...(this.cookie && { Cookie: this.cookie }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch (error) {
      this.rec.count('error:network')
      throw error
    }
    const data = (await response.json().catch(() => ({}))) as T & { code?: string; error?: string }
    this.rec.add(kind, performance.now() - started)
    if (response.status >= 500) this.rec.count('error:http5xx')
    const cookies = response.headers.getSetCookie().map((c) => c.split(';')[0])
    if (cookies.length) {
      const jar = new Map(this.cookie.split('; ').filter(Boolean).map((c) => [c.split('=')[0], c] as const))
      for (const c of cookies) jar.set(c.split('=')[0], c)
      this.cookie = [...jar.values()].filter((c) => !c.endsWith('=')).join('; ')
    }
    return { status: response.status, data }
  }

  async login() {
    const { status, data } = await this.http<{ user?: { id: string } }>('POST', '/api/login', { username: this.username, password: this.password }, 'login')
    if (status !== 200 || !data.user) throw new Error(`${this.username} could not sign in (${status} ${data.code ?? ''})`)
    this.id = data.user.id
  }

  // ── WebSockets ──────────────────────────────────────────────────────────────────────────────

  private open(path: string): WebSocket {
    const url = `${this.site.origin.replace(/^http/, 'ws')}${path}`
    this.rec.count(path === '/ws' ? 'upgrade:club' : 'upgrade:table')
    return new WebSocket(url, { headers: { Cookie: this.cookie } } as never)
  }

  /** Opens the club's connection and waits for `welcome` and the first lobby */
  connect(): Promise<void> {
    this.stopped = false
    return new Promise((resolve, reject) => {
      const ws = (this.club = this.open('/ws'))
      let welcomed = false
      const fail = setTimeout(() => reject(new Error(`${this.username}: no welcome`)), ANSWER_TIMEOUT)
      ws.onmessage = (event) => {
        const message = this.parse(event.data)
        if (!message) return
        this.received('club', message)
        if (message.type === 'welcome') welcomed = true
        if (welcomed && message.type === 'lobby') {
          clearTimeout(fail)
          resolve()
        }
      }
      ws.onclose = (event) => {
        clearTimeout(fail)
        if (this.club === ws) this.club = null
        if (!welcomed) reject(new Error(`${this.username}: club socket closed (${event.code})`))
        else if (!this.stopped) {
          this.rec.count('drop:club')
          void this.reconnectLater()
        }
      }
      ws.onerror = () => {}
      this.startPings()
    })
  }

  private async reconnectLater(delay = 1000 + this.site.random() * 2000) {
    await new Promise((r) => setTimeout(r, delay))
    if (this.stopped || this.club) return
    this.rec.count('reconnect')
    try {
      await this.connect()
    } catch {
      this.rec.count('error:reconnect')
      void this.reconnectLater(5000)
    }
  }

  /** Drops both connections as a phone losing its signal would, and reconnects a moment later */
  drop() {
    this.rec.count('churn')
    this.closeTable()
    const ws = this.club
    this.club = null
    ws?.close()
    void this.reconnectLater()
  }

  private startPings() {
    if (this.pings) return
    this.pings = setInterval(() => {
      for (const ws of [this.club, this.table]) {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send('ping')
          this.rec.count('ping')
        }
      }
    }, PING_EVERY)
  }

  private openTable(tableId: string) {
    if (this.tableSocketId === tableId && this.table) return
    this.closeTable()
    this.tableSocketId = tableId
    const ws = (this.table = this.open(`${TABLE_SOCKET_PREFIX}${tableId}`))
    ws.onmessage = (event) => {
      const message = this.parse(event.data)
      if (message) this.received('table', message)
    }
    ws.onclose = (event) => {
      if (this.table !== ws) return
      this.table = null
      this.tableSocketId = null
      if (event.code === TABLE_SOCKET_REFUSED) return
      if (!this.stopped) this.rec.count('drop:table')
      // Opened again from the next lobby that still has us at the table
      if (!this.stopped && this.lobby?.myTableId === tableId) setTimeout(() => this.lobby?.myTableId === tableId && this.openTable(tableId), 1000)
    }
    ws.onerror = () => {}
  }

  private closeTable() {
    const ws = this.table
    this.table = null
    this.tableSocketId = null
    ws?.close()
  }

  private parse(data: unknown): ServerMessage | null {
    if (typeof data !== 'string' || data === 'pong') return null
    try {
      return JSON.parse(data) as ServerMessage
    } catch {
      return null
    }
  }

  private received(socket: 'club' | 'table', message: ServerMessage) {
    this.rec.count(`in:${message.type}`)
    if (message.type === 'lobby') {
      this.lobby = message.lobby
      const at = message.lobby.myTableId
      if (at) this.openTable(at)
      else {
        this.closeTable()
        this.view = null
      }
    } else if (message.type === 'table') {
      // Chat and recent boards come only when they changed: keep the last ones
      this.view = message.table ? { ...message.table, chat: message.table.chat ?? this.view?.chat, recent: message.table.recent ?? this.view?.recent } : null
      this.countRobotMoves()
      this.maybePlay()
    } else if (message.type === 'error') {
      this.rec.count(`refused:${message.code}`)
    }
    // Any message on either socket may be the answer an action waits for
    for (const waiting of [...this.waiting]) {
      if (message.type === 'error' && waiting.socket === socket) {
        this.finish(waiting, false)
        break
      }
      if (waiting.done(message)) this.finish(waiting, true)
    }
    void socket
  }

  private finish(waiting: Waiting, ok: boolean) {
    clearTimeout(waiting.timer)
    this.waiting = this.waiting.filter((w) => w !== waiting)
    if (ok) this.rec.add(waiting.kind, performance.now() - waiting.at)
    else this.rec.count(`failed:${waiting.kind}`)
    waiting.resolve(ok)
  }

  /**
   * Sends a message (table actions over the table's connection once it is open, as the browser
   * does) and resolves once `done` sees its effect, false on an error or after 15 s
   */
  send(message: ClientMessage, done: (message: ServerMessage) => boolean, kind: string = message.type): Promise<boolean> {
    const tableAction = ['call', 'play', 'addRobot', 'chat', 'stand'].includes(message.type)
    const ws = tableAction && this.table?.readyState === WebSocket.OPEN ? this.table : this.club
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      this.rec.count(`unsent:${kind}`)
      return Promise.resolve(false)
    }
    return new Promise((resolve) => {
      const waiting: Waiting = {
        kind,
        at: performance.now(),
        socket: ws === this.table ? 'table' : 'club',
        done,
        resolve,
        timer: setTimeout(() => {
          this.rec.count(`timeout:${kind}`)
          this.waiting = this.waiting.filter((w) => w !== waiting)
          resolve(false)
        }, ANSWER_TIMEOUT),
      }
      this.waiting.push(waiting)
      ws.send(JSON.stringify(message))
      this.rec.count('sent')
    })
  }

  // ── Club actions the scenarios use ──────────────────────────────────────────────────────────

  async createTable(): Promise<string | null> {
    await this.send({ type: 'createTable' }, (m) => m.type === 'lobby' && !!m.lobby.myTableId)
    return this.lobby?.myTableId ?? null
  }

  sit(tableId: string, seat: Seat) {
    return this.send({ type: 'sit', tableId, seat }, (m) => m.type === 'lobby' && m.lobby.myTableId === tableId)
  }

  watch(tableId: string) {
    return this.send({ type: 'joinTable', tableId }, (m) => m.type === 'lobby' && m.lobby.myTableId === tableId)
  }

  async addRobot(seat: Seat) {
    await this.waitFor(() => !!this.view)
    return this.send({ type: 'addRobot', seat }, (m) => m.type === 'table' && !!m.table?.seats[seat]?.robot)
  }

  leave() {
    if (!this.lobby?.myTableId) return Promise.resolve(true)
    return this.send({ type: 'leaveTable' }, (m) => m.type === 'lobby' && !m.lobby.myTableId)
  }

  chat(text: string) {
    return this.send({ type: 'chat', text }, (m) => m.type === 'table' && !!m.table?.chat?.some((c) => c.text === text))
  }

  direct(to: string, text: string) {
    return this.send({ type: 'sendDirect', to, text }, (m) => m.type === 'direct' && m.message.text === text)
  }

  follow(userId: string) {
    return this.send({ type: 'setFriend', userId, friend: true }, (m) => m.type === 'lobby' && m.lobby.friends.includes(userId))
  }

  playChallenge(challengeId: string) {
    return this.send({ type: 'playChallenge', challengeId }, (m) => m.type === 'lobby' && !!m.lobby.myTableId)
  }

  /** Resolves when `test` holds, checking every 100 ms; false after `ms` */
  async waitFor(test: () => boolean, ms = ANSWER_TIMEOUT): Promise<boolean> {
    const until = Date.now() + ms
    while (!test()) {
      if (Date.now() > until) return false
      await new Promise((r) => setTimeout(r, 100))
    }
    return true
  }

  // ── Playing ─────────────────────────────────────────────────────────────────────────────────

  /** Looks at the table again (after `autoplay` was turned on with a turn already waiting) */
  nudge() {
    this.maybePlay()
  }

  private maybePlay() {
    if (!this.autoplay || this.thinkTimer || this.stopped) return
    const move = decide(this.view, this.site.random)
    if (!move) return
    const position = progressOf(this.view)
    if (position === this.actedAt) return
    const think = this.site.thinkMs * (0.5 + this.site.random())
    this.thinkTimer = setTimeout(() => {
      this.thinkTimer = null
      // Things moved on meanwhile (a robot sat in, an undo): think again from the new view
      if (progressOf(this.view) !== position) return this.maybePlay()
      const now = decide(this.view, this.site.random)
      if (!now) return
      this.actedAt = position
      void this.send(now, (m) => m.type === 'table' && progressOf(m.table) > position).then((ok) => {
        if (!ok) this.actedAt = -1
        this.maybePlay()
      })
    }, think)
  }

  /** The robots' calls and cards on a board that just finished (for the cost estimate) */
  private countRobotMoves() {
    const view = this.view
    const board = view?.board
    if (!this.countRobots || !view || !board || board.phase !== 'finished') return
    const key = view.boardsPlayed
    if (this.countedBoards.has(key)) return
    this.countedBoards.add(key)
    const robots = new Set(Object.entries(view.seats).flatMap(([seat, who]) => (who?.robot ? [seat] : [])))
    const calls = board.auction.filter((c) => robots.has(c.seat)).length
    const cards = board.tricks.reduce((n, t) => n + t.cards.filter((c) => robots.has(c.seat)).length, 0)
    this.rec.count('boards')
    this.rec.count('robotMoves', calls + cards)
  }

  stop() {
    this.stopped = true
    this.autoplay = false
    if (this.thinkTimer) clearTimeout(this.thinkTimer)
    if (this.pings) clearInterval(this.pings)
    this.pings = null
    this.closeTable()
    this.club?.close()
    this.club = null
  }
}
