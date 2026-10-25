/** What a waiting job is for; tests run each kind on its own */
export type JobKind = 'robot' | 'deal' | 'challenge' | 'substitute'

/** Everything done later (robot moves, the next deal, a challenge's reminder and deadline, a robot sitting in for someone offline) goes through one scheduler */
export interface Scheduler {
  /** Runs `run` after `ms`, unless a job with the same key is still waiting */
  add(key: string, kind: JobKind, ms: number, run: () => Promise<void>): void
  /** Whether a job with this key is still waiting */
  pending(key: string): boolean
}

/**
 * Keeps the waiting jobs in memory and asks the platform to wake it at the earliest one. In the
 * Durable Object the wake-up is the object's single storage alarm, so jobs can never overwrite each
 * other's alarm and the object may hibernate between them. Jobs are not stored: after an eviction
 * `ClubService.load()` schedules them again from the tables.
 */
export class AlarmQueue implements Scheduler {
  private readonly jobs = new Map<string, { at: number; run: () => Promise<void> }>()
  private readonly now: () => number
  private readonly wake: (at: number) => void
  /** The wake-up already asked for, if any */
  private armedAt: number | undefined

  constructor(now: () => number, wake: (at: number) => void) {
    this.now = now
    this.wake = wake
  }

  add(key: string, _kind: JobKind, ms: number, run: () => Promise<void>) {
    if (this.jobs.has(key)) return
    this.jobs.set(key, { at: this.now() + ms, run })
    this.arm()
  }

  pending(key: string) {
    return this.jobs.has(key)
  }

  /**
   * Runs every job that is due, starting them earliest first, then asks to be woken for the next
   * one. The due jobs run side by side, so a robot that thinks (`e6-t11`) holds up no other table
   */
  async runDue() {
    this.armedAt = undefined
    for (;;) {
      const now = this.now()
      const due = [...this.jobs].filter(([, job]) => job.at <= now).sort((a, b) => a[1].at - b[1].at)
      if (!due.length) break
      for (const [key] of due) this.jobs.delete(key)
      await Promise.all(
        due.map(async ([key, job]) => {
          try {
            await job.run()
          } catch (error) {
            // One failing job must not stop the others
            console.error('scheduled job failed', key, error)
          }
        }),
      )
    }
    this.arm()
  }

  private arm() {
    let next: number | undefined
    for (const job of this.jobs.values()) if (next === undefined || job.at < next) next = job.at
    if (next === undefined || (this.armedAt !== undefined && this.armedAt <= next)) return
    this.armedAt = next
    this.wake(next)
  }
}

/** Hands every job to `schedule` and lets the caller decide when it runs (the tests' manual queue) */
export function manualScheduler(schedule: (run: () => void, ms: number, kind: JobKind) => void): Scheduler {
  const waiting = new Set<string>()
  return {
    add(key, kind, ms, run) {
      if (waiting.has(key)) return
      waiting.add(key)
      schedule(
        () => {
          waiting.delete(key)
          void run()
        },
        ms,
        kind,
      )
    },
    pending: (key) => waiting.has(key),
  }
}
