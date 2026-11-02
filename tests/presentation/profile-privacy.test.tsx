import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '../../src/components/Toast.tsx'
import { AccountPage } from '../../src/pages/AccountPage.tsx'
import { AuthProvider } from '../../src/state/AuthContext.tsx'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'

/** My account: what others see on my profile page (e13-t08, 隱私設定) */

afterEach(() => vi.unstubAllGlobals())

function serve(me: Record<string, unknown>) {
  const posts: unknown[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/account/preferences' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { profileBoards?: boolean; profilePosts?: boolean }
        posts.push(body)
        const privacy = me.profilePrivacy as { boards: boolean; posts: boolean }
        me = {
          ...me,
          profilePrivacy: { boards: body.profileBoards ?? privacy.boards, posts: body.profilePosts ?? privacy.posts },
        }
      }
      return new Response(JSON.stringify({ user: me }), { status: 200 })
    }),
  )
  render(
    <PreferencesProvider>
      <ToastProvider>
        <AuthProvider>
          <MemoryRouter>
            <AccountPage />
          </MemoryRouter>
        </AuthProvider>
      </ToastProvider>
    </PreferencesProvider>,
  )
  return posts
}

const amy = (features: string[]) => ({
  id: 'amy',
  username: 'amy',
  admin: false,
  permissions: [],
  features,
  profilePrivacy: { boards: true, posts: true },
})

describe('my account: profile privacy', () => {
  it('hides my boards and posts from my profile page on the server', async () => {
    const posts = serve(amy(['forum']))
    const boards = await screen.findByRole('group', { name: '個人頁的「最近的牌」' })
    expect(within(boards).getByRole('radio', { name: '公開' })).toBeChecked()
    await userEvent.click(within(boards).getByRole('radio', { name: '不公開' }))
    expect(posts).toEqual([{ profileBoards: false }])
    expect(await within(boards).findByRole('radio', { name: '不公開' })).toBeChecked()
    const forum = screen.getByRole('group', { name: '個人頁的「論壇貼文」' })
    await userEvent.click(within(forum).getByRole('radio', { name: '不公開' }))
    expect(posts).toEqual([{ profileBoards: false }, { profilePosts: false }])
  })

  it('offers the forum posts only with the forum flag', async () => {
    serve(amy([]))
    expect(await screen.findByRole('group', { name: '個人頁的「最近的牌」' })).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: '個人頁的「論壇貼文」' })).toBeNull()
  })
})
