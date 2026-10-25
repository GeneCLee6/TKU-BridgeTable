import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultChallengeSettings, type ChallengePlayerView, type ChallengeView } from '../../shared/challenge.ts'
import type { LobbyView, MemberStatus } from '../../shared/protocol.ts'
import { ChallengeDialog } from '../../src/components/ChallengeDialog.tsx'
import { ChallengePage } from '../../src/pages/ChallengePage.tsx'
import { ChallengesPage } from '../../src/pages/ChallengesPage.tsx'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'

/** The challenge pages (C6): the challenge lobby, the dialog that starts one, the standings */

const navigated = vi.hoisted(() => vi.fn())
vi.mock('react-router-dom', async (original) => ({
  ...(await original<typeof import('react-router-dom')>()),
  useNavigate: () => navigated,
}))

const mocks = vi.hoisted(() => ({
  api: {
    challenges: vi.fn(),
    challenge: vi.fn(),
    createChallenge: vi.fn(),
    answerChallenge: vi.fn(),
    cancelChallenge: vi.fn(),
    challengeWithBoards: vi.fn(),
    rematchChallenge: vi.fn(),
    traveller: vi.fn(),
  },
  send: vi.fn(),
}))

vi.mock('../../src/lib/api.ts', async (original) => ({
  ...(await original<typeof import('../../src/lib/api.ts')>()),
  api: mocks.api,
}))

const person = (id: string): MemberStatus => ({ id, username: id, online: true, tableNumber: null, seat: null })
const LOBBY: LobbyView = {
  online: [],
  members: [person('amy'), person('ben'), person('bea'), person('cat'), person('zoe')],
  tables: [],
  myTableId: null,
  friends: ['ben', 'bea', 'cat'],
  blocked: [],
}

vi.mock('../../src/state/ClubContext.tsx', () => ({
  useClub: () => ({ lobby: LOBBY, send: mocks.send, notifications: null, status: 'open', table: null, error: null }),
}))
vi.mock('../../src/state/AuthContext.tsx', () => ({
  useAuth: () => ({ user: { id: 'amy', username: 'amy', admin: false, permissions: [] } }),
}))

const HOUR = 3_600_000
const NOW = Date.now()

const player = (userId: string, status: ChallengePlayerView['status'], played = 0, extra: Partial<ChallengePlayerView> = {}): ChallengePlayerView => ({
  user: { id: userId, username: userId },
  userId,
  status,
  played,
  knownDeals: false,
  ...extra,
})

function challenge(id: string, extra: Partial<ChallengeView>): ChallengeView {
  return {
    id,
    creatorId: 'amy',
    createdAt: NOW - HOUR,
    status: 'pending',
    deadline: NOW + 2 * 24 * HOUR + 5 * HOUR + 60_000,
    settings: defaultChallengeSettings(1),
    boards: 8,
    players: [player('amy', 'accepted'), player('ben', 'invited')],
    ...extra,
  }
}

const INVITED = challenge('c1', {
  creatorId: 'ben',
  players: [player('ben', 'accepted', 2, { startedAt: NOW }), player('amy', 'invited')],
})
const ACTIVE = challenge('c2', {
  status: 'active',
  createdAt: NOW - 2 * HOUR,
  players: [player('amy', 'accepted', 3, { startedAt: NOW }), player('cat', 'accepted', 5, { startedAt: NOW })],
})
const DONE = challenge('c3', { status: 'finished', createdAt: NOW - 3 * HOUR, endedAt: NOW - HOUR, deadline: NOW - HOUR })

function show(path: string, element: React.ReactNode) {
  render(
    <PreferencesProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/challenges" element={element} />
          <Route path="/challenges/:challengeId" element={element} />
        </Routes>
      </MemoryRouter>
    </PreferencesProvider>,
  )
}

beforeEach(() => {
  for (const fn of Object.values(mocks.api)) fn.mockReset()
  mocks.send.mockReset()
})

describe('ChallengesPage (e7-t16)', () => {
  it('sorts challenges into 等待接受, 進行中 and 已完成 with opponents, progress and the time left', async () => {
    mocks.api.challenges.mockResolvedValue({ challenges: [INVITED, ACTIVE, DONE] })
    show('/challenges', <ChallengesPage />)
    expect(await screen.findByRole('tab', { name: '等待接受 (1)' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: '進行中 (1)' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '已完成 (1)' })).toBeInTheDocument()

    const card = screen.getByRole('listitem', { name: 'ben 發起' })
    expect(within(card).getByText('還剩 2 天 5 小時')).toBeInTheDocument()
    expect(within(card).getByRole('progressbar', { name: 'ben · 已打 2／8 副' })).toHaveAttribute('aria-valuenow', '2')
    // Not accepted yet: no play button, and no progress of one's own
    expect(within(card).queryByRole('button', { name: '開始打' })).toBeNull()

    mocks.api.answerChallenge.mockResolvedValue({
      challenge: { ...INVITED, status: 'active', players: [INVITED.players[0], player('amy', 'accepted')] },
    })
    await userEvent.click(within(card).getByRole('button', { name: '接受' }))
    expect(mocks.api.answerChallenge).toHaveBeenCalledWith('c1', true)
    // Accepted: it moves to 進行中, and the member can play it
    expect(await screen.findByRole('tab', { name: '進行中 (2)' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('tab', { name: '進行中 (2)' }))
    const active = screen.getByRole('listitem', { name: 'amy 發起' })
    expect(within(active).getByRole('progressbar', { name: '你的進度 · 已打 3／8 副' })).toBeInTheDocument()
    await userEvent.click(within(active).getByRole('button', { name: '繼續打' }))
    expect(mocks.send).toHaveBeenCalledWith({ type: 'playChallenge', challengeId: 'c2' })
    // cat started, so amy can no longer call it off
    expect(within(active).queryByRole('button', { name: '取消挑戰' })).toBeNull()
  })

  it('lets the creator cancel while nobody else has started', async () => {
    const mine = challenge('c4', {})
    mocks.api.challenges.mockResolvedValue({ challenges: [mine] })
    mocks.api.cancelChallenge.mockResolvedValue({ challenge: { ...mine, status: 'cancelled', endedAt: NOW } })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    show('/challenges', <ChallengesPage />)
    await userEvent.click(await screen.findByRole('button', { name: '取消挑戰' }))
    expect(mocks.api.cancelChallenge).toHaveBeenCalledWith('c4')
    expect(await screen.findByRole('tab', { name: '已完成 (1)' })).toBeInTheDocument()
  })
})

const friendsShown = () =>
  within(screen.getByRole('listbox', { name: '邀請好友' }))
    .getAllByRole('option')
    .map((o) => o.textContent)

describe('ChallengeDialog (e7-t17)', () => {
  it('lists every friend on a click, filters as one types, and sends the chosen friends and settings', async () => {
    const onCreated = vi.fn()
    mocks.api.createChallenge.mockResolvedValue({ challenge: challenge('new', {}) })
    render(
      <PreferencesProvider>
        <ChallengeDialog onClose={() => {}} onCreated={onCreated} />
      </PreferencesProvider>,
    )
    const box = screen.getByRole('combobox', { name: '邀請好友' })
    await userEvent.click(box)
    // Friends only: zoe is a member but not a friend
    expect(friendsShown()).toEqual(['ben', 'bea', 'cat'])

    await userEvent.type(box, 'b')
    await waitFor(() => expect(friendsShown()).toEqual(['ben', 'bea']))
    await userEvent.click(screen.getByRole('option', { name: 'bea' }))
    expect(screen.getByRole('button', { name: '移除 bea' })).toBeInTheDocument()
    // One opponent: IMPs or total points
    expect(within(screen.getByLabelText('計分')).getAllByRole('option').map((o) => o.textContent)).toEqual(['IMP', '總分'])

    await userEvent.click(box)
    await userEvent.click(screen.getByRole('option', { name: 'cat' }))
    // Two: matchpoints by default
    expect(screen.getByLabelText('計分')).toHaveValue('mp')
    await userEvent.selectOptions(screen.getByLabelText('副數'), '12')
    await userEvent.selectOptions(screen.getByLabelText('機器人'), 'tku')
    await userEvent.selectOptions(screen.getByLabelText('截止時間'), '5')
    await userEvent.click(screen.getByRole('checkbox', { name: /Best Hand/ }))
    expect(screen.getByTestId('challenge-preview')).toHaveTextContent(/^邀請 2 位好友 · 12 副 · 比賽分（MP） · TKB（淡江制度） · 截止 .* · 最好的牌（Best Hand）$/)

    await userEvent.click(screen.getByRole('button', { name: '發出挑戰' }))
    expect(mocks.api.createChallenge).toHaveBeenCalledWith(['bea', 'cat'], 12, {
      scoring: 'mp',
      robotKind: 'tku',
      bestHand: true,
      justDeclare: false,
      days: 5,
      ranking: 'players',
    })
    await waitFor(() => expect(onCreated).toHaveBeenCalled())
  })

  it('challenges with a board from the history: its robots, no board count or deal options (e7-t22)', async () => {
    mocks.api.challengeWithBoards.mockResolvedValue({ challenge: challenge('new', {}) })
    render(
      <PreferencesProvider>
        <ChallengeDialog onClose={() => {}} onCreated={() => {}} fromBoards={{ ids: ['rec1'], robotKind: 'tku' }} />
      </PreferencesProvider>,
    )
    expect(screen.getByRole('heading', { name: '用這副牌挑戰' })).toBeInTheDocument()
    expect(screen.queryByLabelText('副數')).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.getByLabelText('機器人')).toBeDisabled()
    expect(screen.getByLabelText('機器人')).toHaveValue('tku')
    const box = screen.getByRole('combobox', { name: '邀請好友' })
    await userEvent.click(box)
    await userEvent.click(screen.getByRole('option', { name: 'ben' }))
    expect(screen.getByTestId('challenge-preview')).toHaveTextContent(/^邀請 1 位好友 · 1 副 · /)
    await userEvent.click(screen.getByRole('button', { name: '發出挑戰' }))
    expect(mocks.api.challengeWithBoards).toHaveBeenCalledWith(['ben'], ['rec1'], { scoring: 'imp', days: 3, ranking: 'players' })
  })

  it('asks for a friend before sending', async () => {
    render(
      <PreferencesProvider>
        <ChallengeDialog onClose={() => {}} onCreated={() => {}} />
      </PreferencesProvider>,
    )
    await userEvent.click(screen.getByRole('button', { name: '發出挑戰' }))
    expect(screen.getByRole('alert')).toHaveTextContent('先選至少一位好友')
    expect(mocks.api.createChallenge).not.toHaveBeenCalled()
  })
})

describe('ChallengePage (e7-t18)', () => {
  it('shows places, totals and the person × board matrix, the viewer’s row highlighted, the unfinished below', async () => {
    const settings = defaultChallengeSettings(2)
    mocks.api.challenge.mockResolvedValue({
      challenge: challenge('c5', {
        status: 'finished',
        endedAt: NOW,
        deadline: NOW,
        boards: 2,
        settings,
        players: [player('amy', 'accepted', 2), player('ben', 'accepted', 2), player('cat', 'accepted', 1)],
        standings: {
          final: true,
          scoring: 'mp',
          ranked: [
            { userId: 'ben', rank: 1, total: 75, boards: [100, 50] },
            { userId: 'amy', rank: 2, total: 25, boards: [0, 50] },
          ],
          unfinished: [{ userId: 'cat', played: 1 }],
        },
        travellers: [
          { seq: 1, boardNo: 1, entries: [{ userId: 'amy', boardId: 'b-amy-1', scoreNS: -50, contract: null, declarerTricks: null }] },
          { seq: 2, boardNo: 2, entries: [] },
        ],
      }),
    })
    show('/challenges/c5', <ChallengePage />)
    const table = await screen.findByRole('table')
    const rows = within(table).getAllByRole('row').map((r) => r.textContent)
    expect(rows).toEqual([
      '名次社員總成績 · 比賽分（MP）#1#2',
      '1ben75%100%50%',
      '2amy25%0%50%',
      '—cat未完成 · 已打 1／2 副',
    ])
    expect(within(table).getAllByRole('row')[2]).toHaveAttribute('aria-current', 'true')
    expect(within(table).getByRole('link', { name: '0%' })).toHaveAttribute('href', '/history/b-amy-1')
    expect(screen.getByRole('heading', { name: '最終排名' })).toBeInTheDocument()
    expect(mocks.api.challenge).toHaveBeenCalledWith('c5')
  })

  it('opens a board’s traveller from the matrix, with “compare” against the viewer’s own board (e7-t19)', async () => {
    mocks.api.challenge.mockResolvedValue({
      challenge: challenge('c6', {
        status: 'finished',
        endedAt: NOW,
        deadline: NOW,
        boards: 1,
        settings: defaultChallengeSettings(1),
        players: [player('amy', 'accepted', 1), player('ben', 'accepted', 1)],
        standings: {
          final: true,
          scoring: 'imp',
          ranked: [
            { userId: 'ben', rank: 1, total: 5, boards: [5] },
            { userId: 'amy', rank: 2, total: -5, boards: [-5] },
          ],
          unfinished: [],
        },
        travellers: [
          {
            seq: 1,
            boardNo: 1,
            entries: [
              { userId: 'ben', boardId: 'b-ben-1', scoreNS: 420, contract: null, declarerTricks: null },
              { userId: 'amy', boardId: 'b-amy-1', scoreNS: 170, contract: null, declarerTricks: null },
            ],
          },
        ],
      }),
    })
    mocks.api.traveller.mockResolvedValue({
      traveller: {
        kind: 'challenge',
        eventId: 'c6',
        seq: 1,
        boardNo: 1,
        scoring: 'imp',
        entries: [
          { userId: 'ben', user: { id: 'ben', username: 'ben' }, boardId: 'b-ben-1', contract: { level: 4, strain: 'H', doubled: '', declarer: 'S' }, declarer: { id: 'ben', username: 'ben' }, lead: 'SA', declarerTricks: 10, scoreNS: 420, points: 5 },
          { userId: 'amy', user: { id: 'amy', username: 'amy' }, boardId: 'b-amy-1', contract: { level: 2, strain: 'H', doubled: '', declarer: 'S' }, declarer: { id: 'amy', username: 'amy' }, lead: 'SA', declarerTricks: 10, scoreNS: 170, points: -5 },
        ],
      },
    })
    show('/challenges/c6', <ChallengePage />)
    await userEvent.click(await screen.findByRole('button', { name: '#1' }))
    expect(mocks.api.traveller).toHaveBeenCalledWith('b-ben-1')
    const section = await screen.findByRole('region', { name: /Traveller/ })
    const compare = await within(section).findByRole('link', { name: /和ben並排看/ })
    expect(compare).toHaveAttribute('href', '/history/b-amy-1/vs/b-ben-1')
    expect(within(section).getAllByRole('row')[2]).toHaveAttribute('aria-current', 'true')
  })

  it('tells someone still playing that the results come once they finish', async () => {
    mocks.api.challenge.mockResolvedValue({ challenge: ACTIVE })
    show('/challenges/c2', <ChallengePage />)
    expect(await screen.findByText('打完全部副數，或挑戰結束後，才看得到別人的成績')).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.getByRole('progressbar', { name: 'cat · 已打 5／8 副' })).toBeInTheDocument()
  })
})

describe('rematch and known deals (e7-t21, e7-t22)', () => {
  it('offers a rematch once it ended and marks the creator’s known deals', async () => {
    const ended = challenge('c6', {
      status: 'finished',
      endedAt: NOW,
      deadline: NOW,
      boards: 1,
      players: [player('amy', 'accepted', 1, { knownDeals: true }), player('ben', 'accepted', 1)],
      standings: {
        final: true,
        scoring: 'imp',
        ranked: [
          { userId: 'amy', rank: 1, total: 3 },
          { userId: 'ben', rank: 2, total: -3 },
        ],
        unfinished: [],
      },
    })
    mocks.api.challenge.mockResolvedValue({ challenge: ended })
    mocks.api.rematchChallenge.mockResolvedValue({ challenge: challenge('c7', {}) })
    show('/challenges/c6', <ChallengePage />)
    const table = await screen.findByRole('table')
    expect(within(table).getAllByRole('row')[1]).toHaveTextContent('amy · 已知牌')
    await userEvent.click(screen.getByRole('button', { name: '再戰' }))
    expect(mocks.api.rematchChallenge).toHaveBeenCalledWith('c6')
    await waitFor(() => expect(navigated).toHaveBeenCalledWith('/challenges/c7'))
  })

  it('has no rematch while it is going on', async () => {
    mocks.api.challenge.mockResolvedValue({ challenge: ACTIVE })
    show('/challenges/c2', <ChallengePage />)
    await screen.findByText('打完全部副數，或挑戰結束後，才看得到別人的成績')
    expect(screen.queryByRole('button', { name: '再戰' })).toBeNull()
  })
})

describe('the weekly club challenge and the share card (e7-t23, e7-t24)', () => {
  it('names the club’s weekly challenge, has no rematch, and opens the share card for a ranked member', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const weekly = challenge('c8', {
      status: 'finished',
      endedAt: NOW,
      deadline: NOW,
      boards: 1,
      settings: { ...defaultChallengeSettings(2), ranking: 'club', days: 7, weekly: true },
      players: [player('amy', 'accepted', 1), player('ben', 'accepted', 1)],
      standings: {
        final: true,
        scoring: 'mp',
        ranked: [
          { userId: 'amy', rank: 1, total: 100, boards: [100] },
          { userId: 'ben', rank: 2, total: 0, boards: [0] },
        ],
        unfinished: [],
      },
    })
    mocks.api.challenge.mockResolvedValue({ challenge: weekly })
    show('/challenges/c8', <ChallengePage />)
    expect(await screen.findByRole('heading', { level: 1, name: '每週社團挑戰' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '再戰' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '成績分享卡' }))
    const dialog = screen.getByRole('dialog', { name: '成績分享卡' })
    expect(within(dialog).getByRole('img', { name: '我在「每週社團挑戰」拿到第 1 名（共 2 人）' })).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: '關閉' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('has no share card for someone still playing', async () => {
    mocks.api.challenge.mockResolvedValue({ challenge: ACTIVE })
    show('/challenges/c2', <ChallengePage />)
    await screen.findByText('打完全部副數，或挑戰結束後，才看得到別人的成績')
    expect(screen.queryByRole('button', { name: '成績分享卡' })).toBeNull()
  })
})
