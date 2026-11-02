import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  defaultChallengeSettings,
  type ChallengePlayerView,
  type ChallengeTravellerEntry,
  type ChallengeView,
} from '../../shared/challenge.ts'
import { fullDeck } from '../../shared/cards.ts'
import { makeCall, newBoard, turnOf, type BoardState } from '../../shared/game.ts'
import type { BoardRecord, LobbyView, MemberStatus } from '../../shared/protocol.ts'
import { ChallengeDialog } from '../../src/components/ChallengeDialog.tsx'
import { ChallengeBoardPage } from '../../src/pages/ChallengeBoardPage.tsx'
import { ChallengePage } from '../../src/pages/ChallengePage.tsx'
import { ChallengesPage } from '../../src/pages/ChallengesPage.tsx'
import { ChallengeStatsPage } from '../../src/pages/ChallengeStatsPage.tsx'
import { ApiError } from '../../src/lib/api.ts'
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
    daily: vi.fn(),
    createChallenge: vi.fn(),
    answerChallenge: vi.fn(),
    cancelChallenge: vi.fn(),
    challengeWithBoards: vi.fn(),
    rematchChallenge: vi.fn(),
    traveller: vi.fn(),
    record: vi.fn(),
    challengeThread: vi.fn(),
    postChallengeComment: vi.fn(),
    removeChallengeComment: vi.fn(),
    challengeStats: vi.fn(),
  },
  send: vi.fn(),
  /** amy's permissions: TKB in the club's system needs `tkuSystem` (ROBOT.md §7) */
  permissions: [] as string[],
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
  useAuth: () => ({ user: { id: 'amy', username: 'amy', admin: false, permissions: mocks.permissions } }),
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
  mocks.permissions = []
  mocks.api.daily.mockResolvedValue({
    daily: { settings: { enabled: false, robotKind: 'gib' }, next: null, today: null, yesterday: null, history: [] },
  })
  mocks.api.challengeThread.mockResolvedValue({ thread: { comments: [], canPost: false } })
})

describe('ChallengesPage (e7-t16)', () => {
  it('sorts challenges into 等待接受, 進行中 and 已完成, each a card that opens its page', async () => {
    mocks.api.challenges.mockResolvedValue({ challenges: [INVITED, ACTIVE, DONE] })
    show('/challenges', <ChallengesPage />)
    expect(await screen.findByRole('tab', { name: '等待接受 1' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: '進行中 1' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '已完成 1' })).toBeInTheDocument()

    const card = screen.getByRole('listitem', { name: 'ben 發起' })
    expect(within(card).getByText('還剩 2 天 5 小時')).toBeInTheDocument()
    expect(within(card).getByRole('progressbar', { name: 'ben · 已打 2／8 副' })).toHaveAttribute('aria-valuenow', '2')
    // The whole card is one link to the challenge's page; no buttons of its own, no 「排名」
    const link = within(card).getByRole('link', { name: 'ben 發起' })
    expect(link).toHaveAttribute('href', '/challenges/c1')
    expect(within(card).queryAllByRole('button')).toHaveLength(0)
    expect(within(card).queryByText('排名')).toBeNull()

    await userEvent.click(screen.getByRole('tab', { name: '進行中 1' }))
    const active = screen.getByRole('listitem', { name: 'amy 發起' })
    expect(within(active).getByRole('progressbar', { name: '你的進度 · 已打 3／8 副' })).toBeInTheDocument()
    expect(within(active).getByRole('link')).toHaveAttribute('href', '/challenges/c2')
  })

  it('links to the daily event while it runs (e9-t03)', async () => {
    mocks.api.challenges.mockResolvedValue({ challenges: [] })
    mocks.api.daily.mockResolvedValue({
      daily: { settings: { enabled: true, robotKind: 'gib' }, next: null, today: null, yesterday: null, history: [] },
    })
    show('/challenges', <ChallengesPage />)
    expect(await screen.findByRole('link', { name: '每日賽' })).toHaveAttribute('href', '/daily')
  })

  it('has no daily event link while it is off, for a member', async () => {
    mocks.api.challenges.mockResolvedValue({ challenges: [] })
    show('/challenges', <ChallengesPage />)
    await waitFor(() => expect(mocks.api.daily).toHaveBeenCalled())
    expect(screen.queryByRole('link', { name: '每日賽' })).not.toBeInTheDocument()
  })

  it('sorts and pages the list, and shows many participants side by side with how many more', async () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      challenge(`m${i + 1}`, {
        createdAt: NOW - (i + 1) * HOUR,
        deadline: NOW + (30 - i) * HOUR,
        players: [player('amy', 'accepted'), ...Array.from({ length: 19 }, (_, j) => player(`p${j + 1}`, 'invited'))],
      }),
    )
    mocks.api.challenges.mockResolvedValue({ challenges: many })
    show('/challenges', <ChallengesPage />)
    const panel = await screen.findByRole('tabpanel', { name: '等待接受' })
    const hrefs = () => within(screen.getByRole('tabpanel')).getAllByRole('link').map((a) => a.getAttribute('href'))
    // Newest first, 20 a page
    expect(hrefs()).toHaveLength(20)
    expect(hrefs()[0]).toBe('/challenges/m1')
    // Six of the nineteen others on the card, then how many more
    const first = within(panel).getAllByRole('listitem')[0]
    expect(within(first).getAllByText('未回覆')).toHaveLength(6)
    expect(within(first).getByText('還有 13 人')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '2' }))
    expect(hrefs()).toEqual(['/challenges/m21', '/challenges/m22', '/challenges/m23', '/challenges/m24', '/challenges/m25'])
    expect(screen.getByText('第 21–25 項，共 25 項')).toBeInTheDocument()

    await userEvent.selectOptions(screen.getByRole('combobox', { name: '排序' }), 'deadline')
    // Back to the first page, the soonest deadline first
    expect(hrefs()[0]).toBe('/challenges/m25')
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '排序' }), 'oldest')
    expect(hrefs()[0]).toBe('/challenges/m25')
    expect(hrefs()[19]).toBe('/challenges/m6')
  })
})

describe('answering, playing and calling off, on the challenge’s page', () => {
  it('accepts an invitation, then starts or continues playing it', async () => {
    mocks.api.challenge.mockResolvedValue({ challenge: INVITED })
    show('/challenges/c1', <ChallengePage />)
    // Not accepted yet: no play button
    await screen.findByRole('button', { name: '接受' })
    expect(screen.queryByRole('button', { name: '開始打' })).toBeNull()
    mocks.api.answerChallenge.mockResolvedValue({
      challenge: { ...INVITED, status: 'active', players: [INVITED.players[0], player('amy', 'accepted')] },
    })
    await userEvent.click(screen.getByRole('button', { name: '接受' }))
    expect(mocks.api.answerChallenge).toHaveBeenCalledWith('c1', true)
    await userEvent.click(await screen.findByRole('button', { name: '開始打' }))
    expect(mocks.send).toHaveBeenCalledWith({ type: 'playChallenge', challengeId: 'c1' })
  })

  it('continues a challenge already started; cat started, so amy can no longer call it off', async () => {
    mocks.api.challenge.mockResolvedValue({ challenge: ACTIVE })
    show('/challenges/c2', <ChallengePage />)
    await userEvent.click(await screen.findByRole('button', { name: '繼續打' }))
    expect(mocks.send).toHaveBeenCalledWith({ type: 'playChallenge', challengeId: 'c2' })
    expect(screen.queryByRole('button', { name: '取消挑戰' })).toBeNull()
  })

  it('lets the creator cancel while nobody else has started', async () => {
    const mine = challenge('c4', {})
    mocks.api.challenge.mockResolvedValue({ challenge: mine })
    mocks.api.cancelChallenge.mockResolvedValue({ challenge: { ...mine, status: 'cancelled', endedAt: NOW } })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    show('/challenges/c4', <ChallengePage />)
    await userEvent.click(await screen.findByRole('button', { name: '取消挑戰' }))
    expect(mocks.api.cancelChallenge).toHaveBeenCalledWith('c4')
    expect((await screen.findAllByText('已取消')).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: '取消挑戰' })).toBeNull()
  })
})

const membersShown = () =>
  within(screen.getByRole('listbox', { name: '邀請社員' }))
    .getAllByRole('option')
    .map((o) => o.textContent)

describe('ChallengeDialog (e7-t17)', () => {
  it('lists every other member on a click, filters as one types, and sends the chosen members and settings', async () => {
    mocks.permissions = ['tkuSystem']
    const onCreated = vi.fn()
    mocks.api.createChallenge.mockResolvedValue({ challenge: challenge('new', {}) })
    render(
      <PreferencesProvider>
        <ChallengeDialog onClose={() => {}} onCreated={onCreated} />
      </PreferencesProvider>,
    )
    const box = screen.getByRole('combobox', { name: '邀請社員' })
    await userEvent.click(box)
    // Every member but oneself, friend or not: zoe is not amy's friend
    expect(membersShown()).toEqual(['ben', 'bea', 'cat', 'zoe'])

    await userEvent.type(box, 'b')
    await waitFor(() => expect(membersShown()).toEqual(['ben', 'bea']))
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
    expect(screen.getByTestId('challenge-preview')).toHaveTextContent(/^邀請 2 位社員 · 12 副 · 比賽分（MP） · TKB（淡江制度） · 截止 .* · 最好的牌（Best Hand）$/)

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

  it('has no choice of robots for a member without tkuSystem: one TKB, the 2/1 one (ROBOT.md §7)', async () => {
    mocks.api.createChallenge.mockResolvedValue({ challenge: challenge('new', {}) })
    render(
      <PreferencesProvider>
        <ChallengeDialog onClose={() => {}} onCreated={() => {}} />
      </PreferencesProvider>,
    )
    expect(screen.queryByLabelText('機器人')).toBeNull()
    await userEvent.click(screen.getByRole('combobox', { name: '邀請社員' }))
    await userEvent.click(screen.getByRole('option', { name: 'ben' }))
    await userEvent.click(screen.getByRole('button', { name: '發出挑戰' }))
    expect(mocks.api.createChallenge).toHaveBeenCalledWith(['ben'], 8, expect.objectContaining({ robotKind: 'gib' }))
  })

  it('challenges with a board from the history: its robots, no board count or deal options (e7-t22)', async () => {
    mocks.permissions = ['tkuSystem']
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
    const box = screen.getByRole('combobox', { name: '邀請社員' })
    await userEvent.click(box)
    await userEvent.click(screen.getByRole('option', { name: 'ben' }))
    expect(screen.getByTestId('challenge-preview')).toHaveTextContent(/^邀請 1 位社員 · 1 副 · /)
    await userEvent.click(screen.getByRole('button', { name: '發出挑戰' }))
    expect(mocks.api.challengeWithBoards).toHaveBeenCalledWith(['ben'], ['rec1'], { scoring: 'imp', days: 3, ranking: 'players' })
  })

  it('asks for a member before sending', async () => {
    render(
      <PreferencesProvider>
        <ChallengeDialog onClose={() => {}} onCreated={() => {}} />
      </PreferencesProvider>,
    )
    await userEvent.click(screen.getByRole('button', { name: '發出挑戰' }))
    expect(screen.getByRole('alert')).toHaveTextContent('先選至少一位社員')
    expect(mocks.api.createChallenge).not.toHaveBeenCalled()
  })
})

describe('ChallengePage (e7-t18)', () => {
  it('shows places and totals, the viewer’s row highlighted, the unfinished below', async () => {
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
      }),
    })
    show('/challenges/c5', <ChallengePage />)
    // The places across the width, read row by row (a challenge can have ~20 people)
    const places = within(await screen.findByRole('region', { name: '最終排名' })).getByRole('list', { name: '總成績 · 比賽分（MP）' })
    const rows = within(places).getAllByRole('listitem')
    expect(rows.map((r) => r.textContent)).toEqual(['1ben75%', '2amy25%', '—cat1/2未完成 · 已打 1／2 副'])
    expect(rows[1]).toHaveAttribute('aria-current', 'true')
    expect(mocks.api.challenge).toHaveBeenCalledWith('c5')
    // No travellers from the server, no boards
    expect(screen.queryByRole('region', { name: '每一副的結果' })).toBeNull()
  })

  it('lists every board with each player’s row and the viewer’s matchpoints against each of them', async () => {
    const entry = (userId: string, scoreNS: number, contract: ChallengeTravellerEntry['contract'], tricks: number, lead: string | null) => ({
      userId,
      boardId: `b-${userId}-${scoreNS}`,
      scoreNS,
      contract,
      declarerTricks: tricks,
      lead,
    })
    mocks.api.challenge.mockResolvedValue({
      challenge: challenge('c7', {
        status: 'finished',
        endedAt: NOW,
        deadline: NOW,
        boards: 2,
        settings: defaultChallengeSettings(2),
        players: [player('amy', 'accepted', 2), player('ben', 'accepted', 2), player('cat', 'accepted', 2)],
        standings: {
          final: true,
          scoring: 'mp',
          ranked: [
            { userId: 'amy', rank: 1, total: 62.5, boards: [75, 50] },
            { userId: 'cat', rank: 2, total: 50, boards: [75, 25] },
            { userId: 'ben', rank: 3, total: 37.5, boards: [0, 75] },
          ],
          unfinished: [],
        },
        // amy 420 and 0, ben 170 and 50, cat 420 and −100
        travellers: [
          {
            seq: 1,
            boardNo: 1,
            entries: [
              entry('ben', 170, { level: 2, strain: 'S', doubled: '', declarer: 'S' }, 9, 'HK'),
              entry('amy', 420, { level: 4, strain: 'S', doubled: '', declarer: 'S' }, 10, 'HK'),
              entry('cat', 420, { level: 4, strain: 'S', doubled: '', declarer: 'N' }, 10, 'DA'),
            ],
          },
          {
            seq: 2,
            boardNo: 2,
            entries: [
              entry('amy', 0, null, 0, null),
              entry('ben', 50, { level: 3, strain: 'N', doubled: '', declarer: 'E' }, 8, 'S2'),
              entry('cat', -100, { level: 3, strain: 'N', doubled: '', declarer: 'E' }, 10, 'S2'),
            ],
          },
        ],
      }),
    })
    show('/challenges/c7', <ChallengePage />)
    // Against ben: won board 1, lost board 2: 50%; against cat: tied, then won: 75%; all four: 62.5%
    const versus = within(await screen.findByRole('region', { name: '你對每位的成績' })).getByRole('table')
    expect(within(versus).getAllByRole('row').map((r) => r.textContent)).toEqual([
      '社員比賽分（MP）',
      'cat比了 2 副75%',
      'ben比了 2 副50%',
      '對全部62.5%',
    ])
    const boards = screen.getByRole('region', { name: '每一副的結果' })
    const first = within(boards).getByRole('article', { name: '第 1 副' })
    expect(within(first).getAllByRole('row').map((r) => r.textContent)).toEqual([
      '社員合約首攻結果南北比賽分（MP）你對他',
      '你4♠ S♥K=+42075%—',
      'cat4♠ N♦A=+42075%50%',
      'ben2♠ S♥K+1+1700%100%',
    ])
    expect(within(first).getAllByRole('row')[1]).toHaveAttribute('aria-current', 'true')
    expect(within(first).getByRole('link', { name: '第 1 副' })).toHaveAttribute('href', '/challenges/c7/boards/1')
    // The board's title bar is the one link to it, no second 「看這一副」 (社長 2026-10-27)
    expect(within(first).queryByRole('link', { name: /看這一副/ })).toBeNull()
    expect(within(first).getByRole('link', { name: 'cat' })).toHaveAttribute('href', '/challenges/c7/boards/1?p=cat')
    const second = within(boards).getByRole('article', { name: '第 2 副' })
    expect(within(second).getAllByRole('row').map((r) => r.textContent)).toEqual([
      '社員合約首攻結果南北比賽分（MP）你對他',
      '你--——050%—',
      'cat3NT E♠2+1-10025%100%',
      'ben3NT E♠2-1+5075%0%',
    ])
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
    const places = await screen.findByRole('list', { name: /總成績/ })
    expect(within(places).getAllByRole('listitem')[0]).toHaveTextContent('amy · 已知牌')
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

describe('a challenge board’s page (社長, 2026-10-25)', () => {
  const hands = {
    N: fullDeck().filter((c) => c[0] === 'S'),
    E: fullDeck().filter((c) => c[0] === 'H'),
    S: fullDeck().filter((c) => c[0] === 'D'),
    W: fullDeck().filter((c) => c[0] === 'C'),
  }
  /** A board South declared at `contract`, finished as claimed */
  function record(id: string, userId: string, contract: string, scoreNS: number): BoardRecord {
    let board: BoardState = newBoard(1, hands)
    for (const call of [contract, 'P', 'P', 'P']) board = makeCall(board, turnOf(board)!, call)
    board = { ...board, phase: 'finished', result: { declarerTricks: 13, scoreNS, claimed: true } }
    const robot = (seat: string) => ({ id: `robot:gib:${seat}`, username: `TKB ${seat}`, robot: true })
    return {
      id,
      tableNumber: 0,
      finishedAt: 0,
      mode: 'challenge',
      eventId: 'c8',
      players: { N: robot('N'), E: robot('E'), S: { id: userId, username: userId }, W: robot('W') },
      board,
    }
  }
  const contract = (level: number) => ({ level, strain: 'D' as const, doubled: '' as const, declarer: 'S' as const })
  const showBoard = (path: string) =>
    render(
      <PreferencesProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/challenges/:challengeId/boards/:seq" element={<ChallengeBoardPage />} />
          </Routes>
        </MemoryRouter>
      </PreferencesProvider>,
    )

  it('shows the traveller and a tab per player with their auction and play, the viewer’s first', async () => {
    mocks.api.challenge.mockResolvedValue({
      challenge: challenge('c8', {
        status: 'finished',
        endedAt: NOW,
        deadline: NOW,
        boards: 1,
        players: [player('amy', 'accepted', 1), player('ben', 'accepted', 1)],
        standings: {
          final: true,
          scoring: 'imp',
          ranked: [
            { userId: 'ben', rank: 1, total: 13, boards: [13] },
            { userId: 'amy', rank: 2, total: -13, boards: [-13] },
          ],
          unfinished: [],
        },
        travellers: [
          {
            seq: 1,
            boardNo: 1,
            entries: [
              { userId: 'ben', boardId: 'b-ben', scoreNS: 1440, contract: contract(6), declarerTricks: 13, lead: 'HA' },
              { userId: 'amy', boardId: 'b-amy', scoreNS: 640, contract: contract(5), declarerTricks: 13, lead: 'HA' },
            ],
          },
        ],
      }),
    })
    mocks.api.traveller.mockResolvedValue({
      traveller: {
        kind: 'challenge',
        eventId: 'c8',
        seq: 1,
        boardNo: 1,
        scoring: 'imp',
        entries: [
          { userId: 'ben', user: { id: 'ben', username: 'ben' }, boardId: 'b-ben', contract: contract(6), declarer: { id: 'ben', username: 'ben' }, lead: 'HA', declarerTricks: 13, scoreNS: 1440, points: 13 },
          { userId: 'amy', user: { id: 'amy', username: 'amy' }, boardId: 'b-amy', contract: contract(5), declarer: { id: 'amy', username: 'amy' }, lead: 'HA', declarerTricks: 13, scoreNS: 640, points: -13 },
        ],
      },
    })
    mocks.api.record.mockImplementation(async (id: string) => ({
      record: id === 'b-amy' ? record('b-amy', 'amy', '5D', 640) : record('b-ben', 'ben', '6D', 1440),
    }))
    showBoard('/challenges/c8/boards/1')
    const tabs = await screen.findAllByRole('tab')
    // 640 − 1440 = −800: amy lost 13 IMPs to ben
    expect(tabs.map((tab) => tab.textContent)).toEqual(['你', 'ben-13'])
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true')
    // The traveller and the record are asked for in effects, which React runs after the render
    // that showed the tabs (passive effects may come a task later): wait for them, not assume them
    await waitFor(() => expect(mocks.api.traveller).toHaveBeenCalledWith('b-amy'))
    await waitFor(() => expect(mocks.api.record).toHaveBeenCalledWith('b-amy'))
    expect(await within(screen.getByRole('tabpanel', { name: '你' })).findByText('NS +640')).toBeInTheDocument()
    // The side-by-side replay from the traveller, against the viewer's own board
    const traveller = screen.getByRole('region', { name: /Traveller/ })
    expect(await within(traveller).findByRole('link', { name: /和ben並排看/ })).toHaveAttribute('href', '/history/b-amy/vs/b-ben')

    await userEvent.click(tabs[1])
    expect(await within(screen.getByRole('tabpanel', { name: 'ben' })).findByText('NS +1440')).toBeInTheDocument()
    expect(mocks.api.record).toHaveBeenCalledWith('b-ben')
  })

  const FINISHED_ONE = () =>
    challenge('c9', {
      status: 'finished',
      endedAt: NOW,
      deadline: NOW,
      boards: 1,
      players: [player('amy', 'accepted', 1), player('ben', 'accepted', 1)],
      travellers: [
        {
          seq: 1,
          boardNo: 1,
          entries: [
            { userId: 'amy', boardId: 'b-amy', scoreNS: 640, contract: contract(5), declarerTricks: 13 },
            { userId: 'ben', boardId: 'b-ben', scoreNS: 1440, contract: contract(6), declarerTricks: 13 },
          ],
        },
      ],
    })

  it('has a discussion thread for those who played every board (e7-t27)', async () => {
    mocks.api.challenge.mockResolvedValue({ challenge: FINISHED_ONE() })
    mocks.api.traveller.mockResolvedValue({ traveller: null })
    mocks.api.record.mockResolvedValue({ record: record('b-amy', 'amy', '5D', 640) })
    const ben = { id: 1, userId: 'ben', user: { id: 'ben', username: 'ben' }, text: 'Slam was cold', at: NOW, removable: false }
    mocks.api.challengeThread.mockResolvedValue({ thread: { comments: [ben], canPost: true } })
    mocks.api.postChallengeComment.mockResolvedValue({
      thread: { comments: [ben, { id: 2, userId: 'amy', user: { id: 'amy', username: 'amy' }, text: 'I stopped in five', at: NOW, removable: true }], canPost: true },
    })
    showBoard('/challenges/c9/boards/1')
    const thread = await screen.findByRole('region', { name: '討論' })
    expect(await within(thread).findByText('Slam was cold')).toBeInTheDocument()
    expect(mocks.api.challengeThread).toHaveBeenCalledWith('c9', 1)
    expect(within(thread).queryByRole('button', { name: '刪除' })).not.toBeInTheDocument()

    await userEvent.type(within(thread).getByRole('textbox'), 'I stopped in five')
    await userEvent.click(within(thread).getByRole('button', { name: '留言' }))
    expect(mocks.api.postChallengeComment).toHaveBeenCalledWith('c9', 1, 'I stopped in five')
    expect(await within(thread).findByText('I stopped in five')).toBeInTheDocument()
    expect(within(thread).getByRole('button', { name: '刪除' })).toBeInTheDocument()
    expect(within(thread).getByRole('textbox')).toHaveValue('')
  })

  it('shows no thread when the server says there is none for this member', async () => {
    mocks.api.challenge.mockResolvedValue({ challenge: FINISHED_ONE() })
    mocks.api.traveller.mockResolvedValue({ traveller: null })
    mocks.api.record.mockResolvedValue({ record: record('b-amy', 'amy', '5D', 640) })
    mocks.api.challengeThread.mockRejectedValue(new ApiError('找不到這個挑戰', 404, 'challengeGone'))
    showBoard('/challenges/c9/boards/1')
    await screen.findAllByRole('tab')
    await waitFor(() => expect(mocks.api.challengeThread).toHaveBeenCalled())
    expect(screen.queryByRole('region', { name: '討論' })).not.toBeInTheDocument()
  })

  it('reads only, without a box, for someone who did not play every board', async () => {
    mocks.api.challenge.mockResolvedValue({ challenge: FINISHED_ONE() })
    mocks.api.traveller.mockResolvedValue({ traveller: null })
    mocks.api.record.mockResolvedValue({ record: record('b-amy', 'amy', '5D', 640) })
    showBoard('/challenges/c9/boards/1')
    const thread = await screen.findByRole('region', { name: '討論' })
    expect(await within(thread).findByText('你沒打完全部副數，只能看不能留言。')).toBeInTheDocument()
    expect(within(thread).queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('says a board is not shown when the server sent no results for it', async () => {
    mocks.api.challenge.mockResolvedValue({ challenge: ACTIVE })
    showBoard('/challenges/c2/boards/1')
    expect(await screen.findByText('這一副現在還看不到別人的結果')).toBeInTheDocument()
    expect(mocks.api.record).not.toHaveBeenCalled()
    expect(mocks.api.traveller).not.toHaveBeenCalled()
  })
})

describe('ChallengeStatsPage (e7-t29)', () => {
  it('shows the record and the head to head with each opponent', async () => {
    mocks.api.challengeStats.mockResolvedValue({
      stats: {
        challenges: 2,
        firsts: 1,
        wins: 1,
        losses: 1,
        draws: 1,
        winRate: 0.5,
        boards: 6,
        averageImps: 0.5,
        opponents: [
          { opponent: 'ben', user: { id: 'ben', username: 'ben' }, challenges: 2, wins: 1, losses: 1, draws: 0, boards: 4, imps: 3, lastAt: NOW },
          { opponent: 'cat', challenges: 1, wins: 0, losses: 0, draws: 1, boards: 2, imps: 0, lastAt: NOW },
        ],
      },
    })
    show('/challenges/stats', <ChallengeStatsPage />)
    expect(await screen.findByText('50%')).toBeInTheDocument()
    expect(screen.getByText('+0.50')).toBeInTheDocument()
    const rows = within(screen.getByRole('region', { name: '對每位的戰績' })).getAllByRole('row')
    expect(rows[1]).toHaveTextContent('ben')
    expect(rows[1]).toHaveTextContent('1–1–0')
    expect(rows[1]).toHaveTextContent('+3')
    // A deleted opponent keeps their row without a name
    expect(rows[2]).toHaveTextContent('已刪除的社員')
  })

  it('says there is nothing to count yet', async () => {
    mocks.api.challengeStats.mockResolvedValue({
      stats: { challenges: 0, firsts: 0, wins: 0, losses: 0, draws: 0, winRate: null, boards: 0, averageImps: null, opponents: [] },
    })
    show('/challenges/stats', <ChallengeStatsPage />)
    expect(await screen.findByText(/還沒有算得到的挑戰/)).toBeInTheDocument()
  })
})

describe('partner challenges (e7-t28)', () => {
  it('picks the partner first, then the opposing pairs, and sends a partner challenge', async () => {
    mocks.api.createChallenge.mockResolvedValue({ challenge: challenge('new', {}) })
    render(
      <PreferencesProvider>
        <ChallengeDialog onClose={() => {}} onCreated={() => {}} />
      </PreferencesProvider>,
    )
    await userEvent.click(screen.getByRole('checkbox', { name: /雙人搭檔挑戰/ }))
    const box = screen.getByRole('combobox', { name: '邀請社員' })
    for (const name of ['ben', 'bea']) {
      await userEvent.click(box)
      await userEvent.click(screen.getByRole('option', { name }))
    }
    // Two picks do not pair up: the partner and half a pair
    await userEvent.click(screen.getByRole('button', { name: '發出挑戰' }))
    expect(screen.getByRole('alert')).toHaveTextContent('先選 1 位搭檔')
    expect(mocks.api.createChallenge).not.toHaveBeenCalled()
    await userEvent.click(box)
    await userEvent.click(screen.getByRole('option', { name: 'cat' }))
    expect(screen.getByText('你的搭檔').parentElement).toHaveTextContent('ben')
    expect(screen.getAllByText('第 1 組').map((e) => e.parentElement?.textContent)).toEqual(['第 1 組bea', '第 1 組cat'])
    // One opposing partnership: IMPs or total points, as one on one
    expect(within(screen.getByLabelText('計分')).getAllByRole('option').map((o) => o.textContent)).toEqual(['IMP', '總分'])
    expect(screen.getByTestId('challenge-preview')).toHaveTextContent('雙人搭檔 · 1 組對手')
    await userEvent.click(screen.getByRole('button', { name: '發出挑戰' }))
    expect(mocks.api.createChallenge).toHaveBeenCalledWith(['ben', 'bea', 'cat'], 8, expect.objectContaining({ scoring: 'imp', partners: true }))
  })

  const PAIRS = challenge('p1', {
    status: 'finished',
    endedAt: NOW,
    deadline: NOW,
    boards: 1,
    creatorId: 'ben',
    settings: { ...defaultChallengeSettings(1), partners: true },
    // amy is ben's partner: the partnership is under ben, invited first
    players: [
      player('ben', 'accepted', 1, { partnerId: 'amy' }),
      player('amy', 'accepted', 1, { partnerId: 'ben' }),
      player('cat', 'accepted', 1, { partnerId: 'zoe' }),
      player('zoe', 'accepted', 1, { partnerId: 'cat' }),
    ],
    standings: {
      final: true,
      scoring: 'imp',
      ranked: [
        { userId: 'cat', rank: 1, total: 6, boards: [6], partnerId: 'zoe' },
        { userId: 'ben', rank: 2, total: -6, boards: [-6], partnerId: 'amy' },
      ],
      unfinished: [],
    },
    travellers: [
      {
        seq: 1,
        boardNo: 1,
        entries: [
          { userId: 'ben', boardId: 'r-ben', scoreNS: 420, contract: { level: 4, strain: 'S', doubled: '', declarer: 'S' }, declarerTricks: 10, partnerId: 'amy' },
          { userId: 'cat', boardId: 'r-cat', scoreNS: 620, contract: { level: 4, strain: 'S', doubled: '', declarer: 'N' }, declarerTricks: 11, partnerId: 'zoe' },
        ],
      },
    ],
  })

  it('shows each partnership as one entry, the viewer’s own as 你和 partner', async () => {
    mocks.api.challenge.mockResolvedValue({ challenge: PAIRS })
    show('/challenges/p1', <ChallengePage />)
    const places = within(await screen.findByRole('region', { name: '最終排名' })).getByRole('list', { name: '總成績 · IMP' })
    const rows = within(places).getAllByRole('listitem')
    expect(rows.map((r) => r.textContent)).toEqual(['1cat & zoe+6', '2ben & amy-6'])
    // amy is the partnership's second member, and still sees it as her own
    expect(rows[1]).toHaveAttribute('aria-current', 'true')
    const board = within(screen.getByRole('region', { name: '每一副的結果' }))
    expect(board.getByRole('link', { name: '你和 ben' })).toBeInTheDocument()
    expect(board.getByRole('link', { name: 'cat & zoe' })).toBeInTheDocument()
    expect(document.body).toHaveTextContent('雙人搭檔')
  })

  it('waits for the partner to accept before offering to play', async () => {
    mocks.api.challenge.mockResolvedValue({
      challenge: challenge('p2', {
        status: 'active',
        settings: { ...defaultChallengeSettings(1), partners: true },
        players: [
          player('amy', 'accepted', 0, { partnerId: 'ben' }),
          player('ben', 'invited', 0, { partnerId: 'amy' }),
          player('cat', 'accepted', 0, { partnerId: 'zoe' }),
          player('zoe', 'accepted', 0, { partnerId: 'cat' }),
        ],
      }),
    })
    show('/challenges/p2', <ChallengePage />)
    expect(await screen.findByRole('status')).toHaveTextContent('搭檔還沒接受，兩人都接受才能開打')
    expect(screen.queryByRole('button', { name: '開始打' })).toBeNull()
  })
})
