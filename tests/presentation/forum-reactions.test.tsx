import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Comment, Post } from '../../shared/forum.ts'
import type { LobbyView, Me } from '../../shared/protocol.ts'
import { ForumPostPage } from '../../src/pages/ForumPages.tsx'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'

/** AC-13.1 on the table's post page: reacting, pinning (officers only) and editing one's own comment */

const mocks = vi.hoisted(() => ({
  forum: { post: vi.fn(), pin: vi.fn(), react: vi.fn(), unreact: vi.fn(), updateComment: vi.fn(), comment: vi.fn(), deleteComment: vi.fn() },
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

const officer: Me = { id: 'cat', username: 'cat', admin: false, permissions: ['forumModerate'] }
const post = (over: Partial<Post> = {}): Post => ({
  id: 'p1',
  boardId: 'deals',
  authorId: 'amy',
  title: '貼文',
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

const show = () =>
  render(
    <PreferencesProvider>
      <MemoryRouter initialEntries={['/forum/p/p1']}>
        <Routes>
          <Route path="/forum/p/:postId" element={<ForumPostPage />} />
        </Routes>
      </MemoryRouter>
    </PreferencesProvider>,
  )

beforeEach(() => {
  vi.clearAllMocks()
  mocks.auth = { user: { id: 'ben', username: 'ben', admin: false, permissions: [] } }
})

describe('reactions (按讚)', () => {
  it('reacts to the post, shows the count, and marks which one is mine', async () => {
    mocks.forum.post.mockResolvedValue({ post: post({ reactions: { '♥': ['amy'] } }), comments: [] })
    mocks.forum.react.mockResolvedValue({ '👍': ['ben'], '♥': ['amy'] })
    show()
    const bar = await screen.findByRole('group', { name: '反應' })
    expect(within(bar).getAllByRole('button')).toHaveLength(5)
    expect(within(bar).getByRole('button', { name: '按 ♥，目前 1 人' })).toHaveAttribute('aria-pressed', 'false')
    // Who reacted, by name
    expect(within(bar).getByRole('button', { name: '按 ♥，目前 1 人' })).toHaveAttribute('title', '艾美')

    await userEvent.click(within(bar).getByRole('button', { name: '按 👍，目前 0 人' }))
    expect(mocks.forum.react).toHaveBeenCalledWith('post', 'p1', '👍')
    expect(await within(bar).findByRole('button', { name: '按 👍，目前 1 人' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('takes mine back when pressed again, and another one replaces it', async () => {
    mocks.forum.post.mockResolvedValue({ post: post({ reactions: { '👍': ['ben'] } }), comments: [] })
    mocks.forum.react.mockResolvedValue({ '♠': ['ben'] })
    mocks.forum.unreact.mockResolvedValue({})
    show()
    const bar = await screen.findByRole('group', { name: '反應' })
    await userEvent.click(within(bar).getByRole('button', { name: '按 ♠，目前 0 人' }))
    expect(mocks.forum.react).toHaveBeenCalledWith('post', 'p1', '♠')
    await userEvent.click(await within(bar).findByRole('button', { name: '按 ♠，目前 1 人' }))
    expect(mocks.forum.unreact).toHaveBeenCalledWith('post', 'p1')
    expect(await within(bar).findByRole('button', { name: '按 ♠，目前 0 人' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('reacts to a comment on its own, and shows what the server refuses', async () => {
    mocks.forum.post.mockResolvedValue({ post: post(), comments: [comment('c1')] })
    mocks.forum.react.mockRejectedValue(Object.assign(new Error('這篇貼文不見了'), { code: 'postGone' }))
    show()
    const bars = await screen.findAllByRole('group', { name: '反應' })
    expect(bars).toHaveLength(2)
    await userEvent.click(within(bars[1]).getByRole('button', { name: '按 ♦，目前 0 人' }))
    expect(mocks.forum.react).toHaveBeenCalledWith('comment', 'c1', '♦')
    expect(await screen.findByRole('alert')).toBeInTheDocument()
  })

  it('has none on a draft', async () => {
    mocks.forum.post.mockResolvedValue({ post: post({ authorId: 'ben', draft: true }), comments: [] })
    show()
    await screen.findByRole('heading', { name: '貼文' })
    expect(screen.queryByRole('group', { name: '反應' })).not.toBeInTheDocument()
  })
})

describe('pinning', () => {
  it('is not offered to a member; the post still says it is pinned', async () => {
    mocks.forum.post.mockResolvedValue({ post: post({ pinned: true }), comments: [] })
    show()
    await screen.findByRole('heading', { name: '貼文' })
    expect(screen.getByText('置頂')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '設為置頂' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '取消置頂' })).not.toBeInTheDocument()
  })

  it('lets an officer pin the post and take it down', async () => {
    mocks.auth = { user: officer }
    mocks.forum.post.mockResolvedValueOnce({ post: post(), comments: [] })
    mocks.forum.post.mockResolvedValueOnce({ post: post({ pinned: true }), comments: [] })
    mocks.forum.pin.mockResolvedValue(post({ pinned: true }))
    show()
    await userEvent.click(await screen.findByRole('button', { name: '設為置頂' }))
    expect(mocks.forum.pin).toHaveBeenCalledWith('p1', true)
    mocks.forum.post.mockResolvedValueOnce({ post: post(), comments: [] })
    await userEvent.click(await screen.findByRole('button', { name: '取消置頂' }))
    expect(mocks.forum.pin).toHaveBeenLastCalledWith('p1', false)
    expect(await screen.findByRole('button', { name: '設為置頂' })).toBeInTheDocument()
  })

  it('shows the server’s answer when the right is gone, and is not offered on a draft', async () => {
    mocks.auth = { user: officer }
    mocks.forum.post.mockResolvedValue({ post: post(), comments: [] })
    mocks.forum.pin.mockRejectedValue(Object.assign(new Error('沒有權限'), { code: 'noPermission' }))
    const first = show()
    await userEvent.click(await screen.findByRole('button', { name: '設為置頂' }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    first.unmount()
    mocks.forum.post.mockResolvedValue({ post: post({ authorId: 'cat', draft: true }), comments: [] })
    show()
    await screen.findByRole('heading', { name: '貼文' })
    expect(screen.queryByRole('button', { name: '設為置頂' })).not.toBeInTheDocument()
  })
})

describe('editing a comment', () => {
  it('offers it only on one’s own comment, even to an officer', async () => {
    mocks.forum.post.mockResolvedValue({ post: post(), comments: [comment('c1'), comment('c2', { authorId: 'ben' })] })
    show()
    await screen.findByText('留言 c1')
    expect(screen.getAllByRole('button', { name: '編輯留言' })).toHaveLength(1)
  })

  it('saves the new text, keeps its auction, and shows the comment as edited', async () => {
    const auction = { dealer: 'N', vul: 'None', calls: ['1C'] } as never
    const mine = comment('c2', {
      authorId: 'ben',
      blocks: [
        { kind: 'paragraph', text: '原本的話' },
        { kind: 'auction', auction },
      ],
    })
    mocks.forum.post.mockResolvedValueOnce({ post: post(), comments: [mine] })
    mocks.forum.updateComment.mockResolvedValue(mine)
    mocks.forum.post.mockResolvedValueOnce({
      post: post(),
      comments: [{ ...mine, editedAt: 5, blocks: [{ kind: 'paragraph', text: '改過的話' }, mine.blocks[1]] }],
    })
    show()
    await userEvent.click(await screen.findByRole('button', { name: '編輯留言' }))
    const box = screen.getByRole('textbox', { name: '編輯這則留言' })
    expect(box).toHaveValue('原本的話')
    await userEvent.clear(box)
    await userEvent.type(box, '改過的話')
    await userEvent.click(screen.getByRole('button', { name: '儲存' }))
    expect(mocks.forum.updateComment).toHaveBeenCalledWith('c2', [{ kind: 'paragraph', text: '改過的話' }, { kind: 'auction', auction }])
    expect(await screen.findByText('改過的話')).toBeInTheDocument()
    expect(screen.getByText(/已編輯/)).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: '編輯這則留言' })).not.toBeInTheDocument()
  })

  it('will not save an empty comment; cancel leaves it as it was', async () => {
    mocks.forum.post.mockResolvedValue({ post: post(), comments: [comment('c2', { authorId: 'ben' })] })
    show()
    await userEvent.click(await screen.findByRole('button', { name: '編輯留言' }))
    await userEvent.clear(screen.getByRole('textbox', { name: '編輯這則留言' }))
    expect(screen.getByRole('button', { name: '儲存' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.getByText('留言 c2')).toBeInTheDocument()
    expect(mocks.forum.updateComment).not.toHaveBeenCalled()
  })

  it('keeps the form and the text when the server refuses', async () => {
    mocks.forum.post.mockResolvedValue({ post: post(), comments: [comment('c2', { authorId: 'ben' })] })
    mocks.forum.updateComment.mockRejectedValue(Object.assign(new Error('太快了'), { code: 'slowDown' }))
    show()
    await userEvent.click(await screen.findByRole('button', { name: '編輯留言' }))
    await userEvent.type(screen.getByRole('textbox', { name: '編輯這則留言' }), '！')
    await userEvent.click(screen.getByRole('button', { name: '儲存' }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: '編輯這則留言' })).toHaveValue('留言 c2！')
  })
})
