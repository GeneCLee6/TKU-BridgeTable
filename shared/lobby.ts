import { SEATS, type Seat } from './cards.ts'
import type { LobbyDelta, LobbyMine, LobbyShared, LobbyView, MemberStatus, ServerMessage, TableSummary } from './protocol.ts'

/** How the lobby lists tables and where 快速入座 sits (AC-2.11) */

/** The part of a table these rules look at */
export interface LobbyTable {
  number: number
  seats: Record<Seat, unknown>
}

/** Empty seats; a robot's seat is taken (a person may still take it from the table) */
export const missingSeats = (table: LobbyTable) => SEATS.filter((seat) => !table.seats[seat]).length

/**
 * The lobby's order: tables short of players first, the ones closest to starting (fewest seats
 * missing) on top, then full tables; by table number within each
 */
export function lobbyOrder(a: LobbyTable, b: LobbyTable): number {
  const ma = missingSeats(a)
  const mb = missingSeats(b)
  if (!ma !== !mb) return ma ? -1 : 1
  return ma - mb || a.number - b.number
}

/**
 * Where 快速入座 sits: the first table in the lobby's order that is short of players, among the
 * ones the member may sit at, and its first empty seat (South, then North, East, West); null when
 * no table needs anyone
 */
export function quickSeatChoice<T extends LobbyTable>(tables: T[]): { table: T; seat: Seat } | null {
  const table = [...tables].sort(lobbyOrder).find((t) => missingSeats(t) > 0)
  if (!table) return null
  const seat = (['S', 'N', 'E', 'W'] as const).find((s) => !table.seats[s])!
  return { table, seat }
}

// ── The lobby in two parts (H3b, ARCHITECTURE.md §5.13) ─────────────────────────────────────────

/**
 * The People panel's order: online first; within each, the viewer's friends on top (好友置頂),
 * then by name
 */
export function memberOrder(friends: ReadonlySet<string>) {
  const rank = (m: MemberStatus) => (m.online ? 0 : 2) + (friends.has(m.id) ? 0 : 1)
  return (a: MemberStatus, b: MemberStatus) => rank(a) - rank(b) || a.username.localeCompare(b.username)
}

/**
 * The lobby as a viewer sees it, from the part everyone shares and the viewer's own: the tables
 * listed for everyone with whether the viewer may come in, and the viewer's own hidden ones, in
 * the lobby's order; every member in the People panel's order, placed at the viewer's own tables too
 */
export function composeLobby(shared: LobbyShared, mine: LobbyMine): LobbyView {
  const welcome = new Set(mine.welcome)
  const requested = new Set(mine.requested)
  const tables: TableSummary[] = [
    ...shared.tables.map((t) => ({ ...t, welcome: welcome.has(t.id), ...(requested.has(t.id) && { requested: true as const }) })),
    ...mine.tables,
  ].sort(lobbyOrder)
  const members = shared.members
    .map((m) => {
      const place = mine.places[m.id]
      return place ? { ...m, ...place } : m
    })
    .sort(memberOrder(new Set(mine.friends)))
  return {
    online: members.filter((m) => m.online).map(({ id, username, avatar }) => ({ id, username, ...(avatar && { avatar }) })),
    members,
    tables,
    myTableId: mine.myTableId,
    ...(mine.myTableMode && { myTableMode: mine.myTableMode }),
    friends: mine.friends,
    blocked: mine.blocked,
    matches: shared.matches,
  }
}

/** Puts a delta into a copy of the shared lobby: entries replaced or removed by id */
export function applyLobbyDelta(lobby: LobbyShared, delta: LobbyDelta): LobbyShared {
  const merge = <T extends { id: string }>(list: T[], changed: T[] | undefined, removed: string[] | undefined) => {
    if (!changed?.length && !removed?.length) return list
    const byId = new Map(list.map((x) => [x.id, x]))
    for (const id of removed ?? []) byId.delete(id)
    for (const x of changed ?? []) byId.set(x.id, x)
    return [...byId.values()]
  }
  return {
    members: merge(lobby.members, delta.members, delta.gone),
    tables: merge(lobby.tables, delta.tables, delta.closed),
    matches: delta.matches ?? lobby.matches,
  }
}

export type LobbySharedMessage = Extract<ServerMessage, { type: 'lobbyShared' | 'lobbyDelta' }>
type DeltaMessage = Extract<ServerMessage, { type: 'lobbyDelta' }>

/** The browser's copy of the shared lobby: the version it holds, and deltas that came early */
export interface LobbyReplica {
  copy: { epoch: number; rev: number; lobby: LobbyShared } | null
  /** Deltas past a version not received yet, applied once it comes */
  early: DeltaMessage[]
  /** Asked the club for the whole lobby (`lobbySync`) and waiting for it */
  asked: boolean
}

export const emptyReplica = (): LobbyReplica => ({ copy: null, early: [], asked: false })

/** How many early deltas the copy keeps while it waits for the whole lobby */
const EARLY_KEPT = 50

/**
 * Takes a shared lobby message into the copy: the whole lobby replaces it (and the deltas that came
 * early and follow it apply); a delta applies when it follows the version held, is dropped when
 * already held (or from an earlier run of the club), and otherwise waits. `sync`: the copy is
 * missing a version, so the browser should ask for the whole lobby (once, until it comes)
 */
export function receiveLobby(replica: LobbyReplica, message: LobbySharedMessage): { replica: LobbyReplica; sync: boolean } {
  let { copy, early, asked } = replica
  if (message.type === 'lobbyShared') {
    copy = { epoch: message.epoch, rev: message.rev, lobby: message.lobby }
    asked = false
  } else {
    const stale = copy && (message.epoch < copy.epoch || (message.epoch === copy.epoch && message.rev <= copy.rev))
    if (stale) return { replica, sync: false }
    early = [...early.filter((d) => d.rev !== message.rev || d.epoch !== message.epoch), message].slice(-EARLY_KEPT)
  }
  // Apply whatever follows the version held, in order; drop what it already has (a newer run's
  // deltas wait for that run's whole lobby)
  if (copy) {
    const held = copy
    early = early
      .filter((d) => d.epoch > held.epoch || (d.epoch === held.epoch && d.rev > held.rev))
      .sort((a, b) => a.epoch - b.epoch || a.rev - b.rev)
    while (early.length && early[0].epoch === copy.epoch && early[0].base === copy.rev) {
      const next = early.shift()!
      copy = { epoch: copy.epoch, rev: next.rev, lobby: applyLobbyDelta(copy.lobby, next.delta) }
    }
  }
  const missing = !copy || early.length > 0
  const sync = missing && !asked
  return { replica: { copy, early, asked: asked || sync }, sync }
}
