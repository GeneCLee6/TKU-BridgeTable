import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setClubFromPath } from '../../src/lib/club.ts'
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

const page = () =>
  render(
    <PreferencesProvider>
      <AuthProvider>
        <LoginPage />
      </AuthProvider>
    </PreferencesProvider>,
  )

afterEach(() => vi.unstubAllGlobals())

describe('LoginPage', () => {
  it('links to the club application on 淡江’s sign-in page only (e12-t06)', () => {
    stubApi({})
    const { unmount } = page()
    expect(screen.getByText(/想在這裡開你們社團的牌桌/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '申請建立社團' })).toHaveAttribute('href', '/clubs/apply')
    unmount()
    setClubFromPath('/c/ntu/')
    try {
      page()
      expect(screen.queryByRole('link', { name: '申請建立社團' })).toBeNull()
      expect(screen.queryByText(/想在這裡開你們社團的牌桌/)).toBeNull()
    } finally {
      setClubFromPath('/')
    }
  })

  it('shows and hides the password', async () => {
    stubApi({})
    page()
    const password = screen.getByLabelText(/^密碼/)
    expect(password).toHaveAttribute('type', 'password')
    await userEvent.click(screen.getByRole('button', { name: '顯示密碼' }))
    expect(password).toHaveAttribute('type', 'text')
    expect(screen.getByRole('button', { name: '隱藏密碼' })).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(screen.getByRole('button', { name: '隱藏密碼' }))
    expect(password).toHaveAttribute('type', 'password')
  })

  it('sends a registration for approval and says so', async () => {
    const sent = stubApi({ '/api/register': { status: 202, body: { pending: true, username: 'amy' } } })
    page()
    await userEvent.click(screen.getByRole('button', { name: '申請加入' }))
    await userEvent.type(screen.getByLabelText(/^帳號/), 'amy')
    await userEvent.type(screen.getByLabelText(/^密碼/), 'club-secret-1')
    await userEvent.type(screen.getByLabelText(/^邀請碼/), 'tku')
    await userEvent.type(screen.getByLabelText(/^自我介紹/), '王小美')
    await userEvent.click(screen.getByRole('button', { name: '申請加入' }))
    expect(await screen.findByRole('status')).toHaveTextContent('已送出 amy 的申請')
    expect(sent.find((s) => s.path === '/api/register')!.body).toEqual({
      username: 'amy',
      password: 'club-secret-1',
      inviteCode: 'tku',
      note: '王小美',
      site: 'table',
    })
  })

  it('asks the admins with the invite code, then sets the password with the code they hand over (e1-t36)', async () => {
    const sent = stubApi({
      '/api/password/reset/request': { status: 200, body: { ok: true } },
      '/api/password/reset': { status: 200, body: { ok: true } },
    })
    page()
    await userEvent.click(screen.getByRole('button', { name: '忘記密碼？' }))
    // Asking needs no password
    expect(screen.queryByLabelText(/^新密碼/)).toBeNull()
    await userEvent.type(screen.getByLabelText(/^帳號/), 'amy')
    await userEvent.type(screen.getByLabelText(/^邀請碼/), 'tku')
    await userEvent.click(screen.getByRole('button', { name: '送出申請' }))
    expect(await screen.findByRole('status')).toHaveTextContent('已送出申請')
    expect(sent.find((s) => s.path === '/api/password/reset/request')!.body).toEqual({ username: 'amy', inviteCode: 'tku' })

    await userEvent.click(screen.getByRole('button', { name: '輸入重設代碼' }))
    // The name carries over
    expect(screen.getByLabelText(/^帳號/)).toHaveValue('amy')
    await userEvent.type(screen.getByLabelText(/^重設代碼/), 'ABCDE-FGH23')
    await userEvent.type(screen.getByLabelText(/^新密碼/), 'new-passphrase-1')
    await userEvent.type(screen.getByLabelText(/^再輸入一次新密碼/), 'new-passphrase-2')
    expect(screen.queryByLabelText(/^邀請碼/)).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '輸入重設代碼' }))
    expect(screen.getByRole('alert')).toHaveTextContent('不一樣')
    expect(sent.some((s) => s.path === '/api/password/reset')).toBe(false)

    await userEvent.clear(screen.getByLabelText(/^再輸入一次新密碼/))
    await userEvent.type(screen.getByLabelText(/^再輸入一次新密碼/), 'new-passphrase-1')
    await userEvent.click(screen.getByRole('button', { name: '輸入重設代碼' }))
    expect(await screen.findByRole('status')).toHaveTextContent('密碼已重設')
    expect(sent.find((s) => s.path === '/api/password/reset')!.body).toEqual({
      username: 'amy',
      code: 'ABCDE-FGH23',
      password: 'new-passphrase-1',
    })
    // Back on the sign-in form
    expect(screen.getByRole('form', { name: '登入' })).toBeInTheDocument()
  })

  it('tells someone waiting for approval why they cannot sign in yet', async () => {
    stubApi({
      '/api/login': {
        status: 403,
        body: { error: '你的申請還在等管理員核准，核准後就能登入', code: 'awaitingApproval', params: {} },
      },
    })
    page()
    await userEvent.type(screen.getByLabelText(/^帳號/), 'amy')
    await userEvent.type(screen.getByLabelText(/^密碼/), 'club-secret-1')
    await userEvent.click(screen.getByRole('button', { name: '登入' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('等管理員核准')
  })

  it('shows Turnstile when the Worker hands out a site key, sends its token and asks for a new one after a failure (e1-t33)', async () => {
    const sent = stubApi({
      '/api/register/options': { status: 200, body: { turnstileSiteKey: '0x4AAA-test' } },
      '/api/register': { status: 409, body: { error: '這個帳號已經有人使用', code: 'usernameTaken', params: {} } },
    })
    let pass: ((token: string) => void) | null = null
    const widget = { render: vi.fn(), reset: vi.fn(), remove: vi.fn() }
    widget.render.mockImplementation((_element: HTMLElement, options: { sitekey: string; language: string; callback: (token: string) => void }) => {
      pass = options.callback
      return 'w1'
    })
    vi.stubGlobal('turnstile', widget)
    page()
    await userEvent.click(screen.getByRole('button', { name: '申請加入' }))
    expect(await screen.findByRole('group', { name: '人機驗證' })).toBeInTheDocument()
    await vi.waitFor(() => expect(widget.render).toHaveBeenCalled())
    expect(widget.render.mock.calls.at(-1)![1]).toMatchObject({ sitekey: '0x4AAA-test', language: 'zh-tw' })
    await userEvent.type(screen.getByLabelText(/^帳號/), 'amy')
    await userEvent.type(screen.getByLabelText(/^密碼/), 'club-secret-1')
    // No token yet: the form says so and sends nothing
    await userEvent.click(screen.getByRole('button', { name: '申請加入' }))
    expect(screen.getByRole('alert')).toHaveTextContent('請先完成人機驗證')
    expect(sent.some((s) => s.path === '/api/register')).toBe(false)
    pass!('token-1')
    await userEvent.click(screen.getByRole('button', { name: '申請加入' }))
    await vi.waitFor(() => expect(widget.reset).toHaveBeenCalledWith('w1'))
    expect(sent.find((s) => s.path === '/api/register')!.body).toMatchObject({ username: 'amy', turnstileToken: 'token-1' })
  })

  it('shows no Turnstile when it is off', async () => {
    stubApi({ '/api/register/options': { status: 200, body: { turnstileSiteKey: null } } })
    page()
    await userEvent.click(screen.getByRole('button', { name: '申請加入' }))
    await vi.waitFor(() => expect(screen.getByLabelText(/^邀請碼/)).toBeInTheDocument())
    expect(screen.queryByRole('group', { name: '人機驗證' })).toBeNull()
  })
})
