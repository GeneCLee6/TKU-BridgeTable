import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PairsView } from '../../shared/pairs.ts'
import type { LobbyView } from '../../shared/protocol.ts'
import { RefereeTools } from '../../src/components/RefereePanel.tsx'
import { PairsEventPage } from '../../src/pages/PairsPages.tsx'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'

/** The tournament director's tools on the result pages (e9-t17, AC-9.8) */

const mocks = vi.hoisted(() => ({
  api: { pairs: { get: vi.fn() }, referee: vi.fn() },
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
  useAuth: () => ({ user: { id: 'td', username: 'td', admin: false, permissions: [] } }),
}))

const user = (n: number) => ({ id: `u${n}`, username: `p${n}` })
const pairs = Array.from({ length: 5 }, (_, i) => ({
  pair: i,
  players: [user(i * 2 + 1), user(i * 2 + 2)],
  dir: (i < 3 ? 'NS' : 'EW') as 'NS' | 'EW',
  no: i < 3 ? i + 1 : i - 2,
}))
const td = { id: 'td', username: 'td' }

const PLAYING: PairsView = {
  id: 'e1',
  title: '週五雙人賽',
  status: 'playing',
  director: td,
  createdAt: Date.UTC(2026, 10, 2),
  settings: { title: '週五雙人賽', boardsPerRound: 2, boardMinutes: 8 },
  pairs,
  movement: { kind: 'mitchell', tables: 3, rounds: 3, boardsPerRound: 2, boards: 6 },
  round: 1,
  tables: [
    { table: 1, ns: 0, ew: 4, tableId: 't-1', boards: [1, 2], played: 2 },
    { table: 2, ns: 1, ew: 3, tableId: 't-2', boards: [3, 4], played: 1 },
  ],
  standings: [
    { pair: 0, dir: 'NS', rank: 1, mp: 4, percent: 100, boards: 2 },
    { pair: 1, dir: 'NS', rank: 2, mp: -1.5, percent: 0, boards: 2, penalty: 1.5 },
    { pair: 2, dir: 'NS', rank: 3, mp: 0, percent: 0, boards: 0 },
    { pair: 3, dir: 'EW', rank: 1, mp: 4, percent: 100, boards: 2 },
    { pair: 4, dir: 'EW', rank: 2, mp: 0, percent: 0, boards: 2 },
  ],
  travellers: [
    {
      boardNo: 3,
      entries: [
        { round: 1, table: 2, ns: 1, ew: 3, contract: null, declarerTricks: null, scoreNS: 0, percentNS: 60, ruling: { kind: 'avgPlus', side: 'NS' } },
      ],
    },
  ],
  canDirect: true,
  canReferee: true,
  referee: [
    { id: 'n1', at: Date.UTC(2026, 10, 2, 12), by: td, reason: '遲到', action: 'penalty', target: '1', amount: 1.5 },
    { id: 'n2', at: Date.UTC(2026, 10, 2, 12), by: td, reason: '算錯了', action: 'penalty', target: '2', amount: 1, withdrawn: true },
    { id: 'n3', at: Date.UTC(2026, 10, 2, 12), by: td, reason: '查明', action: 'withdraw', of: 'n2' },
    { id: 'n4', at: Date.UTC(2026, 10, 2, 13), by: td, reason: '斷線', action: 'score', round: 1, table: 2, boardNo: 3, ruling: { kind: 'avgPlus', side: 'NS' } },
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

describe("the director's tools (e9-t17)", () => {
  beforeEach(() => {
    mocks.api.pairs.get.mockReset()
    mocks.api.referee.mockReset()
  })

  it('shows what the director did, with who and why, and the penalty and the ruling where they count', async () => {
    mocks.api.pairs.get.mockResolvedValue({ pairs: { ...PLAYING, canReferee: undefined, canDirect: false } })
    renderPage()
    const notes = await screen.findByRole('list', { name: '裁判紀錄' })
    expect(within(notes).getByText('處罰 · 南北 2 p3 – p4 扣 1.5 MP')).toBeInTheDocument()
    expect(within(notes).getByText('已撤銷')).toBeInTheDocument()
    expect(within(notes).getByText('調整分數 · 第 1 輪第 2 桌第 3 副 · 裁定 Avg+ NS')).toBeInTheDocument()
    expect(within(notes).getAllByText(/裁判：td/)).toHaveLength(4)
    // The standings show the penalty, the traveller the ruling
    expect(within(screen.getByRole('table', { name: '南北' })).getByText(/處罰 −1.5/)).toBeInTheDocument()
    expect(within(screen.getByRole('table', { name: '第 3 副' })).getByText('裁定 Avg+ NS')).toBeInTheDocument()
    // No tools for anyone else
    expect(screen.queryByRole('form', { name: '裁判工具' })).not.toBeInTheDocument()
  })

  it('gives a penalty, then a score for a held-up table, and reads the page again', async () => {
    mocks.api.pairs.get.mockResolvedValue({ pairs: PLAYING })
    mocks.api.referee.mockResolvedValue({ ok: true })
    renderPage()
    const form = await screen.findByRole('form', { name: '裁判工具' })
    await userEvent.selectOptions(within(form).getByLabelText('要做什麼'), '處罰')
    await userEvent.selectOptions(within(form).getByLabelText('對象'), '南北 3 p5 – p6')
    await userEvent.type(within(form).getByLabelText('扣多少（MP）'), '2')
    expect(within(form).getByRole('button', { name: '送出' })).toBeDisabled()
    await userEvent.type(within(form).getByLabelText('理由'), '慢打')
    await userEvent.click(within(form).getByRole('button', { name: '送出' }))
    expect(mocks.api.referee).toHaveBeenCalledWith('pairs', 'e1', { action: 'penalty', target: '2', amount: 2, reason: '慢打' })
    await waitFor(() => expect(mocks.api.pairs.get).toHaveBeenCalledTimes(2))

    await userEvent.selectOptions(within(form).getByLabelText('要做什麼'), '調整分數')
    await userEvent.selectOptions(within(form).getByLabelText('哪一桌'), '第 2 桌 · 1／2 副')
    await userEvent.selectOptions(within(form).getByLabelText('哪一副'), '第 4 副')
    await userEvent.selectOptions(within(form).getByLabelText('裁定'), 'Avg-')
    await userEvent.selectOptions(within(form).getByLabelText('給哪一方'), 'EW')
    await userEvent.type(within(form).getByLabelText('理由'), '斷線')
    await userEvent.click(within(form).getByRole('button', { name: '送出' }))
    expect(mocks.api.referee).toHaveBeenLastCalledWith('pairs', 'e1', {
      action: 'score',
      table: 2,
      boardNo: 4,
      ruling: { kind: 'avgMinus', side: 'EW', reason: '斷線' },
    })
  })

  it('re-opens a table with a board to play again, and offers only what fits the event', async () => {
    const onDone = vi.fn()
    mocks.api.referee.mockResolvedValue({ ok: true })
    render(
      <PreferencesProvider>
        <RefereeTools
          kind="pairs"
          eventId="e1"
          targets={[]}
          targetLabel={(x) => x}
          unit="MP"
          notes={[]}
          tables={[{ table: 1, boards: [1, 2], label: '第 1 桌' }]}
          onDone={onDone}
        />
      </PreferencesProvider>,
    )
    const tool = screen.getByLabelText('要做什麼')
    expect(within(tool).getAllByRole('option').map((o) => o.textContent)).toEqual(['調整分數', '重新開一桌'])
    await userEvent.selectOptions(tool, '重新開一桌')
    await userEvent.click(screen.getByRole('checkbox', { name: '第 2 副' }))
    await userEvent.type(screen.getByLabelText('理由'), '發錯牌')
    await userEvent.click(screen.getByRole('button', { name: '送出' }))
    expect(mocks.api.referee).toHaveBeenCalledWith('pairs', 'e1', { action: 'restart', table: 1, replay: [2], reason: '發錯牌' })
    await waitFor(() => expect(onDone).toHaveBeenCalled())
  })

  it('offers a team match a penalty to either team, and taking one back', async () => {
    mocks.api.referee.mockResolvedValue({ ok: true })
    render(
      <PreferencesProvider>
        <RefereeTools
          kind="match"
          eventId="m1"
          targets={[
            { value: 'A', label: 'A 隊' },
            { value: 'B', label: 'B 隊' },
          ]}
          targetLabel={(x) => `${x} 隊`}
          unit="IMP"
          notes={[{ id: 'n1', at: 1, by: td, reason: '遲到', action: 'penalty', target: 'A', amount: 3 }]}
          onDone={() => undefined}
        />
      </PreferencesProvider>,
    )
    const tool = screen.getByLabelText('要做什麼')
    expect(within(tool).getAllByRole('option').map((o) => o.textContent)).toEqual(['處罰', '撤銷處罰'])
    await userEvent.selectOptions(tool, '撤銷處罰')
    expect(within(screen.getByLabelText('撤銷哪一筆')).getByRole('option').textContent).toBe('處罰 · A 隊 扣 3 IMP')
    await userEvent.type(screen.getByLabelText('理由'), '誤判')
    await userEvent.click(screen.getByRole('button', { name: '送出' }))
    expect(mocks.api.referee).toHaveBeenCalledWith('match', 'm1', { action: 'withdraw', of: 'n1', reason: '誤判' })
  })
})
