import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  isTableAction,
  TABLE_SOCKET_PREFIX,
  TABLE_SOCKET_REFUSED,
  type ClientMessage,
  type DirectMessage,
  type DirectsView,
  type LobbyMine,
  type LobbyShared,
  type LobbyView,
  type NotificationsView,
  type ServerMessage,
  type TableView,
  type TableWire,
} from '../../shared/protocol.ts'
import type { TeamMatchView } from '../../shared/team-match.ts'
import { composeLobby, emptyReplica, receiveLobby } from '../../shared/lobby.ts'
import type { MessageParams } from '../../shared/messages.ts'
import { liveSocket, type ConnectionStatus, type LiveSocket } from '../lib/liveSocket.ts'
import { useAuth } from './AuthContext.tsx'

/**
 * The live connections while signed in (ARCHITECTURE.md §5.10): one to the club (`/ws`: the lobby,
 * notifications, messages, matches, and moving between tables) and, while the member is at a
 * table, one to that table (`/ws/table/<id>`: its view, bidding, play and chat). The server pushes
 * the lobby and the viewer's table whenever they change for this viewer, so this context only
 * stores the latest of each (the table's chat and recent boards are kept when a push leaves them
 * out). The lobby comes in two parts (H3b): the part everyone shares, whole and then as deltas
 * (`receiveLobby` keeps the copy, asking for it whole when a version is missing), and the viewer's
 * own; the page puts them together (`composeLobby`), sorting as the server used to. Both connections are kept alive alike (`src/lib/liveSocket.ts`). A table action goes over
 * the table's connection when it is open, else over the club's, which hands it to the table.
 * Actions made while reconnecting are sent once a connection is back, if they are still fresh.
 */

export type { ConnectionStatus }

interface Club {
  status: ConnectionStatus
  lobby: LobbyView | null
  table: TableView | null
  /** The bell in the header: the newest notifications and the unread count */
  notifications: NotificationsView | null
  /** The viewer's conversations and unread direct messages (AC-1.7) */
  directs: DirectsView | null
  /** Direct messages that arrived over this connection, oldest first; a conversation adds them to the page it loaded */
  directLive: DirectMessage[]
  error: { code: string; params: MessageParams; message: string; at: number } | null
  /** The latest team match pushed to the viewer (§5.8); the prep room takes it when it is the one shown */
  matchLive: { matchId: string; match: TeamMatchView | null } | null
  send: (message: ClientMessage) => void
  dismissError: () => void
}

const ClubContext = createContext<Club | null>(null)

/** How many arrived direct messages the page keeps */
const LIVE_KEPT = 200
/** Actions made while reconnecting go out once the connection is back if they are this recent */
const QUEUE_FOR = 8_000

/** A pushed table as the page keeps it: the server's times (`dealAt`, the board's time limit, the wait) turned into this browser's clock */
function mergeTable(previous: TableView | null, wire: TableWire | null, serverNow: number): TableView | null {
  if (!wire) return null
  const keep = previous && previous.id === wire.id ? previous : null
  const local = (at: number) => at - serverNow + Date.now()
  return {
    ...wire,
    dealAt: wire.dealAt === null ? null : local(wire.dealAt),
    boardEndsAt: wire.boardEndsAt == null ? null : local(wire.boardEndsAt),
    // The same wait keeps the time first worked out, so it does not jitter with every message
    waiting: !wire.waiting
      ? null
      : keep?.waiting?.seat === wire.waiting.seat && Math.abs(keep.waiting.since - local(wire.waiting.since)) < 1000
        ? keep.waiting
        : { ...wire.waiting, since: local(wire.waiting.since) },
    chat: wire.chat ?? keep?.chat ?? [],
    recent: wire.recent ?? keep?.recent ?? [],
  }
}

export function ClubProvider({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth()
  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const [shared, setShared] = useState<LobbyShared | null>(null)
  const [mine, setMine] = useState<LobbyMine | null>(null)
  /** The copy of the shared lobby and the deltas that came early (`receiveLobby`) */
  const replica = useRef(emptyReplica())
  const [table, setTable] = useState<TableView | null>(null)
  const [notifications, setNotifications] = useState<NotificationsView | null>(null)
  const [directs, setDirects] = useState<DirectsView | null>(null)
  const [directLive, setDirectLive] = useState<DirectMessage[]>([])
  const [error, setError] = useState<Club['error']>(null)
  const [matchLive, setMatchLive] = useState<Club['matchLive']>(null)
  const clubSocket = useRef<LiveSocket | null>(null)
  const tableSocket = useRef<LiveSocket | null>(null)
  const waiting = useRef<{ message: ClientMessage; at: number }[]>([])
  const lobby = useMemo(() => (shared && mine ? composeLobby(shared, mine) : null), [shared, mine])
  const myTableId = mine?.myTableId ?? null

  /** Every message from either connection */
  const receive = useCallback((message: ServerMessage) => {
    if (message.type === 'lobbyShared' || message.type === 'lobbyDelta') {
      const { replica: next, sync } = receiveLobby(replica.current, message)
      replica.current = next
      setShared(next.copy?.lobby ?? null)
      if (sync) clubSocket.current?.send(JSON.stringify({ type: 'lobbySync' } satisfies ClientMessage))
    } else if (message.type === 'lobbyMine') setMine(message.mine)
    else if (message.type === 'table') setTable((previous) => mergeTable(previous, message.table, message.now))
    else if (message.type === 'notifications') setNotifications(message.notifications)
    else if (message.type === 'directs') setDirects(message.directs)
    else if (message.type === 'direct') setDirectLive((live) => [...live, message.message].slice(-LIVE_KEPT))
    else if (message.type === 'match') setMatchLive({ matchId: message.matchId, match: message.match })
    else if (message.type === 'error') setError({ code: message.code, params: message.params, message: message.message, at: Date.now() })
  }, [])

  /** Sends what waited while reconnecting, if still fresh: the club takes everything, a table only its own actions */
  const flush = useCallback((socket: LiveSocket, tableOnly: boolean) => {
    const fresh = waiting.current.filter((w) => Date.now() - w.at < QUEUE_FOR)
    waiting.current = fresh.filter(({ message }) => (tableOnly && !isTableAction(message)) || !socket.send(JSON.stringify(message)))
  }, [])

  useEffect(() => {
    if (!user) return
    const socket = liveSocket({
      path: '/ws',
      onMessage: receive,
      onStatus: setStatus,
      onOpen: () => flush(socket, false),
      onRefused: () =>
        void fetch('/api/me').then((r) => {
          if (r.status === 401) void logout()
        }),
    })
    clubSocket.current = socket
    return () => {
      clubSocket.current = null
      socket.close()
      replica.current = emptyReplica()
      setShared(null)
      setMine(null)
      setTable(null)
      setNotifications(null)
      setDirects(null)
      setDirectLive([])
      setMatchLive(null)
    }
  }, [user, logout, receive, flush])

  // The table's own connection, while the lobby says the member is at a table; changing tables
  // closes the old one. A table that turns the member away (they are not at it) is not tried again
  useEffect(() => {
    if (!user || !myTableId) return
    const socket = liveSocket({
      path: `${TABLE_SOCKET_PREFIX}${encodeURIComponent(myTableId)}`,
      onMessage: receive,
      onOpen: () => flush(socket, true),
      stopOn: [TABLE_SOCKET_REFUSED],
    })
    tableSocket.current = socket
    return () => {
      if (tableSocket.current === socket) tableSocket.current = null
      socket.close()
    }
  }, [user, myTableId, receive, flush])

  const send = useCallback((message: ClientMessage) => {
    const data = JSON.stringify(message)
    if (isTableAction(message) && tableSocket.current?.send(data)) return
    if (clubSocket.current?.send(data)) return
    waiting.current.push({ message, at: Date.now() })
  }, [])

  const dismissError = useCallback(() => setError(null), [])

  const value = useMemo(
    () => ({ status, lobby, table, notifications, directs, directLive, error, matchLive, send, dismissError }),
    [status, lobby, table, notifications, directs, directLive, error, matchLive, send, dismissError],
  )
  return <ClubContext.Provider value={value}>{children}</ClubContext.Provider>
}

// oxlint-disable-next-line react/only-export-components
export function useClub(): Club {
  const ctx = useContext(ClubContext)
  if (!ctx) throw new Error('useClub must be used inside ClubProvider')
  return ctx
}

/** The lobby, or null outside a ClubProvider or before it arrives; for pages that only need the member list */
// oxlint-disable-next-line react/only-export-components
export function useLobby(): LobbyView | null {
  return useContext(ClubContext)?.lobby ?? null
}
