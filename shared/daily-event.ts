import type { ChallengeStatus, ChallengeView } from './challenge.ts'
import { isRobotKind, type RobotKind } from './protocol.ts'
import { TAIWAN_OFFSET_MS } from './weekly-challenge.ts'

/**
 * The daily club event (`e9-t02`, `e9-t03`, ARCHITECTURE.md §5.17): every day at 00:00 Taiwan time
 * the club creates a challenge of 8 boards scored in matchpoints and invites every member; it ends
 * at the next midnight. It is a challenge (`settings.daily`), so playing, standings and the results
 * page are the challenge's. An admin turns it on and picks the robots' system; it is off by
 * default (a small club does not fill a daily event).
 */

/** Fixed by AC-9.1: 8 boards, matchpoints, one day */
export const DAILY_BOARDS = 8
export const DAILY_DAYS = 1

export interface DailyEventSettings {
  enabled: boolean
  robotKind: RobotKind
}

/** Off until an admin turns it on; 2/1 like the weekly one (the club's system is private, 社長 2026-10-26) */
export const DEFAULT_DAILY_SETTINGS: DailyEventSettings = { enabled: false, robotKind: 'gib' }

/** One past day in the history list */
export interface DailyEventEntry {
  /** The Taiwan date, YYYY-MM-DD */
  day: string
  challengeId: string
  status: ChallengeStatus
  /** Members who played every board */
  finished: number
}

/** What the daily page shows (`GET /api/daily`); the challenges as the member may see them (§4) */
export interface DailyEventView {
  settings: DailyEventSettings
  /** When the next one is created; null while it is off */
  next: number | null
  /** Today's event, null when there is none or the member is not in it (joined after midnight) */
  today: ChallengeView | null
  yesterday: ChallengeView | null
  /** Earlier days, newest first, at most `DAILY_HISTORY` */
  history: DailyEventEntry[]
}

export const DAILY_HISTORY = 30

const DAY_MS = 86_400_000

/** Checks what an admin sent: both fields optional, nothing else allowed */
export function parseDailySettings(
  value: unknown,
  current: DailyEventSettings = DEFAULT_DAILY_SETTINGS,
): { settings: DailyEventSettings } | { field: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { field: 'settings' }
  const { enabled, robotKind, ...rest } = value as Record<string, unknown>
  const extra = Object.keys(rest)[0]
  if (extra !== undefined) return { field: extra }
  if (enabled !== undefined && typeof enabled !== 'boolean') return { field: 'enabled' }
  if (robotKind !== undefined && !isRobotKind(robotKind)) return { field: 'robotKind' }
  return {
    settings: {
      ...current,
      ...(enabled !== undefined && { enabled }),
      ...(robotKind !== undefined && { robotKind }),
    },
  }
}

/** The latest midnight, Taiwan time, at or before `t` */
export function latestDailySlot(t: number): number {
  return Math.floor((t + TAIWAN_OFFSET_MS) / DAY_MS) * DAY_MS - TAIWAN_OFFSET_MS
}

/** The first midnight, Taiwan time, strictly after `t` */
export const dailySlotAfter = (t: number): number => latestDailySlot(t) + DAY_MS

/** The Taiwan date of `t`, YYYY-MM-DD */
export const taiwanDay = (t: number): string => new Date(t + TAIWAN_OFFSET_MS).toISOString().slice(0, 10)
