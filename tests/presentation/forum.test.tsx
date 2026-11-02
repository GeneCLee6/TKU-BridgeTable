import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FEATURE_DEFAULTS } from '../../shared/features.ts'
import { BUILTIN_BOARDS, type Board, type Comment, type Post } from '../../shared/forum.ts'
import type { LobbyView, Me } from '../../shared/protocol.ts'
import { ForumBoardPage, ForumHomePage, ForumPostPage } from '../../src/pages/ForumPages.tsx'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'

/** The table's forum pages (E13 K1, e13-t03): boards, a board's posts a page at a time, a post and its comments */

const mocks = vi.hoisted(() => ({
  forum: { boards: vi.fn(), boardPage: vi.fn(), feed: vi.fn(), post: vi.fn(), comment: vi.fn(), deleteComment: vi.fn() },
  auth: { user: { id: 'ben', username: 'ben', admin: false, permissions: [] } as Me },
}))
vi.mock('../../src/lib/forum.ts', () => ({ forumApi: mocks.forum }))
vi.mock('../../src/state/AuthContext.tsx', () => ({ useAuth: () => mocks.auth }))
const LOBBY: LobbyView = {
  online: [],
  members: [
    { id: 'amy', username: 'amy', displayName: '艾美', online: true, tableNumber: null, seat: null },
    { id: 'ben', username: 'ben', online: true, tableNumber: null, seat: null },
  ],
  tables: [],
  myTableId: null,
  friends: [],
  blocked: [],
}
vi.mock('../../src/state/ClubContext.tsx', () => ({ useClub: () => ({ lobby: LOBBY }) }))

const boards: Board[] = BUILTIN_BOARDS.map((b) => ({ ...b, pinnedPostIds: [] }))
const post = (id: string, over: Partial<Post> = {}): Post => ({
  id,
  boardId: 'deals',
  authorId: 'amy',
  title: `貼文 ${id}`,
  blocks: [{ kind: 'paragraph', text: '這副牌怎麼打？' }],
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

const renderAt = (path: string) =>
  render(
    <PreferencesProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/forum" element={<ForumHomePage />} />
          <Route path="/forum/p/:postId" element={<ForumPostPage />} />
          <Route path="/forum/:boardId" element={<ForumBoardPage />} />
        </Routes>
      </MemoryRouter>
    </PreferencesProvider>,
  )

beforeEach(() => {
  vi.clearAllMocks()
  mocks.auth = { user: { id: 'ben', username: 'ben', admin: false, permissions: [] } }
  mocks.forum.boards.mockResolvedValue(boards)
})

describe('forum pages', () => {
  it('is off by default (a feature flag)', () => {
    expect(FEATURE_DEFAULTS.forum).toBe('off')
  })

  it('lists the boards and the latest posts with their authors', async () => {
    mocks.forum.feed.mockResolvedValue({ posts: [post('p1', { commentCount: 2 })], page: 1, pages: 1 })
    renderAt('/forum')
    expect(await screen.findByRole('link', { name: /社團公告/ })).toHaveAttribute('href', '/forum/news')
    expect(screen.getByText('只有幹部能發文')).toBeInTheDocument()
    const row = await screen.findByRole('link', { name: /貼文 p1/ })
    expect(row).toHaveAttribute('href', '/forum/p/p1')
    expect(within(row).getByText(/牌局討論 · 艾美/)).toBeInTheDocument()
    expect(within(row).getByLabelText('2 則留言')).toBeInTheDocument()
    expect(mocks.forum.feed).toHaveBeenCalledWith(1)
  })

  it('shows a board with its pinned posts first and pages through it', async () => {
    mocks.forum.boardPage.mockImplementation(async (_id: string, page: number) => ({
      board: boards[1],
      pinned: page === 1 ? [post('pin', { pinned: true })] : [],
      posts: [post(`n${page}`)],
      page,
      pages: 2,
    }))
    renderAt('/forum/deals')
    expect(await screen.findByRole('heading', { name: '牌局討論' })).toBeInTheDocument()
    const links = (await screen.findAllByRole('link', { name: /貼文/ })).map((a) => a.getAttribute('href'))
    expect(links).toEqual(['/forum/p/pin', '/forum/p/n1'])
    expect(screen.getByText('第 1 / 2 頁')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '下一頁' }))
    expect(await screen.findByRole('link', { name: /貼文 n2/ })).toBeInTheDocument()
    expect(mocks.forum.boardPage).toHaveBeenLastCalledWith('deals', 2)
  })

  it('shows a post, its comments and replies, and sends a comment as a paragraph', async () => {
    mocks.forum.post.mockResolvedValue({
      post: post('p1', { blocks: [{ kind: 'paragraph', text: '首攻什麼？' }, { kind: 'hand', cards: ['SA', 'ST', 'H2'] }] }),
      comments: [comment('c1'), comment('c2', { parentId: 'c1', authorId: 'ben' })],
    })
    mocks.forum.comment.mockResolvedValue(comment('c3'))
    renderAt('/forum/p/p1')
    expect(await screen.findByRole('heading', { name: '貼文 p1' })).toBeInTheDocument()
    expect(screen.getByText('首攻什麼？')).toBeInTheDocument()
    expect(screen.getByText('A 10')).toBeInTheDocument()
    expect(screen.getByText('留言 c1')).toBeInTheDocument()
    // Only one's own comment has a delete button (the server checks again)
    expect(screen.getAllByRole('button', { name: '刪除留言' })).toHaveLength(1)

    await userEvent.type(screen.getByRole('textbox', { name: '寫留言' }), '  打黑桃  ')
    await userEvent.click(screen.getByRole('button', { name: '送出' }))
    await waitFor(() =>
      expect(mocks.forum.comment).toHaveBeenCalledWith('p1', { parentId: undefined, blocks: [{ kind: 'paragraph', text: '打黑桃' }] }),
    )

    // A reply to a reply hangs under the same top comment
    await userEvent.click(screen.getAllByRole('button', { name: '回覆' })[1])
    await userEvent.type(screen.getByRole('textbox', { name: '回覆 艾美' }), '同意')
    await userEvent.click(screen.getAllByRole('button', { name: '送出' })[0])
    await waitFor(() =>
      expect(mocks.forum.comment).toHaveBeenLastCalledWith('p1', { parentId: 'c1', blocks: [{ kind: 'paragraph', text: '同意' }] }),
    )
    expect(mocks.forum.post).toHaveBeenCalledTimes(3)
  })

  it('takes no comments on a locked post, except from an officer', async () => {
    mocks.forum.post.mockResolvedValue({ post: post('p1', { locked: true }), comments: [comment('c1')] })
    const { unmount } = renderAt('/forum/p/p1')
    expect(await screen.findByText('這篇貼文已鎖定，不能留言。')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '刪除留言' })).not.toBeInTheDocument()
    unmount()

    mocks.auth = { user: { id: 'ben', username: 'ben', admin: false, permissions: ['forumModerate'] } }
    renderAt('/forum/p/p1')
    expect(await screen.findByRole('textbox', { name: '寫留言' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '刪除留言' })).toBeInTheDocument()
  })

  it('shows the server’s error for a post that is gone', async () => {
    mocks.forum.post.mockRejectedValue(Object.assign(new Error('gone'), { code: 'postGone', params: {} }))
    renderAt('/forum/p/zz')
    expect(await screen.findByRole('alert')).toBeInTheDocument()
  })
})
