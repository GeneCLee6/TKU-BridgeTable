import type { DealSet } from '../shared/deal-set.ts'
import { individual, INDIVIDUAL_PLAYERS, INDIVIDUAL_SIZES, mitchell, MOVEMENT_PAIRS, type Movement, type MovementTable } from '../shared/movement.ts'
import type { PairsResult, PairsSettings, PairsStatus } from '../shared/pairs.ts'
import type { ScoreRuling } from '../shared/ruling-scoring.ts'
import { ClubError } from './errors.ts'

/**
 * One pairs event's state and how it changes (`e9-t10`–`e9-t12`, ARCHITECTURE.md §5.22). Every
 * change is a `PairsStep` run by `applyPairsStep`, a pure function on the event: the club runs it
 * on its copy first (with what only it knows checked before: members, blocks, who is online), then
 * the event runs it again where it lives (its own `EventObject` with `EVENT_OBJECTS=on`, else the
 * club's storage) and that answer is the event. No Cloudflare API, no notification, no table: the
 * club does those from the answer (`worker/pairs-service.ts`).
 */

export interface PairsPair {
  /**
   * Two member ids; the first sits North (or East). An individual event (`e9-t15`): one, every
   * entry is a player (the movement says where they sit each round)
   */
  players: [string, string] | [string]
  /** When the pair entered */
  at: number
}

export interface PairsEvent {
  id: string
  directorId: string
  createdAt: number
  status: PairsStatus
  settings: PairsSettings
  /** An individual event (`e9-t15`): members enter alone and change partner every round; absent for pairs */
  format?: 'individual'
  /** In the order they entered; from the start this order is the movement's (`pairPlace`) */
  pairs: PairsPair[]
  /** From the start */
  movement?: Movement
  deals?: DealSet
  startedAt?: number
  /** The round being played, 1-based (0 before the start) */
  round: number
  /** The tables of each round: `roundTables[round - 1][table - 1]`, '' for a table that sits out */
  roundTables: string[][]
  results: PairsResult[]
  finishedAt?: number
}

/** A change the club asks of an event; structured-clonable, so it crosses Durable Object RPC */
export type PairsStep =
  | { kind: 'enter'; players: [string, string] | [string]; at: number }
  | { kind: 'withdraw'; userId: string; by: string }
  | { kind: 'cancel'; userId: string; at: number }
  | { kind: 'start'; userId: string; deals: DealSet; tables: string[]; at: number }
  | { kind: 'result'; result: PairsResult }
  | { kind: 'round'; round: number; tables: string[] }
  /**
   * The director's tools (`e9-t17`): a score for a board of the round a table has not played
   * (`null` takes back one given so), and a table of the round re-opened as `tableId` with the
   * boards in `replay` (played there) to play again
   */
  | { kind: 'assign'; round: number; table: number; boardNo: number; ruling: ScoreRuling | null; at: number }
  | { kind: 'retable'; round: number; table: number; tableId: string; replay: number[] }

export const pairOf = (event: PairsEvent, userId: string): number => event.pairs.findIndex((p) => p.players.includes(userId))

/** Everyone in a pair of the event */
export const pairsPlayers = (event: PairsEvent): string[] => event.pairs.flatMap((p) => p.players)

/** The movement for `entries` entries: a Mitchell for pairs, the individual movement (`e9-t15`) for players */
export const movementFor = (format: PairsEvent['format'], entries: number, boardsPerRound: number): Movement | null =>
  format === 'individual' ? individual(entries, boardsPerRound) : mitchell(entries, boardsPerRound)

/** The event's movement for its pairs now (before the start: what it would be) */
export const movementOf = (event: PairsEvent): Movement | null =>
  event.movement ?? movementFor(event.format, event.pairs.length, event.settings.boardsPerRound)

/** Most entries an event takes: 20 pairs, or 20 players in an individual event */
export const entriesMax = (event: Pick<PairsEvent, 'format'>) =>
  event.format === 'individual' ? INDIVIDUAL_PLAYERS.max : MOVEMENT_PAIRS.max

/** The error for a number of entries the movement cannot take */
export function movementRefused(event: PairsEvent): ClubError {
  if (event.format === 'individual') return new ClubError('individualSize', { sizes: INDIVIDUAL_SIZES.join('/') })
  return new ClubError(event.pairs.length < MOVEMENT_PAIRS.min ? 'pairsTooFew' : 'pairsFull', { min: MOVEMENT_PAIRS.min, max: MOVEMENT_PAIRS.max })
}

/**
 * Who sits where at a table of the movement: the NS pair North and South and the EW pair East and
 * West (each pair's first player North or East); an individual event's players by its seats
 */
export function seatsOf(event: PairsEvent, table: MovementTable): { ns: [string, string]; ew: [string, string] } {
  const player = (entry: number) => event.pairs[entry].players[0]
  if (table.seats) {
    const [n, s, e, w] = table.seats
    return { ns: [player(n), player(s)], ew: [player(e), player(w)] }
  }
  return { ns: event.pairs[table.ns].players as [string, string], ew: event.pairs[table.ew].players as [string, string] }
}

/** Whether every table of the round finished every board it plays */
export function roundDone(event: PairsEvent, round: number): boolean {
  const schedule = event.movement?.schedule[round - 1]
  if (!schedule) return false
  return schedule.tables.every((t) =>
    t.boards.every((boardNo) => event.results.some((r) => r.round === round && r.table === t.table && r.boardNo === boardNo)),
  )
}

/** The round is done and another one follows: the club opens its tables (`round`) */
export const nextRoundDue = (event: PairsEvent): boolean =>
  event.status === 'playing' && !!event.movement && event.round < event.movement.rounds && roundDone(event, event.round) &&
  event.roundTables.length === event.round

function director(event: PairsEvent, userId: string) {
  if (event.directorId !== userId) throw new ClubError('pairsDirectorOnly', {}, 403)
}

function open(event: PairsEvent) {
  if (event.status !== 'open') throw new ClubError('pairsNotOpen')
}

/** The last board of the last round finishes the event */
function finishIfDone(event: PairsEvent, at: number) {
  if (event.movement && event.round === event.movement.rounds && roundDone(event, event.round)) {
    event.status = 'finished'
    event.finishedAt = at
  }
}

/** The boards of a table of the round with no result yet, in order */
export function boardsLeft(event: PairsEvent, round: number, table: number): number[] {
  const t = event.movement?.schedule[round - 1]?.tables.find((x) => x.table === table)
  if (!t) return []
  return t.boards.filter((b) => !event.results.some((r) => r.round === round && r.table === table && r.boardNo === b))
}

/**
 * Runs one step on the event (in place) or throws the `ClubError` that refuses it. A result or a
 * round already there is no change (a resend), so the same step twice changes nothing
 */
export function applyPairsStep(event: PairsEvent, step: PairsStep): void {
  switch (step.kind) {
    case 'enter': {
      open(event)
      // A pair enters two players; an individual event one (`e9-t15`)
      if (step.players.length !== (event.format === 'individual' ? 1 : 2)) throw new ClubError('unknownCommand')
      for (const userId of step.players)
        if (pairOf(event, userId) >= 0) throw new ClubError('pairsInPair', { name: userId })
      if (event.pairs.length >= entriesMax(event))
        throw new ClubError(event.format === 'individual' ? 'individualFull' : 'pairsFull', { max: entriesMax(event) })
      event.pairs.push({ players: step.players, at: step.at })
      return
    }
    case 'withdraw': {
      open(event)
      const pair = pairOf(event, step.userId)
      if (pair < 0) throw new ClubError('pairsGone', {}, 404)
      if (!event.pairs[pair].players.includes(step.by)) director(event, step.by)
      event.pairs.splice(pair, 1)
      return
    }
    case 'cancel':
      director(event, step.userId)
      open(event)
      event.status = 'cancelled'
      event.finishedAt = step.at
      return
    case 'start': {
      director(event, step.userId)
      open(event)
      const movement = movementFor(event.format, event.pairs.length, event.settings.boardsPerRound)
      if (!movement) throw movementRefused(event)
      if (step.deals.boards.length !== movement.boards || step.tables.length !== movement.tables)
        throw new ClubError('serverError', {}, 500)
      event.status = 'playing'
      event.movement = movement
      event.deals = step.deals
      event.startedAt = step.at
      event.round = 1
      event.roundTables = [step.tables]
      return
    }
    case 'result': {
      const r = step.result
      if (event.status !== 'playing' || !event.movement) throw new ClubError('pairsNotPlaying')
      if (event.results.some((o) => o.round === r.round && o.table === r.table && o.boardNo === r.boardNo)) return
      const table = event.movement.schedule[r.round - 1]?.tables.find((t) => t.table === r.table)
      if (r.round !== event.round || !table || !table.boards.includes(r.boardNo) || table.ns !== r.ns || table.ew !== r.ew)
        throw new ClubError('pairsNotPlaying')
      event.results.push({ ...r })
      finishIfDone(event, r.playedAt)
      return
    }
    case 'assign': {
      if (!event.movement || (event.status !== 'playing' && event.status !== 'finished')) throw new ClubError('pairsNotPlaying')
      const table = event.movement.schedule[step.round - 1]?.tables.find((t) => t.table === step.table)
      if (!table || !table.boards.includes(step.boardNo) || step.round > event.round) throw new ClubError('refereeNoBoard', {}, 404)
      const at = event.results.findIndex((o) => o.round === step.round && o.table === step.table && o.boardNo === step.boardNo)
      const found = at >= 0 ? event.results[at] : undefined
      // A board played there is ruled on its record (`e2-t35`), not here
      if (found?.boardId) throw new ClubError('refereePlayed')
      if (step.ruling === null) {
        // Only while its round is on: an earlier round moved on because the board had a result
        if (!found) return
        if (event.status !== 'playing' || step.round !== event.round) throw new ClubError('refereeRoundOver')
        event.results.splice(at, 1)
        return
      }
      const result: PairsResult = {
        round: step.round,
        table: step.table,
        boardNo: step.boardNo,
        ns: table.ns,
        ew: table.ew,
        boardId: '',
        scoreNS: step.ruling.kind === 'score' ? (step.ruling.scoreNS ?? 0) : 0,
        contract: null,
        declarerTricks: null,
        playedAt: step.at,
        ruling: step.ruling,
      }
      if (found) event.results[at] = result
      else {
        if (event.status !== 'playing') throw new ClubError('pairsNotPlaying')
        event.results.push(result)
        finishIfDone(event, step.at)
      }
      return
    }
    case 'retable': {
      if (event.status !== 'playing' || !event.movement) throw new ClubError('pairsNotPlaying')
      if (step.round !== event.round) throw new ClubError('refereeRoundOver')
      const table = event.movement.schedule[step.round - 1]?.tables.find((t) => t.table === step.table)
      if (!table) throw new ClubError('refereeNoBoard', {}, 404)
      // Re-opened already (a resend)
      if (event.roundTables[step.round - 1]?.[step.table - 1] === step.tableId) return
      if (!step.replay.every((b) => table.boards.includes(b))) throw new ClubError('refereeNoBoard', {}, 404)
      event.results = event.results.filter(
        (r) => !(r.round === step.round && r.table === step.table && step.replay.includes(r.boardNo)),
      )
      event.roundTables = event.roundTables.map((tables, i) =>
        i === step.round - 1 ? tables.map((id, t) => (t === step.table - 1 ? step.tableId : id)) : tables,
      )
      return
    }
    case 'round': {
      if (event.status !== 'playing' || !event.movement) throw new ClubError('pairsNotPlaying')
      // Opened already (a resend, or another call got there first): nothing changes
      if (event.round >= step.round) return
      if (step.round !== event.round + 1 || !roundDone(event, event.round) || step.tables.length !== event.movement.tables)
        throw new ClubError('pairsNotPlaying')
      event.round = step.round
      event.roundTables = [...event.roundTables, step.tables]
      return
    }
  }
}
