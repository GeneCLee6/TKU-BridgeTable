import { isCall } from '../shared/auction.ts'
import { secureRandomInt, type RandomInt } from '../shared/board.ts'
import { isCard, isSeat, partnerOf, sameSide, SEATS, type Seat } from '../shared/cards.ts'
import {
  claimApprovers,
  controllerOf,
  dummyOf,
  legalCards,
  makeCall,
  makeClaim,
  newBoard,
  playCard,
  remainingCards,
  respondToClaim,
  turnOf,
  undoFor,
  type BoardState,
} from '../shared/game.ts'
import { AppError, type MessageCode, type MessageParams } from '../shared/messages.ts'
import {
  DEAL_COUNTDOWN_MS,
  DEFAULT_TABLE_SETTINGS,
  HISTORY_PAGE_SIZES,
  isPermission,
  isRobotId,
  LAST_TRICK_MS,
  LIMITS,
  parseTableSettings,
  PERMISSIONS,
  isRobotKind,
  robotId,
  robotKindOf,
  SLOW_TURN_MS,
  SUBSTITUTE_MS,
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
  type LobbyView,
  type Me,
  type MemberStatus,
  type Permission,
  type PublicUser,
  type RobotKind,
  type ServerMessage,
  type Site,
  type TableSettings,
  type TableChallenge,
  type TableSummary,
  type TableView,
  type TableWire,
} from '../shared/protocol.ts'
import { ruleBrain, type RobotBrain } from '../shared/robot/brain.ts'
import type { RobotBid } from '../shared/robot/robots.ts'
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
import { DEAL_SET_MAX, dealSourceOf, makeDealSet, type DealSet, type DealSetBoard } from '../shared/deal-set.ts'
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
import { TeamMatchService } from './team-match-service.ts'
import { TeamMatchStore } from './team-matches.ts'
import { createHistoryIndex, eventBoards, indexRecord, revealEvent, searchBoards, unindexRecord } from './history-index.ts'
import { challengeStateOf, modeOf, nextSeq, playedSeqs, type ChallengeTableState, type ModeContext } from './modes.ts'
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
import type { Store } from './store.ts'
import { parseClientMessage } from '../shared/message-guard.ts'
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
  boardView,
  challengeBoardVisible,
  challengeTraveller,
  challengeView,
  chatFor,
  recordVisible,
  seatOccupants,
  type Table,
} from './views.ts'

/** An error shown to the user; the code is translated in the browser */
export class ClubError extends AppError {
  constructor(code: MessageCode, params: MessageParams = {}, status = 400) {
    super(code, params, status)
  }
}

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
}

export type ScheduleKind = JobKind

const CHAT_KEEP = 100
/** Boards a table keeps for its History panel */
const RECENT_KEEP = 30
/** 2: history indexes in KV (`hist:`, `uhist:`); 3: the SQL history index as well */
const SCHEMA = 3
/** Boards indexed per step of the backfill; the position is saved after each step */
const BACKFILL_BATCH = 100
/**
 * How long robots wait before acting, so people can follow the play: a card glides to the middle
 * for 1.3 s, and a finished trick stays on the table until its winner leads again
 */
const ROBOT_DELAY = { call: 800, card: 1400, afterTrick: 3000, answer: 400 }
const ROBOT_NAME = 'Robot'
/** The most a robot brain may think per action before the rule robot answers instead (AC-6.5) */
const THINK_LIMIT_MS = 2000

/** A robot's move, once its brain has answered */
interface RobotAnswer {
  message: ClientMessage
  meaning?: RobotBid['meaning']
}

/** A table's settings; a field saved by an older version (a robot level) is dropped */
function settingsOf(table: Table): TableSettings {
  const { visibility, allowKibitz, boardMinutes } = { ...DEFAULT_TABLE_SETTINGS, ...table.settings }
  return { visibility, allowKibitz, boardMinutes }
}

/**
 * Accounts, tables and boards for one bridge club. All state lives in memory and every change is
 * written through to the store, so the Durable Object can be evicted and reloaded at any time.
 *
 * History is kept as one key per board (`board:<id>`) plus two small, time-ordered indexes of
 * summaries (`hist:` for everyone, `uhist:<userId>:` per member), so listing a page of history
 * reads only that page no matter how many boards the club has played.
 */
/** The challenge actions the pages send over HTTP (`ClubService.challengeRequest`) */
export type ChallengeRequest = Extract<
  ClientMessage,
  { type: 'createChallenge' | 'answerChallenge' | 'cancelChallenge' | 'rematchChallenge' }
>

export class ClubService {
  private users = new Map<string, StoredUser>()
  private applications = new Map<string, StoredApplication>()
  private tables = new Map<string, Table>()
  private settings: Partial<ClubSettings> = {}
  private readonly store: Store
  private readonly connections: Connections
  private readonly config: ClubConfig
  private readonly now: () => number
  private readonly random: RandomInt
  private readonly brain: RobotBrain
  /** Tables whose robot is thinking; nothing else is scheduled for them until it answers */
  private readonly thinking = new Set<string>()
  /** Since when each seated member who dropped offline has been away, for their robot substitute (代打) */
  private readonly offlineSince = new Map<string, number>()
  /** Robot moves and the next deal of every table, keyed `robot:<tableId>` and `deal:<tableId>` */
  private readonly scheduler: Scheduler
  /** The scheduler, when it is the alarm queue (not the tests' manual one) */
  private readonly queue?: AlarmQueue
  /**
   * What each member was last sent (as JSON), so an update that changes nothing for them is not
   * sent at all, and the chat and recent boards only go out when they change
   */
  private readonly sent = new Map<
    string,
    { lobby?: string; table?: string; chat?: string; recent?: string; notifications?: string; directs?: string }
  >()
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
  /** Two-table team matches, kept in SQL (§5.7); set up over HTTP, played in later batches */
  readonly matches: TeamMatchService
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
    this.brain = config.brain ?? ruleBrain
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
    })
    this.directs = new DirectMessageStore(store.sql)
    if (config.schedule) {
      this.scheduler = manualScheduler(config.schedule)
    } else {
      const wake = config.wake ?? ((at: number) => void setTimeout(() => void this.runDue(), Math.max(0, at - this.now())))
      this.scheduler = this.queue = new AlarmQueue(this.now, wake)
    }
  }

  /** Runs the robot moves and deals that are due (the Durable Object's alarm) */
  async runDue() {
    await this.queue?.runDue()
  }

  async load() {
    for (const user of (await this.store.list<StoredUser>('user:')).values()) this.users.set(user.id, user)
    for (const application of (await this.store.list<StoredApplication>('app:')).values())
      this.applications.set(application.id, application)
    for (const table of (await this.store.list<Table>('table:')).values()) this.tables.set(table.id, table)
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
    const online = this.connections.onlineUserIds()
    for (const table of this.tables.values()) {
      this.scheduleRobots(table)
      this.scheduleDeal(table)
      // Who was away before the object was evicted is counted as away from now
      for (const seat of SEATS) {
        const id = table.seats[seat]
        if (id && !isRobotId(id) && !online.includes(id) && table.mode !== 'challenge') this.awayFrom(id, this.now())
      }
    }
    // Jobs are not stored: each open challenge's reminder or deadline is scheduled again
    for (const id of this.challenges.openIds()) this.scheduleChallenge(id)
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
    await this.leave(user.id)
    // Their challenges forget them, so their parked challenge tables go too
    for (const table of [...this.tables.values()]) {
      if (challengeStateOf(table)?.userId === user.id) {
        await this.dropTable(table)
        continue
      }
      // Invitations and robot substitutes for them are forgotten; the robot stays in the seat
      const invited = table.invited?.filter((id) => id !== user.id)
      const seat = this.substituteSeat(table, user.id)
      if (invited?.length === table.invited?.length && !seat) continue
      if (table.invited) table.invited = invited
      if (seat) delete table.substitutes![seat]
      await this.save(table)
    }
    this.offlineSince.delete(user.id)
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
    this.broadcast()
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
    const table = this.requireTable(tableId)
    this.tables.delete(table.id)
    await this.store.delete(`table:${table.id}`)
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
    this.offlineSince.delete(userId)
    void this.takeBackSeat(userId)
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
    const table = this.tableOf(userId)
    if (table && table.spectators.includes(userId)) {
      table.spectators = table.spectators.filter((id) => id !== userId)
      this.checkHost(table)
      await this.saveOrDrop(table)
    } else if (table) {
      this.checkHost(table)
      await this.save(table)
      // Away for SUBSTITUTE_MS, TKB plays for them until they come back (代打)
      if (table.mode !== 'challenge') this.awayFrom(userId, this.now())
    }
    this.broadcast()
    this.matches.presence(userId)
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
    return { ok: true, now: this.now(), tables: this.tables.size, online: this.connections.onlineUserIds().length }
  }

  async handle(userId: string, message: ClientMessage) {
    const started = this.now()
    const type = typeof message?.type === 'string' ? message.type : '?'
    try {
      await this.dispatch(userId, message)
    } catch (error) {
      if (error instanceof AppError) {
        this.log({ event: 'action', type, user: userId, ms: this.now() - started, code: error.code })
        this.connections.send(userId, { type: 'error', code: error.code, params: error.params, message: error.message })
        return
      }
      throw error
    }
    this.broadcast()
    const table = this.tableOf(userId)
    if (table) this.scheduleRobots(table)
    this.log({ event: 'action', type, user: userId, ms: this.now() - started })
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
      case 'joinTable':
        return this.joinTable(userId, this.requireTable(message.tableId))
      case 'sit':
        if (!isSeat(message.seat)) throw new ClubError('badSeat')
        return this.sit(userId, this.requireTable(message.tableId), message.seat)
      case 'stand':
        return this.stand(userId)
      case 'leaveTable':
        return this.leave(userId)
      case 'kick':
        return this.kick(userId, message.seat)
      case 'addRobot':
        return this.addRobot(userId, message.seat, message.kind)
      case 'removeRobot':
        return this.removeRobot(userId, message.seat)
      case 'replaceWithRobot':
        return this.replaceWithRobot(userId, message.seat, message.kind)
      case 'chat':
        return this.chat(userId, message.text)
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
      case 'call':
      case 'play':
      case 'claim':
      case 'claimRespond':
      case 'undoRequest':
      case 'undoRespond':
        return this.boardAction(userId, message)
      default:
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
  }

  /**
   * A member the host blocked may not join the table, to sit or to watch; at an invite table only
   * the invited may (`e2-t25`)
   */
  private checkWelcome(userId: string, table: Table) {
    if (this.blocks.has(table.hostId, userId)) throw new ClubError('blockedByHost', {}, 403)
    if (!this.invitedTo(userId, table)) throw new ClubError('notInvited', {}, 403)
  }

  /** Whether a member may come to a table as far as invitations go: any public one, an invite one when invited or already there */
  private invitedTo(userId: string, table: Table): boolean {
    if (table.mode === 'challenge') return false
    if (settingsOf(table).visibility === 'public' || table.hostId === userId) return true
    return !!table.invited?.includes(userId) || this.tableOf(userId) === table
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
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > DEAL_SET_MAX || new Set(ids).size !== ids.length)
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
    const message = parsed.message as ChallengeRequest
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
    for (const table of [...this.tables.values()]) {
      const state = challengeStateOf(table)
      if (state?.challengeId !== challenge.id) continue
      const done = nextSeq(challenge, state.userId) === null && table.board?.phase === 'finished'
      if (done && this.humansSeated(table) > 0) continue
      await this.dropTable(table)
    }
    const now = this.now()
    for (const boardId of revealEvent(this.store.sql, challenge.id, now)) {
      const record = await this.store.get<BoardRecord>(`board:${boardId}`)
      if (record) await this.writeRecord({ ...record, revealAt: now })
    }
  }

  // ── Challenge tables (§5.5, e7-t08, e7-t12) ─────────────────────────────────────────────────

  /** A participant's table for a challenge, at it or parked */
  private challengeTable(challengeId: string, userId: string): Table | undefined {
    return [...this.tables.values()].find((t) => {
      const state = challengeStateOf(t)
      return state?.challengeId === challengeId && state.userId === userId
    })
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
    const existing = this.challengeTable(challenge.id, userId)
    if (!challengeTakesPart(challenge, this.now())) {
      if (existing && this.tableOf(userId) !== existing) await this.dropTable(existing)
      throw new ClubError('challengeClosed')
    }
    if (player.status !== 'accepted') throw new ClubError('challengeNotAccepted')
    if (existing && this.tableOf(userId) === existing) return
    if (player.knownDeals || (!existing && nextSeq(challenge, userId) === null)) throw new ClubError('challengeDone')
    await this.leave(userId)
    if (existing) {
      const state = challengeStateOf(existing)!
      existing.seats[state.parkedSeat ?? 'S'] = userId
      state.parkedSeat = undefined
      existing.hostId = userId
      this.startBoardIfReady(existing)
      await this.save(existing)
      return
    }
    const kind = challenge.settings.robotKind
    const state: ChallengeTableState = { challengeId: challenge.id, userId, seq: 0 }
    const table: Table = {
      id: randomId(6),
      // Challenge tables are not in the lobby and take no number from it
      number: 0,
      hostId: userId,
      seats: { N: robotId(kind, 'N'), E: robotId(kind, 'E'), S: userId, W: robotId(kind, 'W') },
      spectators: [],
      boardsPlayed: playedSeqs(challenge, userId).size,
      board: null,
      chat: [],
      createdAt: this.now(),
      mode: 'challenge',
      modeState: state,
      dealSource: dealSourceOf(challenge.deals),
      settings: { visibility: 'invite', allowKibitz: false, boardMinutes: 0 },
    }
    this.tables.set(table.id, table)
    this.startBoardIfReady(table)
    await this.save(table)
  }

  /**
   * Whether a challenge table has nothing left to play: the challenge is gone, closed or past its
   * deadline, or the participant finished every board and the last one is over
   */
  private challengeTableOver(table: Table): boolean {
    const state = challengeStateOf(table)
    if (!state) return false
    const challenge = this.challenges.get(state.challengeId)
    if (!challenge || !challengeTakesPart(challenge, this.now())) return true
    return nextSeq(challenge, state.userId) === null && (!table.board || table.board.phase === 'finished')
  }

  /** A challenge table whose challenge is gone, closed or past its deadline: nothing more is played there */
  private challengeClosedAt(table: Table): boolean {
    const state = challengeStateOf(table)
    if (!state) return false
    const challenge = this.challenges.get(state.challengeId)
    return !challenge || !challengeTakesPart(challenge, this.now())
  }

  /** At a challenge table nobody watches or takes back a call or card, and seats and settings stay */
  private checkNotChallenge(table: Table) {
    if (table.mode === 'challenge') throw new ClubError('challengeTableFixed')
  }

  /** What a challenge table's player sees of the challenge: which board of how many, until when */
  private tableChallenge(table: Table): TableChallenge | undefined {
    const state = challengeStateOf(table)
    const challenge = state && this.challenges.get(state.challengeId)
    if (!state || !challenge) return undefined
    return {
      id: challenge.id,
      seq: state.seq,
      boards: challenge.deals.boards.length,
      played: playedSeqs(challenge, state.userId).size,
      deadline: challenge.deadline,
    }
  }

  // ── Tables ──────────────────────────────────────────────────────────────────────────────────

  private tableOf(userId: string): Table | undefined {
    return [...this.tables.values()].find(
      (t) => t.spectators.includes(userId) || SEATS.some((s) => t.seats[s] === userId),
    )
  }

  private seatOf(table: Table, userId: string): Seat | null {
    return SEATS.find((s) => table.seats[s] === userId) ?? null
  }

  private humansSeated(table: Table) {
    return SEATS.filter((s) => table.seats[s] && !isRobotId(table.seats[s])).length
  }

  private requireTable(tableId: unknown): Table {
    const table = typeof tableId === 'string' ? this.tables.get(tableId) : undefined
    if (!table) throw new ClubError('tableGone', {}, 404)
    return table
  }

  private async createTable(userId: string, wanted?: unknown, invitees?: unknown) {
    const settings = parseTableSettings(wanted)
    if (!settings) throw new ClubError('badTableSettings')
    const invited = this.checkInvitees(userId, invitees)
    await this.leave(userId)
    const used = new Set([...this.tables.values()].map((t) => t.number))
    let number = 1
    while (used.has(number)) number++
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
    }
    this.tables.set(table.id, table)
    if (invited) await this.invite(table, userId, invited)
    await this.save(table)
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

  /** Replaces the table's invitation list; the members newly on it are told */
  private async invite(table: Table, hostId: string, invitees: string[]) {
    const before = new Set(table.invited ?? [])
    table.invited = invitees
    const username = this.users.get(hostId)!.username
    for (const id of invitees)
      if (!before.has(id))
        await this.notifications.notify(id, 'tableInvited', { tableId: table.id, number: table.number, username })
  }

  /**
   * 快速入座 (`e2-t30`): the public table (or one the member is invited to) that is closest to
   * starting, in the lobby's order (`shared/lobby.ts`); when none is short of players a new table
   * opens. A member already seated somewhere keeps that seat if nothing else needs them
   */
  private async quickSeat(userId: string) {
    const here = this.tableOf(userId)
    const seated = !!here && !!this.seatOf(here, userId)
    const open = [...this.tables.values()].filter(
      (t) => t.mode !== 'challenge' && !(seated && t === here) && this.invitedTo(userId, t) && !this.blocks.has(t.hostId, userId),
    )
    const choice = quickSeatChoice(open)
    if (choice) return this.sit(userId, choice.table, choice.seat)
    if (!seated) return this.createTable(userId)
  }

  private async joinTable(userId: string, table: Table) {
    if (this.tableOf(userId) === table) return
    // Someone else's challenge table is not there for anyone to see
    if (table.mode === 'challenge') throw new ClubError('tableGone', {}, 404)
    this.checkWelcome(userId, table)
    // A table without kibitzers takes people only into its seats (`e2-t26`)
    if (!settingsOf(table).allowKibitz) throw new ClubError('noKibitzing', {}, 403)
    await this.leave(userId)
    table.spectators.push(userId)
    await this.save(table)
  }

  private async sit(userId: string, table: Table, seat: Seat) {
    const current = this.tableOf(userId)
    const currentSeat = current === table ? this.seatOf(table, userId) : null
    if (currentSeat === seat) return
    if (table.mode === 'challenge') {
      if (current === table) this.checkNotChallenge(table)
      throw new ClubError('tableGone', {}, 404)
    }
    if (current !== table) this.checkWelcome(userId, table)
    // A person may take a robot's seat at any time, as on BBO
    const occupant = table.seats[seat]
    if (occupant && !isRobotId(occupant)) throw new ClubError('seatTaken')
    if (currentSeat && table.board && table.board.phase !== 'finished') throw new ClubError('noSeatChange')
    if (current !== table) await this.leave(userId)

    table.spectators = table.spectators.filter((id) => id !== userId)
    if (currentSeat) this.vacate(table, currentSeat)
    // A robot sitting in for someone offline gives the seat up for good
    if (table.substitutes?.[seat]) delete table.substitutes[seat]
    table.seats[seat] = userId
    this.touchTurn(table)
    this.startBoardIfReady(table)
    await this.save(table)
  }

  private async stand(userId: string) {
    const table = this.tableOf(userId)
    const seat = table && this.seatOf(table, userId)
    if (!table || !seat) return
    this.checkNotChallenge(table)
    this.vacate(table, seat)
    table.spectators.push(userId)
    await this.save(table)
  }

  private async leave(userId: string) {
    const table = this.tableOf(userId)
    if (!table) return
    const seat = this.seatOf(table, userId)
    const challenge = challengeStateOf(table)
    if (challenge) {
      // Leaving a challenge table only pauses it (中途斷線視同暫停): it waits with the board as it
      // was until they come back. One with nothing left to play closes
      if (this.challengeTableOver(table)) return this.dropTable(table)
      if (seat) {
        challenge.parkedSeat = seat
        this.vacate(table, seat)
      }
      return this.save(table)
    }
    if (seat) this.vacate(table, seat)
    table.spectators = table.spectators.filter((id) => id !== userId)
    this.checkHost(table)
    await this.saveOrDrop(table)
  }

  /** Only the host runs the table: asking people to leave a seat, adding and removing robots */
  private hostTable(userId: string) {
    const table = this.tableOf(userId)
    if (!table) throw new ClubError('notAtTable')
    if (table.hostId !== userId) throw new ClubError('hostOnly')
    this.checkNotChallenge(table)
    return table
  }

  /**
   * The host is whoever opened the table; when they leave or drop offline, the first person still
   * at the table and online takes over (a seated player before a spectator)
   */
  private checkHost(table: Table) {
    const online = this.connections.onlineUserIds()
    const people = [
      ...SEATS.map((s) => table.seats[s]).filter((id): id is string => !!id && !isRobotId(id)),
      ...table.spectators,
    ]
    if (people.includes(table.hostId) && online.includes(table.hostId)) return
    const next = people.find((id) => online.includes(id))
    if (next) table.hostId = next
  }

  /** The host changes how the table is run; only the fields sent change, and the invitation list when sent */
  private async updateTableSettings(userId: string, wanted: unknown, invitees?: unknown) {
    const table = this.hostTable(userId)
    const settings = parseTableSettings(wanted)
    if (!settings) throw new ClubError('badTableSettings')
    const invited = this.checkInvitees(userId, invitees)
    table.settings = { ...settingsOf(table), ...settings }
    if (invited) await this.invite(table, userId, invited)
    await this.save(table)
  }

  /** The host may ask anyone else to leave their seat; they stay at the table, watching */
  private async kick(userId: string, seat: unknown) {
    const table = this.hostTable(userId)
    if (!isSeat(seat)) throw new ClubError('badSeat')
    const occupant = table.seats[seat]
    if (!occupant || isRobotId(occupant)) return
    if (occupant === userId) throw new ClubError('notSelf')
    this.vacate(table, seat)
    table.spectators.push(occupant)
    await this.save(table)
  }

  /** Seats TKB: in the club's system unless the host chose 2/1 */
  private async addRobot(userId: string, seat: unknown, kind: unknown = 'tku') {
    const table = this.hostTable(userId)
    if (!isSeat(seat)) throw new ClubError('badSeat')
    if (!isRobotKind(kind)) throw new ClubError('unknownRobot')
    if (table.seats[seat]) throw new ClubError('seatTaken')
    table.seats[seat] = robotId(kind, seat)
    this.startBoardIfReady(table)
    await this.save(table)
  }

  private async removeRobot(userId: string, seat: unknown) {
    const table = this.hostTable(userId)
    if (!isSeat(seat)) throw new ClubError('badSeat')
    if (!isRobotId(table.seats[seat])) throw new ClubError('seatNotRobot')
    this.vacate(table, seat)
    await this.save(table)
  }

  /**
   * The host asks a player who has kept the table waiting for SLOW_TURN_MS to leave their seat
   * and seats TKB there (`e2-t28`); the player stays at the table without a seat, as after `kick`
   */
  private async replaceWithRobot(userId: string, seat: unknown, kind: unknown = 'tku') {
    const table = this.hostTable(userId)
    if (!isSeat(seat)) throw new ClubError('badSeat')
    if (!isRobotKind(kind)) throw new ClubError('unknownRobot')
    const occupant = table.seats[seat]
    if (occupant === userId) throw new ClubError('notSelf')
    if (!occupant || isRobotId(occupant) || this.waitingOn(table) !== seat) throw new ClubError('notSlow')
    if (this.now() - (table.turnSince ?? 0) < SLOW_TURN_MS) throw new ClubError('notSlow')
    this.vacate(table, seat)
    table.seats[seat] = robotId(kind, seat)
    table.spectators.push(occupant)
    this.touchTurn(table)
    await this.save(table)
  }

  private vacate(table: Table, seat: Seat) {
    table.seats[seat] = null
    if (table.undo?.seat === seat) table.undo = undefined
    if (table.substitutes?.[seat]) delete table.substitutes[seat]
  }

  /** The table starts waiting on someone anew: the reminder clock (SLOW_TURN_MS) restarts */
  private touchTurn(table: Table) {
    table.turnSince = this.now()
  }

  /**
   * The seat whose person the table is waiting on for a call or card, if any: not while a claim or
   * an undo is being answered, and never a robot's
   */
  private waitingOn(table: Table): Seat | null {
    const board = table.board
    if (!board || board.phase === 'finished' || board.claim || table.undo) return null
    const turn = turnOf(board)
    if (!turn) return null
    const seat = board.phase === 'auction' ? turn : controllerOf(board, turn)
    const id = table.seats[seat]
    return id && !isRobotId(id) ? seat : null
  }

  // ── Robot substitutes (代打, e2-t31) ─────────────────────────────────────────────────────────

  /** The seat where a robot sits in for this member at the table, if any */
  private substituteSeat(table: Table, userId: string): Seat | undefined {
    return SEATS.find((seat) => table.substitutes?.[seat] === userId)
  }

  /** Notes that a seated member went offline at `since` and queues the job that seats their substitute */
  private awayFrom(userId: string, since: number) {
    if (!this.offlineSince.has(userId)) this.offlineSince.set(userId, since)
    const left = SUBSTITUTE_MS - (this.now() - this.offlineSince.get(userId)!)
    this.scheduler.add(`substitute:${userId}`, 'substitute', Math.max(0, left), () => this.substituteDue(userId))
  }

  /**
   * A member seated at a casual table has been offline SUBSTITUTE_MS: TKB takes their seat (marked
   * 代打) so the others can play on, but only while someone else seated is online. A job left from
   * an earlier time away only puts itself back for the rest of the wait
   */
  private async substituteDue(userId: string) {
    const since = this.offlineSince.get(userId)
    if (since === undefined || this.connections.onlineUserIds().includes(userId)) return
    if (this.now() - since < SUBSTITUTE_MS) return this.awayFrom(userId, since)
    const table = this.tableOf(userId)
    const seat = table && this.seatOf(table, userId)
    if (!table || !seat || table.mode === 'challenge') return
    const online = this.connections.onlineUserIds()
    if (!SEATS.some((s) => s !== seat && online.includes(table.seats[s] ?? ''))) return
    // TKB plays the system of a robot partner, if there is one
    const partner = table.seats[partnerOf(seat)]
    const kind: RobotKind = partner && isRobotId(partner) ? robotKindOf(partner) : 'tku'
    if (table.undo?.seat === seat) table.undo = undefined
    table.seats[seat] = robotId(kind, seat)
    table.substitutes = { ...table.substitutes, [seat]: userId }
    if (table.board && table.board.phase !== 'finished')
      table.boardSubstitutes = { ...table.boardSubstitutes, [seat]: userId }
    this.offlineSince.delete(userId)
    this.checkHost(table)
    this.touchTurn(table)
    await this.save(table)
    this.broadcast()
    this.scheduleRobots(table)
  }

  /** A member back online takes their seat back from the robot sitting in for them */
  private async takeBackSeat(userId: string) {
    for (const table of [...this.tables.values()]) {
      const seat = this.substituteSeat(table, userId)
      if (!seat) continue
      delete table.substitutes![seat]
      if (isRobotId(table.seats[seat]) && !this.tableOf(userId)) {
        table.seats[seat] = userId
        this.touchTurn(table)
      }
      await this.save(table)
      this.broadcast()
      this.scheduleRobots(table)
    }
  }

  private async chat(userId: string, text: unknown) {
    const table = this.tableOf(userId)
    const clean = String(text ?? '').trim().slice(0, LIMITS.chatMax)
    if (!table || !clean) return
    table.chat = [
      ...table.chat,
      { id: randomId(6), at: this.now(), userId, username: this.users.get(userId)!.username, text: clean },
    ].slice(-CHAT_KEEP)
    await this.save(table)
  }

  /**
   * Deals the first board as soon as all four seats are taken (by people or robots) and at least
   * one person is seated. After that every board is dealt by itself, as on BBO: nobody has to
   * press "next board". The browsers count down the last DEAL_COUNTDOWN_MS from `dealAt`.
   */
  private startBoardIfReady(table: Table) {
    if (!this.canDeal(table)) return
    if (!table.board) return this.dealBoard(table)
    table.dealAt = Math.max(table.dealAt ?? 0, this.now() + DEAL_COUNTDOWN_MS)
    this.scheduleDeal(table)
  }

  private canDeal(table: Table) {
    return (
      SEATS.every((s) => table.seats[s]) &&
      this.humansSeated(table) > 0 &&
      (!table.board || table.board.phase === 'finished')
    )
  }

  private dealBoard(table: Table) {
    const dealt = modeOf(table).deal(table, this.modeContext())
    // The mode has no more boards: the last one stays on the table
    if (!dealt) {
      table.dealAt = undefined
      return
    }
    // A person who declared from a robot partner's seat goes back to their own for the new board
    this.unswap(table)
    table.board = dealt.board ?? newBoard(dealt.boardNo, dealt.hands)
    table.undo = undefined
    table.rejectedClaim = undefined
    table.recordId = undefined
    table.dealAt = undefined
    table.boardStartedAt = this.now()
    // A robot still sitting in for someone plays this board for them too
    table.boardSubstitutes = table.substitutes && { ...table.substitutes }
    // A board dealt with its auction made (Just Declare) goes straight to the play
    if (table.board.phase === 'play') this.swapForDeclarer(table)
    this.touchTurn(table)
  }

  /**
   * A person never sits out a board as dummy for a robot: when a robot partner becomes declarer,
   * the person moves into the declarer's seat and plays the hand from there, as on BBO (the robot
   * takes the person's seat, which is now dummy)
   */
  private swapForDeclarer(table: Table) {
    const contract = table.board?.contract
    if (!contract) return
    const declarer = contract.declarer
    const dummy = partnerOf(declarer)
    const person = table.seats[dummy]
    if (!isRobotId(table.seats[declarer]) || !person || isRobotId(person)) return
    // The robot keeps its system in its new seat
    const robot = table.seats[declarer]!
    table.seats[declarer] = person
    table.seats[dummy] = robotId(robotKindOf(robot), dummy)
    table.swapped = [declarer, dummy]
    this.moveSubstitute(table, declarer, dummy)
  }

  /** A robot sitting in for someone (代打) moved seats: the note goes with it */
  private moveSubstitute(table: Table, from: Seat, to: Seat) {
    const forWhom = table.substitutes?.[from]
    if (!forWhom) return
    delete table.substitutes![from]
    table.substitutes![to] = forWhom
    if (table.boardSubstitutes?.[from] === forWhom) {
      delete table.boardSubstitutes[from]
      table.boardSubstitutes[to] = forWhom
    }
  }

  /** The seat a player bid from: a person moved into a robot partner's declaring seat bid from dummy's */
  private auctionSeat(table: Table, seat: Seat): Seat {
    return table.swapped && seat === table.swapped[0] ? table.swapped[1] : seat
  }

  /** Puts a swapped person back in their own seat (the auction was reopened by an undo, or a new board is dealt) */
  private unswap(table: Table) {
    if (!table.swapped) return
    const [declarer, dummy] = table.swapped
    const person = table.seats[declarer]
    if (person && !isRobotId(person) && isRobotId(table.seats[dummy])) {
      const robot = table.seats[dummy]!
      table.seats[dummy] = person
      table.seats[declarer] = robotId(robotKindOf(robot), declarer)
      this.moveSubstitute(table, dummy, declarer)
    }
    table.swapped = undefined
  }

  private scheduleDeal(table: Table) {
    if (!table.board || !this.canDeal(table)) return
    const ms = Math.max(0, (table.dealAt ?? 0) - this.now())
    this.scheduler.add(`deal:${table.id}`, 'deal', ms, () => this.dealNext(table.id))
  }

  private async dealNext(tableId: string) {
    const table = this.tables.get(tableId)
    // Someone may have stood up while the result was showing; sitting down deals again
    if (!table || !this.canDeal(table)) return
    // The countdown was restarted (a seat was filled again): wait for it
    if ((table.dealAt ?? 0) > this.now() + 50) return this.scheduleDeal(table)
    this.dealBoard(table)
    await this.save(table)
    this.broadcast()
    this.scheduleRobots(table)
  }

  // ── Bidding and play ────────────────────────────────────────────────────────────────────────

  private async boardAction(userId: string, message: ClientMessage) {
    const table = this.tableOf(userId)
    const seat = table && this.seatOf(table, userId)
    if (!table || !seat) throw new ClubError('notSeated')
    if (table.mode === 'challenge' && (message.type === 'undoRequest' || message.type === 'undoRespond'))
      throw new ClubError('challengeNoUndo')
    await this.act(table, seat, message)
  }

  /** Applies one board action for a seat, from a person or a robot */
  private async act(
    table: Table,
    seat: Seat,
    message: ClientMessage,
    byRobot = false,
    meaning?: RobotBid['meaning'],
  ) {
    const board = table.board
    if (!board) throw new ClubError('noBoard')
    // At the deadline play stops, as on BBO: a board still going is dropped, not finished
    if (this.challengeClosedAt(table)) throw new ClubError('challengeClosed')

    let next: BoardState
    switch (message.type) {
      case 'call':
        if (!isCall(message.call)) throw new ClubError('illegalCall')
        next = makeCall(
          board,
          seat,
          message.call,
          message.alert === undefined ? undefined : String(message.alert).slice(0, LIMITS.alertMax),
        )
        // A robot's explanations are for everyone, its partner too, as GIB's are on BBO
        // A 2/1 robot's call also carries what it shows, explained in each viewer's language
        if (byRobot) {
          const made = { ...next.auction.at(-1)!, robot: true, ...(meaning ? { meaning } : {}) }
          next = { ...next, auction: [...board.auction, made] }
        }
        break
      case 'play': {
        if (!isCard(message.card)) throw new ClubError('unknownCard')
        const dummy = dummyOf(board)
        const hand = dummy && remainingCards(board, dummy).includes(message.card) ? dummy : seat
        if (controllerOf(board, hand) !== seat) throw new ClubError('notYourCard')
        next = playCard(board, hand, message.card)
        break
      }
      case 'claim':
        next = makeClaim(board, seat, Number(message.tricks))
        break
      case 'claimRespond': {
        const claim = board.claim
        next = respondToClaim(board, seat, Boolean(message.accept))
        if (claim && !next.claim && next.phase !== 'finished') table.rejectedClaim = { seat: claim.seat, tricks: claim.tricks, by: seat }
        break
      }
      case 'undoRequest': {
        // Anyone may take back their own last call or card (and everything since), as on BBO;
        // during the play the declarer's cards include dummy's
        if (table.undo) return
        undoFor(board, seat, this.auctionSeat(table, seat))
        table.undo = { seat }
        await this.save(table)
        return
      }
      case 'undoRespond': {
        const undo = table.undo
        if (!undo) return
        if (sameSide(undo.seat, seat)) throw new ClubError('undoByOpponent')
        table.undo = undefined
        if (message.accept) {
          table.board = undoFor(board, undo.seat, this.auctionSeat(table, undo.seat))
          table.rejectedClaim = undefined
          if (table.board.phase === 'auction') this.unswap(table)
        }
        this.touchTurn(table)
        await this.save(table)
        return
      }
      default:
        return
    }

    // Any new action supersedes a pending undo request and the note about a rejected claim
    table.undo = undefined
    if (message.type !== 'claimRespond') table.rejectedClaim = undefined
    table.board = next
    this.touchTurn(table)
    if (board.phase === 'auction' && next.phase === 'play') this.swapForDeclarer(table)
    const finished = next.phase === 'finished' && board.phase !== 'finished'
    if (finished) {
      const record = await this.recordBoard(table, next)
      modeOf(table).boardFinished(table, record, this.modeContext())
      // A board played to the last card leaves that trick on the table for a moment first
      const playedOut = next.play.length === 52
      table.dealAt = this.now() + (playedOut ? LAST_TRICK_MS : 0) + DEAL_COUNTDOWN_MS
      this.startBoardIfReady(table)
    }
    await this.save(table)
    // The last board of the last participant finishes the challenge before its deadline
    const challenge = challengeStateOf(table)
    if (finished && challenge) await this.challengeChanged(challenge.challengeId)
  }

  private async recordBoard(table: Table, board: BoardState) {
    const players = {} as BoardRecord['players']
    for (const seat of SEATS) players[seat] = this.publicUserById(table.seats[seat] ?? '') ?? { id: '', username: '—' }
    // Seats where a robot played for someone offline during the board (代打), and for whom
    const substitutes: NonNullable<BoardRecord['substitutes']> = {}
    for (const seat of SEATS) {
      const forWhom = table.boardSubstitutes?.[seat]
      const user = forWhom && this.publicUserById(forWhom)
      if (user) substitutes[seat] = user
    }
    const record = modeOf(table).record(
      table,
      {
        id: randomId(8),
        tableNumber: table.number,
        finishedAt: this.now(),
        players,
        board,
        ...(Object.keys(substitutes).length > 0 && { substitutes }),
      },
      this.modeContext(),
    )
    await this.saveRecord(record)
    table.recordId = record.id
    table.recent = [summarize(record), ...(table.recent ?? [])].slice(0, RECENT_KEEP)
    table.boardsPlayed++
    return record
  }

  private modeContext(): ModeContext {
    return { random: this.random, now: this.now(), challenges: this.challenges }
  }

  // ── Robots ──────────────────────────────────────────────────────────────────────────────────

  /**
   * Which robot at this table acts next and after what pause, if any. What it does is asked of a
   * brain only when the move runs (`decide`), so a slow brain thinks once per move; `decide` takes
   * the brain so the rule robot can answer the same question when the club's brain is late
   */
  private robotMove(table: Table): { seat: Seat; delay: number; decide: (brain: RobotBrain) => Promise<RobotAnswer> } | null {
    const board = table.board
    if (!board || board.phase === 'finished' || this.humansSeated(table) === 0) return null
    if (this.challengeClosedAt(table)) return null
    const robot = (seat: Seat | null | undefined): seat is Seat => !!seat && isRobotId(table.seats[seat])
    const kindAt = (seat: Seat) => robotKindOf(table.seats[seat]!)

    // Robots agree to undo requests, and accept a claim only if the cards make it good
    if (table.undo) {
      const answer = SEATS.find((s) => robot(s) && !sameSide(s, table.undo!.seat))
      if (!answer) return null
      return { seat: answer, delay: ROBOT_DELAY.answer, decide: async () => ({ message: { type: 'undoRespond', accept: true } }) }
    }
    if (board.claim) {
      const answer = claimApprovers(board, board.claim.seat).find((s) => robot(s) && !board.claim!.accepted.includes(s))
      if (!answer) return null
      const decide = async (brain: RobotBrain): Promise<RobotAnswer> => ({
        message: { type: 'claimRespond', accept: await brain.acceptsClaim(kindAt(answer), board, answer) },
      })
      return { seat: answer, delay: ROBOT_DELAY.answer, decide }
    }
    const turn = turnOf(board)
    if (!turn) return null
    if (board.phase === 'auction') {
      if (!robot(turn)) return null
      const decide = async (brain: RobotBrain): Promise<RobotAnswer> => {
        const bid = await brain.bid(kindAt(turn), board, turn)
        return { message: { type: 'call', call: bid.call, alert: bid.alert }, meaning: bid.meaning }
      }
      return { seat: turn, delay: ROBOT_DELAY.call, decide }
    }
    const controller = controllerOf(board, turn)
    if (!robot(controller)) return null
    const trickJustEnded = board.play.length > 0 && board.play.length % 4 === 0
    return {
      seat: controller,
      delay: trickJustEnded ? ROBOT_DELAY.afterTrick : ROBOT_DELAY.card,
      decide: async (brain) => ({ message: { type: 'play', card: await brain.play(kindAt(controller), board, turn) } }),
    }
  }

  /** What a robot's answer depends on; an answer given for another position is dropped */
  private positionOf(table: Table) {
    const board = table.board
    return JSON.stringify([
      table.seats,
      table.undo ?? null,
      board && [board.boardNo, board.phase, board.auction.length, board.play.length, board.claim ?? null],
    ])
  }

  /** Schedules the next robot move at a table; each move schedules the one after it */
  scheduleRobots(table: Table) {
    const key = `robot:${table.id}`
    if (this.scheduler.pending(key) || this.thinking.has(table.id)) return
    const move = this.robotMove(table)
    if (!move) return
    this.scheduler.add(key, 'robot', move.delay, () => this.runRobot(table.id))
  }

  /**
   * Asks the club's brain, giving it at most the think limit; when it is late or fails the rule
   * robot answers instead, so the table never stalls (AC-6.5). A late answer is ignored
   */
  private async think(decide: (brain: RobotBrain) => Promise<RobotAnswer>): Promise<RobotAnswer> {
    if (this.brain === ruleBrain) return decide(ruleBrain)
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('robot brain too slow')), this.config.thinkLimitMs ?? THINK_LIMIT_MS)
    })
    try {
      return await Promise.race([decide(this.brain), late])
    } catch (error) {
      console.warn('robot brain failed, the rule robot answers', error)
      return decide(ruleBrain)
    } finally {
      clearTimeout(timer)
    }
  }

  private async runRobot(tableId: string) {
    const table = this.tables.get(tableId)
    if (!table) return
    const move = this.robotMove(table)
    if (!move) return
    // The brain may answer later: other messages go on meanwhile, and nothing else is scheduled
    // for this table until it does
    const position = this.positionOf(table)
    this.thinking.add(tableId)
    let answer: RobotAnswer
    try {
      answer = await this.think(move.decide)
    } finally {
      this.thinking.delete(tableId)
    }
    if (this.tables.get(tableId) !== table) return
    // The table moved on while the robot thought (a person played, an undo, a seat changed): ask again
    if (this.positionOf(table) !== position) return this.scheduleRobots(table)
    const { message, meaning } = answer
    try {
      await this.act(table, move.seat, message, true, meaning)
    } catch (error) {
      // A robot move that turns out illegal must not stall the table: pass or play any legal card
      if (!(error instanceof AppError)) throw error
      console.error('robot move rejected', error.code, move.seat, message)
      const board = table.board!
      const turn = turnOf(board)
      const fallback: ClientMessage | null =
        board.phase === 'auction' ? { type: 'call', call: 'P' } : turn ? { type: 'play', card: legalCards(board, turn)[0] } : null
      if (!fallback) return
      await this.act(table, move.seat, fallback, true)
    }
    this.broadcast()
    this.scheduleRobots(table)
  }

  // ── Persistence and broadcasting ────────────────────────────────────────────────────────────

  private async save(table: Table) {
    await this.store.put(`table:${table.id}`, table)
  }

  /** Closes a table no person is sitting at or watching (robots do not keep it open) */
  private async saveOrDrop(table: Table) {
    if (table.spectators.length === 0 && this.humansSeated(table) === 0) await this.dropTable(table)
    else await this.save(table)
  }

  private async dropTable(table: Table) {
    this.tables.delete(table.id)
    await this.store.delete(`table:${table.id}`)
  }

  /**
   * Sends every online member the lobby and the table they are at, but only what changed for them:
   * a card played at one table sends nothing to people in the lobby, and the chat and recent boards
   * only travel when they change. That keeps each update small on a phone connection.
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

      const table = this.tableOf(userId)
      if (!table) {
        if (sent.table !== 'null') this.connections.send(userId, { type: 'table', table: null, now: this.now() })
        Object.assign(sent, { table: 'null', chat: undefined, recent: undefined })
        continue
      }
      const { chat, recent, ...rest } = this.tableView(table, userId)
      const restJson = JSON.stringify(rest)
      const chatJson = JSON.stringify(chat)
      const recentJson = JSON.stringify(recent)
      if (restJson === sent.table && chatJson === sent.chat && recentJson === sent.recent) continue
      const wire: TableWire = { ...rest }
      if (chatJson !== sent.chat) wire.chat = chat
      if (recentJson !== sent.recent) wire.recent = recent
      Object.assign(sent, { table: restJson, chat: chatJson, recent: recentJson })
      this.connections.send(userId, { type: 'table', table: wire, now: this.now() })
    }
  }

  lobbyView(userId: string, online = this.connections.onlineUserIds()): LobbyView {
    const isOnline = (id: string) => isRobotId(id) || online.includes(id)
    const tables: TableSummary[] = [...this.tables.values()]
      // A challenge table is its player's alone and is not listed (§5.5)
      .filter((t) => t.mode !== 'challenge')
      // Tables short of players first, the closest to starting on top (AC-2.11)
      .sort(lobbyOrder)
      .map((t) => ({
        id: t.id,
        number: t.number,
        hostName: this.users.get(t.hostId)?.username ?? '—',
        settings: settingsOf(t),
        welcome: this.invitedTo(userId, t),
        seats: this.occupants(t, isOnline),
        spectators: t.spectators.length,
        boardsPlayed: t.boardsPlayed,
        boardNo: t.board ? t.board.boardNo : null,
      }))
    const members: MemberStatus[] = [...this.users.values()]
      .map((u) => {
        const found = this.tableOf(u.id)
        const table = found?.mode === 'challenge' ? undefined : found
        return {
          id: u.id,
          username: u.username,
          online: online.includes(u.id),
          tableNumber: table?.number ?? null,
          seat: table ? this.seatOf(table, u.id) : null,
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
      myTableId: this.tableOf(userId)?.id ?? null,
      friends: this.friends.of(userId),
      blocked: this.blocks.of(userId),
    }
  }

  /** The seats as everyone sees them, a robot sitting in for someone marked with their name (代打) */
  private occupants(table: Table, isOnline: (id: string) => boolean) {
    const seats = seatOccupants(table, (id) => this.publicUserById(id), isOnline)
    for (const seat of SEATS) {
      const forWhom = table.substitutes?.[seat]
      const name = forWhom && this.users.get(forWhom)?.username
      if (seats[seat]?.robot && name) seats[seat] = { ...seats[seat], substituteFor: name }
    }
    return seats
  }

  tableView(table: Table, userId: string): TableView {
    const online = this.connections.onlineUserIds()
    const mySeat = this.seatOf(table, userId)
    const settings = settingsOf(table)
    const playing = !!table.board && table.board.phase !== 'finished'
    const waiting = this.waitingOn(table)
    return {
      id: table.id,
      number: table.number,
      hostId: table.hostId,
      settings,
      seats: this.occupants(table, (id) => isRobotId(id) || online.includes(id)),
      spectators: table.spectators.flatMap((id) => this.publicUserById(id) ?? []),
      mySeat,
      board: table.board
        ? boardView(table.board, mySeat, {
            undo: table.undo,
            recordId: table.recordId,
            rejectedClaim: table.rejectedClaim,
            auctionSeat: mySeat ? this.auctionSeat(table, mySeat) : undefined,
            undoAllowed: table.mode !== 'challenge',
            kibitz: settings.allowKibitz,
          })
        : null,
      boardsPlayed: table.boardsPlayed,
      dealAt:
        table.board?.phase === 'finished' && this.canDeal(table) && !this.challengeTableOver(table)
          ? (table.dealAt ?? null)
          : null,
      chat: chatFor(table.chat, (authorId) => this.blocks.has(userId, authorId)),
      recent: (table.recent ?? []).filter((summary) => recordVisible(summary, userId, this.now())),
      ...(table.mode === 'challenge' && { challenge: this.tableChallenge(table) }),
      ...(table.hostId === userId &&
        table.mode !== 'challenge' && { invited: (table.invited ?? []).flatMap((id) => this.publicUserById(id) ?? []) }),
      boardEndsAt:
        playing && settings.boardMinutes > 0
          ? (table.boardStartedAt ?? table.createdAt) + settings.boardMinutes * 60_000
          : null,
      waiting: waiting && { seat: waiting, since: table.turnSince ?? table.createdAt },
    }
  }

  private publicUserById(id: string): PublicUser | undefined {
    if (isRobotId(id)) return { id, username: ROBOT_NAME, robot: true, robotKind: robotKindOf(id) }
    const user = this.users.get(id)
    return user && { id: user.id, username: user.username }
  }
}

