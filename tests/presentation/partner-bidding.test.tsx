import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { deal } from '../../shared/board.ts'
import type { PartnerBidBoardView, PartnerBidSummary, PartnerBidView } from '../../shared/partner-bidding.ts'
import { LANGS } from '../../shared/messages.ts'
import type { DoubleDummyState } from '../../src/lib/useDoubleDummy.ts'
import { PartnerBiddingListPage, PartnerBiddingPage, PartnerBidReviewPage } from '../../src/pages/PartnerBiddingPages.tsx'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'
import { STRINGS } from '../../src/strings.ts'

/** The partner bidding practice's pages (`e10-t08`): they show what the server sends and ask it for the rest */

const mocks = vi.hoisted(() => ({
  api: {
    partnerBids: vi.fn(),
    partnerBid: vi.fn(),
    createPartnerBid: vi.fn(),
    answerPartnerBid: vi.fn(),
    callPartnerBid: vi.fn(),
    abandonPartnerBid: vi.fn(),
    practiceSets: vi.fn(),
  },
  live: null as { id: string; session: unknown } | null,
  dd: { status: 'loading' } as DoubleDummyState,
}))

vi.mock('../../src/lib/useDoubleDummy.ts', () => ({ useDoubleDummy: () => mocks.dd }))
vi.mock('../../src/lib/api.ts', async (original) => ({
  ...(await original<typeof import('../../src/lib/api.ts')>()),
  api: mocks.api,
}))
vi.mock('../../src/state/ClubContext.tsx', () => ({
  useClub: () => ({
    lobby: { blocked: ['bad'], members: [{ id: 'amy', username: 'amy' }, { id: 'ben', username: 'ben' }, { id: 'bad', username: 'bad' }] },
    partnerBidLive: mocks.live,
  }),
}))
vi.mock('../../src/state/AuthContext.tsx', () => ({
  useAuth: () => ({ user: { id: 'amy', username: 'amy', admin: false, permissions: [] } }),
}))

const hands = deal(() => 0)

/** The bidding box's Pass key; the auction's passes are buttons too */
const passKey = () => document.querySelector('button[aria-keyshortcuts="P"]')

const summary = (over: Partial<PartnerBidSummary> = {}): PartnerBidSummary => ({
  id: 's1',
  status: 'active',
  inviter: { id: 'amy', username: 'amy' },
  partner: { id: 'ben', username: 'ben' },
  seat: 'S',
  settings: { deal: 'random', boards: 2, robotKind: 'gib' },
  boards: 2,
  done: 0,
  yourTurn: true,
  turnId: 'amy',
  createdAt: 1,
  updatedAt: 1,
  expiresAt: 2,
  ...over,
})

const bidding = (over: Partial<PartnerBidBoardView> = {}): PartnerBidBoardView => ({
  seq: 0,
  boardNo: 1,
  dealer: 'N',
  vul: 'None',
  over: false,
  hands: { S: hands.S },
  auction: [
    { seat: 'N', call: '1C' },
    { seat: 'E', call: 'P' },
  ],
  contract: null,
  turn: 'S',
  legalCalls: ['P', '1D', '1H'],
  ...over,
})

const finished = (over: Partial<PartnerBidBoardView> = {}): PartnerBidBoardView =>
  bidding({
    over: true,
    hands,
    turn: null,
    legalCalls: [],
    contract: { level: 1, strain: 'N', doubled: '', declarer: 'N' },
    auction: [
      { seat: 'N', call: '1N' },
      { seat: 'E', call: 'P' },
      { seat: 'S', call: 'P' },
      { seat: 'W', call: 'P' },
    ],
    ...over,
  })

const session = (over: Partial<PartnerBidView> = {}): PartnerBidView => ({ ...summary(), sessionBoards: [bidding()], ...over })

function wrap(path: string) {
  return render(
    <PreferencesProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/partner-bidding" element={<PartnerBiddingListPage />} />
          <Route path="/partner-bidding/:sessionId" element={<PartnerBiddingPage />} />
          <Route path="/partner-bidding/:sessionId/boards/:seq" element={<PartnerBidReviewPage />} />
        </Routes>
      </MemoryRouter>
    </PreferencesProvider>,
  )
}

beforeEach(() => {
  for (const fn of Object.values(mocks.api)) fn.mockReset()
  mocks.api.practiceSets.mockResolvedValue({ sets: [{ id: 'bidding', count: 5, categories: [] }] })
  mocks.api.partnerBids.mockResolvedValue({ sessions: [] })
  mocks.live = null
  mocks.dd = { status: 'loading' }
})

describe('the list and the invitation (e10-t08)', () => {
  it('invites a member, not oneself nor one the member blocked', async () => {
    const user = userEvent.setup()
    mocks.api.createPartnerBid.mockResolvedValue({ session: session() })
    wrap('/partner-bidding')
    const partner = await screen.findByLabelText('搭檔')
    const names = within(partner).getAllByRole('option').map((o) => o.textContent)
    expect(names).toContain('ben')
    expect(names).not.toContain('amy')
    expect(names).not.toContain('bad')
    await user.selectOptions(partner, 'ben')
    await user.selectOptions(screen.getByLabelText('副數'), '3')
    await user.click(screen.getByRole('button', { name: '送出邀請' }))
    expect(mocks.api.createPartnerBid).toHaveBeenCalledWith('ben', { deal: 'random', boards: 3, robotKind: 'gib' })
  })

  it('lists the sessions and whose turn it is', async () => {
    mocks.api.partnerBids.mockResolvedValue({
      sessions: [summary(), summary({ id: 's2', yourTurn: false, turnId: 'ben', done: 1 }), summary({ id: 's3', status: 'finished', yourTurn: false, turnId: null, done: 2 })],
    })
    wrap('/partner-bidding')
    expect(await screen.findByText('輪到你')).toBeInTheDocument()
    expect(screen.getByText(/輪到 ben/)).toBeInTheDocument()
    expect(screen.getByText(/已叫完/)).toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: '和 ben' })[1]).toHaveAttribute('href', '/partner-bidding/s2')
  })
})

describe('a session', () => {
  it("on the member's turn: their hand, the auction, and a bidding box with only what the server allows", async () => {
    const user = userEvent.setup()
    mocks.api.partnerBid.mockResolvedValue({ session: session() })
    mocks.api.callPartnerBid.mockResolvedValue({ session: session({ yourTurn: false, sessionBoards: [bidding({ turn: 'N', legalCalls: [] })] }) })
    wrap('/partner-bidding/s1')
    await screen.findByRole('heading', { name: /第 1 副，共 2 副/ })
    expect(screen.getByLabelText('你的牌')).toBeInTheDocument()
    await user.click(passKey()!)
    expect(mocks.api.callPartnerBid).toHaveBeenCalledWith('s1', 'P')
    expect(await screen.findByRole('status')).toHaveTextContent('輪到 ben')
    expect(passKey()).toBeNull()
  })

  it("not their turn: no bidding box, and a push from the partner's call brings it back", async () => {
    mocks.api.partnerBid.mockResolvedValue({ session: session({ yourTurn: false, sessionBoards: [bidding({ turn: 'N', legalCalls: [] })] }) })
    const view = wrap('/partner-bidding/s1')
    expect(await screen.findByRole('status')).toHaveTextContent('輪到 ben')
    expect(passKey()).toBeNull()
    mocks.live = { id: 's1', session: session() }
    view.rerender(
      <PreferencesProvider>
        <MemoryRouter initialEntries={['/partner-bidding/s1']}>
          <Routes>
            <Route path="/partner-bidding/:sessionId" element={<PartnerBiddingPage />} />
          </Routes>
        </MemoryRouter>
      </PreferencesProvider>,
    )
    await waitFor(() => expect(passKey()).not.toBeNull())
  })

  it('the invited partner answers', async () => {
    const user = userEvent.setup()
    const invited = session({ status: 'invited', seat: 'N', yourTurn: false, turnId: null, sessionBoards: [] })
    mocks.api.partnerBid.mockResolvedValue({ session: invited })
    mocks.api.answerPartnerBid.mockResolvedValue({ session: session({ seat: 'N' }) })
    wrap('/partner-bidding/s1')
    await user.click(await screen.findByRole('button', { name: '接受' }))
    expect(mocks.api.answerPartnerBid).toHaveBeenCalledWith('s1', true)
  })

  it('the inviter can take the invitation back', async () => {
    const user = userEvent.setup()
    mocks.api.partnerBid.mockResolvedValue({ session: session({ status: 'invited', yourTurn: false, turnId: null, sessionBoards: [] }) })
    mocks.api.abandonPartnerBid.mockResolvedValue({ session: session({ status: 'abandoned', yourTurn: false, sessionBoards: [] }) })
    wrap('/partner-bidding/s1')
    await user.click(await screen.findByRole('button', { name: '收回邀請' }))
    expect(mocks.api.abandonPartnerBid).toHaveBeenCalledWith('s1')
  })

  it('abandons after asking', async () => {
    const user = userEvent.setup()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    mocks.api.partnerBid.mockResolvedValue({ session: session() })
    mocks.api.abandonPartnerBid.mockResolvedValue({ session: session({ status: 'abandoned', yourTurn: false }) })
    wrap('/partner-bidding/s1')
    await user.click(await screen.findByRole('button', { name: '放棄這次練習' }))
    expect(confirm).toHaveBeenCalled()
    expect(mocks.api.abandonPartnerBid).toHaveBeenCalledWith('s1')
    await waitFor(() => expect(screen.queryByRole('button', { name: '放棄這次練習' })).not.toBeInTheDocument())
    confirm.mockRestore()
  })

  it('says so when the session does not exist', async () => {
    const { ApiError } = await vi.importActual<typeof import('../../src/lib/api.ts')>('../../src/lib/api.ts')
    mocks.api.partnerBid.mockRejectedValue(new ApiError('gone', 404, 'partnerBidGone', {}))
    wrap('/partner-bidding/nope')
    expect(await screen.findByRole('alert')).toHaveTextContent('找不到這次搭檔叫牌練習')
  })

  it('links each finished board to its review', async () => {
    mocks.api.partnerBid.mockResolvedValue({ session: session({ done: 1, sessionBoards: [finished(), bidding({ seq: 1 })] }) })
    wrap('/partner-bidding/s1')
    expect(await screen.findByRole('link', { name: '檢討' })).toHaveAttribute('href', '/partner-bidding/s1/boards/0')
  })
})

describe('the review page', () => {
  it('shows the four hands, the auction against TKB and how TKB bids it', async () => {
    const review = {
      steps: [{ call: '1N' }, { call: 'P' }, { call: '3N' }, { call: 'P' }],
      robot: { auction: [{ seat: 'N' as const, call: '1N' }], contract: { level: 3, strain: 'N' as const, doubled: '' as const, declarer: 'N' as const } },
    }
    mocks.api.partnerBid.mockResolvedValue({ session: session({ status: 'finished', done: 2, sessionBoards: [finished({ review, note: '牌組的重點' })] }) })
    wrap('/partner-bidding/s1/boards/0')
    expect(await screen.findByRole('heading', { name: '第 1 副的檢討' })).toBeInTheDocument()
    expect(screen.getByLabelText('南')).toBeInTheDocument()
    expect(screen.getByLabelText('北')).toBeInTheDocument()
    expect(screen.getByLabelText('東')).toBeInTheDocument()
    expect(screen.getByText(/amy/)).toBeInTheDocument()
    expect(screen.getByText('不同')).toBeInTheDocument()
    expect(screen.getByText('牌組的重點')).toBeInTheDocument()
    // Not four TKB here: East and West stay silent
    expect(screen.getByText('南北都換成 TKB，東西一樣不叫，從頭叫同一副')).toBeInTheDocument()
  })

  it('never shows a review of a board still being bid', async () => {
    mocks.api.partnerBid.mockResolvedValue({ session: session() })
    wrap('/partner-bidding/s1/boards/0')
    expect(await screen.findByText('找不到這次搭檔叫牌練習')).toBeInTheDocument()
    expect(screen.queryByLabelText('北')).not.toBeInTheDocument()
  })
})

describe('the texts', () => {
  it('are there in every language', () => {
    for (const lang of LANGS) {
      const p = STRINGS[lang].partnerBid
      expect(p.title, lang).toBeTruthy()
      expect(p.status.expired, lang).toBeTruthy()
      expect(p.board(1, 2), lang).toContain('1')
      expect(STRINGS[lang].push.groups.practice, lang).toBeTruthy()
    }
  })
})
