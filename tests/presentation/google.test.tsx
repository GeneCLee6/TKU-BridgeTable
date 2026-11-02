import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OAuthCard } from '../../src/components/OAuthCard.tsx'
import { leave } from '../../src/lib/leave.ts'
import { LoginPage } from '../../src/pages/LoginPage.tsx'
import { AuthProvider } from '../../src/state/AuthContext.tsx'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'
import type { Me } from '../../shared/protocol.ts'

type Answer = { status: number; body: unknown }

/** Answers the API calls; a list of answers is used in order. Records what was sent */
function stubApi(routes: Record<string, Answer | Answer[]>) {
  const sent: { path: string; body: unknown }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      sent.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      const listed = routes[path]
      const route = (Array.isArray(listed) ? listed.shift() : listed) ?? {
        status: 401,
        body: { error: '請先登入', code: 'signInFirst', params: {} },
      }
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

const GOOGLE_ON = { '/api/auth/google': { status: 200, body: { enabled: true } } }
const amy = (google: Me['google']): Me => ({ id: 'm1', username: 'amy', admin: false, permissions: [], google })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  window.history.replaceState(null, '', '/')
})

describe('signing in with Google (e1-t31)', () => {
  it('has no Google button when the club has no Google sign-in', async () => {
    const sent = stubApi({ '/api/auth/google': { status: 200, body: { enabled: false } } })
    wrap(<LoginPage />)
    await vi.waitFor(() => expect(sent.some((s) => s.path === '/api/auth/google')).toBe(true))
    expect(screen.queryByRole('button', { name: '使用 Google 帳戶登入' })).toBeNull()
  })

  it('goes to Google with this site and the page the member was on', async () => {
    window.history.replaceState(null, '', '/history?scope=all')
    const to = vi.spyOn(leave, 'to').mockImplementation(() => undefined)
    const sent = stubApi({ ...GOOGLE_ON, '/api/auth/google/start': { status: 200, body: { url: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' } } })
    wrap(<LoginPage />)
    await userEvent.click(await screen.findByRole('button', { name: '使用 Google 帳戶登入' }))
    await vi.waitFor(() => expect(to).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth?x=1'))
    expect(sent.find((s) => s.path === '/api/auth/google/start')!.body).toEqual({
      origin: window.location.origin,
      returnTo: '/history?scope=all',
    })
  })

  it('shows what went wrong at Google and takes it off the address bar', async () => {
    window.history.replaceState(null, '', '/?google=error&code=googleNotLinked')
    stubApi(GOOGLE_ON)
    wrap(<LoginPage />)
    expect(await screen.findByRole('alert')).toHaveTextContent('這個 Google 帳號還沒有綁定社團帳號')
    expect(window.location.search).toBe('')
  })

  it('asks for the two-step code after Google; Google does not replace it', async () => {
    window.history.replaceState(null, '', '/?google=code')
    const sent = stubApi({
      ...GOOGLE_ON,
      '/api/auth/google/code': [
        { status: 401, body: { error: '…', code: 'twoFactorWrong', params: {} } },
        { status: 200, body: { user: amy(null), returnTo: '/history' } },
      ],
    })
    wrap(<LoginPage />)
    expect(await screen.findByRole('heading', { name: '輸入驗證碼' })).toBeInTheDocument()
    // No name or password here: Google said who it is
    expect(screen.queryByLabelText(/^帳號/)).toBeNull()
    expect(screen.queryByLabelText(/^密碼/)).toBeNull()
    const field = screen.getByLabelText(/^驗證碼/)
    await userEvent.type(field, '000000')
    await userEvent.click(screen.getByRole('button', { name: '登入' }))
    expect(await screen.findByText('驗證碼不正確或已經用過，請輸入 App 上現在的驗證碼')).toBeInTheDocument()
    await userEvent.clear(field)
    await userEvent.type(field, '123456')
    await userEvent.click(screen.getByRole('button', { name: '登入' }))
    await vi.waitFor(() => expect(window.location.pathname).toBe('/history'))
    expect(sent.filter((s) => s.path === '/api/auth/google/code').map((s) => s.body)).toEqual([
      { code: '000000', lang: 'zh' },
      { code: '123456', lang: 'zh' },
    ])
  })

  it('applies with Google: still a username and a password, Google’s name only fills in the display name', async () => {
    window.history.replaceState(null, '', '/?google=apply')
    const sent = stubApi({
      ...GOOGLE_ON,
      '/api/auth/google/pending': { status: 200, body: { step: 'apply', name: '王小美' } },
      '/api/register': { status: 202, body: { pending: true, username: 'amy' } },
    })
    wrap(<LoginPage />)
    expect(await screen.findByText(/已確認你的 Google 帳號/)).toBeInTheDocument()
    const name = screen.getByLabelText(/^顯示名稱/)
    expect(name).toHaveValue('王小美')
    await userEvent.clear(name)
    await userEvent.type(name, '小美')
    await userEvent.type(screen.getByLabelText(/^帳號/), 'amy')
    await userEvent.type(screen.getByLabelText(/^密碼/), 'club-secret-1')
    await userEvent.type(screen.getByLabelText(/^邀請碼/), 'tku')
    // Already used Google: no second Google button
    expect(screen.queryByRole('button', { name: '使用 Google 帳戶申請加入' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '申請加入' }))
    expect(await screen.findByText(/已送出 amy 的申請/)).toBeInTheDocument()
    expect(sent.find((s) => s.path === '/api/register')!.body).toEqual({
      username: 'amy',
      password: 'club-secret-1',
      inviteCode: 'tku',
      note: '',
      site: 'table',
      google: true,
      displayName: '小美',
    })
  })
})

describe('"My account"’s Google card (e1-t31)', () => {
  it('is not there when the club has no Google sign-in', async () => {
    const sent = stubApi({ '/api/me': { status: 200, body: { user: amy(undefined) } } })
    wrap(<OAuthCard provider="google" />)
    await vi.waitFor(() => expect(sent.some((s) => s.path === '/api/me')).toBe(true))
    expect(screen.queryByText('Google 登入')).toBeNull()
  })

  it('binds with the password first, then Google', async () => {
    const to = vi.spyOn(leave, 'to').mockImplementation(() => undefined)
    const sent = stubApi({
      '/api/me': { status: 200, body: { user: amy(null) } },
      '/api/account/google/link': { status: 200, body: { url: 'https://accounts.google.com/o/oauth2/v2/auth?y=1' } },
    })
    wrap(<OAuthCard provider="google" />)
    expect(await screen.findByText('還沒有綁定 Google 帳號。')).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText(/^輸入密碼確認/), 'club-secret-1')
    await userEvent.click(screen.getByRole('button', { name: '綁定 Google 帳號' }))
    await vi.waitFor(() => expect(to).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth?y=1'))
    expect(sent.find((s) => s.path === '/api/account/google/link')!.body).toEqual({ password: 'club-secret-1', origin: window.location.origin })
  })

  it('shows the bound address to the owner and unbinds with the password', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const sent = stubApi({
      '/api/me': [
        { status: 200, body: { user: amy({ email: 'amy@gmail.com', linkedAt: 1 }) } },
        { status: 200, body: { user: amy(null) } },
      ],
      '/api/account/google/unlink': { status: 200, body: { user: amy(null) } },
    })
    wrap(<OAuthCard provider="google" />)
    expect(await screen.findByText('已綁定：amy@gmail.com')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '解除綁定' }))
    expect(screen.getByRole('alert')).toHaveTextContent('請先輸入密碼')
    await userEvent.type(screen.getByLabelText(/^輸入密碼確認/), 'club-secret-1')
    await userEvent.click(screen.getByRole('button', { name: '解除綁定' }))
    expect(await screen.findByText('還沒有綁定 Google 帳號。')).toBeInTheDocument()
    expect(sent.find((s) => s.path === '/api/account/google/unlink')!.body).toEqual({ password: 'club-secret-1' })
  })

  it('reports a failed binding when Google sends the browser back', async () => {
    window.history.replaceState(null, '', '/account?google=error&code=googleTaken')
    stubApi({ '/api/me': { status: 200, body: { user: amy(null) } } })
    wrap(<OAuthCard provider="google" />)
    expect(await screen.findByRole('alert')).toHaveTextContent('這個 Google 帳號已經綁定在另一個社團帳號')
    expect(window.location.search).toBe('')
  })
})
