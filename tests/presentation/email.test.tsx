import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EmailLinkPage } from '../../src/pages/EmailLinkPage.tsx'
import { LoginPage } from '../../src/pages/LoginPage.tsx'
import { AuthProvider } from '../../src/state/AuthContext.tsx'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'

/** Answers the API calls the page makes; records what was sent */
function stubApi(routes: Record<string, { status: number; body: unknown }>) {
  const sent: { path: string; body: unknown }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      sent.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      const route = routes[path] ?? { status: 401, body: { error: '請先登入', code: 'signInFirst', params: {} } }
      return new Response(JSON.stringify(route.body), { status: route.status })
    }),
  )
  return sent
}

const wrap = (children: ReactNode) =>
  render(
    <PreferencesProvider>
      <AuthProvider>{children}</AuthProvider>
    </PreferencesProvider>,
  )

afterEach(() => {
  vi.unstubAllGlobals()
  window.history.replaceState(null, '', '/')
})

describe('忘記密碼 by email (e1-t30)', () => {
  it('mails a reset link when the club sends mail, and still offers the admins’ way', async () => {
    const sent = stubApi({
      '/api/email': { status: 200, body: { enabled: true } },
      '/api/email/reset/request': { status: 200, body: { ok: true } },
    })
    wrap(<LoginPage />)
    await screen.findByRole('button', { name: '忘記密碼？' })
    await vi.waitFor(() => expect(sent.some((s) => s.path === '/api/email')).toBe(true))
    await userEvent.click(screen.getByRole('button', { name: '忘記密碼？' }))
    expect(await screen.findByRole('heading', { name: '用 Email 重設密碼' })).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText(/^帳號或 Email/), 'amy@example.org')
    await userEvent.click(screen.getByRole('button', { name: '寄重設連結' }))
    expect(await screen.findByRole('status')).toHaveTextContent('如果這個帳號有驗證過的 Email')
    expect(sent.find((s) => s.path === '/api/email/reset/request')!.body).toEqual({ account: 'amy@example.org', lang: 'zh' })
    await userEvent.click(screen.getByRole('button', { name: '請管理員核准' }))
    expect(screen.getByLabelText(/^邀請碼/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '用 Email 重設' })).toBeInTheDocument()
  })

  it('has no email reset when the club sends no mail', async () => {
    stubApi({})
    wrap(<LoginPage />)
    await userEvent.click(screen.getByRole('button', { name: '忘記密碼？' }))
    expect(screen.getByLabelText(/^邀請碼/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '用 Email 重設' })).toBeNull()
  })
})

describe('the email links (e1-t29, e1-t30)', () => {
  it('sets a new password with the link’s token and takes it off the address bar', async () => {
    window.history.replaceState(null, '', '/email/reset#secret-token')
    const sent = stubApi({ '/api/email/reset': { status: 200, body: { username: 'amy' } } })
    wrap(<EmailLinkPage kind="reset" />)
    expect(window.location.hash).toBe('')
    await userEvent.type(screen.getByLabelText(/^新密碼/), 'brand-new-passphrase')
    await userEvent.type(screen.getByLabelText(/^再輸入一次新密碼/), 'brand-new-passphrase')
    await userEvent.click(screen.getByRole('button', { name: '設定新密碼' }))
    expect(await screen.findByRole('status')).toHaveTextContent('amy 的密碼已重設')
    expect(sent.find((s) => s.path === '/api/email/reset')!.body).toEqual({ token: 'secret-token', password: 'brand-new-passphrase' })
  })

  it('verifies an address only when the button is pressed, and shows a used link’s error', async () => {
    window.history.replaceState(null, '', '/email/verify#used')
    const sent = stubApi({
      '/api/email/verify': { status: 403, body: { error: 'x', code: 'emailLinkWrong', params: {} } },
    })
    wrap(<EmailLinkPage kind="verify" />)
    expect(sent.some((s) => s.path === '/api/email/verify')).toBe(false)
    await userEvent.click(screen.getByRole('button', { name: '確認 Email' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('連結不正確')
  })

  it('says so when the link has no token', () => {
    window.history.replaceState(null, '', '/email/verify')
    stubApi({})
    wrap(<EmailLinkPage kind="verify" />)
    expect(screen.getByRole('alert')).toHaveTextContent('連結不完整')
  })
})
