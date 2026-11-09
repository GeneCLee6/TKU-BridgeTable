import type { MetricAlert, MetricsView } from '../shared/protocol.ts'
import { alertsOf } from './metrics.ts'
import type { Scheduler } from './scheduler.ts'
import type { Store } from './store.ts'

/**
 * Tells the club's admins when the status page starts warning (AC-11.5, ARCHITECTURE.md §5.13):
 * a `systemAlert` in the notification centre (and a push, for whoever turned on the admins' group)
 * when an alert appears, once while it lasts, and a `systemRecovered` once every alert is gone.
 * No Cloudflare API: storage through `Store`, time through the club's one scheduler.
 *
 * Cheap on the free plan: nothing runs on its own. Whatever the metrics count (`Metrics`'
 * `onActivity`) asks for a look ALERT_CHECK_MS later, unless one is already waiting; after that
 * look, another is asked for only while an alert is on, so a recovery is noticed even when the club
 * goes quiet and its bad minutes slide out of the hour. A quiet club with nothing on is never woken.
 */

/**
 * How long after activity the alerts are looked at, and how often again while one is on: the
 * metrics are kept in five-minute slices (worker/metrics.ts), so a recovery with nobody about can
 * only happen when a slice leaves the hour, every five minutes. For one admin who is not on call,
 * hearing within five minutes is soon enough, and it is at most 12 looks an hour
 */
export const ALERT_CHECK_MS = 5 * 60_000
/** Where the alerts the admins were last told about are kept, so an eviction does not tell them again */
export const ALERTS_KEY = 'meta:alerts'

export interface AlertState {
  /** The alerts on at the last look, the admins already told */
  active: MetricAlert[]
  /** When the last look changed them */
  at: number
}

export interface AlertDeps {
  store: Store
  scheduler: Scheduler
  now: () => number
  view: () => MetricsView
  /** New alerts are on (`recovered` false), or every alert is off again (`recovered` true, `alerts` empty) */
  tell: (alerts: MetricAlert[], recovered: boolean) => Promise<void>
}

export class AlertWatch {
  private readonly deps: AlertDeps
  private state: AlertState = { active: [], at: 0 }

  constructor(deps: AlertDeps) {
    this.deps = deps
  }

  /** After a wake: what the admins were told, and a look again if an alert was on (jobs are not stored) */
  async load() {
    this.state = (await this.deps.store.get<AlertState>(ALERTS_KEY)) ?? { active: [], at: 0 }
    if (this.state.active.length) this.later()
  }

  /** Something was counted: look at the alerts a little later, once */
  activity() {
    this.later()
  }

  private later() {
    this.deps.scheduler.add('alerts', 'alerts', ALERT_CHECK_MS, () => this.check())
  }

  /** Compares the alerts now with what the admins were told, tells them what changed */
  async check() {
    const now = alertsOf(this.deps.view())
    const before = this.state.active
    const fresh = now.filter((alert) => !before.includes(alert))
    const changed = fresh.length > 0 || now.length !== before.length
    if (changed) {
      // Kept before telling: a failure halfway must not tell the admins twice
      this.state = { active: now, at: this.deps.now() }
      await this.deps.store.put(ALERTS_KEY, this.state)
      if (fresh.length) await this.deps.tell(fresh, false)
      else if (now.length === 0) await this.deps.tell([], true)
    }
    if (now.length) this.later()
  }
}
