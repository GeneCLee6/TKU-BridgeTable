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
import type {
  ClientMessage,
  LobbyView,
  NotificationsView,
  ServerMessage,
  TableView,
  TableWire,
} from '../../shared/protocol.ts'
import type { MessageParams } from '../../shared/messages.ts'
import { useAuth } from './AuthContext.tsx'

/**
 * The live connection to the club: one WebSocket per tab while signed in. The server pushes the
 * lobby and the viewer's table whenever they change for this viewer, so this context only stores
 * the latest of each (the table's chat and recent boards are kept when a push leaves them out).
 *
 * Phones drop idle connections without telling the page, and freeze tabs in the background. So
 * the page pings every few seconds and starts a new connection as soon as the old one has been
 * silent too long, when the tab comes back to the front, or when the network returns. Actions
 * made while it reconnects are sent once it is back, if they are still fresh.
 */

export type ConnectionStatus = 'connecting' | 'open' | 'closed'

interface Club {
  status: ConnectionStatus
  lobby: LobbyView | null
  table: TableView | null
  /** The bell in the header: the newest notifications and the unread count */
  notifications: NotificationsView | null
  error: { code: string; params: MessageParams; message: string; at: number } | null
  send: (message: ClientMessage) => void
  dismissError: () => void
}

const ClubContext = createContext<Club | null>(null)

/** How often the page checks the connection, and how long a silence means it is dead */
const PING_EVERY = 15_000
const SILENT_FOR = 40_000
/** After the tab comes back, how long to wait for an answer to a ping */
const WAKE_ANSWER = 4_000
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
  const [lobby, setLobby] = useState<LobbyView | null>(null)
  const [table, setTable] = useState<TableView | null>(null)
  const [notifications, setNotifications] = useState<NotificationsView | null>(null)
  const [error, setError] = useState<Club['error']>(null)
  const socket = useRef<WebSocket | null>(null)
  const waiting = useRef<{ message: ClientMessage; at: number }[]>([])

  useEffect(() => {
    if (!user) return
    let closed = false
    let attempt = 0
    let retry: ReturnType<typeof setTimeout> | undefined
    let lastHeard = Date.now()

    const flush = (ws: WebSocket) => {
      const fresh = waiting.current.filter((w) => Date.now() - w.at < QUEUE_FOR)
      waiting.current = []
      for (const { message } of fresh) ws.send(JSON.stringify(message))
    }

    const connect = () => {
      clearTimeout(retry)
      setStatus('connecting')
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      const ws = new WebSocket(`${protocol}//${location.host}/ws`)
      socket.current = ws
      ws.onopen = () => {
        attempt = 0
        lastHeard = Date.now()
        setStatus('open')
        flush(ws)
      }
      ws.onmessage = (event) => {
        lastHeard = Date.now()
        if (event.data === 'pong') return
        const message = JSON.parse(event.data) as ServerMessage
        if (message.type === 'lobby') setLobby(message.lobby)
        else if (message.type === 'table') setTable((previous) => mergeTable(previous, message.table, message.now))
        else if (message.type === 'notifications') setNotifications(message.notifications)
        else if (message.type === 'error')
          setError({ code: message.code, params: message.params, message: message.message, at: Date.now() })
      }
      ws.onclose = (event) => {
        if (socket.current !== ws) return
        socket.current = null
        if (closed) return
        setStatus('closed')
        // A rejected upgrade means the session expired
        if (event.code === 1006 && attempt > 3)
          void fetch('/api/me').then((r) => {
            if (r.status === 401) void logout()
          })
        retry = setTimeout(connect, Math.min(1000 * 2 ** attempt++, 10_000))
      }
    }

    /** Gives up on the current socket (it has gone quiet) and connects again at once */
    const reconnect = () => {
      const old = socket.current
      socket.current = null
      if (old) {
        old.onclose = null
        old.onmessage = null
        try {
          old.close()
        } catch {
          // Already closed
        }
      }
      attempt = 0
      connect()
    }

    const heartbeat = setInterval(() => {
      const ws = socket.current
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      if (Date.now() - lastHeard > SILENT_FOR) return reconnect()
      ws.send('ping')
    }, PING_EVERY)

    /** Back in front, or back online: make sure the connection still answers */
    const wake = () => {
      if (document.visibilityState === 'hidden' || closed) return
      const ws = socket.current
      if (!ws) return reconnect()
      if (ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) return reconnect()
      if (ws.readyState !== WebSocket.OPEN) return
      const asked = Date.now()
      ws.send('ping')
      setTimeout(() => {
        if (socket.current === ws && lastHeard < asked) reconnect()
      }, WAKE_ANSWER)
    }
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('online', wake)

    connect()

    return () => {
      closed = true
      clearTimeout(retry)
      clearInterval(heartbeat)
      document.removeEventListener('visibilitychange', wake)
      window.removeEventListener('online', wake)
      const ws = socket.current
      socket.current = null
      ws?.close()
      setLobby(null)
      setTable(null)
      setNotifications(null)
    }
  }, [user, logout])

  const send = useCallback((message: ClientMessage) => {
    const ws = socket.current
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
    else waiting.current.push({ message, at: Date.now() })
  }, [])

  const dismissError = useCallback(() => setError(null), [])

  const value = useMemo(
    () => ({ status, lobby, table, notifications, error, send, dismissError }),
    [status, lobby, table, notifications, error, send, dismissError],
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
