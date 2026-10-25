import { act, render, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TABLE_SOCKET_REFUSED, type ClientMessage, type LobbyView, type ServerMessage } from '../../shared/protocol.ts'
import { liveSocket } from '../../src/lib/liveSocket.ts'
import { AuthProvider } from '../../src/state/AuthContext.tsx'
import { ClubProvider, useClub } from '../../src/state/ClubContext.tsx'

/** The browser's two connections (ARCHITECTURE.md §5.10): the club's `/ws` and the table's `/ws/table/<id>` */

class FakeSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static all: FakeSocket[] = []
  readonly url: string
  readyState = FakeSocket.CONNECTING
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null

  constructor(url: string) {
    this.url = url
    FakeSocket.all.push(this)
  }
  send(data: string) {
    this.sent.push(data)
  }
  close(code = 1000) {
    if (this.readyState === FakeSocket.CLOSED) return
    this.readyState = FakeSocket.CLOSED
    this.onclose?.({ code })
  }
  open() {
    this.readyState = FakeSocket.OPEN
    this.onopen?.()
  }
  receive(message: ServerMessage) {
    this.onmessage?.({ data: JSON.stringify(message) })
  }
  /** The messages sent, without the heartbeat */
  get messages() {
    return this.sent.filter((s) => s !== 'ping').map((s) => (JSON.parse(s) as ClientMessage).type)
  }
}

const sockets = (path: string) => FakeSocket.all.filter((s) => new URL(s.url).pathname === path)

beforeEach(() => {
  FakeSocket.all = []
  vi.stubGlobal('WebSocket', FakeSocket)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the live connections', () => {
  it('opens the table’s own connection while at a table and sends table actions over it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ user: { id: 'amy', username: 'amy' } }), { headers: { 'Content-Type': 'application/json' } })),
    )
    const seen: { club: ReturnType<typeof useClub> | null } = { club: null }
    function Probe() {
      const current = useClub()
      useEffect(() => {
        seen.club = current
      })
      return null
    }
    const club = new Proxy({} as ReturnType<typeof useClub>, { get: (_, key) => seen.club![key as keyof typeof seen.club] })
    render(
      <AuthProvider>
        <ClubProvider>
          <Probe />
        </ClubProvider>
      </AuthProvider>,
    )
    await waitFor(() => expect(sockets('/ws')).toHaveLength(1))
    const lobbySocket = sockets('/ws')[0]
    act(() => lobbySocket.open())
    act(() => lobbySocket.receive({ type: 'lobby', lobby: { myTableId: 't1', tables: [] } as unknown as LobbyView }))
    await waitFor(() => expect(sockets('/ws/table/t1')).toHaveLength(1))
    const tableSocket = sockets('/ws/table/t1')[0]

    // Until the table's connection is open, the club hands table actions on
    act(() => club.send({ type: 'call', call: 'P' }))
    act(() => tableSocket.open())
    act(() => club.send({ type: 'play', card: 'SA' }))
    act(() => club.send({ type: 'leaveTable' }))
    expect(lobbySocket.messages).toEqual(['call', 'leaveTable'])
    expect(tableSocket.messages).toEqual(['play'])

    // The table's view comes over its own connection
    const view = { id: 't1', chat: [], recent: [], dealAt: null, boardEndsAt: null, waiting: null }
    act(() => tableSocket.receive({ type: 'table', table: view as never, now: Date.now() }))
    expect(club.table?.id).toBe('t1')

    // Leaving the table closes it
    act(() => lobbySocket.receive({ type: 'lobby', lobby: { myTableId: null, tables: [] } as unknown as LobbyView }))
    expect(tableSocket.readyState).toBe(FakeSocket.CLOSED)
  })
})

describe('liveSocket', () => {
  it('connects again after the connection drops', () => {
    vi.useFakeTimers()
    const socket = liveSocket({ path: '/ws', onMessage: () => {} })
    FakeSocket.all[0].open()
    FakeSocket.all[0].close(1006)
    vi.advanceTimersByTime(1000)
    expect(FakeSocket.all).toHaveLength(2)
    socket.close()
  })

  it('does not try a table again that turned the member away', () => {
    vi.useFakeTimers()
    const socket = liveSocket({ path: '/ws/table/t1', onMessage: () => {}, stopOn: [TABLE_SOCKET_REFUSED] })
    FakeSocket.all[0].open()
    FakeSocket.all[0].close(TABLE_SOCKET_REFUSED)
    vi.advanceTimersByTime(60_000)
    expect(FakeSocket.all).toHaveLength(1)
    expect(socket.send('x')).toBe(false)
  })
})
