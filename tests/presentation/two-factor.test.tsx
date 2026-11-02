import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TwoFactorCard } from '../../src/components/TwoFactorCard.tsx'
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

const admin = (twoFactor: Me['twoFactor']): Me => ({ id: 'a1', username: 'admin', admin: true, permissions: [], twoFactor })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('signing in with 兩步驟登入 (e11-t31)', () => {
  it('asks for the code after the right password and sends it with the same name and password', async () => {
    const sent = stubApi({
      '/api/login': [
        { status: 401, body: { error: '…', code: 'twoFactorNeeded', params: {} } },
        { status: 401, body: { error: '…', code: 'twoFactorWrong', params: {} } },
        { status: 200, body: { user: admin({ enabled: true, recoveryLeft: 10 }) } },
      ],
    })
    wrap(<LoginPage />)
    await userEvent.type(screen.getByLabelText(/^帳號/), 'admin')
    await userEvent.type(screen.getByLabelText(/^密碼/), 'club-secret-1')
    await userEvent.click(screen.getByRole('button', { name: '登入' }))
    const field = await screen.findByLabelText(/^驗證碼/)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText(/輸入驗證 App 上的 6 位數驗證碼/)).toBeInTheDocument()
    await userEvent.type(field, '000000')
    await userEvent.click(screen.getByRole('button', { name: '登入' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('驗證碼不正確')
    await userEvent.clear(field)
    await userEvent.type(field, '123456')
    await userEvent.click(screen.getByRole('button', { name: '登入' }))
    await vi.waitFor(() => expect(sent.filter((s) => s.path === '/api/login')).toHaveLength(3))
    const logins = sent.filter((s) => s.path === '/api/login').map((s) => s.body)
    expect(logins[0]).toEqual({ username: 'admin', password: 'club-secret-1' })
    expect(logins[2]).toEqual({ username: 'admin', password: 'club-secret-1', code: '123456', lang: 'zh' })
  })
})

describe('"My account"’s 兩步驟登入 card (e11-t31)', () => {
  it('is not there for members without it', async () => {
    const sent = stubApi({ '/api/me': { status: 200, body: { user: { id: 'm1', username: 'amy', admin: false, permissions: [] } } } })
    wrap(<TwoFactorCard />)
    await vi.waitFor(() => expect(sent.some((s) => s.path === '/api/me')).toBe(true))
    expect(screen.queryByText('兩步驟登入')).toBeNull()
  })

  it('sets up with the key, turns on with the first code and shows the recovery codes once', async () => {
    const codes = Array.from({ length: 10 }, (_, i) => `AAAA${i}-BBBBB`)
    const sent = stubApi({
      '/api/me': [
        { status: 200, body: { user: admin({ enabled: false, recoveryLeft: 0 }) } },
        { status: 200, body: { user: admin({ enabled: true, recoveryLeft: 10 }) } },
      ],
      '/api/account/2fa/setup': {
        status: 200,
        body: { secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', uri: 'otpauth://totp/x?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', expiresAt: 1 },
      },
      '/api/account/2fa/enable': { status: 200, body: { user: admin({ enabled: true, recoveryLeft: 10 }), recoveryCodes: codes } },
    })
    wrap(<TwoFactorCard />)
    expect(await screen.findByText('還沒開啟。')).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText(/^輸入密碼確認/), 'club-secret-1')
    await userEvent.click(screen.getByRole('button', { name: '開始設定' }))
    expect(await screen.findByRole('link', { name: '用驗證 App 開啟' })).toHaveAttribute('href', expect.stringMatching(/^otpauth:\/\/totp\//))
    expect(screen.getByText('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP')).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText(/^驗證碼/), '123456')
    await userEvent.click(screen.getByRole('button', { name: '開啟兩步驟登入' }))
    const list = await screen.findByRole('list', { name: '備用碼' })
    expect(list.querySelectorAll('li')).toHaveLength(10)
    expect(sent.find((s) => s.path === '/api/account/2fa/setup')!.body).toEqual({ password: 'club-secret-1' })
    expect(sent.find((s) => s.path === '/api/account/2fa/enable')!.body).toEqual({ code: '123456' })
    await userEvent.click(screen.getByRole('button', { name: '我已經存好了' }))
    expect(await screen.findByText('已開啟，還有 10 組備用碼。')).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: '備用碼' })).toBeNull()
  })

  it('turns off with the password and a code', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const sent = stubApi({
      '/api/me': [
        { status: 200, body: { user: admin({ enabled: true, recoveryLeft: 3 }) } },
        { status: 200, body: { user: admin({ enabled: false, recoveryLeft: 0 }) } },
      ],
      '/api/account/2fa/disable': { status: 200, body: { user: admin({ enabled: false, recoveryLeft: 0 }) } },
    })
    wrap(<TwoFactorCard />)
    expect(await screen.findByText('已開啟，還有 3 組備用碼。')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '關閉兩步驟登入' }))
    expect(screen.getByRole('alert')).toHaveTextContent('請先輸入密碼和驗證碼')
    await userEvent.type(screen.getByLabelText(/^輸入密碼確認/), 'club-secret-1')
    await userEvent.type(screen.getByLabelText(/^驗證碼或備用碼/), '654321')
    await userEvent.click(screen.getByRole('button', { name: '關閉兩步驟登入' }))
    expect(await screen.findByText('還沒開啟。')).toBeInTheDocument()
    expect(sent.find((s) => s.path === '/api/account/2fa/disable')!.body).toEqual({ password: 'club-secret-1', code: '654321', lang: 'zh' })
  })
})
