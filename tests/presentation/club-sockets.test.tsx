import { act, render, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { FRIENDS_ENABLED } from '../../shared/features.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TABLE_SOCKET_REFUSED, type ClientMessage, type LobbyMine, type LobbyShared, type ServerMessage } from '../../shared/protocol.ts'
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

/** The viewer's own part of the lobby (H3b) */
const mine = (over: Partial<LobbyMine> = {}): LobbyMine => ({
  myTableId: null,
  friends: [],
  blocked: [],
  tables: [],
  welcome: [],
  requested: [],
  places: {},
  ...over,
})
const member = (id: string, username: string, online = true) => ({ id, username, online, tableNumber: null, seat: null })

/** The provider with a probe that sees what it holds; its club connection open */
async function mount() {
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
  render(
    <AuthProvider>
      <ClubProvider>
        <Probe />
      </ClubProvider>
    </AuthProvider>,
  )
  await waitFor(() => expect(sockets('/ws')).toHaveLength(1))
  const socket = sockets('/ws')[0]
  act(() => socket.open())
  return { socket, club: () => seen.club! }
}

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
    act(() => lobbySocket.receive({ type: 'lobbyMine', mine: mine({ myTableId: 't1' }) }))
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
    act(() => lobbySocket.receive({ type: 'lobbyMine', mine: mine() }))
    expect(tableSocket.readyState).toBe(FakeSocket.CLOSED)
  })
})

describe('the lobby in two parts (H3b)', () => {
  const shared: LobbyShared = { members: [member('amy', 'amy'), member('ben', 'ben'), member('zoe', 'zoe')], tables: [], matches: [] }

  it('puts the shared part and the viewer’s own together, sorting as the server did', async () => {
    const { socket, club } = await mount()
    act(() => socket.receive({ type: 'lobbyShared', epoch: 5, rev: 1, lobby: shared }))
    expect(club().lobby).toBeNull()
    act(() => socket.receive({ type: 'lobbyMine', mine: mine({ friends: ['zoe'] }) }))
    // Friends on top only while they are shown (FRIENDS_ENABLED)
    await waitFor(() => expect(club().lobby?.members.map((m) => m.username)).toEqual(FRIENDS_ENABLED ? ['zoe', 'amy', 'ben'] : ['amy', 'ben', 'zoe']))
    // A delta: ben goes offline, cal joins
    act(() =>
      socket.receive({ type: 'lobbyDelta', epoch: 5, base: 1, rev: 2, delta: { members: [member('ben', 'ben', false), member('cal', 'cal')] } }),
    )
    await waitFor(() => expect(club().lobby?.members.map((m) => m.username)).toEqual(FRIENDS_ENABLED ? ['zoe', 'amy', 'cal', 'ben'] : ['amy', 'cal', 'zoe', 'ben']))
    expect(socket.messages).toEqual([])
  })

  it('asks for the whole lobby once when a version is missing, and applies what came early', async () => {
    const { socket, club } = await mount()
    act(() => socket.receive({ type: 'lobbyMine', mine: mine() }))
    act(() => socket.receive({ type: 'lobbyShared', epoch: 5, rev: 1, lobby: shared }))
    act(() => socket.receive({ type: 'lobbyDelta', epoch: 5, base: 2, rev: 3, delta: { gone: ['zoe'] } }))
    act(() => socket.receive({ type: 'lobbyDelta', epoch: 5, base: 3, rev: 4, delta: { members: [member('cal', 'cal')] } }))
    expect(socket.messages).toEqual(['lobbySync'])
    await waitFor(() => expect(club().lobby?.members.map((m) => m.username)).toEqual(['amy', 'ben', 'zoe']))
    // The whole lobby at version 2: the early deltas follow it
    act(() => socket.receive({ type: 'lobbyShared', epoch: 5, rev: 2, lobby: { ...shared, members: [...shared.members, member('dan', 'dan')] } }))
    await waitFor(() => expect(club().lobby?.members.map((m) => m.username)).toEqual(['amy', 'ben', 'cal', 'dan']))
    expect(socket.messages).toEqual(['lobbySync'])
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
