import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BUILTIN_BOARDS, type Board, type Post } from '../../shared/forum.ts'
import type { Me } from '../../shared/protocol.ts'
import { ForumBlocks } from '../../src/components/ForumBlocks.tsx'
import { ForumNewPostPage } from '../../src/pages/ForumEditorPage.tsx'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'

/** Pictures in posts (e13-t13): uploading one in the editor, and showing it by its signed address */

const KEY = 'post/0123456789abcdef01234567.webp'
const OTHER = 'post/fedcba9876543210fedcba98.gif'

const mocks = vi.hoisted(() => ({
  forum: {
    tags: vi.fn(async () => [] as { tag: string; count: number }[]),
    boards: vi.fn(),
    createPost: vi.fn(),
  },
  upload: vi.fn(),
  urls: vi.fn(),
  auth: { user: { id: 'ben', username: 'ben', admin: false, permissions: [] } as Me },
}))
vi.mock('../../src/lib/forum.ts', () => ({ forumApi: mocks.forum }))
vi.mock('../../src/state/AuthContext.tsx', () => ({ useAuth: () => mocks.auth }))
vi.mock('../../src/lib/postImage.ts', async (original) => ({
  ...(await original<typeof import('../../src/lib/postImage.ts')>()),
  uploadPostImage: mocks.upload,
  fileUrls: mocks.urls,
}))

const boards: Board[] = BUILTIN_BOARDS.map((b) => ({ ...b, pinnedPostIds: [] }))
const wrap = (ui: React.ReactNode) => render(<PreferencesProvider>{ui}</PreferencesProvider>)
const renderEditor = () =>
  wrap(
    <MemoryRouter initialEntries={['/forum/new?board=deals']}>
      <Routes>
        <Route path="/forum/new" element={<ForumNewPostPage />} />
        <Route path="/forum/p/:postId" element={<p>post page</p>} />
      </Routes>
    </MemoryRouter>,
  )
const picture = () => new File([new Uint8Array([0x52, 0x49, 0x46, 0x46])], 'table.webp', { type: 'image/webp' })

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.removeItem('tku-bridgetable:forumDraft')
  mocks.forum.boards.mockResolvedValue(boards)
  mocks.urls.mockImplementation(async (keys: string[]) =>
    Object.fromEntries(keys.filter((k) => k === KEY).map((k) => [k, { url: `/api/files/${k}?e=1&s=sig` }])),
  )
})

describe('pictures in the post editor (e13-t13)', () => {
  it('uploads a picked picture and sends it as an image block with its alternative text and caption', async () => {
    mocks.upload.mockResolvedValue({ key: KEY, type: 'image/webp', size: 64, url: `/api/files/${KEY}?e=1&s=sig` })
    mocks.forum.createPost.mockResolvedValue({ id: 'p1' } as Post)
    renderEditor()
    await screen.findByLabelText('發布到')
    expect(screen.getByText(/照片會先在你的瀏覽器縮小/)).toBeInTheDocument()
    await userEvent.upload(screen.getByTestId('post-image-input'), picture())
    expect(mocks.upload).toHaveBeenCalledWith(expect.any(File))
    // The picture shows from its signed address
    expect(await screen.findByRole('img', { name: '圖片' })).toHaveAttribute('src', `/api/files/${KEY}?e=1&s=sig`)
    await userEvent.type(screen.getByLabelText('替代文字（給看不到圖片的人，選填）'), '牌桌照片')
    await userEvent.type(screen.getByLabelText('圖片 · 說明（選填）'), '第一桌')
    await userEvent.click(screen.getByRole('button', { name: '發布' }))
    await waitFor(() =>
      expect(mocks.forum.createPost).toHaveBeenCalledWith('deals', {
        title: undefined,
        blocks: [{ kind: 'image', assetId: KEY, alt: '牌桌照片', caption: '第一桌' }],
        tags: [],
      }),
    )
  })

  it('says why a picture cannot go, in the reader’s language', async () => {
    const { PostImageProblem } = await import('../../src/lib/postImage.ts')
    mocks.upload.mockRejectedValueOnce(new PostImageProblem('badType'))
    renderEditor()
    await screen.findByLabelText('發布到')
    await userEvent.upload(screen.getByTestId('post-image-input'), picture())
    expect(await screen.findByRole('alert')).toHaveTextContent('只能上傳 JPEG、PNG、WebP 或 GIF 圖片')
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })
})

describe('pictures in a post (e13-t13)', () => {
  it('shows a picture by its signed address and a note for one the reader may not see', async () => {
    wrap(
      <ForumBlocks
        blocks={[
          { kind: 'image', assetId: KEY, alt: '牌桌照片', caption: '第一桌' },
          { kind: 'image', assetId: OTHER, alt: '' },
        ]}
      />,
    )
    const img = await screen.findByRole('img', { name: '牌桌照片' })
    expect(img).toHaveAttribute('src', `/api/files/${KEY}?e=1&s=sig`)
    expect(img.closest('a')).toHaveAttribute('target', '_blank')
    expect(screen.getByText('第一桌')).toBeInTheDocument()
    expect(screen.getByText('圖片已刪除，或暫時無法顯示')).toBeInTheDocument()
    expect(mocks.urls).toHaveBeenCalledTimes(1)
    expect(mocks.urls).toHaveBeenCalledWith([KEY, OTHER])
  })
})
