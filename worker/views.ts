import { legalCalls, type AuctionCall, type BookNote, type Call } from '../shared/auction.ts'
import type { Vulnerability } from '../shared/board.ts'
import { bookTopics } from '../shared/book-topics.ts'
import { nextSeat, partnerOf, SEATS, sideOf, type Seat } from '../shared/cards.ts'
import { ROBOT_SYSTEMS } from '../shared/robot/robots.ts'
import { explain } from '../shared/robot/system/engine.ts'
import { bookNoteFor, type BookNotes } from '../shared/robot/system/book-spec.ts'
import type { Spec, System } from '../shared/robot/system/spec.ts'
import {
  canUndoFor,
  claimApprovers,
  controllerOf,
  dummyOf,
  legalCards,
  remainingCards,
  tricksOf,
  tricksWon,
  turnOf,
  type BoardState,
} from '../shared/game.ts'
import type {
  BoardRecord,
  BoardSummary,
  BoardView,
  ChatMessage,
  PublicUser,
  RobotKind,
  SeatOccupant,
  TableMode,
  TablePractice,
  TableSettings,
} from '../shared/protocol.ts'
import { TABLE_REQUEST_MS, type RobotSpeed } from '../shared/protocol.ts'
import type { EventReport, PracticeTableState } from './modes.ts'
import { isOpenChallenge, type ChallengeTraveller, type ChallengeView } from '../shared/challenge.ts'
import type { DealSource } from '../shared/deal-source.ts'
import type { MemberProfile, Profile } from '../shared/profile.ts'
import { challengeStandings, hasFinished } from './challenge-flow.ts'
import type { Challenge } from './challenges.ts'
import type { Traveller } from '../shared/traveller.ts'
import type { EventBoard } from './history-index.ts'
import { teamAt, type MatchBoardView, type MatchRoomView, type TeamMatchView, type VugraphChatLine } from '../shared/team-match.ts'
import { scoreTeamMatch } from '../shared/team-scoring.ts'
import { isMatchPlayer } from './team-match-flow.ts'
import { boardScores, type MatchChatLine, type RoomResult, type TeamMatch } from './team-matches.ts'

/** A table as the Worker keeps it */
export interface Table {
  id: string
  number: number
  hostId: string
  seats: Record<Seat, string | null>
  spectators: string[]
  boardsPlayed: number
  board: BoardState | null
  chat: ChatMessage[]
  undo?: { seat: Seat }
  /** The last claim, when it was turned down; cleared by the next action */
  rejectedClaim?: { seat: Seat; tricks: number; by: Seat }
  recordId?: string
  /** When the next board is dealt (ms), once a board is finished */
  dealAt?: number
  /** Declarer's and dummy's seats when a person was moved into a robot partner's declaring seat */
  swapped?: [Seat, Seat]
  /** Boards finished here, newest first (older tables may not have it) */
  recent?: BoardSummary[]
  createdAt: number
  /** What the table is for (`worker/modes.ts`); tables saved before modes are casual */
  mode?: TableMode
  /** The mode's own progress, e.g. which challenge boards are done */
  modeState?: unknown
  /** Where the boards come from; random when absent. Fixed hands never leave the server */
  dealSource?: DealSource
  /** How the host runs the table; tables saved before settings use DEFAULT_TABLE_SETTINGS */
  settings?: TableSettings
  /** Members the host invited (`e2-t25`); at a hidden or request table they come in without asking */
  invited?: string[]
  /** Members the host let in after they asked (a `request` table); kept while the table is open */
  approved?: string[]
  /**
   * Members waiting for the host to answer their request to join, oldest first; gone after
   * TABLE_REQUEST_MS. `muted`: the host blocked them, so the host never sees it (they are not told)
   */
  requests?: TableRequest[]
  /** When the host last declined each member, for the cooldown before they may ask again */
  declined?: Record<string, number>
  /** When the board on the table was dealt, for its time limit (`TableSettings.boardMinutes`) */
  boardStartedAt?: number
  /** When the table started waiting on the current call or card, for the reminder (SLOW_TURN_MS) */
  turnSince?: number
  /** Robots sitting in for members who dropped offline (代打): seat → the member's id */
  substitutes?: Partial<Record<Seat, string>>
  /** Seats where a robot sat in for a member during the board on the table, for its record */
  boardSubstitutes?: Partial<Record<Seat, string>>
  /**
   * The names of the members the table shows (seated, watching, invited, sat in for), given by the
   * club with each action, so the table never has to ask it (ARCHITECTURE.md §5.10)
   */
  names?: Record<string, string>
  /** Whom each member at the table blocked, for the chat each of them sees (`chatFor`) */
  blocks?: Record<string, string[]>
  /** How fast each member at the table wants the robots to play (出牌速度), when not the default */
  speeds?: Record<string, RobotSpeed>
  /** Finished boards whose record the club has not taken yet; offered again until it does (§5.10) */
  outbox?: { record: BoardRecord; event: EventReport | null }[]
  /**
   * TKB's system when nobody chooses one (a robot sitting in, 代打, with no robot partner): its
   * host's when the table opened, the club's only for one with `tkuSystem` (ROBOT.md §7). Tables
   * saved before have none and keep the club's
   */
  robotKind?: RobotKind
  /**
   * Seat control (`e10-t15`, §4): the member who makes the calls for a seat instead of whoever sits
   * there. The seat keeps its occupant (TKB at a bidding practice), who neither calls nor sees
   * anything more for it; the controller sees that hand and bids for it. A seat not listed is its
   * occupant's. General on purpose: a partner bidding later (`e10-t08`) and a teacher at a teaching
   * table (`e10-t10`) are controllers too. Only a practice table sets it for now, and only for calls
   */
  controllers?: Partial<Record<Seat, string>>
}

/** Who makes the calls for a seat: its controller, else whoever sits there (a member or a robot) */
export const actorOf = (table: Pick<Table, 'seats' | 'controllers'>, seat: Seat): string | null =>
  table.controllers?.[seat] ?? table.seats[seat]

/**
 * The seats a member calls for (`actorOf`), in table order: their own seat unless someone else
 * controls it, and every seat they control. They see each of these hands (`boardView`'s `acts`)
 */
export const seatsActedBy = (table: Pick<Table, 'seats' | 'controllers'>, userId: string): Seat[] =>
  SEATS.filter((seat) => actorOf(table, seat) === userId)

/** A member's request to join a table (`Table.requests`) */
export interface TableRequest {
  userId: string
  at: number
  muted?: boolean
}

/** Requests still waiting at `now` (TABLE_REQUEST_MS) */
export const liveRequests = <R extends { at: number }>(requests: R[] | undefined, now: number): R[] =>
  (requests ?? []).filter((r) => now - r.at < TABLE_REQUEST_MS)

/** What the access rules need to know about a table: from the table itself or from the club's directory */
export interface AccessFacts {
  mode?: TableMode
  hostId: string
  settings: TableSettings
  invited?: string[]
  approved?: string[]
}

/**
 * Whether the lobby lists a table for a member (the four access modes, ARCHITECTURE.md §5): never
 * a challenge table (someone's own) nor a team match's (listed with the match); a hidden table
 * only for its host, the invited and whoever is at it; every other table for everyone. `at`: the
 * member is seated at it or watching
 */
export function tableListed(table: AccessFacts, userId: string, at: boolean): boolean {
  // A team match's tables are listed with their match (`LobbyView.matches`, §5.8)
  if (table.mode === 'challenge' || table.mode === 'team') return false
  if (at || table.hostId === userId) return true
  return table.settings.access !== 'hidden' || !!table.invited?.includes(userId)
}

/**
 * Whether the lobby lists a table for every member alike (`tableListed` for anyone): then it goes
 * in the part of the lobby everyone shares (`LobbyShared`, H3b), and so does where each member sits
 * or watches there. A hidden table, and where anyone is at one, only ever go in the own part
 * (`LobbyMine`) of those it is listed for
 */
export function listedForEveryone(table: AccessFacts): boolean {
  return table.mode !== 'challenge' && table.mode !== 'team' && table.settings.access !== 'hidden'
}

/**
 * Whether a member may come to a table (sit in an empty seat, or watch where watching is allowed)
 * without asking: anyone at a public table; the invited and the approved at a request table; the
 * invited at a hidden table; nobody new at a closed table. The host and whoever is already at the
 * table always may. A host's block is checked by the club (it knows the blocks)
 */
export function mayEnter(table: AccessFacts, userId: string, at: boolean): boolean {
  if (table.mode === 'challenge') return false
  if (at || table.hostId === userId) return true
  const invited = !!table.invited?.includes(userId)
  switch (table.settings.access) {
    case 'public':
      return true
    case 'request':
      return invited || !!table.approved?.includes(userId)
    case 'hidden':
      return invited
    case 'closed':
      return false
  }
}

/** Why a member may not come in (`mayEnter` is false): the error they get */
export function refusal(table: AccessFacts, userId: string): 'tableGone' | 'requestFirst' | 'tableClosed' {
  if (!tableListed(table, userId, false)) return 'tableGone'
  return table.settings.access === 'request' ? 'requestFirst' : 'tableClosed'
}

/**
 * Whether a member may see a finished board in any list, search, side panel or detail page
 * (AC-4.9): a board kept back until `revealAt` (a challenge or match still being played) is seen
 * only by its own players until then. The history search applies the same rule in SQL
 * (`worker/history-index.ts`)
 */
export function recordVisible(
  record: Pick<BoardSummary, 'players' | 'revealAt'>,
  userId: string,
  now: number,
): boolean {
  if (record.revealAt === undefined || record.revealAt <= now) return true
  return SEATS.some((seat) => record.players[seat]?.id === userId)
}

/**
 * Another member's profile as anyone in the club may see it (AC-1.5): the id, the username, the
 * avatar's version and the four profile fields, picked one by one so nothing else on the account (password hash, admin
 * flags, sign-in times, settings) can leak. `recent` must already be filtered by `recordVisible`
 */
export function memberProfileView(
  user: { id: string; username: string; avatar?: number; profile?: Profile },
  recent: BoardSummary[],
): MemberProfile {
  const { displayName, level, system, bio } = user.profile ?? {}
  return {
    id: user.id,
    username: user.username,
    ...(user.avatar && { avatar: user.avatar }),
    profile: {
      ...(displayName && { displayName }),
      ...(level && { level }),
      ...(system && { system }),
      ...(bio && { bio }),
    },
    recent,
  }
}

/**
 * The table chat as one viewer sees it (AC-1.6): what members they blocked say is left out, for
 * them only; everyone else still sees it. Unblocking brings the kept messages back. A player at a
 * team match table (`player`) never sees what the watchers say (`kibitz`, §5.8): watchers may be
 * following the other room too
 */
export function chatFor(
  chat: ChatMessage[],
  blocked: (authorId: string) => boolean,
  { player = false }: { player?: boolean } = {},
): ChatMessage[] {
  return chat.filter((message) => !blocked(message.userId) && !(player && message.kibitz))
}

export function seatOccupants(
  table: Pick<Table, 'seats'>,
  user: (id: string) => PublicUser | undefined,
  isOnline: (id: string) => boolean,
): Record<Seat, SeatOccupant | null> {
  const seats = {} as Record<Seat, SeatOccupant | null>
  for (const seat of SEATS) {
    const id = table.seats[seat]
    const found = id ? user(id) : undefined
    seats[seat] = found ? { ...found, online: isOnline(found.id) } : null
  }
  return seats
}

/**
 * What one viewer may see of a board. Players see their own hand, dummy once the opening lead is
 * made (and dummy then sees the declarer's hand, as on BBO), and everything once the board is over.
 * A claim lays the claimer's hand face up for good, even if it is rejected: once the declarer has
 * claimed, both defenders see all four hands (the declarer still sees only their own and dummy);
 * a defender who claimed shows their hand to everyone.
 * Spectators see all four hands, as kibitzers do on BBO; at a table that allows no kibitzers
 * (`kibitz: false`, `e2-t26`) someone there without a seat (a player who stood up or was asked to
 * leave it) sees only what is face up for everyone: dummy after the lead and a defender's claim.
 * Partners never see each other's alerts
 * until the board is over, except a robot's, which are for everyone (GIB's on BBO are too). What
 * the engine reads a person's call as (`meaning` with `inferred`, e5-t22) is for everyone too:
 * it comes only from the public auction and the side's system, like a convention card.
 * `auctionSeat` is where the viewer bid from, if a declarer swap has moved them since.
 * `acts` are the seats the viewer calls for (`seatsActedBy`, seat control): they see each of those
 * hands as their own, and get `legalCalls` when it is the turn of any of them (for that seat:
 * `turn`). Nobody else sees any more for it; a seat someone else controls is still the viewer's own
 * to look at, never to call for. `shown` are seats the viewer may look at but not call for (顯示四家,
 * `e10-t16`): the table gives it only to a practice table's own member, when they turned it on.
 * A challenge table's deal set (`Table.dealSource`) never goes out: only the board being played
 * is in `board`, and this function only ever sees that one.
 */
export function boardView(
  board: BoardState,
  viewer: Seat | null,
  extras: {
    undo?: { seat: Seat }
    recordId?: string
    rejectedClaim?: { seat: Seat; tricks: number; by: Seat }
    auctionSeat?: Seat
    /** False at a table without undo (a challenge table) */
    undoAllowed?: boolean
    /** False at a table that allows no kibitzers: someone without a seat sees no hidden hand */
    kibitz?: boolean
    /** The robots at the table, by seat: on the viewer's turn the bidding box hints come from one */
    robots?: Partial<Record<Seat, RobotKind>>
    /** 淡江橋館's words for the club's system (`ClubLink.bookNotes`): the hints for TKB name them too */
    bookNotes?: BookNotes | null
    /** The seats the viewer calls for (seat control); just their own seat when left out */
    acts?: Seat[]
    /**
     * Seats whose hands the viewer is shown without calling for them: 顯示四家 at a practice table,
     * for its member alone (`e10-t16`). Nothing else changes: no bidding box, no hints for them
     */
    shown?: Seat[]
  } = {},
): BoardView {
  const finished = board.phase === 'finished'
  const dummy = dummyOf(board)
  const dummyExposed = dummy !== null && board.play.length > 0
  const declarer = board.contract?.declarer
  const claimed = board.claimed ?? []
  const defender = viewer !== null && viewer !== declarer && viewer !== dummy
  const acts = viewer === null ? [] : (extras.acts ?? [viewer])
  const canSee = (seat: Seat) =>
    finished ||
    (viewer === null && extras.kibitz !== false) ||
    seat === viewer ||
    acts.includes(seat) ||
    (viewer !== null && !!extras.shown?.includes(seat)) ||
    (dummyExposed && seat === dummy) ||
    (dummyExposed && viewer === dummy && seat === declarer) ||
    (claimed.includes(seat) && seat !== declarer) ||
    (defender && !!declarer && claimed.includes(declarer))

  const hands: BoardView['hands'] = {}
  const handCounts = {} as BoardView['handCounts']
  for (const seat of SEATS) {
    const cards = finished ? board.hands[seat] : remainingCards(board, seat)
    handCounts[seat] = cards.length
    if (canSee(seat)) hands[seat] = cards
  }

  // A partner's alert is hidden, unless the viewer made that call (they bid for both hands)
  const auction = board.auction.map((entry) => {
    if (entry.alert === undefined || entry.robot || finished || viewer === null || acts.includes(entry.seat)) return entry
    if (viewer !== partnerOf(entry.seat) && !acts.includes(partnerOf(entry.seat))) return entry
    const { alert: _hidden, ...rest } = entry
    return rest
  })

  const turn = turnOf(board)
  // The seat the viewer calls for now, if it is the turn of one of theirs
  const calling = board.phase === 'auction' && turn && acts.includes(turn) ? turn : null
  const view: BoardView = {
    boardNo: board.boardNo,
    dealer: board.dealer,
    vul: board.vul,
    phase: board.phase,
    hands,
    handCounts,
    auction,
    contract: board.contract,
    dummy,
    turn,
    tricks: tricksOf(board),
    tricksWon: tricksWon(board),
    legalCards:
      viewer && turn && !board.claim && board.phase === 'play' && controllerOf(board, turn) === viewer
        ? legalCards(board, turn)
        : [],
    legalCalls: calling ? [...legalCalls(board.auction, board.dealer)] : [],
    canUndo:
      !!viewer &&
      extras.undoAllowed !== false &&
      !extras.undo &&
      (canUndoFor(board, viewer, extras.auctionSeat ?? viewer) ||
        (board.phase === 'auction' && acts.some((seat) => seat !== viewer && canUndoFor(board, seat)))),
    canClaim: !!viewer && board.phase === 'play' && viewer !== dummy && !board.claim,
  }

  if (board.claim) {
    view.claim = { ...board.claim, approvers: claimApprovers(board, board.claim.seat) }
  }
  if (extras.undo && !finished) view.undo = extras.undo
  if (extras.rejectedClaim && board.phase === 'play') view.rejectedClaim = extras.rejectedClaim
  if (board.result) view.result = board.result
  if (extras.recordId && finished) view.recordId = extras.recordId
  if (calling) {
    // A robot whose seat the viewer bids for does not read the calls: it is the viewer's hand
    const robots = Object.fromEntries(Object.entries(extras.robots ?? {}).filter(([seat]) => !acts.includes(seat as Seat)))
    const hints = callMeaningsFor(board, calling, robots, extras.bookNotes)
    if (hints) view.callMeanings = hints
  }
  // The hint card (`e10-t06`): the club's book, so not when the partner of the seat bidding is TKB playing 2/1
  const bidder = calling ?? viewer
  if (!bidder || extras.robots?.[partnerOf(bidder)] !== 'gib')
    view.bookTopics = bookTopics(ROBOT_SYSTEMS.tku, board.auction, board.dealer, board.vul, sideOf(bidder ?? 'S'), board.phase !== 'auction', explained)
  return view
}

/**
 * The engine's meanings of the next call after an auction (`explain`), remembered for the last few
 * auctions: every view of a table on each change asks for the same ones, and the hint card asks for
 * every call made so far. From the auction alone, so sharing them between viewers shows nothing
 */
const EXPLAINED = new Map<string, Map<Call, Spec>>()

function explained(system: System, auction: readonly AuctionCall[], dealer: Seat, vul: Vulnerability): Map<Call, Spec> {
  const key = `${system.id}|${dealer}|${vul}|${auction.map((c) => c.call).join(' ')}`
  let meanings = EXPLAINED.get(key)
  if (!meanings) {
    meanings = explain(system, auction, dealer, vul)
    EXPLAINED.set(key, meanings)
    if (EXPLAINED.size > 256) EXPLAINED.delete(EXPLAINED.keys().next().value!)
  }
  return meanings
}

/**
 * The bidding box hints (e5-t22): what each of the viewer's legal calls would show in a robot's
 * system, the partner's when the partner is a robot, else an opponent's. Worked out by the engine
 * from the auction alone (`explain`), as GIB explains a call before it is made: nothing about any
 * hand, so rule 6 holds. None at a table without robots.
 */
export function callMeaningsFor(
  board: BoardState,
  viewer: Seat,
  robots: Partial<Record<Seat, RobotKind>>,
  notes?: BookNotes | null,
): BoardView['callMeanings'] {
  const robot = [partnerOf(viewer), nextSeat(viewer), nextSeat(viewer, 3)].find((seat) => robots[seat])
  if (!robot) return undefined
  const kind = robots[robot]!
  const meanings: Partial<Record<Call, Spec>> = {}
  for (const [call, spec] of explained(ROBOT_SYSTEMS[kind], board.auction, board.dealer, board.vul)) meanings[call] = spec
  // TKB in the club's system: the handbook's words for each call too, and where they are (e7-t05)
  const book: Partial<Record<Call, BookNote>> = {}
  if (kind === 'tku' && notes)
    for (const call of legalCalls(board.auction, board.dealer)) {
      const note = call === 'P' ? undefined : bookNoteFor(notes, board.auction, call)
      if (note) book[call] = note
    }
  return { robot, kind, meanings, ...(Object.keys(book).length ? { book } : {}) }
}

/** What a challenge's viewer is to it, for the rules below */
function challengeRole(c: Challenge, userId: string) {
  const player = c.players.find((p) => p.userId === userId)
  const played = new Set(c.results.filter((r) => r.userId === userId).map((r) => r.seq))
  return { player, played, ended: !isOpenChallenge(c.status), finished: !!player && hasFinished(c, player) }
}

/**
 * Whether a member may see one board of a challenge before it is shown to everyone (§4, `e7-t14`):
 * a participant who played every board sees everyone's record of each (the traveller and its
 * replay). Someone still playing sees no one else's board, not even one they played: knowing
 * whether they are ahead or behind would change how they play the rest (社長, 2026-10-24).
 * Everyone else waits for the record's `revealAt`, brought forward to the end (`recordVisible`)
 */
export function challengeBoardVisible(c: Challenge, boardId: string, userId: string): boolean {
  return c.results.some((r) => r.boardId === boardId) && challengeRole(c, userId).finished
}

/**
 * A challenge as a member may see it (§4, §5.5, `e7-t14`), or null. Participants (invited,
 * accepted or declined) always see the settings, the state and how many boards each person has
 * played; the deals never go out. On top of that, while it is open:
 * - the boards' travellers (everyone's contract, tricks and score), the live standings and the
 *   person × board matrix only for those who played every board: someone still playing sees none
 *   of it, not even for boards they played, so they cannot tell whether they are ahead (社長).
 * Once it ended every participant sees all of it. Non-participants see nothing, unless it finished
 * with `ranking = club`: then the standings, without the boards
 */
export function challengeView(
  challenge: Challenge,
  userId: string,
  userById: (id: string) => PublicUser | undefined,
  boards: (boardId: string) => EventBoard | undefined = () => undefined,
): ChallengeView | null {
  const c = challenge
  const role = challengeRole(c, userId)
  const clubRanking = !role.player && c.status === 'finished' && c.settings.ranking === 'club'
  if (!role.player && !clubRanking) return null
  const played = new Map<string, number>()
  for (const r of c.results) played.set(r.userId, (played.get(r.userId) ?? 0) + 1)
  const view: ChallengeView = {
    id: c.id,
    creatorId: c.creatorId,
    createdAt: c.createdAt,
    status: c.status,
    deadline: c.deadline,
    ...(c.startedAt !== undefined && { startedAt: c.startedAt }),
    ...(c.endedAt !== undefined && { endedAt: c.endedAt }),
    settings: c.settings,
    boards: c.deals.boards.length,
    players: c.players.map((p) => {
      const user = userById(p.userId)
      return {
        ...(user && { user }),
        userId: p.userId,
        status: p.status,
        ...(p.answeredAt !== undefined && { answeredAt: p.answeredAt }),
        ...(p.startedAt !== undefined && { startedAt: p.startedAt }),
        ...(p.finishedAt !== undefined && { finishedAt: p.finishedAt }),
        played: played.get(p.userId) ?? 0,
        knownDeals: p.knownDeals,
      }
    }),
  }

  if (clubRanking) {
    const standings = challengeStandings(c)
    view.standings = { ...standings, ranked: standings.ranked.map(({ boards: _matrix, ...rest }) => rest) }
    return view
  }
  // Expired and cancelled challenges rank nobody; their boards are open to the participants
  if (c.status === 'finished' || (!role.ended && role.finished)) view.standings = challengeStandings(c)
  const travellers: ChallengeTraveller[] = []
  for (const [i, board] of c.deals.boards.entries()) {
    const seq = i + 1
    if (!role.ended && !role.finished) break
    const entries = c.results
      .filter((r) => r.seq === seq)
      .map((r) => {
        const found = boards(r.boardId)
        return {
          userId: r.userId,
          boardId: r.boardId,
          scoreNS: r.scoreNS,
          contract: found?.contract ?? null,
          declarerTricks: found?.declarerTricks ?? null,
          ...(found?.lead !== undefined && { lead: found.lead }),
        }
      })
    if (entries.length) travellers.push({ seq, boardNo: board.boardNo, entries })
  }
  if (travellers.length) view.travellers = travellers
  return view
}

// ── Team matches (§5.8) ─────────────────────────────────────────────────────────────────────

/**
 * A team match as one member may see it (`GET /api/matches…`, §4): the host and everyone invited
 * to or sitting in a seat see it from the start; other members only once it is being played (as
 * kibitzers may watch both tables) or over, never while it is set up or after it was cancelled.
 * The deals are never sent. A board is shown only once it has a result (both rooms played it, or
 * the host ruled on it): one room's score alone would tell the other room's players how the board
 * went before they play it. Each room's result carries the contract and the declarer's tricks from
 * the history index (`details`, the match's rows) and its opening lead, for the result page (`e8-t12`)
 */
export function teamMatchView(
  match: TeamMatch,
  userId: string,
  userById: (id: string) => PublicUser | undefined,
  details?: Map<string, EventBoard>,
): TeamMatchView | null {
  const m = match
  const outsiderMaySee = m.status === 'playing' || m.status === 'finished' || m.status === 'abandoned'
  if (!isMatchPlayer(m, userId) && !outsiderMaySee) return null
  const score = scoreTeamMatch(
    m.settings.scoring,
    Array.from({ length: m.settings.boards }, (_, i) => boardScores(m.boards.find((b) => b.seq === i + 1))),
  )
  const boards: MatchBoardView[] = []
  for (const [i, result] of score.boards.entries()) {
    if (!result) continue
    const board = m.boards.find((b) => b.seq === i + 1)
    const room = (r: RoomResult): MatchRoomView => {
      const found = details?.get(r.boardId)
      return {
        boardId: r.boardId,
        scoreNS: r.scoreNS,
        ...(found && { contract: found.contract, declarerTricks: found.declarerTricks }),
        ...(r.lead && { lead: r.lead }),
      }
    }
    boards.push({
      seq: i + 1,
      ...(board?.open && { open: room(board.open) }),
      ...(board?.closed && { closed: room(board.closed) }),
      ...(board?.ruling && { ruling: { kind: board.ruling.kind, team: board.ruling.team, reason: board.ruling.reason } }),
      result,
    })
  }
  return {
    id: m.id,
    hostId: m.hostId,
    createdAt: m.createdAt,
    status: m.status,
    ...(m.startedAt !== undefined && { startedAt: m.startedAt }),
    ...(m.endedAt !== undefined && { endedAt: m.endedAt }),
    settings: m.settings,
    captains: m.captains,
    ...(m.status === 'playing' && m.tables && { tables: m.tables }),
    ...(m.status === 'playing' && m.pausedAt !== undefined && { pausedAt: m.pausedAt }),
    seats: m.seats.map((s) => {
      const user = s.userId === undefined ? undefined : userById(s.userId)
      return {
        room: s.room,
        seat: s.seat,
        team: teamAt(s.room, s.seat),
        status: s.status,
        ...(s.userId !== undefined && { userId: s.userId }),
        ...(user && { user }),
        robot: s.robot,
      }
    }),
    boards,
    totals: score.totals,
    leader: score.leader,
  }
}

/**
 * A team match board as watchers see it when the match plays one trick behind (`e8-t19`, AC-8.8):
 * while it is played, only the tricks before the last finished one are on it, so the watchers
 * never see the trick being played nor the one just finished, and a claim waiting for an answer is
 * not there yet. The hands are what each seat held then (`boardView` works them out from `play`).
 * The bidding and a finished board are as they are: the result is the room's anyway. Done here, on
 * the server, so the browser of someone watching never has the cards played since
 */
export function laggedBoard(board: BoardState): BoardState {
  if (board.phase !== 'play') return board
  const shown = Math.max(0, 4 * (Math.floor(board.play.length / 4) - 1))
  const { claim: _claim, claimed: _claimed, ...rest } = board
  return { ...rest, play: board.play.slice(0, shown) }
}

/**
 * A team match room's board on the Vugraph page (`e8-t18`): what a watcher at the table sees (all
 * four hands, no bidding box), one trick behind when the match says so (`laggedBoard`). Only for
 * someone who does not play in the match; the table checks that (`TableService.vugraph`)
 */
export function vugraphBoard(board: BoardState, delay: boolean): BoardView {
  const { bookTopics: _topics, ...view } = boardView(delay ? laggedBoard(board) : board, null, { undoAllowed: false })
  return view
}

/** The watchers' chat as one member sees it: without the lines of those they blocked (as at a table, `chatFor`) */
export function vugraphChat(
  lines: MatchChatLine[],
  blocked: (authorId: string) => boolean,
  userById: (id: string) => PublicUser | undefined,
): VugraphChatLine[] {
  return lines.flatMap((line) => {
    const user = blocked(line.userId) ? undefined : userById(line.userId)
    return user ? [{ ...line, username: user.username }] : []
  })
}

/**
 * The traveller of the challenge board `boardId` (`e4-t32`, §4): exactly the traveller
 * `challengeView` gives this member for that board (those who played every board, or everyone in
 * it once it ended), with each entry's board result in the challenge's scoring when the matrix is
 * shown. Null when they may not see it. The opening lead and the declarer come from the records,
 * which the caller reads (`ClubService.traveller`), so they are left empty here
 */
export function challengeTraveller(
  challenge: Challenge,
  boardId: string,
  userId: string,
  userById: (id: string) => PublicUser | undefined,
  boards: (boardId: string) => EventBoard | undefined = () => undefined,
): Traveller | null {
  const view = challengeView(challenge, userId, userById, boards)
  const found = view?.travellers?.find((x) => x.entries.some((e) => e.boardId === boardId))
  if (!view || !found) return null
  const ranked = new Map(view.standings?.ranked.map((r) => [r.userId, r.boards]) ?? [])
  return {
    kind: 'challenge',
    eventId: challenge.id,
    seq: found.seq,
    boardNo: found.boardNo,
    scoring: view.standings?.scoring ?? challenge.settings.scoring,
    entries: found.entries.map((e) => {
      const user = userById(e.userId)
      const points = ranked.get(e.userId)?.[found.seq - 1]
      return {
        userId: e.userId,
        ...(user && { user }),
        boardId: e.boardId,
        contract: e.contract,
        declarer: null,
        lead: e.lead ?? null,
        declarerTricks: e.declarerTricks,
        scoreNS: e.scoreNS,
        ...(points !== undefined && { points }),
      }
    }),
  }
}

/**
 * What a practice table's player sees of its settings (§5.11): only their own choices, so nothing
 * of the deal leaves with it. The hands themselves follow the usual rules (`boardView`); a Just
 * Declare board's auction was made by robots and is public like any other. A deal set's boards
 * (`problems`, `e10-t16`) never leave: only the place of the one on the table, its category and
 * title, and its note once the auction is over (what it teaches gives the bidding away). A bidding
 * practice's review (`review`, `e10-t07`: TKB's call at each step, TKB's own auction) only once the
 * board is finished, when all four hands are open to everyone at the table: it was worked out
 * from the hands, so sent any earlier it would tell what the others hold
 */
export function practiceView(table: Pick<Table, 'mode' | 'modeState' | 'board'>): { practice?: TablePractice } {
  if (table.mode !== 'practice') return {}
  const { deal, conditions, robotKind, justDeclare, biddingOnly, seats, set, showHands, dealt, problems, review } =
    table.modeState as PracticeTableState
  const index = problems?.length && dealt > 0 ? (dealt - 1) % problems.length : null
  const problem = index === null ? null : problems![index]
  const bid = !!table.board && table.board.phase !== 'auction'
  const reviewed = biddingOnly && table.board?.phase === 'finished' && review
  return {
    practice: {
      deal,
      ...(conditions && { conditions }),
      robotKind,
      justDeclare,
      ...(biddingOnly && { biddingOnly }),
      ...(seats && { seats }),
      ...(set && { set }),
      ...(showHands && { showHands }),
      dealt,
      ...(problem && {
        problem: {
          seq: index! + 1,
          count: problems!.length,
          ...(problem.category && { category: problem.category }),
          ...(problem.title && { title: problem.title }),
          ...(bid && problem.note && { note: problem.note }),
        },
      }),
      ...(reviewed && { review }),
    },
  }
}
