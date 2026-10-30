import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionInfo } from '../../shared/account.ts'
import { DataCard, SessionsCard } from '../../src/components/AccountSecurity.tsx'
import { ToastProvider } from '../../src/components/Toast.tsx'
import { LegalPage } from '../../src/pages/LegalPage.tsx'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'

/** "My account"'s signed-in devices (e11-t23) and own data (e11-t27), and the legal pages */

const mocks = vi.hoisted(() => ({
  api: { sessions: vi.fn(), endSession: vi.fn(), endOtherSessions: vi.fn(), deleteAccount: vi.fn(), exportUrl: '/api/account/export' },
  refresh: vi.fn(async () => {}),
}))

vi.mock('../../src/lib/api.ts', async (original) => ({
  ...(await original<typeof import('../../src/lib/api.ts')>()),
  api: mocks.api,
}))
const AUTH = { user: { id: 'amy', username: 'amy', admin: false, permissions: [] }, refresh: mocks.refresh }
vi.mock('../../src/state/AuthContext.tsx', () => ({ useAuth: () => AUTH }))

const NOW = Date.now()
const SESSIONS: SessionInfo[] = [
  { id: 's1', device: 'Chrome · Windows', createdAt: NOW - 86_400_000, lastSeenAt: NOW, current: true },
  { id: 's2', device: 'Safari · iPhone', createdAt: NOW - 5 * 86_400_000, lastSeenAt: NOW - 86_400_000, current: false },
  { id: 's3', device: '', createdAt: NOW - 9 * 86_400_000, lastSeenAt: NOW - 9 * 86_400_000, current: false },
]

const wrap = (node: React.ReactNode) =>
  render(
    <PreferencesProvider>
      <ToastProvider>
        <MemoryRouter>{node}</MemoryRouter>
      </ToastProvider>
    </PreferencesProvider>,
  )

beforeEach(() => {
  vi.clearAllMocks()
  mocks.api.sessions.mockResolvedValue({ sessions: SESSIONS })
})

describe('SessionsCard', () => {
  it('lists the devices, this one marked, and signs one or all the others out', async () => {
    wrap(<SessionsCard />)
    const card = await screen.findByRole('region', { name: '登入中的裝置' })
    expect(await within(card).findByText('這個裝置')).toBeInTheDocument()
    expect(within(card).getByText('不明的裝置')).toBeInTheDocument()
    // No button for this device
    expect(within(card).queryByRole('button', { name: '登出 Chrome · Windows' })).toBeNull()
    mocks.api.endSession.mockResolvedValue({ ok: true })
    await userEvent.click(within(card).getByRole('button', { name: '登出 Safari · iPhone' }))
    expect(mocks.api.endSession).toHaveBeenCalledWith('s2')
    expect(await screen.findByText('已登出那個裝置')).toBeInTheDocument()
    mocks.api.endOtherSessions.mockResolvedValue({ ended: 2 })
    mocks.api.sessions.mockResolvedValue({ sessions: [SESSIONS[0]] })
    await userEvent.click(within(card).getByRole('button', { name: '登出其他裝置' }))
    expect(await screen.findByText('已登出 2 個裝置')).toBeInTheDocument()
    expect(await within(card).findByText('沒有其他裝置登入。')).toBeInTheDocument()
    expect(within(card).getByRole('button', { name: '登出其他裝置' })).toBeDisabled()
  })
})

describe('DataCard', () => {
  it('links the download, and deletes the account only with the password and a confirmation', async () => {
    wrap(<DataCard />)
    expect(screen.getByRole('link', { name: '下載我的資料' })).toHaveAttribute('href', '/api/account/export')
    const form = screen.getByRole('form', { name: '刪除帳號' })
    await userEvent.type(within(form).getByLabelText('輸入密碼確認'), 'secret1')
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false)
    await userEvent.click(within(form).getByRole('button', { name: '刪除我的帳號' }))
    expect(mocks.api.deleteAccount).not.toHaveBeenCalled()
    confirm.mockReturnValueOnce(true)
    mocks.api.deleteAccount.mockResolvedValue({ ok: true })
    await userEvent.click(within(form).getByRole('button', { name: '刪除我的帳號' }))
    expect(mocks.api.deleteAccount).toHaveBeenCalledWith('secret1')
    expect(await screen.findByText('帳號已刪除')).toBeInTheDocument()
    expect(mocks.refresh).toHaveBeenCalled()
  })
})

describe('LegalPage', () => {
  it('shows the privacy policy with a link to the terms, and the other way round', () => {
    const { unmount } = wrap(<LegalPage kind="privacy" />)
    expect(screen.getByRole('heading', { level: 1, name: '隱私權政策' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '你的權利' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '使用條款' })).toHaveAttribute('href', '/terms')
    unmount()
    wrap(<LegalPage kind="terms" />)
    expect(screen.getByRole('heading', { level: 1, name: '使用條款' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '隱私權政策' })).toHaveAttribute('href', '/privacy')
  })
})
