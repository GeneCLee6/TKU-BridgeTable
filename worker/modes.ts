import type { RandomInt } from '../shared/board.ts'
import type { Call } from '../shared/auction.ts'
import type { Hands, Seat } from '../shared/cards.ts'
import { deal } from '../shared/board.ts'
import { JUST_DECLARE_TRIES, northSouthDeclares, robotAuction } from '../shared/challenge-deals.ts'
import { dealFrom, RANDOM_DEALS } from '../shared/deal-source.ts'
import { dealWith } from '../shared/dealer.ts'
import {
  PRACTICE_MAX_ATTEMPTS,
  practiceBoardNo,
  practiceConditions,
  quickRandom,
  type PracticeSettings,
} from '../shared/practice.ts'
import type { BoardState } from '../shared/game.ts'
import type { BoardRecord, RobotKind, TableMode } from '../shared/protocol.ts'
import type { Room } from '../shared/team-match.ts'
import { challengeTakesPart } from './challenge-flow.ts'
import type { Challenge, ChallengeResult } from './challenges.ts'
import { teamMode } from './team-mode.ts'
import type { RoomResult } from './team-matches.ts'
import type { Table } from './views.ts'

export type { TableMode } from '../shared/protocol.ts'

/**
 * What a mode may use besides the table: the random numbers and the time. A table runs on its
 * own (ARCHITECTURE.md §5.10): everything a mode needs of its event is in the table's
 * `modeState`, so no hook reads the club's data
 */
export interface ModeContext {
  random: RandomInt
  now: number
}

/** The next board of a table: its number (dealer and vulnerability follow it) and the hands */
export interface DealtBoard {
  boardNo: number
  hands: Hands
  /**
   * The board to start from instead of a fresh one: a Just Declare challenge board (`e7-t11`)
   * comes with the robots' auction already made, so its participant takes over at the play
   */
  board?: BoardState
}

/**
 * What a finished board means for the event its table belongs to; the club writes it
 * (`ClubLink.boardFinished`). `result` is null when the board does not count (played after the deadline)
 */
export type EventReport =
  | { kind: 'challenge'; challengeId: string; result: ChallengeResult | null }
  /** A team match room's board (§5.8): `seq` is its place in the match; null when it does not count (the match ended) */
  | { kind: 'team'; matchId: string; room: Room; seq: number; result: RoomResult | null }

/**
 * The three places where a mode changes what a table does; bidding, play, seating and visibility
 * stay the same in every mode. A new mode that needs a fourth hook has to say why in its PR.
 */
export interface TableModeHooks {
  /** The table's next board, or null when the mode has no more boards to play */
  deal(table: Table, ctx: ModeContext): DealtBoard | null
  /** The record kept for a finished board */
  record(table: Table, record: BoardRecord, ctx: ModeContext): BoardRecord
  /**
   * A board was just finished and its record made (`record.id` is the board's history id): what
   * the table's event has to write, or null for a table that belongs to none
   */
  boardFinished(table: Table, record: BoardRecord, ctx: ModeContext): EventReport | null
}

/** A table anyone can open: boards are dealt one after another for as long as people play */
const casual: TableModeHooks = {
  deal: (table, ctx) => {
    const boardNo = table.boardsPlayed + 1
    const hands = dealFrom(table.dealSource ?? RANDOM_DEALS, boardNo, ctx.random)
    return hands && { boardNo, hands }
  },
  record: (_table, record) => record,
  boardFinished: () => null,
}

/**
 * A participant's own table for a challenge (`e7-t08`, ARCHITECTURE.md §5.5): what it is playing
 * and where the participant sat when they left it, with what the table needs of the challenge to
 * run on its own (§5.10). The club gives it when the table opens and tells it when the challenge ends
 */
export interface ChallengeTableState {
  challengeId: string
  userId: string
  /** The board on the table: its place in the deal set, 1-based (0 before the first) */
  seq: number
  /**
   * The participant's seat while they are away (they left the page or opened another table): the
   * table waits, parked, until `playChallenge` seats them there again
   */
  parkedSeat?: Seat
  /** The challenge's deadline: play stops there */
  deadline: number
  /** Each board of the set: its number, and the robots' auction for Just Declare (the hands are in `Table.dealSource`) */
  boards: { boardNo: number; auction?: Call[] }[]
  /** The places in the deal set the participant has a result for */
  played: number[]
  /** The robots' system */
  robotKind: RobotKind
  /** The challenge ended (finished, expired or cancelled): nothing more is played */
  closed?: boolean
}

export const challengeStateOf = (table: Table): ChallengeTableState | null =>
  table.mode === 'challenge' ? (table.modeState as ChallengeTableState) : null

/** The places in the deal set the participant has a result for */
export const playedSeqs = (challenge: Challenge, userId: string) =>
  new Set(challenge.results.filter((r) => r.userId === userId).map((r) => r.seq))

/** The first board of the set the participant has not played, or null when they played them all */
export function nextSeq(challenge: Challenge, userId: string): number | null {
  const played = playedSeqs(challenge, userId)
  for (let seq = 1; seq <= challenge.deals.boards.length; seq++) if (!played.has(seq)) return seq
  return null
}

/** The same as `nextSeq`, from what the table knows */
export function nextTableSeq(state: ChallengeTableState): number | null {
  for (let seq = 1; seq <= state.boards.length; seq++) if (!state.played.includes(seq)) return seq
  return null
}

/** Whether a challenge table still takes play: the challenge is open and its deadline not reached */
export const challengeTableOpen = (state: ChallengeTableState, now: number) => !state.closed && now < state.deadline

/** What a challenge table needs of its challenge (§5.10), for one participant */
export function challengeSnapshot(
  challenge: Challenge,
  userId: string,
  now: number,
): Pick<ChallengeTableState, 'deadline' | 'boards' | 'played' | 'robotKind' | 'closed'> {
  return {
    deadline: challenge.deadline,
    boards: challenge.deals.boards.map(({ boardNo, auction }) => ({ boardNo, ...(auction && { auction }) })),
    played: [...playedSeqs(challenge, userId)].sort((a, b) => a - b),
    robotKind: challenge.settings.robotKind,
    ...(!challengeTakesPart(challenge, now) && { closed: true }),
  }
}

/**
 * One person in the South seat and three robots of the challenge's kind. Boards come from the
 * deal set in order, numbered as in the set; each result is written once (the club skips a second
 * one). Nothing is dealt or counted once the challenge is closed or past its deadline
 */
const challenge: TableModeHooks = {
  deal: (table, ctx) => {
    const state = challengeStateOf(table)!
    if (!challengeTableOpen(state, ctx.now)) return null
    const seq = nextTableSeq(state)
    const board = seq === null ? undefined : state.boards[seq - 1]
    const hands = seq === null ? null : dealFrom(table.dealSource!, seq, ctx.random)
    if (!board || !hands) return null
    state.seq = seq!
    // Just Declare: the robots bid as they did when the challenge was made, and the play starts
    if (board.auction)
      return { boardNo: board.boardNo, hands, board: robotAuction(state.robotKind, board.boardNo, hands, board.auction) }
    return { boardNo: board.boardNo, hands }
  },
  record: (table, record) => {
    const state = challengeStateOf(table)!
    // Kept back until the latest the challenge can end; C5 brings it forward when it really ends
    return { ...record, mode: 'challenge', eventId: state.challengeId, revealAt: state.deadline }
  },
  boardFinished: (table, record, ctx) => {
    const state = challengeStateOf(table)!
    const report: EventReport = { kind: 'challenge', challengeId: state.challengeId, result: null }
    // A board finished after the deadline does not count, like one not played
    if (!challengeTableOpen(state, ctx.now) || state.seq < 1 || state.played.includes(state.seq)) return report
    state.played = [...state.played, state.seq].sort((a, b) => a - b)
    report.result = {
      userId: state.userId,
      seq: state.seq,
      boardId: record.id,
      scoreNS: record.board.result?.scoreNS ?? 0,
      playedAt: ctx.now,
    }
    return report
  },
}

/** A practice table's settings and how many boards it has dealt (§5.11) */
export interface PracticeTableState extends PracticeSettings {
  dealt: number
  /**
   * The deal set's boards (`deal: 'set'`, `e10-t16`), dealt in turn and round again: kept on the
   * server like a challenge's deal set; `practiceView` sends only the place, the category and, once
   * the auction is over, the note of the board on the table
   */
  problems?: PracticeTableProblem[]
}

/** A board of a practice table's deal set */
export interface PracticeTableProblem {
  boardNo: number
  hands: Hands
  category?: string
  /** A featured board's title */
  title?: string
  /** What it teaches: a practice set's note, a featured board's explanation */
  note?: string
}

/** The deal set's board on the table and its place (0-based), if the table deals a set */
export function currentProblem(state: PracticeTableState): { problem: PracticeTableProblem; index: number } | null {
  const problems = state.problems
  if (!problems?.length || state.dealt === 0) return null
  const index = (state.dealt - 1) % problems.length
  return { problem: problems[index], index }
}

export const practiceStateOf = (table: Table): PracticeTableState | null =>
  table.mode === 'practice' ? (table.modeState as PracticeTableState) : null

/**
 * Whether the table only bids its boards (a bidding practice, `e10-t15`): the end of the auction
 * ends the board (`endBidding`), nothing is recorded, and the next board comes only when asked for
 */
export const biddingOnly = (table: Table): boolean => !!practiceStateOf(table)?.biddingOnly

/**
 * The next practice board (`e10-t03`, `e10-t05`): any deal, or one meeting the conditions, null
 * when the conditions cannot be met in PRACTICE_MAX_ATTEMPTS. For Just Declare the robots bid it
 * (all four seats, as for a Just Declare challenge board) and a deal North-South does not declare
 * is dealt again, up to JUST_DECLARE_TRIES. Should none come out, the table never stops: the first
 * one with a contract is played (defending), or else the last deal is bid by the member as usual
 */
export function practiceBoard(state: PracticeSettings, boardNo: number, random: RandomInt): DealtBoard | null {
  const conditions = practiceConditions(state)
  const quick = quickRandom(random)
  let contested: DealtBoard | null = null
  let last: DealtBoard | null = null
  for (let tries = 0; tries < (state.justDeclare ? JUST_DECLARE_TRIES : 1); tries++) {
    const dealt = conditions ? dealWith(conditions, quick, PRACTICE_MAX_ATTEMPTS) : { ok: true as const, hands: deal(random) }
    if (!dealt.ok) break
    last = { boardNo, hands: dealt.hands }
    if (!state.justDeclare) return last
    const board = robotAuction(state.robotKind, boardNo, dealt.hands)
    if (northSouthDeclares(board)) return { ...last, board }
    if (board.phase === 'play') contested ??= { ...last, board }
  }
  return contested ?? last
}

/**
 * A member's own table with three robots (§5.11): boards to the member's conditions, numbered so
 * South deals when there are conditions; records marked `practice`, which keeps them out of the
 * club's history list unless asked for
 */
const practice: TableModeHooks = {
  deal: (table, ctx) => {
    const state = practiceStateOf(table)!
    // A deal set's boards one after the other, as they are
    if (state.problems?.length) {
      const problem = state.problems[state.dealt % state.problems.length]
      state.dealt++
      return { boardNo: problem.boardNo, hands: structuredClone(problem.hands) }
    }
    const dealt = practiceBoard(state, practiceBoardNo(state, state.dealt), ctx.random)
    if (dealt) state.dealt++
    return dealt
  },
  record: (_table, record) => ({ ...record, mode: 'practice' }),
  boardFinished: () => null,
}

const MODES: Record<TableMode, TableModeHooks> = { casual, challenge, practice, team: teamMode }

/** Tables saved before modes existed are casual */
export function modeOf(table: Table): TableModeHooks {
  return MODES[table.mode ?? 'casual']
}
