import { CHALLENGE_LIMITS } from './challenge.ts'
import type { ChallengeScoring } from './challenge-scoring.ts'
import { isRobotKind, type RobotKind } from './protocol.ts'

/**
 * The weekly club challenge (`e7-t23`, ARCHITECTURE.md §5.5): an admin sets a weekday and an hour,
 * and every week at that time the club creates a challenge and invites every member. The times are
 * Taiwan time (UTC+8 all year, no daylight saving), so the schedule does not move with the
 * server's clock or the admin's browser.
 */

/** Whole-club challenges have many players: matchpoints, cross-IMPs or total points */
export const WEEKLY_SCORINGS = ['mp', 'crossImp', 'total'] as const satisfies readonly ChallengeScoring[]
export type WeeklyScoring = (typeof WEEKLY_SCORINGS)[number]

export interface WeeklyChallengeSchedule {
  enabled: boolean
  /** 0 = Sunday … 6 = Saturday, Taiwan time */
  weekday: number
  /** 0–23, Taiwan time */
  hour: number
  boards: number
  scoring: WeeklyScoring
  robotKind: RobotKind
  /** Days until the deadline, 1–7 */
  days: number
}

/** 建議預設 (ARCHITECTURE.md §5.5): off until an admin turns it on; Monday 20:00, 8 boards, MP, 2/1 (the club's system is private, 社長 2026-10-26), a week to play */
export const DEFAULT_WEEKLY_SCHEDULE: WeeklyChallengeSchedule = {
  enabled: false,
  weekday: 1,
  hour: 20,
  boards: 8,
  scoring: 'mp',
  robotKind: 'gib',
  days: 7,
}

/** What an admin sees: the schedule, when the next one is created, and the last one created */
export interface WeeklyChallengeView {
  schedule: WeeklyChallengeSchedule
  /** Null while it is off */
  next: number | null
  lastRunAt?: number
  lastChallengeId?: string
}

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
const WEEK_MS = 7 * DAY_MS
/** Taiwan time is UTC+8 all year */
export const TAIWAN_OFFSET_MS = 8 * HOUR_MS

const isInt = (value: unknown, min: number, max: number): value is number =>
  Number.isInteger(value) && (value as number) >= min && (value as number) <= max

/**
 * Checks a schedule an admin sent: every field optional (the current schedule fills the gaps),
 * nothing else allowed. Returns the schedule, or the first field that is wrong
 */
export function parseWeeklySchedule(
  value: unknown,
  current: WeeklyChallengeSchedule = DEFAULT_WEEKLY_SCHEDULE,
): { schedule: WeeklyChallengeSchedule } | { field: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { field: 'schedule' }
  const { enabled, weekday, hour, boards, scoring, robotKind, days, ...rest } = value as Record<string, unknown>
  const extra = Object.keys(rest)[0]
  if (extra !== undefined) return { field: extra }
  if (enabled !== undefined && typeof enabled !== 'boolean') return { field: 'enabled' }
  if (weekday !== undefined && !isInt(weekday, 0, 6)) return { field: 'weekday' }
  if (hour !== undefined && !isInt(hour, 0, 23)) return { field: 'hour' }
  const { boardsMin, boardsMax, daysMin, daysMax } = CHALLENGE_LIMITS
  if (boards !== undefined && !isInt(boards, boardsMin, boardsMax)) return { field: 'boards' }
  if (scoring !== undefined && !WEEKLY_SCORINGS.includes(scoring as WeeklyScoring)) return { field: 'scoring' }
  if (robotKind !== undefined && !isRobotKind(robotKind)) return { field: 'robotKind' }
  if (days !== undefined && !isInt(days, daysMin, daysMax)) return { field: 'days' }
  return {
    schedule: {
      ...current,
      ...(enabled !== undefined && { enabled }),
      ...(weekday !== undefined && { weekday }),
      ...(hour !== undefined && { hour }),
      ...(boards !== undefined && { boards }),
      ...(scoring !== undefined && { scoring: scoring as WeeklyScoring }),
      ...(robotKind !== undefined && { robotKind }),
      ...(days !== undefined && { days }),
    },
  }
}

/** The latest time the schedule names at or before `t` (whether or not it is on) */
export function latestWeeklySlot(s: WeeklyChallengeSchedule, t: number): number {
  const local = t + TAIWAN_OFFSET_MS
  const midnight = Math.floor(local / DAY_MS) * DAY_MS
  // 1970-01-01 was a Thursday
  const weekday = (Math.floor(local / DAY_MS) + 4) % 7
  let slot = midnight - ((weekday - s.weekday + 7) % 7) * DAY_MS + s.hour * HOUR_MS
  if (slot > local) slot -= WEEK_MS
  return slot - TAIWAN_OFFSET_MS
}

/** The first time the schedule names strictly after `t` */
export const weeklySlotAfter = (s: WeeklyChallengeSchedule, t: number): number => latestWeeklySlot(s, t) + WEEK_MS
