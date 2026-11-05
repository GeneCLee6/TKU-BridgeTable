import { DurableObject } from 'cloudflare:workers'
import { clubName, clubOfClubObject, clubOfPath, clubPath, clubStoragePrefix, DEFAULT_CLUB_ID, knownClubs } from '../shared/clubs.ts'
import { CLUB_APPLY_API, type ClubApplyOptions, type ClubStatus, type ClubUsage } from '../shared/platform.ts'
import type { GuestTable, PublicTable } from '../shared/public-lobby.ts'
import { AppError } from '../shared/messages.ts'
import type { ChallengeSettings } from '../shared/challenge.ts'
import { parseHistoryQuery } from '../shared/history-query.ts'
import { toSessionLin } from '../shared/lin.ts'
import { toPbnFile } from '../shared/pbn.ts'
import { MESSAGE_MAX_CHARS } from '../shared/message-guard.ts'
import type { BoardRecord, Me, RegisterOptions, ServerMessage, SystemSpecStatus } from '../shared/protocol.ts'
import type { BookNotes } from '../shared/robot/system/book-spec.ts'
import { TKU } from '../shared/robot/system/tku/index.ts'
import { bookSync } from '../shared/robot/system/tku/sources.ts'
import { DEVICE_COOKIE, deviceCookie, randomId, readCookie, sessionCookie, sessionCookieName } from './auth.ts'
import { deviceLabel } from '../shared/account.ts'
import { ACCOUNT_PREFIXES, backupAdmin, listBackups, runBackup } from './backup.ts'
import { scopedBucket } from './buckets.ts'
import { BookService, IMPORT_LIMITS, importRequestFrom, publicBookResponse } from './book.ts'
import { readForm, readJson, readText } from './body.ts'
import { seedTokenMatches } from './book-seed.ts'
import { BookNotices } from './book-notices.ts'
import { PendingService } from './pending.ts'
import { GlossaryService, publicGlossaryResponse } from './glossary.ts'
import { claudeImporter } from './importer.ts'
import { mailerFrom } from './mail.ts'
import { pushFrom } from './web-push.ts'
import { googleFrom } from './google.ts'
import { lineFrom } from './line.ts'
import { callbackPath, flowCookie, flowCookieName, OAUTH_APPLY_MS, OAUTH_CODE_MS, oauthSite, safeReturn, type OAuthName } from './oauth.ts'
import { ProfileService } from './profiles.ts'
import { CardPdfService, pdfResponse } from './card-pdf.ts'
import { CardSnapshotService } from './card-snapshots.ts'
import { avatarResponse, readAvatarUpload } from './avatars.ts'
import { FILES_PATH, FileService, readFileUpload } from './files.ts'
import { addedImageKeys, checkImagesOwned, droppedImageKeys, releaseImages, signFiles } from './post-images.ts'
import { adminRouteNeed, allows, articleReadRoute, bookRouteNeed, ebookReadRoute, clubRouteNeed, forumRouteNeed, moderatesForum, requireNeed } from './roles.ts'
import { type ArticleReader, ArticleService } from './articles.ts'
import { type EbookReader, EbookService } from './ebooks.ts'
import { ForumService, postExcerpt, postImageKeys, tagFilter } from './forum.ts'
import { ForumNotices } from './forum-notices.ts'
import { ForumSchedule } from './forum-schedule.ts'
import { addedRecordIds } from './forum-share.ts'
import { BOOK_EVENTS_MAX_CHARS, BookTelemetry } from './book-telemetry.ts'
import type { AuditAction } from './audit.ts'
import tkuSystemCard from 'virtual:system-card-tku'
import { tkuCardResponse } from './system-card.ts'
import { robotMeaningsFor } from './system-spec.ts'
import { QuizStore } from './quiz.ts'
import { LearningStore } from './learning.ts'
import { ReadingStore } from './reading.ts'
import { CLIENT_ERROR_MAX_CHARS } from './client-errors.ts'
import { d1Replica } from './d1.ts'
import { edgeSecret, mintPass, passCookie, passCookieName, passNeedsRefresh } from './edge-auth.ts'
import { clubLog, crashEntry, jsonLog, type Logger, sampleActions } from './log.ts'
import { clubStub, eventStub, tableStub } from './clubs.ts'
import { seenSalt } from './integrity.ts'
import { CLUB_APPLICATION_WINDOW_MS, CLUB_APPLICATIONS_PER_ADDRESS, PlatformService, requireApplyClub, requirePlatformOwner, type ClubSetup, type RegistryEntry } from './platform.ts'
import { RegistrationLimit } from './register-limit.ts'
import { requireTurnstile, turnstileKeys } from './turnstile.ts'
import type { TableStats } from './metrics.ts'
import { type ChallengeRequest, ClubError, ClubService, type Connections, type OAuthOutcome } from './service.ts'
import type { EventReport } from './modes.ts'
import type { Store } from './store.ts'
import { TeamService } from './teams.ts'
import type { TableObject } from './table-object.ts'
import type { EventObject } from './event-object.ts'
import { RemoteEvents, type EventRpc, type EventSnapshot } from './events.ts'
import { RemoteMatches, type MatchRpc, type MatchSnapshot } from './match-events.ts'
import { RemotePairs, type PairsRpc, type PairsSnapshot } from './pairs-events.ts'
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
  /**
   * The clubs this Worker serves besides 淡江 (e12-t03, shared/clubs.ts `knownClubs`): comma-separated
   * ids. None in production until clubs can be opened and run (e12-t05, e12-t06); staging may name
   * one to try a second club
   */
  CLUBS?: string
  /**
   * The platform owner (e12-t05, DEPLOY.md §4.20): the user id of the one 淡江 account that runs the
   * platform's back office (/platform), with two-step sign-in on. Without it there is no back
   * office and no club can be applied for
   */
  PLATFORM_OWNER?: string
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
  /**
   * Salts the anti-cheating report's network hashes (wrangler secret put SEEN_SALT, ARCHITECTURE.md
   * §5.17); without it no network is kept, only the browser
   */
  SEEN_SALT?: string
  /**
   * Turnstile on 申請加入 (e1-t33, worker/turnstile.ts, DEPLOY.md §4.13): the site key is a plain
   * variable, the secret a wrangler secret; Turnstile is on only when both are set
   */
  TURNSTILE_SITE_KEY?: string
  TURNSTILE_SECRET_KEY?: string
  /** Signs edge passes (wrangler secret put EDGE_AUTH_SECRET); without it the Worker asks the club every time */
  EDGE_AUTH_SECRET?: string
  /** "off" stops handing out and reading edge passes: the switch back (DEPLOY.md §4.5) */
  EDGE_AUTH?: string
  /** The system profile whose 淡江橋館 rules TKB follows (BridgeHall e7-t03); the club's when unset */
  SYSTEM_PROFILE_ID?: string
  /**
   * Email (e1-t29, e1-t30; worker/mail.ts, DEPLOY.md §4.14): Resend's API key (wrangler secret put
   * RESEND_API_KEY) and the sender, an address on a domain verified there. Without both, email is off
   */
  RESEND_API_KEY?: string
  MAIL_FROM?: string
  /**
   * The site owner's last resort for an admin who lost both the authenticator and the recovery
   * codes (社長 2026-11-02, DEPLOY.md §4.15): set with `wrangler secret put` only for the reset and
   * deleted right after, so only someone with access to the Cloudflare account can use it. Without
   * it (the normal state) `POST /api/ops/two-factor-reset` does not exist
   */
  TWO_FACTOR_RESET_TOKEN?: string
  /**
   * Google sign-in (e1-t31; worker/google.ts, DEPLOY.md §4.16): the OAuth client's id and secret
   * from Google Cloud (wrangler secret put). Without both, Google sign-in is off; PR previews never get them
   */
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  /**
   * Web Push (e1-t28; worker/web-push.ts, DEPLOY.md §4.17): the VAPID key pair made by `npm run vapid`
   * and a contact (`mailto:` or `https:`) for the push services, all three wrangler secrets. Without
   * all three, push is off; PR previews never get them
   */
  VAPID_PUBLIC_KEY?: string
  VAPID_PRIVATE_KEY?: string
  VAPID_SUBJECT?: string
  /**
   * LINE login (e1-t32; worker/line.ts, DEPLOY.md §4.18): the LINE Login channel's id and secret
   * from LINE Developers (wrangler secret put). Without both, LINE login is off; PR previews never get them
   */
  LINE_CHANNEL_ID?: string
  LINE_CHANNEL_SECRET?: string
}

/** A picture's upload may come straight from TKU BridgeBook's page too; its single-use pass is the check */
const FILE_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
}

/**
 * A club's own record of itself (e12-t05, e12-t06), at `meta:club` in its object: written when the
 * platform owner approves it, changed when they suspend it or serve it again. 淡江 has none (it is
 * always served). Not in the backup (`meta:`), so restoring one never changes a suspension
 */
interface ClubRecord {
  id: string
  name: string
  organisation: string
  contactEmail: string
  status: ClubStatus
  approvedAt: number
}
const CLUB_RECORD_KEY = 'meta:club'

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
/** An AI import's form: the PDF at its limit, plus room for the other fields */
const IMPORT_BODY_MAX_BYTES = (IMPORT_LIMITS.pdfMb + 1) * 1024 * 1024
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
  /** The forum's scheduled posts (e13-t12): their times are in the forum's rows, their jobs in the club's scheduler */
  private readonly forumSchedule: ForumSchedule
  /** BridgeHall's error reports and anonymous usage counts (e10-t06, e10-t07) in the object's SQLite database */
  private readonly telemetry: BookTelemetry
  /** The handbook's notifications and who follows which convention (BridgeHall e8-t10); keeps nothing in memory */
  private readonly notices: BookNotices
  private readonly store: Store
  /** Signs edge passes (§5.12); none when switched off */
  private readonly edgeSecret: string | undefined
  /** Which club this object is (e12-t02): its name says */
  private readonly clubId: string
  /** Every log line says the club (e12-t03) */
  private readonly log: Logger
  /** The club's own record (e12-t05): undefined for 淡江 and for a club never opened */
  private record: ClubRecord | undefined
  /** Club applications per address (e12-t06), used in 淡江's object only */
  private readonly applyLimit: RegistrationLimit

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    const storage = ctx.storage
    // One object per club (e12-t02): its name says which; 淡江's is `club`
    const clubId = (this.clubId = clubOfClubObject(ctx.id.name))
    const log = (this.log = clubLog(clubId, jsonLog))
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
      clubId,
      maxUsers: Number(env.MAX_USERS ?? 10),
      // INVITE_CODE is 淡江's (DEPLOY.md): another club's admin sets its own (e12-t03)
      inviteCode: (clubId === DEFAULT_CLUB_ID && env.INVITE_CODE) || undefined,
      // One alarm wakes the object for every robot move and deal, so it can hibernate in between
      wake: (at) => void storage.setAlarm(at),
      // Actions sampled (H3b); the status page still counts every one
      log: sampleActions(log),
      // The lobby goes out at most every LOBBY_GAP_MS while it keeps changing (H3b)
      later: (run, ms) => void setTimeout(run, ms),
      // Each table in its own object (§5.10), unless switched back with TABLE_OBJECTS=off; named after
      // this club, so no other club's object is ever reached (e12-t03, shared/clubs.ts tableObjectName)
      tableObjects: new RemoteTables((tableId) => tableStub(env, clubId, tableId) as unknown as TableRpc),
      tablesInClub: env.TABLE_OBJECTS === 'off',
      // Each challenge (H2b) and team match (H2c) in its own object (§5.12) only when switched on; off by default
      eventObjects: new RemoteEvents((challengeId) => eventStub(env, clubId, 'challenge', challengeId) as unknown as EventRpc),
      matchObjects: new RemoteMatches((matchId) => eventStub(env, clubId, 'match', matchId) as unknown as MatchRpc),
      // A pairs event (§5.22) goes into its own object when made while the switch is on, and stays there
      pairsObjects: new RemotePairs((eventId) => eventStub(env, clubId, 'pairs', eventId) as unknown as PairsRpc),
      eventObjectsOn: env.EVENT_OBJECTS === 'on',
      // The history pages' copy in D1, read by the Worker (§5.12); this club's rows only (e12-t03)
      historyReplica: env.HISTORY ? d1Replica(env.HISTORY) : undefined,
      historyReplicaOff: env.HISTORY_D1 === 'off',
      systemProfileId: env.SYSTEM_PROFILE_ID || undefined,
      // The anti-cheating report's network salt (§5.17): a secret, never in the club's storage
      seenSalt: env.SEEN_SALT || undefined,
      // Email (e1-t29, e1-t30): none unless RESEND_API_KEY and MAIL_FROM are set
      mailer: mailerFrom(env),
      // Google sign-in and LINE login (e1-t31, e1-t32): none unless their two secrets are set, and only
      // for 淡江: the way back carries no club, so it always reaches 淡江's object
      ...(clubId === DEFAULT_CLUB_ID && { google: googleFrom(env), line: lineFrom(env) }),
      // Web Push (e1-t28): none unless the three VAPID secrets are set; sent after the answer, kept alive by waitUntil
      push: pushFrom(env),
      defer: (task) => ctx.waitUntil(task),
      // A deleted member's forum drafts and scheduled posts go (the president, 2026-11-03), then
      // their pictures that no post uses go from R2 (e13-t13); the ones in their published posts stay with the posts
      onMemberRemoved: async (userId) => {
        this.forum.forgetUnpublished(userId)
        await this.files.forget(userId, (key) => this.forum.imagesInUse([key], 'all').size > 0)
      },
      // The platform owner (e12-t05): 淡江's account named by PLATFORM_OWNER
      ...(clubId === DEFAULT_CLUB_ID && env.PLATFORM_OWNER && { platformOwnerId: env.PLATFORM_OWNER }),
    })
    this.applyLimit = new RegistrationLimit(store, Date.now, seenSalt(env.SEEN_SALT), {
      key: 'meta:clubApplications',
      label: 'clubApply',
      max: CLUB_APPLICATIONS_PER_ADDRESS,
      windowMs: CLUB_APPLICATION_WINDOW_MS,
    })
    this.edgeSecret = edgeSecret(env)
    this.book = new BookService(store)
    this.pending = new PendingService(store, this.book.auditTrail)
    // Admins hear when the files near R2's free room (BridgeHall e5-t15)
    // In the club's own part of the bucket (淡江's keys as they were, e12-t03), and its addresses name the club
    this.files = new FileService(
      store,
      env.FILES && scopedBucket(env.FILES, clubStoragePrefix(clubId)),
      Date.now,
      async (bytes) => {
        for (const id of this.service.adminIds()) await this.service.notifications.notify(id, 'filesNearlyFull', { gb: Math.round((bytes / 1024 ** 3) * 10) / 10 })
      },
      clubId,
    )
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
      blocked: (by, other) => this.service.hasBlocked(by, other),
    })
    this.forumSchedule = new ForumSchedule({
      forum: this.forum,
      at: (key, at, run) => this.service.scheduleAt(key, 'forum', at, run),
      member: (id) => this.service.memberMe(id),
      // Out at its time: told as a new post is
      published: (author, post, board) => this.tell(() => this.forumNotices.posted(author, post, board), 'forumNotice'),
    })
    // Browsers send "ping" every few seconds to keep phone connections alive and to notice a dead
    // one quickly; the runtime answers without waking the object
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
    ctx.blockConcurrencyWhile(async () => {
      if (clubId !== DEFAULT_CLUB_ID) this.record = await storage.get<ClubRecord>(CLUB_RECORD_KEY)
      await this.service.load()
      // Jobs are not stored: the scheduled posts wait for their times again (e13-t12)
      this.forumSchedule.load()
    })
  }

  async alarm() {
    await this.service.runDue()
  }

  /** This club's own part of the backup bucket (e12-t03): 淡江's `daily/…` as it was, `clubs/<id>/daily/…` for any other club */
  private backups() {
    return this.env.BACKUPS && scopedBucket(this.env.BACKUPS, clubStoragePrefix(this.clubId))
  }

  /** The daily backup to R2, called by the cron trigger (worker/index.ts `scheduled`) */
  async backup() {
    const bucket = this.backups()
    if (!bucket) {
      this.log({ event: 'backup', ok: false, error: 'no BACKUPS binding' })
      return null
    }
    try {
      const result = await runBackup(this.store, bucket, Date.now())
      this.log({ event: 'backup', ok: true, name: result.name, keys: result.keys, rows: result.rows, bytes: result.bytes, deleted: result.deleted.length })
      return result
    } catch (error) {
      this.log({ event: 'backup', ok: false, error: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }

  // ── The platform (e12-t05, e12-t06; worker/platform.ts) ─────────────────────────────────────

  /**
   * Why this club answers nothing, or null when it is served: 淡江 always is; another club once the
   * platform opened it (its `meta:club`) or while the `CLUBS` override names it, and not while
   * suspended. Checked by every request and socket, whatever the Worker's copy of the registry says
   */
  private closedBecause(): ClubError | null {
    if (this.clubId === DEFAULT_CLUB_ID) return null
    if (this.record) return this.record.status === 'suspended' ? new ClubError('clubSuspended', {}, 403) : null
    return knownClubs(this.env.CLUBS).includes(this.clubId) ? null : new ClubError('unknownClub', {}, 404)
  }

  /** A table's or an event's report to a club never opened is turned away (it offers it again later) */
  private requireOpened() {
    if (this.closedBecause()?.code === 'unknownClub') throw new Error(`Club ${this.clubId} is not open`)
  }

  /** The platform's logic, in 淡江's object; made per use, so it always writes to the current audit trail */
  private platform(): PlatformService {
    if (this.clubId !== DEFAULT_CLUB_ID) throw new ClubError('noSuchApi', {}, 404)
    return new PlatformService(this.store, {
      now: Date.now,
      newId: () => randomId(8),
      audit: this.book.auditTrail,
      limit: this.applyLimit,
      mailer: mailerFrom(this.env),
      extraClubs: knownClubs(this.env.CLUBS),
      log: this.log,
      // The owner's bell (and push) hears of each new application; no owner, no notification
      ...(this.env.PLATFORM_OWNER && {
        notifyOwner: (params: { clubId: string; name: string }) => this.service.notifications.notify(this.env.PLATFORM_OWNER!, 'clubApplication', params),
      }),
      clubs: {
        provision: (id, setup) => clubStub(this.env, id).platformProvision(setup),
        setStatus: (id, status) => clubStub(this.env, id).platformSetStatus(status),
        // 淡江's own from here: an object never calls itself
        usage: (id) => (id === this.clubId ? this.platformUsage() : clubStub(this.env, id).platformUsage()),
      },
    })
  }

  /** The clubs the platform opened, for the Worker's routing and the daily backup (淡江's object only) */
  async platformRegistry(): Promise<RegistryEntry[]> {
    return this.platform().registry()
  }

  /** Opens this club with its first admin (the owner approved it); again changes nothing */
  async platformProvision(setup: ClubSetup): Promise<void> {
    if (this.clubId === DEFAULT_CLUB_ID) throw new Error('淡江 is never provisioned')
    await this.service.provisionFounder(setup.username, setup.passwordHash)
    if (this.record) return
    const record: ClubRecord = {
      id: this.clubId,
      name: setup.name,
      organisation: setup.organisation,
      contactEmail: setup.contactEmail,
      status: 'active',
      approvedAt: setup.approvedAt,
    }
    await this.ctx.storage.put(CLUB_RECORD_KEY, record)
    this.record = record
    this.log({ event: 'clubStatus', status: 'provisioned' })
  }

  /** Suspends this club (every session ends, every socket closes, nothing is deleted) or serves it again */
  async platformSetStatus(status: ClubStatus): Promise<void> {
    if (this.clubId === DEFAULT_CLUB_ID || !this.record) throw new Error(`Club ${this.clubId} has no record`)
    const record: ClubRecord = { ...this.record, status }
    await this.ctx.storage.put(CLUB_RECORD_KEY, record)
    this.record = record
    if (status === 'suspended') await this.service.endEverySession()
    this.log({ event: 'clubStatus', status })
  }

  /** This club's size for the back office: counts from its own storage, R2 and D1 (rough) */
  async platformUsage(): Promise<ClubUsage> {
    const bucket = this.backups()
    const backupBytes = bucket ? (await listBackups(bucket)).reduce((n, b) => n + b.size, 0) : null
    let historyRows: number | null = null
    if (this.env.HISTORY) {
      try {
        const [rows] = await d1Replica(this.env.HISTORY).batch([
          { sql: 'SELECT COUNT(*) AS n FROM boards_index WHERE club_id = ?', params: [this.clubId] },
        ])
        historyRows = Number(rows?.[0]?.n ?? 0)
      } catch {
        // No copy yet (a new database): nothing to count
      }
    }
    return {
      ...this.service.platformCounts(),
      storageBytes: this.ctx.storage.sql.databaseSize,
      filesBytes: (await this.files.usage()).bytes,
      backupBytes,
      historyRows,
    }
  }

  // ── What the tables and the Worker ask over RPC (ARCHITECTURE.md §5.10) ────────────────────

  /** A table's lobby entry changed (`ClubLink.changed`) */
  async tableChanged(entry: TableEntry) {
    this.requireOpened()
    await this.service.link.changed(entry)
  }

  /** A table closed (`ClubLink.closed`) */
  async tableClosed(tableId: string) {
    this.requireOpened()
    await this.service.link.closed(tableId)
  }

  /** A table finished a board (`ClubLink.boardFinished`); a failure makes the table offer it again */
  async tableBoardFinished(record: BoardRecord, event: EventReport | null, stats?: TableStats) {
    this.requireOpened()
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
    this.requireOpened()
    await this.service.eventLink.changed(snapshot)
  }

  /** A team match in its own object tells a change again (`EventLink.matchChanged`, H2c); a failure makes it tell again */
  async matchChanged(snapshot: MatchSnapshot) {
    this.requireOpened()
    await this.service.eventLink.matchChanged(snapshot)
  }

  /** A pairs event in its own object tells a change again (`EventLink.pairsChanged`, §5.22) */
  async pairsChanged(snapshot: PairsSnapshot) {
    this.requireOpened()
    await this.service.pairs.changed(snapshot)
  }

  /** Whose session this is, for a table's connection: the Worker asks once per connection */
  async socketUser(token: string | null): Promise<string | null> {
    // A suspended club (or one never opened) lets nobody connect (e12-t05)
    if (this.closedBecause()) return null
    return (await this.service.userForToken(token))?.id ?? null
  }

  /**
   * The cross-club lobby (e12-t07, ARCHITECTURE.md §1「跨社團大廳」), asked over RPC by the Worker
   * only (`worker/routing.ts`; a browser never reaches a Durable Object): whether this club's member
   * may use it, this club's tables shown to other clubs, and one of them as a guest watches it
   */
  async publicViewer(userId: string): Promise<boolean> {
    return this.service.publicViewer(userId)
  }
  async publicTables(): Promise<PublicTable[]> {
    return this.service.publicTables().map((table) => this.named(table))
  }
  async guestTable(tableId: string): Promise<GuestTable | null> {
    const table = await this.service.guestTable(tableId)
    return table && this.named(table)
  }
  /** The name the club is shown by, for its home-screen app's manifest (worker/manifest.ts): RPC from the Worker only */
  async clubName(): Promise<string> {
    return this.record?.name || clubName(this.clubId)
  }
  /** The name the platform opened the club with (its `meta:club`, e12-t06), else shared/clubs.ts's */
  private named<T extends { clubName: string }>(table: T): T {
    const name = this.record?.name
    return name ? { ...table, clubName: name } : table
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
      // A club never opened or suspended answers nothing else (e12-t05, e12-t06)
      const closed = this.closedBecause()
      if (closed) throw closed
      response = await this.route(request, url)
    } catch (error) {
      code = error instanceof AppError ? error.code : 'serverError'
      response = errorResponse(error, this.log)
    }
    this.service.logEntry({ event: 'http', method: request.method, path: url.pathname, status: response.status, ms: Date.now() - started, ...(code ? { code } : {}) })
    await this.edgePass(request, url, response)
    this.deviceId(request, url, response)
    return response
  }

  /**
   * Gives a signed-in browser without one its `tbt_device` id (e11-t25) with its next `/api/me`, so
   * browsers signed in before the report existed get one without signing in again
   */
  private deviceId(request: Request, url: URL, response: Response) {
    if (url.pathname !== '/api/me' || !response.ok) return
    const cookies = request.headers.get('Cookie')
    if (!readCookie(cookies, sessionCookieName(this.clubId)) || validDevice(readCookie(cookies, DEVICE_COOKIE))) return
    try {
      response.headers.append('Set-Cookie', deviceCookie(randomId(12), url.protocol === 'https:'))
    } catch {
      // An answer whose headers cannot change (none of ours): the next one tries again
    }
  }

  /**
   * Notes where a member signed in or connected from (the anti-cheating report, e11-t25): the
   * address's hash and the browser's id. A sign-in from a browser with no id gets one: its cookie
   */
  private async sighting(request: Request, userId: string, secure: boolean, fresh = false): Promise<string[]> {
    const had = readCookie(request.headers.get('Cookie'), DEVICE_COOKIE)
    const device = validDevice(had) ? had! : fresh ? randomId(12) : ''
    await this.service.noteSighting(
      userId,
      request.headers.get('CF-Connecting-IP') ?? '',
      device,
      deviceLabel(request.headers.get('User-Agent')),
    )
    return device && device !== had ? [deviceCookie(device, secure)] : []
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
    const token = readCookie(cookies, sessionCookieName(this.clubId))
    const pass = readCookie(cookies, passCookieName(this.clubId))
    if (!token && !pass) return
    try {
      if (!(await passNeedsRefresh(secret, pass, Date.now(), this.clubId))) return
      const who = await this.service.passIdentity(token)
      const secure = url.protocol === 'https:'
      if (who) response.headers.append('Set-Cookie', passCookie(await mintPass(secret, who.userId, who.sessionId, Date.now(), this.clubId), secure, this.clubId))
      else if (pass) response.headers.append('Set-Cookie', passCookie('', secure, this.clubId))
    } catch (error) {
      // An answer whose headers cannot change (none of ours): the Worker asks the club instead
      this.log(crashEntry('edgePass', error))
    }
  }

  /** The cookies of a sign-in: the session, and its first edge pass when passes are on */
  private async signedIn(token: string, userId: string, secure: boolean): Promise<string[]> {
    const cookies = [sessionCookie(token, secure, this.clubId)]
    const who = this.edgeSecret ? await this.service.passIdentity(token) : null
    if (who?.userId === userId) cookies.push(passCookie(await mintPass(this.edgeSecret!, userId, who.sessionId, Date.now(), this.clubId), secure, this.clubId))
    return cookies
  }

  /** A provider's flow cookie in this club (e12-t04): each club's flow is its own */
  private readonly flowCookie = (name: OAuthName, id: string, secure: boolean, maxAgeMs?: number) =>
    flowCookie(name, id, secure, maxAgeMs, this.clubId)

  /**
   * Where a flow started on this site goes back to (e12-t04): a page of this club, whatever path
   * the page sent; 淡江橋館's paths are its own and stay as they are
   */
  private inClub(site: 'table' | 'book', path: string): string {
    if (site === 'book' || this.clubId === DEFAULT_CLUB_ID) return path
    return clubOfPath(path)?.clubId === this.clubId ? path : clubPath(this.clubId, path)
  }

  /**
   * Google sign-in's and LINE login's routes that need no session (e1-t31, e1-t32), for provider
   * `name`. The page sends its own origin, which must be this Worker's or 淡江橋館's (`oauthSite`):
   * the callback, and so the cookies, stay on that site. The callback answers with a redirect to a
   * path on the same site (relative, so it stays on 淡江橋館 when Vercel passed it here): the place
   * the member was, the code step, the application form or an error code for the page to show
   */
  private async oauthApi(name: OAuthName, request: Request, url: URL, route: string, token: string | null, body: () => Promise<Body>) {
    const secure = url.protocol === 'https:'
    const flowId = readCookie(request.headers.get('Cookie'), flowCookieName(name, this.clubId))
    const flowCookie = this.flowCookie
    const base = `/api/auth/${name}`
    if (route === `GET ${base}`) return json(this.service.oauthStatus(name))
    if (route === `POST ${base}/start`) {
      const b = await body()
      const site = oauthSite(text(b.origin), url)
      if (!site) throw new ClubError(`${name}Off`, {}, 403)
      const address = request.headers.get('CF-Connecting-IP') ?? ''
      const { url: to, flowId: id } = await this.service.startOAuth(
        name,
        `${site.origin}${callbackPath(name, this.clubId)}`,
        site.site,
        this.inClub(site.site, safeReturn(b.returnTo)),
        address,
      )
      return json({ url: to }, 200, flowCookie(name, id, secure))
    }
    if (route === `GET ${base}/callback`) {
      const params = url.searchParams
      const query = { state: params.get('state') ?? '', code: params.get('code') ?? '', error: params.get('error') ?? '' }
      const sessionUser = (await this.service.userForToken(token))?.id ?? null
      let outcome: OAuthOutcome
      try {
        outcome = await this.service.finishOAuth(name, flowId, query, sessionUser, request.headers.get('User-Agent') ?? '')
      } catch (error) {
        // The provider switched off between the start and the way back
        if (!(error instanceof AppError)) throw error
        outcome = { kind: 'failed', code: `${name}Off`, link: false, site: 'table' }
      }
      return this.oauthRedirect(name, request, outcome, secure)
    }
    if (route === `GET ${base}/pending`) return json(await this.service.oauthPending(name, flowId))
    if (route === `POST ${base}/code`) {
      const b = await body()
      const { user, token: newToken, returnTo } = await this.service.finishOAuthCode(
        name,
        flowId,
        text(b.code),
        request.headers.get('CF-Connecting-IP') ?? '',
        request.headers.get('User-Agent') ?? '',
        b.lang,
      )
      const device = await this.sighting(request, user.id, secure, true)
      return json({ user, returnTo }, 200, ...(await this.signedIn(newToken, user.id, secure)), ...device, flowCookie(name, '', secure))
    }
    return null
  }

  /**
   * Where a Google or LINE callback sends the browser, with the cookies it ends with. The page
   * learns what happened from `?<provider>=code|apply|linked|error&code=…`
   */
  private async oauthRedirect(name: OAuthName, request: Request, outcome: OAuthOutcome, secure: boolean): Promise<Response> {
    // 淡江牌桌 shows its sign-in page on any path when signed out (another club's at its own
    // address, e12-t04); 淡江橋館's is /login
    const table = (path: string) => (outcome.site === 'book' ? path : clubPath(this.clubId, path))
    const signIn = outcome.site === 'book' ? '/login' : table('/')
    const flowCookie = this.flowCookie
    const headers = new Headers({ 'Cache-Control': 'no-store' })
    let location: string
    let cookies: string[]
    switch (outcome.kind) {
      case 'signedIn': {
        location = safeReturn(outcome.returnTo)
        const device = await this.sighting(request, outcome.user.id, secure, true)
        cookies = [...(await this.signedIn(outcome.token, outcome.user.id, secure)), ...device, flowCookie(name, '', secure)]
        break
      }
      case 'code':
        location = `${signIn}?${name}=code`
        cookies = [flowCookie(name, outcome.flowId, secure, OAUTH_CODE_MS)]
        break
      case 'apply':
        location = `${signIn}?${name}=apply`
        cookies = [flowCookie(name, outcome.flowId, secure, OAUTH_APPLY_MS)]
        break
      case 'linked':
        location = table(`/account?${name}=linked`)
        cookies = [flowCookie(name, '', secure)]
        break
      default:
        location = `${outcome.link ? table('/account') : signIn}?${name}=error&code=${outcome.code}`
        cookies = [flowCookie(name, '', secure)]
    }
    headers.set('Location', location)
    for (const cookie of cookies) headers.append('Set-Cookie', cookie)
    return new Response(null, { status: 302, headers })
  }

  private async route(request: Request, url: URL): Promise<Response> {
    const token = readCookie(request.headers.get('Cookie'), sessionCookieName(this.clubId))
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
      const tooLarge = () => new ClubError('badFile', { max: IMPORT_LIMITS.pdfMb }, 413)
      const form = await readForm(request, IMPORT_BODY_MAX_BYTES, tooLarge).catch((error: unknown) => {
        if (error instanceof ClubError) throw error
        return null
      })
      const { ticket, request: job } = importRequestFrom(form)
      this.service.requirePermission(await this.book.useTicket(ticket), 'bookImport')
      if (!this.env.ANTHROPIC_API_KEY) throw new ClubError('importOff', {}, 503)
      const importer = claudeImporter(this.env.ANTHROPIC_API_KEY, this.env.IMPORT_MODEL || undefined, this.env.ANTHROPIC_BASE_URL || undefined)
      const upstream = await importer(job)
      response = new Response(upstream.body, {
        headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' },
      })
    } catch (error) {
      response = errorResponse(error, this.log)
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
      response = errorResponse(error, this.log)
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
    await this.sighting(request, user.id, false)
    return new Response(null, { status: 101, webSocket: client })
  }

  /** `/api/platform/*` (e12-t05): the clubs and their usage, the applications, suspending */
  private async platformApi(request: Request, url: URL, user: Me, body: () => Promise<Body>) {
    const owner = requirePlatformOwner(user, this.env.PLATFORM_OWNER, this.clubId)
    const platform = this.platform()
    const route = `${request.method} ${url.pathname}`
    if (route === 'GET /api/platform') return json(await platform.view())
    const decision = /^POST \/api\/platform\/applications\/([\w-]+)\/(approve|reject)$/.exec(route)
    if (decision) {
      if (decision[2] === 'approve') return json(await platform.approve(owner, decision[1], url.origin))
      return json(await platform.reject(owner, decision[1], (await body()).note))
    }
    const status = /^POST \/api\/platform\/clubs\/([\w-]+)\/status$/.exec(route)
    if (status) {
      const b = await body()
      return json(await platform.setStatus(owner, status[1], b.status, b.note))
    }
    throw new ClubError('noSuchApi', {}, 404)
  }

  private async api(request: Request, url: URL, token: string | null) {
    const secure = url.protocol === 'https:'
    const route = `${request.method} ${url.pathname}`
    const tooLarge = () => new ClubError('messageTooLarge', {}, 413)
    const body = async () => {
      return (await readJson(request, BODY_MAX_BYTES, tooLarge)) as Body
    }

    if (route === 'GET /api/health') return json(this.service.status())
    if (route === 'POST /api/client-errors') {
      // Reports come before sign-in too, so this needs none; the service cleans and rate-limits them
      if (!this.service.reportClientError(await readText(request, CLIENT_ERROR_MAX_CHARS * 4, tooLarge))) throw new ClubError('badMessage')
      return new Response(null, { status: 204 })
    }
    // BridgeHall's error reports and usage counts (e10-t06, e10-t07): no sign-in, and who is signed in
    // is never read; over the rate (or with counting off) they are dropped and still answered 204
    if (route === 'POST /api/book/errors' || route === 'POST /api/book/events') {
      const max = route === 'POST /api/book/errors' ? CLIENT_ERROR_MAX_CHARS : BOOK_EVENTS_MAX_CHARS
      const raw = await readText(request, max * 4, () => new ClubError('messageTooLarge'))
      const ok = route === 'POST /api/book/errors' ? this.telemetry.report(raw) : this.telemetry.record(raw)
      if (!ok) throw new ClubError('badMessage')
      return new Response(null, { status: 204 })
    }
    // What 申請加入 needs before it is sent (e1-t33): Turnstile's site key, or null when it is off
    if (route === 'GET /api/register/options') {
      return json({ turnstileSiteKey: turnstileKeys(this.env)?.siteKey ?? null } satisfies RegisterOptions)
    }
    if (route === 'POST /api/register') {
      const b = await body()
      const address = request.headers.get('CF-Connecting-IP') ?? ''
      const turnstile = turnstileKeys(this.env)
      if (turnstile) await requireTurnstile(turnstile.secret, text(b.turnstileToken), address, this.log)
      // Applying with Google or LINE (e1-t31, e1-t32): `google: true` or `line: true` uses the flow the
      // callback left in this browser's cookie
      const via: OAuthName | undefined = b.google === true ? 'google' : b.line === true ? 'line' : undefined
      const oauth = via && { name: via, flow: readCookie(request.headers.get('Cookie'), flowCookieName(via, this.clubId)) }
      const result = await this.service.register(
        text(b.username),
        text(b.password),
        text(b.inviteCode),
        text(b.note),
        b.site === 'book' ? 'book' : 'table',
        request.headers.get('User-Agent') ?? '',
        address,
        { oauth, displayName: b.displayName },
      )
      const cleared = via ? [this.flowCookie(via, '', secure)] : []
      if ('pending' in result) return json(result, 202, ...cleared)
      const device = await this.sighting(request, result.user.id, secure, true)
      return json({ user: result.user }, 200, ...(await this.signedIn(result.token, result.user.id, secure)), ...device, ...cleared)
    }
    // `code` is the second step (兩步驟登入, e11-t31), only for accounts that turned it on: without
    // it they get 401 twoFactorNeeded and send the same request again with it. Everyone else's
    // request and answer are as before (TKU BridgeHall signs in here too)
    if (route === 'POST /api/login') {
      const b = await body()
      const { user, token: newToken } = await this.service.login(
        text(b.username),
        text(b.password),
        request.headers.get('CF-Connecting-IP') ?? '',
        request.headers.get('User-Agent') ?? '',
        text(b.code),
        b.lang,
      )
      const device = await this.sighting(request, user.id, secure, true)
      return json({ user }, 200, ...(await this.signedIn(newToken, user.id, secure)), ...device)
    }
    // Google sign-in and LINE login (e1-t31, e1-t32, worker/oauth.ts): whether each is on, the way to
    // the provider and back, the code step for 兩步驟登入 and what the sign-in page should show after coming back
    const provider = /^\/api\/auth\/(google|line)(\/|$)/.exec(url.pathname)?.[1] as OAuthName | undefined
    if (provider) {
      const answer = await this.oauthApi(provider, request, url, route, token, body)
      if (answer) return answer
    }
    if (route === 'POST /api/logout') {
      if (token) await this.service.logout(token)
      return json({ ok: true }, 200, sessionCookie('', secure, this.clubId), passCookie('', secure, this.clubId))
    }
    // 忘記密碼 (e1-t36): ask with the invite code, an admin approves, the code they hand over sets the password
    if (route === 'POST /api/password/reset/request') {
      const b = await body()
      await this.service.requestPasswordReset(text(b.username), text(b.inviteCode))
      return json({ ok: true })
    }
    if (route === 'POST /api/password/reset') {
      const b = await body()
      const address = request.headers.get('CF-Connecting-IP') ?? ''
      await this.service.resetForgottenPassword(text(b.username), text(b.code), text(b.password), address)
      return json({ ok: true })
    }
    // Email (e1-t29, e1-t30): whether it is on, a verification link, and 忘記密碼 by a link mailed
    // to the verified address. No sign-in: the links are the proof, and asking says nothing about
    // whether the account or the address exists
    if (route === 'GET /api/email') return json(this.service.emailStatus())
    if (route === 'POST /api/email/verify') return json(await this.service.verifyEmail(text((await body()).token)))
    if (route === 'POST /api/email/reset/request') {
      const b = await body()
      const address = request.headers.get('CF-Connecting-IP') ?? ''
      await this.service.requestEmailReset(text(b.account), url.origin, b.lang, address)
      return json({ ok: true })
    }
    if (route === 'POST /api/email/reset') {
      const b = await body()
      const address = request.headers.get('CF-Connecting-IP') ?? ''
      return json(await this.service.resetPasswordByEmail(text(b.token), text(b.password), address))
    }
    // A picture by its signed address (e11-t02): the signature is the check, so no sign-in
    if (request.method === 'GET' && url.pathname.startsWith(FILES_PATH)) {
      return this.files.serve(decodeURIComponent(url.pathname.slice(FILES_PATH.length)), url)
    }

    // Applying for a new club (e12-t06): 淡江's object only (another club's refuses), no sign-in, open once the platform has an owner
    if (url.pathname === CLUB_APPLY_API) {
      requireApplyClub(this.clubId)
      const open = !!this.env.PLATFORM_OWNER
      const turnstile = turnstileKeys(this.env)
      if (request.method === 'GET') return json({ open, turnstileSiteKey: turnstile?.siteKey ?? null } satisfies ClubApplyOptions)
      if (request.method === 'POST') {
        if (!open) throw new ClubError('clubApplyClosed', {}, 403)
        const b = await body()
        const address = request.headers.get('CF-Connecting-IP') ?? ''
        if (turnstile) await requireTurnstile(turnstile.secret, text(b.turnstileToken), address, this.log)
        return json(await this.platform().apply(b, address), 202)
      }
    }

    // The owner's two-step sign-in reset (DEPLOY.md §4.15): only with TWO_FACTOR_RESET_TOKEN, which
    // exists only while the owner has set it with wrangler; without it (or with a wrong one) the route
    // is answered as if it were not there
    if (route === 'POST /api/ops/two-factor-reset') {
      if (!(await seedTokenMatches(request, this.env.TWO_FACTOR_RESET_TOKEN))) throw new ClubError('noSuchApi', {}, 404)
      return json(await this.service.ownerResetTwoFactor(text((await body()).username)))
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
    // A board's public link (e4-t38): anyone, signed in or not; rate-limited per address (worker/board-shares.ts)
    const shareLink = url.pathname.match(/^\/api\/share\/([\w-]+)$/)
    if (request.method === 'GET' && shareLink) {
      const response = json({ shared: await this.service.shares.open(shareLink[1], request.headers.get('CF-Connecting-IP') ?? '') })
      response.headers.set('X-Robots-Tag', 'noindex')
      return response
    }
    // The club's system card (e5-t52): before the sign-in check, so the signed-out and other clubs get
    // the same not-found answer
    const tkuCard = tkuCardResponse(request.method, url.pathname, this.clubId, user, tkuSystemCard)
    if (tkuCard) return tkuCard
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
    // The platform's back office (e12-t05): the owner only; for anyone else (and on any club but 淡江) there is none
    if (url.pathname === '/api/platform' || url.pathname.startsWith('/api/platform/')) return this.platformApi(request, url, user, body)
    if (url.pathname.startsWith('/api/book/')) return this.bookApi(request, url, user, body)
    if (url.pathname.startsWith('/api/club/')) return this.clubApi(request, url, user, body)
    if (url.pathname.startsWith('/api/forum/')) return this.forumApi(request, url, user, body)
    if (route === 'POST /api/account/password') {
      const b = await body()
      await this.service.changePassword(user.id, text(b.current), text(b.next), token)
      return json({ ok: true })
    }
    // The member's email (e1-t29): bind or change it (a link goes to it), remove it, or resend the link
    if (route === 'POST /api/account/email') {
      const b = await body()
      return json({ user: await this.service.setEmail(user.id, text(b.address), text(b.password), url.origin, b.lang) })
    }
    if (route === 'POST /api/account/email/resend') {
      return json({ user: await this.service.resendEmailVerification(user.id, url.origin, (await body()).lang) })
    }
    // Google sign-in and LINE login (e1-t31, e1-t32): binding asks for the password again, then goes to
    // the provider; unbinding asks for it too
    const bound = /^POST \/api\/account\/(google|line)\/(link|unlink)$/.exec(route)
    if (bound) {
      const name = bound[1] as OAuthName
      const b = await body()
      if (bound[2] === 'unlink') return json({ user: await this.service.unlinkOAuth(name, user.id, text(b.password)) })
      const site = oauthSite(text(b.origin), url)
      if (!site) throw new ClubError(`${name}Off`, {}, 403)
      const address = request.headers.get('CF-Connecting-IP') ?? ''
      const { url: to, flowId } = await this.service.startOAuth(name, `${site.origin}${callbackPath(name, this.clubId)}`, site.site, this.inClub(site.site, '/account'), address, {
        userId: user.id,
        password: text(b.password),
      })
      return json({ url: to }, 200, this.flowCookie(name, flowId, secure))
    }
    // Push notifications (e1-t28, worker/push.ts): this member's devices and choices; off without the VAPID secrets
    if (url.pathname.startsWith('/api/push')) {
      const push = this.service.push
      if (route === 'GET /api/push') return json(await push.view(user.id))
      if (route === 'POST /api/push/subscribe') return json(await push.subscribe(user.id, await body(), request.headers.get('User-Agent') ?? ''))
      if (route === 'POST /api/push/unsubscribe') return json(await push.unsubscribe(user.id, text((await body()).id)))
      if (route === 'POST /api/push/kinds') return json(await push.setKinds(user.id, (await body()).kinds))
      if (route === 'POST /api/push/test') {
        const id = (await body()).id
        return json({ devices: await push.test(user.id, typeof id === 'string' && id ? id : undefined) })
      }
    }
    // 兩步驟登入 (e11-t31): a secret to set up (admins), its first code turns it on, new recovery codes, off
    if (route === 'POST /api/account/2fa/setup') return json(await this.service.startTwoFactor(user.id, text((await body()).password)))
    if (route === 'POST /api/account/2fa/enable') return json(await this.service.enableTwoFactor(user.id, text((await body()).code), token))
    if (route === 'POST /api/account/2fa/recovery') {
      const b = await body()
      return json(await this.service.renewRecoveryCodes(user.id, text(b.password), text(b.code)))
    }
    if (route === 'POST /api/account/2fa/disable') {
      const b = await body()
      return json({ user: await this.service.disableTwoFactor(user.id, text(b.password), text(b.code), b.lang) })
    }
    // Where the member is signed in, and signing other devices out (e11-t23)
    if (route === 'GET /api/account/sessions') return json({ sessions: await this.service.accountSessions(user.id, token) })
    if (route === 'POST /api/account/sessions/others') return json({ ended: await this.service.endOtherSessions(user.id, token) })
    const session = url.pathname.match(/^\/api\/account\/sessions\/([\w-]+)$/)
    if (request.method === 'DELETE' && session) {
      await this.service.endSession(user.id, token, session[1])
      return json({ ok: true })
    }
    // The member's own data, and deleting their account (e11-t27)
    if (route === 'GET /api/account/export') {
      // With the pictures they uploaded (e13-t13): keys, types and sizes, not the bytes
      const data = { ...(await this.service.exportAccount(user.id, token)), files: await this.files.ownedBy(user.id) }
      return new Response(JSON.stringify(data, null, 2), {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="tku-bridge-table-${user.id}.json"`,
          'Cache-Control': 'no-store',
        },
      })
    }
    if (route === 'POST /api/account/delete') {
      await this.service.deleteOwnAccount(user.id, text((await body()).password))
      return json({ ok: true }, 200, sessionCookie('', secure, this.clubId), passCookie('', secure, this.clubId))
    }
    if (route === 'POST /api/account/preferences') {
      const b = await body()
      return json({ user: await this.service.setAccountPreferences(user.id, {
          friendOnlineNotice: b.friendOnlineNotice,
          bookAdoptedNotice: b.bookAdoptedNotice,
          bookProfile: b.bookProfile,
          robotSpeed: b.robotSpeed,
          profileBoards: b.profileBoards,
          profilePosts: b.profilePosts,
        }) })
    }
    if (route === 'PATCH /api/account/profile') return json({ user: await this.service.setProfile(user.id, await body()) })
    // The member's own picture (e1-t34): the bytes as the browser cropped and shrank them
    if (route === 'PUT /api/account/avatar') return json({ user: await this.service.setAvatar(user.id, await readAvatarUpload(request)) })
    if (route === 'DELETE /api/account/avatar') return json({ user: await this.service.deleteAvatar(user.id) })
    // Pictures for posts and articles (e11-t02): a pass to upload one, fresh addresses, removing one
    if (route === 'POST /api/files/ticket') return json(await this.files.createTicket(user.id, await body()))
    // A forum picture only for its uploader or a reader of a post using it (e13-t13)
    if (route === 'POST /api/files/urls') return json(await signFiles(this.files, this.forum, user, (await body()).keys))
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
    if (request.method === 'GET' && member)
      // `hidden`: what the member keeps off their page for this viewer (e13-t08); BridgeHall reads only `member`
      return json({ member: await this.service.memberProfile(user.id, member[1]), hidden: this.service.profileHidden(user.id, member[1]) })
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
    // The records page's search as one PBN file (e4-t36): its first LIMITS.exportBoardsMax boards
    if (route === 'GET /api/history/export.pbn') {
      const { records, total } = await this.service.exportBoards(user.id, parseHistoryQuery(url.searchParams))
      return textFile(toPbnFile(records), `tku-records-${records.length}.pbn`, { 'X-Boards-Total': String(total) })
    }
    const record = url.pathname.match(/^\/api\/history\/([\w-]+)$/)
    if (request.method === 'GET' && record) {
      const found = await this.service.record(record[1], user.id)
      if (!found) throw new ClubError('boardGone', {}, 404)
      return json({ record: found })
    }
    // A board's whole session at its table as one LIN file (e4-t37)
    const sessionLin = url.pathname.match(/^\/api\/history\/([\w-]+)\/session\.lin$/)
    if (request.method === 'GET' && sessionLin) {
      const records = await this.service.session(sessionLin[1], user.id)
      if (!records) throw new ClubError('boardGone', {}, 404)
      const first = records[0]
      const place = first.mode === 'practice' ? 'Practice' : `Table ${first.tableNumber}`
      return textFile(toSessionLin(records, `TKU BridgeTable ${place}`), `tku-session-${sessionLin[1]}.lin`)
    }
    // A board's public link (e4-t38): its players and the admins see it, make it and take it back
    const share = url.pathname.match(/^\/api\/history\/([\w-]+)\/share$/)
    if (share && request.method === 'GET') return json({ share: await this.service.shares.get(user.id, share[1]) })
    if (share && request.method === 'POST') return json({ share: await this.service.shares.create(user.id, share[1]) })
    if (share && request.method === 'DELETE') {
      await this.service.shares.revoke(user.id, share[1])
      return json({ ok: true })
    }
    // A director's ruling on a board (e2-t35): `{ ruling }`, null to take one back; the record comes back
    const ruling = url.pathname.match(/^\/api\/history\/([\w-]+)\/ruling$/)
    if (request.method === 'POST' && ruling) {
      const b = (await body()) as { ruling?: unknown }
      return json({ record: await this.service.ruleBoard(user.id, ruling[1], b.ruling ?? null) })
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
    // Partner bidding practice (e10-t08): only the session's two members, as worker/views.ts lets each see it
    if (route === 'GET /api/partner-bidding') return json({ sessions: this.service.partnerBids.list(user.id) })
    if (route === 'POST /api/partner-bidding') return json({ session: await this.service.partnerBids.create(user.id, await body()) })
    const partnerBid = url.pathname.match(/^\/api\/partner-bidding\/([\w-]+)(?:\/(answer|call|abandon))?$/)
    if (partnerBid && request.method === 'GET' && !partnerBid[2]) return json({ session: this.service.partnerBids.get(user.id, partnerBid[1]) })
    if (partnerBid && request.method === 'POST' && partnerBid[2] === 'answer') {
      const b = await body()
      return json({ session: await this.service.partnerBids.answer(user.id, partnerBid[1], b.accept) })
    }
    if (partnerBid && request.method === 'POST' && partnerBid[2] === 'call') {
      const b = await body()
      return json({ session: await this.service.partnerBids.call(user.id, partnerBid[1], b.call) })
    }
    if (partnerBid && request.method === 'POST' && partnerBid[2] === 'abandon')
      return json({ session: await this.service.partnerBids.abandon(user.id, partnerBid[1]) })
    if (route === 'GET /api/challenges') return json({ challenges: this.service.challengeList(user.id) })
    // The daily club event's page (e9-t03): today's, yesterday's and the earlier days
    if (route === 'GET /api/daily') return json({ daily: this.service.dailyEvent(user.id) })
    // Club points and ratings (J2, ARCHITECTURE.md §5.21); the service checks the flag and who may
    if (route === 'GET /api/rankings') return json({ board: this.service.rankings.leaderboard(user.id, url.searchParams) })
    if (route === 'GET /api/rankings/ledger')
      return json({ entries: this.service.rankings.memberLedger(user.id, url.searchParams) })
    if (route === 'POST /api/rankings/rules') return json({ rules: await this.service.rankings.adminSetRules(user.id, await body()) })
    if (route === 'POST /api/rankings/adjust') return json({ entry: this.service.rankings.adminAdjust(user.id, await body()) })
    if (route === 'POST /api/ratings/visibility')
      return json({ rating: this.service.rankings.setHidden(user.id, (await body()).hidden) })
    const rated = url.pathname.match(/^\/api\/ratings\/([\w-]+)$/)
    if (rated && request.method === 'GET') return json({ rating: this.service.rankings.rating(user.id, rated[1]) })
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
    // A member's challenge record (e7-t29): their own only
    if (route === 'GET /api/challenges/stats') return json({ stats: this.service.challengeExtras.stats(user.id) })
    // Each board's discussion thread (e7-t27); `challengeThreadAccess` decides who reads and writes
    const thread = url.pathname.match(/^\/api\/challenges\/([\w-]+)\/boards\/(\d+)\/comments(?:\/(\d+))?$/)
    if (thread) {
      const [, challengeId, seqText, commentId] = thread
      const seq = Number(seqText)
      const extras = this.service.challengeExtras
      if (request.method === 'GET' && !commentId) return json({ thread: extras.comments(challengeId, seq, user.id) })
      if (request.method === 'POST' && !commentId)
        return json({ thread: extras.addComment(challengeId, seq, user.id, (await body()).text) })
      if (request.method === 'DELETE' && commentId)
        return json({ thread: extras.removeComment(challengeId, seq, user.id, Number(commentId)) })
    }
    const challenge = url.pathname.match(/^\/api\/challenges\/([\w-]+)$/)
    if (request.method === 'GET' && challenge) {
      const found = await this.service.challengeDetail(challenge[1], user.id)
      if (!found) throw new ClubError('challengeGone', {}, 404)
      return json({ challenge: found })
    }
    // The tournament director's tools (e9-t17, §5.24): a board's score, a penalty, the start delayed, a table re-opened
    const referee = url.pathname.match(/^\/api\/referee\/(pairs|match|challenge)\/([\w-]+)$/)
    if (request.method === 'POST' && referee) {
      const done = await this.service.refereeAct(user.id, referee[1], referee[2], await body())
      // A table re-opened changes the lobby
      this.service.broadcast()
      return json(done)
    }
    // Pairs events (§5.22, e9-t10–e9-t13): the list, one event, and its actions
    if (route === 'GET /api/pairs') return json({ pairs: this.service.pairs.list(user.id) })
    if (route === 'POST /api/pairs') {
      // `format: 'individual'`: an individual event (e9-t15, §5.25)
      const b = await body()
      return json({ pairs: await this.service.pairs.create(user.id, b.settings, b.format) })
    }
    const pairsPage = url.pathname.match(/^\/api\/pairs\/([\w-]+)(?:\/(enter|withdraw|cancel|start))?$/)
    if (pairsPage) {
      const [, eventId, action] = pairsPage
      if (request.method === 'GET' && !action) return json({ pairs: this.service.pairs.view(eventId, user.id) })
      if (request.method === 'POST' && action) {
        const b = await body()
        const pairs = this.service.pairs
        if (action === 'enter') return json({ pairs: await pairs.enter(user.id, eventId, b.partner) })
        if (action === 'withdraw') return json({ pairs: await pairs.withdraw(user.id, eventId, b.userId) })
        if (action === 'cancel') return json({ pairs: await pairs.cancel(user.id, eventId) })
        const started = await pairs.start(user.id, eventId)
        this.service.broadcast()
        return json({ pairs: started })
      }
    }
    // Tournament announcements and entries (§5.24, e9-t16): admins announce, change, cancel and start; members enter
    const tournaments = this.service.tournaments
    if (route === 'GET /api/tournaments') return json({ tournaments: tournaments.list(user.id) })
    if (route === 'POST /api/tournaments') return json({ tournament: await tournaments.create(user.id, (await body()).settings) })
    const tournamentPage = url.pathname.match(/^\/api\/tournaments\/([\w-]+)(?:\/(settings|cancel|remove|enter|answer|withdraw|pairing|start))?$/)
    if (tournamentPage) {
      const [, id, action] = tournamentPage
      if (request.method === 'GET' && !action) return json({ tournament: tournaments.view(id, user.id) })
      if (request.method === 'POST' && action) {
        const b = await body()
        if (action === 'settings') return json({ tournament: await tournaments.update(user.id, id, b.settings) })
        if (action === 'cancel') return json({ tournament: await tournaments.cancel(user.id, id) })
        if (action === 'remove') return json({ tournament: await tournaments.remove(user.id, id, b.entryId) })
        if (action === 'enter') return json({ tournament: await tournaments.enter(user.id, id, { partners: b.partners, teamName: b.teamName }) })
        if (action === 'answer') return json({ tournament: await tournaments.answer(user.id, id, b.accept) })
        if (action === 'withdraw') return json({ tournament: await tournaments.withdraw(user.id, id) })
        if (action === 'pairing') return json({ tournament: await tournaments.setPairing(user.id, id, b.order) })
        return json({ tournament: await tournaments.start(user.id, id) })
      }
    }
    // Multi-team events (§5.26, e9-t14): made from a tournament; line-ups, the director's next round and cancel
    const teamEvent = url.pathname.match(/^\/api\/team-events\/([\w-]+)(?:\/(lineup|next|cancel))?$/)
    if (teamEvent) {
      const [, eventId, action] = teamEvent
      const events = this.service.teamEvents
      if (request.method === 'GET' && !action) return json({ event: events.view(eventId, user.id) })
      if (request.method === 'POST' && action) {
        const b = await body()
        if (action === 'lineup') return json({ event: await events.setLineup(user.id, eventId, b.team, b.players) })
        if (action === 'cancel') return json({ event: await events.cancel(user.id, eventId) })
        const next = await events.nextRound(user.id, eventId)
        this.service.broadcast()
        return json({ event: next })
      }
    }
    // Team matches (§5.8): set up (e8-t03), seated (e8-t04, e8-t05) and started (e8-t07) over HTTP
    if (route === 'GET /api/matches') return json({ matches: this.service.matches.list(user.id) })
    if (route === 'POST /api/matches') {
      const b = await body()
      return json({ match: await this.service.matches.create(user.id, { settings: b.settings, seat: b.seat }) })
    }
    // The Vugraph page (e8-t18): both rooms, the score and the watchers' chat; never for the match's players
    const vugraph = url.pathname.match(/^\/api\/matches\/([\w-]+)\/vugraph(\/chat)?$/)
    if (vugraph && request.method === 'GET' && !vugraph[2]) return json({ vugraph: await this.service.matchVugraph(user.id, vugraph[1]) })
    if (vugraph && request.method === 'POST' && vugraph[2])
      return json({ vugraph: await this.service.matchVugraphChat(user.id, vugraph[1], (await body()).text) })
    const matchAction = url.pathname.match(
      /^\/api\/matches\/([\w-]+)\/(settings|cancel|start|invite|answer|move|leave|clear|robot|rule|pause|abandon|replace|sitin|next)$/,
    )
    if (request.method === 'POST' && matchAction) {
      const [, matchId, action] = matchAction
      // While it is played (e8-t14–e8-t16): rulings, the pause, abandoning, substitutes, robots sitting in
      const play = { rule: 'matchRule', pause: 'matchPause', abandon: 'matchAbandon', replace: 'matchReplace', sitin: 'matchSitIn', next: 'matchNextSegment' } as const
      if (action in play) {
        const message = { ...(await body()), type: play[action as keyof typeof play], matchId } as MatchPlayAction
        return json({ match: await this.service.matchPlayRequest(user.id, message) })
      }
      if (action === 'settings') return json({ match: await this.service.matches.update(user.id, matchId, (await body()).settings) })
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
          bucket: this.backups(),
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
            if (tables.length) {
              this.forum.createTables()
              this.forumSchedule.load()
            }
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
    if (method === 'POST' && path === '/daily-event')
      return json({ daily: await this.service.adminSetDailyEvent(user.id, await body()) })
    if (method === 'GET' && path === '/settings') return json({ settings: this.service.clubSettings })
    // The anti-cheating report (e11-t25): admins only, checked again in the service
    if (method === 'GET' && path === '/integrity')
      return json({ report: await this.service.adminIntegrityReport(user.id, url.searchParams.get('days')) })
    // Feature flags (e11-t26): the club's state of each and the members who get it anyway
    if (method === 'GET' && path === '/features') return json({ features: this.service.adminFeatures() })
    if (method === 'POST' && path === '/features') return json({ features: await this.service.adminSetFeature(await body()) })
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
    // 忘記密碼 (e1-t36): approving answers the one-time code, for this admin to hand over
    const reset = path.match(/^\/users\/(\w+)\/password-reset$/)
    if (reset && (method === 'POST' || method === 'DELETE')) {
      const code = await this.service.adminAnswerPasswordReset(user.id, reset[1], method === 'POST')
      return json(code ?? { ok: true })
    }
    // 兩步驟登入 (e11-t31): turning off a member's second step, for one who lost the phone and the recovery codes
    const twoFactor = path.match(/^\/users\/(\w+)\/2fa$/)
    if (twoFactor && method === 'DELETE') {
      await this.service.adminClearTwoFactor(user.id, twoFactor[1])
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
    if (path === '/latest') return json(forum.latest(user))
    // My drafts and scheduled posts, and an officer's view of everyone's scheduled ones (e13-t12)
    if (path === '/drafts') return json(forum.unpublished(user))
    // The tags in use (the table's AC-13.7): the editor's suggestions and the tag filters
    if (path === '/tags') return json(forum.tags(user))
    // `&tag=` narrows a board, the feed and a search to the posts with that tag (AC-13.7)
    const tag = tagFilter(url.searchParams.get('tag'))
    if (path === '/feed') {
      // 我的貼文 and 我提到的 (BridgeHall e11-t10): one member's posts, or the posts mentioning one
      const member = (name: string) => url.searchParams.get(name)?.slice(0, 64) || undefined
      // Another member's posts on their profile page, unless they keep them off it (e13-t08)
      const author = member('author')
      if (author && this.service.profileHidden(user.id, author).posts) return json({ posts: [], page: 1, pages: 1 })
      return json(forum.feed(Number(url.searchParams.get('page') ?? 1), { author, mentions: member('mentions'), tag }, user))
    }
    // 搜尋 (BridgeHall e11-t10): titles and text blocks; `board` narrows it to one board (the table's e13-t11)
    if (path === '/search')
      return json(
        forum.search(url.searchParams.get('q'), Number(url.searchParams.get('page') ?? 1), {
          board: url.searchParams.get('board')?.slice(0, 64) || undefined,
          tag,
          viewer: user,
        }),
      )
    if (path === '/reports') {
      if (method === 'GET') return json({ reports: forum.reports(url.searchParams.get('status') === 'all' ? 'all' : 'open') })
      return json({ report: forum.fileReport(user, await body()) })
    }
    const report = path.match(/^\/reports\/([\w-]+)$/)
    if (report) {
      // A reported post removed takes its pictures with it (e13-t13)
      const asked = forum.report(report[1])
      const images = asked.target === 'post' ? this.postImagesOf(asked.targetId) : []
      const { report: handled, reported } = forum.decideReport(user, report[1], await body())
      if (handled.status === 'removed') await this.releasePostImages(images)
      const what = reported.authorId ? whose(reported.authorId, reported.excerpt ?? '') : ''
      const note = [what, `檢舉：${handled.reason}`].filter(Boolean).join('；')
      if (handled.status === 'dismissed') await audit('forum:dismiss', reported.postId ?? handled.targetId, note)
      else if (reported.postId)
        await audit(handled.target === 'post' ? 'forum:removePost' : 'forum:removeComment', reported.postId, note)
      return json({ report: handled })
    }
    const posts = path.match(/^\/boards\/([\w-]+)\/posts$/)
    if (posts) {
      if (method === 'GET') return json(forum.boardPage(posts[1], Number(url.searchParams.get('page') ?? 1), user, tag))
      const input = await body()
      // A board shared from the history (e13-t07): only one the whole club may see
      for (const id of addedRecordIds(input)) await this.service.checkShareable(user.id, id)
      // Only pictures the author uploaded (e13-t13)
      await checkImagesOwned(this.files, user.id, addedImageKeys(input))
      const post = forum.createPost(user, posts[1], input)
      // A draft or a scheduled post is told about once it is out (e13-t12)
      if (post.draft || post.publishAt !== undefined) this.forumSchedule.saved(post)
      else await tell(() => notices.posted(user, post, forum.board(post.boardId)))
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
    const postAction = path.match(/^\/posts\/([\w-]+)\/(pin|lock|hide|comments)$/)
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
      if (action === 'hide') {
        // An officer hides a post (the table's e13-t10); its open reports close with it, and its author is told (2026-11-02)
        const before = forum.post(id)
        const post = forum.setHidden(user, id, await body())
        if ((before.hidden === true) !== (post.hidden === true)) {
          await audit(post.hidden ? 'forum:hide' : 'forum:unhide', id, whose(post.authorId, postExcerpt(post)))
          await tell(() => notices.hidden(user, post))
        }
        return json({ post })
      }
      const comment = forum.addComment(user, id, await body())
      await tell(() => notices.commented(user, forum.post(id), comment, comment.parentId ? forum.comment(comment.parentId) : undefined))
      return json({ comment })
    }
    const post = path.match(/^\/posts\/([\w-]+)$/)
    if (post) {
      if (method === 'GET') return json(forum.thread(post[1], user))
      const before = forum.post(post[1])
      if (method === 'PATCH') {
        const input = await body()
        if (before.authorId === user.id) {
          for (const id of addedRecordIds(input, before.blocks)) await this.service.checkShareable(user.id, id)
          await checkImagesOwned(this.files, user.id, addedImageKeys(input, before.blocks))
        }
        const updated = forum.updatePost(user, post[1], input)
        const wasOut = !before.draft && before.publishAt === undefined
        const out = !updated.draft && updated.publishAt === undefined
        // A draft or a scheduled post put out now is told about as a new post (e13-t12); one still waiting is not told about yet
        if (wasOut) await tell(() => notices.edited(user, updated, before.mentions ?? []))
        else if (out) await tell(() => notices.posted(user, updated, forum.board(updated.boardId)))
        else this.forumSchedule.saved(updated)
        // A picture edited out of the post goes from R2 unless another post uses it (e13-t13)
        await this.releasePostImages(droppedImageKeys(before.blocks, updated.blocks))
        return json({ post: updated })
      }
      forum.deletePost(user, post[1])
      if (before.authorId !== user.id) await audit('forum:removePost', post[1], whose(before.authorId, postExcerpt(before)))
      await this.releasePostImages(postImageKeys(before.blocks))
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
  /** A post's pictures, none when it is gone */
  private postImagesOf(postId: string): string[] {
    try {
      return postImageKeys(this.forum.post(postId).blocks)
    } catch {
      return []
    }
  }

  /** Pictures no post uses any more go from R2 (e13-t13); a failure only leaves them there, never fails the answer */
  private async releasePostImages(keys: readonly string[]) {
    if (keys.length) await this.tell(async () => void (await releaseImages(this.files, this.forum, keys)), 'forumImages')
  }

  /** Sends the handbook's notifications (e8-t10); what was saved stays saved when they fail */
  private async tell(send: () => Promise<void>, where = 'bookNotice') {
    try {
      await send()
    } catch (error) {
      this.log({ event: 'crash', where, error: error instanceof Error ? error.message : String(error) })
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

/** A `tbt_device` id as this club makes them (randomId), not whatever a browser sent */
const validDevice = (id: string | null) => !!id && /^[\w-]{8,64}$/.test(id)

function json(data: unknown, status = 200, ...cookies: string[]) {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  for (const cookie of cookies) headers.append('Set-Cookie', cookie)
  return new Response(JSON.stringify(data), { status, headers })
}

/** A text file to download (PBN, LIN): ASCII file names only, so no encoding is needed */
function textFile(text: string, name: string, headers: Record<string, string> = {}) {
  return new Response(text, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name.replace(/[^\w.-]/g, '_')}"`,
      'Cache-Control': 'no-store',
      ...headers,
    },
  })
}

function errorResponse(error: unknown, log: Logger) {
  if (error instanceof AppError) return json({ error: error.message, code: error.code, params: error.params }, error.status)
  log(crashEntry('http', error))
  return json({ error: '伺服器發生錯誤', code: 'serverError', params: {} }, 500)
}
