import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fullDeck, type Hands } from '../../shared/cards.ts'
import { BUILTIN_BOARDS, type Board, type Post } from '../../shared/forum.ts'
import { legalCards, makeCall, newBoard, playCard, turnOf, type BoardState } from '../../shared/game.ts'
import type { MemberProfile } from '../../shared/profile.ts'
import type { BoardRecord, LobbyView, Me } from '../../shared/protocol.ts'
import { BoardRecordView } from '../../src/components/BoardRecordView.tsx'
import { ForumBlocks } from '../../src/components/ForumBlocks.tsx'
import { ForumNewPostPage } from '../../src/pages/ForumEditorPage.tsx'
import { ProfilePage } from '../../src/pages/ProfilePage.tsx'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'

/** E13 K3: sharing a board from the history (e13-t07) and the profile page's forum posts and privacy (e13-t08) */

const mocks = vi.hoisted(() => ({
  api: { record: vi.fn(), member: vi.fn() },
  forum: { boards: vi.fn(), createPost: vi.fn(), feed: vi.fn() },
  user: { id: 'ben', username: 'ben', admin: false, permissions: [], features: ['forum'] } as Me,
}))
vi.mock('../../src/lib/api.ts', async (original) => ({
  ...(await original<typeof import('../../src/lib/api.ts')>()),
  api: mocks.api,
}))
vi.mock('../../src/lib/forum.ts', () => ({ forumApi: mocks.forum }))
vi.mock('../../src/state/AuthContext.tsx', () => ({
  useAuth: () => ({ user: mocks.user }),
  useFeature: (flag: string) => !!mocks.user.features?.includes(flag as never),
}))
const LOBBY: LobbyView = {
  online: [],
  members: [{ id: 'amy', username: 'amy', displayName: '艾美', online: true, tableNumber: null, seat: null }],
  tables: [],
  myTableId: null,
  friends: [],
  blocked: [],
}
vi.mock('../../src/state/ClubContext.tsx', () => ({ useClub: () => ({ lobby: LOBBY, send: vi.fn() }), useLobby: () => LOBBY }))
vi.mock('../../src/components/DoubleDummyPanel.tsx', () => ({ DoubleDummyPanel: () => null }))
vi.mock('../../src/components/FeaturedPanel.tsx', () => ({ FeaturedPanel: () => null }))
vi.mock('../../src/components/RatingTrend.tsx', () => ({ RatingTrend: () => null }))

const hands: Hands = {
  N: fullDeck().filter((c) => c[0] === 'S'),
  E: fullDeck().filter((c) => c[0] === 'H'),
  S: fullDeck().filter((c) => c[0] === 'D'),
  W: fullDeck().filter((c) => c[0] === 'C'),
}

function record(id: string, extra: Partial<BoardRecord> = {}): BoardRecord {
  let board: BoardState = newBoard(1, hands)
  for (const call of ['7D', 'P', 'P', 'P']) board = makeCall(board, turnOf(board)!, call)
  for (let i = 0; i < 52; i++) {
    const seat = turnOf(board)!
    board = playCard(board, seat, legalCards(board, seat)[0])
  }
  const robot = (seat: string) => ({ id: `robot:gib:${seat}`, username: 'TKB', robot: true })
  return { id, tableNumber: 3, finishedAt: 0, players: { N: robot('N'), E: robot('E'), S: { id: 'amy', username: 'amy' }, W: robot('W') }, board, ...extra }
}

const boards: Board[] = BUILTIN_BOARDS.map((b) => ({ ...b, pinnedPostIds: [] }))
const post = (id: string): Post => ({
  id,
  boardId: 'deals',
  authorId: 'amy',
  title: `貼文 ${id}`,
  blocks: [{ kind: 'paragraph', text: '這副牌怎麼打？' }],
  createdAt: 0,
  reactions: {},
  commentCount: 0,
})

const renderAt = (path: string, ui: React.ReactNode, route = path) =>
  render(
    <PreferencesProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={route} element={ui} />
          <Route path="/forum/p/:postId" element={<p>貼文頁</p>} />
        </Routes>
      </MemoryRouter>
    </PreferencesProvider>,
  )

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.removeItem('tku-bridgetable:forumDraft')
  mocks.user = { id: 'ben', username: 'ben', admin: false, permissions: [], features: ['forum'] }
  mocks.forum.boards.mockResolvedValue(boards)
})

describe('a board shared on the forum (e13-t07)', () => {
  it('draws the board from the record page’s API, with a link to replay it', async () => {
    mocks.api.record.mockResolvedValue({ record: record('b1') })
    renderAt('/x', <ForumBlocks blocks={[{ kind: 'record', tableRecordId: 'b1' }]} />)
    const replay = await screen.findByRole('link', { name: '重播這副牌' }, { timeout: 5000 })
    expect(replay).toHaveAttribute('href', '/history/b1')
    expect(mocks.api.record).toHaveBeenCalledWith('b1')
    // The players' names come from the record
    expect(screen.getAllByText(/amy/).length).toBeGreaterThan(0)
  })

  it('is only a link when the viewer may not see the board', async () => {
    mocks.api.record.mockRejectedValue(new Error('boardGone'))
    renderAt('/x', <ForumBlocks blocks={[{ kind: 'record', tableRecordId: 'held' }]} />)
    await waitFor(() => expect(mocks.api.record).toHaveBeenCalled())
    expect(await screen.findByRole('link', { name: '看這副牌的紀錄' })).toHaveAttribute('href', '/history/held')
    expect(screen.queryByRole('link', { name: '重播這副牌' })).toBeNull()
  })

  it('offers 分享到論壇 on a record page, but not for a board kept back', () => {
    const { unmount } = renderAt('/history/b1', <BoardRecordView record={record('b1')} />)
    expect(screen.getByRole('link', { name: '分享到論壇' })).toHaveAttribute('href', '/forum/new?record=b1')
    unmount()
    renderAt('/history/b2', <BoardRecordView record={record('b2', { revealAt: Date.now() + 60_000 })} />)
    expect(screen.getByRole('button', { name: '分享到論壇' })).toBeDisabled()
    expect(screen.queryByRole('link', { name: '分享到論壇' })).toBeNull()
  })

  it('offers nothing without the forum flag', () => {
    mocks.user = { ...mocks.user, features: [] }
    renderAt('/history/b1', <BoardRecordView record={record('b1')} />)
    expect(screen.queryByRole('link', { name: '分享到論壇' })).toBeNull()
    expect(screen.queryByRole('button', { name: '分享到論壇' })).toBeNull()
  })

  it('starts a post on 牌局討論 with the board in it', async () => {
    const user = userEvent.setup()
    mocks.api.record.mockResolvedValue({ record: record('b1') })
    mocks.forum.createPost.mockResolvedValue(post('p9'))
    renderAt('/forum/new?record=b1', <ForumNewPostPage />, '/forum/new')
    await screen.findByRole('link', { name: '重播這副牌' }, { timeout: 5000 })
    expect(screen.getByRole('combobox', { name: '發布到' })).toHaveValue('deals')
    await user.click(screen.getByRole('button', { name: '發布' }))
    await waitFor(() => expect(mocks.forum.createPost).toHaveBeenCalled())
    const [boardId, input] = mocks.forum.createPost.mock.calls[0]
    expect(boardId).toBe('deals')
    expect(input.blocks).toContainEqual({ kind: 'record', tableRecordId: 'b1' })
    expect(await screen.findByText('貼文頁')).toBeInTheDocument()
  })
})

describe('the profile page (e13-t08)', () => {
  const amy: MemberProfile = { id: 'amy', username: 'amy', profile: { bio: '喜歡防守' }, recent: [] }

  it('lists the member’s forum posts', async () => {
    mocks.api.member.mockResolvedValue({ member: amy, hidden: { boards: false, posts: false } })
    mocks.forum.feed.mockResolvedValue({ posts: [post('p1')], page: 1, pages: 1 })
    renderAt('/members/amy', <ProfilePage />, '/members/:userId')
    const posts = await screen.findByRole('region', { name: '論壇貼文' }, { timeout: 5000 })
    expect(await within(posts).findByRole('link', { name: /貼文 p1/ })).toHaveAttribute('href', '/forum/p/p1')
    expect(mocks.forum.feed).toHaveBeenCalledWith(1, 'amy')
    expect(screen.getByText('還沒有你看得到的牌局紀錄。')).toBeInTheDocument()
  })

  it('says what the member keeps private', async () => {
    mocks.api.member.mockResolvedValue({ member: amy, hidden: { boards: true, posts: true } })
    renderAt('/members/amy', <ProfilePage />, '/members/:userId')
    expect(await screen.findByText('這位社員不公開論壇貼文。')).toBeInTheDocument()
    expect(screen.getByText('這位社員不公開打過的牌局。')).toBeInTheDocument()
    expect(mocks.forum.feed).not.toHaveBeenCalled()
  })

  it('has no forum section without the forum flag', async () => {
    mocks.user = { ...mocks.user, features: [] }
    mocks.api.member.mockResolvedValue({ member: amy })
    renderAt('/members/amy', <ProfilePage />, '/members/:userId')
    expect(await screen.findByText('喜歡防守')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '論壇貼文' })).toBeNull()
  })
})
