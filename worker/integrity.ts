import {
  addSighting,
  compareLinks,
  comparePairs,
  findLinks,
  INTEGRITY_LIMITS,
  integrityLevel,
  type IntegrityDays,
  type IntegrityEvent,
  type IntegrityMember,
  type IntegrityReport,
  type Sighting,
  type Together,
} from '../shared/integrity.ts'
import type { Sql, Store } from './store.ts'

/**
 * The anti-cheating report's data (`e11-t25`, ARCHITECTURE.md §5.17). Sightings are kept at
 * `seen:<userId>` (at most INTEGRITY_LIMITS.perMember, 90 days): the network as a salted hash of the
 * address and the browser as the id in its `tbt_device` cookie. The salt is the Worker secret
 * `SEEN_SALT` (DEPLOY.md), never the club's storage, so a copy of the storage alone cannot be
 * walked back to addresses; without it no network is kept, only the browser. The address itself
 * is never written. Who played together is read from the club's own history index
 * (`boards_index`, `board_players`), a few indexed queries per pair.
 */

const KEY = 'seen:'
/** Shorter than this is no salt at all (an IPv4 address with a guessable salt is easy to walk back) */
export const SEEN_SALT_MIN = 16

/** The salt to hash addresses with, or null when `SEEN_SALT` is unset or too short to count */
export function seenSalt(value: string | undefined): string | null {
  return value && value.length >= SEEN_SALT_MIN ? value : null
}

export class Sightings {
  private readonly store: Store
  private readonly now: () => number
  private readonly salt: string | null

  constructor(store: Store, now: () => number, salt: string | null) {
    this.store = store
    this.now = now
    this.salt = salt
  }

  /** Whether networks are kept (`SEEN_SALT` is set); browsers are kept either way */
  get networks() {
    return this.salt !== null
  }

  private async network(address: string): Promise<string> {
    if (!address || !this.salt) return ''
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${this.salt}:${address}`))
    return [...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('')
  }

  /** Notes that the member was signed in from `address` with the browser `device` (one read; a write only when something changed) */
  async note(userId: string, address: string, device: string, label: string) {
    const net = await this.network(address)
    const list = (await this.store.get<Sighting[]>(KEY + userId)) ?? []
    const next = addSighting(list, { net, device: /^[\w-]{1,64}$/.test(device) ? device : '', label }, this.now())
    if (next) await this.store.put(KEY + userId, next)
  }

  /** The member's own sightings (their data export) */
  async of(userId: string): Promise<Sighting[]> {
    return (await this.store.get<Sighting[]>(KEY + userId)) ?? []
  }

  async forget(userId: string) {
    await this.store.delete(KEY + userId)
  }

  /** Every member's sightings, by member id */
  async all(): Promise<Map<string, Sighting[]>> {
    const found = new Map<string, Sighting[]>()
    for (const [key, list] of await this.store.list<Sighting[]>(KEY)) found.set(key.slice(KEY.length), list)
    return found
  }
}

interface BoardRow extends Record<string, string | number | null> {
  board_id: string
  played_at: number
  side_a: string
  side_b: string
}

interface EventRow extends Record<string, string | number | null> {
  event_id: string
  mode: string
  user_id: string
  first: number
  last: number
}

/** What `a` and `b` did together since `since`, from the club's history index */
export function together(sql: Sql, a: string, b: string, since: number): Together {
  // Boards at one table: a's seat and b's seat on the same board
  const boards = sql.exec<BoardRow>(
    `SELECT pa.board_id AS board_id, bi.played_at AS played_at, pa.side AS side_a, pb.side AS side_b
       FROM board_players pa
       JOIN board_players pb ON pb.board_id = pa.board_id AND pb.user_id = ?
       JOIN boards_index bi ON bi.board_id = pa.board_id
      WHERE pa.user_id = ? AND bi.played_at >= ?
      ORDER BY bi.played_at DESC`,
    b,
    a,
    since,
  )
  // Challenges and team matches both took part in, each one's first and last board per member
  const rows = sql.exec<EventRow>(
    `SELECT bi.event_id AS event_id, bi.mode AS mode, bp.user_id AS user_id,
            MIN(bi.played_at) AS first, MAX(bi.played_at) AS last
       FROM boards_index bi
       JOIN board_players bp ON bp.board_id = bi.board_id
      WHERE bi.event_id IS NOT NULL AND bi.played_at >= ? AND bp.user_id IN (?, ?)
        AND bi.mode IN ('challenge', 'team')
      GROUP BY bi.event_id, bp.user_id`,
    since,
    a,
    b,
  )
  const byEvent = new Map<string, { mode: string; a?: EventRow; b?: EventRow }>()
  for (const row of rows) {
    const entry = byEvent.get(row.event_id) ?? { mode: row.mode }
    if (row.user_id === a) entry.a = row
    else entry.b = row
    byEvent.set(row.event_id, entry)
  }
  const events: IntegrityEvent[] = []
  for (const [id, entry] of byEvent) {
    if (!entry.a || !entry.b) continue
    const after = entry.b.first > entry.a.last ? 'b' : entry.a.first > entry.b.last ? 'a' : null
    events.push({ id, mode: entry.mode === 'team' ? 'team' : 'challenge', at: Math.min(entry.a.first, entry.b.first), after })
  }
  events.sort((x, y) => y.at - x.at)
  return {
    partners: boards.filter((row) => row.side_a === row.side_b).length,
    opponents: boards.filter((row) => row.side_a !== row.side_b).length,
    boards: boards.slice(0, INTEGRITY_LIMITS.boards).map((row) => row.board_id),
    events: events.slice(0, INTEGRITY_LIMITS.events),
  }
}

/**
 * The report: links from the sightings in the window (only between current members), the
 * strongest INTEGRITY_LIMITS.pairs of them with what they played together, strongest first
 */
export function integrityReport(input: {
  sql: Sql
  sightings: ReadonlyMap<string, readonly Sighting[]>
  member: (id: string) => IntegrityMember | null
  days: IntegrityDays
  now: number
  /** Whether networks are kept (`SEEN_SALT` is set) */
  networks: boolean
}): IntegrityReport {
  const { sql, member, days, now } = input
  const since = now - days * 86_400_000
  const current = new Map([...input.sightings].filter(([id]) => member(id)))
  const { links, shared } = findLinks(current, since)
  links.sort(compareLinks)
  const looked = links.slice(0, INTEGRITY_LIMITS.pairs)
  const pairs = looked
    .map((link) => {
      const played = together(sql, link.a, link.b, since)
      return {
        a: member(link.a)!,
        b: member(link.b)!,
        level: integrityLevel(link, played),
        devices: link.devices,
        networks: link.networks,
        lastSeen: link.lastSeen,
        ...played,
      }
    })
    .sort(comparePairs)
  const seen = [...current.values()].filter((list) => list.some((s) => s.last >= since)).length
  return { days, generatedAt: now, pairs, more: links.length - looked.length, shared, seen, networkOff: !input.networks }
}
