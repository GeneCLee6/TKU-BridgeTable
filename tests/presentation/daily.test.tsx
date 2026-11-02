import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChallengePlayerView, ChallengeView } from '../../shared/challenge.ts'
import type { DailyEventView } from '../../shared/daily-event.ts'
import type { LobbyView } from '../../shared/protocol.ts'
import { DailyPage } from '../../src/pages/DailyPage.tsx'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'

/** The daily event's page (J1, e9-t03) */

const mocks = vi.hoisted(() => ({
  api: {
    daily: vi.fn(),
    answerChallenge: vi.fn(),
    admin: { saveDailyEvent: vi.fn() },
  },
  send: vi.fn(),
  admin: false,
}))

vi.mock('../../src/lib/api.ts', async (original) => ({
  ...(await original<typeof import('../../src/lib/api.ts')>()),
  api: mocks.api,
}))

const LOBBY: LobbyView = { online: [], members: [], tables: [], myTableId: null, friends: [], blocked: [] }
vi.mock('../../src/state/ClubContext.tsx', () => ({
  useClub: () => ({ lobby: LOBBY, send: mocks.send, notifications: null, status: 'open', table: null, error: null }),
}))
vi.mock('../../src/state/AuthContext.tsx', () => ({
  useAuth: () => ({ user: { id: 'amy', username: 'amy', admin: mocks.admin, permissions: [] } }),
}))

const HOUR = 3_600_000
const NOW = Date.now()

const player = (userId: string, status: ChallengePlayerView['status'], played = 0): ChallengePlayerView => ({
  user: { id: userId, username: userId },
  userId,
  status,
  played,
  knownDeals: false,
})

const SETTINGS = {
  scoring: 'mp',
  robotKind: 'gib',
  bestHand: false,
  justDeclare: false,
  days: 1,
  ranking: 'club',
  daily: true,
} as const

function day(id: string, extra: Partial<ChallengeView>): ChallengeView {
  return {
    id,
    creatorId: 'boss',
    createdAt: Date.UTC(2026, 10, 1, 16),
    status: 'pending',
    deadline: NOW + 10 * HOUR,
    settings: SETTINGS,
    boards: 8,
    players: [player('boss', 'accepted'), player('amy', 'invited'), player('ben', 'invited')],
    ...extra,
  }
}

const YESTERDAY = day('d1', {
  status: 'finished',
  createdAt: Date.UTC(2026, 9, 31, 16),
  deadline: NOW - HOUR,
  endedAt: NOW - HOUR,
  players: [player('boss', 'accepted'), player('amy', 'accepted', 8), player('ben', 'accepted', 8)],
  standings: {
    final: true,
    scoring: 'mp',
    ranked: [
      { userId: 'ben', rank: 1, total: 62.5 },
      { userId: 'amy', rank: 2, total: 37.5 },
    ],
    unfinished: [],
  },
})

const view = (extra: Partial<DailyEventView> = {}): DailyEventView => ({
  settings: { enabled: true, robotKind: 'gib' },
  next: NOW + 10 * HOUR,
  today: day('d2', {}),
  yesterday: YESTERDAY,
  history: [{ day: '2026-11-01', challengeId: 'd1', status: 'finished', finished: 2 }],
  ...extra,
})

function show() {
  render(
    <PreferencesProvider>
      <MemoryRouter initialEntries={['/daily']}>
        <Routes>
          <Route path="/daily" element={<DailyPage />} />
        </Routes>
      </MemoryRouter>
    </PreferencesProvider>,
  )
}

beforeEach(() => {
  mocks.api.daily.mockReset()
  mocks.api.answerChallenge.mockReset()
  mocks.api.admin.saveDailyEvent.mockReset()
  mocks.send.mockReset()
  mocks.admin = false
})

describe('DailyPage (e9-t03)', () => {
  it('starts today’s event: accepts the invitation on the way and asks the server for the table', async () => {
    mocks.api.daily.mockResolvedValue({ daily: view() })
    mocks.api.answerChallenge.mockResolvedValue({ challenge: day('d2', {}) })
    show()
    const today = await screen.findByRole('region', { name: '今天的賽' })
    expect(within(today).getByText('已打 0／8 副')).toBeInTheDocument()
    // Today's standings only once they played every board (§4)
    expect(within(today).getByText(/打完全部副數，或挑戰結束後/)).toBeInTheDocument()
    expect(within(today).getByRole('link', { name: '看成績' })).toHaveAttribute('href', '/challenges/d2')
    await userEvent.click(within(today).getByRole('button', { name: '開打' }))
    await waitFor(() => expect(mocks.send).toHaveBeenCalledWith({ type: 'playChallenge', challengeId: 'd2' }))
    expect(mocks.api.answerChallenge).toHaveBeenCalledWith('d2', true)
  })

  it('shows yesterday’s standings and the earlier days', async () => {
    mocks.api.daily.mockResolvedValue({ daily: view() })
    show()
    const yesterday = await screen.findByRole('region', { name: '昨天的排名' })
    const ranks = within(yesterday).getAllByRole('listitem')
    expect(ranks.map((li) => li.textContent)).toEqual(['1ben62.5%', '2amy37.5%'])
    expect(ranks[1]).toHaveAttribute('aria-current', 'true')
    const history = screen.getByRole('region', { name: '歷史' })
    expect(within(history).getByRole('link', { name: '每日賽 2026-11-01' })).toHaveAttribute('href', '/challenges/d1')
    expect(within(history).getByText('2 人打完')).toBeInTheDocument()
    // Members do not see the settings
    expect(screen.queryByRole('region', { name: '每日賽設定' })).not.toBeInTheDocument()
  })

  it('says so when it is off, and lets an admin turn it on', async () => {
    mocks.admin = true
    mocks.api.daily.mockResolvedValue({
      daily: view({ settings: { enabled: false, robotKind: 'gib' }, next: null, today: null, yesterday: null, history: [] }),
    })
    mocks.api.admin.saveDailyEvent.mockResolvedValue({
      daily: view({ settings: { enabled: true, robotKind: 'tku' }, today: null, yesterday: null, history: [] }),
    })
    show()
    expect(await screen.findByText('每日賽目前沒有開啟。')).toBeInTheDocument()
    expect(screen.getByText(/今天沒有每日賽/)).toBeInTheDocument()
    const settings = screen.getByRole('region', { name: '每日賽設定' })
    await userEvent.click(within(settings).getByRole('checkbox', { name: '開啟每日賽' }))
    await userEvent.selectOptions(within(settings).getByRole('combobox'), 'tku')
    await userEvent.click(within(settings).getByRole('button', { name: '儲存' }))
    expect(mocks.api.admin.saveDailyEvent).toHaveBeenCalledWith({ enabled: true, robotKind: 'tku' })
    expect(await within(settings).findByRole('status')).toHaveTextContent('已儲存')
    expect(within(settings).getByTestId('daily-next')).toHaveTextContent('下一場')
  })
})
