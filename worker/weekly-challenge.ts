import { weeklySlotAfter, type WeeklyChallengeSchedule } from '../shared/weekly-challenge.ts'

/**
 * The weekly club challenge's saved state (`e7-t23`, ARCHITECTURE.md §5.5), one key in the store.
 * The job that creates the challenge is not stored: `ClubService.load()` schedules it again from
 * here, and one that came due while the object slept runs at once.
 */
export const WEEKLY_KEY = 'meta:weekly'

export interface WeeklyState {
  schedule: WeeklyChallengeSchedule
  /** The admin who last saved the schedule: the creator of the challenges it makes */
  adminId?: string
  /** When the schedule was last saved; the job is keyed by it, so a changed schedule drops the old job */
  savedAt: number
  /** The scheduled time of the last challenge created (not when the job ran) */
  lastRunAt?: number
  lastChallengeId?: string
}

/**
 * When the next challenge is created: the first time the schedule names after it was saved and
 * after the last one created; null while it is off. It may be in the past (the object slept)
 */
export function nextWeeklyRun(state: WeeklyState): number | null {
  if (!state.schedule.enabled) return null
  return weeklySlotAfter(state.schedule, Math.max(state.savedAt, state.lastRunAt ?? 0))
}
