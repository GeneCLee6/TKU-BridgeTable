import type { RandomInt } from '../shared/board.ts'
import type { Hands, Seat } from '../shared/cards.ts'
import { robotAuction } from '../shared/challenge-deals.ts'
import { dealFrom, RANDOM_DEALS } from '../shared/deal-source.ts'
import type { BoardState } from '../shared/game.ts'
import type { BoardRecord, TableMode } from '../shared/protocol.ts'
import { challengeTakesPart } from './challenge-flow.ts'
import type { Challenge, ChallengeStore } from './challenges.ts'
import type { Table } from './views.ts'

export type { TableMode } from '../shared/protocol.ts'

/** What a mode may use besides the table: the club's random numbers, the time and the challenges */
export interface ModeContext {
  random: RandomInt
  now: number
  challenges: ChallengeStore
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
 * The three places where a mode changes what a table does; bidding, play, seating and visibility
 * stay the same in every mode. A new mode that needs a fourth hook has to say why in its PR.
 */
export interface TableModeHooks {
  /** The table's next board, or null when the mode has no more boards to play */
  deal(table: Table, ctx: ModeContext): DealtBoard | null
  /** The record kept for a finished board */
  record(table: Table, record: BoardRecord, ctx: ModeContext): BoardRecord
  /** A board was just finished and its record saved (`record.id` is the board's history id) */
  boardFinished(table: Table, record: BoardRecord, ctx: ModeContext): void
}

/** A table anyone can open: boards are dealt one after another for as long as people play */
const casual: TableModeHooks = {
  deal: (table, ctx) => {
    const boardNo = table.boardsPlayed + 1
    const hands = dealFrom(table.dealSource ?? RANDOM_DEALS, boardNo, ctx.random)
    return hands && { boardNo, hands }
  },
  record: (_table, record) => record,
  boardFinished: () => {},
}

/**
 * A participant's own table for a challenge (`e7-t08`, ARCHITECTURE.md §5.5): what it is playing
 * and where the participant sat when they left it
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

/**
 * One person in the South seat and three robots of the challenge's kind and level. Boards come
 * from the deal set in order, numbered as in the set; each result is written once (the primary key
 * of `challenge_results` turns down a second one). Nothing is dealt or counted once the challenge
 * is closed or past its deadline
 */
const challenge: TableModeHooks = {
  deal: (table, ctx) => {
    const state = challengeStateOf(table)!
    const c = ctx.challenges.get(state.challengeId)
    if (!c || !challengeTakesPart(c, ctx.now)) return null
    const seq = nextSeq(c, state.userId)
    const board = seq === null ? undefined : c.deals.boards[seq - 1]
    const hands = seq === null ? null : dealFrom(table.dealSource!, seq, ctx.random)
    if (!board || !hands) return null
    state.seq = seq!
    const player = c.players.find((p) => p.userId === state.userId)
    if (player && player.startedAt === undefined) ctx.challenges.updatePlayer(c.id, { ...player, startedAt: ctx.now })
    // Just Declare: the robots bid as they did when the challenge was made, and the play starts
    if (board.auction) return { boardNo: board.boardNo, hands, board: robotAuction(c.settings.robotKind, board.boardNo, hands, board.auction) }
    return { boardNo: board.boardNo, hands }
  },
  record: (table, record, ctx) => {
    const state = challengeStateOf(table)!
    const c = ctx.challenges.get(state.challengeId)
    // Kept back until the latest the challenge can end; C5 brings it forward when it really ends
    return { ...record, mode: 'challenge', eventId: state.challengeId, ...(c && { revealAt: c.deadline }) }
  },
  boardFinished: (table, record, ctx) => {
    const state = challengeStateOf(table)!
    const c = ctx.challenges.get(state.challengeId)
    // A board finished after the deadline does not count, like one not played
    if (!c || !challengeTakesPart(c, ctx.now) || state.seq < 1) return
    const player = c.players.find((p) => p.userId === state.userId)
    if (!player) return
    ctx.challenges.transaction(() => {
      ctx.challenges.addResult(c.id, {
        userId: state.userId,
        seq: state.seq,
        boardId: record.id,
        scoreNS: record.board.result?.scoreNS ?? 0,
        playedAt: ctx.now,
      })
      if (playedSeqs(c, state.userId).size + 1 >= c.deals.boards.length)
        ctx.challenges.updatePlayer(c.id, { ...player, finishedAt: ctx.now })
    })
  },
}

const MODES: Record<TableMode, TableModeHooks> = { casual, challenge }

/** Tables saved before modes existed are casual */
export function modeOf(table: Table): TableModeHooks {
  return MODES[table.mode ?? 'casual']
}
