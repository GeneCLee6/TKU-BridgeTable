import { ChallengeStore, type Challenge, type ChallengeResult } from './challenges.ts'
import { ChallengeEvent } from './event-service.ts'
import { eventWire, type EventLink, type EventRpc, type EventSnapshot, type EventWire } from './events.ts'
import { crashEntry, type Logger } from './log.ts'
import type { Scheduler } from './scheduler.ts'
import type { Sql } from './store.ts'

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
  /** The object's SQLite database: the challenge's rows, in the same tables as the club's (`ChallengeStore`) */
  sql: Sql
  /** The club, over RPC in production */
  club: EventLink
  scheduler: Scheduler
  now: () => number
  log: Logger
}

/** The object's keys: which challenge, its change number, the last change not yet confirmed told, and a mark that the club took it back */
const ID_KEY = 'id'
const REV_KEY = 'rev'
const UNREPORTED_KEY = 'unreported'
const FROZEN_KEY = 'frozen'
/**
 * How soon a change is told to the club again on its own, after the answer that carried it (in
 * case that answer was lost), and how long between tries after a failure (doubling, at most 10 minutes)
 */
export const REPORT_AGAIN_MS = 5_000
const REPORT_RETRY_MS = 30_000
const REPORT_RETRY_MAX_MS = 600_000

/**
 * Everything one `EventObject` does, without Cloudflare APIs (so it runs in Node, ARCHITECTURE.md
 * §5.12): the club's calls (`EventRpc`, answers wrapped for RPC) on the challenge it holds
 * (`ChallengeEvent` on this object's own `ChallengeStore`), its job on the object's alarm, and
 * telling the club every change. Each change gets a number (`rev`) and is kept as "not yet told"
 * (`unreported`) until the club took it: a change the job made is told at once, one the club asked
 * for comes back in the answer and is told again a little later, and a failure is tried again on
 * the alarm. The club keeps the newest number it wrote, so a late or repeated report changes nothing.
 * The Durable Object glue is `worker/event-object.ts`.
 */
export class EventHost implements EventRpc {
  private readonly deps: EventHostDeps
  private readonly store: ChallengeStore
  private event: ChallengeEvent | null = null
  private rev = 0
  /** The club took the challenge back (`handOver`): nothing is changed, run or told until `release` */
  private frozen = false
  private retryMs = REPORT_RETRY_MS

  constructor(deps: EventHostDeps) {
    this.deps = deps
    this.store = new ChallengeStore(deps.sql)
  }

  /** The challenge as it is now, for tests */
  get challenge(): Challenge | null {
    return this.live ? this.event!.get() : null
  }

  private get live(): boolean {
    return !this.frozen && !!this.event?.get()
  }

  private snapshot(): EventSnapshot | null {
    const challenge = this.live ? this.event!.get() : null
    return challenge && { challenge, rev: this.rev }
  }

  /** Loads after the object was evicted: the job is scheduled again, and a change not yet told is told */
  async load() {
    const { storage } = this.deps
    this.store.createTables()
    if (await storage.get<boolean>(FROZEN_KEY)) {
      this.frozen = true
      return
    }
    const id = await storage.get<string>(ID_KEY)
    this.rev = (await storage.get<number>(REV_KEY)) ?? 0
    if (!id) return
    this.event = this.make(id)
    this.event.schedule()
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

  /** A change: its number goes up (never back, even after an eviction) and it waits to be told */
  private async changed() {
    const { storage, now } = this.deps
    this.rev = Math.max(this.rev + 1, now())
    await storage.put(REV_KEY, this.rev)
    await storage.put(UNREPORTED_KEY, this.rev)
  }

  /** Tells the club the challenge as it is now; on failure it is tried again later */
  private async report() {
    if (this.frozen) return
    const { storage, club, log } = this.deps
    const pending = await storage.get<number>(UNREPORTED_KEY)
    const snapshot = this.snapshot()
    if (pending === undefined || !snapshot) return
    try {
      await club.changed(snapshot)
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
    if (this.frozen) return { snapshot: null, error: { code: 'serverError', params: {}, status: 503 } }
    if (!this.live) return { snapshot: null }
    const event = this.event!
    const before = JSON.stringify(event.get())
    return eventWire(
      () => this.snapshot(),
      async () => {
        try {
          run(event)
        } finally {
          if (JSON.stringify(event.get()) !== before) {
            await this.changed()
            this.reportLater(REPORT_AGAIN_MS)
          }
        }
      },
    )
  }

  /** A challenge the club takes over again after a `handOver` without a `release`: what was here is dropped */
  private async thaw() {
    if (!this.frozen) return
    this.frozen = false
    await this.wipe()
  }

  private async wipe() {
    const id = await this.deps.storage.get<string>(ID_KEY)
    if (id) this.store.remove(id)
    this.event = null
    await this.deps.storage.clear()
    // Clearing a Durable Object's storage also drops its SQL tables
    this.store.createTables()
  }

  // ── The club's calls (EventRpc) ─────────────────────────────────────────────────────────────

  async adopt(challenge: Challenge): Promise<EventWire> {
    await this.thaw()
    const { storage } = this.deps
    if (!this.event) {
      await storage.put(ID_KEY, challenge.id)
      this.event = this.make(challenge.id)
    }
    if (this.event.id !== challenge.id)
      return { snapshot: null, error: { code: 'serverError', params: {}, status: 500 } }
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
}

