import type { DealSet } from '../shared/deal-set.ts'
import { mitchell, MOVEMENT_PAIRS, type Movement } from '../shared/movement.ts'
import type { PairsResult, PairsSettings, PairsStatus } from '../shared/pairs.ts'
import { ClubError } from './errors.ts'

/**
 * One pairs event's state and how it changes (`e9-t10`–`e9-t12`, ARCHITECTURE.md §5.20). Every
 * change is a `PairsStep` run by `applyPairsStep`, a pure function on the event: the club runs it
 * on its copy first (with what only it knows checked before: members, blocks, who is online), then
 * the event runs it again where it lives (its own `EventObject` with `EVENT_OBJECTS=on`, else the
 * club's storage) and that answer is the event. No Cloudflare API, no notification, no table: the
 * club does those from the answer (`worker/pairs-service.ts`).
 */

export interface PairsPair {
  /** Two member ids; the first sits North (or East) */
  players: [string, string]
  /** When the pair entered */
  at: number
}

export interface PairsEvent {
  id: string
  directorId: string
  createdAt: number
  status: PairsStatus
  settings: PairsSettings
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
  | { kind: 'enter'; players: [string, string]; at: number }
  | { kind: 'withdraw'; userId: string; by: string }
  | { kind: 'cancel'; userId: string; at: number }
  | { kind: 'start'; userId: string; deals: DealSet; tables: string[]; at: number }
  | { kind: 'result'; result: PairsResult }
  | { kind: 'round'; round: number; tables: string[] }

export const pairOf = (event: PairsEvent, userId: string): number => event.pairs.findIndex((p) => p.players.includes(userId))

/** Everyone in a pair of the event */
export const pairsPlayers = (event: PairsEvent): string[] => event.pairs.flatMap((p) => p.players)

/** The event's movement for its pairs now (before the start: what it would be) */
export const movementOf = (event: PairsEvent): Movement | null =>
  event.movement ?? mitchell(event.pairs.length, event.settings.boardsPerRound)

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

/**
 * Runs one step on the event (in place) or throws the `ClubError` that refuses it. A result or a
 * round already there is no change (a resend), so the same step twice changes nothing
 */
export function applyPairsStep(event: PairsEvent, step: PairsStep): void {
  switch (step.kind) {
    case 'enter': {
      open(event)
      for (const userId of step.players)
        if (pairOf(event, userId) >= 0) throw new ClubError('pairsInPair', { name: userId })
      if (event.pairs.length >= MOVEMENT_PAIRS.max) throw new ClubError('pairsFull', { max: MOVEMENT_PAIRS.max })
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
      const movement = mitchell(event.pairs.length, event.settings.boardsPerRound)
      if (!movement) throw new ClubError('pairsTooFew', { min: MOVEMENT_PAIRS.min })
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
      // The last board of the last round finishes the event
      if (event.round === event.movement.rounds && roundDone(event, event.round)) {
        event.status = 'finished'
        event.finishedAt = r.playedAt
      }
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
