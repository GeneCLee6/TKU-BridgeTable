import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultChallengeSettings, type ChallengePlayerView, type ChallengeView } from '../../shared/challenge.ts'
import type { Notification, NotificationsView, TableView } from '../../shared/protocol.ts'
import { defaultTeamMatchSettings, MATCH_SEATS, teamAt, type MatchSeatView, type TeamMatchView } from '../../shared/team-match.ts'
import { ToastProvider } from '../../src/components/Toast.tsx'
import { ApiError } from '../../src/lib/api.ts'
import { HANDLED_KEY } from '../../src/lib/invites.ts'
import { resetSoundState } from '../../src/lib/sound/player.ts'
import { synthesize } from '../../src/lib/sound/synth.ts'
import { InvitationsProvider, useInviteBanner } from '../../src/state/InvitationsContext.tsx'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'

/** Invitations pop up (`e1-t35`): the dialog, its three buttons, the banner at a table, once per browser */

vi.mock('../../src/lib/sound/synth.ts', () => ({ synthesize: vi.fn(), unlockAudio: vi.fn() }))

const mocks = vi.hoisted(() => ({
  api: { challenge: vi.fn(), match: vi.fn(), answerChallenge: vi.fn(), matchSeat: vi.fn() },
  club: {
    notifications: null as NotificationsView | null,
    matchLive: null as { matchId: string; match: TeamMatchView | null } | null,
    table: null as Partial<TableView> | null,
    send: vi.fn(),
  },
}))

vi.mock('../../src/lib/api.ts', async (original) => ({
  ...(await original<typeof import('../../src/lib/api.ts')>()),
  api: mocks.api,
}))
vi.mock('../../src/state/ClubContext.tsx', () => ({ useClub: () => mocks.club }))
vi.mock('../../src/state/AuthContext.tsx', () => ({
  useAuth: () => ({ user: { id: 'amy', username: 'amy', admin: false, permissions: [] } }),
}))

const HOUR = 3_600_000
const NOW = Date.now()

const player = (userId: string, status: ChallengePlayerView['status']): ChallengePlayerView => ({
  user: { id: userId, username: userId },
  userId,
  status,
  played: 0,
  knownDeals: false,
})

/** ben challenges amy (and cat) */
const challenge = (id: string, extra: Partial<ChallengeView> = {}): ChallengeView => ({
  id,
  creatorId: 'ben',
  createdAt: NOW - HOUR,
  status: 'pending',
  deadline: NOW + 3 * 24 * HOUR,
  settings: defaultChallengeSettings(2),
  boards: 8,
  players: [player('ben', 'accepted'), player('amy', 'invited'), player('cat', 'invited')],
  ...extra,
})

/** ben hosts a match and invites amy to the closed room's North */
function match(id: string, extra: Partial<TeamMatchView> = {}): TeamMatchView {
  const seats: MatchSeatView[] = MATCH_SEATS.map((s) => {
    const base = { ...s, team: teamAt(s.room, s.seat), robot: false }
    if (s.room === 'open' && s.seat === 'S') return { ...base, status: 'seated', userId: 'ben', user: { id: 'ben', username: 'ben' } }
    if (s.room === 'closed' && s.seat === 'N') return { ...base, status: 'invited', userId: 'amy', user: { id: 'amy', username: 'amy' } }
    return { ...base, status: 'empty' }
  })
  return {
    id,
    hostId: 'ben',
    createdAt: NOW,
    status: 'setup',
    settings: { ...defaultTeamMatchSettings(), teamNames: ['淡江', '政大'] },
    captains: { A: 'ben' },
    seats,
    boards: [],
    totals: { A: 0, B: 0 },
    leader: null,
    ...extra,
  }
}

let at = NOW - 10 * 60_000
const note = (id: string, kind: Notification['kind'], params: Notification['params'], read = false): Notification => ({
  id,
  at: (at += 1000),
  kind,
  params,
  read,
})
const bell = (...items: Notification[]): NotificationsView => ({ items: [...items].reverse(), unread: items.filter((n) => !n.read).length })

function Header() {
  return <div data-testid="header">{useInviteBanner()}</div>
}

function tree(path: string) {
  return (
    <PreferencesProvider>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <InvitationsProvider>
            <Header />
            <Routes>
              <Route path="/" element={<p>大廳頁</p>} />
              <Route path="/table/:id" element={<p>牌桌頁</p>} />
              <Route path="/challenges/:id" element={<p>挑戰頁</p>} />
              <Route path="/matches/:id" element={<p>準備室</p>} />
            </Routes>
          </InvitationsProvider>
        </MemoryRouter>
      </ToastProvider>
    </PreferencesProvider>
  )
}

function show(path = '/') {
  const view = render(tree(path))
  return { ...view, update: () => view.rerender(tree(path)) }
}

const invites = () => vi.mocked(synthesize).mock.calls.filter(([, event]) => event === 'invite').length

beforeEach(() => {
  vi.clearAllMocks()
  resetSoundState()
  mocks.club.notifications = null
  mocks.club.matchLive = null
  mocks.club.table = null
  mocks.api.challenge.mockImplementation(async (id: string) => ({ challenge: challenge(id) }))
  mocks.api.match.mockImplementation(async (id: string) => ({ match: match(id) }))
  mocks.api.answerChallenge.mockImplementation(async (id: string) => ({ challenge: challenge(id) }))
  mocks.api.matchSeat.mockImplementation(async (id: string) => ({ match: match(id) }))
})

describe('the invitation dialog', () => {
  it('pops up with the challenge’s details and a sound, and accepting leads to the challenge', async () => {
    const { update } = show()
    expect(screen.queryByRole('alertdialog')).toBeNull()
    mocks.club.notifications = bell(note('n1', 'challengeInvited', { challengeId: 'c1', username: 'ben' }))
    update()

    const dialog = await screen.findByRole('alertdialog', { name: 'ben 邀請你參加挑戰' })
    expect(mocks.api.challenge).toHaveBeenCalledWith('c1')
    expect(within(dialog).getByText('8 副 · 比賽分（MP） · TKB（2/1）')).toBeInTheDocument()
    expect(within(dialog).getByText(/^截止 .* · 還剩 2 天 23 小時$/)).toBeInTheDocument()
    expect(within(dialog).getByText('一起打的人：ben、cat')).toBeInTheDocument()
    // The ring is a passive effect: it may run just after the dialog is on the page
    await waitFor(() => expect(invites()).toBe(1))

    await userEvent.click(within(dialog).getByRole('button', { name: '接受' }))
    expect(mocks.api.answerChallenge).toHaveBeenCalledWith('c1', true)
    expect(mocks.club.send).toHaveBeenCalledWith({ type: 'readNotifications', ids: ['n1'] })
    expect(await screen.findByText('挑戰頁')).toBeInTheDocument()
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('declines at once, and stays on the page', async () => {
    mocks.club.notifications = bell(note('n1', 'challengeInvited', { challengeId: 'c1', username: 'ben' }))
    show()
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '拒絕' }))
    expect(mocks.api.answerChallenge).toHaveBeenCalledWith('c1', false)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(screen.getByText('大廳頁')).toBeInTheDocument()
    expect(screen.getByText('已拒絕邀請')).toBeInTheDocument()
  })

  it('answers later: it closes, stays unread in the bell, and does not pop up again in this browser', async () => {
    mocks.club.notifications = bell(note('n1', 'challengeInvited', { challengeId: 'c1', username: 'ben' }))
    const first = show()
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '稍後回覆' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(mocks.api.answerChallenge).not.toHaveBeenCalled()
    expect(mocks.club.send).not.toHaveBeenCalled()
    first.unmount()

    // A reload, or another tab
    show()
    await waitFor(() => expect(mocks.api.challenge).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('rings once in the browser: a second tab shows it without a sound, and closes when the first answers', async () => {
    mocks.club.notifications = bell(note('n1', 'challengeInvited', { challengeId: 'c1', username: 'ben' }))
    show()
    await screen.findByRole('alertdialog')
    await waitFor(() => expect(invites()).toBe(1))
    // Another tab opening the same page
    render(tree('/'))
    await waitFor(() => expect(screen.getAllByRole('alertdialog')).toHaveLength(2))
    expect(invites()).toBe(1)

    // One of them answers: the other hears of it through storage
    await userEvent.click(screen.getAllByRole('button', { name: '稍後回覆' })[0])
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: HANDLED_KEY })))
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('pops up what came while away one at a time, leaving out those that no longer stand', async () => {
    mocks.api.challenge.mockImplementation(async (id: string) => {
      if (id === 'old') return { challenge: challenge(id, { deadline: NOW - HOUR }) }
      if (id === 'done') return { challenge: challenge(id, { players: [player('ben', 'accepted'), player('amy', 'accepted')] }) }
      if (id === 'gone') throw new ApiError('not found', 404, 'challengeGone')
      return { challenge: challenge(id) }
    })
    mocks.club.notifications = bell(
      note('a', 'challengeInvited', { challengeId: 'old', username: 'ben' }),
      note('b', 'challengeInvited', { challengeId: 'c1', username: 'ben' }),
      note('c', 'challengeInvited', { challengeId: 'done', username: 'cat' }),
      note('d', 'matchInvited', { matchId: 'm1', username: 'ben' }),
      note('e', 'challengeInvited', { challengeId: 'gone', username: 'zoe' }),
    )
    show()
    const first = await screen.findByRole('alertdialog', { name: 'ben 邀請你參加挑戰' })
    await waitFor(() => expect(within(first).getByText('還有 1 個邀請')).toBeInTheDocument())
    await userEvent.click(within(first).getByRole('button', { name: '稍後回覆' }))

    const second = await screen.findByRole('alertdialog', { name: 'ben 邀請你參加隊制賽' })
    expect(within(second).getByText('淡江 對 政大')).toBeInTheDocument()
    expect(within(second).getByText('你的座位：閉室北（政大）')).toBeInTheDocument()
    expect(within(second).queryByText(/還有/)).toBeNull()
    await userEvent.click(within(second).getByRole('button', { name: '接受' }))
    expect(mocks.api.matchSeat).toHaveBeenCalledWith('m1', { action: 'answer', accept: true })
    expect(await screen.findByText('準備室')).toBeInTheDocument()
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('says so when the invitation is called off while it shows', async () => {
    mocks.club.notifications = bell(note('n1', 'challengeInvited', { challengeId: 'c1', username: 'ben' }))
    const { update } = show()
    await screen.findByRole('alertdialog')
    mocks.api.challenge.mockResolvedValue({ challenge: challenge('c1', { status: 'cancelled' }) })
    mocks.club.notifications = bell(
      note('n1', 'challengeInvited', { challengeId: 'c1', username: 'ben' }),
      note('n2', 'challengeCancelled', { challengeId: 'c1', username: 'ben' }),
    )
    update()
    const dialog = await screen.findByRole('alertdialog')
    expect(await within(dialog).findByText(/這個邀請已經失效/)).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: '接受' })).toBeNull()
    await userEvent.click(within(dialog).getByRole('button', { name: '關閉' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('says so when the member is taken off the match’s seat', async () => {
    mocks.club.notifications = bell(note('n1', 'matchInvited', { matchId: 'm1', username: 'ben' }))
    const { update } = show()
    await screen.findByRole('alertdialog')
    mocks.club.matchLive = { matchId: 'm1', match: null }
    update()
    expect(await screen.findByText(/這個邀請已經失效/)).toBeInTheDocument()
  })

  it('waits as a banner in the header while the member plays at a table, and opens from it', async () => {
    mocks.club.table = { id: 't1', mySeat: 'S' }
    mocks.club.notifications = bell(note('n1', 'challengeInvited', { challengeId: 'c1', username: 'ben' }))
    show('/table/t1')
    const banner = await within(screen.getByTestId('header')).findByRole('button', { name: 'ben 邀請你參加挑戰 · 查看' })
    expect(screen.queryByRole('alertdialog')).toBeNull()
    await waitFor(() => expect(invites()).toBe(1))

    await userEvent.click(banner)
    const dialog = screen.getByRole('alertdialog')
    await userEvent.click(within(dialog).getByRole('button', { name: '接受' }))
    expect(mocks.api.answerChallenge).toHaveBeenCalledWith('c1', true)
    // Leaving the page would leave the table
    expect(screen.getByText('牌桌頁')).toBeInTheDocument()
    expect(screen.getByText(/已接受邀請：這桌打完後/)).toBeInTheDocument()
    expect(within(screen.getByTestId('header')).queryByRole('button')).toBeNull()
  })

  it('pops up as usual when the member only watches a table', async () => {
    mocks.club.table = { id: 't1', mySeat: null }
    mocks.club.notifications = bell(note('n1', 'challengeInvited', { challengeId: 'c1', username: 'ben' }))
    show('/table/t1')
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument()
  })
})
