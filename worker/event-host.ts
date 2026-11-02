import { ChallengeStore, type Challenge, type ChallengeResult } from './challenges.ts'
import { ChallengeEvent } from './event-service.ts'
import { eventWire, type EventLink, type EventRpc, type EventSnapshot, type EventWire } from './events.ts'
import { crashEntry, type Logger } from './log.ts'
import { MatchEvent, type MatchStep } from './match-event.ts'
import type { MatchRpc, MatchSnapshot, MatchWire } from './match-events.ts'
import { applyPairsStep, type PairsEvent, type PairsStep } from './pairs-flow.ts'
import type { PairsRpc, PairsSnapshot, PairsWire } from './pairs-events.ts'
import type { Scheduler } from './scheduler.ts'
import type { Sql } from './store.ts'
import { TeamMatchStore, type TeamMatch } from './team-matches.ts'

/** The part of a Durable Object's storage an event uses besides SQL (`worker/event-object.ts`; a Map in the tests) */
export interface EventStorage {
  get<T>(key: string): Promise<T | undefined>
  put<T>(key: string, value: T): Promise<void>
  delete(key: string): Promise<void>
  /** Removes everything the object keeps, its alarm too */
  clear(): Promise<void>
}

export interface EventHostDeps {
  storage: EventStorage
  /** The object's SQLite database: the event's rows, in the same tables as the club's (`ChallengeStore`, `TeamMatchStore`) */
  sql: Sql
  /** The club, over RPC in production */
  club: EventLink
  scheduler: Scheduler
  now: () => number
  log: Logger
}

/**
 * The object's keys: which event, whether it is a team match (H2c; a challenge has no `kind`, as
 * before), its change number, the last change not yet confirmed told, and a mark that the club
 * took it back
 */
const ID_KEY = 'id'
const KIND_KEY = 'kind'
const REV_KEY = 'rev'
const UNREPORTED_KEY = 'unreported'
const FROZEN_KEY = 'frozen'
/** A pairs event (§5.22) is kept whole under one key (at most 20 pairs and 32 boards) */
const PAIRS_KEY = 'pairs'
/**
 * How soon a change is told to the club again on its own, after the answer that carried it (in
 * case that answer was lost), and how long between tries after a failure (doubling, at most 10 minutes)
 */
export const REPORT_AGAIN_MS = 5_000
const REPORT_RETRY_MS = 30_000
const REPORT_RETRY_MAX_MS = 600_000

const refused = { code: 'serverError', params: {}, status: 503 } as const

/**
 * Everything one `EventObject` does, without Cloudflare APIs (so it runs in Node, ARCHITECTURE.md
 * §5.12). It holds one event: a challenge (H2b: `ChallengeEvent` on this object's own
 * `ChallengeStore`, with its job on the object's alarm) or a team match (H2c: `MatchEvent` on its
 * own `TeamMatchStore`; a match has no job of its own). It answers the club's calls (`EventRpc`,
 * `MatchRpc`, wrapped for RPC) and tells the club every change. Each change gets a number (`rev`)
 * and is kept as "not yet told" (`unreported`) until the club took it: a change the job made is
 * told at once, one the club asked for comes back in the answer and is told again a little later,
 * and a failure is tried again on the alarm. The club keeps the newest number it wrote, so a late
 * or repeated report changes nothing. The Durable Object glue is `worker/event-object.ts`.
 */
export class EventHost implements EventRpc, MatchRpc, PairsRpc {
  private readonly deps: EventHostDeps
  private readonly store: ChallengeStore
  private readonly matchStore: TeamMatchStore
  private event: ChallengeEvent | null = null
  private match: MatchEvent | null = null
  /** A pairs event (§5.22): no SQL and no job of its own, it changes only when the club calls */
  private pairs: PairsEvent | null = null
  private rev = 0
  /** The club took the event back (`handOver`): nothing is changed, run or told until `release` */
  private frozen = false
  private retryMs = REPORT_RETRY_MS

  constructor(deps: EventHostDeps) {
    this.deps = deps
    this.store = new ChallengeStore(deps.sql)
    this.matchStore = new TeamMatchStore(deps.sql)
  }

  /** The challenge as it is now, for tests */
  get challenge(): Challenge | null {
    return this.live ? this.event!.get() : null
  }

  /** The team match as it is now, for tests */
  get teamMatch(): TeamMatch | null {
    return this.matchLive ? this.match!.get() : null
  }

  private get live(): boolean {
    return !this.frozen && !!this.event?.get()
  }

  private get matchLive(): boolean {
    return !this.frozen && !!this.match?.get()
  }

  private snapshot(): EventSnapshot | null {
    const challenge = this.live ? this.event!.get() : null
    return challenge && { challenge, rev: this.rev }
  }

  /** The pairs event as it is now, for tests */
  get pairsEvent(): PairsEvent | null {
    return this.frozen ? null : this.pairs
  }

  private pairsSnapshot(): PairsSnapshot | null {
    return !this.frozen && this.pairs ? { event: this.pairs, rev: this.rev } : null
  }

  private matchSnapshot(): MatchSnapshot | null {
    const match = this.matchLive ? this.match!.get() : null
    return match && { match, rev: this.rev }
  }

  private createTables() {
    this.store.createTables()
    this.matchStore.createTables()
  }

  /** Loads after the object was evicted: the job is scheduled again, and a change not yet told is told */
  async load() {
    const { storage } = this.deps
    this.createTables()
    if (await storage.get<boolean>(FROZEN_KEY)) {
      this.frozen = true
      return
    }
    const id = await storage.get<string>(ID_KEY)
    this.rev = (await storage.get<number>(REV_KEY)) ?? 0
    if (!id) return
    const kind = await storage.get<string>(KIND_KEY)
    if (kind === 'match') this.match = this.makeMatch(id)
    else if (kind === 'pairs') this.pairs = (await storage.get<PairsEvent>(PAIRS_KEY)) ?? null
    else {
      this.event = this.make(id)
      this.event.schedule()
    }
    if ((await storage.get<number>(UNREPORTED_KEY)) !== undefined) this.reportLater(0)
  }

  private make(id: string): ChallengeEvent {
    return new ChallengeEvent(id, {
      store: this.store,
      scheduler: this.deps.scheduler,
      now: this.deps.now,
      here: () => !this.frozen,
      // What the job changed is told at once
      changed: async () => {
        await this.changed()
        await this.report()
      },
    })
  }

  private makeMatch(id: string): MatchEvent {
    return new MatchEvent(id, { store: this.matchStore, now: this.deps.now })
  }

  /** A change: its number goes up (never back, even after an eviction) and it waits to be told */
  private async changed() {
    const { storage, now } = this.deps
    this.rev = Math.max(this.rev + 1, now())
    await storage.put(REV_KEY, this.rev)
    await storage.put(UNREPORTED_KEY, this.rev)
  }

  /** Tells the club the event as it is now; on failure it is tried again later */
  private async report() {
    if (this.frozen) return
    const { storage, club, log } = this.deps
    const pending = await storage.get<number>(UNREPORTED_KEY)
    const snapshot = this.snapshot()
    const matchSnapshot = this.matchSnapshot()
    const pairsSnapshot = this.pairsSnapshot()
    if (pending === undefined || (!snapshot && !matchSnapshot && !pairsSnapshot)) return
    try {
      if (snapshot) await club.changed(snapshot)
      else if (matchSnapshot) await club.matchChanged(matchSnapshot)
      else await club.pairsChanged?.(pairsSnapshot!)
      this.retryMs = REPORT_RETRY_MS
      if ((await storage.get<number>(UNREPORTED_KEY)) === pending) await storage.delete(UNREPORTED_KEY)
    } catch (error) {
      log(crashEntry('eventChanged', error))
      this.reportLater(this.retryMs)
      this.retryMs = Math.min(this.retryMs * 2, REPORT_RETRY_MAX_MS)
    }
  }

  private reportLater(ms: number) {
    this.deps.scheduler.add('report', 'outbox', ms, () => this.report())
  }

  /** A call that changes the challenge: answered with it, and told again later in case the answer is lost */
  private async change(run: (event: ChallengeEvent) => unknown): Promise<EventWire> {
    if (this.frozen) return { snapshot: null, error: refused }
    if (!this.live) return { snapshot: null }
    const event = this.event!
    return this.track(
      () => event.get(),
      () => this.snapshot(),
      () => run(event),
    )
  }

  /**
   * Runs a call, and when the event is different after it (even if the call then threw), counts a
   * change and tells it again later
   */
  private track<S>(read: () => unknown, snapshot: () => S | null, run: () => unknown) {
    const before = JSON.stringify(read())
    return eventWire(snapshot, async () => {
      try {
        run()
      } finally {
        if (JSON.stringify(read()) !== before) {
          await this.changed()
          this.reportLater(REPORT_AGAIN_MS)
        }
      }
    })
  }

  /** An event the club takes over again after a `handOver` without a `release`: what was here is dropped */
  private async thaw() {
    if (!this.frozen) return
    this.frozen = false
    await this.wipe()
  }

  private async wipe() {
    const id = await this.deps.storage.get<string>(ID_KEY)
    if (id) {
      this.store.remove(id)
      this.matchStore.remove(id)
    }
    this.event = null
    this.match = null
    this.pairs = null
    await this.deps.storage.clear()
    // Clearing a Durable Object's storage also drops its SQL tables
    this.createTables()
  }

  // ── The club's calls for a challenge (EventRpc) ─────────────────────────────────────────────

  async adopt(challenge: Challenge): Promise<EventWire> {
    await this.thaw()
    const { storage } = this.deps
    if (!this.event && !this.match && !this.pairs) {
      await storage.put(ID_KEY, challenge.id)
      this.event = this.make(challenge.id)
    }
    if (this.event?.id !== challenge.id) return { snapshot: null, error: { ...refused, status: 500 } }
    const had = !!this.event.get()
    this.event.adopt(challenge)
    if (!had) await this.changed()
    return { snapshot: this.snapshot() }
  }
  answer(userId: string, accept: boolean) {
    return this.change((event) => event.answer(userId, accept))
  }
  cancel(userId: string) {
    return this.change((event) => event.cancel(userId))
  }
  started(userId: string) {
    return this.change((event) => event.started(userId))
  }
  result(result: ChallengeResult) {
    return this.change((event) => event.result(result))
  }
  forget(userId: string) {
    return this.change((event) => event.forget(userId))
  }

  async handOver(): Promise<EventWire> {
    if (this.frozen) {
      const id = await this.deps.storage.get<string>(ID_KEY)
      const challenge = id ? this.store.get(id) : null
      return { snapshot: challenge && { challenge, rev: this.rev } }
    }
    const snapshot = this.snapshot()
    if (!snapshot) return { snapshot: null }
    this.frozen = true
    await this.deps.storage.put(FROZEN_KEY, true)
    return { snapshot }
  }

  async release(): Promise<EventWire> {
    this.frozen = false
    await this.wipe()
    return { snapshot: null }
  }

  // ── The club's calls for a team match (MatchRpc, H2c) ───────────────────────────────────────

  async adoptMatch(match: TeamMatch): Promise<MatchWire> {
    await this.thaw()
    const { storage } = this.deps
    if (!this.event && !this.match && !this.pairs) {
      await storage.put(ID_KEY, match.id)
      await storage.put(KIND_KEY, 'match')
      this.match = this.makeMatch(match.id)
    }
    if (this.match?.id !== match.id) return { snapshot: null, error: { ...refused, status: 500 } }
    const had = !!this.match.get()
    this.match.adopt(match)
    if (!had) await this.changed()
    return { snapshot: this.matchSnapshot() }
  }

  async stepMatch(step: MatchStep): Promise<MatchWire> {
    if (this.frozen) return { snapshot: null, error: refused }
    if (!this.matchLive) return { snapshot: null }
    const match = this.match!
    return this.track(
      () => match.get(),
      () => this.matchSnapshot(),
      () => match.apply(step),
    )
  }

  async handOverMatch(): Promise<MatchWire> {
    if (this.frozen) {
      const id = await this.deps.storage.get<string>(ID_KEY)
      const match = id ? this.matchStore.get(id) : null
      return { snapshot: match && { match, rev: this.rev } }
    }
    const snapshot = this.matchSnapshot()
    if (!snapshot) return { snapshot: null }
    this.frozen = true
    await this.deps.storage.put(FROZEN_KEY, true)
    return { snapshot }
  }

  // ── The club's calls for a pairs event (PairsRpc, §5.22) ────────────────────────────────────

  async adoptPairs(event: PairsEvent): Promise<PairsWire> {
    const { storage } = this.deps
    if (this.frozen) return { snapshot: null, error: refused }
    if (!this.event && !this.match && !this.pairs) {
      await storage.put(ID_KEY, event.id)
      await storage.put(KIND_KEY, 'pairs')
      this.pairs = structuredClone(event)
      await storage.put(PAIRS_KEY, this.pairs)
      await this.changed()
    }
    if (this.pairs?.id !== event.id) return { snapshot: null, error: { ...refused, status: 500 } }
    return { snapshot: this.pairsSnapshot() }
  }

  /**
   * One change, run on a copy and kept only when it went through; a change is counted, kept and
   * told again a little later (in case the answer is lost), as for a match
   */
  async stepPairs(step: PairsStep): Promise<PairsWire> {
    if (this.frozen) return { snapshot: null, error: refused }
    if (!this.pairs) return { snapshot: null }
    const next = structuredClone(this.pairs)
    try {
      applyPairsStep(next, step)
    } catch (error) {
      return eventWire(() => this.pairsSnapshot(), async () => {
        throw error
      })
    }
    if (JSON.stringify(next) !== JSON.stringify(this.pairs)) {
      this.pairs = next
      await this.deps.storage.put(PAIRS_KEY, next)
      await this.changed()
      this.reportLater(REPORT_AGAIN_MS)
    }
    return { snapshot: this.pairsSnapshot() }
  }
}
