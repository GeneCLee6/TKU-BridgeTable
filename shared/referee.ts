import { parseRulingRequest, type RulingRequest } from './board-events.ts'
import type { PublicUser } from './protocol.ts'
import type { ScoreRuling } from './ruling-scoring.ts'
import { parseRulingReason, TEAM_MATCH_LIMITS } from './team-match.ts'

/**
 * The tournament director's tools (裁判工具, `e9-t17`, AC-9.8, ARCHITECTURE.md §5.23): what a
 * director of a club event did — a board's score adjusted, a penalty to a pair, team or
 * participant, the start delayed, a table re-opened — kept as a log per event. Every entry says
 * who, when, what and why; nothing is ever edited or deleted (a penalty is taken back with a
 * `withdraw` entry), so the result page shows the whole story. Pure: the log lives in the club
 * (`worker/referee.ts`), the scoring reads the penalties from it whenever a page is shown.
 */

/** The events a director works on: pairs events, team matches, challenges (the daily event is one) */
export const REFEREE_EVENTS = ['pairs', 'match', 'challenge'] as const
export type RefereeEvent = (typeof REFEREE_EVENTS)[number]
export const isRefereeEvent = (value: unknown): value is RefereeEvent => REFEREE_EVENTS.includes(value as RefereeEvent)

export const REFEREE_LIMITS = {
  reasonMax: TEAM_MATCH_LIMITS.reasonMax,
  /** The largest penalty, in the event's unit (MP, IMPs or BAM points, a challenge's unit) */
  penaltyMax: 1000,
  /** How far the start may be put off at a time */
  delayMinutesMax: 240,
  /** Entries kept per event: a director does not need more, and the log stays one small value */
  entriesMax: 200,
} as const

/** What one entry did */
export type RefereeAction =
  /**
   * A board's score adjusted: on a board record (`boardId`, the `e2-t35` ruling, `null` taking it
   * back), or on a pairs board that was never played (`round`, `table`, `boardNo`)
   */
  | { action: 'score'; ruling: ScoreRuling | null; boardId?: string; round?: number; table?: number; boardNo?: number }
  /**
   * A penalty: `target` is a pair's index (pairs), a team ('A' or 'B', team matches) or a
   * participant's id (challenges); `amount` in the event's unit, taken off its total
   */
  | { action: 'penalty'; target: string; amount: number }
  /** The start put off until `until`; `null` lifts the delay */
  | { action: 'delay'; until: number | null }
  /** A table of the round re-opened (pairs): the board on it starts again, `replay` are boards played there to play again */
  | { action: 'restart'; round: number; table: number; replay: number[] }
  /** An earlier penalty taken back */
  | { action: 'withdraw'; of: string }

export type RefereeEntry = RefereeAction & {
  id: string
  at: number
  /** The director's member id */
  by: string
  reason: string
}

/** An entry as the result page shows it (`worker/views.ts` decides which) */
export type RefereeNote = RefereeAction & {
  id: string
  at: number
  by: PublicUser
  reason: string
  /** A penalty taken back later */
  withdrawn?: boolean
}

/** What a director asks for (`POST /api/referee/:kind/:id`) */
export type RefereeRequest =
  | { action: 'score'; boardId: string; ruling: RulingRequest | null }
  | { action: 'score'; round?: number; table: number; boardNo: number; ruling: RulingRequest | null }
  | { action: 'penalty'; target: string; amount: number; reason: string }
  | { action: 'delay'; minutes: number; reason: string }
  | { action: 'restart'; table: number; replay: number[]; reason: string }
  | { action: 'withdraw'; of: string; reason: string }

const positiveInt = (value: unknown, max = 1000): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max

/** Reads a director's request; null when it is not one (the club answers `badReferee`) */
export function parseRefereeRequest(value: unknown): RefereeRequest | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  switch (v.action) {
    case 'score': {
      const ruling = v.ruling === null ? null : parseRulingRequest(v.ruling, parseRulingReason)
      if (ruling === null && v.ruling !== null) return null
      if (typeof v.boardId === 'string') return /^[\w-]{1,40}$/.test(v.boardId) ? { action: 'score', boardId: v.boardId, ruling } : null
      if (!positiveInt(v.table) || !positiveInt(v.boardNo)) return null
      if (v.round !== undefined && !positiveInt(v.round)) return null
      return { action: 'score', ...(v.round !== undefined && { round: v.round as number }), table: v.table, boardNo: v.boardNo, ruling }
    }
    case 'penalty': {
      const reason = parseRulingReason(v.reason)
      const amount = typeof v.amount === 'number' ? Math.round(v.amount * 10) / 10 : NaN
      if (!reason || typeof v.target !== 'string' || !/^[\w-]{1,40}$/.test(v.target)) return null
      if (!Number.isFinite(amount) || amount <= 0 || amount > REFEREE_LIMITS.penaltyMax) return null
      return { action: 'penalty', target: v.target, amount, reason }
    }
    case 'delay': {
      const reason = parseRulingReason(v.reason)
      const minutes = v.minutes
      if (!reason || typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 0 || minutes > REFEREE_LIMITS.delayMinutesMax)
        return null
      return { action: 'delay', minutes, reason }
    }
    case 'restart': {
      const reason = parseRulingReason(v.reason)
      const replay = v.replay ?? []
      if (!reason || !positiveInt(v.table) || !Array.isArray(replay) || replay.length > 32 || !replay.every((b) => positiveInt(b)))
        return null
      return { action: 'restart', table: v.table, replay: [...new Set(replay as number[])], reason }
    }
    case 'withdraw': {
      const reason = parseRulingReason(v.reason)
      if (!reason || typeof v.of !== 'string' || !/^[\w-]{1,40}$/.test(v.of)) return null
      return { action: 'withdraw', of: v.of, reason }
    }
    default:
      return null
  }
}

const withdrawnIds = (entries: readonly RefereeEntry[]) =>
  new Set(entries.flatMap((e) => (e.action === 'withdraw' ? [e.of] : [])))

/** The penalties in force, added up by target (a pair's index, a team, a participant) */
export function penaltiesOf(entries: readonly RefereeEntry[] | undefined): Map<string, number> {
  const totals = new Map<string, number>()
  if (!entries?.length) return totals
  const withdrawn = withdrawnIds(entries)
  for (const e of entries)
    if (e.action === 'penalty' && !withdrawn.has(e.id)) totals.set(e.target, Math.round(((totals.get(e.target) ?? 0) + e.amount) * 10) / 10)
  return totals
}

/** Until when the start is put off (the latest delay), or null */
export function delayOf(entries: readonly RefereeEntry[] | undefined): number | null {
  const last = entries?.findLast((e) => e.action === 'delay')
  return last?.action === 'delay' ? last.until : null
}

/** The entries as notes for the page, each with the director's name and whether it was taken back */
export function refereeNotes(
  entries: readonly RefereeEntry[] | undefined,
  userById: (id: string) => PublicUser | null | undefined,
  shown: (entry: RefereeEntry) => boolean = () => true,
): RefereeNote[] {
  if (!entries?.length) return []
  const withdrawn = withdrawnIds(entries)
  return entries.filter(shown).map(({ by, ...rest }) => ({
    ...rest,
    by: userById(by) ?? { id: by, username: '' },
    ...(rest.action === 'penalty' && withdrawn.has(rest.id) && { withdrawn: true }),
  }))
}

/**
 * A match's score with the director's penalties (`e9-t17`) off each team's total, and who leads
 * then; the boards' own results stay as they are
 */
export function penalizedMatch<S extends { totals: Record<'A' | 'B', number>; leader: 'A' | 'B' | null }>(
  score: S,
  penalties: ReadonlyMap<string, number>,
): S & { penalties?: Partial<Record<'A' | 'B', number>> } {
  const A = penalties.get('A') ?? 0
  const B = penalties.get('B') ?? 0
  if (!A && !B) return score
  const totals = { A: score.totals.A - A, B: score.totals.B - B }
  const margin = totals.A - totals.B
  return {
    ...score,
    totals,
    leader: Math.abs(margin) < 1e-9 ? null : margin > 0 ? 'A' : 'B',
    penalties: { ...(A && { A }), ...(B && { B }) },
  }
}
