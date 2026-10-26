import type { MetricAlert, MetricsView } from '../shared/protocol.ts'
import type { LogEntry } from './log.ts'

export type { MetricAlert, MetricsView }

/**
 * The numbers behind the admin page's system status and `/api/health` (e11-t22, ARCHITECTURE.md
 * §5.13): counted in memory from the structured log entries the objects already write, in
 * five-minute slices over the last hour. The club writes them to its storage at most once a minute
 * (`meta:metrics`): its object hibernates whenever it is idle for a few seconds, even with sockets
 * open, and would otherwise start over each time. No Cloudflare API, no member ids kept: counts only.
 *
 * Inside a Worker the clock only moves on I/O, so a time here is the waiting (an RPC, storage),
 * not the CPU; the CPU of every invocation is in Workers Logs (`$workers.cpuTimeMs`, DEPLOY.md §4.7)
 */

/** Upper bounds (ms) of the latency buckets an action's time falls in */
export const LATENCY_BOUNDS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, Infinity] as const
export const METRICS_WINDOW_MS = 60 * 60_000
const SLICE_MS = 5 * 60_000
/** A connection within this long after the member's last one closed counts as a reconnect */
export const RECONNECT_WINDOW_MS = 60_000
/** How often the counts are written to storage, at most */
export const METRICS_SAVE_MS = 60_000

/** What a table object counted since its last report, sent along with a finished board */
export interface TableStats {
  actions: number
  /** Actions answered with an error code (a rule said no, or a bug) */
  refused: number
  crashes: number
  /** Messages that never reached a handler: too large, malformed, over the rate limit */
  rejected: number
  robotMoves: number
  thinkMs: number
  thinkMaxMs: number
}

export const noTableStats = (): TableStats => ({ actions: 0, refused: 0, crashes: 0, rejected: 0, robotMoves: 0, thinkMs: 0, thinkMaxMs: 0 })

export interface Slice extends TableStats {
  start: number
  latency: number[]
  requests: number
  serverErrors: number
  connects: number
  reconnects: number
  boards: number
  peakOnline: number
}

export const ALERT_LIMITS = {
  /** More than 1% of actions and requests failed with a bug, over at least 50 of them */
  errorRate: { above: 0.01, atLeast: 50 },
  /** More than 20% of connections were reconnects, over at least 20 connections */
  reconnectRate: { above: 0.2, atLeast: 20 },
  /** The 95th percentile of an action took more than a second, over at least 50 actions */
  actionSlow: { aboveMs: 1000, atLeast: 50 },
  /** A robot thought half a second on average (the brain's limit is 2 s, ROBOT.md) */
  robotSlow: { aboveMs: 500, atLeast: 20 },
}

export function alertsOf(view: MetricsView): MetricAlert[] {
  const alerts: MetricAlert[] = []
  const { errorRate, reconnectRate, actionSlow, robotSlow } = ALERT_LIMITS
  if (view.actions + view.requests >= errorRate.atLeast && view.errorRate > errorRate.above) alerts.push('errorRate')
  if (view.connects >= reconnectRate.atLeast && view.reconnectRate > reconnectRate.above) alerts.push('reconnectRate')
  if (view.actions >= actionSlow.atLeast && (view.actionP95Ms ?? 0) > actionSlow.aboveMs) alerts.push('actionSlow')
  if (view.robot.moves >= robotSlow.atLeast && (view.robot.avgMs ?? 0) > robotSlow.aboveMs) alerts.push('robotSlow')
  return alerts
}

const bucketOf = (ms: number) => LATENCY_BOUNDS.findIndex((bound) => ms <= bound)
const ratio = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 10_000) / 10_000 : 0)

/** A table object's own counts until it reports them (`take`); nothing about who */
export class TableCounters {
  private stats = noTableStats()

  observe(entry: LogEntry) {
    if (entry.event === 'action') {
      this.stats.actions++
      if (entry.code) this.stats.refused++
    } else if (entry.event === 'rejected') this.stats.rejected++
    else if (entry.event === 'crash') this.stats.crashes++
  }

  think(ms: number) {
    this.stats.robotMoves++
    this.stats.thinkMs += ms
    this.stats.thinkMaxMs = Math.max(this.stats.thinkMaxMs, ms)
  }

  /** The counts so far, starting over; `putBack` when they did not reach the club */
  take(): TableStats {
    const taken = this.stats
    this.stats = noTableStats()
    return taken
  }

  putBack(stats: TableStats) {
    this.stats = addStats(this.stats, stats)
  }
}

function addStats(a: TableStats, b: TableStats): TableStats {
  return {
    actions: a.actions + b.actions,
    refused: a.refused + b.refused,
    crashes: a.crashes + b.crashes,
    rejected: a.rejected + b.rejected,
    robotMoves: a.robotMoves + b.robotMoves,
    thinkMs: a.thinkMs + b.thinkMs,
    thinkMaxMs: Math.max(a.thinkMaxMs, b.thinkMaxMs),
  }
}

function mergeSlices(a: Slice, b: Slice): Slice {
  return {
    ...addStats(a, b),
    start: a.start,
    latency: a.latency.map((n, i) => n + (b.latency[i] ?? 0)),
    requests: a.requests + b.requests,
    serverErrors: a.serverErrors + b.serverErrors,
    connects: a.connects + b.connects,
    reconnects: a.reconnects + b.reconnects,
    boards: a.boards + b.boards,
    peakOnline: Math.max(a.peakOnline, b.peakOnline),
  }
}

/** What is kept in storage between wakes */
export interface MetricsState {
  started: number
  slices: Slice[]
}

/** The club's counts: its own log entries, its connections, and what the tables report */
export class Metrics {
  private slices: Slice[] = []
  private readonly now: () => number
  private started: number
  private readonly save?: (state: MetricsState) => void
  private savedAt = -Infinity
  private saving = false
  /** When each member's last connection closed, for telling a reconnect from a new visit */
  private readonly gone = new Map<string, number>()

  constructor(now: () => number, save?: (state: MetricsState) => void) {
    this.now = now
    this.started = now()
    this.save = save
  }

  /** The counts as last written, after the object woke up again */
  restore(state: MetricsState | undefined) {
    if (!state?.slices) return
    const now = this.now()
    this.started = Math.min(this.started, state.started)
    const kept = new Map(state.slices.filter((s) => s.start > now - METRICS_WINDOW_MS).map((s) => [s.start, s]))
    for (const slice of this.slices) {
      const old = kept.get(slice.start)
      kept.set(slice.start, old ? mergeSlices(old, slice) : slice)
    }
    this.slices = [...kept.values()].sort((a, b) => a.start - b.start)
  }

  /** Writes the counts once the change under way is done, at most every METRICS_SAVE_MS */
  private changed() {
    if (!this.save || this.saving || this.now() - this.savedAt < METRICS_SAVE_MS) return
    this.saving = true
    queueMicrotask(() => {
      this.saving = false
      this.savedAt = this.now()
      this.save!({ started: this.started, slices: this.slices })
    })
  }

  private slice(): Slice {
    const now = this.now()
    const start = now - (now % SLICE_MS)
    let last = this.slices.at(-1)
    if (!last || last.start !== start) {
      last = { ...noTableStats(), start, latency: LATENCY_BOUNDS.map(() => 0), requests: 0, serverErrors: 0, connects: 0, reconnects: 0, boards: 0, peakOnline: 0 }
      this.slices.push(last)
      this.slices = this.slices.filter((s) => s.start > now - METRICS_WINDOW_MS)
    }
    this.changed()
    return last
  }

  observe(entry: LogEntry) {
    const slice = this.slice()
    if (entry.event === 'action') {
      slice.actions++
      slice.latency[bucketOf(entry.ms)]++
      if (entry.code) slice.refused++
    } else if (entry.event === 'rejected') slice.rejected++
    else if (entry.event === 'crash') slice.crashes++
    else if (entry.event === 'http') {
      slice.requests++
      if (entry.status >= 500) slice.serverErrors++
    }
  }

  /** A member's connection opened; `online` is how many members are online now */
  connected(userId: string, online: number) {
    const slice = this.slice()
    slice.connects++
    const gone = this.gone.get(userId)
    if (gone !== undefined && this.now() - gone <= RECONNECT_WINDOW_MS) slice.reconnects++
    this.gone.delete(userId)
    slice.peakOnline = Math.max(slice.peakOnline, online)
  }

  /** A member's last connection closed */
  disconnected(userId: string) {
    const now = this.now()
    this.gone.set(userId, now)
    if (this.gone.size > 2000) for (const [id, at] of this.gone) if (now - at > RECONNECT_WINDOW_MS) this.gone.delete(id)
  }

  /** A robot in this object answered after `ms` (tables in the club's own object, H1a) */
  think(ms: number) {
    const slice = this.slice()
    slice.robotMoves++
    slice.thinkMs += ms
    slice.thinkMaxMs = Math.max(slice.thinkMaxMs, ms)
  }

  /** A finished board reached the club, with what its table counted since its last report */
  board(stats?: TableStats) {
    const slice = this.slice()
    slice.boards++
    if (stats) Object.assign(slice, addStats(slice, stats))
  }

  view(): MetricsView {
    this.slice()
    const all = this.slices
    const sum = (key: keyof Omit<Slice, 'latency' | 'start'>) => all.reduce((total, s) => total + s[key], 0)
    const latency = LATENCY_BOUNDS.map((_, i) => all.reduce((total, s) => total + s.latency[i], 0))
    const timed = latency.reduce((a, b) => a + b, 0)
    let p95: number | null = null
    if (timed > 0) {
      let seen = 0
      const at = latency.findIndex((count) => (seen += count) >= timed * 0.95)
      const bound = LATENCY_BOUNDS[at]
      p95 = bound === Infinity ? LATENCY_BOUNDS[LATENCY_BOUNDS.length - 2] : bound
    }
    const actions = sum('actions')
    const requests = sum('requests')
    const connects = sum('connects')
    const moves = sum('robotMoves')
    const now = this.now()
    return {
      minutes: Math.max(1, Math.round((now - Math.max(this.started, now - METRICS_WINDOW_MS)) / 60_000)),
      actions,
      actionP95Ms: p95,
      refused: sum('refused'),
      rejected: sum('rejected'),
      crashes: sum('crashes'),
      requests,
      serverErrors: sum('serverErrors'),
      errorRate: ratio(sum('crashes') + sum('serverErrors'), actions + requests),
      connects,
      reconnects: sum('reconnects'),
      reconnectRate: ratio(sum('reconnects'), connects),
      boards: sum('boards'),
      peakOnline: all.reduce((peak, s) => Math.max(peak, s.peakOnline), 0),
      robot: {
        moves,
        avgMs: moves ? Math.round((sum('thinkMs') / moves) * 10) / 10 : null,
        maxMs: moves ? all.reduce((max, s) => Math.max(max, s.thinkMaxMs), 0) : null,
      },
    }
  }
}
