import { dailySlotAfter, type DailyEventSettings } from '../shared/daily-event.ts'

/**
 * The daily club event's saved state (`e9-t02`, ARCHITECTURE.md §5.18), one key in the store, as
 * the weekly challenge's (`weekly-challenge.ts`). The job is not stored: `ClubService.load()`
 * schedules it again from here, and one that came due while the object slept runs at once.
 */
export const DAILY_KEY = 'meta:daily'

export interface DailyRun {
  /** The Taiwan date, YYYY-MM-DD */
  day: string
  challengeId: string
}

export interface DailyState {
  settings: DailyEventSettings
  /** The admin who last saved the settings: the creator of the events */
  adminId?: string
  /** When the settings were last saved; the job is keyed by it */
  savedAt: number
  /** The midnight of the last event created (not when the job ran) */
  lastRunAt?: number
  /** Every event created, oldest first: the history list and today's and yesterday's */
  runs: DailyRun[]
}

/** When the next event is created: the first midnight after saving and after the last one; null while off */
export function nextDailyRun(state: DailyState): number | null {
  if (!state.settings.enabled) return null
  return dailySlotAfter(Math.max(state.savedAt, state.lastRunAt ?? 0))
}
