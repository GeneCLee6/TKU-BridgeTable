import { parseClientMessage } from '../shared/message-guard.ts'
import { AppError, type MessageCode } from '../shared/messages.ts'
import { isTableAction, TABLE_SOCKET_REFUSED, type TableAction, type TableSettings } from '../shared/protocol.ts'
import type { Seat } from '../shared/cards.ts'
import { ClubError } from './errors.ts'
import { crashEntry, type Logger } from './log.ts'
import { ACTION_BURST, ACTIONS_PER_SECOND, CHAT_BURST, CHATS_PER_SECOND, TokenBuckets } from './rate-limit.ts'
import { TableService, type TableConfig, type TableConnections } from './table-service.ts'
import { toWire, type ClubLink, type MatchTableUpdate, type Named, type Person, type TableEntry, type TableRpc, type Wire } from './tables.ts'
import type { Table } from './views.ts'

/** The part of a Durable Object's storage a table uses (`worker/table-object.ts`; a Map in the tests) */
export interface TableStorage {
  get<T>(key: string): Promise<T | undefined>
  put<T>(key: string, value: T): Promise<void>
  /** Removes everything the object keeps, its alarm too */
  clear(): Promise<void>
}

/** The table's own WebSockets: who holds one, sending, and closing a member's */
export interface TableSockets extends TableConnections {
  dismiss(userId: string, code: number, reason: string): void
}

export interface TableHostDeps {
  storage: TableStorage
  sockets: TableSockets
  /** The club, over RPC in production */
  club: ClubLink
  config: TableConfig
  log: Logger
}

/** The object's keys: the table itself, a mark that it closed, and a mark that the club took it back */
const TABLE_KEY = 'table'
const CLOSED_KEY = 'closed'
const FROZEN_KEY = 'frozen'

/**
 * Everything one `TableObject` does, without Cloudflare APIs (so it runs in Node, ARCHITECTURE.md
 * §5.10): the club's calls (`TableRpc`, answers wrapped for RPC), the table's own connections
 * (only people at the table, messages checked and rate-limited as at the club), and its storage
 * (`table`, plus `closed` once the table closed and `frozen` while the club takes it back).
 * The Durable Object glue is `worker/table-object.ts`.
 */
export class TableHost implements TableRpc {
  private service: TableService | null = null
  /** The club took the table back (`handOver`): nothing is saved, sent or played until `release` */
  private frozen = false
  private readonly deps: TableHostDeps
  private readonly link: ClubLink
  /** Rate limits on the table's connection (§5.6); a member's limits at the club are separate */
  private readonly actionLimit: TokenBuckets
  private readonly chatLimit: TokenBuckets

  constructor(deps: TableHostDeps) {
    this.deps = deps
    const { club, log } = deps
    this.actionLimit = new TokenBuckets(ACTION_BURST, ACTIONS_PER_SECOND, deps.config.now)
    this.chatLimit = new TokenBuckets(CHAT_BURST, CHATS_PER_SECOND, deps.config.now)
    // What the table tells the club; a report that does not get through is only logged (the next
    // one carries the whole entry), a board's record is offered again (the table's outbox)
    this.link = {
      changed: (entry) => {
        if (this.frozen) return
        void Promise.resolve()
          .then(() => club.changed(entry))
          .catch((error: unknown) => log(crashEntry('tableChanged', error)))
      },
      closed: async (tableId) => {
        try {
          await club.closed(tableId)
        } catch (error) {
          log(crashEntry('tableClosed', error))
        }
      },
      boardFinished: async (record, event) => {
        if (this.frozen) throw new Error('the table was handed back to the club')
        await club.boardFinished(record, event)
      },
      // Asked as a host seats a robot; when the club cannot be reached the action fails (serverError)
      mayUseTku: (userId) => club.mayUseTku(userId),
    }
  }

  /** The table as it is now, for tests */
  get table(): Table | null {
    return this.live ? this.service!.state : null
  }

  private get live(): boolean {
    return !this.frozen && !!this.service?.state
  }

  /** Loads the table after the object was evicted; its jobs are scheduled again, nothing is sent */
  async load() {
    const { storage } = this.deps
    if (await storage.get<boolean>(FROZEN_KEY)) {
      this.frozen = true
      return
    }
    const table = await storage.get<Table>(TABLE_KEY)
    if (table) await this.make(table.id).restore(table)
  }

  private make(tableId: string): TableService {
    const { storage, sockets, config } = this.deps
    this.service = new TableService(
      tableId,
      {
        save: async (table) => {
          if (!this.frozen) await storage.put(TABLE_KEY, table)
        },
        remove: async () => {
          await storage.clear()
          await storage.put(CLOSED_KEY, true)
        },
      },
      sockets,
      this.link,
      config,
    )
    return this.service
  }

  /** A table the club takes over again after a `handOver` without a `release`: what it had here is dropped */
  private async thaw() {
    if (!this.frozen) return
    this.frozen = false
    this.service = null
    await this.deps.storage.clear()
  }

  // ── The club's calls (TableRpc) ─────────────────────────────────────────────────────────────

  open(table: Table): Promise<Wire<TableEntry>> {
    return this.answer(async () => {
      await this.thaw()
      // Opening twice (an RPC retried) keeps what is there
      if (this.live) return (await this.service!.adopt(table))!
      return this.make(table.id).open(table)
    })
  }

  adopt(table: Table): Promise<Wire<TableEntry | null>> {
    return this.answer(async () => {
      if (await this.deps.storage.get<boolean>(CLOSED_KEY)) return null
      await this.thaw()
      return (this.live ? this.service! : this.make(table.id)).adopt(table)
    })
  }

  join(person: Person) {
    return this.atTable((table) => table.join(person))
  }
  sit(person: Person, seat: Seat) {
    return this.atTable((table) => table.sit(person, seat))
  }
  configure(userId: string, settings: Partial<TableSettings>, invited?: Named[]) {
    return this.atTable((table) => table.configure(userId, settings, invited))
  }
  request(person: Person, muted: boolean) {
    return this.atTable((table) => table.request(person, muted))
  }
  answerRequest(hostId: string, userId: string, accept: boolean) {
    return this.atTable((table) => table.answerRequest(hostId, userId, accept))
  }
  resume(person: Person) {
    return this.atTable((table) => table.resume(person))
  }
  act(userId: string, message: TableAction) {
    return this.atTable((table) => table.act(userId, message))
  }
  leave(userId: string) {
    return this.ifTable(null, (table) => table.leave(userId))
  }
  reclaim(userId: string, reseat: boolean) {
    return this.ifTable(null, (table) => table.reclaim(userId, reseat))
  }
  presence(userId: string, online: boolean) {
    return this.ifTable(null, (table) => table.presence(userId, online))
  }
  forget(userId: string) {
    return this.ifTable(null, (table) => table.forget(userId))
  }
  challengeEnded() {
    return this.ifTable(null, (table) => table.challengeEnded())
  }
  matchEnded() {
    return this.ifTable(null, (table) => table.matchEnded())
  }
  matchUpdate(update: MatchTableUpdate) {
    return this.ifTable(null, (table) => table.matchUpdate(update))
  }
  blocked(userId: string, blocked: string[]) {
    return this.ifTable(undefined, (table) => table.blocked(userId, blocked))
  }
  close() {
    return this.ifTable(undefined, (table) => table.close())
  }

  handOver(): Promise<Wire<Table | null>> {
    return this.answer(async () => {
      if (this.frozen) return (await this.deps.storage.get<Table>(TABLE_KEY)) ?? null
      const table = this.service?.state ?? null
      if (!table) return null
      this.frozen = true
      await this.deps.storage.put(TABLE_KEY, table)
      await this.deps.storage.put(FROZEN_KEY, true)
      return table
    })
  }

  release(): Promise<Wire<null>> {
    return this.answer(async () => {
      this.frozen = false
      this.service = null
      await this.deps.storage.clear()
      return null
    })
  }

  /** A call that needs the table: an object without one answers `gone` */
  private async atTable<T>(run: (table: TableService) => Promise<T>): Promise<Wire<T>> {
    if (!this.live) return { gone: true }
    return this.answer(() => run(this.service!))
  }

  /** A call that answers `none` when there is no table */
  private async ifTable<T, N>(none: N, run: (table: TableService) => Promise<T>): Promise<Wire<T | N>> {
    if (!this.live) return { ok: none }
    return this.answer(() => run(this.service!))
  }

  /** Wraps a call's answer for RPC; afterwards anyone connected who is no longer at the table is let go */
  private async answer<T>(run: () => Promise<T>): Promise<Wire<T>> {
    try {
      return await toWire(run)
    } finally {
      this.dismissStrangers()
    }
  }

  // ── The table's connections ─────────────────────────────────────────────────────────────────

  /** Whether a member may hold a connection to this table: only people at it (§5.10) */
  admits(userId: string): boolean {
    return this.live && this.service!.admits(userId)
  }

  /** A member's connection opened (it is already counted online): they get the whole table, or are let go */
  async connected(userId: string) {
    if (!this.admits(userId)) return this.deps.sockets.dismiss(userId, TABLE_SOCKET_REFUSED, 'not at this table')
    await this.service!.presence(userId, true)
  }

  /** A member's last connection to the table closed: a spectator leaves, a seated player may get a substitute */
  async disconnected(userId: string) {
    if (this.live) await this.service!.presence(userId, false)
  }

  /**
   * A message on the table's connection (AC-11.7): checked as at the club (`parseClientMessage`),
   * only table actions, and rate-limited per member; errors go back to the sender
   */
  async message(userId: string, raw: string) {
    const parsed = parseClientMessage(raw)
    if ('error' in parsed) return this.reject(userId, parsed.error)
    const { message } = parsed
    if (!isTableAction(message)) return this.reject(userId, 'unknownCommand', message.type)
    if (!this.actionLimit.take(userId)) return this.reject(userId, 'slowDown', message.type)
    if (message.type === 'chat' && !this.chatLimit.take(userId)) return this.reject(userId, 'chatTooFast', message.type)
    const { log, config, sockets } = this.deps
    const started = config.now()
    try {
      if (!this.live) throw new ClubError('tableGone', {}, 404)
      await this.service!.act(userId, message)
      log({ event: 'action', type: message.type, user: userId, ms: config.now() - started })
    } catch (error) {
      // A bug is logged and answered as `serverError`
      if (!(error instanceof AppError)) log(crashEntry(message.type, error))
      const failure = error instanceof AppError ? error : new ClubError('serverError', {}, 500)
      log({ event: 'action', type: message.type, user: userId, ms: config.now() - started, code: failure.code })
      sockets.send(userId, { type: 'error', code: failure.code, params: failure.params, message: failure.message })
    } finally {
      this.dismissStrangers()
    }
  }

  private reject(userId: string, code: MessageCode, type?: string) {
    this.deps.log({ event: 'rejected', user: userId, code, ...(type ? { type } : {}) })
    const error = new ClubError(code)
    this.deps.sockets.send(userId, { type: 'error', code, params: {}, message: error.message })
  }

  /** Closes the connections of members who are no longer at the table (they left, or it closed) */
  private dismissStrangers() {
    const { sockets } = this.deps
    for (const userId of sockets.onlineUserIds())
      if (!this.admits(userId)) sockets.dismiss(userId, TABLE_SOCKET_REFUSED, 'not at this table')
  }
}
