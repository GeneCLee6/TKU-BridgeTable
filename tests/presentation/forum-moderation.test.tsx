import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BUILTIN_BOARDS, type Board, type Comment, type Post, type ReportItem } from '../../shared/forum.ts'
import type { LobbyView, Me } from '../../shared/protocol.ts'
import { ForumReportsPage, ForumSearchPage } from '../../src/pages/ForumModerationPages.tsx'
import { ForumHomePage, ForumPostPage } from '../../src/pages/ForumPages.tsx'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'

/** The forum's reports, hiding and search on the table (E13 K4: e13-t10, e13-t11) */

const mocks = vi.hoisted(() => ({
  forum: {
    tags: vi.fn(async () => [] as { tag: string; count: number }[]),
    boards: vi.fn(),
    feed: vi.fn(),
    post: vi.fn(),
    search: vi.fn(),
    report: vi.fn(),
    reports: vi.fn(),
    decide: vi.fn(),
    hide: vi.fn(),
  },
  auth: { user: { id: 'ben', username: 'ben', admin: false, permissions: [] } as Me },
}))
vi.mock('../../src/lib/forum.ts', () => ({ forumApi: mocks.forum }))
vi.mock('../../src/state/AuthContext.tsx', () => ({ useAuth: () => mocks.auth }))
const LOBBY: LobbyView = {
  online: [],
  members: [
    { id: 'amy', username: 'amy', displayName: '艾美', online: true, tableNumber: null, seat: null },
    { id: 'ben', username: 'ben', online: true, tableNumber: null, seat: null },
    { id: 'cat', username: 'cat', online: true, tableNumber: null, seat: null },
  ],
  tables: [],
  myTableId: null,
  friends: [],
  blocked: [],
}
vi.mock('../../src/state/ClubContext.tsx', () => ({ useClub: () => ({ lobby: LOBBY }) }))

const officer: Me = { id: 'cat', username: 'cat', admin: false, permissions: ['forumModerate'] }
const boards: Board[] = BUILTIN_BOARDS.map((b) => ({ ...b, pinnedPostIds: [] }))
const post = (id: string, over: Partial<Post> = {}): Post => ({
  id,
  boardId: 'deals',
  authorId: 'amy',
  title: `貼文 ${id}`,
  blocks: [{ kind: 'paragraph', text: '首攻什麼？' }],
  createdAt: 0,
  reactions: {},
  commentCount: 0,
  ...over,
})
const comment = (id: string, over: Partial<Comment> = {}): Comment => ({
  id,
  postId: 'p1',
  authorId: 'amy',
  blocks: [{ kind: 'paragraph', text: `留言 ${id}` }],
  createdAt: 0,
  reactions: {},
  ...over,
})
const item = (id: string, over: Partial<ReportItem['report']> = {}, rest: Omit<ReportItem, 'report'> = {}): ReportItem => ({
  report: { id, target: 'post', targetId: 'p1', reporterId: 'ben', reason: '廣告', createdAt: 0, status: 'open', ...over },
  postId: 'p1',
  authorId: 'amy',
  excerpt: '貼文 p1',
  ...rest,
})

const renderAt = (path: string) =>
  render(
    <PreferencesProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/forum" element={<ForumHomePage />} />
          <Route path="/forum/search" element={<ForumSearchPage />} />
          <Route path="/forum/reports" element={<ForumReportsPage />} />
          <Route path="/forum/p/:postId" element={<ForumPostPage />} />
        </Routes>
      </MemoryRouter>
    </PreferencesProvider>,
  )

beforeEach(() => {
  vi.clearAllMocks()
  mocks.auth = { user: { id: 'ben', username: 'ben', admin: false, permissions: [] } }
  mocks.forum.boards.mockResolvedValue(boards)
  mocks.forum.feed.mockResolvedValue({ posts: [], page: 1, pages: 1 })
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})

describe('forum search (e13-t11)', () => {
  it('links to search from the forum, and to the reports only for officers', async () => {
    renderAt('/forum')
    expect(await screen.findByRole('link', { name: '搜尋' })).toHaveAttribute('href', '/forum/search')
    expect(screen.queryByRole('link', { name: '檢舉處理' })).not.toBeInTheDocument()
  })

  it('searches one board and lists what it found', async () => {
    mocks.forum.search.mockResolvedValue({ posts: [post('p1')], page: 1, pages: 1, query: '首攻', total: 1 })
    renderAt('/forum/search')
    await userEvent.type(screen.getByRole('searchbox', { name: '搜尋標題與內容' }), '首攻')
    await screen.findByRole('option', { name: '牌局討論' })
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '板面' }), 'deals')
    await userEvent.click(screen.getByRole('button', { name: '搜尋' }))
    expect(await screen.findByText('「首攻」找到 1 篇貼文')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /貼文 p1/ })).toHaveAttribute('href', '/forum/p/p1')
    expect(mocks.forum.search).toHaveBeenCalledWith('首攻', 1, 'deals', undefined)
  })

  it('reads the search from the address and says when nothing matches', async () => {
    mocks.forum.search.mockResolvedValue({ posts: [], page: 1, pages: 1, query: 'xyz', total: 0 })
    renderAt('/forum/search?q=xyz')
    expect(await screen.findByText('沒有符合的貼文')).toBeInTheDocument()
    expect(mocks.forum.search).toHaveBeenCalledWith('xyz', 1, undefined, undefined)
  })

  it('lists every post with a tag, with no words to search for (AC-13.7)', async () => {
    mocks.forum.tags.mockResolvedValue([{ tag: '首攻', count: 2 }])
    mocks.forum.search.mockResolvedValue({ posts: [post('p1'), post('p2')], page: 1, pages: 1, query: '', total: 2 })
    renderAt('/forum/search')
    expect(screen.getByRole('button', { name: '搜尋' })).toBeDisabled()
    await screen.findByRole('option', { name: '#首攻' })
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '標籤' }), '首攻')
    await userEvent.click(screen.getByRole('button', { name: '搜尋' }))
    expect(await screen.findByText('標籤「首攻」有 2 篇貼文')).toBeInTheDocument()
    expect(mocks.forum.search).toHaveBeenCalledWith('', 1, undefined, '首攻')
  })
})

describe('forum reports and hiding (e13-t10)', () => {
  it('lets a member report someone else’s post or comment, not their own', async () => {
    mocks.forum.post.mockResolvedValue({ post: post('p1'), comments: [comment('c1'), comment('c2', { authorId: 'ben' })] })
    mocks.forum.report.mockResolvedValue(item('r1').report)
    renderAt('/forum/p/p1')
    await screen.findByRole('heading', { name: '貼文 p1' })
    // The post and amy's comment; not ben's own comment
    expect(screen.getAllByRole('button', { name: '檢舉' })).toHaveLength(2)
    expect(screen.queryByRole('button', { name: '隱藏' })).not.toBeInTheDocument()
    await userEvent.click(screen.getAllByRole('button', { name: '檢舉' })[1])
    await userEvent.type(screen.getByRole('textbox', { name: '檢舉的原因' }), '人身攻擊')
    await userEvent.click(screen.getByRole('button', { name: '送出檢舉' }))
    expect(mocks.forum.report).toHaveBeenCalledWith({ target: 'comment', targetId: 'c1', reason: '人身攻擊' })
    expect(await screen.findByText('已送出檢舉，幹部會處理。')).toBeInTheDocument()
  })

  it('lets an officer hide a post and shows it as hidden', async () => {
    mocks.auth = { user: officer }
    mocks.forum.post.mockResolvedValueOnce({ post: post('p1'), comments: [] })
    mocks.forum.post.mockResolvedValueOnce({ post: post('p1', { hidden: true }), comments: [] })
    mocks.forum.hide.mockResolvedValue(post('p1', { hidden: true }))
    renderAt('/forum/p/p1')
    await userEvent.click(await screen.findByRole('button', { name: '隱藏' }))
    expect(mocks.forum.hide).toHaveBeenCalledWith('p1', true)
    expect(await screen.findByText('這篇貼文已被幹部隱藏，只有作者與幹部看得到。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '取消隱藏' })).toBeInTheDocument()
  })

  it('lists the reports for officers, who dismiss, hide or delete', async () => {
    mocks.auth = { user: officer }
    mocks.forum.reports.mockResolvedValue([
      item('r1'),
      item('r2', { target: 'comment', targetId: 'c9', reason: '洗版' }, { postId: 'p1', authorId: 'amy', excerpt: '留言 c9' }),
      item('r3', { status: 'dismissed', handledBy: 'cat', handledAt: 0 }),
    ])
    mocks.forum.decide.mockResolvedValue(item('r1').report)
    mocks.forum.hide.mockResolvedValue(post('p1', { hidden: true }))
    renderAt('/forum/reports')
    const cards = await screen.findAllByRole('listitem')
    expect(cards).toHaveLength(3)
    expect(within(cards[0]).getByText('廣告')).toBeInTheDocument()
    expect(within(cards[0]).getByText(/ben 檢舉/)).toBeInTheDocument()
    expect(within(cards[1]).getByRole('link', { name: '看貼文' })).toHaveAttribute('href', '/forum/p/p1#comment-c9')
    // A comment cannot be hidden; a handled report has no buttons
    expect(within(cards[1]).queryByRole('button', { name: '隱藏' })).not.toBeInTheDocument()
    expect(within(cards[2]).queryByRole('button')).not.toBeInTheDocument()
    expect(within(cards[2]).getByText(/cat 處理/)).toBeInTheDocument()

    await userEvent.click(within(cards[0]).getByRole('button', { name: '隱藏' }))
    expect(mocks.forum.hide).toHaveBeenCalledWith('p1', true)
    await userEvent.click(within(cards[1]).getByRole('button', { name: '刪除內容' }))
    expect(mocks.forum.decide).toHaveBeenCalledWith('r2', 'remove')
    await userEvent.click(within(cards[0]).getByRole('button', { name: '不處理' }))
    expect(mocks.forum.decide).toHaveBeenCalledWith('r1', 'dismiss')

    await userEvent.click(screen.getByRole('button', { name: '全部' }))
    expect(mocks.forum.reports).toHaveBeenLastCalledWith('all')
  })

  it('sends a member who is not an officer back to the forum', async () => {
    renderAt('/forum/reports')
    expect(await screen.findByRole('heading', { name: '論壇' })).toBeInTheDocument()
    expect(mocks.forum.reports).not.toHaveBeenCalled()
  })
})
