import type { ServerMessage } from '../../shared/protocol.ts'

/**
 * One live connection to the server (the club's `/ws`, or a table's `/ws/table/<id>`, ARCHITECTURE.md
 * §5.10), kept alive the same way for both.
 *
 * Phones drop idle connections without telling the page, and freeze tabs in the background. So
 * the page pings every few seconds and starts a new connection as soon as the old one has been
 * silent too long, when the tab comes back to the front, or when the network returns. A connection
 * that closes is opened again with a growing pause, unless it closed with one of `stopOn`.
 */

export type ConnectionStatus = 'connecting' | 'open' | 'closed'

/** How often the page checks the connection, and how long a silence means it is dead */
const PING_EVERY = 15_000
const SILENT_FOR = 40_000
/** After the tab comes back, how long to wait for an answer to a ping */
const WAKE_ANSWER = 4_000

export interface LiveSocketOptions {
  path: string
  onMessage: (message: ServerMessage) => void
  /** The connection (re)opened: what was waiting can go out */
  onOpen?: () => void
  onStatus?: (status: ConnectionStatus) => void
  /** Close codes after which it does not connect again (a table that turned the member away) */
  stopOn?: number[]
  /** The connection keeps failing to open: perhaps the session expired */
  onRefused?: () => void
}

export interface LiveSocket {
  /** Sends when the connection is open; false when it is not (the caller keeps the message) */
  send: (data: string) => boolean
  /** Closes it for good */
  close: () => void
}

export function liveSocket(options: LiveSocketOptions): LiveSocket {
  let closed = false
  let attempt = 0
  let retry: ReturnType<typeof setTimeout> | undefined
  let lastHeard = Date.now()
  let socket: WebSocket | null = null
  const status = (value: ConnectionStatus) => options.onStatus?.(value)

  const connect = () => {
    clearTimeout(retry)
    status('connecting')
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${protocol}//${location.host}${options.path}`)
    socket = ws
    ws.onopen = () => {
      attempt = 0
      lastHeard = Date.now()
      status('open')
      options.onOpen?.()
    }
    ws.onmessage = (event) => {
      if (socket !== ws) return
      lastHeard = Date.now()
      if (event.data === 'pong') return
      options.onMessage(JSON.parse(event.data) as ServerMessage)
    }
    ws.onclose = (event) => {
      if (socket !== ws) return
      socket = null
      if (closed) return
      status('closed')
      if (options.stopOn?.includes(event.code)) return stop()
      // A rejected upgrade (1006 again and again) may mean the session expired
      if (event.code === 1006 && attempt > 3) options.onRefused?.()
      retry = setTimeout(connect, Math.min(1000 * 2 ** attempt++, 10_000))
    }
  }

  /** Gives up on the current socket (it has gone quiet) and connects again at once */
  const reconnect = () => {
    const old = socket
    socket = null
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
    const ws = socket
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    if (Date.now() - lastHeard > SILENT_FOR) return reconnect()
    ws.send('ping')
  }, PING_EVERY)

  /** Back in front, or back online: make sure the connection still answers */
  const wake = () => {
    if (document.visibilityState === 'hidden' || closed) return
    const ws = socket
    if (!ws) return reconnect()
    if (ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) return reconnect()
    if (ws.readyState !== WebSocket.OPEN) return
    const asked = Date.now()
    ws.send('ping')
    setTimeout(() => {
      if (socket === ws && lastHeard < asked) reconnect()
    }, WAKE_ANSWER)
  }
  document.addEventListener('visibilitychange', wake)
  window.addEventListener('online', wake)

  function stop() {
    closed = true
    clearTimeout(retry)
    clearInterval(heartbeat)
    document.removeEventListener('visibilitychange', wake)
    window.removeEventListener('online', wake)
  }

  connect()

  return {
    send(data) {
      if (socket?.readyState !== WebSocket.OPEN) return false
      socket.send(data)
      return true
    },
    close() {
      stop()
      const ws = socket
      socket = null
      ws?.close()
    },
  }
}
