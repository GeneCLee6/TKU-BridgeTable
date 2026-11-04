import { deviceLabel } from '../shared/account.ts'
import { isLang, type Lang } from '../shared/messages.ts'
import { NOTIFICATION_KINDS, type Notification, type NotificationKind } from '../shared/protocol.ts'
import { PUSH_DEVICES_MAX, PUSH_OFF_BY_DEFAULT, pushDeviceId, type PushKinds, type PushView } from '../shared/push.ts'
import { pushMessage, testPushMessage, type PushMessage } from '../shared/push-texts.ts'
import { ClubError } from './errors.ts'
import type { Logger } from './log.ts'
import type { Store } from './store.ts'
import { allowedEndpoint, validKeys, type PushSender, type PushTarget, type PushUrgency } from './web-push.ts'

/**
 * Push notifications (PWA 推播, e1-t28, AC-1.8; ARCHITECTURE.md §5.4). Each member keeps their
 * devices and choices under `push:<userId>`; the notification centre (`worker/notifications.ts`)
 * hands every new notification to `queue`, which pushes it to each of the member's devices unless
 * the member is online (the bell already shows it), the kind is turned off or push is off.
 *
 * Pushes go out from the club's Durable Object, never in a Worker request: what `queue` collects
 * in one turn is sent together (`flush`), a few at a time, inside `defer` (the object's
 * `waitUntil`) so the action that caused it does not wait for the push services. A push service
 * answering 404 or 410 means the browser dropped the subscription: the device is removed.
 * Nothing is retried: the notification is in the bell either way.
 */

interface StoredDevice extends PushTarget {
  id: string
  lang: Lang
  name: string
  createdAt: number
}

interface StoredPush {
  devices: StoredDevice[]
  /** Kinds the member switched from their default (PUSH_OFF_BY_DEFAULT) */
  kinds?: Partial<Record<NotificationKind, boolean>>
}

export interface PushOptions {
  /** Sends one push; without it push is off and every route but the view answers `pushOff` */
  sender?: PushSender
  now: () => number
  /** Whether the member has the site open (a connection to the club) right now */
  online: (userId: string) => boolean
  /** Whether forum links lead to the table's own forum (the `forum` flag), as the bell does */
  forum: (userId: string) => boolean
  /** The club whose pages the pushes open (e12-t04); 淡江 when left out */
  clubId?: string
  /** Keeps the object alive until the pushes are out (the Durable Object's `waitUntil`) */
  defer: (task: Promise<unknown>) => void
  log: Logger
}

/** How many pushes are in flight at once in a batch */
const PUSH_PARALLEL = 6
/** The kinds that are worth waking a phone for: someone waits for an answer */
const URGENT = new Set<NotificationKind>([
  'challengeInvited',
  'challengePartnerSeated',
  'tableInvited',
  'tableRequest',
  'directorCalled',
  'matchInvited',
  'matchStarted',
  'matchSubIn',
  'pairInvited',
  'tournamentPartner',
])
/** The kinds that are stale within the hour (a table, someone online): the push service drops them after that */
const SHORT_LIVED = new Set<NotificationKind>([
  'challengePartnerSeated',
  'tableInvited',
  'tableRequest',
  'tableRequestApproved',
  'tableRequestDeclined',
  'directorCalled',
  'friendOnline',
  'matchStarted',
  'matchSubIn',
])
/** One test push per member this often */
const TEST_GAP_MS = 10_000
const HOUR_S = 3_600
const DAY_S = 86_400

const KEY = (userId: string) => `push:${userId}`

export function pushKinds(stored: StoredPush['kinds'] = {}): PushKinds {
  const kinds = {} as PushKinds
  for (const kind of NOTIFICATION_KINDS) kinds[kind] = stored[kind] ?? !PUSH_OFF_BY_DEFAULT.includes(kind)
  return kinds
}

interface Job {
  userId: string
  message: PushMessage | ((lang: Lang) => PushMessage)
  urgency: PushUrgency
  ttl: number
  /** Only this device (the test push from one device) */
  deviceId?: string
  /** The notification's kind; none for the test push, which goes out even while online */
  kind?: NotificationKind
}

export class PushService {
  private readonly store: Store
  private readonly options: PushOptions
  private readonly loaded = new Map<string, StoredPush>()
  private jobs: Job[] = []
  private running: Promise<void> | null = null
  /** When each member last sent a test push */
  private readonly tested = new Map<string, number>()

  constructor(store: Store, options: PushOptions) {
    this.store = store
    this.options = options
  }

  get enabled() {
    return !!this.options.sender
  }

  private requireSender() {
    if (!this.options.sender) throw new ClubError('pushOff', {}, 503)
    return this.options.sender
  }

  private async record(userId: string): Promise<StoredPush> {
    let record = this.loaded.get(userId)
    if (!record) {
      record = (await this.store.get<StoredPush>(KEY(userId))) ?? { devices: [] }
      this.loaded.set(userId, record)
    }
    return record
  }

  private async save(userId: string, record: StoredPush) {
    this.loaded.set(userId, record)
    if (record.devices.length === 0 && !record.kinds) await this.store.delete(KEY(userId))
    else await this.store.put(KEY(userId), record)
  }

  async view(userId: string): Promise<PushView> {
    const record = await this.record(userId)
    return {
      enabled: this.enabled,
      ...(this.options.sender ? { publicKey: this.options.sender.publicKey } : {}),
      devices: record.devices.map(({ id, name, createdAt }) => ({ id, name, createdAt })),
      kinds: pushKinds(record.kinds),
    }
  }

  /**
   * `POST /api/push/subscribe`: this browser's subscription (`PushSubscription.toJSON()`), its
   * language for the texts. Subscribing the same endpoint again updates it (new keys, language);
   * an eleventh device drops the oldest
   */
  async subscribe(userId: string, body: { endpoint?: unknown; keys?: unknown; lang?: unknown }, userAgent: string): Promise<PushView> {
    this.requireSender()
    const endpoint = String(body.endpoint ?? '')
    const keys = (body.keys ?? {}) as { p256dh?: unknown; auth?: unknown }
    const p256dh = String(keys.p256dh ?? '')
    const auth = String(keys.auth ?? '')
    if (!allowedEndpoint(endpoint) || !validKeys(p256dh, auth)) throw new ClubError('pushBadSubscription')
    const id = await pushDeviceId(endpoint)
    const record = await this.record(userId)
    const old = record.devices.find((d) => d.id === id)
    const device: StoredDevice = {
      id,
      endpoint,
      p256dh,
      auth,
      lang: isLang(body.lang) ? body.lang : 'zh',
      name: deviceLabel(userAgent),
      createdAt: old?.createdAt ?? this.options.now(),
    }
    const devices = [...record.devices.filter((d) => d.id !== id), device].slice(-PUSH_DEVICES_MAX)
    await this.save(userId, { ...record, devices })
    return this.view(userId)
  }

  /** `POST /api/push/unsubscribe { id }`: one device stops getting pushes; an unknown id is ignored */
  async unsubscribe(userId: string, deviceId: string): Promise<PushView> {
    const record = await this.record(userId)
    await this.save(userId, { ...record, devices: record.devices.filter((d) => d.id !== deviceId) })
    return this.view(userId)
  }

  /** `POST /api/push/kinds { kinds }`: which kinds are pushed; kinds not named keep their choice */
  async setKinds(userId: string, wanted: unknown): Promise<PushView> {
    const record = await this.record(userId)
    const kinds = { ...record.kinds }
    if (wanted && typeof wanted === 'object') {
      for (const [kind, on] of Object.entries(wanted)) {
        if (!(NOTIFICATION_KINDS as readonly string[]).includes(kind) || typeof on !== 'boolean') continue
        const k = kind as NotificationKind
        // Only what differs from the default is kept
        if (on === !PUSH_OFF_BY_DEFAULT.includes(k)) delete kinds[k]
        else kinds[k] = on
      }
    }
    await this.save(userId, { ...record, kinds: Object.keys(kinds).length ? kinds : undefined })
    return this.view(userId)
  }

  /** `POST /api/push/test { id? }`: a test push to one device (or every one), even while online; how many devices */
  async test(userId: string, deviceId?: string): Promise<number> {
    this.requireSender()
    const now = this.options.now()
    if (now - (this.tested.get(userId) ?? -Infinity) < TEST_GAP_MS) throw new ClubError('slowDown', {}, 429)
    this.tested.set(userId, now)
    const record = await this.record(userId)
    const count = record.devices.filter((d) => !deviceId || d.id === deviceId).length
    if (count) this.add({ userId, message: (lang) => testPushMessage(lang, this.options.clubId), urgency: 'normal', ttl: HOUR_S, deviceId })
    return count
  }

  /** A new notification (worker/notifications.ts): pushed to the member's devices unless they are online or turned it off */
  queue(userId: string, n: Notification) {
    if (!this.options.sender) return
    this.add({
      userId,
      message: (lang) => pushMessage(n, lang, { forum: this.options.forum(userId), clubId: this.options.clubId }),
      urgency: URGENT.has(n.kind) ? 'high' : 'normal',
      ttl: SHORT_LIVED.has(n.kind) ? HOUR_S : DAY_S,
      kind: n.kind,
    })
  }

  private add(job: Job) {
    this.jobs.push(job)
    if (!this.running) this.start()
  }

  /** Sends what is queued after this turn (whatever else it notifies goes in the same batch) */
  private start() {
    const run = Promise.resolve()
      .then(() => this.drain())
      .catch(() => undefined)
      .finally(() => {
        this.running = null
        // Queued after the last batch was taken but before it finished
        if (this.jobs.length) this.start()
      })
    this.running = run
    this.options.defer(run)
  }

  /** Resolves once everything queued so far is sent (tests) */
  async idle() {
    while (this.running) await this.running
  }

  private async drain() {
    while (this.jobs.length) {
      const jobs = this.jobs
      this.jobs = []
      await this.flush(jobs)
    }
  }

  private async flush(jobs: Job[]) {
    const sender = this.options.sender
    if (!sender) return
    const sends: { userId: string; device: StoredDevice; data: string; urgency: PushUrgency; ttl: number }[] = []
    for (const job of jobs) {
      const kind = job.kind
      if (kind) {
        // Checked when sending, not when queued: they may have opened the site meanwhile
        if (this.options.online(job.userId)) continue
        if (!pushKinds((await this.record(job.userId)).kinds)[kind]) continue
      }
      for (const device of (await this.record(job.userId)).devices) {
        if (job.deviceId && device.id !== job.deviceId) continue
        const message = typeof job.message === 'function' ? job.message(device.lang) : job.message
        sends.push({ userId: job.userId, device, data: JSON.stringify(message), urgency: job.urgency, ttl: job.ttl })
      }
    }
    if (!sends.length) return
    let sent = 0
    let failed = 0
    const statuses = new Map<number, number>()
    const dead = new Map<string, Set<string>>()
    for (let i = 0; i < sends.length; i += PUSH_PARALLEL) {
      await Promise.all(
        sends.slice(i, i + PUSH_PARALLEL).map(async (s) => {
          let status = 0
          try {
            status = (await sender.send(s.device, s.data, { urgency: s.urgency, ttl: s.ttl })).status
          } catch {
            status = 0
          }
          if (status >= 200 && status < 300) sent++
          else {
            failed++
            statuses.set(status, (statuses.get(status) ?? 0) + 1)
          }
          if (status === 404 || status === 410) {
            const ids = dead.get(s.userId) ?? new Set<string>()
            ids.add(s.device.id)
            dead.set(s.userId, ids)
          }
        }),
      )
    }
    let removed = 0
    for (const [userId, ids] of dead) {
      const record = await this.record(userId)
      const devices = record.devices.filter((d) => !ids.has(d.id))
      removed += record.devices.length - devices.length
      await this.save(userId, { ...record, devices })
    }
    this.options.log({
      event: 'push',
      sent,
      failed,
      removed,
      ...(statuses.size ? { statuses: [...statuses].map(([status, count]) => `${status}:${count}`).join(',') } : {}),
    })
  }

  /** What the member's data export shows: each device's name and when it subscribed, never its keys */
  async exportOf(userId: string) {
    const view = await this.view(userId)
    return { devices: view.devices.map(({ name, createdAt }) => ({ name, createdAt })), kinds: view.kinds }
  }

  /** Every device of a member stops getting pushes (signed out everywhere, a new password) */
  async dropDevices(userId: string) {
    const record = await this.record(userId)
    if (record.devices.length) await this.save(userId, { ...record, devices: [] })
  }

  /** Removes everything a deleted account kept */
  async forget(userId: string) {
    this.loaded.delete(userId)
    await this.store.delete(KEY(userId))
  }
}
