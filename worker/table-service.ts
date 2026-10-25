import { isCall } from '../shared/auction.ts'
import type { RandomInt } from '../shared/board.ts'
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
import { AppError } from '../shared/messages.ts'
import {
  DEAL_COUNTDOWN_MS,
  DEFAULT_TABLE_SETTINGS,
  isRobotId,
  isRobotKind,
  LAST_TRICK_MS,
  LIMITS,
  robotId,
  robotKindOf,
  SLOW_TURN_MS,
  SUBSTITUTE_MS,
  summarize,
  type BoardRecord,
  type ClientMessage,
  type PublicUser,
  type RobotKind,
  type ServerMessage,
  type TableAction,
  type TableChallenge,
  type TableSettings,
  type TableView,
  type TableWire,
} from '../shared/protocol.ts'
import { ruleBrain, type RobotBrain } from '../shared/robot/brain.ts'
import { inferredMeaning, type RobotBid } from '../shared/robot/robots.ts'
import { randomId } from './auth.ts'
import { ClubError } from './errors.ts'
import { challengeStateOf, challengeTableOpen, modeOf, nextTableSeq, type EventReport, type ModeContext } from './modes.ts'
import type { Scheduler } from './scheduler.ts'
import type { ClubLink, Named, Person, TableApi, TableEntry, Tables } from './tables.ts'
import { boardView, chatFor, recordVisible, seatOccupants, type Table } from './views.ts'

/** Who is connected to the table; in one process the club's connections, in production the table's own sockets */
export interface TableConnections {
  onlineUserIds(): string[]
  send(userId: string, message: ServerMessage): void
}

/** Where one table is kept: `table:<id>` in the club's storage (H1a), or the table's own object */
export interface TableStore {
  save(table: Table): Promise<void>
  remove(tableId: string): Promise<void>
}

export interface TableConfig {
  now: () => number
  random: RandomInt
  /** What the robots think with; the rule robot unless a stronger brain is given */
  brain?: RobotBrain
  /** How long the brain may think before the rule robot answers instead (ms) */
  thinkLimitMs?: number
  /** Robot moves, the next deal and robot substitutes */
  scheduler: Scheduler
}

const CHAT_KEEP = 100
/** Boards a table keeps for its History panel */
const RECENT_KEEP = 30
/**
 * How long robots wait before acting, so people can follow the play: a card glides to the middle
 * for 1.3 s, and a finished trick stays on the table until its winner leads again
 */
const ROBOT_DELAY = { call: 800, card: 1400, afterTrick: 3000, answer: 400 }
export const ROBOT_NAME = 'Robot'
/** The most a robot brain may think per action before the rule robot answers instead (AC-6.5) */
const THINK_LIMIT_MS = 2000
/** How soon a finished board's record is offered to the club again after a failure */
const OUTBOX_RETRY_MS = 30_000

/** A robot's move, once its brain has answered */
interface RobotAnswer {
  message: ClientMessage
  meaning?: RobotBid['meaning']
}

/** A table's settings; a field saved by an older version (a robot level) is dropped */
export function settingsOf(table: Pick<Table, 'settings'>): TableSettings {
  const { visibility, allowKibitz, boardMinutes } = { ...DEFAULT_TABLE_SETTINGS, ...table.settings }
  return { visibility, allowKibitz, boardMinutes }
}

export const robotUser = (id: string): PublicUser => ({ id, username: ROBOT_NAME, robot: true, robotKind: robotKindOf(id) })

/** A finished board waiting for the club to take its record (ARCHITECTURE.md §5.10) */
interface Outgoing {
  record: BoardRecord
  event: EventReport | null
}

/**
 * One table: its seats and watchers, bidding and play, robots, the next deal, time limits, robot
 * substitutes, chat, and what each person at it sees (ARCHITECTURE.md §5.10). It knows nothing of
 * the club but what the club gives it with each call (names, blocks, a challenge's snapshot), and
 * tells the club only what the lobby shows (`ClubLink.changed`) and the boards it finishes. All
 * state is written through to its `TableStore`, so its object can be evicted at any time.
 */
export class TableService implements TableApi {
  readonly id: string
  private table: Table | null = null
  private readonly store: TableStore
  private readonly connections: TableConnections
  private readonly link: ClubLink
  private readonly config: TableConfig
  private readonly now: () => number
  private readonly brain: RobotBrain
  private readonly scheduler: Scheduler
  /** What each person was last sent (as JSON), so a change that is not theirs is not sent */
  private readonly sent = new Map<string, { table?: string; chat?: string; recent?: string }>()
  /** Since when each seated member who dropped offline has been away, for their robot substitute (代打) */
  private readonly offlineSince = new Map<string, number>()
  /** A robot is thinking; nothing else is scheduled for the table until it answers */
  private thinking = false
  /** The entry last reported to the club, and its JSON without `rev` */
  private entry: TableEntry | null = null
  private reported: string | undefined
  private rev = 0

  constructor(id: string, store: TableStore, connections: TableConnections, link: ClubLink, config: TableConfig) {
    this.id = id
    this.store = store
    this.connections = connections
    this.link = link
    this.config = config
    this.now = config.now
    this.brain = config.brain ?? ruleBrain
    this.scheduler = config.scheduler
  }

  /** The table as it is now, or null once it closed (for tests and the Durable Object) */
  get state(): Table | null {
    return this.table
  }

  // ── Loading ─────────────────────────────────────────────────────────────────────────────────

  /**
   * Takes a table back after its object was evicted (or the club was): its jobs are scheduled
   * again from its state (jobs are not stored), and whoever is seated but offline counts as away
   * from now. Nothing is sent, and the club is not told: it has the entry from before (in its
   * directory), and an object waking from hibernation should not call it each time
   */
  async restore(table: Table): Promise<TableEntry> {
    this.load(table)
    this.scheduleRobots()
    this.report(false)
    if (table.outbox?.length) this.retryOutbox(0)
    return this.entry!
  }

  /**
   * Takes over a table kept somewhere else until now (`TableApi.adopt`): saved here as it is. When
   * this table already has its state (the move is being done again), that state wins
   */
  async adopt(table: Table): Promise<TableEntry | null> {
    if (this.table) return this.entry ?? this.settled()
    const entry = await this.restore(table)
    await this.save()
    return entry
  }

  /**
   * Whether a member may hold a connection to this table (ARCHITECTURE.md §5.10): seated, watching,
   * or the player of a parked challenge table
   */
  admits(userId: string): boolean {
    const table = this.table
    return !!table && (this.isAt(userId) || challengeStateOf(table)?.userId === userId)
  }

  private load(table: Table) {
    this.table = table
    this.sent.clear()
    this.offlineSince.clear()
    this.scheduleDeal()
    const online = this.connections.onlineUserIds()
    for (const seat of SEATS) {
      const id = table.seats[seat]
      if (id && !isRobotId(id) && !online.includes(id) && table.mode !== 'challenge') this.awayFrom(id, this.now())
    }
  }

  // ── The club's calls (TableApi) ─────────────────────────────────────────────────────────────

  async open(table: Table): Promise<TableEntry> {
    this.load(table)
    if (!table.board) this.startBoardIfReady()
    await this.save()
    return this.settled()!
  }

  async join(person: Person): Promise<TableEntry> {
    const table = this.require()
    if (this.isAt(person.id)) return this.settled()!
    // Someone else's challenge table is not there for anyone to see
    if (table.mode === 'challenge') throw new ClubError('tableGone', {}, 404)
    if (!settingsOf(table).allowKibitz) throw new ClubError('noKibitzing', {}, 403)
    this.welcome(person)
    table.spectators.push(person.id)
    await this.save()
    return this.settled()!
  }

  async sit(person: Person, seat: Seat): Promise<TableEntry> {
    const table = this.require()
    const userId = person.id
    const here = this.isAt(userId)
    const currentSeat = here ? this.seatOf(userId) : null
    if (currentSeat === seat) return this.settled()!
    if (table.mode === 'challenge') {
      if (here) throw new ClubError('challengeTableFixed')
      throw new ClubError('tableGone', {}, 404)
    }
    // A person may take a robot's seat at any time, as on BBO
    const occupant = table.seats[seat]
    if (occupant && !isRobotId(occupant)) throw new ClubError('seatTaken')
    if (currentSeat && table.board && table.board.phase !== 'finished') throw new ClubError('noSeatChange')
    this.welcome(person)
    table.spectators = table.spectators.filter((id) => id !== userId)
    if (currentSeat) this.vacate(currentSeat)
    // A robot sitting in for someone offline gives the seat up for good
    if (table.substitutes?.[seat]) delete table.substitutes[seat]
    table.seats[seat] = userId
    this.touchTurn()
    this.startBoardIfReady()
    await this.save()
    return this.settled()!
  }

  async leave(userId: string): Promise<TableEntry | null> {
    const table = this.table
    if (!table || !this.isAt(userId)) return this.settled()
    const seat = this.seatOf(userId)
    this.sent.delete(userId)
    this.offlineSince.delete(userId)
    const challenge = challengeStateOf(table)
    if (challenge) {
      // Leaving a challenge table only pauses it (中途斷線視同暫停): it waits with the board as it
      // was until they come back. One with nothing left to play closes
      if (this.challengeTableOver()) {
        await this.drop()
        return null
      }
      if (seat) {
        challenge.parkedSeat = seat
        this.vacate(seat)
      }
      await this.save()
      return this.settled()
    }
    if (seat) this.vacate(seat)
    table.spectators = table.spectators.filter((id) => id !== userId)
    this.checkHost()
    return this.saveOrDrop()
  }

  async configure(userId: string, settings: Partial<TableSettings>, invited?: Named[]): Promise<TableEntry> {
    const table = this.hostTable(userId)
    table.settings = { ...settingsOf(table), ...settings }
    if (invited) {
      table.invited = invited.map((member) => member.id)
      for (const member of invited) this.name(member)
    }
    await this.save()
    return this.settled()!
  }

  async resume(person: Person): Promise<TableEntry> {
    const table = this.require()
    const state = challengeStateOf(table)
    if (!state || state.userId !== person.id) throw new ClubError('tableGone', {}, 404)
    if (this.isAt(person.id)) return this.settled()!
    this.welcome(person)
    table.seats[state.parkedSeat ?? 'S'] = person.id
    state.parkedSeat = undefined
    table.hostId = person.id
    this.startBoardIfReady()
    await this.save()
    return this.settled()!
  }

  async reclaim(userId: string, reseat: boolean): Promise<TableEntry | null> {
    const table = this.table
    const seat = table && this.substituteSeat(userId)
    if (!table || !seat) return this.settled()
    delete table.substitutes![seat]
    if (reseat && isRobotId(table.seats[seat]) && !this.isAt(userId)) {
      table.seats[seat] = userId
      this.touchTurn()
    }
    await this.save()
    return this.settled()
  }

  /**
   * A member at the table came online: they get everything again. One who dropped offline:
   * spectators leave; seated players keep their seat, but a host who drops out hands the table
   * to someone still there, and a robot sits in for them after SUBSTITUTE_MS
   */
  async presence(userId: string, online: boolean): Promise<TableEntry | null> {
    const table = this.table
    this.sent.delete(userId)
    if (!table || !this.isAt(userId)) return this.settled()
    if (online) {
      this.offlineSince.delete(userId)
      return this.settled()
    }
    if (table.spectators.includes(userId)) {
      table.spectators = table.spectators.filter((id) => id !== userId)
      this.checkHost()
      return this.saveOrDrop()
    }
    this.checkHost()
    await this.save()
    // Away for SUBSTITUTE_MS, TKB plays for them until they come back (代打)
    if (table.mode !== 'challenge') this.awayFrom(userId, this.now())
    return this.settled()
  }

  async blocked(userId: string, blocked: string[]): Promise<void> {
    const table = this.table
    if (!table) return
    table.blocks = { ...table.blocks, [userId]: blocked }
    await this.save()
    this.settled()
  }

  async forget(userId: string): Promise<TableEntry | null> {
    const table = this.table
    if (!table) return null
    // Their challenges forget them, so their parked challenge table goes too
    if (challengeStateOf(table)?.userId === userId) {
      await this.drop()
      return null
    }
    // Invitations and robot substitutes for them are forgotten; the robot stays in the seat
    const seat = this.substituteSeat(userId)
    if (table.invited) table.invited = table.invited.filter((id) => id !== userId)
    if (seat) delete table.substitutes![seat]
    if (table.names) delete table.names[userId]
    if (table.blocks) delete table.blocks[userId]
    this.offlineSince.delete(userId)
    this.sent.delete(userId)
    await this.save()
    return this.settled()
  }

  /**
   * The table's challenge ended (finished, expired or cancelled): a board still being played is
   * dropped, as the deadline stops play; only someone still sitting after their last board keeps
   * the table until they leave
   */
  async challengeEnded(): Promise<TableEntry | null> {
    const table = this.table
    const state = table && challengeStateOf(table)
    if (!table || !state) return this.settled()
    state.closed = true
    const done = nextTableSeq(state) === null && table.board?.phase === 'finished'
    if (done && this.humansSeated() > 0) {
      await this.save()
      return this.settled()
    }
    await this.drop()
    return null
  }

  async close(): Promise<void> {
    await this.drop()
  }

  async act(userId: string, message: TableAction): Promise<TableEntry | null> {
    switch (message.type) {
      case 'stand':
        await this.stand(userId)
        break
      case 'kick':
        await this.kick(userId, message.seat)
        break
      case 'addRobot':
        await this.addRobot(userId, message.seat, message.kind)
        break
      case 'removeRobot':
        await this.removeRobot(userId, message.seat)
        break
      case 'replaceWithRobot':
        await this.replaceWithRobot(userId, message.seat, message.kind)
        break
      case 'chat':
        await this.chat(userId, message.text)
        break
      case 'call':
      case 'play':
      case 'claim':
      case 'claimRespond':
      case 'undoRequest':
      case 'undoRespond':
        await this.boardAction(userId, message)
        break
      default:
        throw new ClubError('unknownCommand')
    }
    return this.settled()
  }

  /** What one member sees of the table (`tableView`), for tests and the Durable Object */
  view(userId: string): TableView | null {
    return this.table && this.tableView(this.table, userId)
  }

  // ── Seats ───────────────────────────────────────────────────────────────────────────────────

  private require(): Table {
    if (!this.table) throw new ClubError('tableGone', {}, 404)
    return this.table
  }

  /** Whether a member is at the table: in a seat or watching */
  private isAt(userId: string): boolean {
    const table = this.table
    return !!table && (table.spectators.includes(userId) || SEATS.some((s) => table.seats[s] === userId))
  }

  private seatOf(userId: string): Seat | null {
    return SEATS.find((s) => this.table!.seats[s] === userId) ?? null
  }

  private humansSeated() {
    const table = this.table!
    return SEATS.filter((s) => table.seats[s] && !isRobotId(table.seats[s])).length
  }

  /** Notes a member's name and blocks as they come to the table */
  private welcome(person: Person) {
    const table = this.table!
    this.name(person)
    table.blocks = { ...table.blocks, [person.id]: person.blocked }
  }

  private name(member: Named) {
    const table = this.table!
    table.names = { ...table.names, [member.id]: member.username }
  }

  private async stand(userId: string) {
    const table = this.table
    const seat = table && this.isAt(userId) ? this.seatOf(userId) : null
    if (!table || !seat) return
    this.checkNotChallenge()
    this.vacate(seat)
    table.spectators.push(userId)
    await this.save()
  }

  /** Only the host runs the table: asking people to leave a seat, adding and removing robots */
  private hostTable(userId: string): Table {
    const table = this.table
    if (!table || !this.isAt(userId)) throw new ClubError('notAtTable')
    if (table.hostId !== userId) throw new ClubError('hostOnly')
    this.checkNotChallenge()
    return table
  }

  /** At a challenge table nobody watches or takes back a call or card, and seats and settings stay */
  private checkNotChallenge() {
    if (this.table!.mode === 'challenge') throw new ClubError('challengeTableFixed')
  }

  /**
   * The host is whoever opened the table; when they leave or drop offline, the first person still
   * at the table and online takes over (a seated player before a spectator)
   */
  private checkHost() {
    const table = this.table!
    const online = this.connections.onlineUserIds()
    const people = [
      ...SEATS.map((s) => table.seats[s]).filter((id): id is string => !!id && !isRobotId(id)),
      ...table.spectators,
    ]
    if (people.includes(table.hostId) && online.includes(table.hostId)) return
    const next = people.find((id) => online.includes(id))
    if (next) table.hostId = next
  }

  /** The host may ask anyone else to leave their seat; they stay at the table, watching */
  private async kick(userId: string, seat: unknown) {
    const table = this.hostTable(userId)
    if (!isSeat(seat)) throw new ClubError('badSeat')
    const occupant = table.seats[seat]
    if (!occupant || isRobotId(occupant)) return
    if (occupant === userId) throw new ClubError('notSelf')
    this.vacate(seat)
    table.spectators.push(occupant)
    await this.save()
  }

  /** Seats TKB: in the club's system unless the host chose 2/1 */
  private async addRobot(userId: string, seat: unknown, kind: unknown = 'tku') {
    const table = this.hostTable(userId)
    if (!isSeat(seat)) throw new ClubError('badSeat')
    if (!isRobotKind(kind)) throw new ClubError('unknownRobot')
    if (table.seats[seat]) throw new ClubError('seatTaken')
    table.seats[seat] = robotId(kind, seat)
    this.startBoardIfReady()
    await this.save()
  }

  private async removeRobot(userId: string, seat: unknown) {
    const table = this.hostTable(userId)
    if (!isSeat(seat)) throw new ClubError('badSeat')
    if (!isRobotId(table.seats[seat])) throw new ClubError('seatNotRobot')
    this.vacate(seat)
    await this.save()
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
    this.vacate(seat)
    table.seats[seat] = robotId(kind, seat)
    table.spectators.push(occupant)
    this.touchTurn()
    await this.save()
  }

  private vacate(seat: Seat) {
    const table = this.table!
    table.seats[seat] = null
    if (table.undo?.seat === seat) table.undo = undefined
    if (table.substitutes?.[seat]) delete table.substitutes[seat]
  }

  /** The table starts waiting on someone anew: the reminder clock (SLOW_TURN_MS) restarts */
  private touchTurn() {
    this.table!.turnSince = this.now()
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

  private async chat(userId: string, text: unknown) {
    const table = this.table
    const clean = String(text ?? '').trim().slice(0, LIMITS.chatMax)
    if (!table || !this.isAt(userId) || !clean) return
    const username = table.names?.[userId] ?? '—'
    table.chat = [...table.chat, { id: randomId(6), at: this.now(), userId, username, text: clean }].slice(-CHAT_KEEP)
    await this.save()
  }

  // ── Robot substitutes (代打, e2-t31) ─────────────────────────────────────────────────────────

  /** The seat where a robot sits in for this member at the table, if any */
  private substituteSeat(userId: string): Seat | undefined {
    return SEATS.find((seat) => this.table?.substitutes?.[seat] === userId)
  }

  /** Notes that a seated member went offline at `since` and queues the job that seats their substitute */
  private awayFrom(userId: string, since: number) {
    if (!this.offlineSince.has(userId)) this.offlineSince.set(userId, since)
    const left = SUBSTITUTE_MS - (this.now() - this.offlineSince.get(userId)!)
    this.scheduler.add(`substitute:${this.id}:${userId}`, 'substitute', Math.max(0, left), () => this.substituteDue(userId))
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
    const table = this.table
    const seat = table && this.isAt(userId) ? this.seatOf(userId) : null
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
    this.sent.delete(userId)
    this.checkHost()
    this.touchTurn()
    await this.save()
    this.settled()
  }

  // ── Dealing ─────────────────────────────────────────────────────────────────────────────────

  /**
   * Deals the first board as soon as all four seats are taken (by people or robots) and at least
   * one person is seated. After that every board is dealt by itself, as on BBO: nobody has to
   * press "next board". The browsers count down the last DEAL_COUNTDOWN_MS from `dealAt`.
   */
  private startBoardIfReady() {
    const table = this.table!
    if (!this.canDeal()) return
    if (!table.board) return this.dealBoard()
    table.dealAt = Math.max(table.dealAt ?? 0, this.now() + DEAL_COUNTDOWN_MS)
    this.scheduleDeal()
  }

  private canDeal() {
    const table = this.table!
    return SEATS.every((s) => table.seats[s]) && this.humansSeated() > 0 && (!table.board || table.board.phase === 'finished')
  }

  private dealBoard() {
    const table = this.table!
    const dealt = modeOf(table).deal(table, this.modeContext())
    // The mode has no more boards: the last one stays on the table
    if (!dealt) {
      table.dealAt = undefined
      return
    }
    // A person who declared from a robot partner's seat goes back to their own for the new board
    this.unswap()
    table.board = dealt.board ?? newBoard(dealt.boardNo, dealt.hands)
    table.undo = undefined
    table.rejectedClaim = undefined
    table.recordId = undefined
    table.dealAt = undefined
    table.boardStartedAt = this.now()
    // A robot still sitting in for someone plays this board for them too
    table.boardSubstitutes = table.substitutes && { ...table.substitutes }
    // A board dealt with its auction made (Just Declare) goes straight to the play
    if (table.board.phase === 'play') this.swapForDeclarer()
    this.touchTurn()
  }

  /**
   * A person never sits out a board as dummy for a robot: when a robot partner becomes declarer,
   * the person moves into the declarer's seat and plays the hand from there, as on BBO (the robot
   * takes the person's seat, which is now dummy)
   */
  private swapForDeclarer() {
    const table = this.table!
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
    this.moveSubstitute(declarer, dummy)
  }

  /** A robot sitting in for someone (代打) moved seats: the note goes with it */
  private moveSubstitute(from: Seat, to: Seat) {
    const table = this.table!
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
  private unswap() {
    const table = this.table!
    if (!table.swapped) return
    const [declarer, dummy] = table.swapped
    const person = table.seats[declarer]
    if (person && !isRobotId(person) && isRobotId(table.seats[dummy])) {
      const robot = table.seats[dummy]!
      table.seats[dummy] = person
      table.seats[declarer] = robotId(robotKindOf(robot), declarer)
      this.moveSubstitute(dummy, declarer)
    }
    table.swapped = undefined
  }

  private scheduleDeal() {
    const table = this.table
    if (!table?.board || !this.canDeal()) return
    const ms = Math.max(0, (table.dealAt ?? 0) - this.now())
    this.scheduler.add(`deal:${table.id}`, 'deal', ms, () => this.dealNext())
  }

  private async dealNext() {
    const table = this.table
    // Someone may have stood up while the result was showing; sitting down deals again
    if (!table || !this.canDeal()) return
    // The countdown was restarted (a seat was filled again): wait for it
    if ((table.dealAt ?? 0) > this.now() + 50) return this.scheduleDeal()
    this.dealBoard()
    await this.save()
    this.settled()
  }

  // ── Challenge tables ────────────────────────────────────────────────────────────────────────

  /**
   * Whether a challenge table has nothing left to play: the challenge closed or is past its
   * deadline, or the participant finished every board and the last one is over
   */
  private challengeTableOver(): boolean {
    const table = this.table!
    const state = challengeStateOf(table)
    if (!state) return false
    if (!challengeTableOpen(state, this.now())) return true
    return nextTableSeq(state) === null && (!table.board || table.board.phase === 'finished')
  }

  /** A challenge table whose challenge is closed or past its deadline: nothing more is played there */
  private challengeClosed(): boolean {
    const state = challengeStateOf(this.table!)
    return !!state && !challengeTableOpen(state, this.now())
  }

  /** What a challenge table's player sees of the challenge: which board of how many, until when */
  private tableChallenge(table: Table): TableChallenge | undefined {
    const state = challengeStateOf(table)
    if (!state) return undefined
    return {
      id: state.challengeId,
      seq: state.seq,
      boards: state.boards.length,
      played: state.played.length,
      deadline: state.deadline,
    }
  }

  // ── Bidding and play ────────────────────────────────────────────────────────────────────────

  private async boardAction(userId: string, message: TableAction) {
    const table = this.table
    const seat = table && this.isAt(userId) ? this.seatOf(userId) : null
    if (!table || !seat) throw new ClubError('notSeated')
    if (table.mode === 'challenge' && (message.type === 'undoRequest' || message.type === 'undoRespond'))
      throw new ClubError('challengeNoUndo')
    await this.applyAction(seat, message)
  }

  /** Applies one board action for a seat, from a person or a robot */
  private async applyAction(seat: Seat, message: ClientMessage, byRobot = false, meaning?: RobotBid['meaning']) {
    const table = this.table!
    const board = table.board
    if (!board) throw new ClubError('noBoard')
    // At the deadline play stops, as on BBO: a board still going is dropped, not finished
    if (this.challengeClosed()) throw new ClubError('challengeClosed')

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
        } else {
          // A person's call carries what the engine reads it as, in their side's system: a robot
          // partner's, or the club's (e5-t22); like a convention card, it is for everyone
          const partner = table.seats[partnerOf(seat)]
          const kind: RobotKind = partner && isRobotId(partner) ? robotKindOf(partner) : 'tku'
          const inferred = inferredMeaning(kind, next.auction, next.dealer, next.vul)
          if (inferred) next = { ...next, auction: [...board.auction, { ...next.auction.at(-1)!, meaning: inferred, inferred: kind }] }
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
        await this.save()
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
          if (table.board.phase === 'auction') this.unswap()
        }
        this.touchTurn()
        await this.save()
        return
      }
      default:
        return
    }

    // Any new action supersedes a pending undo request and the note about a rejected claim
    table.undo = undefined
    if (message.type !== 'claimRespond') table.rejectedClaim = undefined
    table.board = next
    this.touchTurn()
    if (board.phase === 'auction' && next.phase === 'play') this.swapForDeclarer()
    const finished = next.phase === 'finished' && board.phase !== 'finished'
    if (finished) {
      const record = this.recordBoard(next)
      const event = modeOf(table).boardFinished(table, record, this.modeContext())
      // Saved with the table first, so a record the club has not taken yet is never lost (§5.10)
      table.outbox = [...(table.outbox ?? []), { record, event }]
      // A board played to the last card leaves that trick on the table for a moment first
      const playedOut = next.play.length === 52
      table.dealAt = this.now() + (playedOut ? LAST_TRICK_MS : 0) + DEAL_COUNTDOWN_MS
      this.startBoardIfReady()
    }
    await this.save()
    // The club keeps the record and, for a challenge, its result; the last board of the last
    // participant finishes the challenge before its deadline
    if (finished) await this.sendOutbox()
  }

  /** The record of a finished board; the club stores it (`ClubLink.boardFinished`) */
  private recordBoard(board: BoardState): BoardRecord {
    const table = this.table!
    const players = {} as BoardRecord['players']
    for (const seat of SEATS) players[seat] = this.publicUser(table.seats[seat] ?? '') ?? { id: '', username: '—' }
    // Seats where a robot played for someone offline during the board (代打), and for whom
    const substitutes: NonNullable<BoardRecord['substitutes']> = {}
    for (const seat of SEATS) {
      const forWhom = table.boardSubstitutes?.[seat]
      const user = forWhom && this.publicUser(forWhom)
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
    table.recordId = record.id
    table.recent = [summarize(record), ...(table.recent ?? [])].slice(0, RECENT_KEEP)
    table.boardsPlayed++
    return record
  }

  /**
   * Hands every finished board waiting in the outbox to the club, oldest first. One the club could
   * not take stays and is offered again later; the club takes the same record twice without harm
   */
  private async sendOutbox() {
    for (;;) {
      const next: Outgoing | undefined = this.table?.outbox?.[0]
      if (!next) return
      try {
        await this.link.boardFinished(next.record, next.event)
      } catch (error) {
        console.error('board record not taken by the club, retrying', next.record.id, error)
        this.retryOutbox(OUTBOX_RETRY_MS)
        return
      }
      // The club may have closed the table meanwhile (its challenge ended)
      const table = this.table
      if (!table?.outbox) return
      table.outbox = table.outbox.filter((item) => item.record.id !== next.record.id)
      if (!table.outbox.length) delete table.outbox
      await this.save()
    }
  }

  private retryOutbox(ms: number) {
    this.scheduler.add(`outbox:${this.id}`, 'outbox', ms, () => this.sendOutbox())
  }

  private modeContext(): ModeContext {
    return { random: this.config.random, now: this.now() }
  }

  // ── Robots ──────────────────────────────────────────────────────────────────────────────────

  /**
   * Which robot at this table acts next and after what pause, if any. What it does is asked of a
   * brain only when the move runs (`decide`), so a slow brain thinks once per move; `decide` takes
   * the brain so the rule robot can answer the same question when the club's brain is late
   */
  private robotMove(): { seat: Seat; delay: number; decide: (brain: RobotBrain) => Promise<RobotAnswer> } | null {
    const table = this.table
    const board = table?.board
    if (!table || !board || board.phase === 'finished' || this.humansSeated() === 0) return null
    if (this.challengeClosed()) return null
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
  private positionOf() {
    const table = this.table!
    const board = table.board
    return JSON.stringify([
      table.seats,
      table.undo ?? null,
      board && [board.boardNo, board.phase, board.auction.length, board.play.length, board.claim ?? null],
    ])
  }

  /** Schedules the next robot move; each move schedules the one after it */
  private scheduleRobots() {
    const key = `robot:${this.id}`
    if (!this.table || this.scheduler.pending(key) || this.thinking) return
    const move = this.robotMove()
    if (!move) return
    this.scheduler.add(key, 'robot', move.delay, () => this.runRobot())
  }

  /**
   * Asks the brain, giving it at most the think limit; when it is late or fails the rule robot
   * answers instead, so the table never stalls (AC-6.5). A late answer is ignored
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

  private async runRobot() {
    const table = this.table
    if (!table) return
    const move = this.robotMove()
    if (!move) return
    // The brain may answer later: other messages go on meanwhile, and nothing else is scheduled
    // for this table until it does
    const position = this.positionOf()
    this.thinking = true
    let answer: RobotAnswer
    try {
      answer = await this.think(move.decide)
    } finally {
      this.thinking = false
    }
    if (this.table !== table) return
    // The table moved on while the robot thought (a person played, an undo, a seat changed): ask again
    if (this.positionOf() !== position) return this.scheduleRobots()
    const { message, meaning } = answer
    try {
      await this.applyAction(move.seat, message, true, meaning)
    } catch (error) {
      // A robot move that turns out illegal must not stall the table: pass or play any legal card
      if (!(error instanceof AppError)) throw error
      console.error('robot move rejected', error.code, move.seat, message)
      const board = table.board!
      const turn = turnOf(board)
      const fallback: ClientMessage | null =
        board.phase === 'auction' ? { type: 'call', call: 'P' } : turn ? { type: 'play', card: legalCards(board, turn)[0] } : null
      if (!fallback) return
      await this.applyAction(move.seat, fallback, true)
    }
    this.settled()
  }

  // ── Persistence, reports and broadcasting ───────────────────────────────────────────────────

  private async save() {
    if (this.table) await this.store.save(this.table)
  }

  /** Closes a table no person is sitting at or watching (robots do not keep it open) */
  private async saveOrDrop(): Promise<TableEntry | null> {
    const table = this.table!
    if (table.spectators.length === 0 && this.humansSeated() === 0) {
      await this.drop()
      return null
    }
    await this.save()
    return this.settled()
  }

  private async drop() {
    const table = this.table
    if (!table) return
    this.table = null
    this.entry = null
    this.reported = undefined
    this.sent.clear()
    this.offlineSince.clear()
    await this.store.remove(table.id)
    await this.link.closed(table.id)
  }

  /**
   * After every change: the people at the table see it, the next robot move is scheduled and the
   * club hears whatever the lobby shows. Returns the table's entry, or null once it closed
   */
  private settled(): TableEntry | null {
    if (!this.table) return null
    this.broadcast()
    this.scheduleRobots()
    this.report()
    return this.entry
  }

  /** What the club keeps of the table (`TableEntry`), without `rev` */
  private describe(table: Table): Omit<TableEntry, 'rev'> {
    const state = challengeStateOf(table)
    return {
      id: table.id,
      number: table.number,
      hostId: table.hostId,
      mode: table.mode ?? 'casual',
      settings: settingsOf(table),
      invited: [...(table.invited ?? [])],
      seats: { ...table.seats },
      spectators: [...table.spectators],
      substitutes: { ...table.substitutes },
      boardsPlayed: table.boardsPlayed,
      boardNo: table.board ? table.board.boardNo : null,
      playing: !!table.board && table.board.phase !== 'finished',
      ...(state && { challenge: { challengeId: state.challengeId, userId: state.userId } }),
    }
  }

  /**
   * Tells the club when anything the lobby shows changed; a card played changes nothing there.
   * `tell = false` only notes the entry (the caller hands it to the club itself, or need not)
   */
  private report(tell = true) {
    const table = this.table
    if (!table) return
    const entry = this.describe(table)
    const json = JSON.stringify(entry)
    if (json === this.reported && this.entry) return
    this.reported = json
    this.rev = Math.max(this.rev + 1, this.now())
    this.entry = { ...entry, rev: this.rev }
    if (tell) void this.link.changed(this.entry)
  }

  /**
   * Sends everyone at the table who is online what changed for them: the chat and recent boards
   * only travel when they change. That keeps each update small on a phone connection
   */
  private broadcast() {
    const table = this.table
    if (!table) return
    const people = new Set([...SEATS.map((s) => table.seats[s]).filter((id): id is string => !!id && !isRobotId(id)), ...table.spectators])
    for (const userId of this.connections.onlineUserIds()) {
      if (!people.has(userId)) continue
      const sent = this.sent.get(userId) ?? {}
      this.sent.set(userId, sent)
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

  private publicUser(id: string): PublicUser | undefined {
    if (isRobotId(id)) return robotUser(id)
    const username = this.table?.names?.[id]
    return username === undefined ? undefined : { id, username }
  }

  /** The seats as everyone sees them, a robot sitting in for someone marked with their name (代打) */
  private occupants(table: Table, isOnline: (id: string) => boolean) {
    const seats = seatOccupants(table, (id) => this.publicUser(id), isOnline)
    for (const seat of SEATS) {
      const forWhom = table.substitutes?.[seat]
      const name = forWhom && table.names?.[forWhom]
      if (seats[seat]?.robot && name) seats[seat] = { ...seats[seat], substituteFor: name }
    }
    return seats
  }

  private tableView(table: Table, userId: string): TableView {
    const online = this.connections.onlineUserIds()
    const mySeat = this.isAt(userId) ? this.seatOf(userId) : null
    const settings = settingsOf(table)
    const playing = !!table.board && table.board.phase !== 'finished'
    const waiting = this.waitingOn(table)
    const blocked = new Set(table.blocks?.[userId] ?? [])
    return {
      id: table.id,
      number: table.number,
      hostId: table.hostId,
      settings,
      seats: this.occupants(table, (id) => isRobotId(id) || online.includes(id)),
      spectators: table.spectators.flatMap((id) => this.publicUser(id) ?? []),
      mySeat,
      board: table.board
        ? boardView(table.board, mySeat, {
            undo: table.undo,
            recordId: table.recordId,
            rejectedClaim: table.rejectedClaim,
            auctionSeat: mySeat ? this.auctionSeat(table, mySeat) : undefined,
            undoAllowed: table.mode !== 'challenge',
            kibitz: settings.allowKibitz,
            robots: Object.fromEntries(SEATS.flatMap((s) => (table.seats[s] && isRobotId(table.seats[s]!) ? [[s, robotKindOf(table.seats[s]!)]] : []))),
          })
        : null,
      boardsPlayed: table.boardsPlayed,
      dealAt: table.board?.phase === 'finished' && this.canDeal() && !this.challengeTableOver() ? (table.dealAt ?? null) : null,
      chat: chatFor(table.chat, (authorId) => blocked.has(authorId)),
      recent: (table.recent ?? []).filter((summary) => recordVisible(summary, userId, this.now())),
      ...(table.mode === 'challenge' && { challenge: this.tableChallenge(table) }),
      ...(table.hostId === userId &&
        table.mode !== 'challenge' && { invited: (table.invited ?? []).flatMap((id) => this.publicUser(id) ?? []) }),
      boardEndsAt:
        playing && settings.boardMinutes > 0 ? (table.boardStartedAt ?? table.createdAt) + settings.boardMinutes * 60_000 : null,
      waiting: waiting && { seat: waiting, since: table.turnSince ?? table.createdAt },
    }
  }
}

/**
 * The tables in the same process as the club (H1a and the tests): one `TableService` each, made
 * when first asked for. In production each table is its own Durable Object (§5.10)
 */
export class LocalTables implements Tables {
  private readonly services = new Map<string, TableService>()
  private readonly make: (tableId: string) => TableService

  constructor(make: (tableId: string) => TableService) {
    this.make = make
  }

  get(tableId: string): TableService {
    let service = this.services.get(tableId)
    if (!service?.state) {
      service = this.make(tableId)
      this.services.set(tableId, service)
    }
    return service
  }

  /** The table's service while it is open, for tests */
  local(tableId: string): TableService | undefined {
    const service = this.services.get(tableId)
    return service?.state ? service : undefined
  }
}
