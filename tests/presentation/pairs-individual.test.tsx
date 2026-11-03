import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PairsView } from '../../shared/pairs.ts'
import type { LobbyView } from '../../shared/protocol.ts'
import { PairsBanner } from '../../src/components/PairsBanner.tsx'
import { PairsEventPage } from '../../src/pages/PairsPages.tsx'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'

/** An individual event's page (e9-t15, AC-9.6): entering alone, the partnerships at each table, one ranking */

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
const players = Array.from({ length: 8 }, (_, i) => ({ pair: i, players: [user(i + 1)] }))

const OPEN: PairsView = {
  id: 'e1',
  title: '',
  status: 'open',
  format: 'individual',
  director: user(9),
  createdAt: Date.UTC(2026, 10, 3),
  settings: { title: '', boardsPerRound: 1, boardMinutes: 8 },
  pairs: players.slice(1),
  round: 0,
  tables: [],
  standings: [],
  travellers: [],
  canDirect: false,
}

const PLAYING: PairsView = {
  ...OPEN,
  status: 'playing',
  pairs: players,
  myPair: 0,
  movement: { kind: 'individual', tables: 2, rounds: 7, boardsPerRound: 1, boards: 7 },
  round: 2,
  myTable: { table: 1, ns: 0, ew: 2, tableId: 't-1', boards: [2], played: 0, seats: [0, 1, 2, 3] },
  tables: [
    { table: 1, ns: 0, ew: 2, tableId: 't-1', boards: [2], played: 0, seats: [0, 1, 2, 3] },
    { table: 2, ns: 4, ew: 6, tableId: 't-2', boards: [2], played: 0, seats: [4, 5, 6, 7] },
  ],
  standings: players.map((p, i) => ({ pair: p.pair, rank: i < 4 ? 1 : 5, mp: i < 4 ? 2 : 0, percent: i < 4 ? 100 : 0, boards: 1 })),
  travellers: [
    {
      boardNo: 1,
      entries: [
        {
          round: 1,
          table: 1,
          ns: 0,
          ew: 4,
          seats: [0, 7, 4, 5],
          contract: { level: 3, strain: 'N', doubled: '', declarer: 'N' },
          declarerTricks: 9,
          scoreNS: 400,
          percentNS: 100,
          boardId: 'b1',
        },
        { round: 1, table: 2, ns: 1, ew: 3, seats: [1, 2, 3, 6], contract: null, declarerTricks: null, scoreNS: 0, percentNS: 0 },
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
        </Routes>
      </MemoryRouter>
    </PreferencesProvider>,
  )
}

describe('individual event page', () => {
  beforeEach(() => {
    for (const fn of Object.values(mocks.api.pairs)) fn.mockReset()
  })

  it('lets a member enter alone, without a partner', async () => {
    mocks.api.pairs.get.mockResolvedValue({ pairs: OPEN })
    mocks.api.pairs.enter.mockResolvedValue({ pairs: { ...OPEN, pairs: players, myPair: 0 } })
    renderPage()
    expect(await screen.findByRole('heading', { name: '個人賽' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '報名的社員' })).toBeInTheDocument()
    expect(screen.queryByLabelText('搭檔的帳號名稱')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '報名' }))
    expect(mocks.api.pairs.enter).toHaveBeenCalledWith('e1', undefined)
    expect(await screen.findByRole('button', { name: '退出' })).toBeInTheDocument()
  })

  it('names the partnerships at each table, ranks everyone in one field and shows the partner of each board', async () => {
    mocks.api.pairs.get.mockResolvedValue({ pairs: PLAYING })
    renderPage()
    expect(await screen.findByText('你在第 1 桌')).toBeInTheDocument()
    // This round's tables: North–South against East–West
    expect(screen.getByText('p1 – p2 · p3 – p4')).toBeInTheDocument()
    expect(screen.getByText('p5 – p6 · p7 – p8')).toBeInTheDocument()
    // One standings table, no NS/EW fields
    expect(screen.queryByRole('table', { name: '南北' })).not.toBeInTheDocument()
    expect(screen.getAllByRole('columnheader', { name: '社員' })).toHaveLength(1)
    // The board: each side is the two players who partnered there
    const board = screen.getByRole('table', { name: '第 1 副' })
    expect(within(board).getByText('p1 – p8')).toBeInTheDocument()
    expect(within(board).getByText('p5 – p6')).toBeInTheDocument()
    // My boards: my partner and my opponents on board 1
    const mine = screen.getByRole('table', { name: '我的逐副表現' })
    const row = within(mine).getAllByRole('row')[1]
    expect(within(row).getByText('p8')).toBeInTheDocument()
    expect(within(row).getByText('p5 – p6')).toBeInTheDocument()
  })

  it('names the individual event on its table', () => {
    render(
      <PreferencesProvider>
        <MemoryRouter>
          <PairsBanner pairs={{ id: 'e1', round: 2, rounds: 7, table: 1, played: 0, boards: 1, over: false, individual: true }} />
        </MemoryRouter>
      </PreferencesProvider>,
    )
    expect(screen.getByRole('link', { name: '個人賽 第 2／7 輪 · 第 1 桌' })).toBeInTheDocument()
  })
})
