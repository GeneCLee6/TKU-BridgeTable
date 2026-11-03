import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { fireEvent } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BUILTIN_BOARDS, type Board, type Post } from '../../shared/forum.ts'
import type { LobbyView, Me } from '../../shared/protocol.ts'
import { LobbyNews } from '../../src/components/LobbyNews.tsx'
import { fromLocalInput, initialRelease, localInput } from '../../src/lib/forumRelease.ts'
import { ForumEditPostPage, ForumNewPostPage } from '../../src/pages/ForumEditorPage.tsx'
import { ForumDraftsPage, ForumPostPage } from '../../src/pages/ForumPages.tsx'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'

/** Drafts, scheduled posts and the home page's announcements (E13 e13-t12, AC-13.4) */

const member: Me = { id: 'ben', username: 'ben', admin: false, permissions: [] }
const officer: Me = { id: 'cat', username: 'cat', admin: false, permissions: ['forumModerate'] }

const mocks = vi.hoisted(() => ({
  forum: {
    tags: vi.fn(async () => [] as { tag: string; count: number }[]),
    boards: vi.fn(),
    post: vi.fn(),
    createPost: vi.fn(),
    updatePost: vi.fn(),
    deletePost: vi.fn(),
    drafts: vi.fn(),
    latest: vi.fn(),
  },
  auth: { user: null as Me | null },
  forumOn: true,
}))
vi.mock('../../src/lib/forum.ts', () => ({ forumApi: mocks.forum }))
vi.mock('../../src/state/AuthContext.tsx', () => ({ useAuth: () => mocks.auth, useFeature: () => mocks.forumOn }))
const LOBBY: LobbyView = {
  online: [],
  members: [
    { id: 'ben', username: 'ben', online: false, tableNumber: null, seat: null },
    { id: 'cat', username: 'cat', displayName: '小貓', online: false, tableNumber: null, seat: null },
  ],
  tables: [],
  myTableId: null,
  friends: [],
  blocked: [],
} as unknown as LobbyView
vi.mock('../../src/state/ClubContext.tsx', () => ({ useClub: () => ({ lobby: LOBBY }) }))

const boards: Board[] = BUILTIN_BOARDS.map((b) => ({ ...b, pinnedPostIds: [] }))
const post = (over: Partial<Post> = {}): Post => ({
  id: 'p1',
  boardId: 'news',
  authorId: 'cat',
  title: '週五社課',
  blocks: [{ kind: 'paragraph', text: '七點在 E787' }],
  createdAt: Date.UTC(2026, 10, 3, 4),
  reactions: {},
  commentCount: 0,
  ...over,
})

const wrap = (ui: React.ReactNode) => render(<PreferencesProvider>{ui}</PreferencesProvider>)
const renderAt = (path: string) =>
  wrap(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/forum/new" element={<ForumNewPostPage />} />
        <Route path="/forum/drafts" element={<ForumDraftsPage />} />
        <Route path="/forum/p/:postId" element={<ForumPostPage />} />
        <Route path="/forum/p/:postId/edit" element={<ForumEditPostPage />} />
        <Route path="/forum/:boardId" element={<p>board page</p>} />
      </Routes>
    </MemoryRouter>,
  )

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.removeItem('tku-bridgetable:forumDraft')
  mocks.auth = { user: member }
  mocks.forumOn = true
  mocks.forum.boards.mockResolvedValue(boards)
})

describe('the editor’s drafts and scheduling (e13-t12)', () => {
  it('saves a member’s post as a draft on the server, and offers no scheduling', async () => {
    mocks.forum.createPost.mockResolvedValue(post({ id: 'd1', boardId: 'chat', authorId: 'ben', draft: true }))
    mocks.forum.post.mockResolvedValue({ post: post({ id: 'd1', boardId: 'chat', authorId: 'ben', draft: true }), comments: [] })
    renderAt('/forum/new?board=chat')
    await screen.findByLabelText('發布到')
    expect(screen.queryByRole('checkbox', { name: '排程發布' })).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox', { name: '文字' }), { target: { value: '還沒寫完' } })
    await userEvent.click(screen.getByRole('button', { name: '存成草稿' }))
    await waitFor(() =>
      expect(mocks.forum.createPost).toHaveBeenCalledWith('chat', {
        title: undefined,
        blocks: [{ kind: 'paragraph', text: '還沒寫完' }],
        tags: [],
        draft: true,
      }),
    )
    // The device's copy goes once the server has it; the post page says it is a draft
    expect(window.localStorage.getItem('tku-bridgetable:forumDraft')).toBeNull()
    expect(await screen.findByText('這是草稿，只有你看得到；發布之後大家才看得到。')).toBeInTheDocument()
  })

  it('lets an officer schedule a post for a time', async () => {
    mocks.auth = { user: officer }
    mocks.forum.createPost.mockResolvedValue(post({ publishAt: Date.UTC(2026, 10, 7, 11) }))
    mocks.forum.post.mockResolvedValue({ post: post({ publishAt: Date.UTC(2026, 10, 7, 11) }), comments: [] })
    renderAt('/forum/new?board=news')
    expect(await screen.findByLabelText('發布到')).toHaveValue('news')
    fireEvent.change(screen.getByRole('textbox', { name: '文字' }), { target: { value: '社課改時間' } })
    await userEvent.click(screen.getByRole('checkbox', { name: '排程發布' }))
    fireEvent.change(screen.getByLabelText('發布時間'), { target: { value: '2026-11-07T19:00' } })
    await userEvent.click(screen.getByRole('button', { name: '排程' }))
    await waitFor(() =>
      expect(mocks.forum.createPost).toHaveBeenCalledWith('news', {
        title: undefined,
        blocks: [{ kind: 'paragraph', text: '社課改時間' }],
        tags: [],
        publishAt: new Date('2026-11-07T19:00').getTime(),
      }),
    )
    expect(await screen.findByText('排程中')).toBeInTheDocument()
  })

  it('puts a draft out now when its author publishes it, and a post that is out saves only', async () => {
    mocks.auth = { user: officer }
    const draft = post({ draft: true })
    mocks.forum.post.mockResolvedValue({ post: draft, comments: [] })
    mocks.forum.updatePost.mockResolvedValue(post())
    renderAt('/forum/p/p1/edit')
    await userEvent.click(await screen.findByRole('button', { name: '立即發布' }))
    await waitFor(() => expect(mocks.forum.updatePost).toHaveBeenCalledWith('p1', expect.objectContaining({ draft: false })))
  })

  it('shows a scheduled post’s time when editing it', async () => {
    mocks.auth = { user: officer }
    const at = new Date('2026-11-07T19:00').getTime()
    mocks.forum.post.mockResolvedValue({ post: post({ publishAt: at }), comments: [] })
    mocks.forum.updatePost.mockResolvedValue(post({ draft: true }))
    renderAt('/forum/p/p1/edit')
    expect(await screen.findByRole('checkbox', { name: '排程發布' })).toBeChecked()
    expect(screen.getByLabelText('發布時間')).toHaveValue('2026-11-07T19:00')
    await userEvent.click(screen.getByRole('button', { name: '存成草稿' }))
    await waitFor(() => expect(mocks.forum.updatePost).toHaveBeenCalledWith('p1', expect.objectContaining({ draft: true })))
  })

  it('offers no draft or scheduling for a post that is out', async () => {
    mocks.auth = { user: officer }
    mocks.forum.post.mockResolvedValue({ post: post(), comments: [] })
    renderAt('/forum/p/p1/edit')
    expect(await screen.findByRole('button', { name: '儲存' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '存成草稿' })).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: '排程發布' })).not.toBeInTheDocument()
  })

  it('converts the browser’s local time and back, and starts an hour or two ahead', () => {
    const at = new Date(2026, 10, 7, 19, 30).getTime()
    expect(localInput(at)).toBe('2026-11-07T19:30')
    expect(fromLocalInput('2026-11-07T19:30')).toBe(at)
    expect(fromLocalInput('')).toBeUndefined()
    expect(initialRelease(post({ publishAt: at }))).toEqual({ schedule: true, at: '2026-11-07T19:30' })
    expect(initialRelease(undefined, new Date(2026, 10, 7, 19, 30).getTime())).toEqual({ schedule: false, at: '2026-11-07T21:00' })
  })
})

describe('a post not out yet (e13-t12)', () => {
  it('takes no comments and says when it comes out', async () => {
    mocks.auth = { user: officer }
    const at = new Date(2026, 10, 7, 19, 0).getTime()
    mocks.forum.post.mockResolvedValue({ post: post({ publishAt: at }), comments: [] })
    renderAt('/forum/p/p1')
    expect(await screen.findByText(/排程在 .* 發布；發布前只有作者與幹部看得到/)).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: '留言' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '隱藏' })).not.toBeInTheDocument()
    expect(screen.queryByText(/^留言 \(/)).not.toBeInTheDocument()
  })

  it('lists my drafts and scheduled posts with what they are', async () => {
    mocks.forum.drafts.mockResolvedValue([
      post({ id: 's1', title: '下週公告', publishAt: new Date(2026, 10, 7, 19, 0).getTime() }),
      post({ id: 'd1', title: '我的草稿', authorId: 'ben', boardId: 'chat', draft: true }),
    ])
    renderAt('/forum/drafts')
    expect(await screen.findByRole('heading', { name: '草稿與排程' })).toBeInTheDocument()
    const scheduled = (await screen.findByText('下週公告')).closest('a')!
    expect(scheduled).toHaveAttribute('href', '/forum/p/s1')
    expect(within(scheduled).getByText('排程中')).toBeInTheDocument()
    expect(within(scheduled).getByText(/小貓 · .*發布/)).toBeInTheDocument()
    const draft = screen.getByText('我的草稿').closest('a')!
    expect(within(draft).getByText('草稿')).toBeInTheDocument()
    expect(within(draft).getByText(/上次儲存/)).toBeInTheDocument()
  })

  it('says so when there is nothing waiting', async () => {
    mocks.forum.drafts.mockResolvedValue([])
    renderAt('/forum/drafts')
    expect(await screen.findByText('沒有草稿或排程中的貼文。')).toBeInTheDocument()
  })
})

describe('the home page’s announcements (e13-t12, AC-13.4)', () => {
  const lobby = () =>
    wrap(
      <MemoryRouter>
        <LobbyNews />
      </MemoryRouter>,
    )

  it('shows the latest announcements, pinned first, beside the newest discussions', async () => {
    mocks.forum.latest.mockResolvedValue({
      news: [post({ id: 'n1', title: '置頂公告', pinned: true }), post({ id: 'n2', title: '週五社課' })],
      discussions: [post({ id: 'x1', boardId: 'deals', authorId: 'ben', title: '這副怎麼叫' })],
    })
    lobby()
    const news = await screen.findByRole('heading', { name: '社團公告' })
    expect(screen.getByRole('heading', { name: '最新討論' })).toBeInTheDocument()
    const column = news.closest('div')!.parentElement!
    expect(within(column).getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(['/forum/news', '/forum/p/n1', '/forum/p/n2'])
    expect(within(column).getByLabelText('置頂')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /這副怎麼叫/ })).toHaveAttribute('href', '/forum/p/x1')
  })

  it('says there is no news yet, and shows nothing without the forum flag or when the forum cannot be read', async () => {
    mocks.forum.latest.mockResolvedValue({ news: [], discussions: [] })
    const { unmount } = lobby()
    expect(await screen.findByText('還沒有公告。')).toBeInTheDocument()
    unmount()

    mocks.forumOn = false
    const off = lobby()
    expect(mocks.forum.latest).toHaveBeenCalledTimes(1)
    expect(off.container).toBeEmptyDOMElement()
    off.unmount()

    mocks.forumOn = true
    mocks.forum.latest.mockRejectedValue(new Error('down'))
    const failed = lobby()
    await waitFor(() => expect(mocks.forum.latest).toHaveBeenCalledTimes(2))
    expect(failed.container).toBeEmptyDOMElement()
  })
})
