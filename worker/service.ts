import { secureRandomInt, type RandomInt } from '../shared/board.ts'
import { isSeat, SEATS, type Seat } from '../shared/cards.ts'
import { AppError, type MessageCode } from '../shared/messages.ts'
import {
  DEFAULT_TABLE_SETTINGS,
  HISTORY_PAGE_SIZES,
  isPermission,
  isRobotId,
  isTableAction,
  LIMITS,
  parseTableSettings,
  PERMISSIONS,
  robotId,
  soloTable,
  summarize,
  USERNAME_PATTERN,
  type AdminUser,
  type Application,
  type BoardRecord,
  type ClientMessage,
  type ClubSettings,
  type DirectPage,
  type DirectsView,
  type Favorite,
  type FavoritesPage,
  type FavoriteTag,
  type HistoryPage,
  type LiveMatch,
  type LobbyView,
  type Me,
  type MemberChange,
  type MemberStatus,
  type Permission,
  type PublicUser,
  type RobotKind,
  type ServerMessage,
  type Site,
  type TableAction,
  type TableMode,
  type TableSummary,
} from '../shared/protocol.ts'
import { dealWith } from '../shared/dealer.ts'
import { parsePracticeSettings, PRACTICE_MAX_ATTEMPTS, practiceConditions, quickRandom } from '../shared/practice.ts'
import type { RobotBrain } from '../shared/robot/brain.ts'
import { hashPassword, randomId, SESSION_DAYS, verifyPassword } from './auth.ts'
import { checkFavorite } from '../shared/favorites.ts'
import { DEFAULT_HISTORY_QUERY, type HistoryQuery } from '../shared/history-query.ts'
import {
  CHALLENGE_LIMITS,
  isOpenChallenge,
  parseChallengeSettings,
  scoringsFor,
  type ChallengeSettings,
  type ChallengeView,
} from '../shared/challenge.ts'
import { boardAsSouth, challengeDeals } from '../shared/challenge-deals.ts'
import {
  DEFAULT_WEEKLY_SCHEDULE,
  latestWeeklySlot,
  parseWeeklySchedule,
  type WeeklyChallengeView,
} from '../shared/weekly-challenge.ts'
import { dealSourceOf, makeDealSet, type DealSet, type DealSetBoard } from '../shared/deal-set.ts'
import { openingLead, type Traveller } from '../shared/traveller.ts'
import {
  answer,
  cancel,
  challengeTakesPart,
  deadlineOutcome,
  earlyFinish,
  newChallenge,
  nextChallengeTime,
  REMINDER_MS,
  remindWhom,
  type ChallengeChange,
} from './challenge-flow.ts'
import { ChallengeStore, type Challenge, type ChallengeResult } from './challenges.ts'
import { ClubError } from './errors.ts'
import { FeaturedService } from './featured.ts'
import { TeamMatchService, type MatchPlayAction } from './team-match-service.ts'
import type { RoomClock } from './team-match-flow.ts'
import { TeamMatchStore } from './team-matches.ts'
import { teamTable } from './team-mode.ts'
import { ROOMS, type Room, type TeamMatchView } from '../shared/team-match.ts'
import {
  createHistoryIndex,
  eventBoards,
  indexRecord,
  revealBoards,
  revealEvent,
  searchBoards,
  unindexRecord,
} from './history-index.ts'
import {
  challengeSnapshot,
  challengeStateOf,
  nextSeq,
  playedSeqs,
  type ChallengeTableState,
  type EventReport,
  type PracticeTableState,
} from './modes.ts'
import { DirectMessageStore } from './direct-messages.ts'
import {
  countFavorites,
  favoriteIds,
  favoritesAmong,
  favoriteTags,
  getFavorite,
  removeFavorite,
  removeFavoritesOf,
  saveFavorite,
} from './favorites.ts'
import { NotificationService } from './notifications.ts'
import { Relations } from './relations.ts'
import { AlarmQueue, manualScheduler, type JobKind, type Scheduler } from './scheduler.ts'
import { LocalTables, ROBOT_NAME, robotUser, TableService, type TableConfig, type TableStore } from './table-service.ts'
import type { ClubLink, Person, RemoteTables, TableEntry, Tables } from './tables.ts'
import { nextWeeklyRun, WEEKLY_KEY, type WeeklyState } from './weekly-challenge.ts'
import type { Store } from './store.ts'
import { parseClientMessage } from '../shared/message-guard.ts'
import { parseProfile, PROFILE_RECENT, type MemberProfile, type Profile } from '../shared/profile.ts'
import { lobbyOrder, quickSeatChoice } from '../shared/lobby.ts'
import { parseClientError } from './client-errors.ts'
import { crashEntry, noLog, type Logger } from './log.ts'
import {
  ACTION_BURST,
  ACTIONS_PER_SECOND,
  CHAT_BURST,
  CHATS_PER_SECOND,
  CLIENT_ERROR_BURST,
  CLIENT_ERRORS_PER_SECOND,
  DIRECT_BURST,
  DIRECTS_PER_SECOND,
  FailureWindow,
  FRIEND_ONLINE_QUIET_MS,
  LOGIN_FAILURES_PER_ADDRESS,
  LOGIN_FAILURES_PER_NAME,
  LOGIN_WINDOW_MS,
  TokenBuckets,
} from './rate-limit.ts'
import {
  challengeBoardVisible,
  challengeTraveller,
  challengeView,
  memberProfileView,
  recordVisible,
  seatOccupants,
  type Table,
} from './views.ts'

export { ClubError } from './errors.ts'

interface StoredUser {
  id: string
  username: string
  passwordHash: string
  createdAt: number
  lastLoginAt?: number
  admin?: boolean
  permissions?: Permission[]
  /** Set when the member reset a forgotten password themselves, so admins can see it */
  passwordResetAt?: number
  /** False when the member turned off the notice that a friend came online (e1-t24) */
  friendOnlineNotice?: boolean
  /** What the member tells the club about themselves (AC-1.5); others see it through `memberProfileView` */
  profile?: Profile
}

/** A registration waiting for approval: the account it becomes once an admin approves it */
interface StoredApplication {
  id: string
  username: string
  passwordHash: string
  note: string
  site: Site
  createdAt: number
}

interface Session {
  userId: string
  expires: number
}

/** Who is connected; the Durable Object implements it with its hibernatable WebSockets */
export interface Connections {
  onlineUserIds(): string[]
  send(userId: string, message: ServerMessage): void
  /** Closes every socket of a user (after their account is deleted) */
  disconnect(userId: string): void
}

export interface ClubConfig {
  /** Defaults from the Worker environment; an admin can override them (ClubSettings) */
  maxUsers: number
  inviteCode?: string
  now?: () => number
  random?: RandomInt
  /**
   * Asks to be woken at `at` (ms) to run the jobs that are due (`runDue`); the Durable Object sets
   * its storage alarm. Without it a timer is used
   */
  wake?: (at: number) => void
  /** Runs robot moves and the next deal after a pause instead of the alarm queue; tests pass a manual queue */
  schedule?: (run: () => void, ms: number, kind: ScheduleKind) => void
  /** What the robots think with; the rule robot unless a stronger brain is given */
  brain?: RobotBrain
  /** How long the brain may think before the rule robot answers instead (ms); THINK_LIMIT_MS unless a test sets it */
  thinkLimitMs?: number
  /** Where structured log entries go (`worker/log.ts`); nowhere unless given */
  log?: Logger
  /**
   * The tables in their own Durable Objects (`TableObject`, ARCHITECTURE.md §5.10). Without it they
   * run in this object (`LocalTables`, kept as `table:<id>`), as in most tests
   */
  tableObjects?: RemoteTables
  /**
   * Keeps the tables in this object even though `tableObjects` is given, and brings back any that
   * were moved out: the switch back (`TABLE_OBJECTS=off`, DEPLOY.md)
   */
  tablesInClub?: boolean
}

export type ScheduleKind = JobKind

/** 2: history indexes in KV (`hist:`, `uhist:`); 3: the SQL history index as well */
const SCHEMA = 3
/** 4: every table in its own `TableObject`, the club keeping only its directory (`tabledir:`, §5.10) */
const TABLES_SCHEMA = 4
/** How soon a table that could not be moved is tried again */
const MOVE_RETRY_MS = 60_000
/** Boards indexed per step of the backfill; the position is saved after each step */
const BACKFILL_BATCH = 100
/** How many closed tables the club remembers, to drop their reports that arrive late (§5.10) */
const CLOSED_KEPT = 200
/** The table actions only the host may take: outside any table they are `notAtTable`, not `notSeated` */
const HOST_ACTIONS = new Set<string>(['kick', 'addRobot', 'removeRobot', 'replaceWithRobot'])

/** The error for changing seats or settings at a table that is one member's alone (`soloTable`) */
const fixedTable = (mode: TableMode | undefined) =>
  new ClubError(mode === 'practice' ? 'practiceTableFixed' : 'challengeTableFixed')

/**
 * Accounts, the lobby and boards for one bridge club. All state lives in memory and every change is
 * written through to the store, so the Durable Object can be evicted and reloaded at any time.
 *
 * Each table runs on its own (`TableService`, ARCHITECTURE.md §5.10): the club keeps a directory of
 * them (`TableEntry`), moves people between them and keeps the boards they finish.
 *
 * History is kept as one key per board (`board:<id>`) plus two small, time-ordered indexes of
 * summaries (`hist:` for everyone, `uhist:<userId>:` per member), so listing a page of history
 * reads only that page no matter how many boards the club has played.
 */
/** Whether a match table's room moved on in a way the match page shows: its board, or whom robots sit in for */
const matchMoved = (before: TableEntry | undefined, after: TableEntry) =>
  !before ||
  before.boardNo !== after.boardNo ||
  before.playing !== after.playing ||
  before.match?.startedAt !== after.match?.startedAt ||
  JSON.stringify(before.substitutes) !== JSON.stringify(after.substitutes)

/** The challenge actions the pages send over HTTP (`ClubService.challengeRequest`) */
export type ChallengeRequest = Extract<
  ClientMessage,
  { type: 'createChallenge' | 'answerChallenge' | 'cancelChallenge' | 'rematchChallenge' }
>

export class ClubService {
  private users = new Map<string, StoredUser>()
  private applications = new Map<string, StoredApplication>()
  /** Every table as it last reported (§5.10): the lobby and moving between tables read only this */
  private readonly directory = new Map<string, TableEntry>()
  /** Tables that closed lately, so a report of theirs that arrives late is dropped */
  private readonly closedTables = new Set<string>()
  /** The tables themselves, each running on its own: its own Durable Object, or `LocalTables` in this one */
  readonly tables: Tables
  /** The tables when they run in this object */
  private readonly localTables?: LocalTables
  /** The tables when each is its own Durable Object (§5.10); the directory is then kept as `tabledir:` */
  private readonly remote?: RemoteTables
  /** What the tables tell the club (`ClubLink`); a `TableObject` calls it over RPC through `Club` */
  readonly link: ClubLink
  /** Each member's actions, one at a time (§5.10): the end of the last one queued */
  private readonly lanes = new Map<string, Promise<void>>()
  /** Club actions under way that may change several tables; the lobby goes out when they end */
  private busy = 0
  private settings: Partial<ClubSettings> = {}
  private readonly store: Store
  private readonly connections: Connections
  private readonly config: ClubConfig
  private readonly now: () => number
  private readonly random: RandomInt
  /** Jobs: every table's robot moves, deals and substitutes, challenge deadlines, the weekly challenge */
  private readonly scheduler: Scheduler
  /** The scheduler, when it is the alarm queue (not the tests' manual one) */
  private readonly queue?: AlarmQueue
  /**
   * What each member was last sent (as JSON), so an update that changes nothing for them is not
   * sent at all. `table` is the id of the table they were last at, or `null` once told they are at none
   */
  private readonly sent = new Map<string, { lobby?: string; table?: string; notifications?: string; directs?: string }>()
  /** The notification centre; other parts of the club call `notifications.notify` */
  readonly notifications: NotificationService
  /** Whom each member follows (好友) and whom they blocked (AC-1.6) */
  private readonly friends: Relations
  private readonly blocks: Relations
  /** Direct messages (AC-1.7), kept in SQL (§5.7) */
  private readonly directs: DirectMessageStore
  /** Members with an open socket as far as this object has seen, and when each was last announced to friends (e1-t24) */
  private readonly present = new Set<string>()
  private readonly announced = new Map<string, number>()
  /** Challenges, kept in SQL (§5.5); created and answered here, played in later batches */
  readonly challenges: ChallengeStore
  /** The weekly club challenge's schedule (`e7-t23`), null until an admin sets one */
  private weekly: WeeklyState | null = null
  /** Two-table team matches, kept in SQL (§5.7); set up over HTTP, played in later batches */
  readonly matches: TeamMatchService
  /** Featured boards (精選牌局, AC-4.5, §5.9) */
  readonly featured: FeaturedService
  private readonly log: Logger
  /** Rate limits (AC-11.7): messages and chat lines per member, wrong passwords, browser error reports */
  private readonly actionLimit: TokenBuckets
  private readonly chatLimit: TokenBuckets
  private readonly directLimit: TokenBuckets
  private readonly loginByName: FailureWindow
  private readonly loginByAddress: FailureWindow
  private readonly clientErrorLimit: TokenBuckets

  constructor(store: Store, connections: Connections, config: ClubConfig) {
    this.store = store
    this.connections = connections
    this.config = config
    this.now = config.now ?? Date.now
    this.log = config.log ?? noLog
    this.actionLimit = new TokenBuckets(ACTION_BURST, ACTIONS_PER_SECOND, this.now)
    this.chatLimit = new TokenBuckets(CHAT_BURST, CHATS_PER_SECOND, this.now)
    this.directLimit = new TokenBuckets(DIRECT_BURST, DIRECTS_PER_SECOND, this.now)
    this.loginByName = new FailureWindow(LOGIN_FAILURES_PER_NAME, LOGIN_WINDOW_MS, this.now)
    this.loginByAddress = new FailureWindow(LOGIN_FAILURES_PER_ADDRESS, LOGIN_WINDOW_MS, this.now)
    this.clientErrorLimit = new TokenBuckets(CLIENT_ERROR_BURST, CLIENT_ERRORS_PER_SECOND, this.now)
    this.random = config.random ?? secureRandomInt
    this.notifications = new NotificationService(store, this.now, (userId) => void this.pushNotifications(userId))
    this.friends = new Relations(store, 'friend', this.now)
    this.blocks = new Relations(store, 'block', this.now)
    this.challenges = new ChallengeStore(store.sql)
    this.matches = new TeamMatchService(new TeamMatchStore(store.sql), {
      now: this.now,
      newId: () => randomId(8),
      userById: (id) => this.publicUserById(id),
      takeAction: (id) => this.actionLimit.take(id),
      isMember: (id) => this.users.has(id),
      blocked: (by, other) => this.blocks.has(by, other),
      online: () => this.connections.onlineUserIds(),
      send: (id, message) => this.connections.send(id, message),
      notify: (id, kind, params) => this.notifications.notify(id, kind, params),
      watchers: (matchId) => this.matchWatchers(matchId),
      live: (matchId) => this.matchLive(matchId),
      boardDetails: (matchId) => eventBoards(this.store.sql, matchId),
    })
    this.featured = new FeaturedService(store, {
      now: this.now,
      userById: (id) => this.publicUserById(id),
      requireCurator: (id) => void this.requirePermission(id, 'boardCurate'),
      notify: (id, kind, params) => this.notifications.notify(id, kind, params),
      takeAction: (id) => this.actionLimit.take(id),
    })
    this.directs = new DirectMessageStore(store.sql)
    if (config.schedule) {
      this.scheduler = manualScheduler(config.schedule)
    } else {
      const wake = config.wake ?? ((at: number) => void setTimeout(() => void this.runDue(), Math.max(0, at - this.now())))
      this.scheduler = this.queue = new AlarmQueue(this.now, wake)
    }
    const link: ClubLink = {
      changed: (entry) => this.applyEntry(entry),
      closed: (tableId) => this.tableClosed(tableId),
      boardFinished: (record, event) => this.boardFinished(record, event),
    }
    this.link = link
    // Each table in its own Durable Object (H1b, §5.10), unless switched back into this one
    if (config.tableObjects && !config.tablesInClub) {
      this.tables = this.remote = config.tableObjects
      // An object that answers it has no table: the directory had missed its closing
      this.remote.onGone = (tableId) => this.tableClosed(tableId)
      return
    }
    // In this same object, kept in its storage as `table:<id>` (H1a, and the tests)
    const tableStore: TableStore = {
      save: (table) => store.put(`table:${table.id}`, table),
      remove: (tableId) => store.delete(`table:${tableId}`),
    }
    const tableConfig: TableConfig = {
      now: this.now,
      random: this.random,
      brain: config.brain,
      thinkLimitMs: config.thinkLimitMs,
      scheduler: this.scheduler,
    }
    this.tables = this.localTables = new LocalTables((id) => new TableService(id, tableStore, connections, link, tableConfig))
  }

  /** A table running in this object, while it is open (tests) */
  localTable(tableId: string): TableService | undefined {
    return this.localTables?.local(tableId)
  }

  /** Runs the robot moves and deals that are due (the Durable Object's alarm) */
  async runDue() {
    await this.queue?.runDue()
  }

  async load() {
    for (const user of (await this.store.list<StoredUser>('user:')).values()) this.users.set(user.id, user)
    for (const application of (await this.store.list<StoredApplication>('app:')).values())
      this.applications.set(application.id, application)
    await this.friends.load()
    await this.blocks.load()
    this.settings = (await this.store.get<Partial<ClubSettings>>('meta:settings')) ?? {}
    createHistoryIndex(this.store.sql)
    this.challenges.createTables()
    this.matches.store.createTables()
    this.directs.createTables()
    const schema = (await this.store.get<number>('meta:schema')) ?? 1
    if (schema < 2) await this.migrate()
    if (schema < 3) await this.backfillIndex()
    await this.ensureAdmin()
    await this.batch(async () => {
      if (this.remote) {
        // Each table runs in its own object and schedules its own jobs; the club only reads its directory
        for (const entry of (await this.store.list<TableEntry>('tabledir:')).values()) this.directory.set(entry.id, entry)
        await this.moveTablesOut()
        return
      }
      if (this.config.tableObjects) await this.bringTablesBack()
      // Each table takes its state back and schedules its own jobs (jobs are not stored)
      for (const stored of (await this.store.list<Table>('table:')).values()) await this.restoreLocal(stored)
    })
    // Jobs are not stored: each open challenge's reminder or deadline is scheduled again
    for (const id of this.challenges.openIds()) this.scheduleChallenge(id)
    this.weekly = (await this.store.get<WeeklyState>(WEEKLY_KEY)) ?? null
    this.scheduleWeekly()
  }

  /** A table kept in this object's storage takes its state back (brought up to date first) */
  private async restoreLocal(stored: Table) {
    const table = this.upgradeTable(stored)
    if (table !== stored) await this.store.put(`table:${table.id}`, table)
    this.applyEntry(await this.localTables!.get(table.id).restore(table))
  }

  /**
   * Version 4 (H1b, ARCHITECTURE.md §5.10): every table kept in the club's storage (`table:<id>`)
   * moves into its own `TableObject`. Per table: its object adopts it (saved there, its jobs
   * scheduled), then its directory entry is written (`tabledir:<id>`), then `table:<id>` is
   * deleted. So an object evicted halfway carries on where it stopped: a table adopted twice keeps
   * what its object has, one that closed meanwhile is only dropped. A table whose object fails
   * stays in `table:` and is tried again later; `meta:schema` becomes 4 once none is left
   */
  private async moveTablesOut() {
    const remote = this.remote!
    const stored = await this.store.list<Table>('table:')
    let failed = 0
    await Promise.all(
      [...stored].map(async ([key, saved]) => {
        try {
          const table = this.upgradeTable(saved)
          const entry = await remote.get(table.id).adopt(table)
          if (entry) {
            this.directory.set(entry.id, entry)
            await this.store.put(`tabledir:${entry.id}`, entry)
          }
          await this.store.delete(key)
        } catch (error) {
          failed++
          this.log(crashEntry('moveTablesOut', error))
        }
      }),
    )
    if (stored.size) this.log({ event: 'tablesMoved', to: 'objects', moved: stored.size - failed, failed })
    if (failed) {
      this.scheduler.add('migrate:tables', 'migrate', MOVE_RETRY_MS, async () => {
        await this.batch(() => this.moveTablesOut())
        this.broadcast()
      })
      return
    }
    if (((await this.store.get<number>('meta:schema')) ?? 1) < TABLES_SCHEMA) await this.store.put('meta:schema', TABLES_SCHEMA)
  }

  /**
   * The switch back (`TABLE_OBJECTS=off`, DEPLOY.md): every table in its own object comes back to
   * `table:<id>`, in the safe order the other way round: the object hands it over and keeps still,
   * the club saves it (unless it already has its own copy, which is newer), the object forgets it,
   * the directory entry goes. A table whose object fails stays there until the next load
   */
  private async bringTablesBack() {
    const objects = this.config.tableObjects!
    const entries = await this.store.list<TableEntry>('tabledir:')
    let failed = 0
    for (const key of entries.keys()) {
      const tableId = key.slice('tabledir:'.length)
      try {
        const table = await objects.handOver(tableId)
        if (table && !(await this.store.get(`table:${tableId}`))) await this.store.put(`table:${tableId}`, table)
        await objects.release(tableId)
        await this.store.delete(key)
      } catch (error) {
        failed++
        this.log(crashEntry('bringTablesBack', error))
      }
    }
    if (entries.size) this.log({ event: 'tablesMoved', to: 'club', moved: entries.size - failed, failed })
    if (!failed && (await this.store.get<number>('meta:schema')) === TABLES_SCHEMA) await this.store.put('meta:schema', SCHEMA)
  }

  /** Version 1 kept history as `board:<time>-<id>` only; build the indexes from it */
  private async migrate() {
    for (const [key, record] of await this.store.list<BoardRecord>('board:')) {
      if (!key.includes('-')) continue
      await this.saveRecord(record)
      await this.store.delete(key)
    }
    await this.store.put('meta:schema', 2)
  }

  /**
   * Version 3 adds the SQL history index: every `board:` record is indexed, a batch at a time. The
   * last key done is kept in `meta:backfill`, so an object evicted halfway carries on where it
   * stopped; indexing a board twice changes nothing
   */
  private async backfillIndex() {
    let after = await this.store.get<string>('meta:backfill')
    for (;;) {
      // `start` is inclusive: the key after `after` is `after` + the lowest character
      const batch = await this.store.list<BoardRecord>('board:', {
        limit: BACKFILL_BATCH,
        ...(after && { start: `${after}\0` }),
      })
      if (!batch.size) break
      for (const record of batch.values()) indexRecord(this.store.sql, record)
      after = [...batch.keys()].at(-1)!
      await this.store.put('meta:backfill', after)
    }
    await this.store.put('meta:schema', SCHEMA)
    await this.store.delete('meta:backfill')
  }

  /** A club always has an admin: if nobody is one, the oldest account becomes admin */
  private async ensureAdmin() {
    const members = [...this.users.values()]
    if (!members.length || members.some((u) => u.admin)) return
    const oldest = members.sort((a, b) => a.createdAt - b.createdAt)[0]
    oldest.admin = true
    await this.store.put(`user:${oldest.id}`, oldest)
  }

  // ── Settings ────────────────────────────────────────────────────────────────────────────────

  get clubSettings(): ClubSettings {
    return {
      maxUsers: this.settings.maxUsers ?? this.config.maxUsers,
      inviteCode: this.settings.inviteCode ?? this.config.inviteCode ?? '',
    }
  }

  // ── Accounts ────────────────────────────────────────────────────────────────────────────────

  /**
   * The very first account becomes the admin and is signed in at once. Every later registration is
   * an application that keeps the chosen name and password, and becomes an account only when an
   * admin approves it. TKU BridgeTable and TKU BridgeBook share these accounts, so `site` only
   * tells the admin where someone signed up.
   */
  async register(
    username: string,
    password: string,
    inviteCode: string,
    note = '',
    site: Site = 'table',
  ): Promise<{ user: Me; token: string } | { pending: true; username: string }> {
    this.checkInvite(inviteCode)
    const name = this.checkNewName(username)
    this.checkPassword(String(password ?? ''))
    this.checkRoom()
    const passwordHash = await hashPassword(String(password))
    if (!this.users.size) {
      const user = await this.addUser(name, passwordHash)
      return { user: this.me(user), token: await this.createSession(user.id) }
    }
    const application: StoredApplication = {
      id: randomId(8),
      username: name,
      passwordHash,
      note: String(note ?? '').trim().slice(0, LIMITS.applicationNoteMax),
      site: site === 'book' ? 'book' : 'table',
      createdAt: this.now(),
    }
    this.applications.set(application.id, application)
    await this.store.put(`app:${application.id}`, application)
    // Admins hear about it at once, even if they are not on the admin page
    for (const admin of [...this.users.values()].filter((u) => u.admin))
      await this.notifications.notify(admin.id, 'application', { username: name })
    return { pending: true, username: name }
  }

  private checkInvite(inviteCode: string) {
    const { inviteCode: code } = this.clubSettings
    if (code && inviteCode !== code) throw new ClubError('badInvite', {}, 403)
  }

  /** A valid name nobody uses yet, including people still waiting for approval */
  private checkNewName(username: string) {
    const name = String(username ?? '').trim()
    if (name.length < LIMITS.usernameMin || name.length > LIMITS.usernameMax || !USERNAME_PATTERN.test(name))
      throw new ClubError('badUsername', { min: LIMITS.usernameMin, max: LIMITS.usernameMax })
    if (this.findUser(name) || this.findApplication(name) || name.toLowerCase() === ROBOT_NAME.toLowerCase())
      throw new ClubError('usernameTaken', {}, 409)
    return name
  }

  private checkRoom() {
    const { maxUsers } = this.clubSettings
    if (this.users.size >= maxUsers) throw new ClubError('memberCap', { max: maxUsers }, 403)
  }

  /** Accounts admins add themselves need no approval */
  private async createUser(username: string, password: string) {
    const name = this.checkNewName(username)
    this.checkPassword(String(password ?? ''))
    this.checkRoom()
    return this.addUser(name, await hashPassword(String(password)))
  }

  private async addUser(username: string, passwordHash: string) {
    const user: StoredUser = {
      id: randomId(8),
      username,
      passwordHash,
      createdAt: this.now(),
      admin: this.users.size === 0,
    }
    this.users.set(user.id, user)
    await this.store.put(`user:${user.id}`, user)
    return user
  }

  private checkPassword(password: string) {
    if (password.length < LIMITS.passwordMin) throw new ClubError('shortPassword', { min: LIMITS.passwordMin })
  }

  /**
   * Signs in. `address` is where the request came from (the Worker passes CF-Connecting-IP): wrong
   * passwords are counted per username from that address and per address, so guessing is slowed
   * without letting a stranger lock a member out from everywhere
   */
  async login(username: string, password: string, address = '') {
    const name = String(username ?? '').trim()
    const nameKey = `${address}|${name.toLowerCase()}`
    if (this.loginByName.blocked(nameKey) || this.loginByAddress.blocked(address)) {
      this.log({ event: 'loginLocked', username: name.slice(0, LIMITS.usernameMax) })
      throw new ClubError('tooManyLogins', { minutes: LOGIN_WINDOW_MS / 60_000 }, 429)
    }
    const failed = () => {
      this.loginByName.fail(nameKey)
      this.loginByAddress.fail(address)
      return new ClubError('badLogin', {}, 401)
    }
    const user = this.findUser(name)
    if (!user) {
      // Someone still waiting for approval learns that, but only with their own password
      const application = this.findApplication(name)
      if (application && (await verifyPassword(String(password ?? ''), application.passwordHash)))
        throw new ClubError('awaitingApproval', {}, 403)
      throw failed()
    }
    if (!(await verifyPassword(String(password ?? ''), user.passwordHash))) throw failed()
    this.loginByName.clear(nameKey)
    user.lastLoginAt = this.now()
    await this.store.put(`user:${user.id}`, user)
    return { user: this.me(user), token: await this.createSession(user.id) }
  }

  async logout(token: string) {
    await this.store.delete(`session:${token}`)
  }

  async userForToken(token: string | null): Promise<Me | null> {
    if (!token) return null
    const session = await this.store.get<Session>(`session:${token}`)
    if (!session) return null
    if (session.expires < this.now()) {
      await this.store.delete(`session:${token}`)
      return null
    }
    const user = this.users.get(session.userId)
    return user ? this.me(user) : null
  }

  async changePassword(userId: string, current: string, next: string) {
    const user = this.requireUser(userId)
    if (!(await verifyPassword(String(current ?? ''), user.passwordHash))) throw new ClubError('wrongPassword', {}, 403)
    await this.setPassword(user, String(next ?? ''))
  }

  /** `POST /api/account/preferences`: the member's own settings the server needs (e1-t24) */
  async setAccountPreferences(userId: string, preferences: { friendOnlineNotice?: unknown }): Promise<Me> {
    const user = this.requireUser(userId)
    const { friendOnlineNotice } = preferences
    if (typeof friendOnlineNotice !== 'boolean') throw new ClubError('unknownCommand')
    if (friendOnlineNotice) delete user.friendOnlineNotice
    else user.friendOnlineNotice = false
    await this.store.put(`user:${user.id}`, user)
    return this.me(user)
  }

  /** `PATCH /api/account/profile`: replaces the member's own profile (AC-1.5); empty fields are cleared */
  async setProfile(userId: string, input: unknown): Promise<Me> {
    const user = this.requireUser(userId)
    const parsed = parseProfile(input)
    if ('error' in parsed) throw new ClubError(parsed.error, parsed.params)
    if (Object.keys(parsed.profile).length) user.profile = parsed.profile
    else delete user.profile
    await this.store.put(`user:${user.id}`, user)
    return this.me(user)
  }

  /**
   * `GET /api/members/:id`: another member's profile card (AC-1.5) with their latest boards the
   * viewer may see (the history search's own visibility rule). Only `memberProfileView`'s fields leave
   */
  async memberProfile(viewerId: string, memberId: string): Promise<MemberProfile> {
    this.requireUser(viewerId)
    const member = this.users.get(String(memberId ?? ''))
    if (!member) throw new ClubError('userGone', {}, 404)
    const recent = await this.search(viewerId, {
      ...DEFAULT_HISTORY_QUERY,
      scope: 'all',
      player: member.id,
      size: PROFILE_RECENT,
    })
    return memberProfileView(member, recent.boards)
  }

  /**
   * 忘記密碼: whoever knows the club's invite code can give a member account a new password by name.
   * There is no e-mail check yet, so admin accounts are left out (another admin resets them on the
   * admin page), the member is signed out everywhere, and the admin page shows when it happened.
   * Someone still waiting for approval can change the password of their application the same way.
   */
  async resetForgottenPassword(username: string, inviteCode: string, password: string) {
    this.checkInvite(inviteCode)
    const name = String(username ?? '').trim()
    const user = this.findUser(name)
    const application = user ? undefined : this.findApplication(name)
    if (!user && !application) throw new ClubError('userGone', {}, 404)
    if (user?.admin) throw new ClubError('adminNoSelfReset', {}, 403)
    this.checkPassword(String(password ?? ''))
    const passwordHash = await hashPassword(String(password))
    if (application) {
      application.passwordHash = passwordHash
      await this.store.put(`app:${application.id}`, application)
      return
    }
    user!.passwordHash = passwordHash
    user!.passwordResetAt = this.now()
    await this.store.put(`user:${user!.id}`, user)
    await this.revokeSessions(user!.id)
    this.connections.disconnect(user!.id)
  }

  private async setPassword(user: StoredUser, password: string) {
    this.checkPassword(password)
    user.passwordHash = await hashPassword(password)
    await this.store.put(`user:${user.id}`, user)
  }

  private permissionsOf(user: StoredUser): Permission[] {
    return user.admin ? [...PERMISSIONS] : PERMISSIONS.filter((p) => user.permissions?.includes(p))
  }

  private me(user: StoredUser): Me {
    const me: Me = {
      id: user.id,
      username: user.username,
      admin: !!user.admin,
      permissions: this.permissionsOf(user),
      friendOnlineNotice: user.friendOnlineNotice !== false,
    }
    if (user.profile) me.profile = user.profile
    if (user.admin) me.applications = this.applications.size
    return me
  }

  /** The member, if they may use a permission (admins may use all of them) */
  requirePermission(userId: string, permission: Permission): Me {
    const user = this.users.get(userId)
    if (!user) throw new ClubError('signInAgain', {}, 401)
    if (!this.permissionsOf(user).includes(permission)) throw new ClubError('noPermission', {}, 403)
    return this.me(user)
  }

  private findUser(username: string) {
    const wanted = username.toLowerCase()
    return [...this.users.values()].find((u) => u.username.toLowerCase() === wanted)
  }

  private findApplication(username: string) {
    const wanted = username.toLowerCase()
    return [...this.applications.values()].find((a) => a.username.toLowerCase() === wanted)
  }

  private requireUser(id: string) {
    const user = this.users.get(id)
    if (!user) throw new ClubError('userGone', {}, 404)
    return user
  }

  private async createSession(userId: string) {
    const token = randomId(32)
    await this.store.put<Session>(`session:${token}`, { userId, expires: this.now() + SESSION_DAYS * 86_400_000 })
    return token
  }

  private async revokeSessions(userId: string) {
    for (const [key, session] of await this.store.list<Session>('session:'))
      if (session.userId === userId) await this.store.delete(key)
  }

  // ── Admin ───────────────────────────────────────────────────────────────────────────────────

  /** A member's name, for messages such as who saved a system profile first */
  usernameOf(userId: string): string | undefined {
    return this.users.get(userId)?.username
  }

  requireAdmin(userId: string) {
    if (!this.users.get(userId)?.admin) throw new ClubError('adminOnly', {}, 403)
  }

  async adminUsers(): Promise<AdminUser[]> {
    const online = this.connections.onlineUserIds()
    const users = [...this.users.values()].sort((a, b) => a.createdAt - b.createdAt)
    return Promise.all(
      users.map(async (u) => ({
        id: u.id,
        username: u.username,
        admin: !!u.admin,
        createdAt: u.createdAt,
        lastLoginAt: u.lastLoginAt ?? null,
        boards: (await this.store.list(`uhist:${u.id}:`)).size,
        online: online.includes(u.id),
        permissions: this.permissionsOf(u),
        passwordResetAt: u.passwordResetAt ?? null,
      })),
    )
  }

  async adminCreateUser(username: string, password: string) {
    return this.me(await this.createUser(username, password))
  }

  adminApplications(): Application[] {
    return [...this.applications.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(({ id, username, note, site, createdAt }) => ({ id, username, note, site, createdAt }))
  }

  /** Turns an application into an account with the name and password the applicant chose */
  async adminApprove(applicationId: string) {
    const application = this.requireApplication(applicationId)
    this.checkRoom()
    // An admin may have added an account with the same name in the meantime
    if (this.findUser(application.username)) throw new ClubError('usernameTaken', {}, 409)
    const user = await this.addUser(application.username, application.passwordHash)
    await this.dropApplication(application)
    return this.me(user)
  }

  async adminReject(applicationId: string) {
    await this.dropApplication(this.requireApplication(applicationId))
  }

  private requireApplication(id: string) {
    const application = this.applications.get(id)
    if (!application) throw new ClubError('applicationGone', {}, 404)
    return application
  }

  private async dropApplication(application: StoredApplication) {
    this.applications.delete(application.id)
    await this.store.delete(`app:${application.id}`)
  }

  async adminSetPermissions(userId: string, permissions: unknown) {
    const user = this.requireUser(userId)
    if (!Array.isArray(permissions) || !permissions.every(isPermission)) throw new ClubError('badPermission')
    user.permissions = PERMISSIONS.filter((p) => permissions.includes(p))
    await this.store.put(`user:${user.id}`, user)
  }

  /**
   * The admin page's members section saves every role and permission change at once. All of them
   * are checked first, so either every change is stored or none is; the rules are the same as one
   * at a time: no taking away your own admin role, and the club keeps at least one admin.
   */
  async adminUpdateMembers(actorId: string, changes: unknown) {
    if (!Array.isArray(changes) || changes.length > this.users.size) throw new ClubError('badMemberChange')
    const next = new Map<string, { admin: boolean; permissions: Permission[] }>()
    for (const change of changes as Partial<Record<keyof MemberChange, unknown>>[]) {
      if (!change || typeof change !== 'object' || typeof change.id !== 'string' || next.has(change.id))
        throw new ClubError('badMemberChange')
      if (change.admin !== undefined && typeof change.admin !== 'boolean') throw new ClubError('badMemberChange')
      const user = this.requireUser(change.id)
      const permissions = change.permissions
      if (permissions !== undefined && (!Array.isArray(permissions) || !permissions.every(isPermission)))
        throw new ClubError('badPermission')
      const admin = change.admin ?? !!user.admin
      if (!admin && user.admin && user.id === actorId) throw new ClubError('notSelf')
      next.set(user.id, {
        admin,
        permissions: permissions ? PERMISSIONS.filter((p) => permissions.includes(p)) : (user.permissions ?? []),
      })
    }
    if (![...this.users.values()].some((u) => next.get(u.id)?.admin ?? u.admin)) throw new ClubError('lastAdmin')
    for (const [id, { admin, permissions }] of next) {
      const user = this.requireUser(id)
      user.admin = admin
      user.permissions = permissions
      await this.store.put(`user:${user.id}`, user)
    }
  }

  async adminResetPassword(userId: string, password: string) {
    const user = this.requireUser(userId)
    await this.setPassword(user, String(password ?? ''))
    await this.revokeSessions(user.id)
    this.connections.disconnect(user.id)
  }

  async adminSetAdmin(actorId: string, userId: string, admin: boolean) {
    const user = this.requireUser(userId)
    if (!admin && user.admin && [...this.users.values()].filter((u) => u.admin).length === 1)
      throw new ClubError('lastAdmin')
    if (!admin && actorId === userId) throw new ClubError('notSelf')
    user.admin = admin
    await this.store.put(`user:${user.id}`, user)
  }

  async adminDeleteUser(actorId: string, userId: string) {
    if (actorId === userId) throw new ClubError('notSelf')
    const user = this.requireUser(userId)
    await this.batch(async () => {
      await this.leave(user.id)
      // Their challenges forget them, so their parked challenge tables go too; invitations and
      // robot substitutes for them are forgotten (the robot stays in the seat)
      for (const entry of [...this.directory.values()]) {
        const involved =
          entry.challenge?.userId === user.id ||
          entry.invited.includes(user.id) ||
          Object.values(entry.substitutes).includes(user.id) ||
          // A team match plays on: a robot takes their seat (§5.8)
          (!!entry.match && SEATS.some((s) => entry.seats[s] === user.id))
        if (involved) this.applyResult(entry.id, await this.tables.get(entry.id).forget(user.id))
      }
      await this.dropMember(user)
    })
    this.broadcast()
  }

  private async dropMember(user: StoredUser) {
    this.users.delete(user.id)
    await this.store.delete(`user:${user.id}`)
    await this.revokeSessions(user.id)
    await this.notifications.forget(user.id)
    await this.friends.forget(user.id)
    await this.blocks.forget(user.id)
    removeFavoritesOf(this.store.sql, user.id)
    this.present.delete(user.id)
    this.announced.delete(user.id)
    const correspondents = this.directs.forget(user.id)
    for (const id of correspondents) this.pushDirects(id)
    // A challenge left with too few people is cancelled; one where everyone left is done finishes
    for (const id of this.challenges.forget(user.id, this.now())) await this.challengeChanged(id)
    // A match they host that has not started is cancelled; their seats are emptied (§5.7)
    this.matches.store.forget(user.id, this.now())
    this.connections.disconnect(user.id)
  }

  async adminUpdateSettings(update: Partial<ClubSettings>) {
    const next = { ...this.settings }
    if (update.maxUsers !== undefined) {
      const max = Number(update.maxUsers)
      if (!Number.isInteger(max) || max < LIMITS.maxUsersMin || max > LIMITS.maxUsersMax)
        throw new ClubError('badCap', { min: LIMITS.maxUsersMin, max: LIMITS.maxUsersMax })
      next.maxUsers = max
    }
    if (update.inviteCode !== undefined) next.inviteCode = String(update.inviteCode).trim().slice(0, 40)
    this.settings = next
    await this.store.put('meta:settings', next)
    return this.clubSettings
  }

  async adminCloseTable(tableId: string) {
    const entry = this.requireEntry(tableId)
    await this.batch(() => this.closeTable(entry.id))
    this.broadcast()
  }

  // ── History ─────────────────────────────────────────────────────────────────────────────────

  /** Newest first, one page at a time; `page` counts from 1 and `size` is one of HISTORY_PAGE_SIZES */
  async history(userId: string, all: boolean, page = 1, size: number = LIMITS.historyPageDefault): Promise<HistoryPage> {
    if (!(HISTORY_PAGE_SIZES as readonly number[]).includes(size)) size = LIMITS.historyPageDefault
    return this.search(userId, {
      ...DEFAULT_HISTORY_QUERY,
      scope: all ? 'all' : 'mine',
      page: Math.max(1, Math.floor(page) || 1),
      size,
    })
  }

  /** One page of a history search (`shared/history-query.ts`), from the SQL index; boards kept back are left out */
  async search(userId: string, query: HistoryQuery): Promise<HistoryPage> {
    const found = searchBoards(this.store.sql, query, userId, this.now())
    const records = await Promise.all(found.ids.map((id) => this.store.get<BoardRecord>(`board:${id}`)))
    return {
      boards: records.flatMap((record) => (record ? [summarize(record)] : [])),
      total: found.total,
      page: found.page,
      size: query.size,
    }
  }

  // ── Favorites (AC-4.4) ──────────────────────────────────────────────────────────────────────

  /**
   * A board a member may keep: one they may see in every list (`recordVisible`). A challenge or
   * match board not revealed yet can be kept only by its own players, as the lists show it; the
   * same error as a missing board, so asking tells nothing about it
   */
  private async favoritable(boardId: string, userId: string): Promise<BoardRecord> {
    const record = /^[\w-]+$/.test(boardId) ? await this.store.get<BoardRecord>(`board:${boardId}`) : undefined
    if (!record || !recordVisible(record, userId, this.now())) throw new ClubError('boardGone', {}, 404)
    return record
  }

  /** One page of the member's favorites, filtered as history is (and by `tag`), with their notes and tags */
  async favorites(userId: string, query: HistoryQuery): Promise<FavoritesPage> {
    const found = searchBoards(this.store.sql, query, userId, this.now(), true)
    const records = await Promise.all(found.ids.map((id) => this.store.get<BoardRecord>(`board:${id}`)))
    const boards = records.flatMap((record) => (record ? [summarize(record)] : []))
    const kept = favoritesAmong(this.store.sql, userId, boards.map((b) => b.id))
    return {
      boards,
      total: found.total,
      page: found.page,
      size: query.size,
      favorites: boards.flatMap((b) => kept.get(b.id) ?? []),
      tags: favoriteTags(this.store.sql, userId),
    }
  }

  /** Every board the member keeps, for the star buttons */
  favoriteIds(userId: string): string[] {
    return favoriteIds(this.store.sql, userId)
  }

  /** The member's favorite of one board (null if not kept) and their tags, for editing */
  async favorite(userId: string, boardId: string): Promise<{ favorite: Favorite | null; tags: FavoriteTag[] }> {
    await this.favoritable(boardId, userId)
    return { favorite: getFavorite(this.store.sql, userId, boardId), tags: favoriteTags(this.store.sql, userId) }
  }

  /** Keeps a board, or changes the note and tags of one kept; what is left out stays as it was */
  async saveFavorite(userId: string, boardId: string, change: { note?: unknown; tags?: unknown }): Promise<Favorite> {
    await this.favoritable(boardId, userId)
    const sql = this.store.sql
    const before = getFavorite(sql, userId, boardId)
    if (!before && countFavorites(sql, userId) >= LIMITS.favoritesMax)
      throw new ClubError('favoritesFull', { max: LIMITS.favoritesMax })
    const { note, tags } = checkFavorite(change.note ?? before?.note ?? '', change.tags ?? before?.tags ?? [])
    return saveFavorite(sql, userId, boardId, note, tags, this.now())
  }

  /** Stops keeping a board; nothing happens if it was not kept */
  removeFavorite(userId: string, boardId: string) {
    removeFavorite(this.store.sql, userId, boardId)
  }

  /**
   * A board's full record, if the member may see it: a board kept back is seen only by its players,
   * and a challenge board also by the participants who played the same board (its traveller, §4)
   */
  async record(id: string, userId: string): Promise<BoardRecord | null> {
    if (!/^[\w-]+$/.test(id)) return null
    const record = await this.store.get<BoardRecord>(`board:${id}`)
    if (!record) return null
    if (recordVisible(record, userId, this.now())) return record
    const challenge = record.mode === 'challenge' && record.eventId ? this.challenges.get(record.eventId) : null
    return challenge && challengeBoardVisible(challenge, record.id, userId) ? record : null
  }

  /**
   * The traveller of a board (`e4-t32`, AC-4.12): everyone's result on the same board of its
   * challenge, as the member may see it (`challengeTraveller`, §4); null for a board that belongs
   * to no event or that they may not compare yet. The leads and declarers are read from the records
   */
  async traveller(id: string, userId: string): Promise<Traveller | null> {
    if (!/^[\w-]+$/.test(id)) return null
    const record = await this.store.get<BoardRecord>(`board:${id}`)
    if (record?.mode !== 'challenge' || !record.eventId) return null
    const challenge = this.challenges.get(record.eventId)
    if (!challenge) return null
    const boards = eventBoards(this.store.sql, challenge.id)
    const traveller = challengeTraveller(
      challenge,
      id,
      userId,
      (other) => this.publicUserById(other),
      (boardId) => boards.get(boardId),
    )
    if (!traveller) return null
    const records = await Promise.all(traveller.entries.map((e) => this.store.get<BoardRecord>(`board:${e.boardId}`)))
    traveller.entries.forEach((entry, i) => {
      const board = records[i]?.board
      if (!board) return
      entry.lead = openingLead(board)
      if (board.contract) entry.declarer = records[i]!.players[board.contract.declarer] ?? null
    })
    return traveller
  }

  private async saveRecord(record: BoardRecord) {
    // The SQL index first, in one transaction: if it fails nothing is written. If a key-value
    // write fails after it, the index rows are taken back out, so a board is never half saved
    indexRecord(this.store.sql, record)
    try {
      await this.writeRecord(record)
    } catch (error) {
      unindexRecord(this.store.sql, record.id)
      await this.store.delete(`board:${record.id}`)
      throw error
    }
  }

  /** The record and its two key-value summaries (written again when a challenge brings `revealAt` forward) */
  private async writeRecord(record: BoardRecord) {
    // Zero-padded time keeps the indexes in chronological order
    const order = `${String(record.finishedAt).padStart(14, '0')}-${record.id}`
    const summary = summarize(record)
    await this.store.put(`board:${record.id}`, record)
    await this.store.put(`hist:${order}`, summary)
    for (const id of new Set(SEATS.map((seat) => record.players[seat].id))) {
      if (!id || isRobotId(id)) continue
      await this.store.put(`uhist:${id}:${order}`, summary)
    }
  }

  // ── Connections ─────────────────────────────────────────────────────────────────────────────

  connected(userId: string) {
    const user = this.users.get(userId)
    if (!user) return
    // A new socket starts with nothing: send it everything
    this.sent.delete(userId)
    this.connections.send(userId, { type: 'welcome', me: this.me(user) })
    // Their table sends them everything again, and stops waiting to seat a robot for them. A table
    // in its own object hears it from its own connection instead (§5.10)
    const entry = this.entryOf(userId)
    if (entry && !this.remote) void this.tables.get(entry.id).presence(userId, true)
    void this.reclaimSeats(userId)
    this.broadcast()
    void this.pushNotifications(userId)
    this.pushDirects(userId)
    // Whether the host can start a match they are in depends on who is online (e8-t06)
    this.matches.presence(userId)
    if (!this.present.has(userId)) {
      this.present.add(userId)
      void this.announceOnline(userId)
    }
  }

  /**
   * Tells the online members who follow someone that they just came online (e1-t24), through the
   * notification centre. Not for followers who turned it off or whom the newcomer blocked, and not
   * again within FRIEND_ONLINE_QUIET_MS, so a phone that keeps reconnecting stays quiet
   */
  private async announceOnline(userId: string) {
    const user = this.users.get(userId)
    if (!user) return
    const last = this.announced.get(userId)
    if (last !== undefined && this.now() - last < FRIEND_ONLINE_QUIET_MS) return
    this.announced.set(userId, this.now())
    for (const followerId of this.connections.onlineUserIds()) {
      if (followerId === userId || !this.friends.has(followerId, userId) || this.blocks.has(userId, followerId)) continue
      if (this.users.get(followerId)?.friendOnlineNotice === false) continue
      await this.notifications.notify(followerId, 'friendOnline', { username: user.username })
    }
  }

  /** Sends a member their conversation list if they are online and it changed since the last send */
  private pushDirects(userId: string) {
    if (!this.connections.onlineUserIds().includes(userId)) return
    const view = this.directsView(userId)
    const json = JSON.stringify(view)
    const sent = this.sent.get(userId) ?? {}
    if (sent.directs === json) return
    sent.directs = json
    this.sent.set(userId, sent)
    this.connections.send(userId, { type: 'directs', directs: view })
  }

  directsView(userId: string): DirectsView {
    return {
      conversations: this.directs.conversations(userId).flatMap(({ otherId, last, unread }) => {
        const user = this.publicUserById(otherId)
        return user ? [{ user, last, unread }] : []
      }),
      unread: this.directs.unread(userId),
    }
  }

  /** `GET /api/messages/:userId`: a page of the member's own conversation with another member, never anyone else's */
  directPage(userId: string, otherId: string, before?: number): DirectPage {
    const other = this.otherMember(userId, otherId)
    return this.directs.page(userId, other, before !== undefined && Number.isInteger(before) && before > 0 ? before : undefined)
  }

  /**
   * Sends a direct message (AC-1.7, e1-t27): to another member (not oneself or a robot), at most
   * LIMITS.directMax characters, and not when either has blocked the other. The sender hears
   * `unblockToMessage`; a member blocked by the recipient only hears they cannot write to them, as with
   * invitations. The message goes to the two members' sockets and nobody else's
   */
  private sendDirect(userId: string, to: unknown, text: unknown) {
    const other = this.otherMember(userId, to)
    const clean = String(text ?? '').trim()
    if (!clean) return
    if (clean.length > LIMITS.directMax) throw new ClubError('directTooLong', { max: LIMITS.directMax })
    if (this.blocks.has(userId, other)) throw new ClubError('unblockToMessage')
    if (this.blocks.has(other, userId)) throw new ClubError('cannotMessage', { name: this.users.get(other)!.username }, 403)
    const message = this.directs.add(userId, other, clean, this.now())
    for (const id of [userId, other]) {
      if (!this.connections.onlineUserIds().includes(id)) continue
      this.connections.send(id, { type: 'direct', message })
      this.pushDirects(id)
    }
  }

  /** Sends a member their notifications if they are online and something changed since the last send */
  private async pushNotifications(userId: string) {
    if (!this.connections.onlineUserIds().includes(userId)) return
    const view = await this.notifications.view(userId)
    const json = JSON.stringify(view)
    const sent = this.sent.get(userId) ?? {}
    if (sent.notifications === json) return
    sent.notifications = json
    this.sent.set(userId, sent)
    this.connections.send(userId, { type: 'notifications', notifications: view })
  }

  /**
   * Called when a user's last socket closes. Spectators leave; seated players keep their seat, but
   * a host who drops out hands the table to someone still there.
   */
  async disconnected(userId: string) {
    this.sent.delete(userId)
    this.present.delete(userId)
    // Their table decides: a spectator leaves, a seated player keeps the seat for a while (代打).
    // A table in its own object goes by its own connection instead (§5.10)
    const entry = this.entryOf(userId)
    if (entry && !this.remote) {
      const table = this.tables.get(entry.id)
      this.applyResult(entry.id, await this.batch(() => table.presence(userId, false)))
    }
    this.broadcast()
    this.matches.presence(userId)
  }

  /** A member back online takes their seat back from the robot sitting in for them (代打) */
  private async reclaimSeats(userId: string) {
    for (const entry of [...this.directory.values()]) {
      if (!Object.values(entry.substitutes).includes(userId)) continue
      this.applyResult(entry.id, await this.tables.get(entry.id).reclaim(userId, !this.entryOf(userId)))
    }
  }

  /**
   * A WebSocket message as it arrived (AC-11.7): checked for size, shape and field types
   * (`shared/message-guard.ts`) and rate-limited per member before it reaches `handle`; a rejected
   * one is answered with an `error`. A bug in a handler is logged and answered with `serverError`
   */
  async handleRaw(userId: string, raw: string) {
    const parsed = parseClientMessage(raw)
    if ('error' in parsed) return this.reject(userId, parsed.error)
    const { message } = parsed
    if (!this.actionLimit.take(userId)) return this.reject(userId, 'slowDown', message.type)
    if (message.type === 'chat' && !this.chatLimit.take(userId)) return this.reject(userId, 'chatTooFast', message.type)
    if (message.type === 'sendDirect' && !this.directLimit.take(userId))
      return this.reject(userId, 'directTooFast', message.type)
    try {
      await this.handle(userId, message)
    } catch (error) {
      this.log(crashEntry(message.type, error))
      const failure = new ClubError('serverError', {}, 500)
      this.connections.send(userId, { type: 'error', code: failure.code, params: {}, message: failure.message })
    }
  }

  private reject(userId: string, code: MessageCode, type?: string) {
    this.log({ event: 'rejected', user: userId, code, ...(type ? { type } : {}) })
    const error = new ClubError(code)
    this.connections.send(userId, { type: 'error', code, params: {}, message: error.message })
  }

  /** A browser's error report (`POST /api/client-errors`): cleaned and logged, a few a second at most */
  reportClientError(raw: string): boolean {
    const entry = parseClientError(raw)
    if (!entry) return false
    if (this.clientErrorLimit.take('club')) this.log(entry)
    return true
  }

  /** `GET /api/health`: the club loaded and answers; counts only, nothing about who */
  health() {
    return { ok: true, now: this.now(), tables: this.directory.size, online: this.connections.onlineUserIds().length }
  }

  async handle(userId: string, message: ClientMessage) {
    return this.inLane(userId, async () => {
      const started = this.now()
      const type = typeof message?.type === 'string' ? message.type : '?'
      try {
        await this.batch(() => this.dispatch(userId, message))
      } catch (error) {
        if (error instanceof AppError) {
          this.log({ event: 'action', type, user: userId, ms: this.now() - started, code: error.code })
          this.connections.send(userId, { type: 'error', code: error.code, params: error.params, message: error.message })
          return
        }
        throw error
      }
      this.broadcast()
      this.log({ event: 'action', type, user: userId, ms: this.now() - started })
    })
  }

  /**
   * Runs a member's actions one at a time (§5.10): while one waits on a table's answer (an RPC to
   * its object), the next (from another tab, say) waits for it, so nobody sits at B while still
   * being taken from A. A member with nothing under way starts at once
   */
  private inLane<T>(userId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.lanes.get(userId)
    const result = previous ? previous.then(run) : run()
    const done = result.then(
      () => undefined,
      () => undefined,
    )
    this.lanes.set(userId, done)
    void done.then(() => {
      if (this.lanes.get(userId) === done) this.lanes.delete(userId)
    })
    return result
  }

  /**
   * Runs a club action that may change several tables: the lobby goes out once, when it ends (the
   * caller broadcasts), not after every table's report
   */
  private async batch<T>(run: () => Promise<T>): Promise<T> {
    this.busy++
    try {
      return await run()
    } finally {
      this.busy--
    }
  }

  private async dispatch(userId: string, message: ClientMessage) {
    if (!this.users.has(userId)) throw new ClubError('signInAgain', {}, 401)
    switch (message?.type) {
      case 'createTable':
        return this.createTable(userId, message.settings, message.invitees)
      case 'updateTableSettings':
        return this.updateTableSettings(userId, message.settings, message.invitees)
      case 'quickSeat':
        return this.quickSeat(userId)
      case 'createPractice':
        return this.createPractice(userId, message.settings)
      case 'joinTable':
        return this.joinTable(userId, this.requireEntry(message.tableId))
      case 'sit':
        if (!isSeat(message.seat)) throw new ClubError('badSeat')
        return this.sit(userId, this.requireEntry(message.tableId), message.seat)
      case 'leaveTable':
        return this.leave(userId)
      case 'readNotifications': {
        const ids = message.ids
        if (ids !== undefined && !(Array.isArray(ids) && ids.every((id) => typeof id === 'string')))
          throw new ClubError('unknownCommand')
        return this.notifications.markRead(userId, ids)
      }
      case 'setFriend':
        return this.setFriend(userId, message.userId, message.friend)
      case 'setBlocked':
        return this.setBlocked(userId, message.userId, message.blocked)
      case 'sendDirect':
        return this.sendDirect(userId, message.to, message.text)
      case 'readDirect':
        if (this.directs.markRead(userId, this.otherMember(userId, message.userId))) this.pushDirects(userId)
        return
      case 'createChallenge':
        return this.createChallenge(userId, message.invitees, message.boards, message.settings, message.fromBoards)
      case 'rematchChallenge':
        return this.rematchChallenge(userId, message.challengeId)
      case 'answerChallenge':
        return this.answerChallenge(userId, message.challengeId, message.accept)
      case 'cancelChallenge':
        return this.cancelChallenge(userId, message.challengeId)
      case 'playChallenge':
        return this.playChallenge(userId, message.challengeId)
      case 'matchInvite':
      case 'matchAnswer':
      case 'matchMove':
      case 'matchLeave':
      case 'matchClear':
      case 'matchRobot':
        await this.matches.act(userId, message)
        return
      case 'startMatch':
        return this.startMatch(userId, message.matchId)
      case 'matchRule':
      case 'matchPause':
      case 'matchAbandon':
      case 'matchReplace':
      case 'matchSitIn':
        return this.matchPlay(userId, message)
      default:
        // Bidding, play, chat and the host's seat changes belong to the member's table (§5.10)
        if (isTableAction(message)) return this.tableAction(userId, message)
        throw new ClubError('unknownCommand')
    }
  }

  // ── Friends and blocks ──────────────────────────────────────────────────────────────────────

  /** Another member's account, for a friend or block action; never oneself, never a robot */
  private otherMember(userId: string, otherId: unknown): string {
    if (otherId === userId) throw new ClubError('notSelf')
    if (typeof otherId !== 'string' || !this.users.has(otherId)) throw new ClubError('userGone', {}, 404)
    return otherId
  }

  /** Following is one-way and asks nobody; a member one has blocked must be unblocked first */
  private async setFriend(userId: string, otherId: unknown, friend: unknown) {
    const other = this.otherMember(userId, otherId)
    if (typeof friend !== 'boolean') throw new ClubError('unknownCommand')
    if (friend && this.blocks.has(userId, other)) throw new ClubError('unblockFirst')
    await this.friends.set(userId, other, friend)
  }

  /**
   * Blocking hides the other member's chat from the blocker and keeps them away from any table the
   * blocker hosts; it also stops following them. They are not told
   */
  private async setBlocked(userId: string, otherId: unknown, blocked: unknown) {
    const other = this.otherMember(userId, otherId)
    if (typeof blocked !== 'boolean') throw new ClubError('unknownCommand')
    await this.blocks.set(userId, other, blocked)
    if (blocked) await this.friends.set(userId, other, false)
    // The chat they see at their table changes at once
    const entry = this.entryOf(userId)
    if (entry) await this.tables.get(entry.id).blocked(userId, this.blocks.of(userId))
  }

  /**
   * A member the host blocked may not join the table, to sit or to watch; at an invite table only
   * the invited may (`e2-t25`)
   */
  private checkWelcome(userId: string, table: TableEntry) {
    if (this.blocks.has(table.hostId, userId)) throw new ClubError('blockedByHost', {}, 403)
    if (!this.invitedTo(userId, table)) throw new ClubError('notInvited', {}, 403)
  }

  /** Whether a member may come to a table as far as invitations go: any public one, an invite one when invited or already there */
  private invitedTo(userId: string, table: TableEntry): boolean {
    if (soloTable(table.mode)) return false
    if (table.settings.visibility === 'public' || table.hostId === userId) return true
    return table.invited.includes(userId) || this.entryOf(userId)?.id === table.id
  }

  // ── Challenges (§5.5) ───────────────────────────────────────────────────────────────────────

  /**
   * Creates a challenge (e7-t05): 1–20 different members the creator follows, neither side
   * blocking the other; settings checked by `parseChallengeSettings`. The boards are 4–16 dealt at
   * random now, turned for Best Hand and bid by the robots for Just Declare (`e7-t10`, `e7-t11`);
   * or, with `fromBoards`, boards the creator already played (`e7-t22`). The creator has accepted
   * and may play at once (unless their results are already in); the invitees are told. Returns the
   * new challenge's id
   */
  private async createChallenge(
    userId: string,
    invitees: unknown,
    boards: unknown,
    wanted: unknown,
    fromBoards?: unknown,
  ): Promise<string> {
    const { invitedMin, invitedMax, boardsMin, boardsMax, boardsDefault } = CHALLENGE_LIMITS
    if (!Array.isArray(invitees)) throw new ClubError('badChallengeSettings', { field: 'invitees' })
    if (invitees.length < invitedMin || invitees.length > invitedMax)
      throw new ClubError('challengeInvitees', { min: invitedMin, max: invitedMax })
    if (new Set(invitees).size !== invitees.length) throw new ClubError('badChallengeSettings', { field: 'invitees' })
    for (const id of invitees) {
      const other = this.otherMember(userId, id)
      const name = this.users.get(other)!.username
      // Blocking the invitee also stopped following them, so a member one blocked is never a friend
      if (!this.friends.has(userId, other)) throw new ClubError('notFriend', { name })
      // Whether they blocked the creator stays private: the creator only hears they cannot be invited
      if (this.blocks.has(other, userId)) throw new ClubError('cannotInvite', { name }, 403)
    }
    const parsed = parseChallengeSettings(wanted, invitees.length)
    if ('field' in parsed) throw new ClubError('badChallengeSettings', { field: parsed.field })
    let settings = parsed.settings
    let deals: DealSet | null
    let known: ChallengeResult[] | undefined
    if (fromBoards !== undefined) {
      if (boards !== undefined) throw new ClubError('badChallengeSettings', { field: 'boards' })
      const given = await this.boardsToChallengeWith(userId, fromBoards)
      // Their own boards are dealt as they were: no Best Hand, no Just Declare, and the same robots
      if (settings.bestHand) throw new ClubError('badChallengeSettings', { field: 'bestHand' })
      if (settings.justDeclare) throw new ClubError('badChallengeSettings', { field: 'justDeclare' })
      const askedKind = (wanted as Partial<ChallengeSettings> | undefined)?.robotKind
      if (askedKind !== undefined && askedKind !== given.robotKind)
        throw new ClubError('badChallengeSettings', { field: 'robotKind' })
      settings = { ...settings, robotKind: given.robotKind }
      deals = makeDealSet({ kind: 'given', boards: given.boards.map(({ boardNo, hands }) => ({ boardNo, hands })) })
      known = given.boards.map((b, i) => ({ userId, seq: i + 1, boardId: b.id, scoreNS: b.scoreNS, playedAt: b.playedAt }))
    } else {
      const count = boards ?? boardsDefault
      if (!Number.isInteger(count) || (count as number) < boardsMin || (count as number) > boardsMax)
        throw new ClubError('challengeBoards', { min: boardsMin, max: boardsMax })
      const { bestHand, justDeclare, robotKind } = settings
      deals = challengeDeals({ count: count as number, bestHand, justDeclare, robotKind }, this.random)
    }
    if (!deals) throw new ClubError('serverError', {}, 500)
    const challenge = newChallenge({
      id: randomId(8),
      creatorId: userId,
      invitees: invitees as string[],
      settings,
      deals,
      now: this.now(),
      known,
    })
    this.challenges.create(challenge)
    this.scheduleChallenge(challenge.id)
    const username = this.users.get(userId)!.username
    for (const id of invitees as string[])
      await this.notifications.notify(id, 'challengeInvited', { challengeId: challenge.id, username })
    return challenge.id
  }

  /**
   * The boards of 「用這副牌挑戰」 (`e7-t22`): 1–16 different boards from the history that the member
   * played with three robots of one system and that anyone may see by now, each turned so the seat
   * they bid from is South, with their result from their side. A board they did not play is
   * `boardGone`, as if it did not exist
   */
  private async boardsToChallengeWith(
    userId: string,
    ids: unknown,
  ): Promise<{ robotKind: RobotKind; boards: (DealSetBoard & { id: string; scoreNS: number; playedAt: number })[] }> {
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > CHALLENGE_LIMITS.boardsMax || new Set(ids).size !== ids.length)
      throw new ClubError('badChallengeSettings', { field: 'fromBoards' })
    const kinds = new Set<RobotKind>()
    const boards = []
    for (const id of ids) {
      const record = typeof id === 'string' ? await this.store.get<BoardRecord>(`board:${id}`) : null
      const seat = record ? SEATS.find((s) => record.players[s]?.id === userId) : undefined
      const result = record?.board.result
      // A board still kept back (a challenge going on) is not there to give away
      if (!record || !seat || !result || (record.revealAt ?? 0) > this.now()) throw new ClubError('boardGone', {}, 404)
      const others = SEATS.filter((s) => s !== seat).map((s) => record.players[s])
      if (!others.every((p) => p?.robot)) throw new ClubError('challengeRobotsOnly')
      // Practice boards were dealt to the member's own conditions and may have been dealt again
      if (record.mode === 'practice') throw new ClubError('practiceNoChallenge')
      for (const p of others) kinds.add(p.robotKind ?? 'tku')
      // Declaring for a robot partner moved them to its seat: they bid from the other one
      const bidFrom = record.board.auction.find((c) => !c.robot)?.seat ?? seat
      const { boardNo, hands } = record.board
      const south = boardAsSouth({ boardNo, hands, scoreNS: result.scoreNS }, bidFrom)
      boards.push({ ...south, id: record.id, playedAt: record.finishedAt })
    }
    if (kinds.size !== 1) throw new ClubError('challengeRobotKinds')
    return { robotKind: [...kinds][0], boards }
  }

  /**
   * One-click rematch (`e7-t21`): a participant of a challenge that ended challenges the same
   * people again (everyone who did not decline) with the same settings and number of boards, on
   * new boards. The usual checks of `createChallenge` apply: they must still be friends
   */
  private async rematchChallenge(userId: string, challengeId: unknown): Promise<string> {
    const c = this.requireChallenge(challengeId)
    const me = c.players.find((p) => p.userId === userId)
    if (!me) throw new ClubError('challengeGone', {}, 404)
    if (isOpenChallenge(c.status)) throw new ClubError('challengeNotOver')
    if (me.status !== 'accepted') throw new ClubError('challengeNotAccepted')
    // Next week's club challenge comes by itself
    if (c.settings.weekly) throw new ClubError('weeklyNoRematch')
    const others = c.players
      .filter((p) => p.userId !== userId && p.status !== 'declined' && this.users.has(p.userId))
      .map((p) => p.userId)
    if (!others.length) throw new ClubError('rematchNobody')
    const { boardsMin, boardsMax } = CHALLENGE_LIMITS
    const boards = Math.min(boardsMax, Math.max(boardsMin, c.deals.boards.length))
    const { scoring, robotKind, bestHand, justDeclare, days, ranking } = c.settings
    // With someone gone the number of people may no longer fit the scoring: then the default
    const fits = scoringsFor(others.length).includes(scoring)
    return this.createChallenge(userId, others, boards, { robotKind, bestHand, justDeclare, days, ranking, ...(fits && { scoring }) })
  }

  private requireChallenge(id: unknown): Challenge {
    const challenge = typeof id === 'string' ? this.challenges.get(id) : null
    if (!challenge) throw new ClubError('challengeGone', {}, 404)
    return challenge
  }

  /** Writes a step of `challenge-flow.ts` in one transaction */
  private applyChallenge(challenge: Challenge, change: ChallengeChange) {
    this.store.sql.transaction(() => {
      for (const player of change.players) this.challenges.updatePlayer(challenge.id, player)
      if (change.status) this.challenges.setStatus(challenge.id, change.status, this.now())
    })
  }

  /** An invitee accepts or declines (e7-t06); the creator is told either way */
  private async answerChallenge(userId: string, challengeId: unknown, accept: unknown) {
    if (typeof accept !== 'boolean') throw new ClubError('unknownCommand')
    const challenge = this.requireChallenge(challengeId)
    const step = answer(challenge, userId, accept, this.now())
    if ('error' in step) throw new ClubError(step.error, {}, step.error === 'challengeGone' ? 404 : 400)
    this.applyChallenge(challenge, step)
    // The weekly club challenge's creator is the club: no admin hears every member's answer
    if (!challenge.settings.weekly)
      await this.notifications.notify(challenge.creatorId, accept ? 'challengeAccepted' : 'challengeDeclined', {
        challengeId: challenge.id,
        username: this.users.get(userId)!.username,
      })
    // The last decline may expire it, or leave only people who are done
    await this.challengeChanged(challenge.id)
  }

  /** The creator calls it off while nobody else has started; everyone who has not declined is told */
  private async cancelChallenge(userId: string, challengeId: unknown) {
    const challenge = this.requireChallenge(challengeId)
    const step = cancel(challenge, userId)
    if ('error' in step) throw new ClubError(step.error, {}, step.error === 'challengeGone' ? 404 : 400)
    this.applyChallenge(challenge, step)
    const username = this.users.get(userId)!.username
    for (const p of challenge.players)
      if (p.userId !== userId && p.status !== 'declined')
        await this.notifications.notify(p.userId, 'challengeCancelled', { challengeId: challenge.id, username })
    await this.challengeChanged(challenge.id)
  }

  /**
   * Creates, answers or cancels a challenge over HTTP (`POST /api/challenges…`, `e7-t16`, `e7-t17`):
   * the same checks as the socket messages, but the page hears back at once with the challenge as
   * the member now sees it. Errors are thrown as `ClubError`
   */
  async challengeRequest(userId: string, request: ChallengeRequest): Promise<ChallengeView | null> {
    // The same shape checks and rate limit as a socket message (`handleRaw`)
    const parsed = parseClientMessage(JSON.stringify(request))
    if ('error' in parsed) throw new ClubError(parsed.error)
    if (!this.actionLimit.take(userId)) throw new ClubError('slowDown', {}, 429)
    // In the member's lane, as their socket messages are: cancelling closes tables
    return this.inLane(userId, () => this.challengeAction(userId, parsed.message as ChallengeRequest))
  }

  private async challengeAction(userId: string, message: ChallengeRequest): Promise<ChallengeView | null> {
    let id: string
    if (message.type === 'createChallenge') {
      id = await this.createChallenge(userId, message.invitees, message.boards, message.settings, message.fromBoards)
    } else if (message.type === 'rematchChallenge') {
      id = await this.rematchChallenge(userId, message.challengeId)
    } else {
      await this.dispatch(userId, message)
      id = message.challengeId
    }
    // Cancelling closes the challenge's tables
    this.broadcast()
    return this.challengeFor(id, userId)
  }

  /**
   * The challenges a member is in, newest first, as they may see them (`challengeView`), without
   * the travellers: the list is for the lobby, one challenge's page asks for it with `challengeFor`
   */
  challengeList(userId: string): ChallengeView[] {
    return this.challenges.idsOf(userId).flatMap((id) => {
      const challenge = this.challenges.get(id)
      const view = challenge && challengeView(challenge, userId, (other) => this.publicUserById(other))
      if (!view) return []
      const { travellers: _later, ...rest } = view
      return [rest]
    })
  }

  /**
   * One challenge as the member may see it (`challengeView`, §4): its participants, and the whole
   * club once it finished with `ranking = club`; null for anyone else
   */
  challengeFor(id: string, userId: string): ChallengeView | null {
    const challenge = this.challenges.get(id)
    if (!challenge) return null
    const boards = eventBoards(this.store.sql, id)
    return challengeView(challenge, userId, (other) => this.publicUserById(other), (boardId) => boards.get(boardId))
  }

  // ── Challenge deadlines and settlement (§5.5, e7-t13) ───────────────────────────────────────

  /**
   * Puts an open challenge's one job (`challenge:<id>`) at its next time point: the reminder 12
   * hours before the deadline until it went out, then the deadline. Jobs are not stored; `load()`
   * schedules every open challenge again
   */
  private scheduleChallenge(id: string) {
    const challenge = this.challenges.get(id)
    const at = challenge ? nextChallengeTime(challenge) : null
    if (at === null) return
    this.scheduler.add(`challenge:${id}`, 'challenge', Math.max(0, at - this.now()), () => this.challengeDue(id))
  }

  /**
   * The challenge's job. At the deadline it settles (`deadlineOutcome`); before it, from 12 hours
   * out, it reminds those who accepted and still have boards to play, once. Either way the time is
   * checked again here, so a job run early only puts itself back
   */
  private async challengeDue(id: string) {
    const challenge = this.challenges.get(id)
    if (!challenge || !isOpenChallenge(challenge.status)) return
    const now = this.now()
    if (now >= challenge.deadline) {
      const change = deadlineOutcome(challenge, now)
      if (change) await this.endChallenge(challenge, change)
      this.broadcast()
      return
    }
    if (challenge.remindedAt === undefined && now >= challenge.deadline - REMINDER_MS) {
      // Noted first, so a failure halfway never sends it twice
      this.challenges.setReminded(id, now)
      for (const userId of remindWhom(challenge))
        await this.notifications.notify(userId, 'challengeReminder', { challengeId: id })
    }
    this.scheduleChallenge(id)
  }

  /**
   * After anything that may end a challenge (an answer, a cancel, a finished board, an account
   * deleted): one that just ended closes up; one where every invitee answered and everyone who
   * accepted played every board finishes now, before the deadline
   */
  private async challengeChanged(id: string) {
    const challenge = this.challenges.get(id)
    if (!challenge) return
    if (!isOpenChallenge(challenge.status)) return this.challengeEnded(challenge)
    const change = earlyFinish(challenge)
    if (change) await this.endChallenge(challenge, change)
  }

  /** Moves a challenge to its end (`finished` or `expired`); a finished one tells everyone who accepted */
  private async endChallenge(challenge: Challenge, change: ChallengeChange) {
    this.applyChallenge(challenge, change)
    const ended = this.challenges.get(challenge.id)!
    await this.challengeEnded(ended)
    if (ended.status !== 'finished') return
    for (const p of ended.players)
      if (p.status === 'accepted')
        await this.notifications.notify(p.userId, 'challengeResults', { challengeId: ended.id })
  }

  /**
   * A challenge that ended (finished, expired or cancelled). Its tables close: a board still being
   * played is dropped, as the deadline stops play; only someone still sitting at their table after
   * their last board keeps it until they leave. Its boards are shown to everyone from now on: the
   * records' `revealAt` and `boards_index.reveal_at` are brought forward to the end
   */
  private async challengeEnded(challenge: Challenge) {
    for (const entry of [...this.directory.values()]) {
      if (entry.challenge?.challengeId !== challenge.id) continue
      this.applyResult(entry.id, await this.tables.get(entry.id).challengeEnded())
    }
    const now = this.now()
    for (const boardId of revealEvent(this.store.sql, challenge.id, now)) {
      const record = await this.store.get<BoardRecord>(`board:${boardId}`)
      if (record) await this.writeRecord({ ...record, revealAt: now })
    }
  }

  // ── The weekly club challenge (§5.5, e7-t23) ────────────────────────────────────────────────

  /** The schedule as an admin sees it, with when the next challenge is created */
  weeklyChallenge(): WeeklyChallengeView {
    const state = this.weekly
    if (!state) return { schedule: DEFAULT_WEEKLY_SCHEDULE, next: null }
    return {
      schedule: state.schedule,
      next: nextWeeklyRun(state),
      ...(state.lastRunAt !== undefined && { lastRunAt: state.lastRunAt }),
      ...(state.lastChallengeId !== undefined && { lastChallengeId: state.lastChallengeId }),
    }
  }

  /**
   * An admin sets the schedule (`parseWeeklySchedule`). The next challenge is the first time the
   * schedule names after now (or after the last one created), so saving never creates one at once
   */
  async adminSetWeeklyChallenge(adminId: string, value: unknown): Promise<WeeklyChallengeView> {
    const parsed = parseWeeklySchedule(value, this.weekly?.schedule)
    if ('field' in parsed) throw new ClubError('badChallengeSettings', { field: parsed.field })
    this.weekly = { ...this.weekly, schedule: parsed.schedule, adminId, savedAt: this.now() }
    await this.store.put(WEEKLY_KEY, this.weekly)
    this.scheduleWeekly()
    return this.weeklyChallenge()
  }

  /**
   * One job, keyed by when the schedule was saved: a job left from an older schedule finds it
   * changed and does nothing. Not stored; `load()` schedules it again
   */
  private scheduleWeekly() {
    const state = this.weekly
    const at = state && nextWeeklyRun(state)
    if (!state || at === null || at === undefined) return
    const savedAt = state.savedAt
    this.scheduler.add(`weekly:${savedAt}`, 'weekly', Math.max(0, at - this.now()), () => this.weeklyDue(savedAt))
  }

  /**
   * The weekly job: once the time comes, the time is noted first (so a failure halfway never
   * creates two), then the challenge is created and the job waits for the next week. An object
   * that slept through several weeks creates one challenge, not one for each week missed
   */
  private async weeklyDue(savedAt: number) {
    const state = this.weekly
    if (!state || state.savedAt !== savedAt) return
    const at = nextWeeklyRun(state)
    if (at === null) return
    const now = this.now()
    if (now >= at) {
      state.lastRunAt = latestWeeklySlot(state.schedule, now)
      await this.store.put(WEEKLY_KEY, state)
      const id = await this.createWeeklyChallenge(state)
      if (id) {
        state.lastChallengeId = id
        await this.store.put(WEEKLY_KEY, state)
        this.broadcast()
      }
    }
    this.scheduleWeekly()
  }

  /**
   * Creates the week's club challenge: every member is invited, not only friends, and no block
   * stops it (the club invites, not a member). The admin who saved the schedule is its creator
   * (accepted, as every creator is); if they are no longer an admin, the oldest admin. Everyone is
   * told, the creator too. Null when there is nobody to invite
   */
  private async createWeeklyChallenge(state: WeeklyState): Promise<string | null> {
    const members = [...this.users.values()].sort((a, b) => a.createdAt - b.createdAt)
    const creator = members.find((u) => u.admin && u.id === state.adminId) ?? members.find((u) => u.admin)
    if (!creator) return null
    const invitees = members.filter((u) => u.id !== creator.id).map((u) => u.id)
    if (!invitees.length) return null
    const { boards, scoring, robotKind, days } = state.schedule
    const settings: ChallengeSettings = {
      // Head to head (a club of two) matchpoints mean little: IMPs instead
      scoring: invitees.length > 1 || scoring === 'total' ? scoring : 'imp',
      robotKind,
      bestHand: false,
      justDeclare: false,
      days,
      ranking: 'club',
      weekly: true,
    }
    const deals = challengeDeals({ count: boards, bestHand: false, justDeclare: false, robotKind }, this.random)
    if (!deals) return null
    const challenge = newChallenge({ id: randomId(8), creatorId: creator.id, invitees, settings, deals, now: this.now() })
    this.challenges.create(challenge)
    this.scheduleChallenge(challenge.id)
    for (const p of challenge.players)
      await this.notifications.notify(p.userId, 'challengeWeekly', { challengeId: challenge.id })
    return challenge.id
  }

  // ── Challenge tables (§5.5, e7-t08, e7-t12) ─────────────────────────────────────────────────

  /** A participant's table for a challenge, at it or parked */
  private challengeEntry(challengeId: string, userId: string): TableEntry | undefined {
    return [...this.directory.values()].find((t) => t.challenge?.challengeId === challengeId && t.challenge.userId === userId)
  }

  /**
   * Starts a challenge or goes back to it (e7-t08, e7-t12). Only an accepted participant, while
   * the challenge is open and before the deadline: the creator at once, the others after accepting.
   * The first time it opens their own table: they sit South, the other three seats are TKB in the
   * challenge's system, and the first board of the set is dealt. Coming back seats them
   * where they were: a board in progress goes on exactly as it was, a finished one is followed by
   * the next board of the set. Whatever table they were at they leave first
   */
  private async playChallenge(userId: string, challengeId: unknown) {
    const challenge = this.requireChallenge(challengeId)
    const player = challenge.players.find((p) => p.userId === userId)
    if (!player) throw new ClubError('challengeGone', {}, 404)
    const existing = this.challengeEntry(challenge.id, userId)
    const atIt = !!existing && this.entryOf(userId)?.id === existing.id
    if (!challengeTakesPart(challenge, this.now())) {
      if (existing && !atIt) await this.closeTable(existing.id)
      throw new ClubError('challengeClosed')
    }
    if (player.status !== 'accepted') throw new ClubError('challengeNotAccepted')
    if (atIt) return
    this.checkNotInMatch(userId)
    if (player.knownDeals || (!existing && nextSeq(challenge, userId) === null)) throw new ClubError('challengeDone')
    await this.leave(userId)
    if (existing) {
      this.applyResult(existing.id, await this.tables.get(existing.id).resume(this.person(userId)))
      return
    }
    const kind = challenge.settings.robotKind
    const state: ChallengeTableState = { challengeId: challenge.id, userId, seq: 0, ...challengeSnapshot(challenge, userId, this.now()) }
    const table: Table = {
      id: randomId(6),
      // Challenge tables are not in the lobby and take no number from it
      number: 0,
      hostId: userId,
      seats: { N: robotId(kind, 'N'), E: robotId(kind, 'E'), S: userId, W: robotId(kind, 'W') },
      spectators: [],
      boardsPlayed: state.played.length,
      board: null,
      chat: [],
      createdAt: this.now(),
      mode: 'challenge',
      modeState: state,
      dealSource: dealSourceOf(challenge.deals),
      settings: { visibility: 'invite', allowKibitz: false, boardMinutes: 0 },
      names: { [userId]: this.users.get(userId)!.username },
      blocks: { [userId]: this.blocks.of(userId) },
    }
    // The table deals its first board as it opens
    if (player.startedAt === undefined) this.challenges.updatePlayer(challenge.id, { ...player, startedAt: this.now() })
    this.applyEntry(await this.tables.get(table.id).open(table))
  }

  // ── Team matches being played (§5.8, e8-t07–e8-t11, e8-t13) ─────────────────────────────────

  /**
   * The host starts a match over HTTP (`POST /api/matches/:id/start`): the same as the socket's
   * `startMatch`, rate-limited, in the host's lane; answers the match as the host now sees it
   */
  async startMatchRequest(userId: string, matchId: string): Promise<TeamMatchView | null> {
    if (!this.actionLimit.take(userId)) throw new ClubError('slowDown', {}, 429)
    await this.inLane(userId, () => this.batch(() => this.startMatch(userId, matchId)))
    this.broadcast()
    return this.matches.get(matchId, userId)
  }

  /**
   * Starts a match (`e8-t07`, AC-8.2): the host's, set up, every seat taken and everyone online.
   * Nobody in it may be playing another match. Each member leaves the table they are at (a
   * challenge table only pauses), then both rooms open at once (§5.10: two independent tables, in
   * production two `TableObject`s) on the same new deal set and deal board 1. If either cannot
   * open, the other is closed too and the match stays set up
   */
  private async startMatch(userId: string, matchId: unknown) {
    const match = this.matches.startable(userId, matchId)
    const members = match.seats.flatMap((s) => (s.userId !== undefined && !s.robot ? [s.userId] : []))
    for (const id of members)
      if (this.matches.store.playingIdOf(id))
        throw new ClubError('matchPlayerBusy', { name: this.users.get(id)?.username ?? '' })
    const deals = makeDealSet({ kind: 'random', count: match.settings.boards }, this.random)
    if (!deals) throw new ClubError('serverError', {}, 500)
    const people = Object.fromEntries(
      members.flatMap((id) => {
        const user = this.users.get(id)
        return user ? [[id, { username: user.username, blocked: this.blocks.of(id) }]] : []
      }),
    )
    const ids = { open: randomId(6), closed: randomId(6) } satisfies Record<Room, string>
    for (const id of members) await this.leave(id)
    const now = this.now()
    const opened = await Promise.allSettled(
      ROOMS.map((room) => this.tables.get(ids[room]).open(teamTable({ id: ids[room], match, room, deals, now, people }))),
    )
    const failed = opened.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (failed) {
      for (const [i, result] of opened.entries())
        if (result.status === 'fulfilled') await this.closeTable(ids[ROOMS[i]]).catch(() => undefined)
      // A table error the member should see keeps its code; anything else is the server's
      throw failed.reason instanceof AppError ? failed.reason : new ClubError('serverError', {}, 500)
    }
    for (const result of opened) if (result.status === 'fulfilled') this.applyEntry(result.value)
    await this.matches.started(match.id, deals, ids)
  }

  /**
   * A member playing a team match plays there and nowhere else until it ends (§5.8, AC-8.4):
   * `inMatch` for any other table, `matchOtherRoom` for the other room of their own match. The
   * table checks the other room again with its own state
   */
  private checkNotInMatch(userId: string, target?: TableEntry) {
    const match = this.matches.playingOf(userId)
    if (!match) return
    if (target?.match?.matchId !== match.id) throw new ClubError('inMatch')
    const mine = match.seats.find((s) => s.userId === userId)
    if (mine && mine.room !== target.match.room) throw new ClubError('matchOtherRoom', {}, 403)
  }

  /** Everyone at a match's tables, seated or watching: they see its score as it changes */
  private matchWatchers(matchId: string): string[] {
    const people = new Set<string>()
    for (const entry of this.directory.values()) {
      if (entry.match?.matchId !== matchId) continue
      for (const seat of SEATS) if (entry.seats[seat] && !isRobotId(entry.seats[seat])) people.add(entry.seats[seat]!)
      for (const id of entry.spectators) people.add(id)
    }
    return [...people]
  }

  /**
   * A room finished a board of its match (`e8-t08`, `e8-t10`): the result is written once; once
   * both rooms played the board its two records are shown to everyone (until then only its own
   * four players see each, §4), the new score goes to everyone in the match and at its tables, and
   * the last board finishes the match (`e8-t11`)
   */
  private async teamBoardFinished(event: Extract<EventReport, { kind: 'team' }>) {
    if (!event.result) return
    const outcome = this.matches.addResult(event.matchId, event.seq, event.room, event.result)
    if (!outcome) return
    await this.revealRecords(revealBoards(this.store.sql, outcome.reveal, this.now()))
    if (outcome.finished) await this.endMatch(event.matchId)
    this.matches.push(event.matchId)
  }

  /**
   * A match whose every board is done (`e8-t11`): finished, its tables told (nothing more is dealt;
   * each closes once its people leave), any board still kept back shown to everyone, and everyone
   * in it told
   */
  private async endMatch(matchId: string) {
    await this.matches.finish(matchId)
    await this.matchTablesEnded(matchId)
  }

  /** The match ended (finished or abandoned): its tables are told, and every board of it is shown to everyone */
  private async matchTablesEnded(matchId: string) {
    for (const entry of [...this.directory.values()])
      if (entry.match?.matchId === matchId) this.applyResult(entry.id, await this.tables.get(entry.id).matchEnded())
    await this.revealRecords(revealEvent(this.store.sql, matchId, this.now()))
  }

  /** A match's tables in the directory, by room */
  private matchTables(matchId: string): Partial<Record<Room, TableEntry>> {
    const found: Partial<Record<Room, TableEntry>> = {}
    for (const entry of this.directory.values()) if (entry.match?.matchId === matchId) found[entry.match.room] = entry
    return found
  }

  /** Where each room of a match is and whom robots sit in for (代打), from the directory (§5.8) */
  private matchLive(matchId: string): { rooms: Partial<Record<Room, RoomClock>>; sittingIn: string[] } {
    const rooms: Partial<Record<Room, RoomClock>> = {}
    const sittingIn: string[] = []
    for (const [room, entry] of Object.entries(this.matchTables(matchId)) as [Room, TableEntry][]) {
      const startedAt = entry.match?.startedAt
      rooms[room] = { seq: entry.boardNo, playing: entry.playing, ...(startedAt !== undefined && { startedAt }) }
      sittingIn.push(...Object.values(entry.substitutes).filter((id): id is string => !!id))
    }
    return { rooms, sittingIn }
  }

  /**
   * What the host does while a match is played over HTTP (`POST /api/matches/:id/rule|pause|…`):
   * the same shape checks and rate limit as the socket, in the member's lane; answers the match
   * as they now see it
   */
  async matchPlayRequest(userId: string, message: MatchPlayAction): Promise<TeamMatchView | null> {
    const parsed = parseClientMessage(JSON.stringify(message))
    if ('error' in parsed) throw new ClubError(parsed.error)
    if (!this.actionLimit.take(userId)) throw new ClubError('slowDown', {}, 429)
    await this.inLane(userId, () => this.batch(() => this.matchPlay(userId, parsed.message as MatchPlayAction)))
    this.broadcast()
    return this.matches.get(String(message.matchId), userId)
  }

  /**
   * The exceptions while a match is played (§5.8, `e8-t14`–`e8-t16`): the match's rules are checked
   * and written by `TeamMatchService`; the club tells the tables (`matchUpdate`) and pushes the match
   */
  private async matchPlay(userId: string, message: MatchPlayAction) {
    const matchId = String(message.matchId)
    switch (message.type) {
      case 'matchRule': {
        // e8-t15: the room playing the board puts it away; the board is done, so its records are shown
        const { seq, reveal, finished } = this.matches.rule(userId, message)
        for (const entry of Object.values(this.matchTables(matchId)))
          this.applyResult(entry.id, await this.tables.get(entry.id).matchUpdate({ ruled: seq }))
        await this.revealRecords(revealBoards(this.store.sql, reveal, this.now()))
        if (finished) await this.endMatch(matchId)
        break
      }
      case 'matchPause': {
        const { changed } = this.matches.pause(userId, matchId, message.paused)
        if (changed)
          for (const entry of Object.values(this.matchTables(matchId)))
            this.applyResult(entry.id, await this.tables.get(entry.id).matchUpdate({ paused: message.paused }))
        break
      }
      case 'matchAbandon':
        await this.matches.abandon(userId, matchId)
        await this.matchTablesEnded(matchId)
        break
      case 'matchReplace': {
        // Someone watching the match has seen its boards: they may not come in (e11-t13)
        const newcomer = message.userId
        const watching = typeof newcomer === 'string' ? this.entryOf(newcomer) : undefined
        if (watching?.match?.matchId === matchId && watching.spectators.includes(newcomer) && this.matches.get(matchId, userId))
          throw new ClubError('matchWatching', { name: this.users.get(newcomer)?.username ?? '' })
        const replaced = await this.matches.replace(userId, message)
        await this.leave(replaced.newcomer)
        const user = this.users.get(replaced.newcomer)!
        const person = { id: user.id, username: user.username, blocked: this.blocks.of(user.id) }
        for (const [room, entry] of Object.entries(this.matchTables(matchId)) as [Room, TableEntry][])
          this.applyResult(
            entry.id,
            await this.tables.get(entry.id).matchUpdate({
              players: replaced.players,
              ...(room === replaced.room && { replace: { seat: replaced.seat, person } }),
            }),
          )
        break
      }
      case 'matchSitIn': {
        const { at } = this.matches.sitIn(userId, message)
        const entry = this.matchTables(matchId)[at.room]
        if (entry) this.applyResult(entry.id, await this.tables.get(entry.id).matchUpdate({ sitIn: at.seat }))
        break
      }
    }
    this.matches.push(matchId)
  }

  /** Rewrites the records whose index rows were just brought forward, so they read as shown from now */
  private async revealRecords(boardIds: string[]) {
    const now = this.now()
    for (const boardId of boardIds) {
      const record = await this.store.get<BoardRecord>(`board:${boardId}`)
      if (record) await this.writeRecord({ ...record, revealAt: now })
    }
  }

  // ── Tables (the directory, ARCHITECTURE.md §5.10) ───────────────────────────────────────────

  /** The table a member is at (seated or watching), from the directory */
  private entryOf(userId: string): TableEntry | undefined {
    return [...this.directory.values()].find((t) => t.spectators.includes(userId) || SEATS.some((s) => t.seats[s] === userId))
  }

  private seatIn(entry: TableEntry, userId: string): Seat | null {
    return SEATS.find((s) => entry.seats[s] === userId) ?? null
  }

  private requireEntry(tableId: unknown): TableEntry {
    const entry = typeof tableId === 'string' ? this.directory.get(tableId) : undefined
    if (!entry) throw new ClubError('tableGone', {}, 404)
    return entry
  }

  /** A member as a table needs them: name and blocks (§5.10) */
  private person(userId: string): Person {
    return { id: userId, username: this.users.get(userId)!.username, blocked: this.blocks.of(userId) }
  }

  private async createTable(userId: string, wanted?: unknown, invitees?: unknown) {
    const settings = parseTableSettings(wanted)
    if (!settings) throw new ClubError('badTableSettings')
    const invited = this.checkInvitees(userId, invitees)
    this.checkNotInMatch(userId)
    await this.leave(userId)
    const used = new Set([...this.directory.values()].map((t) => t.number))
    let number = 1
    while (used.has(number)) number++
    const username = this.users.get(userId)!.username
    const table: Table = {
      id: randomId(6),
      number,
      hostId: userId,
      seats: { N: null, E: null, S: userId, W: null },
      spectators: [],
      boardsPlayed: 0,
      board: null,
      chat: [],
      createdAt: this.now(),
      mode: 'casual',
      settings: { ...DEFAULT_TABLE_SETTINGS, ...settings },
      names: { [userId]: username },
      blocks: { [userId]: this.blocks.of(userId) },
    }
    if (invited) {
      table.invited = invited
      for (const id of invited) table.names![id] = this.users.get(id)!.username
    }
    this.applyEntry(await this.tables.get(table.id).open(table))
    for (const id of invited ?? []) await this.notifications.notify(id, 'tableInvited', { tableId: table.id, number, username })
  }

  /**
   * Opens the member's own practice table (§5.11, `e10-t03`): South, three TKB of the chosen system,
   * boards dealt to a preset or the member's conditions, Just Declare if asked. Like a challenge
   * table it is not in the lobby and nobody else comes to it; it closes when the member leaves.
   * Conditions that cannot be met are turned down here, before the member leaves their table
   */
  private async createPractice(userId: string, wanted: unknown) {
    const parsed = parsePracticeSettings(wanted)
    if ('field' in parsed) throw new ClubError('badPracticeSettings', { field: parsed.field })
    const { settings } = parsed
    const conditions = practiceConditions(settings)
    if (conditions && !dealWith(conditions, quickRandom(this.random), PRACTICE_MAX_ATTEMPTS).ok) throw new ClubError('dealTooStrict')
    this.checkNotInMatch(userId)
    await this.leave(userId)
    const kind = settings.robotKind
    const state: PracticeTableState = { ...settings, dealt: 0 }
    const table: Table = {
      id: randomId(6),
      // Practice tables are not in the lobby and take no number from it
      number: 0,
      hostId: userId,
      seats: { N: robotId(kind, 'N'), E: robotId(kind, 'E'), S: userId, W: robotId(kind, 'W') },
      spectators: [],
      boardsPlayed: 0,
      board: null,
      chat: [],
      createdAt: this.now(),
      mode: 'practice',
      modeState: state,
      settings: { visibility: 'invite', allowKibitz: false, boardMinutes: 0 },
      names: { [userId]: this.users.get(userId)!.username },
      blocks: { [userId]: this.blocks.of(userId) },
    }
    // The table deals its first board as it opens
    this.applyEntry(await this.tables.get(table.id).open(table))
  }

  /**
   * Checks an invitation list (`e2-t25`): other members, each once, at most LIMITS.tableInvitesMax;
   * not one the host blocked, nor one who blocked the host (they only hear the member cannot be invited)
   */
  private checkInvitees(userId: string, invitees: unknown): string[] | undefined {
    if (invitees === undefined) return undefined
    if (!Array.isArray(invitees) || invitees.length > LIMITS.tableInvitesMax || new Set(invitees).size !== invitees.length)
      throw new ClubError('badTableSettings')
    for (const id of invitees) {
      const other = this.otherMember(userId, id)
      const name = this.users.get(other)!.username
      if (this.blocks.has(userId, other)) throw new ClubError('unblockFirst')
      if (this.blocks.has(other, userId)) throw new ClubError('cannotInvite', { name }, 403)
    }
    return invitees as string[]
  }

  /**
   * 快速入座 (`e2-t30`): the public table (or one the member is invited to) that is closest to
   * starting, in the lobby's order (`shared/lobby.ts`); when none is short of players a new table
   * opens. A member already seated somewhere keeps that seat if nothing else needs them
   */
  private async quickSeat(userId: string) {
    this.checkNotInMatch(userId)
    const here = this.entryOf(userId)
    const seated = !!here && !!this.seatIn(here, userId)
    const open = [...this.directory.values()].filter(
      (t) =>
        !soloTable(t.mode) &&
        t.mode !== 'team' &&
        !(seated && t.id === here!.id) &&
        this.invitedTo(userId, t) &&
        !this.blocks.has(t.hostId, userId),
    )
    const choice = quickSeatChoice(open)
    if (choice) return this.sit(userId, choice.table, choice.seat)
    if (!seated) return this.createTable(userId)
  }

  private async joinTable(userId: string, entry: TableEntry) {
    if (this.entryOf(userId)?.id === entry.id) return
    // Someone else's challenge or practice table is not there for anyone to see
    if (soloTable(entry.mode)) throw new ClubError('tableGone', {}, 404)
    this.checkNotInMatch(userId, entry)
    this.checkWelcome(userId, entry)
    // A table without kibitzers takes people only into its seats (`e2-t26`)
    if (!entry.settings.allowKibitz) throw new ClubError('noKibitzing', {}, 403)
    await this.leave(userId)
    this.applyEntry(await this.tables.get(entry.id).join(this.person(userId)))
  }

  /**
   * Takes a seat. What the directory shows is checked here, before the member leaves any other
   * table; the table checks again with its own state (§5.10)
   */
  private async sit(userId: string, entry: TableEntry, seat: Seat) {
    const current = this.entryOf(userId)
    const here = current?.id === entry.id
    const currentSeat = here ? this.seatIn(entry, userId) : null
    if (currentSeat === seat) return
    if (soloTable(entry.mode)) {
      if (here) throw fixedTable(entry.mode)
      throw new ClubError('tableGone', {}, 404)
    }
    // The match seats its players; nobody sits down at its tables or moves there (§5.8)
    if (entry.mode === 'team') {
      this.checkNotInMatch(userId, entry)
      throw new ClubError('matchTableFixed')
    }
    this.checkNotInMatch(userId)
    if (!here) this.checkWelcome(userId, entry)
    // A person may take a robot's seat at any time, as on BBO
    const occupant = entry.seats[seat]
    if (occupant && !isRobotId(occupant)) throw new ClubError('seatTaken')
    if (currentSeat && entry.playing) throw new ClubError('noSeatChange')
    if (!here) await this.leave(userId)
    this.applyEntry(await this.tables.get(entry.id).sit(this.person(userId), seat))
  }

  private async leave(userId: string) {
    const entry = this.entryOf(userId)
    if (!entry) return
    this.applyResult(entry.id, await this.tables.get(entry.id).leave(userId))
  }

  /** The host changes how the table is run; only the fields sent change, and the invitation list when sent */
  private async updateTableSettings(userId: string, wanted: unknown, invitees?: unknown) {
    const entry = this.entryOf(userId)
    if (!entry) throw new ClubError('notAtTable')
    if (entry.hostId !== userId) throw new ClubError('hostOnly')
    if (soloTable(entry.mode)) throw fixedTable(entry.mode)
    if (entry.mode === 'team') throw new ClubError('matchTableFixed')
    const settings = parseTableSettings(wanted)
    if (!settings) throw new ClubError('badTableSettings')
    const invited = this.checkInvitees(userId, invitees)
    const before = new Set(entry.invited)
    const named = invited?.map((id) => ({ id, username: this.users.get(id)!.username }))
    this.applyEntry(await this.tables.get(entry.id).configure(userId, settings, named))
    const username = this.users.get(userId)!.username
    for (const id of invited ?? [])
      if (!before.has(id))
        await this.notifications.notify(id, 'tableInvited', { tableId: entry.id, number: entry.number, username })
  }

  /** A table action (bidding, play, chat, the host's seat changes): the member's own table handles it */
  private async tableAction(userId: string, message: TableAction) {
    const entry = this.entryOf(userId)
    if (!entry) {
      if (message.type === 'stand' || message.type === 'chat') return
      if (HOST_ACTIONS.has(message.type)) throw new ClubError('notAtTable')
      throw new ClubError('notSeated')
    }
    this.applyResult(entry.id, await this.tables.get(entry.id).act(userId, message))
  }

  /** Closes a table (an admin, a challenge closed) */
  private async closeTable(tableId: string) {
    await this.tables.get(tableId).close()
    this.tableClosed(tableId)
  }

  /**
   * A table's report (`ClubLink.changed`, or the answer to a call): kept unless an older one than
   * what the directory has. The lobby goes out at once, unless a club action is under way (it
   * sends everything when it ends)
   */
  private applyEntry(entry: TableEntry) {
    if (this.closedTables.has(entry.id)) return
    const known = this.directory.get(entry.id)
    if (known && known.rev >= entry.rev) return
    this.directory.set(entry.id, entry)
    // Tables in their own objects: the directory is kept, so the lobby lists them after an eviction
    // without waking every table
    if (this.remote) void this.store.put(`tabledir:${entry.id}`, entry)
    // A match room dealt a board or a robot sat in for someone: the match page shows it (§5.8)
    if (entry.match && !entry.match.ended && matchMoved(known, entry)) this.matches.push(entry.match.matchId)
    if (!this.busy) this.broadcast()
  }

  /** A table's answer: its entry, or null when it closed */
  private applyResult(tableId: string, entry: TableEntry | null) {
    if (entry) this.applyEntry(entry)
    else this.tableClosed(tableId)
  }

  /** A table closed (`ClubLink.closed`) */
  private tableClosed(tableId: string) {
    this.closedTables.add(tableId)
    // Only the latest ids are needed to drop a late report
    if (this.closedTables.size > CLOSED_KEPT) this.closedTables.delete(this.closedTables.values().next().value!)
    if (this.remote) void this.store.delete(`tabledir:${tableId}`)
    if (!this.directory.delete(tableId)) return
    if (!this.busy) this.broadcast()
  }

  /**
   * A board finished at a table (`ClubLink.boardFinished`): its record goes into the history, and
   * a challenge board's result into the challenge (once: the same record twice changes nothing).
   * The last board of the last participant finishes the challenge before its deadline
   */
  private async boardFinished(record: BoardRecord, event: EventReport | null) {
    await this.saveRecord(record)
    if (event?.kind === 'team') return this.teamBoardFinished(event)
    if (event?.kind !== 'challenge') return
    if (event.result) this.addChallengeResult(event.challengeId, event.result)
    await this.challengeChanged(event.challengeId)
  }

  /** Writes a challenge board's result, checked against the challenge as it is now; the last one marks the participant finished */
  private addChallengeResult(challengeId: string, result: ChallengeResult) {
    const c = this.challenges.get(challengeId)
    // A board finished after the deadline does not count, like one not played
    if (!c || !challengeTakesPart(c, this.now())) return
    const player = c.players.find((p) => p.userId === result.userId)
    if (!player || c.results.some((r) => r.userId === result.userId && r.seq === result.seq)) return
    this.challenges.transaction(() => {
      this.challenges.addResult(c.id, result)
      if (playedSeqs(c, result.userId).size + 1 >= c.deals.boards.length)
        this.challenges.updatePlayer(c.id, { ...player, finishedAt: this.now() })
    })
  }

  /**
   * Brings an older table up to what a table keeps now (§5.10): the names and blocks it shows, and
   * a challenge table's snapshot of its challenge. Returns the same object when nothing changed
   */
  private upgradeTable(table: Table): Table {
    const people = new Set<string>([
      ...SEATS.map((s) => table.seats[s]).filter((id): id is string => !!id && !isRobotId(id)),
      ...table.spectators,
      ...(table.invited ?? []),
      ...Object.values(table.substitutes ?? {}),
      table.hostId,
    ])
    const state = challengeStateOf(table)
    if (state) people.add(state.userId)
    const names: Record<string, string> = { ...table.names }
    for (const id of people) {
      const user = this.users.get(id)
      if (user) names[id] = user.username
    }
    const blocks: Record<string, string[]> = {}
    for (const id of people) if (this.users.has(id)) blocks[id] = this.blocks.of(id)
    let modeState = table.modeState
    if (state && state.deadline === undefined) {
      const challenge = this.challenges.get(state.challengeId)
      modeState = {
        ...state,
        ...(challenge
          ? challengeSnapshot(challenge, state.userId, this.now())
          : { deadline: 0, boards: [], played: [], robotKind: 'tku', closed: true }),
      } satisfies ChallengeTableState
    }
    const upgraded: Table = { ...table, names, blocks, modeState }
    return JSON.stringify(upgraded) === JSON.stringify(table) ? table : upgraded
  }

  // ── Broadcasting ────────────────────────────────────────────────────────────────────────────

  /**
   * Sends every online member the lobby, but only when it changed for them: a card played at one
   * table sends nothing to people in the lobby. Each table sends its own view to the people at it;
   * the club only tells a member who is at no table any more (`table: null`)
   */
  broadcast() {
    const online = this.connections.onlineUserIds()
    for (const userId of online) {
      const sent = this.sent.get(userId) ?? {}
      this.sent.set(userId, sent)

      const lobby = this.lobbyView(userId, online)
      const lobbyJson = JSON.stringify(lobby)
      if (lobbyJson !== sent.lobby) {
        sent.lobby = lobbyJson
        this.connections.send(userId, { type: 'lobby', lobby })
      }

      const at = this.entryOf(userId)
      if (at) {
        sent.table = at.id
        continue
      }
      if (sent.table !== 'null') this.connections.send(userId, { type: 'table', table: null, now: this.now() })
      sent.table = 'null'
    }
  }

  lobbyView(userId: string, online = this.connections.onlineUserIds()): LobbyView {
    const isOnline = (id: string) => isRobotId(id) || online.includes(id)
    const mine = this.entryOf(userId)
    const tables: TableSummary[] = [...this.directory.values()]
      // A challenge or practice table is its player's alone and is not listed (§5.5, §5.11); a
      // match's tables are listed with their match (`matches`, §5.8)
      .filter((t) => !soloTable(t.mode) && t.mode !== 'team')
      // Tables short of players first, the closest to starting on top (AC-2.11)
      .sort(lobbyOrder)
      .map((t) => ({
        id: t.id,
        number: t.number,
        hostName: this.users.get(t.hostId)?.username ?? '—',
        settings: t.settings,
        welcome: this.invitedTo(userId, t),
        seats: this.occupants(t, isOnline),
        spectators: t.spectators.length,
        boardsPlayed: t.boardsPlayed,
        boardNo: t.boardNo,
      }))
    const members: MemberStatus[] = [...this.users.values()]
      .map((u) => {
        const found = this.entryOf(u.id)
        const table = soloTable(found?.mode) || found?.mode === 'team' ? undefined : found
        return {
          id: u.id,
          username: u.username,
          online: online.includes(u.id),
          tableNumber: table?.number ?? null,
          seat: table ? this.seatIn(table, u.id) : null,
        }
      })
      // Online first; within each, the viewer's friends on top (好友置頂)
      .sort(
        (a, b) =>
          Number(b.online) - Number(a.online) ||
          Number(this.friends.has(userId, b.id)) - Number(this.friends.has(userId, a.id)) ||
          a.username.localeCompare(b.username),
      )
    return {
      online: online.flatMap((id) => this.publicUserById(id) ?? []),
      members,
      tables,
      myTableId: mine?.id ?? null,
      ...(mine && soloTable(mine.mode) && { myTableMode: mine.mode }),
      friends: this.friends.of(userId),
      blocked: this.blocks.of(userId),
      matches: this.liveMatches(),
    }
  }

  /** The team matches being played, from the directory (their tables say which match and room), oldest first */
  private liveMatches(): LiveMatch[] {
    const found = new Map<string, LiveMatch>()
    for (const entry of this.directory.values()) {
      if (!entry.match || entry.match.ended) continue
      const live = found.get(entry.match.matchId) ?? { id: entry.match.matchId, teamNames: entry.match.teamNames, tables: {} }
      live.tables[entry.match.room] = entry.id
      found.set(live.id, live)
    }
    return [...found.values()]
  }

  /** The seats as everyone sees them, a robot sitting in for someone marked with their name (代打) */
  private occupants(entry: TableEntry, isOnline: (id: string) => boolean) {
    const seats = seatOccupants(entry, (id) => this.publicUserById(id), isOnline)
    for (const seat of SEATS) {
      const forWhom = entry.substitutes[seat]
      const name = forWhom && this.users.get(forWhom)?.username
      if (seats[seat]?.robot && name) seats[seat] = { ...seats[seat], substituteFor: name }
    }
    return seats
  }

  private publicUserById(id: string): PublicUser | undefined {
    if (isRobotId(id)) return robotUser(id)
    const user = this.users.get(id)
    return user && { id: user.id, username: user.username }
  }
}
