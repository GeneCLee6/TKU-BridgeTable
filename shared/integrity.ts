/**
 * The anti-cheating report (防作弊報表, `e11-t25`, ARCHITECTURE.md §5.17): which members were seen
 * on the same network or the same browser, and whether those accounts then played together (at one
 * table, or in one challenge or team match). Pure: the types, the limits and how pairs are found and
 * ranked; the Worker keeps the sightings and reads the boards (`worker/integrity.ts`).
 *
 * The report is a lead for an admin to look into, never a verdict: nothing happens to anyone
 * because of it, and nobody but the admins sees it.
 */

/** How many days back the report can look; the first is the default */
export const INTEGRITY_DAYS = [30, 7, 90] as const
export type IntegrityDays = (typeof INTEGRITY_DAYS)[number]

export const INTEGRITY_LIMITS = {
  /** How long a sighting is kept: as long as the longest report window */
  keepDays: 90,
  /** Most sightings kept per member, the oldest dropped first */
  perMember: 16,
  /**
   * A network shared by more members than this is a shared network (the club room's Wi-Fi, the
   * campus, a mobile carrier's NAT): it links nobody, and the report only counts it
   */
  sharedNetwork: 4,
  /** Most pairs the report looks at (strongest first); the rest are only counted */
  pairs: 40,
  /** Most boards at one table listed per pair */
  boards: 5,
  /** Most events listed per pair */
  events: 10,
} as const

/** A sighting is written again at most this often for the same network and browser */
export const SIGHTING_STEP_MS = 60 * 60_000

/** Where and with what a member was signed in: a login or a club connection */
export interface Sighting {
  /** The network: a salted hash of the address, never the address itself; '' when unknown */
  net: string
  /** The browser: the random id in its `tbt_device` cookie; '' when it had none yet */
  device: string
  /** Browser and system from the User-Agent (`deviceLabel`), for the report to show */
  label: string
  first: number
  last: number
}

/** Days for the report: one of INTEGRITY_DAYS, the default otherwise */
export function integrityDays(value: unknown): IntegrityDays {
  const days = Number(value)
  return (INTEGRITY_DAYS as readonly number[]).includes(days) ? (days as IntegrityDays) : INTEGRITY_DAYS[0]
}

/**
 * A member's sightings with one more: the same network and browser is updated in place, the
 * oldest beyond `perMember` or older than `keepDays` go. Null when nothing needs writing (seen
 * there within SIGHTING_STEP_MS), so a reconnect costs one read and no write
 */
export function addSighting(
  list: readonly Sighting[],
  seen: { net: string; device: string; label: string },
  now: number,
): Sighting[] | null {
  if (!seen.net && !seen.device) return null
  const keepFrom = now - INTEGRITY_LIMITS.keepDays * 86_400_000
  const index = list.findIndex((s) => s.net === seen.net && s.device === seen.device)
  const old = index >= 0 ? list[index] : null
  if (old && now - old.last < SIGHTING_STEP_MS && old.label === seen.label) return null
  const next: Sighting = { ...seen, first: old?.first ?? now, last: now }
  return [next, ...list.filter((_, i) => i !== index)]
    .filter((s) => s.last >= keepFrom)
    .sort((a, b) => b.last - a.last)
    .slice(0, INTEGRITY_LIMITS.perMember)
}

/** Two members linked by what they share; `a` < `b` by id */
export interface Link {
  a: string
  b: string
  /** Browser labels both used (the same `tbt_device` cookie): one browser, two accounts */
  devices: string[]
  /** How many small networks both were seen on */
  networks: number
  /** The latest time either was seen on something they share */
  lastSeen: number
}

export interface SharedNetwork {
  /** A short label for the network (from its hash), so two reports can be compared */
  label: string
  members: number
  lastSeen: number
}

/**
 * Who shares a browser or a small network, from every member's sightings since `since`. A network
 * with more than `sharedNetwork` members links nobody and comes back in `shared` instead
 */
export function findLinks(sightings: ReadonlyMap<string, readonly Sighting[]>, since: number) {
  const byNet = new Map<string, Map<string, number>>()
  const byDevice = new Map<string, { label: string; users: Map<string, number> }>()
  for (const [userId, list] of sightings) {
    for (const s of list) {
      if (s.last < since) continue
      if (s.net) {
        const users = byNet.get(s.net) ?? new Map<string, number>()
        users.set(userId, Math.max(users.get(userId) ?? 0, s.last))
        byNet.set(s.net, users)
      }
      if (s.device) {
        const entry = byDevice.get(s.device) ?? { label: s.label, users: new Map<string, number>() }
        entry.users.set(userId, Math.max(entry.users.get(userId) ?? 0, s.last))
        if (s.label) entry.label = s.label
        byDevice.set(s.device, entry)
      }
    }
  }
  const links = new Map<string, Link>()
  const link = (x: string, y: string, last: number) => {
    const [a, b] = x < y ? [x, y] : [y, x]
    const key = `${a} ${b}`
    const found = links.get(key) ?? { a, b, devices: [], networks: 0, lastSeen: 0 }
    found.lastSeen = Math.max(found.lastSeen, last)
    links.set(key, found)
    return found
  }
  const pairsOf = (users: Map<string, number>, each: (link: Link) => void) => {
    const ids = [...users.keys()].sort()
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) each(link(ids[i], ids[j], Math.max(users.get(ids[i])!, users.get(ids[j])!)))
  }
  const shared: SharedNetwork[] = []
  for (const [net, users] of byNet) {
    if (users.size < 2) continue
    if (users.size > INTEGRITY_LIMITS.sharedNetwork) {
      shared.push({ label: net.slice(0, 6), members: users.size, lastSeen: Math.max(...users.values()) })
      continue
    }
    pairsOf(users, (found) => found.networks++)
  }
  for (const { label, users } of byDevice.values()) {
    if (users.size < 2) continue
    pairsOf(users, (found) => found.devices.push(label))
  }
  return { links: [...links.values()], shared: shared.sort((x, y) => y.members - x.members) }
}

/** What the two accounts of a link did together in the report's window */
export interface Together {
  /** Boards at one table as partners, and as opponents */
  partners: number
  opponents: number
  /** The newest of those boards (ids), for the admin to open */
  boards: string[]
  events: IntegrityEvent[]
}

/** A challenge or team match both accounts of a link played in */
export interface IntegrityEvent {
  id: string
  mode: 'challenge' | 'team'
  /** When the first of their boards in it was played */
  at: number
  /**
   * Who played all their boards after the other had finished theirs (`a` or `b`), so could have
   * been told the deals; null when they played at the same time (a team match's two rooms) or mixed
   */
  after: 'a' | 'b' | null
}

/**
 * How strong a lead is:
 * - `high`: one browser for both accounts, and they played together
 * - `medium`: one browser; or a small network, and they played together
 * - `low`: only a small network
 */
export type IntegrityLevel = 'high' | 'medium' | 'low'

export function integrityLevel(link: Pick<Link, 'devices'>, together: Together): IntegrityLevel {
  const played = together.partners + together.opponents + together.events.length > 0
  if (link.devices.length) return played ? 'high' : 'medium'
  return played ? 'medium' : 'low'
}

const LEVEL_ORDER: Record<IntegrityLevel, number> = { high: 0, medium: 1, low: 2 }

export interface IntegrityMember {
  id: string
  username: string
}

export interface IntegrityPair extends Together {
  a: IntegrityMember
  b: IntegrityMember
  level: IntegrityLevel
  devices: string[]
  networks: number
  lastSeen: number
}

/** `GET /api/admin/integrity?days=` */
export interface IntegrityReport {
  days: IntegrityDays
  generatedAt: number
  pairs: IntegrityPair[]
  /** Pairs beyond INTEGRITY_LIMITS.pairs, not looked at */
  more: number
  shared: SharedNetwork[]
  /** Members with any sighting in the window: how much the report could see */
  seen: number
  /** No network is kept (the Worker secret SEEN_SALT is not set): only browsers are compared */
  networkOff: boolean
}

/** Strongest first: level, then one browser before a network, then the most played together, then the newest */
export function comparePairs(x: IntegrityPair, y: IntegrityPair) {
  return (
    LEVEL_ORDER[x.level] - LEVEL_ORDER[y.level] ||
    y.devices.length - x.devices.length ||
    y.partners + y.opponents + y.events.length - (x.partners + x.opponents + x.events.length) ||
    y.lastSeen - x.lastSeen
  )
}

/** Links before the boards are read: one browser first, then the most networks, then the newest */
export function compareLinks(x: Link, y: Link) {
  return y.devices.length - x.devices.length || y.networks - x.networks || y.lastSeen - x.lastSeen
}
