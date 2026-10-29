import { isCall, type BookNote } from '../shared/auction.ts'
import type { RandomInt } from '../shared/board.ts'
import { isCard, isSeat, partnerOf, sameSide, SEATS, type Seat } from '../shared/cards.ts'
import {
  claimApprovers,
  controllerOf,
  dummyOf,
  endBidding,
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
  DEFAULT_ROBOT_SPEED,
  fixedSeats,
  isRobotId,
  isRobotKind,
  LIMITS,
  robotId,
  robotKindOf,
  ROBOT_PACE,
  slowestSpeed,
  SLOW_TURN_MS,
  soloTable,
  SUBSTITUTE_MS,
  summarize,
  TABLE_REQUEST_COOLDOWN_MS,
  tableSettingsFrom,
  type BoardRecord,
  type ClientMessage,
  type PracticeReview,
  type PublicUser,
  type RobotKind,
  type RobotSpeed,
  type ServerMessage,
  type TableAction,
  type TableChallenge,
  type TableSettings,
  type TableView,
  type TableWire,
} from '../shared/protocol.ts'
import { ruleBrain, type RobotBrain } from '../shared/robot/brain.ts'
import { bookNoteFor, type BookNotes } from '../shared/robot/system/book-spec.ts'
import { inferredMeaning, type RobotBid } from '../shared/robot/robots.ts'
import { randomId } from './auth.ts'
import { reviewSteps, robotBidding } from './practice-review.ts'
import { ClubError } from './errors.ts'
import {
  biddingOnly,
  challengeStateOf,
  challengeTableOpen,
  modeOf,
  nextTableSeq,
  practiceStateOf,
  type EventReport,
  type ModeContext,
} from './modes.ts'
import type { Scheduler } from './scheduler.ts'
import { tableMatch, teamPaused, teamStateOf, teamTableOver } from './team-mode.ts'
import type { ClubLink, MatchTableUpdate, Named, Person, TableApi, TableEntry, Tables } from './tables.ts'
import {
  actorOf,
  boardView,
  chatFor,
  liveRequests,
  mayEnter,
  practiceView,
  recordVisible,
  refusal,
  seatOccupants,
  seatsActedBy,
  tableListed,
  type AccessFacts,
  type Table,
} from './views.ts'

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
  /** How long each robot move took to think (ms), for the status page (e11-t22) */
  onThink?: (ms: number) => void
}

const CHAT_KEEP = 100
/** Boards a table keeps for its History panel */
const RECENT_KEEP = 30
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

/**
 * A table's settings, as saved by any version: an old `visibility` becomes its access mode
 * (`public` stays, `invite` is hidden), a field since dropped (a robot level) goes (`tableSettingsFrom`)
 */
export function settingsOf(table: Pick<Table, 'settings'>): TableSettings {
  return tableSettingsFrom(table.settings)
}

/** What the access rules (`mayEnter`, `tableListed`) need of a table */
const accessFacts = (table: Table): AccessFacts => ({
  mode: table.mode,
  hostId: table.hostId,
  settings: settingsOf(table),
  invited: table.invited,
  approved: table.approved,
})

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
  /** 淡江橋館's words for the club's system, and the deal they were last asked for (`loadBookNotes`) */
  private bookNotes: BookNotes | null = null
  private bookNotesDeal: BoardState['hands'] | null = null
  private bookNotesLoad: Promise<void> | null = null
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
    // Settings saved before the four access modes are brought up to date, and saved so with the next change
    table.settings = settingsOf(table)
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
    if (soloTable(table.mode)) throw new ClubError('tableGone', {}, 404)
    // A team match's player never watches the other room (§5.8); anyone else may watch its tables
    if (this.otherRoom(person.id)) throw new ClubError('matchOtherRoom', {}, 403)
    const team = teamStateOf(table)
    if (team && !team.closed && team.players[team.room].includes(person.id)) {
      // A player a robot sits in for (代打) comes back to their seat; nobody of the match watches
      // its tables while it is on, not even their own room (`e8-t14`, `e11-t13`)
      if (this.substituteSeat(person.id)) {
        this.welcome(person)
        return (await this.reclaim(person.id, true))!
      }
      throw new ClubError('matchNoWatching', {}, 403)
    }
    if (table.mode !== 'team') this.checkAccess(person.id)
    if (!this.watchable(table)) throw new ClubError('noKibitzing', {}, 403)
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
    if (fixedSeats(table.mode)) {
      // Nobody else sits at a challenge or practice table; one they may not see is not there for them
      if (here || (table.mode === 'practice' && tableListed(accessFacts(table), userId, false))) throw this.fixed()
      throw new ClubError('tableGone', {}, 404)
    }
    // The match seats its players; nobody else sits at its tables, nor moves (§5.8)
    if (table.mode === 'team') {
      if (this.otherRoom(userId)) throw new ClubError('matchOtherRoom', {}, 403)
      throw new ClubError('matchTableFixed')
    }
    if (!here) this.checkAccess(userId)
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
    // A team match player keeps their seat while the match is on: going to another page only
    // leaves the page (§5.8); the table goes on, and a robot sits in if they drop offline
    if (seat && this.playsOn()) return this.settled()
    if (seat) this.vacate(seat)
    table.spectators = table.spectators.filter((id) => id !== userId)
    this.checkHost()
    return this.saveOrDrop()
  }

  async configure(userId: string, settings: Partial<TableSettings>, invited?: Named[]): Promise<TableEntry> {
    const table = this.table
    if (!table || !this.isAt(userId)) throw new ClubError('notAtTable')
    if (table.hostId !== userId) throw new ClubError('hostOnly')
    if (soloTable(table.mode)) throw this.fixed()
    if (table.mode === 'team') throw new ClubError('matchTableFixed')
    // At a practice table only who may watch changes: it has no time limit, and watching is what coming in means
    if (table.mode === 'practice' && (settings.allowKibitz !== undefined || settings.boardMinutes !== undefined))
      throw this.fixed()
    table.settings = { ...settingsOf(table), ...settings }
    // Requests wait only at a request table; whoever was let in before stays let in
    if (table.settings.access !== 'request') table.requests = []
    if (invited) {
      table.invited = invited.map((member) => member.id)
      for (const member of invited) this.name(member)
    }
    await this.save()
    return this.settled()!
  }

  async request(person: Person, muted: boolean): Promise<TableEntry> {
    const table = this.require()
    const userId = person.id
    if (soloTable(table.mode) || table.mode === 'team') throw new ClubError('tableGone', {}, 404)
    if (this.isAt(userId)) return this.settled()!
    const facts = accessFacts(table)
    if (!tableListed(facts, userId, false)) throw new ClubError('tableGone', {}, 404)
    // Nothing to ask for: they may come in as it is
    if (mayEnter(facts, userId, false)) return this.settled()!
    if (facts.settings.access !== 'request') throw new ClubError('tableClosed', {}, 403)
    const now = this.now()
    const declined = table.declined?.[userId]
    if (declined !== undefined && now - declined < TABLE_REQUEST_COOLDOWN_MS) throw new ClubError('requestCooldown', {}, 429)
    const waiting = liveRequests(table.requests, now)
    if (!waiting.some((r) => r.userId === userId)) waiting.push({ userId, at: now, ...(muted && { muted: true }) })
    table.requests = waiting
    this.name(person)
    await this.save()
    return this.settled()!
  }

  async answerRequest(hostId: string, userId: string, accept: boolean): Promise<TableEntry> {
    const table = this.table
    if (!table || !this.isAt(hostId)) throw new ClubError('notAtTable')
    if (table.hostId !== hostId) throw new ClubError('hostOnly')
    const now = this.now()
    const waiting = liveRequests(table.requests, now)
    if (!waiting.some((r) => r.userId === userId && !r.muted)) throw new ClubError('requestGone', {}, 404)
    table.requests = waiting.filter((r) => r.userId !== userId)
    if (accept) table.approved = [...(table.approved ?? []).filter((id) => id !== userId), userId]
    else {
      // Old refusals are forgotten once their cooldown is over
      const kept = Object.entries(table.declined ?? {}).filter(([, at]) => now - at < TABLE_REQUEST_COOLDOWN_MS)
      table.declined = { ...Object.fromEntries(kept), [userId]: now }
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

  async robotSpeed(userId: string, speed: RobotSpeed): Promise<void> {
    const table = this.table
    if (!table) return
    this.setSpeed(userId, speed)
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
    // A team match plays on: a robot of the match's system takes the deleted member's seat (§5.8)
    const team = teamStateOf(table)
    const kept = team && !team.closed ? this.seatOf(userId) : null
    if (kept) {
      this.vacate(kept)
      table.seats[kept] = robotId(team!.robotKind, kept)
      this.touchTurn()
    }
    // Invitations and robot substitutes for them are forgotten; the robot stays in the seat
    const seat = this.substituteSeat(userId)
    if (table.invited) table.invited = table.invited.filter((id) => id !== userId)
    if (table.approved) table.approved = table.approved.filter((id) => id !== userId)
    if (table.requests) table.requests = table.requests.filter((r) => r.userId !== userId)
    if (table.declined) delete table.declined[userId]
    if (seat) delete table.substitutes![seat]
    // The seats they bid for go back to whoever sits there
    for (const s of SEATS) if (table.controllers?.[s] === userId) delete table.controllers[s]
    if (table.names) delete table.names[userId]
    if (table.blocks) delete table.blocks[userId]
    if (table.speeds) delete table.speeds[userId]
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

  /**
   * The table's team match ended (finished, or abandoned): nothing more is dealt, and from now on
   * the table is like any other - people leave when they like, and it closes once nobody is left.
   * A room of robots alone closes at once
   */
  async matchEnded(): Promise<TableEntry | null> {
    const table = this.table
    const state = table && teamStateOf(table)
    if (!table || !state) return this.settled()
    state.closed = true
    state.pausedAt = undefined
    table.dealAt = undefined
    // An abandoned match stops where it is: a board being played is put away, unrecorded
    if (table.board && table.board.phase !== 'finished') this.putAway()
    return this.saveOrDrop()
  }

  /**
   * What the match's host changed while it is played (§5.8, `e8-t14`–`e8-t16`): who is in it,
   * a substitute (替補), a robot sitting in (代打), a ruling, the pause. Nothing for a match that ended
   */
  async matchUpdate(update: MatchTableUpdate): Promise<TableEntry | null> {
    const table = this.table
    const state = table && teamStateOf(table)
    if (!table || !state || state.closed) return this.settled()
    // Who was ever in the match stays kept out of the other room: a player substituted out has seen this room's boards
    if (update.players)
      state.players = {
        open: [...new Set([...state.players.open, ...update.players.open])],
        closed: [...new Set([...state.players.closed, ...update.players.closed])],
      }
    if (update.replace) this.replaceSeat(update.replace.seat, update.replace.person)
    if (update.sitIn) {
      const member = table.seats[update.sitIn]
      if (member && !isRobotId(member)) this.sitIn(member, update.sitIn, state.robotKind)
    }
    if (update.ruled !== undefined) {
      const seq = update.ruled
      state.ruled = [...new Set([...(state.ruled ?? []), seq])].sort((a, b) => a - b)
      // The room is playing the board ruled on: it is put away, and the next one dealt (when not paused)
      if (state.seq === seq && table.board && table.board.phase !== 'finished') {
        this.putAway()
        if (state.pausedAt === undefined) this.dealBoard()
      }
    }
    if (update.paused === true && state.pausedAt === undefined) state.pausedAt = this.now()
    if (update.paused === false && state.pausedAt !== undefined) this.resumeMatch(state.pausedAt)
    await this.save()
    return this.settled()
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
      case 'redeal':
        await this.redeal(userId)
        break
      case 'rebid':
        await this.rebid(userId)
        break
      case 'showHands':
        await this.showHands(userId, message.show)
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

  /**
   * Whether a member may come to the table as its access mode says (`mayEnter`); the club has
   * already checked the host's blocks. The same error as the club's when not
   */
  private checkAccess(userId: string) {
    const facts = accessFacts(this.table!)
    if (mayEnter(facts, userId, false)) return
    const code = refusal(facts, userId)
    throw new ClubError(code, {}, code === 'tableGone' ? 404 : 403)
  }

  /** Whether people without a seat may watch: as the host set it, and always at a practice table (watching is all there is to it) */
  private watchable(table: Table): boolean {
    return table.mode === 'practice' || settingsOf(table).allowKibitz
  }

  /** Notes a member's name and blocks as they come to the table */
  private welcome(person: Person) {
    const table = this.table!
    this.name(person)
    table.blocks = { ...table.blocks, [person.id]: person.blocked }
    this.setSpeed(person.id, person.robotSpeed)
  }

  /** Notes how fast a member wants the robots to play; only speeds other than the default are kept */
  private setSpeed(userId: string, speed: RobotSpeed | undefined) {
    const table = this.table!
    if (speed && speed !== DEFAULT_ROBOT_SPEED) table.speeds = { ...table.speeds, [userId]: speed }
    else if (table.speeds?.[userId]) {
      delete table.speeds[userId]
      if (!Object.keys(table.speeds).length) delete table.speeds
    }
  }

  /** How fast the robots play here: the slowest of the people seated, so nobody is rushed */
  private speed(table: Table): RobotSpeed {
    const humans = SEATS.flatMap((s) => (table.seats[s] && !isRobotId(table.seats[s]) ? [table.seats[s]!] : []))
    return slowestSpeed(humans.map((id) => table.speeds?.[id] ?? DEFAULT_ROBOT_SPEED))
  }

  private name(member: Named) {
    const table = this.table!
    table.names = { ...table.names, [member.id]: member.username }
  }

  private async stand(userId: string) {
    const table = this.table
    const seat = table && this.isAt(userId) ? this.seatOf(userId) : null
    if (!table || !seat) return
    this.checkFixed()
    this.vacate(seat)
    table.spectators.push(userId)
    await this.save()
  }

  /** Only the host runs the table: asking people to leave a seat, adding and removing robots */
  private hostTable(userId: string): Table {
    const table = this.table
    if (!table || !this.isAt(userId)) throw new ClubError('notAtTable')
    this.checkFixed()
    if (table.hostId !== userId) throw new ClubError('hostOnly')
    return table
  }

  /**
   * At a challenge or practice table (`fixedSeats`) nobody else sits, and seats and settings stay
   * as they were opened (at a challenge table nobody takes back a call or card either); at a team
   * match table seats and settings are the match's (§5.8)
   */
  private checkFixed() {
    const mode = this.table!.mode
    if (fixedSeats(mode)) throw this.fixed()
    if (mode === 'team') throw new ClubError('matchTableFixed')
  }

  private fixed() {
    return new ClubError(this.table!.mode === 'practice' ? 'practiceTableFixed' : 'challengeTableFixed')
  }

  /**
   * Whether a member has a seat in the other room of this table's team match: they may neither
   * watch nor sit here while the match is on (§5.8, AC-8.4)
   */
  private otherRoom(userId: string): boolean {
    const state = teamStateOf(this.table!)
    if (!state || state.closed) return false
    const other = state.room === 'open' ? 'closed' : 'open'
    return state.players[other].includes(userId)
  }

  /**
   * A team match room plays on by itself while the match is on, even with robots alone (two
   * people and six robots may leave one room to the robots) and when everyone at it leaves
   */
  private playsOn(): boolean {
    const state = teamStateOf(this.table!)
    return !!state && !state.closed
  }

  /**
   * The host is whoever opened the table; when they leave or drop offline, the first person still
   * at the table and online takes over (a seated player before a spectator)
   */
  private checkHost() {
    const table = this.table!
    // A practice table stays its member's: it closes when they leave
    if (table.mode === 'practice') return
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

  /**
   * The system TKB is seated in for a host (ROBOT.md §7): the club's only for one the club says may
   * use it (`ClubLink.mayUseTku`), else 2/1; asking for the club's without it is `tkuSystemOnly`.
   * Checked here, so it holds on the table's own connection as through the club
   */
  private async robotKindFor(userId: string, asked: unknown): Promise<unknown> {
    if (asked !== undefined && asked !== 'tku') return asked
    const may = await this.link.mayUseTku(userId)
    if (asked === 'tku' && !may) throw new ClubError('tkuSystemOnly', {}, 403)
    return asked ?? (may ? 'tku' : 'gib')
  }

  /** Seats TKB in the system the host chose, or theirs by default (`robotKindFor`) */
  private async addRobot(userId: string, seat: unknown, asked?: unknown) {
    this.hostTable(userId)
    const kind = await this.robotKindFor(userId, asked)
    // Checked again after asking the club: something may have changed meanwhile
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
  private async replaceWithRobot(userId: string, seat: unknown, asked?: unknown) {
    this.hostTable(userId)
    const kind = await this.robotKindFor(userId, asked)
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

  /** TKB's system for a robot sitting in (代打): the one the club gave the table as it opened (`Table.robotKind`); older tables the club's */
  private defaultKind(): RobotKind {
    return this.table?.robotKind ?? 'tku'
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
    if (!board || board.phase === 'finished' || board.claim || table.undo || teamPaused(table)) return null
    const turn = turnOf(board)
    if (!turn) return null
    const seat = board.phase === 'auction' ? turn : controllerOf(board, turn)
    const id = actorOf(table, seat)
    return id && !isRobotId(id) ? seat : null
  }

  private async chat(userId: string, text: unknown) {
    const table = this.table
    const clean = String(text ?? '').trim().slice(0, LIMITS.chatMax)
    if (!table || !this.isAt(userId) || !clean) return
    const username = table.names?.[userId] ?? '—'
    // At a team match table the watchers talk among themselves (§5.8): the players never see it
    const kibitz = table.mode === 'team' && !this.seatOf(userId)
    const message = { id: randomId(6), at: this.now(), userId, username, text: clean, ...(kibitz && { kibitz: true as const }) }
    table.chat = [...table.chat, message].slice(-CHAT_KEEP)
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
    // A team match room plays on with robots alone (`e8-t14`): its robot is the match's system
    const team = teamStateOf(table)
    const online = this.connections.onlineUserIds()
    if (!team && !SEATS.some((s) => s !== seat && online.includes(table.seats[s] ?? ''))) return
    // TKB plays the system of a robot partner, if there is one, else the table's (its host's when it opened)
    const partner = table.seats[partnerOf(seat)]
    const kind: RobotKind = team ? team.robotKind : partner && isRobotId(partner) ? robotKindOf(partner) : this.defaultKind()
    this.sitIn(userId, seat, kind)
    await this.save()
    this.settled()
  }

  /** TKB sits in the member's seat for them (代打) until they come back; they are no longer at the table */
  private sitIn(userId: string, seat: Seat, kind: RobotKind) {
    const table = this.table!
    if (table.undo?.seat === seat) table.undo = undefined
    table.seats[seat] = robotId(kind, seat)
    table.substitutes = { ...table.substitutes, [seat]: userId }
    if (table.board && table.board.phase !== 'finished')
      table.boardSubstitutes = { ...table.boardSubstitutes, [seat]: userId }
    this.offlineSince.delete(userId)
    this.sent.delete(userId)
    this.checkHost()
    this.touchTurn()
  }

  // ── Team match exceptions (§5.8, e8-t14–e8-t16) ──────────────────────────────────────────────

  /**
   * 替補: a member takes the seat for the rest of the match. Whoever sat there (a member, or a robot
   * sitting in for one) leaves the table; the newcomer plays on from where the board is
   */
  private replaceSeat(seat: Seat, person: Person) {
    const table = this.table!
    const before = table.seats[seat]
    if (table.undo?.seat === seat) table.undo = undefined
    if (table.substitutes?.[seat]) delete table.substitutes[seat]
    if (before && !isRobotId(before)) {
      this.offlineSince.delete(before)
      this.sent.delete(before)
    }
    table.spectators = table.spectators.filter((id) => id !== person.id)
    this.welcome(person)
    table.seats[seat] = person.id
    if (!this.connections.onlineUserIds().includes(person.id)) this.awayFrom(person.id, this.now())
    this.touchTurn()
  }

  /** Puts the board on the table away unrecorded (a ruling, or the match abandoned): nothing is on the table after */
  private putAway() {
    const table = this.table!
    this.unswap()
    table.board = null
    table.undo = undefined
    table.rejectedClaim = undefined
    table.recordId = undefined
    table.dealAt = undefined
  }

  /**
   * The match goes on after a pause: the clocks (the board's time limit, the slow-turn reminder)
   * do not count the pause; a board due to be dealt is dealt after the countdown again
   */
  private resumeMatch(pausedAt: number) {
    const table = this.table!
    const state = teamStateOf(table)!
    const paused = this.now() - pausedAt
    state.pausedAt = undefined
    if (table.boardStartedAt !== undefined) table.boardStartedAt += paused
    if (table.turnSince !== undefined) table.turnSince += paused
    if (!table.board) return this.dealBoard()
    if (table.board.phase === 'finished' && this.canDeal() && !teamTableOver(table)) {
      table.dealAt = Math.max(table.dealAt ?? 0, this.now() + DEAL_COUNTDOWN_MS)
      this.scheduleDeal()
    }
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
    if (!this.dealsByItself()) return
    table.dealAt = Math.max(table.dealAt ?? 0, this.now() + DEAL_COUNTDOWN_MS)
    this.scheduleDeal()
  }

  /** Whether the next board comes by itself after the countdown: not at a bidding practice, where the member asks for it */
  private dealsByItself() {
    return !biddingOnly(this.table!)
  }

  private canDeal() {
    const table = this.table!
    return (
      SEATS.every((s) => table.seats[s]) &&
      (this.humansSeated() > 0 || this.playsOn()) &&
      !teamPaused(table) &&
      (!table.board || table.board.phase === 'finished')
    )
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
    const practice = practiceStateOf(table)
    if (practice) delete practice.review
    table.undo = undefined
    table.rejectedClaim = undefined
    table.recordId = undefined
    table.dealAt = undefined
    table.boardStartedAt = this.now()
    // A robot still sitting in for someone plays this board for them too
    table.boardSubstitutes = table.substitutes && { ...table.substitutes }
    // A board dealt with its auction made (Just Declare) goes straight to the play
    if (table.board.phase === 'play') this.swapForDeclarer()
    // The handbook's words for the calls to come (`loadBookNotes`)
    else void this.loadBookNotes()
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
    if (!table?.board || !this.canDeal() || !this.dealsByItself()) return
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

  // ── Practice tables (§5.11) ──────────────────────────────────────────────────────────────────

  /**
   * 隨時重發 (`e10-t03`): the practice table's own member puts the board away, played or not, and
   * gets a new one at once. Nothing is recorded for the board put away
   */
  private async redeal(userId: string) {
    const table = this.table
    if (!table || !this.isAt(userId)) throw new ClubError('notAtTable')
    if (table.mode !== 'practice') throw new ClubError('practiceOnly')
    if (table.hostId !== userId || !this.seatOf(userId)) throw new ClubError('hostOnly')
    const before = table.board
    this.dealBoard()
    // The conditions could not be met this time: the board stays
    if (table.board === before) throw new ClubError('dealTooStrict')
    await this.save()
  }

  /**
   * 重叫這一副 (`e10-t15`): at a bidding practice its member bids the board on the table again from
   * the start, the same hands, finished or not. Nothing was recorded for it, nor is now
   */
  private async rebid(userId: string) {
    const table = this.table
    if (!table || !this.isAt(userId)) throw new ClubError('notAtTable')
    if (!biddingOnly(table)) throw new ClubError('biddingOnlyRebid')
    if (table.hostId !== userId || !this.seatOf(userId)) throw new ClubError('hostOnly')
    const board = table.board
    if (!board) throw new ClubError('noBoard')
    table.board = newBoard(board.boardNo, board.hands)
    delete practiceStateOf(table)!.review
    table.undo = undefined
    table.rejectedClaim = undefined
    table.dealAt = undefined
    table.boardStartedAt = this.now()
    this.touchTurn()
    await this.save()
  }

  /**
   * 顯示四家 (`e10-t16`): a practice table's own member sees all four hands, or hides them again.
   * Only them (`shownTo`): a watcher sees what any watcher sees, and the robots only their own
   */
  private async showHands(userId: string, show: unknown) {
    const table = this.table
    if (!table || !this.isAt(userId)) throw new ClubError('notAtTable')
    const state = practiceStateOf(table)
    if (!state) throw new ClubError('practiceOnly')
    if (table.hostId !== userId || !this.seatOf(userId)) throw new ClubError('hostOnly')
    if (typeof show !== 'boolean') throw new ClubError('badMessage')
    if (show) state.showHands = true
    else delete state.showHands
    await this.save()
  }

  /** The hands a viewer is shown besides their own (`boardView`'s `shown`): all four for a practice table's member who asked */
  private shownTo(table: Table, userId: string): Seat[] | undefined {
    const state = practiceStateOf(table)
    return state?.showHands && table.hostId === userId && this.seatOf(userId) ? [...SEATS] : undefined
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
    if (teamPaused(table)) throw new ClubError('matchPaused')
    if (message.type === 'undoRequest' || message.type === 'undoRespond') {
      if (table.mode === 'challenge') throw new ClubError('challengeNoUndo')
      if (table.mode === 'team') throw new ClubError('matchNoUndo')
    }
    if (message.type === 'call') return this.applyAction(this.callingSeat(userId, seat, message.seat), message)
    if (message.type === 'undoRequest') return this.applyAction(this.undoSeat(userId, seat), message)
    // Nobody agrees to take back a call they made themselves, for whichever seat (seat control)
    if (message.type === 'undoRespond' && table.undo && actorOf(table, table.undo.seat) === userId)
      throw new ClubError('undoByOpponent')
    await this.applyAction(seat, message)
  }

  /**
   * The seat a member calls for (seat control, `e10-t15`): the one the call names, which must be a
   * seat they make the calls for (`actorOf`), else their own. Whose turn it is `makeCall` checks
   */
  private callingSeat(userId: string, own: Seat, asked: unknown): Seat {
    if (asked === undefined) return own
    if (!isSeat(asked)) throw new ClubError('badSeat')
    if (actorOf(this.table!, asked) !== userId) throw new ClubError('notYourSeat', {}, 403)
    return asked
  }

  /**
   * Whose call an undo takes back: during the auction the last call the member made, for any seat
   * they call for; otherwise their own seat's, as always
   */
  private undoSeat(userId: string, own: Seat): Seat {
    const table = this.table!
    const board = table.board
    const acts = seatsActedBy(table, userId)
    if (!board || board.phase !== 'auction' || acts.length < 2) return own
    const last = board.auction.findLast((c) => acts.includes(c.seat))
    return last && last.seat !== this.auctionSeat(table, own) ? last.seat : own
  }

  /** Applies one board action for a seat, from a person or a robot */
  private async applyAction(seat: Seat, message: ClientMessage, byRobot = false, meaning?: RobotBid['meaning'], book?: BookNote) {
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
          // TKB in the club's system: 淡江橋館's words for the call too (BridgeHall e7-t03)
          const made = { ...next.auction.at(-1)!, robot: true, ...(meaning ? { meaning } : {}), ...(book ? { book } : {}) }
          next = { ...next, auction: [...board.auction, made] }
        } else {
          // A person's call carries what the engine reads it as, in their side's system: a robot
          // partner's, or the club's (e5-t22); like a convention card, it is for everyone
          // A member bidding for a robot's seat (seat control) bids in that robot's system
          const partner = table.seats[partnerOf(seat)]
          const own = table.seats[seat]
          const kind: RobotKind =
            partner && isRobotId(partner) ? robotKindOf(partner) : own && isRobotId(own) ? robotKindOf(own) : 'tku'
          const inferred = inferredMeaning(kind, next.auction, next.dealer, next.vul)
          // In the club's system the handbook's words for the call go with it too (e7-t06), so
          // the record links every call to the handbook, not only TKB's; the words already loaded
          // for the deal (`loadBookNotes`), as a person's call does not wait for them
          const book = kind === 'tku' && message.call !== 'P' ? bookNoteFor(this.bookNotes, board.auction, message.call) : undefined
          if (inferred || book)
            next = {
              ...next,
              auction: [...board.auction, { ...next.auction.at(-1)!, ...(inferred ? { meaning: inferred, inferred: kind } : {}), ...(book ? { book } : {}) }],
            }
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
    // A bidding practice ends the board with the auction: the hands are laid open, nothing is
    // played or recorded, and the next board waits for the member (`redeal`, `rebid`)
    if (board.phase === 'auction' && next.phase !== 'auction' && biddingOnly(table)) {
      table.board = endBidding(next)
      // Its review is worked out from now on (`scheduleReview`)
      delete practiceStateOf(table)!.review
      this.touchTurn()
      await this.save()
      return
    }
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
      table.dealAt = this.now() + (playedOut ? ROBOT_PACE[this.speed(table)].lastTrick : 0) + DEAL_COUNTDOWN_MS
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
        // A practice board is named by its mode; its table's lobby number means nothing later
        tableNumber: table.mode === 'practice' ? 0 : table.number,
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
    if (!table || !board || board.phase === 'finished' || (this.humansSeated() === 0 && !this.playsOn())) return null
    if (this.challengeClosed() || teamPaused(table)) return null
    const robot = (seat: Seat | null | undefined): seat is Seat => !!seat && isRobotId(table.seats[seat])
    // A robot whose calls a member makes (seat control) waits for them; it still answers undo and claims
    const robotActs = (seat: Seat | null | undefined): seat is Seat => robot(seat) && isRobotId(actorOf(table, seat))
    const kindAt = (seat: Seat) => robotKindOf(table.seats[seat]!)
    const pace = ROBOT_PACE[this.speed(table)]

    // Robots agree to undo requests, and accept a claim only if the cards make it good
    if (table.undo) {
      const answer = SEATS.find((s) => robot(s) && !sameSide(s, table.undo!.seat))
      if (!answer) return null
      return { seat: answer, delay: pace.answer, decide: async () => ({ message: { type: 'undoRespond', accept: true } }) }
    }
    if (board.claim) {
      const answer = claimApprovers(board, board.claim.seat).find((s) => robot(s) && !board.claim!.accepted.includes(s))
      if (!answer) return null
      const decide = async (brain: RobotBrain): Promise<RobotAnswer> => ({
        message: { type: 'claimRespond', accept: await brain.acceptsClaim(kindAt(answer), board, answer) },
      })
      return { seat: answer, delay: pace.answer, decide }
    }
    const turn = turnOf(board)
    if (!turn) return null
    if (board.phase === 'auction') {
      if (!robotActs(turn)) return null
      const decide = async (brain: RobotBrain): Promise<RobotAnswer> => {
        const bid = await brain.bid(kindAt(turn), board, turn)
        return { message: { type: 'call', call: bid.call, alert: bid.alert }, meaning: bid.meaning }
      }
      return { seat: turn, delay: pace.call, decide }
    }
    const controller = controllerOf(board, turn)
    if (!robotActs(controller)) return null
    const trickJustEnded = board.play.length > 0 && board.play.length % 4 === 0
    return {
      seat: controller,
      delay: trickJustEnded ? pace.afterTrick : pace.card,
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
    this.scheduleReview()
    const key = `robot:${this.id}`
    if (!this.table || this.scheduler.pending(key) || this.thinking) return
    const move = this.robotMove()
    if (!move) return
    this.scheduler.add(key, 'robot', move.delay, () => this.runRobot())
  }

  /**
   * 檢討 (`e10-t07`): once a bidding practice's auction is over, TKB's call at each step, then four
   * TKB bidding the board. Each part is a job of its own, after the call that ended the auction,
   * so no request does more than about one auction's robot work (the free plan's 10 ms of CPU a
   * request); after an eviction `restore` schedules what is still missing
   */
  private scheduleReview() {
    const table = this.table
    const state = table && practiceStateOf(table)
    const board = table?.board
    if (!state || !board || !biddingOnly(table) || board.phase !== 'finished') return
    if (state.review?.steps && state.review.robot) return
    const key = `review:${this.id}`
    if (this.scheduler.pending(key)) return
    this.scheduler.add(key, 'robot', 0, () => this.review(board))
  }

  /** Works out the next missing part of the review of `board`, if it is still the one on the table */
  private async review(board: BoardState) {
    const table = this.table
    const state = table && practiceStateOf(table)
    if (!state || table.board !== board) return
    const kind = state.robotKind
    // A brain that fails leaves the rule robot to answer, as at the table
    const ask = async <T>(work: (brain: RobotBrain) => Promise<T>): Promise<T> => {
      try {
        return await work(this.brain)
      } catch (error) {
        if (this.brain === ruleBrain) throw error
        console.warn('robot brain failed, the rule robot reviews', error)
        return work(ruleBrain)
      }
    }
    const part: PracticeReview = state.review?.steps
      ? { robot: await ask((brain) => robotBidding(brain, kind, board)) }
      : { steps: await ask((brain) => reviewSteps(brain, kind, board)) }
    // The board was bid again or another dealt while the brain thought
    if (this.table !== table || table.board !== board) return
    state.review = { ...state.review, ...part }
    await this.save()
    this.settled()
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

  /**
   * 淡江橋館's words for the calls in the club's system (BridgeHall e7-t03, e7-t05): the club's
   * synced rules are asked for once a board (`ClubLink.bookNotes`), from the deal on, and kept when
   * the club cannot answer. Every view and call waits for the same answer
   */
  private loadBookNotes(): Promise<void> {
    const board = this.table?.board
    const ask = this.link.bookNotes
    if (!board || !ask) return Promise.resolve()
    if (this.bookNotesDeal !== board.hands) {
      this.bookNotesDeal = board.hands
      this.bookNotesLoad = (async () => {
        try {
          const answer = await ask(this.bookNotes?.key ?? null)
          if (answer === 'same') return
          this.bookNotes = answer
          // The bidding box hints name the handbook's words too
          if (this.table?.board?.phase === 'auction') this.broadcast()
        } catch (error) {
          console.warn('book notes unavailable', error)
        }
      })()
    }
    return this.bookNotesLoad ?? Promise.resolve()
  }

  /**
   * The words for a TKB call. TKB bids by its own rules; the words go with the call as they are,
   * pass left out as its alert is
   */
  private async bookNoteOf(seat: Seat, message: ClientMessage): Promise<BookNote | undefined> {
    const board = this.table?.board
    const robot = this.table?.seats[seat]
    if (message.type !== 'call' || message.call === 'P' || !board || !robot || robotKindOf(robot) !== 'tku' || !this.link.bookNotes) return
    await this.loadBookNotes()
    return bookNoteFor(this.bookNotes, board.auction, message.call)
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
    let book: BookNote | undefined
    const started = performance.now()
    let thought = 0
    try {
      answer = await this.think(move.decide)
      thought = performance.now() - started
      book = await this.bookNoteOf(move.seat, answer.message)
    } finally {
      this.thinking = false
    }
    this.config.onThink?.(thought)
    if (this.table !== table || teamPaused(table)) return
    // The table moved on while the robot thought (a person played, an undo, a seat changed): ask again
    if (this.positionOf() !== position) return this.scheduleRobots()
    const { message, meaning } = answer
    try {
      await this.applyAction(move.seat, message, true, meaning, book)
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

  /**
   * Closes a table no person is sitting at or watching (robots do not keep it open), and a practice
   * table its member left (people watching it go with it)
   */
  private async saveOrDrop(): Promise<TableEntry | null> {
    const table = this.table!
    if ((table.spectators.length === 0 || table.mode === 'practice') && this.humansSeated() === 0 && !this.playsOn()) {
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
    const team = teamStateOf(table)
    return {
      id: table.id,
      number: table.number,
      hostId: table.hostId,
      mode: table.mode ?? 'casual',
      settings: settingsOf(table),
      invited: [...(table.invited ?? [])],
      approved: [...(table.approved ?? [])],
      requests: liveRequests(table.requests, this.now()).map(({ userId, at }) => ({ userId, at })),
      seats: { ...table.seats },
      spectators: [...table.spectators],
      substitutes: { ...table.substitutes },
      boardsPlayed: table.boardsPlayed,
      boardNo: table.board ? table.board.boardNo : null,
      playing: !!table.board && table.board.phase !== 'finished',
      ...(state && { challenge: { challengeId: state.challengeId, userId: state.userId } }),
      ...(team && {
        match: {
          matchId: team.matchId,
          room: team.room,
          teamNames: team.teamNames,
          ...(team.closed && { ended: true }),
          ...(table.boardStartedAt !== undefined && { startedAt: table.boardStartedAt }),
        },
      }),
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
      // Who bids for the seat instead of its occupant (seat control): for everyone, like the occupant
      const controller = table.controllers?.[seat]
      const controlledBy = controller && table.names?.[controller]
      if (seats[seat] && controlledBy) seats[seat] = { ...seats[seat], controlledBy }
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
    // The seats the viewer calls for (seat control); only someone at the table calls for any
    const acts = this.isAt(userId) ? seatsActedBy(table, userId) : []
    const controls = acts.some((seat) => seat !== mySeat)
    return {
      id: table.id,
      number: table.number,
      hostId: table.hostId,
      settings,
      seats: this.occupants(table, (id) => isRobotId(id) || online.includes(id)),
      spectators: table.spectators.flatMap((id) => this.publicUser(id) ?? []),
      mySeat,
      ...(controls && { acts }),
      board: table.board
        ? boardView(table.board, mySeat, {
            acts,
            shown: this.isAt(userId) ? this.shownTo(table, userId) : undefined,
            undo: table.undo,
            recordId: table.recordId,
            rejectedClaim: table.rejectedClaim,
            auctionSeat: mySeat ? this.auctionSeat(table, mySeat) : undefined,
            undoAllowed: table.mode !== 'challenge' && table.mode !== 'team',
            kibitz: this.watchable(table),
            robots: Object.fromEntries(SEATS.flatMap((s) => (table.seats[s] && isRobotId(table.seats[s]!) ? [[s, robotKindOf(table.seats[s]!)]] : []))),
            bookNotes: this.bookNotes,
          })
        : null,
      boardsPlayed: table.boardsPlayed,
      dealAt:
        table.board?.phase === 'finished' && this.canDeal() && !this.challengeTableOver() && !teamTableOver(table)
          ? (table.dealAt ?? null)
          : null,
      chat: chatFor(table.chat, (authorId) => blocked.has(authorId), { player: table.mode === 'team' && mySeat !== null }),
      recent: (table.recent ?? []).filter((summary) => recordVisible(summary, userId, this.now())),
      ...(table.mode === 'challenge' && { challenge: this.tableChallenge(table) }),
      ...practiceView(table),
      ...(table.mode === 'team' && { match: tableMatch(table) }),
      ...(table.hostId === userId &&
        !soloTable(table.mode) &&
        table.mode !== 'team' && {
          invited: (table.invited ?? []).flatMap((id) => this.publicUser(id) ?? []),
          // Requests from members the host blocked never reach them (`muted`)
          requests: liveRequests(table.requests, this.now()).flatMap((r) => {
            const user = !r.muted && this.publicUser(r.userId)
            return user ? [{ user, at: r.at }] : []
          }),
        }),
      boardEndsAt:
        playing && settings.boardMinutes > 0 && !teamPaused(table)
          ? (table.boardStartedAt ?? table.createdAt) + settings.boardMinutes * 60_000
          : null,
      waiting: waiting && { seat: waiting, since: table.turnSince ?? table.createdAt },
      robotSpeed: this.speed(table),
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
