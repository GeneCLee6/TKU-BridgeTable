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
  robotLevelOf,
  DEFAULT_ROBOT_LEVEL,
  isOfferedRobotLevel,
  isRobotLevel,
  summarize,
  USERNAME_PATTERN,
  type AdminUser,
  type Application,
  type BoardRecord,
  type ClientMessage,
  type ClubSettings,
  type HistoryPage,
  type LobbyView,
  type Me,
  type MemberStatus,
  type Permission,
  type PublicUser,
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
import { DEFAULT_HISTORY_QUERY, type HistoryQuery } from '../shared/history-query.ts'
import { CHALLENGE_LIMITS, parseChallengeSettings, type ChallengeView } from '../shared/challenge.ts'
import { dealSourceOf, makeDealSet } from '../shared/deal-set.ts'
import { answer, cancel, challengeTakesPart, newChallenge, type ChallengeChange } from './challenge-flow.ts'
import { ChallengeStore, type Challenge } from './challenges.ts'
import { createHistoryIndex, indexRecord, searchBoards, unindexRecord } from './history-index.ts'
import { challengeStateOf, modeOf, nextSeq, playedSeqs, type ChallengeTableState, type ModeContext } from './modes.ts'
import { NotificationService } from './notifications.ts'
import { Relations } from './relations.ts'
import { AlarmQueue, manualScheduler, type JobKind, type Scheduler } from './scheduler.ts'
import type { Store } from './store.ts'
import { boardView, challengeView, chatFor, recordVisible, seatOccupants, type Table } from './views.ts'

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

const settingsOf = (table: Table): TableSettings => ({ ...DEFAULT_TABLE_SETTINGS, ...table.settings })

/**
 * Accounts, tables and boards for one bridge club. All state lives in memory and every change is
 * written through to the store, so the Durable Object can be evicted and reloaded at any time.
 *
 * History is kept as one key per board (`board:<id>`) plus two small, time-ordered indexes of
 * summaries (`hist:` for everyone, `uhist:<userId>:` per member), so listing a page of history
 * reads only that page no matter how many boards the club has played.
 */
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
    { lobby?: string; table?: string; chat?: string; recent?: string; notifications?: string }
  >()
  /** The notification centre; other parts of the club call `notifications.notify` */
  readonly notifications: NotificationService
  /** Whom each member follows (好友) and whom they blocked (AC-1.6) */
  private readonly friends: Relations
  private readonly blocks: Relations
  /** Challenges, kept in SQL (§5.5); created and answered here, played in later batches */
  readonly challenges: ChallengeStore

  constructor(store: Store, connections: Connections, config: ClubConfig) {
    this.store = store
    this.connections = connections
    this.config = config
    this.now = config.now ?? Date.now
    this.random = config.random ?? secureRandomInt
    this.brain = config.brain ?? ruleBrain
    this.notifications = new NotificationService(store, this.now, (userId) => void this.pushNotifications(userId))
    this.friends = new Relations(store, 'friend', this.now)
    this.blocks = new Relations(store, 'block', this.now)
    this.challenges = new ChallengeStore(store.sql)
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
    const schema = (await this.store.get<number>('meta:schema')) ?? 1
    if (schema < 2) await this.migrate()
    if (schema < 3) await this.backfillIndex()
    await this.ensureAdmin()
    for (const table of this.tables.values()) {
      this.scheduleRobots(table)
      this.scheduleDeal(table)
    }
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

  async login(username: string, password: string) {
    const name = String(username ?? '').trim()
    const user = this.findUser(name)
    if (!user) {
      // Someone still waiting for approval learns that, but only with their own password
      const application = this.findApplication(name)
      if (application && (await verifyPassword(String(password ?? ''), application.passwordHash)))
        throw new ClubError('awaitingApproval', {}, 403)
      throw new ClubError('badLogin', {}, 401)
    }
    if (!(await verifyPassword(String(password ?? ''), user.passwordHash))) throw new ClubError('badLogin', {}, 401)
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
    const me: Me = { id: user.id, username: user.username, admin: !!user.admin, permissions: this.permissionsOf(user) }
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
    for (const table of [...this.tables.values()])
      if (challengeStateOf(table)?.userId === user.id) await this.dropTable(table)
    this.users.delete(user.id)
    await this.store.delete(`user:${user.id}`)
    await this.revokeSessions(user.id)
    await this.notifications.forget(user.id)
    await this.friends.forget(user.id)
    await this.blocks.forget(user.id)
    this.challenges.forget(user.id, this.now())
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

  /** A board's full record, if the member may see it (a board kept back only to its players) */
  async record(id: string, userId: string): Promise<BoardRecord | null> {
    if (!/^[\w-]+$/.test(id)) return null
    const record = await this.store.get<BoardRecord>(`board:${id}`)
    return record && recordVisible(record, userId, this.now()) ? record : null
  }

  private async saveRecord(record: BoardRecord) {
    // Zero-padded time keeps the indexes in chronological order
    const order = `${String(record.finishedAt).padStart(14, '0')}-${record.id}`
    const summary = summarize(record)
    // The SQL index first, in one transaction: if it fails nothing is written. If a key-value
    // write fails after it, the index rows are taken back out, so a board is never half saved
    indexRecord(this.store.sql, record)
    try {
      await this.store.put(`board:${record.id}`, record)
      await this.store.put(`hist:${order}`, summary)
      for (const id of new Set(SEATS.map((seat) => record.players[seat].id))) {
        if (!id || isRobotId(id)) continue
        await this.store.put(`uhist:${id}:${order}`, summary)
      }
    } catch (error) {
      unindexRecord(this.store.sql, record.id)
      await this.store.delete(`board:${record.id}`)
      throw error
    }
  }

  // ── Connections ─────────────────────────────────────────────────────────────────────────────

  connected(userId: string) {
    const user = this.users.get(userId)
    if (!user) return
    // A new socket starts with nothing: send it everything
    this.sent.delete(userId)
    this.connections.send(userId, { type: 'welcome', me: this.me(user) })
    this.broadcast()
    void this.pushNotifications(userId)
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
    const table = this.tableOf(userId)
    if (table && table.spectators.includes(userId)) {
      table.spectators = table.spectators.filter((id) => id !== userId)
      this.checkHost(table)
      await this.saveOrDrop(table)
    } else if (table) {
      this.checkHost(table)
      await this.save(table)
    }
    this.broadcast()
  }

  async handle(userId: string, message: ClientMessage) {
    try {
      await this.dispatch(userId, message)
    } catch (error) {
      if (error instanceof AppError) {
        this.connections.send(userId, { type: 'error', code: error.code, params: error.params, message: error.message })
        return
      }
      throw error
    }
    this.broadcast()
    const table = this.tableOf(userId)
    if (table) this.scheduleRobots(table)
  }

  private async dispatch(userId: string, message: ClientMessage) {
    if (!this.users.has(userId)) throw new ClubError('signInAgain', {}, 401)
    switch (message?.type) {
      case 'createTable':
        return this.createTable(userId, message.settings)
      case 'updateTableSettings':
        return this.updateTableSettings(userId, message.settings)
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
        return this.addRobot(userId, message.seat, message.kind, message.level)
      case 'removeRobot':
        return this.removeRobot(userId, message.seat)
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
      case 'createChallenge':
        return this.createChallenge(userId, message.invitees, message.boards, message.settings)
      case 'answerChallenge':
        return this.answerChallenge(userId, message.challengeId, message.accept)
      case 'cancelChallenge':
        return this.cancelChallenge(userId, message.challengeId)
      case 'playChallenge':
        return this.playChallenge(userId, message.challengeId)
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

  /** A member the host blocked may not join the table, to sit or to watch */
  private checkWelcome(userId: string, table: Table) {
    if (this.blocks.has(table.hostId, userId)) throw new ClubError('blockedByHost', {}, 403)
  }

  // ── Challenges (§5.5) ───────────────────────────────────────────────────────────────────────

  /**
   * Creates a challenge (e7-t05): 1–20 different members the creator follows, neither side
   * blocking the other; 4–16 boards dealt at random now; settings checked by
   * `parseChallengeSettings`. The creator has accepted and may play at once; the invitees are told
   */
  private async createChallenge(userId: string, invitees: unknown, boards: unknown, wanted: unknown) {
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
    const count = boards ?? boardsDefault
    if (!Number.isInteger(count) || (count as number) < boardsMin || (count as number) > boardsMax)
      throw new ClubError('challengeBoards', { min: boardsMin, max: boardsMax })
    const parsed = parseChallengeSettings(wanted, invitees.length)
    if ('field' in parsed) throw new ClubError('badChallengeSettings', { field: parsed.field })
    const deals = makeDealSet({ kind: 'random', count: count as number }, this.random)
    if (!deals) throw new ClubError('serverError', {}, 500)
    const challenge = newChallenge({
      id: randomId(8),
      creatorId: userId,
      invitees: invitees as string[],
      settings: parsed.settings,
      deals,
      now: this.now(),
    })
    this.challenges.create(challenge)
    const username = this.users.get(userId)!.username
    for (const id of invitees as string[])
      await this.notifications.notify(id, 'challengeInvited', { challengeId: challenge.id, username })
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
  }

  /** The challenges a member is in, newest first, as they may see them */
  challengeList(userId: string): ChallengeView[] {
    return this.challenges.idsOf(userId).flatMap((id) => {
      const challenge = this.challenges.get(id)
      const view = challenge && challengeView(challenge, userId, (other) => this.publicUserById(other))
      return view ? [view] : []
    })
  }

  /** One challenge, if the member is in it */
  challengeFor(id: string, userId: string): ChallengeView | null {
    const challenge = this.challenges.get(id)
    return challenge && challengeView(challenge, userId, (other) => this.publicUserById(other))
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
   * The first time it opens their own table: they sit South, the other three seats are robots of the
   * challenge's kind and level, and the first board of the set is dealt. Coming back seats them
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
    const { robotKind: kind, robotLevel } = challenge.settings
    const level = isRobotLevel(robotLevel) ? robotLevel : DEFAULT_ROBOT_LEVEL
    const state: ChallengeTableState = { challengeId: challenge.id, userId, seq: 0 }
    const table: Table = {
      id: randomId(6),
      // Challenge tables are not in the lobby and take no number from it
      number: 0,
      hostId: userId,
      seats: { N: robotId(kind, 'N', level), E: robotId(kind, 'E', level), S: userId, W: robotId(kind, 'W', level) },
      spectators: [],
      boardsPlayed: playedSeqs(challenge, userId).size,
      board: null,
      chat: [],
      createdAt: this.now(),
      mode: 'challenge',
      modeState: state,
      dealSource: dealSourceOf(challenge.deals),
      settings: { visibility: 'invite', allowKibitz: false, robotLevel: level },
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

  private async createTable(userId: string, wanted?: unknown) {
    const settings = parseTableSettings(wanted)
    if (!settings) throw new ClubError('badTableSettings')
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
    await this.save(table)
  }

  private async joinTable(userId: string, table: Table) {
    if (this.tableOf(userId) === table) return
    // Someone else's challenge table is not there for anyone to see
    if (table.mode === 'challenge') throw new ClubError('tableGone', {}, 404)
    this.checkWelcome(userId, table)
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
    table.seats[seat] = userId
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

  /** The host changes how the table is run; only the fields sent change */
  private async updateTableSettings(userId: string, wanted: unknown) {
    const table = this.hostTable(userId)
    const settings = parseTableSettings(wanted)
    if (!settings) throw new ClubError('badTableSettings')
    table.settings = { ...settingsOf(table), ...settings }
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

  /**
   * Seats a robot: the club's (淡江機器人) unless the host chose another kind, at the table's robot
   * level unless the host chose another one (only the levels offered now, `OFFERED_ROBOT_LEVELS`)
   */
  private async addRobot(userId: string, seat: unknown, kind: unknown = 'tku', level?: unknown) {
    const table = this.hostTable(userId)
    if (!isSeat(seat)) throw new ClubError('badSeat')
    if (!isRobotKind(kind)) throw new ClubError('unknownRobot')
    const chosen = level ?? settingsOf(table).robotLevel ?? DEFAULT_ROBOT_LEVEL
    if (!isOfferedRobotLevel(chosen)) throw new ClubError('badRobotLevel')
    if (table.seats[seat]) throw new ClubError('seatTaken')
    table.seats[seat] = robotId(kind, seat, chosen)
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

  private vacate(table: Table, seat: Seat) {
    table.seats[seat] = null
    if (table.undo?.seat === seat) table.undo = undefined
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
    table.board = newBoard(dealt.boardNo, dealt.hands)
    table.undo = undefined
    table.rejectedClaim = undefined
    table.recordId = undefined
    table.dealAt = undefined
    table.swapped = undefined
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
    // The robot keeps its kind and level in its new seat
    const robot = table.seats[declarer]!
    table.seats[declarer] = person
    table.seats[dummy] = robotId(robotKindOf(robot), dummy, robotLevelOf(robot))
    table.swapped = [declarer, dummy]
  }

  /** The seat a player bid from: a person moved into a robot partner's declaring seat bid from dummy's */
  private auctionSeat(table: Table, seat: Seat): Seat {
    return table.swapped && seat === table.swapped[0] ? table.swapped[1] : seat
  }

  /** Puts a swapped person back in their own seat (the auction was reopened by an undo) */
  private unswap(table: Table) {
    if (!table.swapped) return
    const [declarer, dummy] = table.swapped
    const person = table.seats[declarer]
    if (person && !isRobotId(person) && isRobotId(table.seats[dummy])) {
      const robot = table.seats[dummy]!
      table.seats[dummy] = person
      table.seats[declarer] = robotId(robotKindOf(robot), declarer, robotLevelOf(robot))
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
    if (board.phase === 'auction' && next.phase === 'play') this.swapForDeclarer(table)
    if (next.phase === 'finished' && board.phase !== 'finished') {
      const record = await this.recordBoard(table, next)
      modeOf(table).boardFinished(table, record, this.modeContext())
      // A board played to the last card leaves that trick on the table for a moment first
      const playedOut = next.play.length === 52
      table.dealAt = this.now() + (playedOut ? LAST_TRICK_MS : 0) + DEAL_COUNTDOWN_MS
      this.startBoardIfReady(table)
    }
    await this.save(table)
  }

  private async recordBoard(table: Table, board: BoardState) {
    const players = {} as BoardRecord['players']
    for (const seat of SEATS) players[seat] = this.publicUserById(table.seats[seat] ?? '') ?? { id: '', username: '—' }
    const record = modeOf(table).record(
      table,
      { id: randomId(8), tableNumber: table.number, finishedAt: this.now(), players, board },
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
    const levelAt = (seat: Seat) => robotLevelOf(table.seats[seat]!)
    const seed = this.mistakeSeed(table, board)

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
        message: { type: 'claimRespond', accept: await brain.acceptsClaim(kindAt(answer), board, answer, levelAt(answer)) },
      })
      return { seat: answer, delay: ROBOT_DELAY.answer, decide }
    }
    const turn = turnOf(board)
    if (!turn) return null
    if (board.phase === 'auction') {
      if (!robot(turn)) return null
      const decide = async (brain: RobotBrain): Promise<RobotAnswer> => {
        const bid = await brain.bid(kindAt(turn), board, turn, levelAt(turn), seed)
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
      decide: async (brain) => ({ message: { type: 'play', card: await brain.play(kindAt(controller), board, turn, levelAt(controller), seed) } }),
    }
  }

  /**
   * The key for the robots' deliberate mistakes on this board (ROBOT.md §8): the table and the
   * board number, which stay the same when the board is undone or the object reloaded. A challenge
   * table keys them by the challenge and the board's place in the set instead, so every participant
   * who does the same meets the same robots (§5.5, e7-t09); the brain adds the action number
   */
  private mistakeSeed(table: Table, board: BoardState) {
    const challenge = challengeStateOf(table)
    if (challenge) return `challenge:${challenge.challengeId}:${challenge.seq}`
    return `${table.id}:${board.boardNo}`
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
      .sort((a, b) => a.number - b.number)
      .map((t) => ({
        id: t.id,
        number: t.number,
        hostName: this.users.get(t.hostId)?.username ?? '—',
        settings: settingsOf(t),
        seats: seatOccupants(t, (id) => this.publicUserById(id), isOnline),
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

  tableView(table: Table, userId: string): TableView {
    const online = this.connections.onlineUserIds()
    const mySeat = this.seatOf(table, userId)
    return {
      id: table.id,
      number: table.number,
      hostId: table.hostId,
      settings: settingsOf(table),
      seats: seatOccupants(table, (id) => this.publicUserById(id), (id) => isRobotId(id) || online.includes(id)),
      spectators: table.spectators.flatMap((id) => this.publicUserById(id) ?? []),
      mySeat,
      board: table.board
        ? boardView(table.board, mySeat, {
            undo: table.undo,
            recordId: table.recordId,
            rejectedClaim: table.rejectedClaim,
            auctionSeat: mySeat ? this.auctionSeat(table, mySeat) : undefined,
            undoAllowed: table.mode !== 'challenge',
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
    }
  }

  private publicUserById(id: string): PublicUser | undefined {
    if (isRobotId(id)) return { id, username: ROBOT_NAME, robot: true, robotKind: robotKindOf(id), robotLevel: robotLevelOf(id) }
    const user = this.users.get(id)
    return user && { id: user.id, username: user.username }
  }
}

