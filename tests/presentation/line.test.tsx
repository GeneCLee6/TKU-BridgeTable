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

const on = (enabled: boolean): Answer => ({ status: 200, body: { enabled } })
const LINE_ON = { '/api/auth/line': on(true) }
const amy = (line: Me['line']): Me => ({ id: 'm1', username: 'amy', admin: false, permissions: [], line })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  window.history.replaceState(null, '', '/')
})

describe('the branded sign-in buttons (e1-t31, e1-t32)', () => {
  it('shows Google’s and LINE’s own buttons, each with its logo, under 或', async () => {
    stubApi({ '/api/auth/google': on(true), ...LINE_ON })
    wrap(<LoginPage />)
    const google = await screen.findByRole('button', { name: '使用 Google 帳戶登入' })
    const line = await screen.findByRole('button', { name: '用 LINE 登入' })
    expect(screen.getByText('或')).toBeInTheDocument()
    // The logos are inline SVG (the CSP lets in no images from other sites), hidden from screen readers
    for (const button of [google, line]) {
      const logo = button.querySelector('svg')
      expect(logo).not.toBeNull()
      expect(logo).toHaveAttribute('aria-hidden', 'true')
      expect(button.querySelector('img')).toBeNull()
    }
    expect(google.querySelectorAll('svg path')).toHaveLength(4)
    expect(google).toHaveAttribute('type', 'button')
  })

  it('shows only LINE when the club has only LINE, and the application’s wording on 申請加入', async () => {
    const sent = stubApi({ '/api/auth/google': on(false), ...LINE_ON })
    wrap(<LoginPage />)
    await screen.findByRole('button', { name: '用 LINE 登入' })
    expect(sent.some((s) => s.path === '/api/auth/google')).toBe(true)
    expect(screen.queryByRole('button', { name: '使用 Google 帳戶登入' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '申請加入' }))
    expect(await screen.findByRole('button', { name: '用 LINE 申請加入' })).toBeInTheDocument()
  })

  it('has neither when the club has neither', async () => {
    const sent = stubApi({ '/api/auth/google': on(false), '/api/auth/line': on(false) })
    wrap(<LoginPage />)
    await vi.waitFor(() => expect(sent.filter((s) => s.path.startsWith('/api/auth/')).length).toBe(2))
    expect(screen.queryByText('或')).toBeNull()
  })
})

describe('logging in with LINE (e1-t32)', () => {
  it('goes to LINE with this site and the page the member was on', async () => {
    window.history.replaceState(null, '', '/history?scope=all')
    const to = vi.spyOn(leave, 'to').mockImplementation(() => undefined)
    const sent = stubApi({
      ...LINE_ON,
      '/api/auth/line/start': { status: 200, body: { url: 'https://access.line.me/oauth2/v2.1/authorize?x=1' } },
    })
    wrap(<LoginPage />)
    await userEvent.click(await screen.findByRole('button', { name: '用 LINE 登入' }))
    await vi.waitFor(() => expect(to).toHaveBeenCalledWith('https://access.line.me/oauth2/v2.1/authorize?x=1'))
    expect(sent.find((s) => s.path === '/api/auth/line/start')!.body).toEqual({
      origin: window.location.origin,
      returnTo: '/history?scope=all',
    })
  })

  it('shows what went wrong at LINE and takes it off the address bar', async () => {
    window.history.replaceState(null, '', '/?line=error&code=lineNotLinked')
    stubApi(LINE_ON)
    wrap(<LoginPage />)
    expect(await screen.findByRole('alert')).toHaveTextContent('這個 LINE 帳號還沒有綁定社團帳號')
    expect(window.location.search).toBe('')
  })

  it('asks for the two-step code after LINE', async () => {
    window.history.replaceState(null, '', '/?line=code')
    const sent = stubApi({ ...LINE_ON, '/api/auth/line/code': { status: 200, body: { user: amy(null), returnTo: '/lobby' } } })
    wrap(<LoginPage />)
    expect(await screen.findByRole('heading', { name: '輸入驗證碼' })).toBeInTheDocument()
    expect(screen.getByText(/用 LINE 登入也要輸入/)).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText(/^驗證碼/), '123456')
    await userEvent.click(screen.getByRole('button', { name: '登入' }))
    await vi.waitFor(() => expect(window.location.pathname).toBe('/lobby'))
    expect(sent.find((s) => s.path === '/api/auth/line/code')!.body).toEqual({ code: '123456', lang: 'zh' })
  })

  it('applies with LINE: still a username and a password, LINE’s name only fills in the display name', async () => {
    window.history.replaceState(null, '', '/?line=apply')
    const sent = stubApi({
      ...LINE_ON,
      '/api/auth/google': on(true),
      '/api/auth/line/pending': { status: 200, body: { step: 'apply', name: '王小美' } },
      '/api/register': { status: 202, body: { pending: true, username: 'amy' } },
    })
    wrap(<LoginPage />)
    expect(await screen.findByText(/已確認你的 LINE 帳號/)).toBeInTheDocument()
    expect(screen.getByLabelText(/^顯示名稱/)).toHaveValue('王小美')
    await userEvent.type(screen.getByLabelText(/^帳號/), 'amy')
    await userEvent.type(screen.getByLabelText(/^密碼/), 'club-secret-1')
    await userEvent.type(screen.getByLabelText(/^邀請碼/), 'tku')
    expect(screen.queryByRole('button', { name: '用 LINE 申請加入' })).toBeNull()
    expect(screen.queryByRole('button', { name: '使用 Google 帳戶申請加入' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '申請加入' }))
    expect(await screen.findByText(/已送出 amy 的申請/)).toBeInTheDocument()
    expect(sent.find((s) => s.path === '/api/register')!.body).toEqual({
      username: 'amy',
      password: 'club-secret-1',
      inviteCode: 'tku',
      note: '',
      site: 'table',
      line: true,
      displayName: '王小美',
    })
  })
})

describe('"My account"’s LINE card (e1-t32)', () => {
  it('is not there when the club has no LINE login', async () => {
    const sent = stubApi({ '/api/me': { status: 200, body: { user: amy(undefined) } } })
    wrap(<OAuthCard provider="line" />)
    await vi.waitFor(() => expect(sent.some((s) => s.path === '/api/me')).toBe(true))
    expect(screen.queryByText('LINE 登入')).toBeNull()
  })

  it('binds with the password first, then LINE’s own button', async () => {
    const to = vi.spyOn(leave, 'to').mockImplementation(() => undefined)
    const sent = stubApi({
      '/api/me': { status: 200, body: { user: amy(null) } },
      '/api/account/line/link': { status: 200, body: { url: 'https://access.line.me/oauth2/v2.1/authorize?y=1' } },
    })
    wrap(<OAuthCard provider="line" />)
    expect(await screen.findByText('還沒有綁定 LINE 帳號。')).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText(/^輸入密碼確認/), 'club-secret-1')
    const button = screen.getByRole('button', { name: '綁定 LINE 帳號' })
    expect(button.querySelector('svg')).not.toBeNull()
    await userEvent.click(button)
    await vi.waitFor(() => expect(to).toHaveBeenCalledWith('https://access.line.me/oauth2/v2.1/authorize?y=1'))
    expect(sent.find((s) => s.path === '/api/account/line/link')!.body).toEqual({
      password: 'club-secret-1',
      origin: window.location.origin,
    })
  })

  it('shows the LINE name to the owner, unbinds with the password, and reports a binding that came back', async () => {
    window.history.replaceState(null, '', '/account?line=linked')
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const sent = stubApi({
      '/api/me': [
        { status: 200, body: { user: amy({ name: '小美', linkedAt: 1 }) } },
        { status: 200, body: { user: amy(null) } },
      ],
      '/api/account/line/unlink': { status: 200, body: { user: amy(null) } },
    })
    wrap(<OAuthCard provider="line" />)
    expect(await screen.findByText('已綁定：小美')).toBeInTheDocument()
    expect(window.location.search).toBe('')
    await userEvent.type(screen.getByLabelText(/^輸入密碼確認/), 'club-secret-1')
    await userEvent.click(screen.getByRole('button', { name: '解除綁定' }))
    expect(await screen.findByText('還沒有綁定 LINE 帳號。')).toBeInTheDocument()
    expect(sent.find((s) => s.path === '/api/account/line/unlink')!.body).toEqual({ password: 'club-secret-1' })
  })
})
