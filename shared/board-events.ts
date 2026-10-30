import type { Call } from './auction.ts'
import type { Card, Seat, Side } from './cards.ts'
import type { PublicUser } from './protocol.ts'
import { RULINGS } from './team-scoring.ts'

/**
 * A board's action log (`e2-t32`, AC-2.14): every call, card, claim, answer to a claim and undo, in
 * the order the server took them, each with the server's clock (`at`, ms). It is append-only: an
 * undo takes nothing out, it is one more event saying how many calls and cards are left. The table
 * keeps it while the board is played (never sent live) and the board's record keeps it. Every
 * event is something all four at the table saw happen, so it shows nothing the record does not
 */
export type BoardEvent =
  | { at: number; type: 'deal' }
  | { at: number; type: 'call'; seat: Seat; call: Call }
  | { at: number; type: 'play'; seat: Seat; card: Card }
  | { at: number; type: 'claim'; seat: Seat; tricks: number }
  | { at: number; type: 'claimAccept' | 'claimReject'; seat: Seat }
  /** An accepted undo (`seat` took back): the calls and cards left after it */
  | { at: number; type: 'undo'; seat: Seat; calls: number; cards: number }

/** When each call and card that stands on the finished board was made (server time, ms) */
export interface ActionTimes {
  calls: number[]
  cards: number[]
}

/**
 * Replays the log: the time of each call and card left at the end (an undo drops the times of what
 * it took back). Null when the log does not match the board (an old record, or a board dealt with
 * its auction made, whose calls were never made at the table)
 */
export function actionTimes(events: readonly BoardEvent[] | undefined, calls: number, cards: number): ActionTimes | null {
  if (!events?.length) return null
  const times: ActionTimes = { calls: [], cards: [] }
  for (const event of events) {
    if (event.type === 'call') times.calls.push(event.at)
    else if (event.type === 'play') times.cards.push(event.at)
    else if (event.type === 'undo') {
      times.calls.length = Math.min(times.calls.length, event.calls)
      times.cards.length = Math.min(times.cards.length, event.cards)
    }
  }
  if (times.cards.length !== cards) return null
  if (times.calls.length !== calls) times.calls = []
  return times
}

/** The longest pause a real-speed replay waits between two cards (a player who stepped away) */
export const REAL_GAP_MAX_MS = 30_000
/** The shortest: cards played at once (a claim's last trick, a robot) still show one by one */
export const REAL_GAP_MIN_MS = 200

/**
 * How long a real-speed replay (`e2-t33`) waits before each card: `gaps[i]` before card i, the
 * time since the card before it (the first card: since the last call, or the deal), kept within
 * REAL_GAP_MIN_MS–REAL_GAP_MAX_MS
 */
export function realGaps(times: ActionTimes, startedAt?: number): number[] {
  return times.cards.map((at, i) => {
    const before = i > 0 ? times.cards[i - 1] : (times.calls.at(-1) ?? startedAt ?? at)
    return Math.min(REAL_GAP_MAX_MS, Math.max(REAL_GAP_MIN_MS, at - before))
  })
}

// ── Rulings (`e2-t35`) ─────────────────────────────────────────────────────────────────────────

export const BOARD_RULINGS = [...RULINGS, 'score'] as const
export type BoardRulingKind = (typeof BOARD_RULINGS)[number]

/**
 * A director's ruling on a finished board (`e2-t35`): Avg, Avg+ or Avg- for one side (the other
 * side gets the opposite), or a score the director gives North-South. The board's own result stays
 * as played; the record and the history show the ruling beside it
 */
export interface BoardRuling {
  kind: BoardRulingKind
  /** Whom Avg+ or Avg- is for; Avg and a score leave it out */
  side?: Side
  /** The score a `score` ruling gives North-South */
  scoreNS?: number
  reason: string
  by: PublicUser
  at: number
}

/** What a ruling asks for, as the director sends it */
export interface RulingRequest {
  kind: BoardRulingKind
  side?: Side
  scoreNS?: number
  reason: string
}

/** The highest score a board can have (7NT redoubled, vulnerable, with every overtrick is far below) */
export const RULING_SCORE_MAX = 7600

/** Reads a ruling request: its kind, the side Avg+/Avg- is for, the score in tens; null when it is not one */
export function parseRulingRequest(value: unknown, reasonOf: (value: unknown) => string | null): RulingRequest | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (!(BOARD_RULINGS as readonly unknown[]).includes(v.kind)) return null
  const kind = v.kind as BoardRulingKind
  const reason = reasonOf(v.reason)
  if (!reason) return null
  if (kind === 'score') {
    const score = v.scoreNS
    if (typeof score !== 'number' || !Number.isInteger(score) || score % 10 !== 0 || Math.abs(score) > RULING_SCORE_MAX) return null
    return { kind, scoreNS: score, reason }
  }
  if (kind === 'avg') return { kind, reason }
  if (v.side !== 'NS' && v.side !== 'EW') return null
  return { kind, side: v.side, reason }
}
