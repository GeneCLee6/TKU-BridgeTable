import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LobbyView, MemberStatus } from '../../shared/protocol.ts'
import { defaultTeamMatchSettings, MATCH_SEATS, teamAt, type MatchSeatView, type TeamMatchView } from '../../shared/team-match.ts'
import { MatchBanner } from '../../src/components/MatchBanner.tsx'
import { MatchesPage } from '../../src/pages/MatchesPage.tsx'
import { MatchPage } from '../../src/pages/MatchPage.tsx'
import { MatchReplayPage } from '../../src/pages/MatchReplayPage.tsx'
import { VugraphPage } from '../../src/pages/VugraphPage.tsx'
import { ApiError } from '../../src/lib/api.ts'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'

/**
 * The team match pages (F3, F4, F5): the list of one's matches, the prep room (e8-t06), starting it and
 * the score (e8-t07, e8-t10, e8-t11), the result page (e8-t12) and the host's controls while it is
 * played (e8-t14–e8-t16)
 */

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
    startMatch: vi.fn(),
    matchPlay: vi.fn(),
    matchVugraph: vi.fn(),
    matchVugraphChat: vi.fn(),
    record: vi.fn(),
  },
  me: 'amy',
  /** The viewer's permissions: TKB in the club's system needs `tkuSystem` (ROBOT.md §7) */
  permissions: [] as string[],
  /** The latest team match pushed over the socket (`ClubContext.matchLive`) */
  matchLive: null as { matchId: string; match: TeamMatchView | null } | null,
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
  useClub: () => ({ lobby: LOBBY, notifications: null, matchLive: mocks.matchLive, status: 'open', table: null, error: null }),
}))
vi.mock('../../src/state/AuthContext.tsx', () => ({
  useAuth: () => ({ user: { id: mocks.me, username: mocks.me, admin: false, permissions: mocks.permissions } }),
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
  const page = () => (
    <PreferencesProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/matches" element={<MatchesPage />} />
          <Route path="/matches/:matchId" element={<MatchPage />} />
          <Route path="/matches/:matchId/vugraph" element={<VugraphPage />} />
          <Route path="/matches/:matchId/replay" element={<MatchReplayPage />} />
        </Routes>
      </MemoryRouter>
    </PreferencesProvider>
  )
  const { rerender } = render(page())
  return { again: () => rerender(page()) }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.me = 'amy'
  mocks.matchLive = null
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

  it('drops a match from the list as soon as it is cancelled, and reads the list again', async () => {
    const other = prepRoom({ id: 'm2', settings: { ...defaultTeamMatchSettings(), teamNames: ['政大', ''] } })
    mocks.api.matches.mockResolvedValue({ matches: [prepRoom(), other] })
    const { again } = show('/matches')
    expect(await screen.findByText('淡江 對 B 隊')).toBeInTheDocument()
    // The server leaves the cancelled one out from now on
    mocks.api.matches.mockResolvedValue({ matches: [other] })
    mocks.matchLive = { matchId: 'm1', match: prepRoom({ status: 'cancelled' }) }
    again()
    expect(screen.queryByText('淡江 對 B 隊')).not.toBeInTheDocument()
    await waitFor(() => expect(mocks.api.matches).toHaveBeenCalledTimes(2))
    expect(screen.getByText('政大 對 B 隊')).toBeInTheDocument()
    // One the member may no longer see goes too
    mocks.api.matches.mockResolvedValue({ matches: [] })
    mocks.matchLive = { matchId: 'm2', match: null }
    again()
    expect(screen.queryByText('政大 對 B 隊')).not.toBeInTheDocument()
    await waitFor(() => expect(mocks.api.matches).toHaveBeenCalledTimes(3))
    expect(screen.queryByText('淡江 對 B 隊')).not.toBeInTheDocument()
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
    await userEvent.click(screen.getByLabelText('觀看者落後一墩（避免場外傳遞牌情）'))
    await userEvent.click(screen.getByRole('button', { name: '儲存' }))
    expect(mocks.api.matchSettings).toHaveBeenCalledWith('m1', expect.objectContaining({ boards: 12, invite: 'captains', delay: true }))
  })

  it('lets only a host with tkuSystem choose the robots’ system (ROBOT.md §7)', async () => {
    mocks.api.match.mockResolvedValue({ match: prepRoom() })
    show('/matches/m1')
    await screen.findByLabelText('副數')
    expect(screen.queryByLabelText('機器人的制度')).toBeNull()
    cleanup()
    mocks.permissions = ['tkuSystem']
    show('/matches/m1')
    const kind = await screen.findByLabelText('機器人的制度')
    expect([...kind.querySelectorAll('option')].map((o) => o.value)).toEqual(['tku', 'gib'])
    mocks.permissions = []
  })
})

/** The match being played: amy and ben seated, the rest robots, board 1 scored */
function playing(extra: Partial<TeamMatchView> = {}): TeamMatchView {
  const base = prepRoom()
  return {
    ...base,
    status: 'playing',
    startedAt: 1,
    ready: undefined,
    tables: { open: 't-open', closed: 't-closed' },
    seats: base.seats.map((s) =>
      s.userId === 'ben' ? { ...s, status: 'seated' } : s.status === 'empty' ? { ...s, status: 'seated', robot: true } : s,
    ),
    boards: [
      {
        seq: 1,
        open: { boardId: 'r1', scoreNS: 420 },
        closed: { boardId: 'r2', scoreNS: -50 },
        result: { A: 10, B: 0, net: 470, ruled: false },
      },
    ],
    totals: { A: 10, B: 0 },
    leader: 'A',
    ...extra,
  }
}

describe('MatchPage while the match is played (F4)', () => {
  it('lets the host start once everyone is there, and takes them to their table', async () => {
    mocks.api.match.mockResolvedValue({ match: prepRoom({ ready: { ready: true } }) })
    mocks.api.startMatch.mockResolvedValue({ match: playing() })
    show('/matches/m1')
    expect(await screen.findByText('人都到齊了，可以開始比賽。兩室會同時發第 1 副。')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '開始比賽' }))
    expect(mocks.api.startMatch).toHaveBeenCalledWith('m1')
    await waitFor(() => expect(navigated).toHaveBeenCalledWith('/table/t-open'))
  })

  it('shows a player the score of boards both rooms played and the way back to their own table only', async () => {
    mocks.me = 'ben'
    mocks.api.match.mockResolvedValue({ match: playing() })
    show('/matches/m1')
    expect(await screen.findByRole('heading', { name: '比分' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: '比分' })).toHaveTextContent('淡江10 : 0B 隊VP 13.78 : 6.22已計分 1 / 8 副')
    expect(screen.getByRole('link', { name: '回到我的牌桌' })).toHaveAttribute('href', '/table/t-closed')
    expect(screen.queryByRole('link', { name: '觀看開室' })).toBeNull()
    expect(screen.getByRole('link', { name: '420' })).toHaveAttribute('href', '/history/r1')
    // Nothing of the setup is left
    expect(screen.queryByRole('button', { name: '開始比賽' })).toBeNull()
    expect(screen.queryByRole('button', { name: '離開比賽' })).toBeNull()
  })

  it('offers anyone else both rooms to watch', async () => {
    mocks.me = 'zed'
    mocks.api.match.mockResolvedValue({ match: playing() })
    show('/matches/m1')
    expect(await screen.findByRole('link', { name: '觀看開室' })).toHaveAttribute('href', '/table/t-open')
    expect(screen.getByRole('link', { name: '觀看閉室' })).toHaveAttribute('href', '/table/t-closed')
    expect(screen.getByRole('link', { name: '觀賽（Vugraph）' })).toHaveAttribute('href', '/matches/m1/vugraph')
    expect(screen.getByRole('link', { name: '整場重播' })).toHaveAttribute('href', '/matches/m1/replay')
  })

  it('names the winner once the match is over', async () => {
    mocks.api.match.mockResolvedValue({ match: playing({ status: 'finished', tables: undefined, endedAt: 2 }) })
    show('/matches/m1')
    expect(await screen.findByRole('heading', { name: '比賽結束' })).toBeInTheDocument()
    expect(screen.getByText('淡江 獲勝')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: '回到我的牌桌' })).toBeNull()
  })
})

describe('MatchBanner (e8-t10)', () => {
  it('shows the room, the board and the score over the table, and waits for the other room at the end', async () => {
    mocks.api.match.mockResolvedValue({ match: playing() })
    render(
      <PreferencesProvider>
        <MemoryRouter>
          <MatchBanner match={{ id: 'm1', room: 'open', seq: 8, boards: 8, played: 8, over: true }} />
        </MemoryRouter>
      </PreferencesProvider>,
    )
    expect(screen.getByRole('link', { name: '開室 · 第 8 / 8 副' })).toHaveAttribute('target', '_blank')
    expect(await screen.findByRole('group', { name: '比分' })).toHaveTextContent('10 : 0')
    expect(screen.getByRole('status')).toHaveTextContent('這一室打完了，等待另一室')
  })
})

describe('MatchesPage with matches being played', () => {
  it('lists the matches being played for anyone to follow', async () => {
    mocks.api.matches.mockResolvedValue({ matches: [] })
    LOBBY.matches = [{ id: 'm9', teamNames: ['', '資管'], tables: { open: 'a', closed: 'b' } }]
    show('/matches')
    expect(await screen.findByRole('link', { name: /A 隊 對 資管/ })).toHaveAttribute('href', '/matches/m9')
    LOBBY.matches = undefined
  })
})

describe('the result page and the host’s controls (F5)', () => {
  const details = {
    open: { boardId: 'r1', scoreNS: 420, contract: { level: 4, strain: 'S', doubled: '', declarer: 'S' }, declarerTricks: 10, lead: 'HK' },
    closed: { boardId: 'r2', scoreNS: -50, contract: { level: 4, strain: 'S', doubled: '', declarer: 'N' }, declarerTricks: 9, lead: 'D2' },
  } as const

  it('compares the rooms board by board, with the running score, a replay and the host’s rulings', async () => {
    mocks.me = 'zed'
    const ruled = { seq: 2, open: { boardId: 'r3', scoreNS: 100 }, ruling: { kind: 'avgPlus', team: 'B', reason: '閉室超時' }, result: { A: 0, B: 3, ruled: true } } as const
    mocks.api.match.mockResolvedValue({
      match: playing({ status: 'finished', tables: undefined, endedAt: 2, boards: [{ seq: 1, ...details, result: { A: 10, B: 0, net: 470, ruled: false } }, ruled], totals: { A: 10, B: 3 } }),
    })
    show('/matches/m1')
    const table = await screen.findByRole('table')
    const rows = within(table).getAllByRole('row')
    expect(rows[2]).toHaveTextContent('4♠ S')
    expect(rows[2]).toHaveTextContent('=')
    expect(rows[2]).toHaveTextContent('4♠ N')
    expect(rows[2]).toHaveTextContent('-1')
    expect(rows[2]).toHaveTextContent('10 : 0')
    expect(within(rows[2]).getByRole('link', { name: '並排重播 1' })).toHaveAttribute('href', '/history/r1/vs/r2')
    expect(rows[3]).toHaveTextContent('10 : 3')
    expect(within(table).getByText('裁定 Avg+（B 隊）：閉室超時')).toBeInTheDocument()
  })

  it('lets the host pause, rule on a room over the time limit, and have a robot sit in', async () => {
    const now = Date.now()
    mocks.api.match.mockResolvedValue({
      match: playing({ rooms: { open: { seq: 3, playing: true, endsAt: now + 4 * 60_000 }, closed: { seq: 2, playing: true, endsAt: now - 1000 } } }),
    })
    mocks.api.matchPlay.mockResolvedValue({ match: playing() })
    show('/matches/m1')
    expect(await screen.findByRole('heading', { name: '比賽管理' })).toBeInTheDocument()
    expect(screen.getByText('開室：第 3 副')).toBeInTheDocument()
    expect(screen.getByText('剩 4 分鐘')).toBeInTheDocument()
    expect(screen.getByText('已超時')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '中止比賽' })).toBeDisabled()
    await userEvent.selectOptions(screen.getByLabelText('裁定第 2 副'), 'avgMinus')
    await userEvent.selectOptions(screen.getByLabelText('給哪一隊'), 'B')
    await userEvent.type(screen.getByLabelText('理由'), '慢')
    await userEvent.click(screen.getByRole('button', { name: '送出裁定' }))
    expect(mocks.api.matchPlay).toHaveBeenCalledWith('m1', { action: 'rule', seq: 2, ruling: 'avgMinus', team: 'B', reason: '慢' })
    await userEvent.click(screen.getAllByRole('button', { name: '改由機器人代打' })[0])
    expect(mocks.api.matchPlay).toHaveBeenCalledWith('m1', { action: 'sitin', room: 'open', seat: 'S' })
    mocks.api.matchPlay.mockResolvedValue({ match: playing({ pausedAt: now }) })
    await userEvent.click(screen.getByRole('button', { name: '暫停比賽' }))
    expect(mocks.api.matchPlay).toHaveBeenCalledWith('m1', { action: 'pause', paused: true })
    expect(await screen.findByRole('button', { name: '繼續比賽' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '中止比賽' })).toBeEnabled()
  })

  it('lets the host bring in a substitute while paused, and marks a robot sitting in', async () => {
    const match = playing({ pausedAt: 1 })
    match.seats = match.seats.map((s) => (s.userId === 'ben' ? { ...s, substitute: true } : s))
    mocks.api.match.mockResolvedValue({ match })
    mocks.api.matchPlay.mockResolvedValue({ match })
    show('/matches/m1')
    const ben = await screen.findByLabelText('閉室北')
    expect(within(ben).getByText('機器人代打中')).toBeInTheDocument()
    await userEvent.click(within(ben).getByRole('button', { name: '替補' }))
    await userEvent.selectOptions(screen.getByLabelText('選擇替補閉室北的社員'), 'cat')
    await userEvent.click(within(ben).getAllByRole('button', { name: '替補' })[1])
    expect(mocks.api.matchPlay).toHaveBeenCalledWith('m1', { action: 'replace', room: 'closed', seat: 'N', userId: 'cat' })
  })

  it('tells everyone at the table the match is paused', () => {
    render(
      <PreferencesProvider>
        <MemoryRouter>
          <MatchBanner match={{ id: 'm1', room: 'open', seq: 2, boards: 8, played: 1, over: false, paused: true }} />
        </MemoryRouter>
      </PreferencesProvider>,
    )
    expect(screen.getByRole('status')).toHaveTextContent('房主暫停了比賽')
  })
})

describe('segments and changing seats between them (e8-t21)', () => {
  it('lets the host set boards per segment', async () => {
    mocks.api.match.mockResolvedValue({ match: prepRoom() })
    mocks.api.matchSettings.mockResolvedValue({ match: prepRoom() })
    show('/matches/m1')
    await userEvent.selectOptions(await screen.findByLabelText('分段'), '每段 4 副（共 2 段）')
    await userEvent.click(screen.getByRole('button', { name: '儲存' }))
    expect(mocks.api.matchSettings).toHaveBeenCalledWith('m1', expect.objectContaining({ boards: 8, segmentBoards: 4 }))
  })

  it('shows the break between segments: the captain swaps seats, the host starts the next segment', async () => {
    const match = playing({ settings: { ...defaultTeamMatchSettings(), segmentBoards: 4 }, segment: 1, breakAt: 5 })
    mocks.api.match.mockResolvedValue({ match })
    mocks.api.matchPlay.mockResolvedValue({ match })
    mocks.api.matchSeat.mockResolvedValue({ match })
    show('/matches/m1')
    expect(await screen.findByText('第 1 / 2 段')).toBeInTheDocument()
    expect(screen.getByText(/第 1 段打完了。隊長可以換座位/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '中止比賽' })).toBeEnabled()
    await userEvent.click(within(screen.getByLabelText('開室南')).getByRole('button', { name: '換位' }))
    await userEvent.click(within(screen.getByLabelText('閉室東')).getByRole('button', { name: '換到這裡' }))
    expect(mocks.api.matchSeat).toHaveBeenCalledWith('m1', { action: 'move', from: { room: 'open', seat: 'S' }, to: expect.objectContaining({ room: 'closed', seat: 'E' }) })
    await userEvent.click(screen.getByRole('button', { name: '開始第 2 段' }))
    expect(mocks.api.matchPlay).toHaveBeenCalledWith('m1', { action: 'next' })
  })

  it('names the segment over the table, and says when the room waits for the next', async () => {
    mocks.api.match.mockResolvedValue({ match: playing({ segment: 1 }) })
    render(
      <PreferencesProvider>
        <MemoryRouter>
          <MatchBanner match={{ id: 'm1', room: 'open', seq: 4, boards: 8, played: 4, over: true, segment: { n: 1, of: 2 } }} />
        </MemoryRouter>
      </PreferencesProvider>,
    )
    expect(screen.getByText('第 1 / 2 段')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('第 1 段打完了，等房主開始下一段')
  })

  it('takes a player whose pair changed rooms to their new table once the next segment starts', async () => {
    // Amy sits in the open room now; her browser is still at the closed room's table
    mocks.api.match.mockResolvedValue({ match: playing({ segment: 2 }) })
    render(
      <PreferencesProvider>
        <MemoryRouter>
          <MatchBanner match={{ id: 'm1', room: 'closed', seq: 4, boards: 8, played: 4, over: true, segment: { n: 1, of: 2 } }} />
        </MemoryRouter>
      </PreferencesProvider>,
    )
    await waitFor(() => expect(navigated).toHaveBeenCalledWith('/table/t-open'))
  })
})

describe('the Vugraph page (e8-t18, e8-t19) and the whole match replayed (e8-t20)', () => {
  const room = (tableId: string, seq: number) => ({
    tableId,
    seats: {
      N: { id: 'robot:gib:N', username: 'TKB', robot: true, online: true },
      E: { id: 'robot:gib:E', username: 'TKB', robot: true, online: true },
      S: { id: 'amy', username: 'amy', online: true },
      W: { id: 'robot:gib:W', username: 'TKB', robot: true, online: true },
    },
    board: {
      boardNo: seq,
      dealer: 'N',
      vul: 'none',
      phase: 'play',
      hands: {
        N: ['SA', 'SK', 'SQ', 'SJ', 'ST', 'S9', 'S8', 'S7', 'S6', 'S5', 'S4', 'S3'],
        E: ['HA', 'HK', 'HQ', 'HJ', 'HT', 'H9', 'H8', 'H7', 'H6', 'H5', 'H4', 'H3'],
        S: ['DA', 'DK', 'DQ', 'DJ', 'DT', 'D9', 'D8', 'D7', 'D6', 'D5', 'D4', 'D3'],
        W: ['CA', 'CK', 'CQ', 'CJ', 'CT', 'C9', 'C8', 'C7', 'C6', 'C5', 'C4', 'C3'],
      },
      handCounts: { N: 12, E: 12, S: 12, W: 12 },
      auction: [
        { seat: 'N', call: '1S' },
        { seat: 'E', call: 'P' },
        { seat: 'S', call: 'P' },
        { seat: 'W', call: 'P' },
      ],
      contract: { level: 1, strain: 'S', doubled: '', declarer: 'N' },
      dummy: 'S',
      turn: 'N',
      tricks: [
        {
          leader: 'E',
          cards: [
            { seat: 'E', card: 'H2' },
            { seat: 'S', card: 'D2' },
            { seat: 'W', card: 'C2' },
            { seat: 'N', card: 'S2' },
          ],
          winner: 'N',
        },
      ],
      tricksWon: { NS: 1, EW: 0 },
      legalCards: [],
      legalCalls: [],
      canUndo: false,
      canClaim: false,
    },
    match: { id: 'm1', room: tableId === 't-open' ? 'open' : 'closed', seq, boards: 8, played: seq - 1, over: false },
  })

  it('shows both rooms side by side with the score, and the watchers talk among themselves', async () => {
    mocks.me = 'zed'
    const settings = { ...defaultTeamMatchSettings(), teamNames: ['淡江', ''] as [string, string], delay: true }
    const page = { match: playing({ settings }), rooms: { open: room('t-open', 2), closed: room('t-closed', 2) }, chat: [] }
    mocks.api.matchVugraph.mockResolvedValue({ vugraph: page })
    mocks.api.matchVugraphChat.mockResolvedValue({ vugraph: { ...page, chat: [{ id: 'c1', at: 1, userId: 'zed', username: 'zed', text: '好牌' }] } })
    show('/matches/m1/vugraph')
    expect(await screen.findByRole('heading', { name: '觀賽（Vugraph） · 淡江 對 B 隊' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: '比分' })).toHaveTextContent('VP 13.78 : 6.22')
    expect(screen.getByText(/觀看者落後一墩/)).toBeInTheDocument()
    const open = screen.getByRole('region', { name: '開室' })
    expect(within(open).getByRole('heading', { name: '開室 · 第 2 / 8 副' })).toBeInTheDocument()
    expect(within(open).getByText(/南北 1 墩 · 東西 0 墩/)).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '閉室' })).toBeInTheDocument()
    expect(screen.getByText('還沒有人說話。')).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('和其他觀看者聊聊…'), '好牌')
    await userEvent.click(screen.getByRole('button', { name: '送出' }))
    expect(mocks.api.matchVugraphChat).toHaveBeenCalledWith('m1', '好牌')
    expect(await screen.findByText('好牌')).toBeInTheDocument()
  })

  it('tells a player they may not watch while the match is on', async () => {
    mocks.api.matchVugraph.mockRejectedValue(new ApiError('no', 403, 'matchNoWatching'))
    show('/matches/m1/vugraph')
    expect(await screen.findByRole('alert')).toBeInTheDocument()
  })

  it('replays every board both rooms played, one after another', async () => {
    const third = { seq: 3, open: { boardId: 'r5', scoreNS: 100 }, closed: { boardId: 'r6', scoreNS: 100 }, result: { A: 0, B: 0, net: 0, ruled: false } }
    const ruled = { seq: 2, ruling: { kind: 'avg', team: 'A', reason: '超時' }, open: { boardId: 'r3', scoreNS: 50 }, result: { A: 0, B: 0, ruled: true } } as const
    mocks.api.match.mockResolvedValue({ match: playing({ status: 'finished', tables: undefined, boards: [...playing().boards, ruled, third] }) })
    const record = (id: string, boardNo: number) => ({
      id,
      tableNumber: 0,
      finishedAt: 1,
      players: { N: { id: 'n', username: 'n' }, E: { id: 'e', username: 'e' }, S: { id: 's', username: 's' }, W: { id: 'w', username: 'w' } },
      board: {
        boardNo,
        dealer: 'N',
        vul: 'none',
        hands: { N: [], E: [], S: [], W: [] },
        auction: [],
        contract: null,
        play: [],
        phase: 'finished',
        result: { contract: null, declarerTricks: null, scoreNS: 0, claimed: false },
      },
    })
    mocks.api.record.mockImplementation((id: string) => Promise.resolve({ record: record(id, id === 'r1' || id === 'r2' ? 1 : 3) }))
    show('/matches/m1/replay')
    expect(await screen.findByRole('heading', { level: 1, name: /整場重播/ })).toBeInTheDocument()
    await waitFor(() => expect(mocks.api.record).toHaveBeenCalledWith('r1'))
    expect(mocks.api.record).toHaveBeenCalledWith('r2')
    // Board 2 was ruled with one room unplayed: it is not in the replay
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['第 1 副', '第 3 副'])
    expect(screen.getByRole('button', { name: '上一副' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: '下一副' }))
    await waitFor(() => expect(mocks.api.record).toHaveBeenCalledWith('r5'))
    expect(mocks.api.record).toHaveBeenCalledWith('r6')
    expect(screen.getByRole('button', { name: '下一副' })).toBeDisabled()
  })
})
