import { isCall } from '../shared/auction.ts'
import { deal, secureRandomInt, type RandomInt } from '../shared/board.ts'
import { isCard, isSeat, sameSide, SEATS, type Seat } from '../shared/cards.ts'
import {
  controllerOf,
  dummyOf,
  GameError,
  lastActor,
  makeCall,
  makeClaim,
  newBoard,
  playCard,
  remainingCards,
  respondToClaim,
  undoLast,
  type BoardState,
} from '../shared/game.ts'
import {
  LIMITS,
  summarize,
  USERNAME_PATTERN,
  type BoardRecord,
  type BoardSummary,
  type ClientMessage,
  type LobbyView,
  type PublicUser,
  type ServerMessage,
  type TableSummary,
  type TableView,
} from '../shared/protocol.ts'
import { hashPassword, randomId, SESSION_DAYS, verifyPassword } from './auth.ts'
import type { Store } from './store.ts'
import { boardView, seatOccupants, type Table } from './views.ts'

/** An error shown to the user as-is */
export class ClubError extends Error {
  readonly status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

interface StoredUser extends PublicUser {
  passwordHash: string
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
}

export interface ClubConfig {
  maxUsers: number
  /** When set, registering requires this code */
  inviteCode?: string
  now?: () => number
  random?: RandomInt
}

const CHAT_KEEP = 100

/**
 * Accounts, tables and boards for one bridge club. All state lives in memory and every change is
 * written through to the store, so the Durable Object can be evicted and reloaded at any time.
 */
export class ClubService {
  private users = new Map<string, StoredUser>()
  private tables = new Map<string, Table>()
  private readonly store: Store
  private readonly connections: Connections
  private readonly config: ClubConfig
  private readonly now: () => number
  private readonly random: RandomInt

  constructor(store: Store, connections: Connections, config: ClubConfig) {
    this.store = store
    this.connections = connections
    this.config = config
    this.now = config.now ?? Date.now
    this.random = config.random ?? secureRandomInt
  }

  async load() {
    for (const user of (await this.store.list<StoredUser>('user:')).values())
      this.users.set(user.id, user)
    for (const table of (await this.store.list<Table>('table:')).values())
      this.tables.set(table.id, table)
  }

  // ── Accounts ────────────────────────────────────────────────────────────────────────────────

  async register(username: string, password: string, inviteCode: string) {
    username = String(username ?? '').trim()
    password = String(password ?? '')
    if (this.config.inviteCode && inviteCode !== this.config.inviteCode)
      throw new ClubError('badInvite', {}, 403)
    if (this.users.size >= this.config.maxUsers)
      throw new ClubError(`社團帳號已達上限（${this.config.maxUsers} 人）`, 403)
    if (
      username.length < LIMITS.usernameMin ||
      username.length > LIMITS.usernameMax ||
      !USERNAME_PATTERN.test(username)
    )
      throw new ClubError(
        `帳號需為 ${LIMITS.usernameMin}–${LIMITS.usernameMax} 個字，只能用中英文、數字與 _ . -`,
      )
    if (password.length < LIMITS.passwordMin)
      throw new ClubError(`密碼至少 ${LIMITS.passwordMin} 個字`)
    if (this.findUser(username)) throw new ClubError('usernameTaken', {}, 409)

    const user: StoredUser = {
      id: randomId(8),
      username,
      passwordHash: await hashPassword(password),
      createdAt: this.now(),
    }
    this.users.set(user.id, user)
    await this.store.put(`user:${user.id}`, user)
    return { user: publicUser(user), token: await this.createSession(user.id) }
  }

  async login(username: string, password: string) {
    const user = this.findUser(String(username ?? '').trim())
    if (!user || !(await verifyPassword(String(password ?? ''), user.passwordHash)))
      throw new ClubError('badLogin', {}, 401)
    return { user: publicUser(user), token: await this.createSession(user.id) }
  }

  async logout(token: string) {
    await this.store.delete(`session:${token}`)
  }

  async userForToken(token: string | null): Promise<PublicUser | null> {
    if (!token) return null
    const session = await this.store.get<Session>(`session:${token}`)
    if (!session) return null
    if (session.expires < this.now()) {
      await this.store.delete(`session:${token}`)
      return null
    }
    const user = this.users.get(session.userId)
    return user ? publicUser(user) : null
  }

  private findUser(username: string) {
    const wanted = username.toLowerCase()
    return [...this.users.values()].find((u) => u.username.toLowerCase() === wanted)
  }

  private async createSession(userId: string) {
    const token = randomId(32)
    await this.store.put<Session>(`session:${token}`, {
      userId,
      expires: this.now() + SESSION_DAYS * 86_400_000,
    })
    return token
  }

  // ── History ─────────────────────────────────────────────────────────────────────────────────

  /** Newest first; only boards the user played unless `all` */
  async history(userId: string, all: boolean): Promise<BoardSummary[]> {
    const records = [...(await this.store.list<BoardRecord>('board:')).values()]
    return records
      .filter((r) => all || SEATS.some((seat) => r.players[seat].id === userId))
      .map(summarize)
      .reverse()
  }

  async record(id: string): Promise<BoardRecord | null> {
    const records = await this.store.list<BoardRecord>('board:')
    return [...records.values()].find((r) => r.id === id) ?? null
  }

  // ── Connections ─────────────────────────────────────────────────────────────────────────────

  connected(userId: string) {
    const user = this.users.get(userId)
    if (!user) return
    this.connections.send(userId, { type: 'welcome', me: publicUser(user) })
    this.broadcast()
  }

  /** Called when a user's last socket closes. Spectators leave; seated players keep their seat. */
  async disconnected(userId: string) {
    const table = this.tableOf(userId)
    if (table && table.spectators.includes(userId)) {
      table.spectators = table.spectators.filter((id) => id !== userId)
      await this.saveOrDrop(table)
    }
    this.broadcast()
  }

  async handle(userId: string, message: ClientMessage) {
    try {
      await this.dispatch(userId, message)
    } catch (error) {
      if (error instanceof ClubError || error instanceof GameError) {
        this.connections.send(userId, { type: 'error', message: error.message })
        return
      }
      throw error
    }
    this.broadcast()
  }

  private async dispatch(userId: string, message: ClientMessage) {
    if (!this.users.has(userId)) throw new ClubError('signInAgain', {}, 401)
    switch (message?.type) {
      case 'createTable':
        return this.createTable(userId)
      case 'joinTable':
        return this.joinTable(userId, this.requireTable(message.tableId))
      case 'sit':
        if (!isSeat(message.seat)) throw new ClubError('badSeat')
        return this.sit(userId, this.requireTable(message.tableId), message.seat)
      case 'stand':
        return this.stand(userId)
      case 'leaveTable':
        return this.leave(userId)
      case 'freeSeat':
        return this.freeSeat(userId, message.seat)
      case 'chat':
        return this.chat(userId, message.text)
      case 'ready':
        return this.ready(userId)
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

  // ── Tables ──────────────────────────────────────────────────────────────────────────────────

  private tableOf(userId: string): Table | undefined {
    return [...this.tables.values()].find(
      (t) => t.spectators.includes(userId) || SEATS.some((s) => t.seats[s] === userId),
    )
  }

  private seatOf(table: Table, userId: string): Seat | null {
    return SEATS.find((s) => table.seats[s] === userId) ?? null
  }

  private requireTable(tableId: unknown): Table {
    const table = typeof tableId === 'string' ? this.tables.get(tableId) : undefined
    if (!table) throw new ClubError('tableGone', {}, 404)
    return table
  }

  private async createTable(userId: string) {
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
      ready: [],
      chat: [],
      createdAt: this.now(),
    }
    this.tables.set(table.id, table)
    await this.save(table)
  }

  private async joinTable(userId: string, table: Table) {
    if (this.tableOf(userId) === table) return
    await this.leave(userId)
    table.spectators.push(userId)
    await this.save(table)
  }

  private async sit(userId: string, table: Table, seat: Seat) {
    const current = this.tableOf(userId)
    const currentSeat = current === table ? this.seatOf(table, userId) : null
    if (currentSeat === seat) return
    if (table.seats[seat]) throw new ClubError('seatTaken')
    if (currentSeat && table.board && table.board.phase !== 'finished')
      throw new ClubError('noSeatChange')
    if (current !== table) await this.leave(userId)

    table.spectators = table.spectators.filter((id) => id !== userId)
    if (currentSeat) {
      table.seats[currentSeat] = null
      table.ready = table.ready.filter((s) => s !== currentSeat)
    }
    table.seats[seat] = userId
    this.startBoardIfReady(table)
    await this.save(table)
  }

  private async stand(userId: string) {
    const table = this.tableOf(userId)
    const seat = table && this.seatOf(table, userId)
    if (!table || !seat) return
    this.vacate(table, seat)
    table.spectators.push(userId)
    await this.save(table)
  }

  private async leave(userId: string) {
    const table = this.tableOf(userId)
    if (!table) return
    const seat = this.seatOf(table, userId)
    if (seat) this.vacate(table, seat)
    table.spectators = table.spectators.filter((id) => id !== userId)
    await this.saveOrDrop(table)
  }

  /** Anyone at the table may free the seat of a player who has gone offline */
  private async freeSeat(userId: string, seat: unknown) {
    const table = this.tableOf(userId)
    if (!table) throw new ClubError('notAtTable')
    if (!isSeat(seat) || !table.seats[seat]) return
    if (this.connections.onlineUserIds().includes(table.seats[seat]!))
      throw new ClubError('freeOfflineOnly')
    this.vacate(table, seat)
    await this.save(table)
  }

  private vacate(table: Table, seat: Seat) {
    table.seats[seat] = null
    table.ready = table.ready.filter((s) => s !== seat)
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

  private async ready(userId: string) {
    const table = this.tableOf(userId)
    const seat = table && this.seatOf(table, userId)
    if (!table || !seat || table.board?.phase !== 'finished') return
    if (!table.ready.includes(seat)) table.ready.push(seat)
    this.startBoardIfReady(table)
    await this.save(table)
  }

  /** Deals the next board once all four seats are taken and everyone is done with the last one */
  private startBoardIfReady(table: Table) {
    if (SEATS.some((s) => !table.seats[s])) return
    const board = table.board
    if (board && (board.phase !== 'finished' || table.ready.length < 4)) return
    table.board = newBoard(table.boardsPlayed + 1, deal(this.random))
    table.ready = []
    table.undo = undefined
    table.recordId = undefined
  }

  // ── Bidding and play ────────────────────────────────────────────────────────────────────────

  private async boardAction(userId: string, message: ClientMessage) {
    const table = this.tableOf(userId)
    const seat = table && this.seatOf(table, userId)
    if (!table || !seat) throw new ClubError('notSeated')
    const board = table.board
    if (!board) throw new ClubError('noBoard')

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
        break
      case 'play': {
        if (!isCard(message.card)) throw new ClubError('unknownCard')
        const dummy = dummyOf(board)
        const hand =
          dummy && remainingCards(board, dummy).includes(message.card) ? dummy : seat
        if (controllerOf(board, hand) !== seat) throw new ClubError('notYourCard')
        next = playCard(board, hand, message.card)
        break
      }
      case 'claim':
        next = makeClaim(board, seat, Number(message.tricks))
        break
      case 'claimRespond':
        next = respondToClaim(board, seat, Boolean(message.accept))
        break
      case 'undoRequest': {
        // During play the declarer may take back dummy's card; otherwise only one's own action
        const actor = lastActor(board)
        const mine = board.play.length ? actor && controllerOf(board, actor) === seat : actor === seat
        if (!mine) throw new ClubError('undoOwnOnly')
        if (board.claim) throw new ClubError('claimPending')
        table.undo = { seat }
        await this.save(table)
        return
      }
      case 'undoRespond': {
        const undo = table.undo
        if (!undo) return
        if (sameSide(undo.seat, seat)) throw new ClubError('undoByOpponent')
        table.undo = undefined
        if (message.accept) table.board = undoLast(board)
        await this.save(table)
        return
      }
      default:
        return
    }

    // Any new action supersedes a pending undo request
    table.undo = undefined
    table.board = next
    if (next.phase === 'finished' && board.phase !== 'finished') await this.recordBoard(table, next)
    await this.save(table)
  }

  private async recordBoard(table: Table, board: BoardState) {
    const players = {} as BoardRecord['players']
    for (const seat of SEATS) {
      const user = table.seats[seat] ? this.users.get(table.seats[seat]!) : undefined
      players[seat] = user ? publicUser(user) : { id: '', username: '—' }
    }
    const finishedAt = this.now()
    const record: BoardRecord = {
      id: randomId(8),
      tableNumber: table.number,
      finishedAt,
      players,
      board,
    }
    // Zero-padded time keeps the history listing in chronological order
    await this.store.put(`board:${String(finishedAt).padStart(14, '0')}-${record.id}`, record)
    table.recordId = record.id
    table.boardsPlayed++
  }

  // ── Persistence and broadcasting ────────────────────────────────────────────────────────────

  private async save(table: Table) {
    await this.store.put(`table:${table.id}`, table)
  }

  /** Closes a table nobody is sitting at or watching */
  private async saveOrDrop(table: Table) {
    if (table.spectators.length === 0 && SEATS.every((s) => !table.seats[s])) {
      this.tables.delete(table.id)
      await this.store.delete(`table:${table.id}`)
    } else {
      await this.save(table)
    }
  }

  /** Sends every online user the lobby and the table they are at. A club is small enough for this. */
  broadcast() {
    const online = this.connections.onlineUserIds()
    for (const userId of online) {
      this.connections.send(userId, { type: 'lobby', lobby: this.lobbyView(userId, online) })
      const table = this.tableOf(userId)
      this.connections.send(userId, { type: 'table', table: table ? this.tableView(table, userId) : null })
    }
  }

  lobbyView(userId: string, online = this.connections.onlineUserIds()): LobbyView {
    const isOnline = (id: string) => online.includes(id)
    const tables: TableSummary[] = [...this.tables.values()]
      .sort((a, b) => a.number - b.number)
      .map((t) => ({
        id: t.id,
        number: t.number,
        hostName: this.users.get(t.hostId)?.username ?? '—',
        seats: seatOccupants(t, (id) => this.publicUserById(id), isOnline),
        spectators: t.spectators.length,
        boardsPlayed: t.boardsPlayed,
        boardNo: t.board ? t.board.boardNo : null,
      }))
    return {
      online: online.flatMap((id) => this.publicUserById(id) ?? []),
      tables,
      myTableId: this.tableOf(userId)?.id ?? null,
    }
  }

  tableView(table: Table, userId: string): TableView {
    const online = this.connections.onlineUserIds()
    const mySeat = this.seatOf(table, userId)
    return {
      id: table.id,
      number: table.number,
      hostId: table.hostId,
      seats: seatOccupants(table, (id) => this.publicUserById(id), (id) => online.includes(id)),
      spectators: table.spectators.flatMap((id) => this.publicUserById(id) ?? []),
      mySeat,
      board: table.board
        ? boardView(table.board, mySeat, { undo: table.undo, recordId: table.recordId })
        : null,
      boardsPlayed: table.boardsPlayed,
      ready: table.ready,
      chat: table.chat,
    }
  }

  private publicUserById(id: string): PublicUser | undefined {
    const user = this.users.get(id)
    return user && publicUser(user)
  }
}

const publicUser = (user: StoredUser): PublicUser => ({ id: user.id, username: user.username })

