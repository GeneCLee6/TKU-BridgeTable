import { legalCalls } from '../shared/auction.ts'
import { partnerOf, SEATS, type Seat } from '../shared/cards.ts'
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
import type { BoardSummary, BoardView, ChatMessage, PublicUser, SeatOccupant, TableMode, TableSettings } from '../shared/protocol.ts'
import { isOpenChallenge, type ChallengeTraveller, type ChallengeView } from '../shared/challenge.ts'
import type { DealSource } from '../shared/deal-source.ts'
import { challengeStandings, hasFinished } from './challenge-flow.ts'
import type { Challenge } from './challenges.ts'
import type { Traveller } from '../shared/traveller.ts'
import type { EventBoard } from './history-index.ts'
import { teamAt, type MatchBoardView, type TeamMatchView } from '../shared/team-match.ts'
import { scoreTeamMatch } from '../shared/team-scoring.ts'
import { isMatchPlayer } from './team-match-flow.ts'
import { boardScores, type TeamMatch } from './team-matches.ts'

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
 * The table chat as one viewer sees it (AC-1.6): what members they blocked say is left out, for
 * them only; everyone else still sees it. Unblocking brings the kept messages back
 */
export function chatFor(chat: ChatMessage[], blocked: (authorId: string) => boolean): ChatMessage[] {
  return chat.filter((message) => !blocked(message.userId))
}

export function seatOccupants(
  table: Table,
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
 * Spectators see all four hands, as kibitzers do on BBO. Partners never see each other's alerts
 * until the board is over, except a robot's, which are for everyone (GIB's on BBO are too).
 * `auctionSeat` is where the viewer bid from, if a declarer swap has moved them since.
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
  } = {},
): BoardView {
  const finished = board.phase === 'finished'
  const dummy = dummyOf(board)
  const dummyExposed = dummy !== null && board.play.length > 0
  const declarer = board.contract?.declarer
  const claimed = board.claimed ?? []
  const defender = viewer !== null && viewer !== declarer && viewer !== dummy
  const canSee = (seat: Seat) =>
    finished ||
    viewer === null ||
    seat === viewer ||
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

  const auction = board.auction.map((entry) => {
    if (entry.alert === undefined || entry.robot || finished || viewer === null || viewer !== partnerOf(entry.seat))
      return entry
    const { alert: _hidden, ...rest } = entry
    return rest
  })

  const turn = turnOf(board)
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
    legalCalls:
      viewer && board.phase === 'auction' && turn === viewer
        ? [...legalCalls(board.auction, board.dealer)]
        : [],
    canUndo: !!viewer && extras.undoAllowed !== false && !extras.undo && canUndoFor(board, viewer, extras.auctionSeat ?? viewer),
    canClaim: !!viewer && board.phase === 'play' && viewer !== dummy && !board.claim,
  }

  if (board.claim) {
    view.claim = { ...board.claim, approvers: claimApprovers(board, board.claim.seat) }
  }
  if (extras.undo && !finished) view.undo = extras.undo
  if (extras.rejectedClaim && board.phase === 'play') view.rejectedClaim = extras.rejectedClaim
  if (board.result) view.result = board.result
  if (extras.recordId && finished) view.recordId = extras.recordId
  return view
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
 * went before they play it
 */
export function teamMatchView(
  match: TeamMatch,
  userId: string,
  userById: (id: string) => PublicUser | undefined,
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
    boards.push({
      seq: i + 1,
      ...(board?.open && { open: { boardId: board.open.boardId, scoreNS: board.open.scoreNS } }),
      ...(board?.closed && { closed: { boardId: board.closed.boardId, scoreNS: board.closed.scoreNS } }),
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
        lead: null,
        declarerTricks: e.declarerTricks,
        scoreNS: e.scoreNS,
        ...(points !== undefined && { points }),
      }
    }),
  }
}
