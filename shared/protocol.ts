import type { FeatureFlag } from './features.ts'
import type { AuctionCall, BookNote, Call, Contract } from './auction.ts'
import type { Vulnerability } from './board.ts'
import type { BoardEvent, BoardRuling } from './board-events.ts'
import type { BookTopics } from './book-topics.ts'
import type { Card, Seat, Side } from './cards.ts'
import type { ChallengeSettings } from './challenge.ts'
import type { BoardResult, BoardState, Phase, Trick } from './game.ts'
import type { MessageCode, MessageParams } from './messages.ts'
import type { PracticeSettings } from './practice.ts'
import type { MatchSeat, Room, TeamMatchView } from './team-match.ts'
import type { RulingKind, Team } from './team-scoring.ts'
import type { Profile } from './profile.ts'
import type { Spec } from './robot/system/spec.ts'
import type { SpecShows, SystemSpec } from './systemSpec.ts'

/** Messages and views exchanged between the browser and the Worker over HTTP and WebSocket */

export interface PublicUser {
  id: string
  username: string
  /** Set for a robot player in a seat or a history record */
  robot?: boolean
  /**
   * The system TKB bids: the club's or the GIB-compatible 2/1; older records have none (the club's).
   * Records from when robots had levels may still carry a `robotLevel`, which nothing reads
   */
  robotKind?: RobotKind
  /** The version of the member's uploaded picture (e1-t34, `avatarUrl`); none means the default avatar */
  avatar?: number
  /**
   * Their profile's display name (TKU-BridgeHall e11-t19), when they set one: on the lobby's
   * members and seats only. A table's own seats and history records carry the username, so the
   * table page takes the name and the picture from the lobby (`withMemberProfile`)
   */
  displayName?: string
}

/**
 * What an admin can let a member do beyond playing (§5.2): edit TKU BridgeBook (淡江橋譜) online
 * (`bookEdit`: drafts and sending them for review), publish its conventions and send drafts back
 * (`bookReview`, BridgeHall e8-t01; a reviewer is always an editor too, `withImpliedPermissions`),
 * import Word or PDF files into it (`bookImport`), feature finished boards
 * (`boardCurate`, e4-t28), and seat TKB in the club's system (`tkuSystem`, 社長 2026-10-26: the
 * club's robot is private; everyone else's TKB is the 2/1 one), and be an officer (幹部) of
 * BridgeHall's forum (`forumModerate`, e11-t09: post news, pin, lock, delete anyone's posts and
 * comments, handle reports). Admins have every permission.
 */
export const PERMISSIONS = ['bookEdit', 'bookReview', 'bookImport', 'boardCurate', 'tkuSystem', 'forumModerate'] as const
export type Permission = (typeof PERMISSIONS)[number]
export const isPermission = (value: unknown): value is Permission => PERMISSIONS.includes(value as Permission)

/** A permission list as stored: `bookReview` brings `bookEdit` with it (a reviewer is an editor); in PERMISSIONS order */
export function withImpliedPermissions(permissions: readonly Permission[]): Permission[] {
  const set = new Set(permissions)
  if (set.has('bookReview')) set.add('bookEdit')
  return PERMISSIONS.filter((p) => set.has(p))
}

/** The signed-in user, as /api/me returns it */
export interface Me extends PublicUser {
  /**
   * The club the account belongs to (e12-t02, shared/clubs.ts); the server always sets it. Pages
   * send it back as `X-Club-Id` so each request reaches that club's object
   */
  clubId?: string
  admin: boolean
  /** Everything for an admin */
  permissions: Permission[]
  /** Admins only: registrations waiting for approval */
  applications?: number
  /** Whether the bell says when a friend comes online (e1-t24); the server always sets it, on unless turned off */
  friendOnlineNotice?: boolean
  /**
   * Whether the bell says a convention the member's team or partnership plays was published
   * (BridgeHall F4, `bookPublished` for that reason only); the server always sets it, on unless
   * turned off. Following, overrides, review and suggestions are told regardless
   */
  bookAdoptedNotice?: boolean
  /** The member's own profile (AC-1.5), to edit on "My account"; empty until they fill it in */
  profile?: Profile
  /**
   * The handbook's system profile (制度集, TKU-BridgeBook e1-t16) the member reads with, the same on
   * every device; absent for the club's own
   */
  bookProfile?: string
  /** How fast the robots play at the member's tables (出牌速度); the server always sets it */
  robotSpeed?: RobotSpeed
  /** The feature flags the member has (e11-t26, shared/features.ts); the server always sets it */
  features?: FeatureFlag[]
}

/** Where someone registered; both sites share the accounts */
export type Site = 'table' | 'book'

/** A registration waiting for an admin to approve it, as the admin page lists it */
export interface Application {
  id: string
  username: string
  /** What the applicant wrote about themselves, e.g. their name and class */
  note: string
  site: Site
  createdAt: number
}

/** POST /api/register: the first account signs in at once; later ones wait for approval */
export type RegisterResult = { user: Me } | { pending: true; username: string }

export interface SeatOccupant extends PublicUser {
  online: boolean
  /** A robot sitting in for a member who dropped offline (代打, `e2-t31`): their name; they get the seat back on returning */
  substituteFor?: string
  /** Someone else makes the calls for this seat (seat control, `e10-t15`): their name */
  controlledBy?: string
}

/**
 * Robots sit in seats under ids like 'robot:gib:N'. Ids saved earlier still read: 'robot:N' (the
 * club's system) and, from when robots had levels, 'robot:gib:beginner:N' (every level is TKB now)
 */
export const ROBOT_PREFIX = 'robot:'
export const isRobotId = (id: string | null | undefined) => !!id && id.startsWith(ROBOT_PREFIX)

/**
 * The robot is TKB (ROBOT.md), and a host seats it in either bidding system: the club's
 * (淡江制度, the club's system in TKU BridgeBook; only with the `tkuSystem` permission) or 2/1
 * (GIB-compatible, docs/BBO GIB)
 */
export const ROBOT_KINDS = ['tku', 'gib'] as const
export type RobotKind = (typeof ROBOT_KINDS)[number]
export const isRobotKind = (value: unknown): value is RobotKind => ROBOT_KINDS.includes(value as RobotKind)

/**
 * Whether a member may seat TKB in the club's system (淡江制度): the `tkuSystem` permission, which
 * admins have too (`Me.permissions` lists everything for them). The server checks it again
 */
export const mayUseTkuSystem = (me: Pick<Me, 'permissions'> | null | undefined) => !!me?.permissions.includes('tkuSystem')
/** The systems a member may seat TKB in: both with `tkuSystem`, otherwise only 2/1 (there is one TKB for them) */
export const robotKindsFor = (me: Pick<Me, 'permissions'> | null | undefined): readonly RobotKind[] =>
  mayUseTkuSystem(me) ? ROBOT_KINDS : ['gib']
/** The system TKB is seated in when a member does not say: the club's for those who may use it, otherwise 2/1 */
export const defaultRobotKind = (me: Pick<Me, 'permissions'> | null | undefined): RobotKind => (mayUseTkuSystem(me) ? 'tku' : 'gib')

/** A robot's id carries its system, so it moves with the robot when seats are swapped and survives a reload */
export const robotId = (kind: RobotKind, seat: Seat) => `${ROBOT_PREFIX}${kind}:${seat}`
export function robotKindOf(id: string): RobotKind {
  const kind = id.slice(ROBOT_PREFIX.length).split(':')[0]
  return isRobotKind(kind) ? kind : 'tku'
}

export interface ChatMessage {
  id: string
  at: number
  userId: string
  username: string
  text: string
  /**
   * Said by someone watching a team match table (§5.8): only the other watchers see it, never the
   * players (`chatFor` in `worker/views.ts`)
   */
  kibitz?: true
}

/**
 * Who may come to a table (AC-2.9; the four access modes, 2026-10-25): `public` listed in the lobby,
 * anyone may sit or watch; `request` listed, a member asks and the host approves or declines;
 * `hidden` not listed, only invited members find it (their invitation or a link); `closed` listed,
 * nobody new comes, the people already there stay. Invited members come in without asking at a
 * `request` table too. Tables saved before settings use the defaults
 */
export const TABLE_ACCESS = ['public', 'request', 'hidden', 'closed'] as const
export type TableAccess = (typeof TABLE_ACCESS)[number]
/** The time limits a host may set for each board, in minutes (AC-2.10); 0 is none */
export const BOARD_TIME_LIMITS = [0, 5, 7, 10, 15] as const
export interface TableSettings {
  access: TableAccess
  /** Whether people who are not seated may watch (whoever the access mode lets in) */
  allowKibitz: boolean
  /** Minutes each board may take, one of BOARD_TIME_LIMITS; 0 is no limit */
  boardMinutes: number
}
export const DEFAULT_TABLE_SETTINGS: TableSettings = { access: 'public', allowKibitz: true, boardMinutes: 0 }
/**
 * A practice table (§5.11) starts hidden: it is the member's own, and only someone they invite (a
 * coach, a friend) may watch; nobody else ever sits there, so watching is always allowed
 */
export const PRACTICE_TABLE_SETTINGS: TableSettings = { access: 'hidden', allowKibitz: true, boardMinutes: 0 }

/** What the access was called before the four modes: `public` stays, `invite` (listed, invited only) became `hidden` */
const LEGACY_VISIBILITY: Record<string, TableAccess> = { public: 'public', invite: 'hidden' }

/**
 * A table's settings as stored by any version (`visibility` before the four access modes, fields
 * missing before settings, a robot level since dropped): brought to today's three fields
 */
export function tableSettingsFrom(stored: unknown): TableSettings {
  const saved = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>
  const access = TABLE_ACCESS.includes(saved.access as TableAccess)
    ? (saved.access as TableAccess)
    : (LEGACY_VISIBILITY[String(saved.visibility)] ?? DEFAULT_TABLE_SETTINGS.access)
  const allowKibitz = typeof saved.allowKibitz === 'boolean' ? saved.allowKibitz : DEFAULT_TABLE_SETTINGS.allowKibitz
  const boardMinutes = (BOARD_TIME_LIMITS as readonly unknown[]).includes(saved.boardMinutes)
    ? (saved.boardMinutes as number)
    : DEFAULT_TABLE_SETTINGS.boardMinutes
  return { access, allowKibitz, boardMinutes }
}

/** Request and hidden tables take their invited members without asking, so the host keeps a list for them */
export const takesInvitees = (access: TableAccess) => access === 'request' || access === 'hidden'

/** A request to join a table waits this long for the host; then it is gone and may be sent again */
export const TABLE_REQUEST_MS = 10 * 60_000
/** After the host declines, the same member may not ask that table again for this long */
export const TABLE_REQUEST_COOLDOWN_MS = 10 * 60_000

/** After this long on one call or card a player is reminded, and the host may seat a robot instead (AC-2.10) */
export const SLOW_TURN_MS = 60_000
/** A seated member offline this long is replaced by a robot until they come back (代打, AC-2.13) */
export const SUBSTITUTE_MS = 3 * 60_000

/**
 * Checks settings from the browser: every field optional, nothing else allowed; null when invalid.
 * A page loaded before the four access modes may still send `visibility` (`invite` means hidden)
 */
export function parseTableSettings(value: unknown): Partial<TableSettings> | null {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { access, visibility, allowKibitz, boardMinutes, ...rest } = value as Record<string, unknown>
  if (Object.keys(rest).length) return null
  if (access !== undefined && !TABLE_ACCESS.includes(access as TableAccess)) return null
  if (visibility !== undefined && (access !== undefined || !Object.hasOwn(LEGACY_VISIBILITY, String(visibility)))) return null
  if (allowKibitz !== undefined && typeof allowKibitz !== 'boolean') return null
  if (boardMinutes !== undefined && !(BOARD_TIME_LIMITS as readonly unknown[]).includes(boardMinutes)) return null
  const wanted = access ?? (visibility === undefined ? undefined : LEGACY_VISIBILITY[String(visibility)])
  return {
    ...(wanted !== undefined && { access: wanted as TableAccess }),
    ...(allowKibitz !== undefined && { allowKibitz }),
    ...(boardMinutes !== undefined && { boardMinutes: boardMinutes as number }),
  }
}

/**
 * What a table is for (`worker/modes.ts`): `casual` tables anyone opens, a participant's own
 * `challenge` table (ARCHITECTURE.md §5.5), a member's own `practice` table with three robots
 * (§5.11), and the two rooms of a `team` match (§5.8). Pairs events add theirs
 */
export const TABLE_MODES = ['casual', 'challenge', 'practice', 'team'] as const
export type TableMode = (typeof TABLE_MODES)[number]

/**
 * A table that is one member's alone (a challenge table): not in the lobby, nobody else joins or
 * watches, and its seats, robots and settings stay as they were opened
 */
export const soloTable = (mode: TableMode | undefined) => mode === 'challenge'

/**
 * A table whose seats and robots stay as they were opened (a challenge or practice table): nobody
 * else sits there. A practice table may still be watched, as its access mode allows (§5.11)
 */
export const fixedSeats = (mode: TableMode | undefined) => mode === 'challenge' || mode === 'practice'

/** A practice table as its player sees it (§5.11): how the boards are dealt and who bids with them */
export interface TablePractice extends PracticeSettings {
  /** Boards dealt at the table so far, finished or not (a new deal counts too) */
  dealt: number
  /**
   * The board on the table when it comes from a deal set (`e10-t16`): its place in the set (1-based)
   * and how many it has, its category, and what it teaches once the auction is over (`note`: a
   * practice set's note or a featured board's title and explanation). Never any cards
   */
  problem?: PracticeProblemView
  /**
   * 檢討 (`e10-t07`): at a bidding practice, once the auction is over (all four hands are open by
   * then), what TKB would have called at each step and how four TKB bid the board. Worked out on
   * the server after the auction, in turns (`TableService.review`), so a part may still be missing
   */
  review?: PracticeReview
}

/** The review of a bidding practice's board (`e10-t07`); never sent while the board is being bid */
export interface PracticeReview {
  /**
   * For each call of the auction, in order: the call TKB (the table's system) would have made from
   * that seat at that point, holding that seat's hand and knowing the auction before it, and what
   * that call shows. Missing until worked out
   */
  steps?: PracticeReviewStep[]
  /** Four TKB bidding the board from the start, and where they get to. Missing until worked out */
  robot?: { auction: AuctionCall[]; contract: Contract | null }
}

export interface PracticeReviewStep {
  call: Call
  meaning?: Spec
}

export interface PracticeProblemView {
  seq: number
  count: number
  category?: string
  title?: string
  note?: string
}

/** A challenge table as its player sees it: which challenge, which board of how many, until when */
export interface TableChallenge {
  id: string
  /** The board on the table: its place in the challenge, 1-based (0 before the first) */
  seq: number
  /** Boards in the challenge */
  boards: number
  /** Boards the player has finished */
  played: number
  deadline: number
}

/**
 * A team match table (§5.8) as everyone at it sees it: which match and room, which board of how
 * many. The score is not here: it comes from the match itself (`TeamMatchView`), which only counts
 * boards both rooms finished
 */
export interface TableMatch {
  id: string
  room: Room
  /** The board on the table: its place in the match, 1-based (0 before the first) */
  seq: number
  boards: number
  /** Boards this room has finished */
  played: number
  /** This room played every board: its last result stays on the table while the other room finishes */
  over: boolean
  /** The host paused the match (`e8-t16`): nobody calls or plays, and the clock stands still */
  paused?: boolean
  /** Boards the host ruled on that this room skipped or will skip (`e8-t15`) */
  ruled?: number[]
}

/** A team match being played, as the lobby lists it for anyone to watch (§5.8, AC-8.4) */
export interface LiveMatch {
  id: string
  teamNames: [string, string]
  /** The two rooms' tables */
  tables: Partial<Record<Room, string>>
}

export interface TableSummary {
  id: string
  number: number
  hostName: string
  settings: TableSettings
  /**
   * Whether the viewer may come in without asking: every member at a public table, the invited and
   * approved ones at a request table, the invited ones at a hidden table, nobody new at a closed one
   */
  welcome: boolean
  /** The viewer asked to join this table and the host has not answered yet */
  requested?: boolean
  /** A member's practice table (§5.11): its seats are taken by the member and three robots */
  practice?: boolean
  seats: Record<Seat, SeatOccupant | null>
  spectators: number
  boardsPlayed: number
  /** Board number currently on the table, if any */
  boardNo: number | null
}

/** One board as a particular viewer is allowed to see it */
export interface BoardView {
  boardNo: number
  dealer: Seat
  vul: Vulnerability
  phase: Phase
  /** Remaining cards of each hand the viewer may see (all original cards once finished) */
  hands: Partial<Record<Seat, Card[]>>
  handCounts: Record<Seat, number>
  /** Alerts the viewer may not see are removed */
  auction: AuctionCall[]
  contract: Contract | null
  dummy: Seat | null
  turn: Seat | null
  tricks: Trick[]
  tricksWon: Record<Side, number>
  /** Cards the viewer may click right now, if any (their own hand or dummy's) */
  legalCards: Card[]
  /** Calls the viewer may make, if it is their turn to call */
  legalCalls: Call[]
  /**
   * On the viewer's turn at a table with a robot: what each legal call would show in the robot's
   * system, so the bidding box tells how the robot will read it (`robot` is the robot whose system
   * it is: the partner, else an opponent). From the auction and the system only, never the cards
   */
  callMeanings?: {
    robot: Seat
    kind: RobotKind
    meanings: Partial<Record<Call, Spec>>
    /** TKB in the club's system: 淡江橋館's words for each call and where they are (BridgeHall e7-t05) */
    book?: Partial<Record<Call, BookNote>>
  }
  /**
   * The bidding hint card (`BookHints`, `e10-t06`): the TKU BridgeBook pages for the auction so far and
   * the calls that could come next, worked out on the server (`views.ts`) from the auction alone; none
   * when the viewer's partner is TKB playing 2/1, whose system the book does not describe
   */
  bookTopics?: BookTopics
  claim?: { seat: Seat; tricks: number; accepted: Seat[]; approvers: Seat[] }
  /** The last claim, turned down by `by`; shown until the next card */
  rejectedClaim?: { seat: Seat; tricks: number; by: Seat }
  /** Whether the viewer may ask to take back their last call or card (and everything since) */
  canUndo: boolean
  /** Whether the viewer may claim now: any time during the play, for anyone but dummy */
  canClaim: boolean
  undo?: { seat: Seat }
  result?: BoardResult
  /** History record id once the board is saved */
  recordId?: string
}

export interface TableView {
  id: string
  number: number
  hostId: string
  settings: TableSettings
  seats: Record<Seat, SeatOccupant | null>
  spectators: PublicUser[]
  mySeat: Seat | null
  /**
   * The seats the viewer makes the calls for when that is more than their own (seat control,
   * `e10-t15`): they see each of these hands, and the bidding box is theirs on any of their turns
   * (`board.turn` says for which). Left out otherwise
   */
  acts?: Seat[]
  board: BoardView | null
  boardsPlayed: number
  /**
   * When the next board will be dealt (server clock, ms), while a finished board is on the table
   * and all four seats are taken; the browser runs its countdown from it
   */
  dealAt: number | null
  chat: ChatMessage[]
  /** Boards finished at this table, newest first, for the History panel */
  recent: BoardSummary[]
  /**
   * At a challenge table (§5.5): the challenge and the player's progress. Nobody watches, there is
   * no undo, and seats and settings do not change there
   */
  challenge?: TableChallenge
  /** At a team match table (§5.8): no undo, and seats and settings are the match's */
  match?: TableMatch
  /** At a practice table (§5.11): its settings. Seats and settings do not change there; undo has no limit */
  practice?: TablePractice
  /** The host only: the members invited to the table (`e2-t25`) */
  invited?: PublicUser[]
  /** The host only: members waiting for an answer to their request to join (oldest first, `at` server clock) */
  requests?: { user: PublicUser; at: number }[]
  /** When the board's time limit runs out (server clock, ms), while a board is played at a table with one */
  boardEndsAt: number | null
  /**
   * The seat the table is waiting on (a call or card from a person) and since when (server clock),
   * for the reminder after SLOW_TURN_MS; null when nobody is waited on
   */
  waiting: { seat: Seat; since: number } | null
  /** How fast the robots play here: the slowest speed of the people seated (`slowestSpeed`); the server always sets it */
  robotSpeed?: RobotSpeed
  /**
   * A player called the director (`e2-t34`) and it has not been cleared yet: who and when (server
   * clock). Everyone at the table sees it; the host and the admins were told
   */
  directorCall?: { user: PublicUser; at: number }
}

/**
 * A table as it goes over the wire: chat and recent boards are left out when they have not changed
 * since the last message to that member, and the browser keeps its copy
 */
export type TableWire = Omit<TableView, 'chat' | 'recent'> & { chat?: ChatMessage[]; recent?: BoardSummary[] }

/**
 * How fast the robots play (出牌速度, a member's own setting on 我的帳號): 極快, 快 or 較慢. A table
 * goes at the slowest speed of the people seated there, so nobody is rushed (ARCHITECTURE.md §5.3)
 */
export const ROBOT_SPEEDS = ['veryFast', 'fast', 'slower'] as const
export type RobotSpeed = (typeof ROBOT_SPEEDS)[number]
export const DEFAULT_ROBOT_SPEED: RobotSpeed = 'veryFast'
export const isRobotSpeed = (value: unknown): value is RobotSpeed => (ROBOT_SPEEDS as readonly unknown[]).includes(value)

/**
 * How long robots wait before acting at each speed (ms): a call, a card, the lead after a finished
 * trick (the trick stays on the table until its winner leads again), an answer to undo or a claim,
 * and how long the last trick of a board stays before the countdown. A card must wait out the
 * glide of the card before it (src/lib/motion.ts `paceOf`), and a finished trick must be seen
 * whole for a moment before it is collected. 較慢 is the pace before (#110)
 */
export const ROBOT_PACE: Record<RobotSpeed, { call: number; card: number; afterTrick: number; answer: number; lastTrick: number }> = {
  veryFast: { call: 200, card: 400, afterTrick: 1000, answer: 150, lastTrick: 1200 },
  fast: { call: 400, card: 700, afterTrick: 1600, answer: 250, lastTrick: 1900 },
  slower: { call: 600, card: 1050, afterTrick: 2300, answer: 300, lastTrick: 2700 },
}

/** The slowest of these speeds (the people seated at a table); the default when there is none */
export function slowestSpeed(speeds: readonly RobotSpeed[]): RobotSpeed {
  if (!speeds.length) return DEFAULT_ROBOT_SPEED
  return ROBOT_SPEEDS[Math.max(...speeds.map((speed) => ROBOT_SPEEDS.indexOf(speed)))]
}

/** The countdown before the next deal */
export const DEAL_COUNTDOWN_MS = 2300

/** A club member as the People panel lists them */
export interface MemberStatus extends PublicUser {
  online: boolean
  /** Number of the table they are seated at or watching */
  tableNumber: number | null
  /** Their seat there, if seated */
  seat: Seat | null
}

/** What `/api/health` shows under `metrics`: the last hour (or since the object woke), counts only */
export interface MetricsView {
  /** Minutes the numbers cover */
  minutes: number
  actions: number
  /** The 95th percentile of an action's time (the upper bound of its bucket), ms; null with no actions */
  actionP95Ms: number | null
  refused: number
  rejected: number
  crashes: number
  requests: number
  serverErrors: number
  /** (crashes + 5xx answers) / (actions + requests) */
  errorRate: number
  connects: number
  reconnects: number
  /** reconnects / connects */
  reconnectRate: number
  boards: number
  peakOnline: number
  robot: { moves: number; avgMs: number | null; maxMs: number | null }
}

/** What the status page warns about, and when (`alertsOf`) */
export type MetricAlert = 'errorRate' | 'reconnectRate' | 'actionSlow' | 'robotSlow'

/**
 * `GET /api/health` (no sign-in, counts only, nothing about who): the club loaded and answers, with
 * the last hour's numbers (`worker/metrics.ts`) and what they warn about; the admin page's system
 * status reads it (e11-t22)
 */
export interface HealthStatus {
  ok: boolean
  now: number
  tables: number
  online: number
  /** Challenges in their own objects (H2b), when the club has them */
  events?: { objects: number; unconfirmed: number }
  /** Members seated at a table, and the robots seated */
  playing: number
  robots: number
  metrics: MetricsView
  alerts: MetricAlert[]
}

export interface LobbyView {
  online: PublicUser[]
  /** Every member, online first, for the People panel */
  members: MemberStatus[]
  tables: TableSummary[]
  /** The table the current user is seated at or watching */
  myTableId: string | null
  /** The mode of that table when it is not in `tables` (a challenge or practice table, `soloTable`) */
  myTableMode?: TableMode
  /** Ids of the members the viewer follows (好友, one-way: nobody is asked); `members` lists them first */
  friends: string[]
  /** Ids of the members the viewer blocked: their chat is hidden from the viewer, and they cannot join a table the viewer hosts */
  blocked: string[]
  /** Team matches being played; their tables are not in `tables` (§5.8). Always sent; optional for older pages' fixtures */
  matches?: LiveMatch[]
}

/**
 * The lobby goes out in two parts (H3b, ARCHITECTURE.md §4 and §5.13), which the browser puts
 * together into a `LobbyView` (`composeLobby`, `shared/lobby.ts`). This is the part that is the
 * same for every viewer: serialized once and sent as the same string to everyone, then kept up
 * to date with `LobbyDelta`s. Nothing in it depends on who looks: a hidden table, and where
 * anyone sits at one, are only in the viewers' own parts (`LobbyMine`). Lists are in no order;
 * the browser sorts them
 */
export interface LobbyShared {
  /** Every member; where they are (`tableNumber`, `seat`) only at a table listed for everyone */
  members: MemberStatus[]
  /** The tables listed for everyone (`listedForEveryone`), without what depends on the viewer */
  tables: SharedTable[]
  /** Team matches being played (§5.8) */
  matches: LiveMatch[]
}

/** A table as everyone sees it in the lobby: a `TableSummary` without `welcome` and `requested` */
export type SharedTable = Omit<TableSummary, 'welcome' | 'requested'>

/** What changed in `LobbyShared` since the previous version: entries replaced whole, or removed */
export interface LobbyDelta {
  /** Members added or changed */
  members?: MemberStatus[]
  /** Members no longer in the club */
  gone?: string[]
  /** Tables listed for everyone, added or changed */
  tables?: SharedTable[]
  /** Tables no longer listed for everyone (closed, or hidden now) */
  closed?: string[]
  /** The team matches being played, whole, when they changed */
  matches?: LiveMatch[]
}

/** The viewer's own part of the lobby: sent only to them, and only when it changed */
export interface LobbyMine {
  myTableId: string | null
  myTableMode?: TableMode
  friends: string[]
  blocked: string[]
  /** The tables listed for this viewer but not for everyone (a hidden table they host, are invited to or are at), whole */
  tables: TableSummary[]
  /** The shared tables the viewer may come in without asking (`TableSummary.welcome`) */
  welcome: string[]
  /** The shared tables the viewer asked to join, the host not having answered yet */
  requested: string[]
  /** Where members are when that is one of this viewer's own `tables`: the table's number and their seat */
  places: Record<string, { tableNumber: number; seat: Seat | null }>
}

/**
 * Something a member should know about, kept for them until they read it (AC-1.8). The browser
 * writes the text in the viewer's language from `kind` and `params`, and knows where each kind
 * leads (`src/lib/notifications.ts`). Challenges, match invitations and messages add their kinds
 */
export const NOTIFICATION_KINDS = [
  'application',
  'challengeInvited',
  'challengeAccepted',
  'challengeDeclined',
  'challengeCancelled',
  'challengeReminder',
  'challengeResults',
  'challengeWeekly',
  'friendOnline',
  'tableInvited',
  'tableRequest',
  'tableRequestApproved',
  'tableRequestDeclined',
  'matchInvited',
  'matchAccepted',
  'matchDeclined',
  'matchLeft',
  'matchRemoved',
  'matchCancelled',
  'matchStarted',
  'matchFinished',
  'matchAbandoned',
  'matchSubIn',
  'boardFeatured',
  'pairInvited',
  'pairAccepted',
  'pairDeclined',
  'pairEnded',
  'filesNearlyFull',
  'bookPublished',
  'bookOverrideChanged',
  'bookReviewRequested',
  'bookReturned',
  'bookSuggestUnify',
  'articleReviewRequested',
  'articleReturned',
  'articlePublished',
  'forumReply',
  'forumMention',
  'forumAnnouncement',
  'forumPinned',
  'directorCalled',
] as const
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number]

export interface Notification {
  id: string
  at: number
  kind: NotificationKind
  /**
   * `application`: { username } of the person who registered. The challenge kinds (§5.5):
   * { challengeId, username } of who invited, accepted, declined or cancelled; the reminder 12 hours
   * before the deadline and the results (`challengeReminder`, `challengeResults`) carry
   * { challengeId } and are sent by the deadline job (`e7-t13`); `challengeWeekly` { challengeId }
   * goes to every member when the weekly club challenge is created (`e7-t23`). `friendOnline`: { username } of
   * a member the viewer follows who just came online (e1-t24). `tableInvited`: { tableId, number,
   * username } of the table and the host who invited (`e2-t25`). `tableRequest`: { tableId, number,
   * username } of the member asking to join, to a host who is offline; `tableRequestApproved`,
   * `tableRequestDeclined`: { tableId, number, username } of the host who answered. `boardFeatured`: { boardId,
   * username } of a board the member played and who featured it (`e4-t29`). The team match kinds
   * (§5.8, `e8-t04`): { matchId, username } of who invited, accepted, declined, left, took the
   * member off a seat or called the match off; `matchStarted` { matchId, username } of the host who
   * started it, `matchFinished` { matchId } when both rooms played every board (`e8-t07`, `e8-t11`);
   * `matchAbandoned` { matchId, username } of the host who stopped it, `matchSubIn` { matchId,
   * username } of who put the member in a seat as a substitute (替補, `e8-t16`). The partnership
   * kinds (TKU BridgeBook E2, `e2-t03`): { pairId, username } of who invited the member to be
   * partners, accepted, declined or cancelled the invitation, or ended the partnership.
   * `filesNearlyFull` { gb }: to admins, the uploaded files passed 8 GB of R2's free 10 GB
   * (BridgeHall e5-t15). The handbook's kinds (BridgeHall e8-t10, e8-t11, e2-t08; worker/book-notices.ts):
   * `bookPublished` { slug, name, version, username } of a convention the member follows, plays in a
   * team or partnership, or sent for review, and the reviewer who published it; `bookOverrideChanged`
   * { slug, name, profileId, profile, username } instead when the publish changed a section that
   * their team's or partnership's profile overrides; `bookReviewRequested` { slug, name, username } to
   * the reviewers; `bookReturned` { slug, name, username } to who sent it, from the reviewer who sent
   * it back; `bookSuggestUnify` { pairId, profileId, ref, slug, name, team, username } to both
   * partners when their team's captain suggests they drop an override (`ref`, as book-notices.ts
   * `overrideRef`) and play the team's version. The library's articles (BridgeHall J4, e5-t07), each
   * { slug, title, username }: `articleReviewRequested` to the reviewers when an editor sends a
   * draft for review, `articleReturned` to who sent it when a reviewer sends it back,
   * `articlePublished` to who sent it when a reviewer publishes it. The forum's kinds (BridgeHall e11-t08;
   * worker/forum-notices.ts), each { postId, title, username } of the post (`title` is its title or
   * the start of its text) and who did it: `forumReply` (+ `commentId`) a comment on the member's
   * post or a reply to their comment; `forumMention` (+ `commentId` when in a comment) the member
   * was named with `@`; `forumAnnouncement` a new post on an officers-only board (the news), to
   * every member; `forumPinned` an officer pinned the member's post. `directorCalled` { tableId,
   * number, username } of the table and the player who called the director (`e2-t34`), to its host
   * and the admins
   */
  params: Record<string, string | number>
  read: boolean
}

/** The newest notifications (up to NOTIFICATIONS_SHOWN) and how many of all kept are unread */
export interface NotificationsView {
  items: Notification[]
  unread: number
}

/** How many notifications a member keeps, and how many the bell shows */
export const NOTIFICATIONS_KEPT = 500
export const NOTIFICATIONS_SHOWN = 30

/**
 * A direct message (私訊, AC-1.7) between two members. Only those two are ever sent it; ids grow
 * with time across the whole club, so they order a conversation and page it (`before`)
 */
export interface DirectMessage {
  id: number
  from: string
  to: string
  text: string
  at: number
}

/** One conversation as the viewer's list shows it: the other member, the newest message, unread count */
export interface Conversation {
  user: PublicUser
  last: DirectMessage
  unread: number
}

/** The viewer's conversations, newest first (up to DIRECT_CONVERSATIONS_SHOWN), and all their unread messages */
export interface DirectsView {
  conversations: Conversation[]
  unread: number
}

/** `GET /api/messages/:userId?before=<id>`: one page of a conversation, oldest first; `more` when older ones exist */
export interface DirectPage {
  messages: DirectMessage[]
  more: boolean
}

/** Messages kept per conversation, messages per page, and conversations in the list */
export const DIRECT_KEPT = 1000
export const DIRECT_PAGE_SIZE = 30
export const DIRECT_CONVERSATIONS_SHOWN = 50

/**
 * The messages a table handles by itself (ARCHITECTURE.md §5.10): nothing outside the table
 * changes, so they go over the table's own connection. Everything else goes to the club
 */
export const TABLE_ACTIONS = [
  'stand',
  'kick',
  'addRobot',
  'removeRobot',
  'replaceWithRobot',
  'call',
  'play',
  'claim',
  'claimRespond',
  'undoRequest',
  'undoRespond',
  'chat',
  'redeal',
  'rebid',
  'showHands',
] as const

export type TableAction = Extract<ClientMessage, { type: (typeof TABLE_ACTIONS)[number] }>

export const isTableAction = (message: ClientMessage): message is TableAction =>
  (TABLE_ACTIONS as readonly string[]).includes(message.type)

/** A table's own connection (ARCHITECTURE.md §5.10): `/ws/table/<id>`, next to the club's `/ws` */
export const TABLE_SOCKET_PREFIX = '/ws/table/'
/** A table id as the Worker routes it */
export const TABLE_ID_PATTERN = /^[\w-]{1,32}$/
/**
 * The close code of a table connection from a member who is not at that table (or a table that is
 * not there): the browser does not try that table again and sends through the club instead
 */
export const TABLE_SOCKET_REFUSED = 4004

export type ClientMessage =
  /** `invitees`: the members invited to the table (they are told), at most LIMITS.tableInvitesMax */
  | { type: 'createTable'; settings?: Partial<TableSettings>; invitees?: string[] }
  /** The host changes how the table is run; `invitees`, when sent, replaces the invitation list */
  | { type: 'updateTableSettings'; settings: Partial<TableSettings>; invitees?: string[] }
  /** Asks the host of a `request` table to let the member in (to sit or watch) */
  | { type: 'requestJoin'; tableId: string }
  /** The host lets a member who asked in, or turns them down */
  | { type: 'answerRequest'; userId: string; accept: boolean }
  /** Sits at the public table that most needs a player, or opens one when none does (快速入座) */
  | { type: 'quickSeat' }
  | { type: 'joinTable'; tableId: string }
  | { type: 'sit'; tableId: string; seat: Seat }
  | { type: 'stand' }
  | { type: 'leaveTable' }
  /** The host asks a person to leave a seat; they stay at the table, watching */
  | { type: 'kick'; seat: Seat }
  /** TKB in the club's system unless `kind` says otherwise */
  | { type: 'addRobot'; seat: Seat; kind?: RobotKind }
  | { type: 'removeRobot'; seat: Seat }
  /** The host asks a player who has kept the table waiting SLOW_TURN_MS to leave, and seats TKB there */
  | { type: 'replaceWithRobot'; seat: Seat; kind?: RobotKind }
  /**
   * `seat`: the seat the call is made for (seat control, `e10-t15`), which the member must make the
   * calls for (`notYourSeat`); their own seat when left out
   */
  | { type: 'call'; call: Call; alert?: string; seat?: Seat }
  | { type: 'play'; card: Card }
  | { type: 'claim'; tricks: number }
  | { type: 'claimRespond'; accept: boolean }
  | { type: 'undoRequest' }
  | { type: 'undoRespond'; accept: boolean }
  | { type: 'chat'; text: string }
  /**
   * Opens the member's own practice table (§5.11, `e10-t03`): South, with three TKB of
   * `settings.robotKind`, boards dealt to `settings.deal`. Leaves any other table first
   */
  | { type: 'createPractice'; settings: PracticeSettings; access?: TableAccess }
  /** At a practice table only: the board on the table is put away unplayed and a new one dealt */
  | { type: 'redeal' }
  /** At a bidding practice only (`e10-t15`): the board on the table is bid again from the start, the same hands */
  | { type: 'rebid' }
  /** At a practice table only, its member (`e10-t16`): 顯示四家, all four hands shown to them alone, or hidden again */
  | { type: 'showHands'; show: boolean }
  /** Marks these notifications read, or all of them when `ids` is left out */
  | { type: 'readNotifications'; ids?: string[] }
  /**
   * A player seated at the member's table calls the director (`e2-t34`): everyone at the table sees
   * it, and its host and the admins are told and may come in to watch
   */
  | { type: 'callDirector' }
  /** The host, an admin or whoever called clears the director call at the member's table */
  | { type: 'clearDirector' }
  /** Follows another member (好友) or stops following them; one-way, they are not asked */
  | { type: 'setFriend'; userId: string; friend: boolean }
  /** Blocks or unblocks another member; blocking also stops following them */
  | { type: 'setBlocked'; userId: string; blocked: boolean }
  /** Starts a challenge, or goes back to it: the player's own table, from the next board (§5.5) */
  | { type: 'playChallenge'; challengeId: string }
  /**
   * Challenges 1–20 friends (§5.5): `boards` 1–16 (8 when left out), settings over the defaults.
   * With `fromBoards` (history ids, 1–16) the boards are ones the creator played with three robots
   * (「用這副牌挑戰」, `e7-t22`): their results count and they do not play again
   */
  | {
      type: 'createChallenge'
      invitees: string[]
      boards?: number
      settings?: Partial<ChallengeSettings>
      fromBoards?: string[]
    }
  /** An invitee accepts or declines, once, before the deadline */
  | { type: 'answerChallenge'; challengeId: string; accept: boolean }
  /** The creator calls a challenge off while nobody else has started */
  | { type: 'cancelChallenge'; challengeId: string }
  /** One-click rematch (`e7-t21`): the same people and settings, new boards, once a challenge ended */
  | { type: 'rematchChallenge'; challengeId: string }
  /**
   * Team match seats before the start (§5.8, `e8-t04`, `e8-t05`): a captain invites a member to an
   * empty seat of their team, puts a robot there or clears it; the invited answer; a seated member
   * moves to an empty seat of their team, or a captain swaps two seats of their team; anyone but
   * the host leaves. Also over HTTP (`POST /api/matches/:id/<action>`)
   */
  | { type: 'matchInvite'; matchId: string; room: MatchSeat['room']; seat: Seat; userId: string }
  | { type: 'matchAnswer'; matchId: string; accept: boolean }
  | { type: 'matchMove'; matchId: string; from: MatchSeat; to: MatchSeat }
  | { type: 'matchLeave'; matchId: string }
  | { type: 'matchClear'; matchId: string; room: MatchSeat['room']; seat: Seat }
  | { type: 'matchRobot'; matchId: string; room: MatchSeat['room']; seat: Seat }
  /** The host starts the match (`e8-t07`): both rooms open and deal board 1. Also `POST /api/matches/:id/start` */
  | { type: 'startMatch'; matchId: string }
  /**
   * While a team match is played (§5.8, `e8-t14`–`e8-t16`), all the host's (替補 also a team's
   * captain's), also over HTTP (`POST /api/matches/:id/rule|pause|abandon|replace|sitin`): a ruling
   * on a board over the time limit, with its reason; pausing and resuming both rooms; abandoning a
   * paused match; a member of the club taking a seat as a substitute (paused only); a robot sitting
   * in for a member (代打) until they come back
   */
  | { type: 'matchRule'; matchId: string; seq: number; ruling: RulingKind; team: Team; reason: string }
  | { type: 'matchPause'; matchId: string; paused: boolean }
  | { type: 'matchAbandon'; matchId: string }
  | { type: 'matchReplace'; matchId: string; room: MatchSeat['room']; seat: Seat; userId: string }
  | { type: 'matchSitIn'; matchId: string; room: MatchSeat['room']; seat: Seat }
  /** Sends a direct message (AC-1.7): not to oneself, a robot, or between members where either blocked the other */
  | { type: 'sendDirect'; to: string; text: string }
  /** Marks the conversation with this member read */
  | { type: 'readDirect'; userId: string }
  /**
   * The browser's copy of the shared lobby is missing a version (`LobbyDelta` out of order, or
   * after the club restarted): the club sends the whole of it again
   */
  | { type: 'lobbySync' }

export type ServerMessage =
  | { type: 'welcome'; me: Me }
  /**
   * The lobby (H3b): the shared part whole (on connecting, after `lobbySync`, after the club
   * restarted) or what changed in it (`base` is the version it applies to), as one string for
   * everyone; and the viewer's own part whenever it changed. `epoch` is when this run of the club
   * started: versions count from there
   */
  | { type: 'lobbyShared'; epoch: number; rev: number; lobby: LobbyShared }
  | { type: 'lobbyDelta'; epoch: number; base: number; rev: number; delta: LobbyDelta }
  | { type: 'lobbyMine'; mine: LobbyMine }
  /** `now` is the server's clock when sent, so the browser can turn `dealAt` into its own time */
  | { type: 'table'; table: TableWire | null; now: number }
  | { type: 'error'; code: MessageCode; params: MessageParams; message: string }
  /** On connecting, and whenever the member's notifications change */
  | { type: 'notifications'; notifications: NotificationsView }
  /** On connecting, and whenever the member's conversations or unread counts change */
  | { type: 'directs'; directs: DirectsView }
  /** A new direct message, sent only to its two members (all their tabs) */
  | { type: 'direct'; message: DirectMessage }
  /**
   * A team match the member is in changed (§5.8): as they now see it, or null once they may no
   * longer see it (they left, declined or were taken off their seat before the start)
   */
  | { type: 'match'; matchId: string; match: TeamMatchView | null }

/** A finished board kept in the history */
export interface BoardRecord {
  id: string
  tableNumber: number
  finishedAt: number
  players: Record<Seat, PublicUser>
  board: BoardState
  /** The table's mode when it is not `casual` */
  mode?: TableMode
  /** The challenge or match the board belongs to, if any */
  eventId?: string
  /** A team match board: which room it was played in (§5.8) */
  room?: Room
  /**
   * Until when only the board's own players may see it (a challenge or a team match board one room
   * has not played yet); shown to everyone when absent. `worker/views.ts` has the rule
   */
  revealAt?: number
  /** Seats where a robot played for a member who was offline (代打) during the board, and for whom */
  substitutes?: Partial<Record<Seat, PublicUser>>
  /** The table's host when the board was finished: they may rule on it (`e2-t35`), as the admins may */
  hostId?: string
  /** When the board was dealt (server clock) */
  startedAt?: number
  /** Every action on the board with the server's time (`e2-t32`); records from before it have none */
  events?: BoardEvent[]
  /** A director's ruling on the board (`e2-t35`) */
  ruling?: BoardRuling
}

export interface BoardSummary {
  id: string
  tableNumber: number
  finishedAt: number
  players: Record<Seat, PublicUser>
  boardNo: number
  dealer: Seat
  vul: Vulnerability
  contract: Contract | null
  result: BoardResult
  mode?: TableMode
  eventId?: string
  room?: Room
  revealAt?: number
  /** The director's ruling, without its reason (the record has it) */
  ruling?: Pick<BoardRuling, 'kind' | 'side' | 'scoreNS'>
}

export function summarize(record: BoardRecord): BoardSummary {
  const { board } = record
  return {
    id: record.id,
    tableNumber: record.tableNumber,
    finishedAt: record.finishedAt,
    players: record.players,
    boardNo: board.boardNo,
    dealer: board.dealer,
    vul: board.vul,
    contract: board.contract,
    result: board.result!,
    ...(record.mode !== undefined && { mode: record.mode }),
    ...(record.eventId !== undefined && { eventId: record.eventId }),
    ...(record.room !== undefined && { room: record.room }),
    ...(record.revealAt !== undefined && { revealAt: record.revealAt }),
    ...(record.ruling && {
      ruling: {
        kind: record.ruling.kind,
        ...(record.ruling.side && { side: record.ruling.side }),
        ...(record.ruling.scoreNS !== undefined && { scoreNS: record.ruling.scoreNS }),
      },
    }),
  }
}

/** One page of the history list, newest first; `page` counts from 1 */
export interface HistoryPage {
  boards: BoardSummary[]
  total: number
  page: number
  size: number
}

/**
 * How many boards a history search finds on each Taiwan date (UTC+8, the dates `from`/`to` take),
 * newest first: the side panel's list by day (`GET /api/history/days`, e3-t48)
 */
export interface HistoryDay {
  /** YYYY-MM-DD */
  date: string
  count: number
}

export interface HistoryDays {
  days: HistoryDay[]
}

/** A board a member keeps (AC-4.4): their own note and tags, seen by no one else */
export interface Favorite {
  boardId: string
  note: string
  tags: string[]
  createdAt: number
  updatedAt: number
}

/** A member's tag and how many of their favorites carry it, for the tag filter and autocomplete */
export interface FavoriteTag {
  tag: string
  count: number
}

/** One page of 「我的收藏」: the boards as a history page, plus each one's note and tags */
export interface FavoritesPage extends HistoryPage {
  favorites: Favorite[]
  tags: FavoriteTag[]
}

/** Page sizes the history list offers */
export const HISTORY_PAGE_SIZES = [10, 20, 50, 100] as const

/** A member as the admin page lists them */
export interface AdminUser {
  id: string
  username: string
  admin: boolean
  createdAt: number
  lastLoginAt: number | null
  boards: number
  online: boolean
  permissions: Permission[]
  /** When they last reset a forgotten password themselves */
  passwordResetAt: number | null
}

/**
 * One member's changes in the admin page's members section, saved together with the others in one
 * request (POST /api/admin/members). A field left out stays as it is.
 */
export interface MemberChange {
  id: string
  admin?: boolean
  permissions?: Permission[]
}

/** Club settings an admin can change; they override the Worker's environment defaults */
export interface ClubSettings {
  maxUsers: number
  /** Empty means anyone may register (up to the limit) */
  inviteCode: string
}

/** Limits shared by the client forms and the server checks */
export const LIMITS = {
  usernameMin: 2,
  usernameMax: 16,
  passwordMin: 6,
  /** ASVS 2.1.2: long enough for any passphrase, short enough that hashing one costs nothing (docs/SECURITY.md) */
  passwordMax: 128,
  applicationNoteMax: 60,
  chatMax: 300,
  directMax: 500,
  alertMax: 200,
  maxUsersMin: 2,
  maxUsersMax: 100,
  tableInvitesMax: 30,
  historyPageDefault: 20,
  /** Days the list by day goes back at most (`GET /api/history/days`) */
  historyDaysMax: 366,
  favoritesMax: 1000,
  favoriteNoteMax: 500,
  favoriteTagsMax: 8,
  favoriteTagMax: 20,
}

export const USERNAME_PATTERN = /^[\p{L}\p{N}_.-]+$/u

// ---------------------------------------------------------------------------------------------
// System profiles (制度集, TKU BridgeBook E1 e1-t07)
//
// A profile is a layer over the club's handbook: which conventions a team or partnership plays,
// and where its agreements differ from the club's. The handbook resolves the layers into the
// conventions a reader sees (TKU-BridgeBook src/lib/profiles.ts). TKU-BridgeBook src/lib/api.ts
// mirrors these types; change them together.
// ---------------------------------------------------------------------------------------------

/** The club's own profile: always there, never deleted, the root every other profile inherits */
export const CLUB_PROFILE_ID = 'club'

/** Who a profile belongs to: the club, a team, or a partnership */
export const PROFILE_SCOPES = ['club', 'team', 'partnership'] as const
export type ProfileScope = (typeof PROFILE_SCOPES)[number]
export const isProfileScope = (value: unknown): value is ProfileScope => PROFILE_SCOPES.includes(value as ProfileScope)

/**
 * Limits the Worker checks on a saved profile: its JSON in UTF-8 bytes, how many overrides it may
 * hold, how many profiles the club may have besides its own, the name's length and a note's length
 */
export const PROFILE_LIMITS = { bytesMax: 200_000, overridesMax: 500, profilesMax: 100, nameMax: 40, noteMax: 2_000, cardEditsMax: 1_000 } as const

/**
 * Who may read a team's or partnership's profile (e2-t04): the whole club, the default, or only its
 * members (and the editors). The club's profile is the club's to read.
 */
export const PROFILE_VISIBILITIES = ['club', 'members'] as const
export type ProfileVisibility = (typeof PROFILE_VISIBILITIES)[number]

/** Whether a profile plays a convention; a convention it does not list follows the parent profile */
export type Adoption = 'on' | 'off'

/**
 * One place where a profile differs from its parent. Rows are found by position, the same as the
 * handbook's editor: `blockIndex` within the section's own blocks, `rowIndex` within that
 * `responses` block. `section` is a handbook Section (TKU-BridgeBook src/types/convention.ts),
 * checked here only for shape, like BookEntry.convention
 */
export type ProfileOverride =
  /** A response row means something else; `note`, when present, replaces the row's note ('' clears it) */
  | { kind: 'row'; slug: string; sectionId: string; blockIndex: number; rowIndex: number; meaning: string; note?: string }
  /** The whole section is replaced (it keeps `sectionId` as its id) */
  | { kind: 'section'; slug: string; sectionId: string; section: Record<string, unknown> }
  /** The convention's summary or tags, whichever is present */
  | { kind: 'meta'; slug: string; summary?: string; tags?: string[] }

/** A private note on a convention or one of its sections, shown only to the profile's members */
export interface ProfileNote {
  slug: string
  sectionId?: string
  text: string
  /** The user id that wrote it */
  by: string
  at: number
}

/**
 * A hand edit of one cell of a convention card (BridgeHall E3 e3-t06), kept by slot id such as
 * `wbf.openings.1H.responses`; the handbook fills the cards from the conventions and puts these
 * on top. Fields left out keep what the conventions filled; `text` is at most `noteMax` long
 */
export interface ProfileCardEdit {
  text?: string
  /** A tick box, or a tick-like table cell */
  checked?: boolean
  /** The chosen option of a choice */
  option?: string
  /** Marked for the partnership to look at */
  flagged?: boolean
}

export interface SystemProfile {
  /** CLUB_PROFILE_ID for the club; a random id for the others */
  id: string
  /** 「社團預設」「A 隊」「小明＋小華」 */
  name: string
  scope: ProfileScope
  /** The profile this one inherits; absent for the club, and taken as the club when absent on any other */
  parentId?: string
  /** 'members' when only its members (and the editors) may read it; absent for the whole club */
  visibility?: ProfileVisibility
  /** slug -> plays it or not; a slug left out follows the parent */
  adopted: Record<string, Adoption>
  overrides: ProfileOverride[]
  notes: ProfileNote[]
  /** Hand edits of its convention cards by slot id (e3-t06); a slot left out follows the parent */
  cardEdits?: Record<string, ProfileCardEdit>
  version: number
  updatedAt: number
  /** The user id that saved this version */
  updatedBy: string
}

/** GET /api/book/profiles: a profile without its adoptions, overrides and notes, which it counts instead */
export interface ProfileSummary {
  id: string
  name: string
  scope: ProfileScope
  parentId?: string
  visibility?: ProfileVisibility
  version: number
  updatedAt: number
  updatedBy: string
  counts: { adopted: number; overrides: number; notes: number }
}

/** A saved version of a profile, newest first in the list, which leaves out `profile` */
export interface ProfileRevision {
  profileId: string
  version: number
  at: number
  /** The user id that saved it */
  by: string
  note: string
  profile?: SystemProfile
}

/** What an editor sends to create or save a profile; the Worker sets the id, version and who saved it */
export type ProfileInput = Pick<SystemProfile, 'name' | 'scope' | 'parentId' | 'visibility' | 'adopted' | 'overrides' | 'notes' | 'cardEdits'>

// ── 淡江橋館 → the robot (BridgeHall E7: e7-t03, e7-t04) ────────────────────────────────────────

/**
 * A profile's rules as last synced from 淡江橋館: the handbook makes the `SystemSpec` from the
 * profile's conventions (`toSystemSpec`) and an editor sends it here (PUT /api/book/system-spec/:id)
 */
export interface SyncedSystemSpec {
  spec: SystemSpec
  syncedAt: number
  /** The user id that synced it */
  syncedBy: string
  /** Their username, when the account still exists */
  syncedByName?: string
}

/** GET /api/book/system-spec?profileId=: the profile's synced rules, and which profile TKB follows */
export interface SystemSpecStatus {
  /** The profile whose rules TKB uses in the club's system (`ClubConfig.systemProfileId`) */
  tableProfileId: string
  /** Null until the profile is synced */
  synced: SyncedSystemSpec | null
}

/** PUT /api/book/system-spec/:profileId */
export interface SystemSpecInput {
  spec: SystemSpec
}

/** POST /api/book/robot-meanings: the calls to look up, after each auction (a `Book.after` pattern) */
export interface RobotMeaningsQuery {
  items: { after: string; calls: string[] }[]
}

/** What the robot's rule shows, in the parts the handbook's patterns read, and in words */
export interface RobotShows extends Omit<SpecShows, 'name'> {
  /** The robot's convention name (`CONVENTIONS`), which may be one the handbook's patterns do not read */
  name?: string
  /** `describe` in Traditional Chinese */
  text: string
}

export interface RobotMeaningsItem {
  after: string
  /** Null when no rule of TKB in the club's system makes the call after this auction */
  meanings: Record<string, RobotShows | null>
}

/** The answer to POST /api/book/robot-meanings */
export interface RobotMeanings {
  items: RobotMeaningsItem[]
}

/**
 * A synced spec's size (its JSON), how many auctions one robot-meanings request may ask about and
 * how many calls after each: small enough for one request's CPU on the free plan
 */
export const SYSTEM_SPEC_LIMITS = { bytesMax: 1_000_000, meaningItemsMax: 10, meaningCallsMax: 38 } as const

/**
 * What the member asking may do with a profile (e2-t04), sent with GET /api/book/profiles/:id so the
 * handbook knows what to offer; the Worker checks again on every call. `notes`: sees its private
 * notes; `edit`: may save it; `share`: may change its visibility (a team's captain, not its members)
 */
export interface ProfileAccess {
  notes: boolean
  edit: boolean
  share: boolean
}

// Convention card versions (制度卡版本, TKU BridgeHall E3 e3-t09)
//
// A published version of one profile's card on one template: the card as the handbook filled it
// (its src/cards/fill.ts FilledCard, kept as sent) and, when the handbook made one, the Word file.
// Read by whoever may read the profile; with `shared` on, by anyone with the link, signed in or
// not, until it is turned off. The handbook mirrors these in TKU-BridgeHall src/lib/api.ts.
// ---------------------------------------------------------------------------------------------

/** Versions per profile, the card's JSON, the Word file (bytes, before base64) and the note */
export const CARD_SNAPSHOT_LIMITS = { perProfile: 200, cardBytesMax: 800_000, docxBytesMax: 600_000, noteMax: 200 } as const

/**
 * POST /api/book/card-pdf (BridgeHall e3-t13, worker/card-pdf.ts): the card page's printable HTML
 * printed to PDF by Browser Run. The HTML stays under the API's 2 MB body; each member may make
 * `perMemberBurst` at once, then one every `perMemberEveryMs`; the club stops at `dailyBrowserMs`
 * of browser time a day (the Workers Free plan has 10 minutes); the same HTML within `cacheMs` is
 * not printed again
 */
export const CARD_PDF_LIMITS = {
  htmlBytesMax: 1_900_000,
  perMemberBurst: 5,
  perMemberEveryMs: 120_000,
  dailyBrowserMs: 8 * 60_000,
  cacheMs: 60 * 60_000,
  cacheEntries: 20,
} as const

/** The sheet a card is printed on (BridgeHall cards/types.ts `CardTemplate.paper`) */
export type CardPdfPaper = 'A4-landscape' | 'A4-portrait'

/** POST /api/book/card-pdf's body; the answer is the PDF (application/pdf) */
export interface CardPdfRequest {
  html: string
  paper: CardPdfPaper
  /** The file's name without `.pdf`; ASCII letters, digits and - only (anything else is dropped) */
  name?: string
}

/** GET /api/book/cards/:profileId: a version without its card */
export interface CardSnapshotMeta {
  profileId: string
  /** The handbook's template id (wbf, ctcba-simple…) */
  templateId: string
  /** 1, 2, … for each profile and template */
  n: number
  at: number
  /** The user id that published it */
  by: string
  byName?: string
  note: string
  /** The profile as it was filled from */
  profileName: string
  profileVersion: number
  /** Anyone with the link may read it */
  shared: boolean
  /** Has the Word file (GET …/docx) */
  docx: boolean
}

/** GET /api/book/cards/:profileId/:templateId/:n */
export interface CardSnapshot extends CardSnapshotMeta {
  card: Record<string, unknown>
}

/** POST /api/book/cards/:profileId */
export interface CardSnapshotInput {
  templateId: string
  profileVersion: number
  note?: string
  card: Record<string, unknown>
  /** The Word file, base64 */
  docx?: string
}

// Teams and partnerships (隊伍與搭檔, TKU BridgeBook E2 e2-t01)
//
// Each team and each active partnership owns a system profile (above): a team's inherits the
// club's, a partnership's its team's or the club's. The handbook mirrors these types in
// TKU-BridgeBook src/lib/api.ts; change them together. The table's team matches (E8) may use the
// same teams later (`Team` there is a match's side, A or B), so the shape of ClubTeam stays put until then.
// ---------------------------------------------------------------------------------------------

/** Most members a team may have (its captain included); most partnerships, pending or active, one member may be in */
export const TEAM_LIMITS = { membersMax: 8, pairsMax: 10, nameMax: 40 } as const

export interface ClubTeam {
  id: string
  name: string
  /** A member of the team; manages it with the editors */
  captainId: string
  /** User ids, the captain's among them, in the order they joined */
  memberIds: string[]
  /** The team's system profile, made with the team */
  profileId: string
  createdAt: number
  /** Archived teams keep their members and profile but are left off the lists by the handbook */
  archived?: boolean
  /** The captain lets the members edit the team's profile too (e2-t10); absent when only the captain may */
  membersEdit?: boolean
}

export const PAIR_STATUSES = ['pending', 'active', 'ended'] as const
export type PairStatus = (typeof PAIR_STATUSES)[number]

export interface Partnership {
  id: string
  /** [who invited, who was invited] */
  userIds: [string, string]
  /** The team the two play for, when they do; both are its members */
  teamId?: string
  /** The partnership's system profile, made when the invitation is accepted: '' while pending */
  profileId: string
  createdAt: number
  status: PairStatus
  /** When the invitation was accepted, and when the partnership ended */
  acceptedAt?: number
  endedAt?: number
}

/** POST /api/club/teams: the captain is added to the members when left out */
export interface TeamInput {
  name: string
  captainId: string
  memberIds?: string[]
}

/** PATCH /api/club/teams/:id: whichever fields are present */
export interface TeamPatch {
  name?: string
  captainId?: string
  archived?: boolean
  membersEdit?: boolean
}

/**
 * POST /api/club/teams/:id/suggest-unify (BridgeHall e2-t08): the captain suggests one of the
 * team's partnerships drop an override (`ref`, as worker/book-notices.ts `overrideRef`); `name` is
 * the convention's name as the handbook shows it
 */
export interface SuggestUnifyInput {
  pairId: string
  ref: string
  name?: string
}

/** GET and PUT /api/book/follows/:slug (BridgeHall e8-t10): whether the member follows (關注) a convention */
export interface BookFollow {
  following: boolean
}

/** GET /api/club/members: who may be put on a team or invited as a partner, by username */
export interface ClubMember {
  id: string
  username: string
  /** Their profile's display name, when they set one (TKU-BridgeBook e11-t01) */
  displayName?: string
  /** Their uploaded picture's version (`avatarUrl`); none means the default avatar */
  avatar?: number
}

/** GET /api/club/members/:id/teams: the teams a member is in and their active partnerships (TKU-BridgeHall e11-t04) */
export interface MemberTeams {
  teams: ClubTeam[]
  pairs: Partnership[]
}

/** POST /api/club/pairs: invite `partnerId`, optionally as partners in a team both belong to */
export interface PairInvite {
  partnerId: string
  teamId?: string
}

// BridgeHall's error reports and anonymous usage counts (BridgeHall e10-t06, e10-t07;
// worker/book-telemetry.ts, ARCHITECTURE.md §5.15). BridgeHall's src/lib/api.ts copies these word for word

/** A browser error the book reported (e10-t06): cleaned, no member id */
export interface BookClientError {
  id: number
  /** ms since epoch, server time */
  at: number
  kind: 'error' | 'rejection' | 'boundary'
  message: string
  source?: string
  stack?: string
  /** Path only, no query */
  page?: string
  version?: string
  /** How many times the same kind+message+source+page came in; the row keeps the latest time */
  count: number
}

export type BookAnalyticsEventType = 'page' | 'search' | 'profile-switch' | 'quiz-answer'

/** One anonymous usage event (e10-t07); no member id, no profile id */
export interface BookAnalyticsEvent {
  type: BookAnalyticsEventType
  /** page: the path without query, e.g. `/c/stayman`, `/practice`; ≤ 200 chars */
  path?: string
  /** page on a convention page, quiz-answer: the convention slug */
  slug?: string
  /** search: the query the reader settled on, trimmed, ≤ 50 chars */
  query?: string
  /** profile-switch: the kind of profile switched to */
  profileKind?: 'club' | 'team' | 'pair' | 'personal'
  /** quiz-answer */
  correct?: boolean
}

export interface BookAnalyticsBatch {
  /** Random id the browser makes per ISO week (not stored past the weekly count) */
  visitor: string
  events: BookAnalyticsEvent[]
}

export interface BookAnalyticsWeek {
  /** Monday of the week, YYYY-MM-DD (UTC) */
  week: string
  visitors: number
  pages: number
}

export interface BookAnalyticsView {
  enabled: boolean
  /** Last 12 weeks, oldest first, weeks without data included with zeros */
  weeks: BookAnalyticsWeek[]
  /** Last 28 days, most viewed first, ≤ 20 */
  topConventions: { slug: string; views: number }[]
  /** Last 28 days, ≤ 20 */
  topSearches: { query: string; count: number }[]
  /** Last 28 days */
  profileSwitches: number
  /** Last 28 days */
  quiz: { answered: number; correct: number }
}
