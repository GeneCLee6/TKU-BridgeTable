import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TeamEventView } from '../../shared/team-event.ts'
import { TeamEventPage } from '../../src/pages/TeamEventPage.tsx'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'

/** The multi-team event's page (e9-t14, AC-9.5): standings by VP, the rounds, my match, line-ups, the director's next round */

const mocks = vi.hoisted(() => ({
  api: { teamEvents: { get: vi.fn(), lineup: vi.fn(), next: vi.fn(), cancel: vi.fn() } },
}))

vi.mock('../../src/lib/api.ts', async (original) => ({
  ...(await original<typeof import('../../src/lib/api.ts')>()),
  api: mocks.api,
}))

const u = (id: string) => ({ id, username: id })

const VIEW: TeamEventView = {
  id: 'e1',
  title: '社慶團體賽',
  status: 'playing',
  format: 'roundRobin',
  rounds: 3,
  settings: { title: '社慶團體賽', boards: 8, boardMinutes: 10, rounds: 5 },
  director: u('boss'),
  createdAt: 0,
  teams: [
    { id: 't1', name: '甲隊', players: ['a1', 'a2', 'a3', 'a4', 'a5'].map(u), lineup: ['a1', 'a2', 'a3', 'a4'], canLineup: true },
    { id: 't2', name: '', players: ['b1', 'b2', 'b3', 'b4'].map(u), lineup: [], canLineup: false },
    { id: 't3', name: '丙隊', players: ['c1', 'c2', 'c3', 'c4'].map(u), lineup: [], canLineup: false },
  ],
  played: [
    {
      n: 1,
      matches: [{ matchId: 'm1', a: 0, b: 1, status: 'finished', imps: { A: 23, B: 8 }, vp: { A: 14.74, B: 5.26 } }],
      bye: 2,
      done: true,
    },
    { n: 2, matches: [{ matchId: 'm2', a: 2, b: 0, status: 'playing', imps: { A: 3, B: 0 } }], bye: 1, done: false },
  ],
  standings: [
    { team: 0, rank: 1, vp: 14.74, played: 1, byes: 0, impsFor: 23, impsAgainst: 8, quotient: 2.875 },
    { team: 2, rank: 2, vp: 12, played: 0, byes: 1, impsFor: 0, impsAgainst: 0, quotient: 1 },
    { team: 1, rank: 3, vp: 5.26, played: 1, byes: 0, impsFor: 8, impsAgainst: 23, quotient: 0.348 },
  ],
  myTeam: 0,
  myMatch: 'm2',
  canNext: false,
  canCancel: false,
  tournamentId: 'tour1',
}

function renderPage() {
  return render(
    <PreferencesProvider>
      <MemoryRouter initialEntries={['/team-events/e1']}>
        <Routes>
          <Route path="/team-events/:eventId" element={<TeamEventPage />} />
        </Routes>
      </MemoryRouter>
    </PreferencesProvider>,
  )
}

describe('multi-team event page (e9-t14)', () => {
  beforeEach(() => {
    for (const fn of Object.values(mocks.api.teamEvents)) fn.mockReset()
  })

  it('shows the standings by VP, the rounds with IMPs and VP, and my match', async () => {
    mocks.api.teamEvents.get.mockResolvedValue({ event: VIEW })
    renderPage()
    expect(await screen.findByRole('heading', { name: '社慶團體賽' })).toBeInTheDocument()
    expect(screen.getByText('循環賽')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '前往我的比賽' })).toHaveAttribute('href', '/matches/m2')
    const standings = screen.getByRole('region', { name: '排名' })
    const rows = within(standings).getAllByRole('row').slice(1)
    expect(rows.map((r) => within(r).getAllByRole('cell')[1].textContent)).toEqual(['甲隊', '丙隊', '第 2 隊'])
    expect(within(rows[0]).getByText('14.74')).toBeInTheDocument()
    expect(rows[0]).toHaveAttribute('aria-current', 'true')
    expect(within(standings).getByText(/輪空得 12 VP/)).toBeInTheDocument()
    const rounds = screen.getByRole('region', { name: '各輪' })
    expect(within(rounds).getByText('甲隊 對 第 2 隊')).toBeInTheDocument()
    expect(within(rounds).getByText('IMP 23 : 8')).toBeInTheDocument()
    expect(within(rounds).getByText('VP 14.74 : 5.26')).toBeInTheDocument()
    expect(within(rounds).getByText('輪空：丙隊')).toBeInTheDocument()
    expect(within(rounds).getByText('進行中')).toBeInTheDocument()
    // Not the director
    expect(screen.queryByRole('button', { name: /開始第/ })).not.toBeInTheDocument()
  })

  it("lets the captain set the next round's line-up", async () => {
    mocks.api.teamEvents.get.mockResolvedValue({ event: VIEW })
    mocks.api.teamEvents.lineup.mockResolvedValue({ event: VIEW })
    renderPage()
    const form = await screen.findByRole('form', { name: '下一輪的出賽名單' })
    await userEvent.selectOptions(within(form).getByRole('combobox', { name: '開室一對 1' }), 'a5')
    await userEvent.click(within(form).getByRole('button', { name: '儲存出賽名單' }))
    expect(mocks.api.teamEvents.lineup).toHaveBeenCalledWith('e1', 0, ['a5', 'a2', 'a3', 'a4'])
    expect(await within(form).findByText('已儲存。')).toBeInTheDocument()
    // The same player twice cannot be saved
    await userEvent.selectOptions(within(form).getByRole('combobox', { name: '開室一對 2' }), 'a5')
    expect(within(form).getByRole('button', { name: '儲存出賽名單' })).toBeDisabled()
  })

  it("gives the director the next round, and shows the server's refusal", async () => {
    mocks.api.teamEvents.get.mockResolvedValue({ event: { ...VIEW, myTeam: undefined, myMatch: undefined, canNext: true } })
    const { ApiError } = await import('../../src/lib/api.ts')
    mocks.api.teamEvents.next.mockRejectedValue(new ApiError('x', 400, 'teamEventRoundOn'))
    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: '開始第 3 輪' }))
    expect(mocks.api.teamEvents.next).toHaveBeenCalledWith('e1')
    expect(await screen.findByRole('alert')).toHaveTextContent('這一輪還有比賽沒打完')
  })
})
