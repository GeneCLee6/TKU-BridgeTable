import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TournamentView } from '../../shared/tournament.ts'
import { TournamentPage, TournamentsListPage } from '../../src/pages/TournamentPages.tsx'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'

/** A tournament of the individual kind (e9-t15, §5.25): everyone enters alone, places count players */

const mocks = vi.hoisted(() => ({
  api: { tournaments: { list: vi.fn(), get: vi.fn(), create: vi.fn(), enter: vi.fn(), start: vi.fn() } },
  user: { id: 'u1', username: 'amy', admin: false, permissions: [] as string[] },
}))

vi.mock('../../src/lib/api.ts', async (original) => ({
  ...(await original<typeof import('../../src/lib/api.ts')>()),
  api: mocks.api,
}))
vi.mock('../../src/state/AuthContext.tsx', () => ({
  useAuth: () => ({ user: mocks.user }),
}))

const START = Date.UTC(2026, 10, 21, 6)

const OPEN: TournamentView = {
  id: 't1',
  title: '個人賽盃',
  kind: 'individual',
  status: 'open',
  startsAt: START,
  deadline: START - 86_400_000,
  capacity: 16,
  used: 1,
  mine: false,
  description: '',
  createdBy: { id: 'boss', username: 'boss' },
  createdAt: START - 7 * 86_400_000,
  settings: {
    kind: 'individual',
    title: '個人賽盃',
    description: '',
    startsAt: START,
    deadline: START - 86_400_000,
    capacity: 16,
    pairs: { boardsPerRound: 1, boardMinutes: 8 },
    match: { boards: 8, scoring: 'imp', boardMinutes: 10 },
  },
  entries: [{ id: 'e1', players: [{ id: 'u2', username: 'ben', confirmed: true }], complete: true, at: 1 }],
  entriesOpen: true,
  canManage: false,
}

function renderPage(path = '/tournaments/t1') {
  return render(
    <PreferencesProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/tournaments" element={<TournamentsListPage />} />
          <Route path="/tournaments/:tournamentId" element={<TournamentPage />} />
        </Routes>
      </MemoryRouter>
    </PreferencesProvider>,
  )
}

describe('individual tournament pages', () => {
  beforeEach(() => {
    for (const fn of Object.values(mocks.api.tournaments)) fn.mockReset()
    mocks.user.admin = false
  })

  it('counts players and enters alone, with no partner box', async () => {
    mocks.api.tournaments.get.mockResolvedValue({ tournament: OPEN })
    mocks.api.tournaments.enter.mockResolvedValue({
      tournament: {
        ...OPEN,
        mine: true,
        myEntry: 'e2',
        used: 2,
        entries: [...OPEN.entries, { id: 'e2', players: [{ id: 'u1', username: 'amy', confirmed: true }], complete: true, at: 2 }],
      },
    })
    renderPage()
    expect(await screen.findByText('1／16 人')).toBeInTheDocument()
    expect(screen.getByText('個人賽')).toBeInTheDocument()
    // A member alone in an individual event is not waiting to be paired
    expect(screen.queryByText('單人（開賽時和其他單人配對）')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('搭檔的帳號名稱（留白就是自己報名）')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '自己報名' }))
    expect(mocks.api.tournaments.enter).toHaveBeenCalledWith('t1', [], undefined)
    expect(await screen.findByText('你已經報名了。')).toBeInTheDocument()
  })

  it('tells the admin how the event is made', async () => {
    mocks.user.admin = true
    mocks.api.tournaments.get.mockResolvedValue({ tournament: { ...OPEN, canManage: true } })
    renderPage()
    expect(await screen.findByText(/建立個人賽：依報名順序取 8、12、16 或 20 人/)).toBeInTheDocument()
  })

  it('offers the individual kind in the form, with places in players', async () => {
    mocks.user.admin = true
    mocks.api.tournaments.list.mockResolvedValue({ tournaments: [] })
    renderPage('/tournaments')
    const kind = await screen.findByRole('combobox', { name: '比賽方式' })
    await userEvent.selectOptions(kind, 'individual')
    const places = screen.getByRole('spinbutton', { name: '名額（人）' })
    expect(places).toHaveValue(20)
    expect(places).toHaveAttribute('min', '8')
  })

  // Only the first N rounds (§5.25)
  it('sets the rounds to play, up to what the places seat', async () => {
    mocks.user.admin = true
    mocks.api.tournaments.list.mockResolvedValue({ tournaments: [] })
    mocks.api.tournaments.create.mockResolvedValue({ tournament: OPEN })
    mocks.api.tournaments.get.mockResolvedValue({ tournament: OPEN })
    renderPage('/tournaments')
    const kind = await screen.findByRole('combobox', { name: '比賽方式' })
    expect(screen.queryByRole('combobox', { name: '輪數' })).not.toBeInTheDocument()
    await userEvent.selectOptions(kind, 'individual')
    const rounds = screen.getByRole('combobox', { name: '輪數' })
    expect(rounds).toHaveValue('')
    // 20 places: up to 19 rounds; 13 places seat 12: up to 11
    expect(within(rounds).getAllByRole('option')).toHaveLength(20)
    const places = screen.getByRole('spinbutton', { name: '名額（人）' })
    await userEvent.clear(places)
    await userEvent.type(places, '13')
    expect(within(rounds).getAllByRole('option')).toHaveLength(12)
    await userEvent.selectOptions(rounds, '6')
    await userEvent.type(screen.getByRole('textbox', { name: '名稱' }), '個人賽盃')
    await userEvent.click(screen.getByRole('button', { name: '公告比賽' }))
    expect(mocks.api.tournaments.create).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'individual', capacity: 13, pairs: { boardsPerRound: 3, boardMinutes: 8, rounds: 6 } }),
    )
  })

  it('shows the rounds on the announcement', async () => {
    mocks.api.tournaments.get.mockResolvedValue({
      tournament: { ...OPEN, settings: { ...OPEN.settings, pairs: { ...OPEN.settings.pairs, rounds: 7 } } },
    })
    renderPage()
    expect(await screen.findByText('只打前 7 輪')).toBeInTheDocument()
  })
})
