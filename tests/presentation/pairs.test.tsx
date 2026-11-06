import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PairsView } from '../../shared/pairs.ts'
import type { LobbyView } from '../../shared/protocol.ts'
import { PairsEventPage } from '../../src/pages/PairsPages.tsx'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'

/** A pairs event's page (J3, e9-t10–e9-t13) */

const mocks = vi.hoisted(() => ({
  api: { pairs: { get: vi.fn(), enter: vi.fn(), withdraw: vi.fn(), start: vi.fn(), cancel: vi.fn() } },
}))

vi.mock('../../src/lib/api.ts', async (original) => ({
  ...(await original<typeof import('../../src/lib/api.ts')>()),
  api: mocks.api,
}))

const LOBBY: LobbyView = { online: [], members: [], tables: [], myTableId: null, friends: [], blocked: [] }
vi.mock('../../src/state/ClubContext.tsx', () => ({
  useClub: () => ({ lobby: LOBBY, send: vi.fn(), notifications: null, status: 'open', table: null, error: null }),
}))
vi.mock('../../src/state/AuthContext.tsx', () => ({
  useAuth: () => ({ user: { id: 'u1', username: 'p1', admin: false, permissions: [] } }),
}))

const user = (n: number) => ({ id: `u${n}`, username: `p${n}` })
const pairs = Array.from({ length: 5 }, (_, i) => ({ pair: i, players: [user(i * 2 + 1), user(i * 2 + 2)] }))

const OPEN: PairsView = {
  id: 'e1',
  title: '週五雙人賽',
  status: 'open',
  director: user(1),
  createdAt: Date.UTC(2026, 10, 2),
  settings: { title: '週五雙人賽', boardsPerRound: 2, boardMinutes: 8 },
  pairs,
  myPair: 0,
  round: 0,
  tables: [],
  standings: [],
  travellers: [],
  canDirect: true,
}

const PLAYING: PairsView = {
  ...OPEN,
  status: 'playing',
  pairs: pairs.map((p) => ({ ...p, dir: p.pair < 3 ? 'NS' : 'EW', no: p.pair < 3 ? p.pair + 1 : p.pair - 2 })),
  movement: { kind: 'mitchell', tables: 3, rounds: 3, boardsPerRound: 2, boards: 6 },
  round: 2,
  myTable: { table: 1, ns: 0, ew: 4, tableId: 't-1', boards: [1, 2], played: 1 },
  tables: [
    { table: 1, ns: 0, ew: 4, tableId: 't-1', boards: [1, 2], played: 1 },
    { table: 2, ns: 1, ew: 3, tableId: 't-2', boards: [3, 4], played: 0 },
  ],
  standings: [
    { pair: 0, dir: 'NS', rank: 1, mp: 4, percent: 100, boards: 2 },
    { pair: 1, dir: 'NS', rank: 2, mp: 0, percent: 0, boards: 2 },
    { pair: 2, dir: 'NS', rank: 3, mp: 0, percent: 0, boards: 0 },
    { pair: 3, dir: 'EW', rank: 1, mp: 4, percent: 100, boards: 2 },
    { pair: 4, dir: 'EW', rank: 2, mp: 0, percent: 0, boards: 2 },
  ],
  travellers: [
    {
      boardNo: 5,
      entries: [
        { round: 1, table: 1, ns: 0, ew: 3, contract: { level: 4, strain: 'S', doubled: '', declarer: 'N' }, declarerTricks: 10, scoreNS: 420, percentNS: 100, boardId: 'b1' },
        { round: 1, table: 2, ns: 1, ew: 4, contract: null, declarerTricks: null, scoreNS: 0, percentNS: 0 },
      ],
    },
  ],
}

function renderPage() {
  return render(
    <PreferencesProvider>
      <MemoryRouter initialEntries={['/pairs/e1']}>
        <Routes>
          <Route path="/pairs/:eventId" element={<PairsEventPage />} />
          <Route path="/table/:tableId" element={<p>table page</p>} />
        </Routes>
      </MemoryRouter>
    </PreferencesProvider>,
  )
}

describe('pairs event page', () => {
  beforeEach(() => {
    for (const fn of Object.values(mocks.api.pairs)) fn.mockReset()
  })

  it('lists the pairs entered, and lets the director start', async () => {
    mocks.api.pairs.get.mockResolvedValue({ pairs: OPEN })
    mocks.api.pairs.start.mockResolvedValue({ pairs: PLAYING })
    renderPage()
    expect(await screen.findByRole('heading', { name: '週五雙人賽' })).toBeInTheDocument()
    expect(screen.getByText('p1 – p2')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '退出' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '開始比賽' }))
    expect(mocks.api.pairs.start).toHaveBeenCalledWith('e1')
    expect(await screen.findByText('你在第 1 桌')).toBeInTheDocument()
  })

  it('shows the round, the live standings by field, and the boards played so far', async () => {
    mocks.api.pairs.get.mockResolvedValue({ pairs: PLAYING })
    renderPage()
    expect(await screen.findByText('你在第 1 桌')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '到我的牌桌' })).toHaveAttribute('href', '/table/t-1')
    const ns = screen.getByRole('table', { name: '南北' })
    expect(within(ns).getAllByRole('row')).toHaveLength(4)
    expect(within(ns).getByText('100.00%')).toBeInTheDocument()
    const board = screen.getByRole('table', { name: '第 5 副' })
    // The viewer's own result links its record; another table's does not until the event is over
    expect(within(board).getAllByRole('link')).toHaveLength(1)
    await waitFor(() => expect(screen.getByRole('table', { name: '我的逐副表現' })).toBeInTheDocument())
  })
})
