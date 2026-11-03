import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TournamentView } from '../../shared/tournament.ts'
import { TournamentPage, TournamentsListPage } from '../../src/pages/TournamentPages.tsx'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'

/** The tournament pages (e9-t16, AC-9.7): the announcement, entering, confirming, and the admin's start */

const mocks = vi.hoisted(() => ({
  api: {
    tournaments: {
      list: vi.fn(),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      enter: vi.fn(),
      answer: vi.fn(),
      withdraw: vi.fn(),
      remove: vi.fn(),
      cancel: vi.fn(),
      start: vi.fn(),
    },
  },
  user: { id: 'u1', username: 'amy', admin: false, permissions: [] as string[] },
}))

vi.mock('../../src/lib/api.ts', async (original) => ({
  ...(await original<typeof import('../../src/lib/api.ts')>()),
  api: mocks.api,
}))
vi.mock('../../src/state/AuthContext.tsx', () => ({
  useAuth: () => ({ user: mocks.user }),
}))

const START = Date.UTC(2026, 10, 14, 6)
const user = (id: string, username: string, confirmed = true) => ({ id, username, confirmed })

const OPEN: TournamentView = {
  id: 't1',
  title: '社慶盃',
  kind: 'pairs',
  status: 'open',
  startsAt: START,
  deadline: START - 86_400_000,
  capacity: 10,
  used: 1.5,
  mine: false,
  description: '週六下午兩點，社辦見',
  createdBy: { id: 'boss', username: 'boss' },
  createdAt: START - 7 * 86_400_000,
  settings: {
    kind: 'pairs',
    title: '社慶盃',
    description: '週六下午兩點，社辦見',
    startsAt: START,
    deadline: START - 86_400_000,
    capacity: 10,
    pairs: { boardsPerRound: 3, boardMinutes: 8 },
    match: { boards: 8, scoring: 'imp', boardMinutes: 10 },
  },
  entries: [
    { id: 'e1', players: [user('u2', 'ben'), user('u3', 'cat', false)], complete: false, at: 1 },
    { id: 'e2', players: [user('u4', 'dan')], complete: true, at: 2 },
  ],
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
          <Route path="/pairs/:id" element={<p>pairs page</p>} />
        </Routes>
      </MemoryRouter>
    </PreferencesProvider>,
  )
}

describe('tournament pages', () => {
  beforeEach(() => {
    for (const fn of Object.values(mocks.api.tournaments)) fn.mockReset()
    mocks.user.admin = false
  })

  it('shows the announcement and the entries, and enters with a partner', async () => {
    mocks.api.tournaments.get.mockResolvedValue({ tournament: OPEN })
    mocks.api.tournaments.enter.mockResolvedValue({
      tournament: { ...OPEN, mine: true, myEntry: 'e3', entries: [...OPEN.entries, { id: 'e3', players: [user('u1', 'amy'), user('u5', 'eve', false)], complete: false, at: 3 }] },
    })
    renderPage()
    expect(await screen.findByRole('heading', { name: '社慶盃' })).toBeInTheDocument()
    expect(screen.getByText('週六下午兩點，社辦見')).toBeInTheDocument()
    expect(screen.getByText('1.5／10 對')).toBeInTheDocument()
    const entries = screen.getByRole('list')
    expect(within(entries).getAllByRole('listitem')).toHaveLength(2)
    expect(within(entries).getByText('（等確認）')).toBeInTheDocument()
    expect(within(entries).getByText('單人（開賽時和其他單人配對）')).toBeInTheDocument()
    // Nobody named: entering alone
    expect(screen.getByRole('button', { name: '自己報名' })).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('搭檔的帳號名稱（留白就是自己報名）'), 'eve')
    await userEvent.click(screen.getByRole('button', { name: '報名' }))
    expect(mocks.api.tournaments.enter).toHaveBeenCalledWith('t1', ['eve'], undefined)
    expect(await screen.findByText('你已經報名了。')).toBeInTheDocument()
    // Members cannot manage it
    expect(screen.queryByRole('button', { name: '用報名名單開賽' })).not.toBeInTheDocument()
  })

  it('lets a partner confirm', async () => {
    mocks.api.tournaments.get.mockResolvedValue({ tournament: { ...OPEN, mine: true, myEntry: 'e1', myPending: true } })
    mocks.api.tournaments.answer.mockResolvedValue({ tournament: { ...OPEN, mine: true, myEntry: 'e1' } })
    renderPage()
    expect(await screen.findByText('有人和你一起報名了這場比賽，請確認。')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '確認報名' }))
    expect(mocks.api.tournaments.answer).toHaveBeenCalledWith('t1', true)
    expect(await screen.findByRole('button', { name: '退出報名' })).toBeInTheDocument()
  })

  it('asks a team for three teammates', async () => {
    mocks.api.tournaments.get.mockResolvedValue({ tournament: { ...OPEN, kind: 'match', capacity: 2, used: 0, entries: [] } })
    renderPage()
    const button = await screen.findByRole('button', { name: '整隊報名' })
    expect(button).toBeDisabled()
    await userEvent.type(screen.getByLabelText('三位隊友的帳號名稱（用逗號或空白分開）'), 'ben, cat dan')
    expect(button).toBeEnabled()
  })

  it('lets an admin start it from the entries, then links the event', async () => {
    mocks.user.admin = true
    mocks.api.tournaments.get.mockResolvedValue({ tournament: { ...OPEN, canManage: true } })
    mocks.api.tournaments.start.mockResolvedValue({ tournament: { ...OPEN, canManage: true, status: 'started', eventId: 'p1', eventLink: '/pairs/p1' } })
    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: '用報名名單開賽' }))
    expect(mocks.api.tournaments.start).toHaveBeenCalledWith('t1')
    expect(await screen.findByRole('link', { name: '前往比賽' })).toHaveAttribute('href', '/pairs/p1')
  })

  it('links the results once it is over', async () => {
    mocks.api.tournaments.get.mockResolvedValue({ tournament: { ...OPEN, status: 'finished', eventId: 'p1', eventLink: '/pairs/p1' } })
    renderPage()
    expect(await screen.findByRole('link', { name: '看比賽結果' })).toHaveAttribute('href', '/pairs/p1')
    expect(screen.getByText('比賽結束了，結果已經公告。')).toBeInTheDocument()
  })

  it('lists the tournaments, with the form for admins', async () => {
    mocks.user.admin = true
    mocks.api.tournaments.list.mockResolvedValue({
      tournaments: [{ id: 't1', title: '社慶盃', kind: 'pairs', status: 'open', startsAt: START, deadline: START - 1, capacity: 10, used: 2, mine: true }],
    })
    renderPage('/tournaments')
    expect(await screen.findByRole('link', { name: '社慶盃' })).toHaveAttribute('href', '/tournaments/t1')
    expect(screen.getByText('2／10 對')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '公告比賽' })).toBeInTheDocument()
  })
})
