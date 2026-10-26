/// <reference types="node" />
import { ChallengeStore } from '../../worker/challenges.ts'
import { EventHost } from '../../worker/event-host.ts'
import { RemoteEvents, type EventRpc } from '../../worker/events.ts'
import { noLog } from '../../worker/log.ts'
import { AlarmQueue, manualScheduler, type Scheduler } from '../../worker/scheduler.ts'
import { ClubService, type ClubConfig, type Connections } from '../../worker/service.ts'
import type { Sql, Store } from '../../worker/store.ts'
import { memorySql } from './sqlite.ts'

/**
 * The challenge and team match tests run twice (`vite.config.ts`, the project `event-objects`):
 * as they are, every challenge in the club's object (the switch off, the default), and with
 * `TBT_EVENT_OBJECTS=on`, every challenge in its own `EventObject` (H2b, ARCHITECTURE.md §5.12).
 * Each object is an `EventHost` with its own storage and SQLite database, reached through
 * `RemoteEvents` behind a structured clone (as RPC copies everything); its jobs go to the test's
 * own queue (`schedule`), so the tests run them as they always did.
 */
export const EVENT_OBJECTS = process.env.TBT_EVENT_OBJECTS === 'on'

/** One challenge's object: its storage and database outlive the host, which is dropped on eviction */
export interface FakeEventObject {
  storage: Map<string, unknown>
  sql: Sql
  host: EventHost
}

/** The objects of one club's store, and the club they report to (the latest one made on that store) */
interface World {
  objects: Map<string, FakeEventObject>
  club: ClubService | null
  scheduler: Scheduler
  /** The test's queue: each object (each host, after an eviction too) has its own jobs in it */
  schedule?: ClubConfig['schedule']
  now: () => number
  /** Objects that fail every call (RPC down) */
  failing: Set<string>
}

const worlds = new WeakMap<Store, World>()
const byClub = new WeakMap<ClubService, World>()

const clone = <T>(value: T): T => (value === undefined ? value : structuredClone(value))

function makeHost(world: World, parts: Omit<FakeEventObject, 'host'>): EventHost {
  return new EventHost({
    storage: {
      get: async (key) => clone(parts.storage.get(key)) as never,
      put: async (key, value) => void parts.storage.set(key, clone(value)),
      delete: async (key) => void parts.storage.delete(key),
      clear: async () => parts.storage.clear(),
    },
    sql: parts.sql,
    club: {
      changed: async (snapshot) => {
        if (!world.club) throw new Error('no club')
        await world.club.eventLink.changed(clone(snapshot))
      },
    },
    // An object's jobs are its own, and gone when it is evicted (they are scheduled again on load)
    scheduler: world.schedule ? manualScheduler(world.schedule) : world.scheduler,
    now: world.now,
    log: noLog,
  })
}

/** A challenge's object, made (and loaded) the first time it is called */
async function objectOf(world: World, id: string): Promise<FakeEventObject> {
  let found = world.objects.get(id)
  if (!found) {
    const parts = { storage: new Map<string, unknown>(), sql: memorySql() }
    found = { ...parts, host: makeHost(world, parts) }
    world.objects.set(id, found)
    await found.host.load()
  }
  return found
}

function stub(world: World, id: string): EventRpc {
  return new Proxy({} as EventRpc, {
    get:
      (_, name: string) =>
      async (...args: unknown[]) => {
        if (world.failing.has(id)) throw new Error('object unavailable')
        const host = (await objectOf(world, id)).host as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
        return clone(await host[name](...clone(args)))
      },
  })
}

/**
 * The club the tests use: as given with the switch off; with it on, with every challenge in its
 * own fake object (`objects` forces either). The objects of a store survive a new club made on
 * it (the club's object evicted), as Durable Objects do
 */
export function clubService(store: Store, connections: Connections, config: ClubConfig, objects = EVENT_OBJECTS): ClubService {
  if (!objects) return new ClubService(store, connections, config)
  const now = config.now ?? Date.now
  const scheduler: Scheduler = config.schedule
    ? manualScheduler(config.schedule)
    : new AlarmQueue(now, (at) => void setTimeout(() => void (scheduler as AlarmQueue).runDue(), Math.max(0, at - now())))
  const known = worlds.get(store)
  // A new club on a store that had one: the whole Worker was evicted, the objects too. Their jobs
  // go to the new club's queue (jobs are not stored), and they load again with the club
  const world: World = known ?? { objects: new Map(), club: null, now, scheduler, failing: new Set() }
  world.now = now
  world.scheduler = scheduler
  world.schedule = config.schedule
  worlds.set(store, world)
  const club = new ClubService(store, connections, {
    ...config,
    eventObjects: new RemoteEvents((id) => stub(world, id)),
    eventObjectsOn: config.eventObjectsOn ?? true,
  })
  world.club = club
  byClub.set(club, world)
  if (known) {
    const load = club.load.bind(club)
    club.load = async () => {
      for (const id of world.objects.keys()) await evictEventObject(club, id)
      await load()
    }
  }
  return club
}

/** The challenge's object, if it has one (tests of the switch on) */
export function eventObject(club: ClubService, id: string): FakeEventObject | undefined {
  return byClub.get(club)?.objects.get(id)
}

/** Every object of the club's store */
export function eventObjects(club: ClubService): Map<string, FakeEventObject> {
  return byClub.get(club)?.objects ?? new Map()
}

/** Makes a challenge's object fail every call (true) or answer again (false) */
export function failEventObject(club: ClubService, id: string, failing: boolean) {
  const world = byClub.get(club)!
  if (failing) world.failing.add(id)
  else world.failing.delete(id)
}

/** The object is evicted: a new host loads from the same storage and database */
export async function evictEventObject(club: ClubService, id: string) {
  const world = byClub.get(club)!
  const found = world.objects.get(id)!
  found.host = makeHost(world, found)
  await found.host.load()
}

/**
 * Writes straight into a challenge, as a test sets one up: into the club's tables, and into its
 * object's when it has one, so both keep the same challenge
 */
export function writeChallenge(club: ClubService, id: string, write: (store: ChallengeStore) => void) {
  write(club.challenges)
  const object = eventObject(club, id)
  if (object) write(new ChallengeStore(object.sql))
}
