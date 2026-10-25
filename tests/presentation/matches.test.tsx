import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LobbyView, MemberStatus } from '../../shared/protocol.ts'
import { defaultTeamMatchSettings, MATCH_SEATS, teamAt, type MatchSeatView, type TeamMatchView } from '../../shared/team-match.ts'
import { MatchesPage } from '../../src/pages/MatchesPage.tsx'
import { MatchPage } from '../../src/pages/MatchPage.tsx'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'

/** The team match pages (F3): the list of one's matches and the prep room (e8-t06) */

const navigated = vi.hoisted(() => vi.fn())
vi.mock('react-router-dom', async (original) => ({
  ...(await original<typeof import('react-router-dom')>()),
  useNavigate: () => navigated,
}))

const mocks = vi.hoisted(() => ({
  api: {
    matches: vi.fn(),
    match: vi.fn(),
    createMatch: vi.fn(),
    matchSettings: vi.fn(),
    cancelMatch: vi.fn(),
    matchSeat: vi.fn(),
  },
  me: 'amy',
}))

vi.mock('../../src/lib/api.ts', async (original) => ({
  ...(await original<typeof import('../../src/lib/api.ts')>()),
  api: mocks.api,
}))

const person = (id: string, online = true): MemberStatus => ({ id, username: id, online, tableNumber: null, seat: null })
const LOBBY: LobbyView = {
  online: [],
  members: [person('amy'), person('ben'), person('cat'), person('eve', false)],
  tables: [],
  myTableId: null,
  friends: [],
  blocked: ['eve'],
}

vi.mock('../../src/state/ClubContext.tsx', () => ({
  useClub: () => ({ lobby: LOBBY, notifications: null, matchLive: null, status: 'open', table: null, error: null }),
}))
vi.mock('../../src/state/AuthContext.tsx', () => ({
  useAuth: () => ({ user: { id: mocks.me, username: mocks.me, admin: false, permissions: [] } }),
}))

/** A match amy hosts from the open room's South; ben is invited to the closed room's North */
function prepRoom(extra: Partial<TeamMatchView> = {}): TeamMatchView {
  const seats: MatchSeatView[] = MATCH_SEATS.map((s) => {
    const base = { ...s, team: teamAt(s.room, s.seat), robot: false }
    if (s.room === 'open' && s.seat === 'S')
      return { ...base, status: 'seated', userId: 'amy', user: { id: 'amy', username: 'amy' }, online: true }
    if (s.room === 'closed' && s.seat === 'N')
      return { ...base, status: 'invited', userId: 'ben', user: { id: 'ben', username: 'ben' }, online: false }
    if (s.room === 'open' && s.seat === 'E') return { ...base, status: 'seated', robot: true }
    return { ...base, status: 'empty' }
  })
  return {
    id: 'm1',
    hostId: 'amy',
    createdAt: 0,
    status: 'setup',
    settings: { ...defaultTeamMatchSettings(), teamNames: ['淡江', ''] },
    captains: { A: 'amy' },
    seats,
    boards: [],
    totals: { A: 0, B: 0 },
    leader: null,
    ready: { ready: false, reason: 'seats' },
    ...extra,
  }
}

function show(path: string) {
  render(
    <PreferencesProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/matches" element={<MatchesPage />} />
          <Route path="/matches/:matchId" element={<MatchPage />} />
        </Routes>
      </MemoryRouter>
    </PreferencesProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.me = 'amy'
})

describe('MatchesPage', () => {
  it('lists the member’s matches and sets up a new one', async () => {
    mocks.me = 'ben'
    mocks.api.matches.mockResolvedValue({ matches: [prepRoom()] })
    mocks.api.createMatch.mockResolvedValue({ match: prepRoom({ id: 'm2' }) })
    show('/matches')
    expect(await screen.findByText('淡江 對 B 隊')).toBeInTheDocument()
    expect(screen.getByText('邀請你')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '建立隊制賽' }))
    await waitFor(() => expect(navigated).toHaveBeenCalledWith('/matches/m2'))
  })
})

describe('MatchPage (e8-t06)', () => {
  it('shows both rooms’ seats, the rosters, and why the host cannot start yet', async () => {
    mocks.api.match.mockResolvedValue({ match: prepRoom() })
    show('/matches/m1')
    expect(await screen.findByRole('heading', { name: '淡江 對 B 隊' })).toBeInTheDocument()
    const invited = screen.getByRole('listitem', { name: '閉室北' })
    expect(within(invited).getByText('ben')).toBeInTheDocument()
    expect(within(invited).getByText('等待回覆')).toBeInTheDocument()
    expect(within(invited).getByRole('img', { name: '離線' })).toBeInTheDocument()
    expect(within(screen.getByRole('listitem', { name: '開室東' })).getByText('TKB（2/1）')).toBeInTheDocument()
    expect(screen.getByText('兩室的機器人座位不對稱：同一副牌在兩室會由不同組合的真人和機器人打。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '開始比賽' })).toBeDisabled()
    expect(screen.getByText('8 個座位都要有人（真人接受邀請，或機器人）')).toBeInTheDocument()
  })

  it('lets the host invite a member to an empty seat, without those already in it or blocked', async () => {
    mocks.api.match.mockResolvedValue({ match: prepRoom() })
    mocks.api.matchSeat.mockResolvedValue({ match: prepRoom() })
    show('/matches/m1')
    const seat = await screen.findByRole('listitem', { name: '閉室東' })
    await userEvent.click(within(seat).getByRole('button', { name: '邀請' }))
    const picker = within(seat).getByRole('combobox', { name: '邀請社員坐閉室東' })
    const options = within(picker).getAllByRole('option').map((o) => o.textContent)
    expect(options).toEqual(['選擇社員', 'cat（在線）'])
    await userEvent.selectOptions(picker, 'cat')
    await userEvent.click(within(seat).getAllByRole('button', { name: '邀請' })[1])
    expect(mocks.api.matchSeat).toHaveBeenCalledWith('m1', { action: 'invite', room: 'closed', seat: 'E', userId: 'cat' })
  })

  it('lets the invited member accept or decline', async () => {
    mocks.me = 'ben'
    mocks.api.match.mockResolvedValue({ match: prepRoom() })
    mocks.api.matchSeat.mockResolvedValue({ match: null })
    show('/matches/m1')
    expect(await screen.findByRole('heading', { name: '你受邀坐閉室北，要參加嗎？' })).toBeInTheDocument()
    // Not the host: no settings, no start button
    expect(screen.queryByRole('button', { name: '開始比賽' })).toBeNull()
    expect(screen.queryByRole('button', { name: '邀請' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '拒絕' }))
    expect(mocks.api.matchSeat).toHaveBeenCalledWith('m1', { action: 'answer', accept: false })
    expect(await screen.findByText('找不到這場隊制賽，或你沒有權限查看')).toBeInTheDocument()
  })

  it('saves the host’s settings', async () => {
    mocks.api.match.mockResolvedValue({ match: prepRoom() })
    mocks.api.matchSettings.mockResolvedValue({ match: prepRoom() })
    show('/matches/m1')
    const boards = await screen.findByLabelText('副數')
    await userEvent.clear(boards)
    await userEvent.type(boards, '12')
    await userEvent.selectOptions(screen.getByLabelText('邀請方式'), 'captains')
    await userEvent.click(screen.getByRole('button', { name: '儲存' }))
    expect(mocks.api.matchSettings).toHaveBeenCalledWith('m1', expect.objectContaining({ boards: 12, invite: 'captains' }))
  })
})
