import { DurableObject } from 'cloudflare:workers'
import { clubIdOfObject, DEFAULT_CLUB_ID } from '../shared/clubs.ts'
import { AppError } from '../shared/messages.ts'
import type { ChallengeSettings } from '../shared/challenge.ts'
import { parseHistoryQuery } from '../shared/history-query.ts'
import { MESSAGE_MAX_CHARS } from '../shared/message-guard.ts'
import type { BoardRecord, Me, ServerMessage, SystemSpecStatus } from '../shared/protocol.ts'
import type { BookNotes } from '../shared/robot/system/book-spec.ts'
import { TKU } from '../shared/robot/system/tku/index.ts'
import { bookSync } from '../shared/robot/system/tku/sources.ts'
import { randomId, readCookie, SESSION_COOKIE, sessionCookie } from './auth.ts'
import { ACCOUNT_PREFIXES, backupAdmin, runBackup } from './backup.ts'
import { BookService, importRequestFrom, publicBookResponse } from './book.ts'
import { seedTokenMatches } from './book-seed.ts'
import { BookNotices } from './book-notices.ts'
import { PendingService } from './pending.ts'
import { GlossaryService, publicGlossaryResponse } from './glossary.ts'
import { claudeImporter } from './importer.ts'
import { ProfileService } from './profiles.ts'
import { CardPdfService, pdfResponse } from './card-pdf.ts'
import { CardSnapshotService } from './card-snapshots.ts'
import { avatarResponse, readAvatarUpload } from './avatars.ts'
import { FILES_PATH, FileService, readFileUpload } from './files.ts'
import { adminRouteNeed, allows, articleReadRoute, bookRouteNeed, ebookReadRoute, clubRouteNeed, forumRouteNeed, moderatesForum, requireNeed } from './roles.ts'
import { type ArticleReader, ArticleService } from './articles.ts'
import { type EbookReader, EbookService } from './ebooks.ts'
import { ForumService, postExcerpt } from './forum.ts'
import { ForumNotices } from './forum-notices.ts'
import { BOOK_EVENTS_MAX_CHARS, BookTelemetry } from './book-telemetry.ts'
import type { AuditAction } from './audit.ts'
import { robotMeaningsFor } from './system-spec.ts'
import { QuizStore } from './quiz.ts'
import { LearningStore } from './learning.ts'
import { ReadingStore } from './reading.ts'
import { CLIENT_ERROR_MAX_CHARS } from './client-errors.ts'
import { d1Replica } from './d1.ts'
import { edgeSecret, mintPass, PASS_COOKIE, passCookie, passNeedsRefresh } from './edge-auth.ts'
import { crashEntry, jsonLog, sampleActions } from './log.ts'
import type { TableStats } from './metrics.ts'
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
  /** BridgeHall's seed of its built-in conventions (worker/book-seed.ts; wrangler secret put BOOK_SEED_TOKEN) */
  BOOK_SEED_TOKEN?: string
  /** BridgeHall's scheduled backup of the content, read only (GET /api/book/export; wrangler secret put BOOK_EXPORT_TOKEN) */
  BOOK_EXPORT_TOKEN?: string
  IMPORT_MODEL?: string
  /** Only for tests or an API gateway */
  ANTHROPIC_BASE_URL?: string
  /**
   * Browser Run (formerly Browser Rendering) for BridgeHall's card PDFs (worker/card-pdf.ts, DEPLOY.md
   * §4.11); without it the card page prints with the browser's own dialog
   */
  BROWSER?: BrowserRun
  /** Daily backups (worker/backup.ts); the bucket is created by hand before deploying (DEPLOY.md §4.4) */
  BACKUPS?: R2Bucket
  /**
   * Pictures for posts and articles (worker/files.ts, BridgeBook e11-t02); the bucket is created by
   * hand before the binding is added (DEPLOY.md §4.8). Without it the files API answers 503
   */
  FILES?: R2Bucket
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
  /** The system profile whose 淡江橋館 rules TKB follows (BridgeHall e7-t03); the club's when unset */
  SYSTEM_PROFILE_ID?: string
}

/** A picture's upload may come straight from TKU BridgeBook's page too; its single-use pass is the check */
const FILE_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
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
/** A convention's name for a notification (e8-t10); its slug when it has none or is hidden */
const conventionName = (convention: Record<string, unknown> | null, slug: string) =>
  (convention && typeof convention.nameZh === 'string' && convention.nameZh) || slug
/** An article's title as a notification names it (BridgeHall J4) */
const articleTitle = (article: Record<string, unknown> | null, slug: string) =>
  (article && typeof article.title === 'string' && article.title) || slug

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
  /** BridgeHall's glossary (e4-t05); reads storage on each request, so a restore needs nothing */
  private readonly glossary: GlossaryService
  /** The 待確認 panel (BridgeHall e8-t06); reads storage on each request, so a restore needs nothing */
  private readonly pending: PendingService
  /** The library's articles (BridgeHall e5-t04) */
  private articles: ArticleService
  /** The library's e-books (BridgeHall e5-t09) */
  private ebooks: EbookService
  private profiles: ProfileService
  /** Convention card versions (BridgeHall e3-t09); keeps nothing in memory */
  private readonly cardSnapshots: CardSnapshotService
  private readonly cardPdf: CardPdfService
  /** Pictures in R2 (e11-t02); keeps only its signing key in memory */
  private readonly files: FileService
  /** TKU BridgeBook's teams and partnerships (E2); keeps nothing in memory, so it outlives a restore */
  private readonly teams: TeamService
  /** 淡江橋館's practice results and question fixes (E6); keeps nothing in memory */
  private readonly quiz: QuizStore
  /** 淡江橋館's learning paths and members' progress (e4-t08, e4-t11); keeps nothing in memory */
  private readonly learning: LearningStore
  /** Members' places in articles and e-books (BridgeHall e5-t14); keeps nothing in memory */
  private readonly reading: ReadingStore
  /** TKU-BridgeHall's forum (E11) in the object's SQLite database; keeps nothing in memory but its rate limits */
  private readonly forum: ForumService
  /** The forum's notifications (BridgeHall e11-t08); keeps nothing in memory */
  private readonly forumNotices: ForumNotices
  /** BridgeHall's error reports and anonymous usage counts (e10-t06, e10-t07) in the object's SQLite database */
  private readonly telemetry: BookTelemetry
  /** The handbook's notifications and who follows which convention (BridgeHall e8-t10); keeps nothing in memory */
  private readonly notices: BookNotices
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
      // One object per club (e12-t02): its name says which
      clubId: clubIdOfObject(ctx.id.name) ?? DEFAULT_CLUB_ID,
      maxUsers: Number(env.MAX_USERS ?? 10),
      inviteCode: env.INVITE_CODE || undefined,
      // One alarm wakes the object for every robot move and deal, so it can hibernate in between
      wake: (at) => void storage.setAlarm(at),
      // Actions sampled (H3b); the status page still counts every one
      log: sampleActions(jsonLog),
      // The lobby goes out at most every LOBBY_GAP_MS while it keeps changing (H3b)
      later: (run, ms) => void setTimeout(run, ms),
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
      systemProfileId: env.SYSTEM_PROFILE_ID || undefined,
    })
    this.edgeSecret = edgeSecret(env)
    this.book = new BookService(store)
    this.pending = new PendingService(store, this.book.auditTrail)
    // Admins hear when the files near R2's free room (BridgeHall e5-t15)
    this.files = new FileService(store, env.FILES, Date.now, async (bytes) => {
      for (const id of this.service.adminIds()) await this.service.notifications.notify(id, 'filesNearlyFull', { gb: Math.round((bytes / 1024 ** 3) * 10) / 10 })
    })
    this.quiz = new QuizStore(store, Date.now, () => randomId(8))
    this.learning = new LearningStore(store, Date.now)
    this.reading = new ReadingStore(store, Date.now)
    this.glossary = new GlossaryService(store)
    this.articles = this.newArticles()
    this.ebooks = this.newEbooks()
    this.profiles = new ProfileService(store, Date.now, (id) => this.service.usernameOf(id))
    this.cardSnapshots = new CardSnapshotService(store, Date.now, (id) => this.service.usernameOf(id))
    this.cardPdf = new CardPdfService(env.BROWSER)
    this.teams = new TeamService(store, {
      now: Date.now,
      newId: () => randomId(6),
      usernameOf: (id) => this.service.usernameOf(id),
      members: () => this.service.memberDirectory(),
      notify: (id, kind, params) => this.service.notifications.notify(id, kind, params),
      profiles: () => this.profiles,
    })
    this.notices = new BookNotices(store, {
      notify: (id, kind, params) => this.service.notifications.notify(id, kind, params),
      members: () => this.service.memberDirectory(),
      reviewerIds: () => this.service.reviewerIds(),
      mutesAdopted: (id) => this.service.mutesAdoptedNotices(id),
      teams: () => this.teams,
      profiles: () => this.profiles,
    })
    this.forum = new ForumService(store.sql, {
      now: Date.now,
      newId: () => randomId(8),
      members: () => this.service.memberDirectory(),
    })
    this.forum.createTables()
    this.telemetry = new BookTelemetry(store.sql, { now: Date.now, log: (entry) => this.service.logEntry(entry) })
    this.telemetry.createTables()
    this.forumNotices = new ForumNotices({
      notify: (id, kind, params) => this.service.notifications.notify(id, kind, params),
      members: () => this.service.memberDirectory(),
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
      jsonLog({ event: 'backup', ok: true, name: result.name, keys: result.keys, rows: result.rows, bytes: result.bytes, deleted: result.deleted.length })
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
  async tableBoardFinished(record: BoardRecord, event: EventReport | null, stats?: TableStats) {
    await this.service.link.boardFinished(record, event, stats)
  }

  /** Whether a member may seat TKB in the club's system (`ClubLink.mayUseTku`) */
  async tableMayUseTku(userId: string): Promise<boolean> {
    return this.service.link.mayUseTku(userId)
  }

  /** 淡江橋館's words for TKB's calls (`ClubLink.bookNotes`, BridgeHall e7-t03) */
  async tableBookNotes(known: string | null): Promise<BookNotes | 'same' | null> {
    return this.service.systemSpecs.bookNotes(known)
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

  send(userId: string, message: ServerMessage, data?: string) {
    const payload = data ?? JSON.stringify(message)
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
    this.service.logEntry({ event: 'http', method: request.method, path: url.pathname, status: response.status, ms: Date.now() - started, ...(code ? { code } : {}) })
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
    if (url.pathname.startsWith(`${FILES_PATH}upload/`)) return this.fileUpload(request, url)
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

  /** A picture or its thumbnail (e11-t02), with its single-use pass instead of the session cookie */
  private async fileUpload(request: Request, url: URL): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: FILE_CORS })
    let response: Response
    try {
      if (request.method !== 'PUT') throw new ClubError('noSuchApi', {}, 404)
      const token = url.pathname.slice(`${FILES_PATH}upload/`.length)
      const part = url.searchParams.get('part') === 'thumb' ? 'thumb' : 'file'
      // A picture's limit, or a PDF's for an e-book's pass (e5-t09)
      const bytes = await readFileUpload(request, await this.files.uploadMax(token, part))
      response = json({ file: await this.files.upload(token, part, bytes) })
    } catch (error) {
      response = errorResponse(error)
    }
    for (const [key, value] of Object.entries(FILE_CORS)) response.headers.set(key, value)
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

    if (route === 'GET /api/health') return json(this.service.status())
    if (route === 'POST /api/client-errors') {
      // Reports come before sign-in too, so this needs none; the service cleans and rate-limits them
      if (Number(request.headers.get('Content-Length') ?? 0) > CLIENT_ERROR_MAX_CHARS * 4)
        throw new ClubError('messageTooLarge', {}, 413)
      if (!this.service.reportClientError(await request.text())) throw new ClubError('badMessage')
      return new Response(null, { status: 204 })
    }
    // BridgeHall's error reports and usage counts (e10-t06, e10-t07): no sign-in, and who is signed in
    // is never read; over the rate (or with counting off) they are dropped and still answered 204
    if (route === 'POST /api/book/errors' || route === 'POST /api/book/events') {
      const max = route === 'POST /api/book/errors' ? CLIENT_ERROR_MAX_CHARS : BOOK_EVENTS_MAX_CHARS
      if (Number(request.headers.get('Content-Length') ?? 0) > max * 4) throw new ClubError('messageTooLarge')
      const raw = await request.text()
      const ok = route === 'POST /api/book/errors' ? this.telemetry.report(raw) : this.telemetry.record(raw)
      if (!ok) throw new ClubError('badMessage')
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
    // A picture by its signed address (e11-t02): the signature is the check, so no sign-in
    if (request.method === 'GET' && url.pathname.startsWith(FILES_PATH)) {
      return this.files.serve(decodeURIComponent(url.pathname.slice(FILES_PATH.length)), url)
    }

    const user = await this.service.userForToken(token)
    // BridgeHall's built-in conventions (L0): its seed script carries the seed token instead of a
    // session, to seed them and to read them and their search index back
    const seedPath = url.pathname === '/api/book/builtin' || (request.method === 'GET' && url.pathname === '/api/book/search-index')
    if (seedPath && !user && (await seedTokenMatches(request, this.env.BOOK_SEED_TOKEN))) {
      if (request.method === 'PUT') return json(await this.book.seedBuiltin('seed-script', await body()))
      const read = await publicBookResponse(this.book, request, url.pathname)
      if (read) return read
    }
    // BridgeHall's backup (L1, e8-t12) carries the export token, which reads the content and nothing else
    if (route === 'GET /api/book/export' && !user && (await seedTokenMatches(request, this.env.BOOK_EXPORT_TOKEN))) {
      return json(await this.book.exportAll())
    }
    // A convention card version shared by link (BridgeHall e3-t09): anyone, signed in or not
    const shared = request.method === 'GET' ? await this.sharedCardResponse(url.pathname) : null
    if (shared) return shared
    // Everything else needs signing in, BridgeHall's reading included: its whole site is for members
    // since 2026-10-29 (the handbook, glossary, practice fixes, learning paths, library and profiles)
    if (!user) throw new ClubError('signInFirst', {}, 401)

    const open = await publicBookResponse(this.book, request, url.pathname)
    if (open) return open
    const glossary = await publicGlossaryResponse(this.glossary, request, url.pathname)
    if (glossary) return glossary
    // The editors' fixes to the practice questions (BridgeHall e6-t06)
    if (route === 'GET /api/book/quiz/fixes') return json({ fixes: await this.quiz.fixes() })
    // The editors' learning paths (BridgeHall e4-t08)
    if (route === 'GET /api/book/paths') return json({ paths: await this.learning.paths() })
    // The library's articles (BridgeHall e5-t04); members-only ones are like the rest now that
    // every reader is a member
    const articleRead = articleReadRoute(request.method, url.pathname)
    if (articleRead) {
      const reader: ArticleReader = allows(user, 'bookEdit') ? 'editor' : 'member'
      const result = articleRead.slug
        ? await this.articles.get(reader, articleRead.slug)
        : await this.articles.list(reader, url.searchParams.get('text') === '1')
      return json(result)
    }
    // The library's e-books (BridgeHall e5-t09, e5-t11): the same
    const ebookRead = ebookReadRoute(request.method, url.pathname)
    if (ebookRead) {
      const reader: EbookReader = allows(user, 'bookEdit') ? 'editor' : 'member'
      return json(ebookRead.id ? await this.ebooks.get(reader, ebookRead.id) : await this.ebooks.list(reader))
    }
    if (route === 'GET /api/me') return json({ user })
    if (url.pathname.startsWith('/api/book/')) return this.bookApi(request, url, user, body)
    if (url.pathname.startsWith('/api/club/')) return this.clubApi(request, url, user, body)
    if (url.pathname.startsWith('/api/forum/')) return this.forumApi(request, url, user, body)
    if (route === 'POST /api/account/password') {
      const b = await body()
      await this.service.changePassword(user.id, text(b.current), text(b.next))
      return json({ ok: true })
    }
    if (route === 'POST /api/account/preferences') {
      const b = await body()
      return json({ user: await this.service.setAccountPreferences(user.id, {
          friendOnlineNotice: b.friendOnlineNotice,
          bookAdoptedNotice: b.bookAdoptedNotice,
          bookProfile: b.bookProfile,
          robotSpeed: b.robotSpeed,
        }) })
    }
    if (route === 'PATCH /api/account/profile') return json({ user: await this.service.setProfile(user.id, await body()) })
    // The member's own picture (e1-t34): the bytes as the browser cropped and shrank them
    if (route === 'PUT /api/account/avatar') return json({ user: await this.service.setAvatar(user.id, await readAvatarUpload(request)) })
    if (route === 'DELETE /api/account/avatar') return json({ user: await this.service.deleteAvatar(user.id) })
    // Pictures for posts and articles (e11-t02): a pass to upload one, fresh addresses, removing one
    if (route === 'POST /api/files/ticket') return json(await this.files.createTicket(user.id, await body()))
    if (route === 'POST /api/files/urls') return json(await this.files.urls((await body()).keys))
    if (request.method === 'DELETE' && url.pathname.startsWith(FILES_PATH)) {
      // The forum's officers (and admins) may remove anyone's picture (BridgeHall e11-t09)
      await this.files.remove(user.id, decodeURIComponent(url.pathname.slice(FILES_PATH.length)), moderatesForum(user))
      return json({ ok: true })
    }
    // Any member's picture, for both sites; cached by its version (`?v=`)
    const avatar = url.pathname.match(/^\/api\/avatar\/([\w-]+)$/)
    if (request.method === 'GET' && avatar) return avatarResponse(await this.service.avatar(avatar[1]), request)
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
    if (route === 'GET /api/history/days') return json(this.service.historyDays(user.id, parseHistoryQuery(url.searchParams)))
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
    // The practice dialog (e10-t16): the club's practice sets (no boards), and the member's own saved settings
    if (route === 'GET /api/practice/sets') return json({ sets: this.service.practiceSets() })
    if (route === 'GET /api/practice/presets') return json({ presets: await this.service.savedPractice(user.id) })
    if (route === 'POST /api/practice/presets') return json({ presets: await this.service.savePractice(user.id, await body()) })
    const preset = url.pathname.match(/^\/api\/practice\/presets\/([\w-]+)$/)
    if (preset && request.method === 'DELETE') return json({ presets: await this.service.removeSavedPractice(user.id, preset[1]) })
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
    // The Vugraph page (e8-t18): both rooms, the score and the watchers' chat; never for the match's players
    const vugraph = url.pathname.match(/^\/api\/matches\/([\w-]+)\/vugraph(\/chat)?$/)
    if (vugraph && request.method === 'GET' && !vugraph[2]) return json({ vugraph: await this.service.matchVugraph(user.id, vugraph[1]) })
    if (vugraph && request.method === 'POST' && vugraph[2])
      return json({ vugraph: await this.service.matchVugraphChat(user.id, vugraph[1], (await body()).text) })
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
          restored: async (prefixes, tables) => {
            this.book = new BookService(this.store)
            this.articles = this.newArticles()
            this.ebooks = this.newEbooks()
            this.profiles = new ProfileService(this.store, Date.now, (id) => this.service.usernameOf(id))
            this.service.systemSpecs.forget()
            // Members come back as of the backup and everyone signs in again (DEPLOY.md §4.4)
            if (prefixes.some((p) => ACCOUNT_PREFIXES.includes(p))) await this.service.reloadAccounts()
            // The forum keeps nothing in memory; this fills in what an older backup's rows lack (search words, built-in boards)
            if (tables.length) this.forum.createTables()
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
    const memberTeams = path.match(/^\/members\/([\w-]+)\/teams$/)
    if (memberTeams) return json(await this.teams.memberTeams(memberTeams[1]))
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
    // 建議統一 (BridgeHall e2-t08): the captain asks a partnership to drop an override
    const unify = path.match(/^\/teams\/([\w-]+)\/suggest-unify$/)
    if (unify) {
      await this.notices.suggestUnify(user, unify[1], await body())
      return json({ ok: true })
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
   * TKU-BridgeHall's forum (E11, e11-t06, e11-t07); members only. Who may use each route is in
   * roles.ts. New posts and comments, edits that name someone new and pins tell the members they
   * are about (e11-t08, forum-notices.ts); what the officers do is in the audit log (e11-t09)
   */
  private async forumApi(request: Request, url: URL, user: Me, body: () => Promise<Body>) {
    const path = url.pathname.slice('/api/forum'.length)
    const method = request.method
    const need = forumRouteNeed(method, path)
    if (!need) throw new ClubError('noSuchApi', {}, 404)
    requireNeed(user, need)
    const forum = this.forum
    const notices = this.forumNotices
    const audit = (action: AuditAction, target: string, note?: string) =>
      this.tell(async () => {
        await this.book.auditTrail.record({ by: user.username, action, target, note })
      }, 'forumAudit')
    const tell = (send: () => Promise<void>) => this.tell(send, 'forumNotice')
    /** Whose a post or comment was, for the audit log */
    const whose = (authorId: string, excerpt: string) => `${this.service.usernameOf(authorId) ?? authorId}：${excerpt}`

    if (path === '/boards') {
      if (method === 'GET') return json({ boards: forum.boards() })
      const created = forum.createBoard(await body())
      await audit('forum:board', created.id, created.name)
      return json({ board: created })
    }
    if (path === '/latest') return json(forum.latest())
    if (path === '/feed') {
      // 我的貼文 and 我提到的 (BridgeHall e11-t10): one member's posts, or the posts mentioning one
      const member = (name: string) => url.searchParams.get(name)?.slice(0, 64) || undefined
      return json(forum.feed(Number(url.searchParams.get('page') ?? 1), { author: member('author'), mentions: member('mentions') }))
    }
    // 搜尋 (BridgeHall e11-t10): titles and text blocks
    if (path === '/search') return json(forum.search(url.searchParams.get('q'), Number(url.searchParams.get('page') ?? 1)))
    if (path === '/reports') {
      if (method === 'GET') return json({ reports: forum.reports(url.searchParams.get('status') === 'all' ? 'all' : 'open') })
      return json({ report: forum.fileReport(user, await body()) })
    }
    const report = path.match(/^\/reports\/([\w-]+)$/)
    if (report) {
      const { report: handled, reported } = forum.decideReport(user, report[1], await body())
      const what = reported.authorId ? whose(reported.authorId, reported.excerpt ?? '') : ''
      const note = [what, `檢舉：${handled.reason}`].filter(Boolean).join('；')
      if (handled.status === 'dismissed') await audit('forum:dismiss', reported.postId ?? handled.targetId, note)
      else if (reported.postId)
        await audit(handled.target === 'post' ? 'forum:removePost' : 'forum:removeComment', reported.postId, note)
      return json({ report: handled })
    }
    const posts = path.match(/^\/boards\/([\w-]+)\/posts$/)
    if (posts) {
      if (method === 'GET') return json(forum.boardPage(posts[1], Number(url.searchParams.get('page') ?? 1)))
      const post = forum.createPost(user, posts[1], await body())
      await tell(() => notices.posted(user, post, forum.board(post.boardId)))
      return json({ post })
    }
    const board = path.match(/^\/boards\/([\w-]+)$/)
    if (board) {
      if (method === 'PATCH') {
        const changed = forum.updateBoard(board[1], await body())
        await audit('forum:board', changed.id, changed.name)
        return json({ board: changed })
      }
      const { name } = forum.board(board[1])
      forum.deleteBoard(board[1])
      await audit('forum:boardDelete', board[1], name)
      return json({ ok: true })
    }
    const reaction = path.match(/^\/(posts|comments)\/([\w-]+)\/reaction$/)
    if (reaction) {
      const target = reaction[1] === 'posts' ? 'post' : 'comment'
      if (method === 'PUT') return json({ reactions: forum.react(user, target, reaction[2], await body()) })
      return json({ reactions: forum.unreact(user, target, reaction[2]) })
    }
    const postAction = path.match(/^\/posts\/([\w-]+)\/(pin|lock|comments)$/)
    if (postAction) {
      const [, id, action] = postAction
      if (action === 'pin') {
        const was = forum.post(id).pinned === true
        const post = forum.setPinned(id, await body())
        const now = post.pinned === true
        if (was !== now) {
          await audit(now ? 'forum:pin' : 'forum:unpin', id, postExcerpt(post))
          if (now) await tell(() => notices.pinned(user, post))
        }
        return json({ post })
      }
      if (action === 'lock') {
        const was = forum.post(id).locked === true
        const post = forum.setLocked(id, await body())
        if (was !== (post.locked === true)) await audit(post.locked ? 'forum:lock' : 'forum:unlock', id, postExcerpt(post))
        return json({ post })
      }
      const comment = forum.addComment(user, id, await body())
      await tell(() => notices.commented(user, forum.post(id), comment, comment.parentId ? forum.comment(comment.parentId) : undefined))
      return json({ comment })
    }
    const post = path.match(/^\/posts\/([\w-]+)$/)
    if (post) {
      if (method === 'GET') return json(forum.thread(post[1]))
      const before = forum.post(post[1])
      if (method === 'PATCH') {
        const updated = forum.updatePost(user, post[1], await body())
        await tell(() => notices.edited(user, updated, before.mentions ?? []))
        return json({ post: updated })
      }
      forum.deletePost(user, post[1])
      if (before.authorId !== user.id) await audit('forum:removePost', post[1], whose(before.authorId, postExcerpt(before)))
      return json({ ok: true })
    }
    const comment = path.match(/^\/comments\/([\w-]+)$/)
    if (comment) {
      const before = forum.comment(comment[1])
      if (method === 'PATCH') {
        const updated = forum.updateComment(user, comment[1], await body())
        await tell(() => notices.edited(user, forum.post(updated.postId), before.mentions ?? [], updated))
        return json({ comment: updated })
      }
      forum.deleteComment(user, comment[1])
      if (before.authorId !== user.id) await audit('forum:removeComment', before.postId, whose(before.authorId, postExcerpt(before)))
      return json({ ok: true })
    }
    throw new ClubError('noSuchApi', {}, 404)
  }

  /**
   * TKU BridgeBook's online editing and system profiles; reading the content (publicBookResponse)
   * needs any member (since 2026-10-29). Who may use each route is in roles.ts.
   */
  /** Sends the handbook's notifications (e8-t10); what was saved stays saved when they fail */
  private async tell(send: () => Promise<void>, where = 'bookNotice') {
    try {
      await send()
    } catch (error) {
      jsonLog({ event: 'crash', where, error: error instanceof Error ? error.message : String(error) })
    }
  }

  private async bookApi(request: Request, url: URL, user: Me, body: () => Promise<Body>) {
    const path = url.pathname.slice('/api/book'.length)
    const method = request.method
    const need = bookRouteNeed(method, path)
    if (!need) throw new ClubError('noSuchApi', {}, 404)
    requireNeed(user, need)

    // BridgeHall's error reports and usage counts (e10-t06, e10-t07); roles.ts decides who
    if (path === '/errors') {
      if (method === 'GET') return json({ errors: this.telemetry.errors() })
      this.telemetry.clearErrors()
      return new Response(null, { status: 204 })
    }
    if (path === '/analytics') return json(this.telemetry.view())
    if (path === '/analytics/settings') {
      if (!this.telemetry.setEnabled(await body())) throw new ClubError('badMessage')
      return json(this.telemetry.view())
    }

    const convention = path.match(/^\/conventions\/([\w-]+)(?:\/(hide|reset|reject|draft|revisions)(?:\/([\w-]+))?)?$/)
    if (convention) {
      const [, slug, action, revisionId] = convention
      // Drafts and review (BridgeHall e8-t01, e8-t02)
      if (action === 'draft') {
        if (method === 'GET') return json({ draft: await this.book.draftOf(slug) })
        if (method === 'PUT') {
          const draft = await this.book.saveBookDraft(user, slug, await body())
          if (draft.status === 'in-review') await this.tell(() => this.notices.reviewRequested(user, { slug, name: conventionName(draft.convention, slug) }))
          return json({ draft })
        }
        await this.book.discardDraft(user, slug, await body())
        return json({ ok: true })
      }
      if (action === 'reject') {
        const requestedBy = (await this.book.draftOf(slug))?.reviewRequestedBy
        const draft = await this.book.reject(user, slug, await body())
        await this.tell(() => this.notices.returned(user, { slug, name: conventionName(draft.convention, slug), requestedBy }))
        return json({ draft })
      }
      if (method === 'PUT') {
        const input = await body()
        const entry = await this.book.save(user, slug, input)
        // Notes the new version no longer has are closed (BridgeHall e8-t08)
        const [revision] = await this.book.revisions(slug)
        await this.pending.published(user, slug, entry.convention, entry.version, revision?.note ?? '')
        const publish = { slug, name: conventionName(entry.convention, slug), version: entry.version, requestedBy: entry.reviewRequestedBy }
        await this.tell(() => this.notices.published(user, { ...publish, changedSections: input.changedSections }))
        return json({ entry })
      }
      if (action === 'hide') return json({ entry: await this.book.hide(user, slug, await body()) })
      if (action === 'reset') {
        await this.book.reset(user, slug, await body())
        return json({ ok: true })
      }
      if (revisionId) return json({ revision: await this.book.revision(slug, revisionId) })
      return json({ revisions: await this.book.revisions(slug) })
    }
    // An article (BridgeHall e5-t04); reading it is above, without signing in
    const article = path.match(/^\/articles\/([\w-]+)(?:\/(hide|reject|draft|revisions)(?:\/([\w-]+))?)?$/)
    if (article) {
      const [, slug, action, revisionId] = article
      // Drafts and review (BridgeHall e5-t07)
      if (action === 'draft') {
        if (method === 'GET') return json({ draft: await this.articles.draftOf(slug) })
        if (method === 'PUT') {
          const draft = await this.articles.saveDraft(user, slug, await body())
          if (draft.status === 'in-review') await this.tell(() => this.notices.articleReviewRequested(user, { slug, title: articleTitle(draft.article, slug) }))
          return json({ draft })
        }
        await this.articles.discardDraft(user, slug, await body())
        return json({ ok: true })
      }
      // Sent back or published: who sent it for review hears it (J4)
      if (action === 'reject') {
        const requestedBy = (await this.articles.draftOf(slug))?.reviewRequestedBy
        const draft = await this.articles.reject(user, slug, await body())
        await this.tell(() => this.notices.articleReviewed(user, 'articleReturned', { slug, title: articleTitle(draft.article, slug), requestedBy }))
        return json({ draft })
      }
      if (method === 'PUT') {
        const entry = await this.articles.save(user, slug, await body())
        const requestedBy = entry.reviewRequestedBy
        if (requestedBy)
          await this.tell(() => this.notices.articleReviewed(user, 'articlePublished', { slug, title: articleTitle(entry.article, slug), requestedBy }))
        return json({ entry })
      }
      if (action === 'hide') return json({ entry: await this.articles.hide(user, slug, await body()) })
      if (revisionId) return json({ revision: await this.articles.revision(slug, revisionId) })
      return json({ revisions: await this.articles.revisions(slug) })
    }
    // An e-book (BridgeHall e5-t09): a pass for its PDF, adding, changing and taking one down; reading is above
    if (path === '/ebooks/ticket') return json(await this.files.createEbookTicket(user.id, await body()))
    if (path === '/ebooks') return json({ ebook: await this.ebooks.create(user, await body()) })
    const ebook = path.match(/^\/ebooks\/([\w-]+)$/)
    if (ebook) {
      if (method === 'PUT') return json({ ebook: await this.ebooks.update(user, ebook[1], await body()) })
      await this.ebooks.remove(user, ebook[1])
      return json({ ok: true })
    }
    // Following a convention (關注, e8-t10)
    const follow = path.match(/^\/follows\/([\w-]+)$/)
    if (follow) {
      if (method === 'GET') return json({ following: await this.notices.following(user.id, follow[1]) })
      return json({ following: await this.notices.setFollowing(user.id, follow[1], await body()) })
    }
    if (path === '/reviews') return json({ drafts: await this.book.bookDrafts(), articles: await this.articles.drafts() })
    if (path === '/audit') return json({ entries: await this.book.auditLog() })
    if (path === '/pending') return json({ ...(await this.pending.list()), editors: this.service.editorNames() })
    const pending = path.match(/^\/pending\/([\w-]+)\/([\w-]+)\/(\d+)$/)
    if (pending) return json({ meta: await this.pending.save(user, pending[1], pending[2], Number(pending[3]), await body()) })
    if (path === '/categories') return json(await this.book.saveCategories(user, await body()))
    // The built-in conventions' seed (L0), from an admin's session; the script's token is above
    if (path === '/builtin') return json(await this.book.seedBuiltin(user.username, await body()))
    // The backup's export (L1), from an admin's session; the backup's token is above
    if (path === '/export') return json(await this.book.exportAll())
    if (path === '/series') return json(await this.articles.saveSeries(user, await body()))
    if (path === '/glossary') return json(await this.glossary.save(user, await body()))

    if (path === '/profiles') {
      if (method === 'GET') return json({ profiles: await this.teams.readableProfiles(user) })
      const created = await this.profiles.create(user, await body())
      await this.book.auditTrail.record({ by: user.username, action: 'profile:create', target: created.id, version: created.version })
      return json({ profile: created })
    }
    // Which member may read, save or see the versions of a team's or partnership's profile: TeamService (e2-t04)
    const profile = path.match(/^\/profiles\/([\w-]+)(\/revisions(?:\/(\d+))?)?$/)
    if (profile) {
      const [, id, revisions, version] = profile
      if (revisions && version) return json({ revision: await this.teams.profileRevision(user, id, Number(version)) })
      if (revisions) return json({ revisions: await this.teams.profileRevisions(user, id) })
      if (method === 'GET') return json(await this.teams.readProfile(user, id))
      if (method === 'PUT') {
        const saved = await this.teams.saveProfile(user, id, await body())
        await this.book.auditTrail.record({ by: user.username, action: 'profile:save', target: id, version: saved.version })
        return json({ profile: saved })
      }
      await this.profiles.remove(id, await body())
      await this.cardSnapshots.removeAll(id)
      await this.book.auditTrail.record({ by: user.username, action: 'profile:delete', target: id })
      return json({ ok: true })
    }

    // A convention card as a PDF (BridgeHall e3-t13): any member; the page falls back to printing
    if (path === '/card-pdf') {
      const input = await body()
      const name = typeof input.name === 'string' ? input.name.replace(/[^\w-]/g, '').slice(0, 80) : ''
      return pdfResponse(await this.cardPdf.render(user.id, input), `${name || 'card'}.pdf`)
    }
    // Convention card versions (BridgeHall e3-t09): reading is the profile's readers', publishing and
    // deleting its editors', turning the link on or off theirs who may set who reads the profile
    const cards = path.match(/^\/cards\/([\w-]+)(?:\/([\w-]+)\/(\d+)(\/docx)?)?$/)
    if (cards) {
      const [, id, templateId, n, docx] = cards
      const { profile, access } = await this.teams.readProfile(user, id)
      if (!templateId) {
        if (method === 'GET') return json({ snapshots: await this.cardSnapshots.list(id) })
        if (!access.edit) throw new ClubError('noPermission', {}, 403)
        const snapshot = await this.cardSnapshots.create(user, profile, await body())
        await this.book.auditTrail.record({ by: user.username, action: 'card:publish', target: `${id}/${snapshot.templateId}`, version: snapshot.n })
        return json({ snapshot })
      }
      const at = Number(n)
      if (docx) return docxResponse(await this.cardSnapshots.docx(id, templateId, at), `${templateId}-v${at}.docx`)
      if (method === 'GET') return json({ snapshot: await this.cardSnapshots.get(id, templateId, at) })
      if (method === 'PATCH') {
        if (!access.share) throw new ClubError('noPermission', {}, 403)
        return json({ snapshot: await this.cardSnapshots.share(id, templateId, at, (await body()).shared) })
      }
      if (!access.edit) throw new ClubError('noPermission', {}, 403)
      await this.cardSnapshots.remove(id, templateId, at)
      await this.book.auditTrail.record({ by: user.username, action: 'card:delete', target: `${id}/${templateId}`, version: at })
      return json({ ok: true })
    }

    // 淡江橋館 → TKB (BridgeHall e7-t03, e7-t04): the synced rules and the report page's lookups
    if (path === '/system-spec') {
      const profileId = url.searchParams.get('profileId') || this.service.systemSpecs.tableProfileId
      return json(await this.systemSpecStatus(profileId))
    }
    const specFor = path.match(/^\/system-spec\/([\w-]+)$/)
    if (specFor) {
      // Only a profile that exists; its own rules for who may save it do not apply: syncing is the editors'
      await this.profiles.get(specFor[1])
      await this.service.systemSpecs.save(user, specFor[1], await body())
      return json(await this.systemSpecStatus(specFor[1]))
    }
    if (path === '/robot-meanings') return json({ items: robotMeaningsFor(await body()) })

    // 練習 (BridgeHall e6-t04, e6-t06): a member's own results, and the editors' fixes
    if (path === '/quiz/rounds') {
      if (method === 'GET') return json({ rounds: await this.quiz.rounds(user.id) })
      if (method === 'POST') return json({ round: await this.quiz.addRound(user.id, await body()) })
      await this.quiz.clearRounds(user.id)
      return json({ ok: true })
    }
    if (path === '/quiz/fixes') {
      if (method === 'PUT') {
        const fix = await this.quiz.saveFix(user, await body())
        await this.book.auditTrail.record({ by: user.username, action: 'quiz:fix', target: fix.id, ...(fix.note && { note: fix.note }) })
        return json({ fix })
      }
      const id = await this.quiz.removeFix(await body())
      await this.book.auditTrail.record({ by: user.username, action: 'quiz:unfix', target: id })
      return json({ ok: true })
    }

    // 學習路徑 (BridgeHall e4-t11, e4-t12): a member's own progress, and the editors' paths
    if (path === '/paths/progress') {
      if (method === 'GET') return json({ progress: await this.learning.progress(user.id) })
      return json({ progress: await this.learning.markLesson(user.id, await body()) })
    }
    // 閱讀進度 (BridgeHall e5-t14): a member's own places in articles and e-books
    if (path === '/reading') {
      if (method === 'GET') return json({ places: await this.reading.places(user.id) })
      if (method === 'PUT') return json({ place: await this.reading.mark(user.id, await body()) })
      await this.reading.forget(user.id, await body())
      return json({ ok: true })
    }
    if (path === '/paths') {
      if (method === 'PUT') {
        const saved = await this.learning.savePath(user, await body())
        await this.book.auditTrail.record({ by: user.username, action: 'path:save', target: saved.id })
        return json({ path: saved })
      }
      const id = await this.learning.removePath(await body())
      await this.book.auditTrail.record({ by: user.username, action: 'path:reset', target: id })
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

  /** GET of a shared convention card version (or its Word file); null when it is not shared, or not one */
  private async sharedCardResponse(pathname: string): Promise<Response | null> {
    const m = pathname.match(/^\/api\/book\/cards\/([\w-]+)\/([\w-]+)\/(\d+)(\/docx)?$/)
    if (!m) return null
    const [, id, templateId, n, docx] = m
    const meta = await this.cardSnapshots.meta(id, templateId, Number(n)).catch(() => null)
    if (!meta?.shared) return null
    if (docx) return docxResponse(await this.cardSnapshots.docx(id, templateId, meta.n), `${templateId}-v${meta.n}.docx`)
    return json({ snapshot: await this.cardSnapshots.get(id, templateId, meta.n) })
  }

  /** Articles sign their pictures' addresses with the file service's key */
  private newArticles() {
    return new ArticleService(this.store, (keys) => this.files.urls(keys))
  }

  /** E-books sign their PDFs' and covers' addresses the same way */
  private newEbooks() {
    const files = this.files
    return new EbookService(this.store, {
      sign: (keys) => files.urls(keys),
      meta: (key) => files.meta(key),
      remove: (userId, key, any) => files.remove(userId, key, any),
      usage: () => files.usage(),
    })
  }

  private async systemSpecStatus(profileId: string): Promise<SystemSpecStatus> {
    const synced = await this.service.systemSpecs.get(profileId)
    const name = synced && this.service.usernameOf(synced.syncedBy)
    return {
      tableProfileId: this.service.systemSpecs.tableProfileId,
      synced: synced ? { ...synced, ...(name ? { syncedByName: name } : {}) } : null,
    }
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

/** A Word file to download */
function docxResponse(bytes: Uint8Array, name: string) {
  return new Response(bytes, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'no-store',
    },
  })
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
