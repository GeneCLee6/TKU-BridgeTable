import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fullDeck } from '../../shared/cards.ts'
import { BUILTIN_BOARDS, type Board, type ForumAuction, type ForumDeal, type Post } from '../../shared/forum.ts'
import { emptyAuction, emptyDeal } from '../../shared/forum-editor.ts'
import type { LobbyView, Me } from '../../shared/protocol.ts'
import { AuctionEditor } from '../../src/components/AuctionEditor.tsx'
import { DealEditor } from '../../src/components/DealEditor.tsx'
import { ForumEditPostPage, ForumNewPostPage } from '../../src/pages/ForumEditorPage.tsx'
import { ForumPostPage } from '../../src/pages/ForumPages.tsx'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'

/** The table's post editor (E13 K2): four hands (e13-t05), an auction (e13-t06), the post editor (e13-t04) */

const mocks = vi.hoisted(() => ({
  forum: {
    tags: vi.fn(async () => [] as { tag: string; count: number }[]),
    boards: vi.fn(),
    post: vi.fn(),
    createPost: vi.fn(),
    updatePost: vi.fn(),
    deletePost: vi.fn(),
    comment: vi.fn(),
    deleteComment: vi.fn(),
  },
  auth: { user: { id: 'ben', username: 'ben', admin: false, permissions: [] } as Me },
}))
vi.mock('../../src/lib/forum.ts', () => ({ forumApi: mocks.forum }))
vi.mock('../../src/state/AuthContext.tsx', () => ({ useAuth: () => mocks.auth }))
const LOBBY: LobbyView = { online: [], members: [], tables: [], myTableId: null, friends: [], blocked: [] }
vi.mock('../../src/state/ClubContext.tsx', () => ({ useClub: () => ({ lobby: LOBBY }) }))

const boards: Board[] = BUILTIN_BOARDS.map((b) => ({ ...b, pinnedPostIds: [] }))
const post = (over: Partial<Post> = {}): Post => ({
  id: 'p1',
  boardId: 'deals',
  authorId: 'ben',
  title: '舊標題',
  blocks: [{ kind: 'paragraph', text: '舊內容' }],
  createdAt: 0,
  reactions: {},
  commentCount: 0,
  ...over,
})

const wrap = (ui: React.ReactNode) => render(<PreferencesProvider>{ui}</PreferencesProvider>)

function DealHarness({ onDeal }: { onDeal: (deal: ForumDeal) => void }) {
  const [deal, setDeal] = useState(emptyDeal())
  return (
    <DealEditor
      value={deal}
      onChange={(d) => {
        setDeal(d)
        onDeal(d)
      }}
    />
  )
}

function AuctionHarness({ onAuction }: { onAuction: (a: ForumAuction) => void }) {
  const [auction, setAuction] = useState(emptyAuction('E'))
  return (
    <AuctionEditor
      value={auction}
      onChange={(a) => {
        setAuction(a)
        onAuction(a)
      }}
    />
  )
}

const cardButton = (name: RegExp) => within(screen.getByRole('group', { name: '點選要給的牌' })).getByRole('button', { name })

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.removeItem('tku-bridgetable:forumDraft')
  mocks.auth = { user: { id: 'ben', username: 'ben', admin: false, permissions: [] } }
  mocks.forum.boards.mockResolvedValue(boards)
})

describe('four-hand editor (e13-t05)', () => {
  it('deals 52 different cards, 13 a hand, moving on to the next seat and giving the rest to the last', () => {
    let last: ForumDeal = emptyDeal()
    wrap(<DealHarness onDeal={(d) => (last = d)} />)
    // Click the first 39 cards of the pack: North, East and South fill in turn
    for (const card of fullDeck().slice(0, 39)) {
      const buttons = within(screen.getByRole('group', { name: '點選要給的牌' })).getAllByRole('button')
      const index = fullDeck().indexOf(card)
      fireEvent.click(buttons[index])
    }
    expect(last.hands.N).toHaveLength(13)
    expect(last.hands.E).toHaveLength(13)
    expect(last.hands.S).toHaveLength(13)
    expect(screen.getByRole('button', { name: '西 0', pressed: true })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('還有 13 張沒分配')
    fireEvent.click(screen.getByRole('button', { name: '其餘 13 張給西家' }))
    expect(last.hands.W).toHaveLength(13)
    expect(new Set(Object.values(last.hands).flat()).size).toBe(52)
    expect(screen.getAllByRole('status')[0]).toHaveTextContent('52 張都分好了')
  })

  it('takes a card back, moves it to another seat, and keeps the dealer and vulnerability', () => {
    let last: ForumDeal = emptyDeal()
    wrap(<DealHarness onDeal={(d) => (last = d)} />)
    // The first key is ♠A
    fireEvent.click(within(screen.getByRole('group', { name: '點選要給的牌' })).getAllByRole('button')[0])
    expect(last.hands.N).toEqual(['SA'])
    fireEvent.click(screen.getByRole('button', { name: /^東 / }))
    fireEvent.click(cardButton(/北家/))
    expect(last.hands).toMatchObject({ N: [], E: ['SA'] })
    fireEvent.click(cardButton(/東家/))
    expect(last.hands.E).toEqual([])
    fireEvent.change(screen.getByLabelText('發牌'), { target: { value: 'W' } })
    fireEvent.change(screen.getByLabelText('身價'), { target: { value: 'Both' } })
    expect(last).toMatchObject({ dealer: 'W', vul: 'Both' })
  })
})

describe('auction input (e13-t06)', () => {
  it('offers only legal calls from the bidding box and shows the contract once it is over', async () => {
    let last: ForumAuction = emptyAuction('E')
    wrap(<AuctionHarness onAuction={(a) => (last = a)} />)
    expect(screen.getByRole('button', { name: 'X' })).toBeDisabled()
    await userEvent.keyboard('1s{Enter}')
    expect(last.calls).toEqual([{ seat: 'E', call: '1S' }])
    // Below 1♠ is not offered
    await userEvent.click(screen.getByRole('button', { name: '1' }))
    expect(screen.getAllByRole('button').filter((b) => b.getAttribute('aria-keyshortcuts') === 'C')[0]).toBeDisabled()
    await userEvent.keyboard('{Escape}p{Enter}4s{Enter}p{Enter}p{Enter}p{Enter}')
    expect(last.calls.map((c) => c.call)).toEqual(['1S', 'P', '4S', 'P', 'P', 'P'])
    expect(screen.getByRole('status')).toHaveTextContent('叫牌結束：')
    expect(screen.getByRole('status')).toHaveTextContent('東家主打')
    expect(screen.queryByRole('group', { name: '叫牌盒' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '收回一個叫品' }))
    expect(last.calls).toHaveLength(5)
    fireEvent.change(screen.getByLabelText('發牌'), { target: { value: 'N' } })
    expect(last.calls.map((c) => c.seat)).toEqual(['N', 'E', 'S', 'W', 'N'])
  })
})

const renderAt = (path: string) =>
  wrap(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/forum/new" element={<ForumNewPostPage />} />
        <Route path="/forum/p/:postId" element={<ForumPostPage />} />
        <Route path="/forum/p/:postId/edit" element={<ForumEditPostPage />} />
        <Route path="/forum/:boardId" element={<p>board page</p>} />
      </Routes>
    </MemoryRouter>,
  )

describe('post editor (e13-t04)', () => {
  it('writes a post with Markdown text and an auction, and sends the forum’s blocks', async () => {
    mocks.forum.createPost.mockResolvedValue(post({ id: 'new1' }))
    mocks.forum.post.mockResolvedValue({ post: post({ id: 'new1' }), comments: [] })
    renderAt('/forum/new?board=systems')
    const board = await screen.findByLabelText('發布到')
    expect(board).toHaveValue('systems')
    // The news board takes only the officers' posts
    expect(within(board).queryByRole('option', { name: '社團公告' })).not.toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('標題（選填）'), '這樣叫對嗎')
    fireEvent.change(screen.getByRole('textbox', { name: '文字' }), { target: { value: '開叫 1!s 之後：\n\n- 答叫 2!c\n- 再叫？' } })
    await userEvent.click(screen.getByRole('button', { name: '加叫牌過程' }))
    await userEvent.keyboard('1s{Enter}p{Enter}')
    await userEvent.click(screen.getByRole('button', { name: '發布' }))
    await waitFor(() =>
      expect(mocks.forum.createPost).toHaveBeenCalledWith('systems', {
        title: '這樣叫對嗎',
        blocks: [
          { kind: 'paragraph', text: '開叫 1♠ 之後：' },
          { kind: 'rules', items: [{ text: '答叫 2♣' }, { text: '再叫？' }] },
          {
            kind: 'auction',
            auction: {
              dealer: 'N',
              calls: [
                { seat: 'N', call: '1S' },
                { seat: 'E', call: 'P' },
              ],
            },
          },
        ],
        tags: [],
      }),
    )
    expect(window.localStorage.getItem('tku-bridgetable:forumDraft')).toBeNull()
  })

  it('adds tags typed, pasted with commas or picked from the ones in use, and takes them off (AC-13.7)', async () => {
    mocks.forum.tags.mockResolvedValue([
      { tag: '首攻', count: 4 },
      { tag: '2/1', count: 2 },
    ])
    mocks.forum.createPost.mockResolvedValue(post({ id: 'p9' }))
    renderAt('/forum/new')
    const box = await screen.findByLabelText('標籤（選填）')
    await userEvent.type(box, '#Squeeze{Enter}')
    fireEvent.change(box, { target: { value: '防禦，squeeze,' } })
    const suggested = await screen.findByRole('list', { name: '常用標籤' })
    await userEvent.click(within(suggested).getByRole('button', { name: '#首攻' }))
    const chosen = screen.getByRole('list', { name: '標籤' })
    expect(within(chosen).getAllByRole('button').map((b) => b.textContent)).toEqual(['#squeeze', '#防禦', '#首攻'])
    // A tag picked is not offered again
    expect(within(suggested).queryByRole('button', { name: '#首攻' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '拿掉標籤「防禦」' }))
    fireEvent.change(screen.getByRole('textbox', { name: '文字' }), { target: { value: '擠牌' } })
    await userEvent.click(screen.getByRole('button', { name: '發布' }))
    await waitFor(() =>
      expect(mocks.forum.createPost).toHaveBeenCalledWith('deals', {
        title: undefined,
        blocks: [{ kind: 'paragraph', text: '擠牌' }],
        tags: ['squeeze', '首攻'],
      }),
    )
  })

  it('stops taking tags at the limit', async () => {
    renderAt('/forum/new')
    const box = await screen.findByLabelText('標籤（選填）')
    fireEvent.change(box, { target: { value: 'a,b,c,d,e,f,' } })
    expect(within(screen.getByRole('list', { name: '標籤' })).getAllByRole('button')).toHaveLength(5)
    expect(box).toBeDisabled()
  })

  it('keeps a draft on this device and lists what stops a post', async () => {
    renderAt('/forum/new')
    await screen.findByLabelText('發布到')
    await userEvent.click(screen.getByRole('button', { name: '發布' }))
    expect(await screen.findByText('貼文還沒有內容')).toBeInTheDocument()
    expect(mocks.forum.createPost).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole('textbox', { name: '文字' }), { target: { value: '草稿' } })
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem('tku-bridgetable:forumDraft')!).blocks).toEqual([{ kind: 'paragraph', text: '草稿' }]))
  })

  it('edits a post written on BridgeHall without losing the blocks it does not edit', async () => {
    const deal: ForumDeal = { hands: { N: ['SA', 'SK'], E: ['HA'], S: [], W: [] }, dealer: 'S', vul: 'NS' }
    mocks.forum.post.mockResolvedValue({
      post: post({
        blocks: [
          { kind: 'paragraph', text: '舊內容' },
          { kind: 'deal', deal, caption: '第 1 副' },
          { kind: 'ref', slug: 'stayman' },
        ],
        tags: ['舊標籤'],
      }),
      comments: [],
    })
    mocks.forum.updatePost.mockResolvedValue(post())
    renderAt('/forum/p/p1/edit')
    expect(await screen.findByRole('heading', { name: '編輯貼文' })).toBeInTheDocument()
    expect(screen.getByLabelText('發布到')).toBeDisabled()
    // The four hands are drawn with the record pages' diagram, the seats named instead of players
    expect(screen.getByText('北 · 7 點')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: /發牌 S，南北有身價/ })).toBeInTheDocument()
    expect(screen.getByText('這個區塊在淡江橋館編輯，這裡只能移動或移除。')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox', { name: '文字' }), { target: { value: '新內容' } })
    await userEvent.click(screen.getByRole('button', { name: '儲存' }))
    await waitFor(() =>
      expect(mocks.forum.updatePost).toHaveBeenCalledWith('p1', {
        title: '舊標題',
        blocks: [{ kind: 'paragraph', text: '新內容' }, { kind: 'deal', deal: { ...deal, hands: { N: ['SA', 'SK'], E: ['HA'], S: [], W: [] } }, caption: '第 1 副' }, { kind: 'ref', slug: 'stayman' }],
        tags: ['舊標籤'],
      }),
    )
  })

  it('lets only the author edit; the author or an officer deletes', async () => {
    mocks.forum.post.mockResolvedValue({ post: post({ authorId: 'amy' }), comments: [] })
    const { unmount } = renderAt('/forum/p/p1')
    expect(await screen.findByRole('heading', { name: '舊標題' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: '編輯' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '刪除貼文' })).not.toBeInTheDocument()
    unmount()

    mocks.forum.post.mockResolvedValue({ post: post(), comments: [] })
    mocks.forum.deletePost.mockResolvedValue({ ok: true })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderAt('/forum/p/p1')
    expect(await screen.findByRole('link', { name: '編輯' })).toHaveAttribute('href', '/forum/p/p1/edit')
    await userEvent.click(screen.getByRole('button', { name: '刪除貼文' }))
    await waitFor(() => expect(mocks.forum.deletePost).toHaveBeenCalledWith('p1'))
    expect(await screen.findByText('board page')).toBeInTheDocument()
  })

  it('sends a comment with an auction', async () => {
    mocks.forum.post.mockResolvedValue({ post: post({ authorId: 'amy' }), comments: [] })
    mocks.forum.comment.mockResolvedValue({})
    renderAt('/forum/p/p1')
    await userEvent.click(await screen.findByRole('button', { name: '加叫牌過程' }))
    await userEvent.keyboard('1n{Enter}')
    await userEvent.click(screen.getByRole('button', { name: '送出' }))
    await waitFor(() =>
      expect(mocks.forum.comment).toHaveBeenCalledWith('p1', {
        parentId: undefined,
        blocks: [{ kind: 'auction', auction: { dealer: 'N', calls: [{ seat: 'N', call: '1N' }] } }],
      }),
    )
  })
})
