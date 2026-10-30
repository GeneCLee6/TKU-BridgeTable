import { DurableObject } from 'cloudflare:workers'
import type { Challenge, ChallengeResult } from './challenges.ts'
import type { Env } from './club.ts'
import { homeClubStub } from './clubs.ts'
import { EventHost } from './event-host.ts'
import type { EventRpc } from './events.ts'
import { jsonLog } from './log.ts'
import { AlarmQueue } from './scheduler.ts'

/**
 * One challenge in its own Durable Object (`idFromName('challenge:<id>')`, ARCHITECTURE.md §5.12,
 * H2b), used when `EVENT_OBJECTS=on`. This is only the glue to Cloudflare: storage, the SQLite
 * database, the alarm and the club's stub. What the challenge does is `EventHost` and
 * `ChallengeEvent`, which never touch a Cloudflare API. Only the club calls it (RPC); no browser
 * connects here.
 */
export class EventObject extends DurableObject<Env> implements EventRpc {
  private readonly host: EventHost
  private readonly queue: AlarmQueue

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    const storage = ctx.storage
    this.queue = new AlarmQueue(Date.now, (at) => void storage.setAlarm(at))
    const club = homeClubStub(env)
    this.host = new EventHost({
      storage: {
        get: (key) => storage.get(key),
        put: (key, value) => storage.put(key, value),
        delete: async (key) => {
          await storage.delete(key)
        },
        clear: async () => {
          await storage.deleteAlarm()
          await storage.deleteAll()
        },
      },
      sql: {
        exec: (query, ...params) => storage.sql.exec(query, ...params).toArray() as never,
        transaction: (fn) => storage.transactionSync(fn),
      },
      club: { changed: (snapshot) => club.eventChanged(snapshot) },
      scheduler: this.queue,
      now: Date.now,
      log: jsonLog,
    })
    ctx.blockConcurrencyWhile(() => this.host.load())
  }

  async alarm() {
    await this.queue.runDue()
  }

  adopt(challenge: Challenge) {
    return this.host.adopt(challenge)
  }
  answer(userId: string, accept: boolean) {
    return this.host.answer(userId, accept)
  }
  cancel(userId: string) {
    return this.host.cancel(userId)
  }
  started(userId: string) {
    return this.host.started(userId)
  }
  result(result: ChallengeResult) {
    return this.host.result(result)
  }
  forget(userId: string) {
    return this.host.forget(userId)
  }
  handOver() {
    return this.host.handOver()
  }
  release() {
    return this.host.release()
  }
}
