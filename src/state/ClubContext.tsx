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
  ServerMessage,
  TableView,
} from '../../shared/protocol.ts'
import type { MessageParams } from '../../shared/messages.ts'
import { useAuth } from './AuthContext.tsx'

/**
 * The live connection to the club: one WebSocket per tab while signed in. The server pushes the
 * whole lobby and the viewer's table after every change, so this context only stores the latest
 * of each. It reconnects with backoff, and the server restores the table on reconnect.
 */

export type ConnectionStatus = 'connecting' | 'open' | 'closed'

interface Club {
  status: ConnectionStatus
  lobby: LobbyView | null
  table: TableView | null
  error: { code: string; params: MessageParams; message: string; at: number } | null
  send: (message: ClientMessage) => void
  dismissError: () => void
}

const ClubContext = createContext<Club | null>(null)

export function ClubProvider({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth()
  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const [lobby, setLobby] = useState<LobbyView | null>(null)
  const [table, setTable] = useState<TableView | null>(null)
  const [error, setError] = useState<Club['error']>(null)
  const socket = useRef<WebSocket | null>(null)

  useEffect(() => {
    if (!user) return
    let closed = false
    let attempt = 0
    let timer: ReturnType<typeof setTimeout> | undefined

    const connect = () => {
      setStatus('connecting')
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      const ws = new WebSocket(`${protocol}//${location.host}/ws`)
      socket.current = ws
      ws.onopen = () => {
        attempt = 0
        setStatus('open')
      }
      ws.onmessage = (event) => {
        const message = JSON.parse(event.data) as ServerMessage
        if (message.type === 'lobby') setLobby(message.lobby)
        else if (message.type === 'table') setTable(message.table)
        else if (message.type === 'error')
          setError({ code: message.code, params: message.params, message: message.message, at: Date.now() })
      }
      ws.onclose = (event) => {
        if (socket.current === ws) socket.current = null
        if (closed) return
        setStatus('closed')
        // A rejected upgrade means the session expired
        if (event.code === 1006 && attempt > 3)
          void fetch('/api/me').then((r) => {
            if (r.status === 401) void logout()
          })
        timer = setTimeout(connect, Math.min(1000 * 2 ** attempt++, 10_000))
      }
    }
    connect()

    return () => {
      closed = true
      clearTimeout(timer)
      socket.current?.close()
      socket.current = null
      setLobby(null)
      setTable(null)
    }
  }, [user, logout])

  const send = useCallback((message: ClientMessage) => {
    const ws = socket.current
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
  }, [])

  const dismissError = useCallback(() => setError(null), [])

  const value = useMemo(
    () => ({ status, lobby, table, error, send, dismissError }),
    [status, lobby, table, error, send, dismissError],
  )
  return <ClubContext.Provider value={value}>{children}</ClubContext.Provider>
}

// oxlint-disable-next-line react/only-export-components
export function useClub(): Club {
  const ctx = useContext(ClubContext)
  if (!ctx) throw new Error('useClub must be used inside ClubProvider')
  return ctx
}
