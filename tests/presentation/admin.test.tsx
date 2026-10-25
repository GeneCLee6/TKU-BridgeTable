import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdminUser, Application, LobbyView } from '../../shared/protocol.ts'
import { ToastProvider } from '../../src/components/Toast.tsx'
import { formatRelative } from '../../src/lib/format.ts'
import { AdminPage } from '../../src/pages/AdminPage.tsx'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'

/** The admin page (D3, e3-t41): section nav, one card per section, toasts, field errors, row menus */

const mocks = vi.hoisted(() => ({
  api: {
    users: vi.fn(),
    applications: vi.fn(),
    settings: vi.fn(),
    saveSettings: vi.fn(),
    approve: vi.fn(),
    reject: vi.fn(),
    setPermissions: vi.fn(),
    createUser: vi.fn(),
    resetPassword: vi.fn(),
    setAdmin: vi.fn(),
    deleteUser: vi.fn(),
    closeTable: vi.fn(),
  },
}))

vi.mock('../../src/lib/api.ts', async (original) => ({
  ...(await original<typeof import('../../src/lib/api.ts')>()),
  api: { admin: mocks.api },
}))

const LOBBY: LobbyView = { online: [], members: [], tables: [], myTableId: null, friends: [], blocked: [] }
vi.mock('../../src/state/ClubContext.tsx', () => ({ useClub: () => ({ lobby: LOBBY }) }))
// The same object every render, as AuthProvider's memo gives (a new `refresh` each time would reload forever)
const AUTH = { user: { id: 'boss', username: 'boss', admin: true, permissions: [] }, refresh: async () => {} }
vi.mock('../../src/state/AuthContext.tsx', () => ({ useAuth: () => AUTH }))

const NOW = Date.now()
const user = (id: string, extra: Partial<AdminUser> = {}): AdminUser => ({
  id,
  username: id,
  admin: false,
  createdAt: NOW - 30 * 86_400_000,
  lastLoginAt: NOW,
  boards: 12,
  online: false,
  permissions: [],
  passwordResetAt: null,
  ...extra,
})
const application: Application = { id: 'app1', username: 'lin', note: '資管二', site: 'book', createdAt: NOW }

const page = () =>
  render(
    <PreferencesProvider>
      <ToastProvider>
        <AdminPage />
      </ToastProvider>
    </PreferencesProvider>,
  )

beforeEach(() => {
  for (const fn of Object.values(mocks.api)) fn.mockReset()
  mocks.api.users.mockResolvedValue({ users: [user('boss', { admin: true, boards: 412 }), user('amy')] })
  mocks.api.applications.mockResolvedValue({ applications: [application] })
  mocks.api.settings.mockResolvedValue({ settings: { maxUsers: 60, inviteCode: 'tku' } })
})

describe('AdminPage', () => {
  it('has a section nav, with the waiting applications counted', async () => {
    page()
    const nav = await screen.findByRole('navigation', { name: '管理頁的區塊' })
    const links = within(nav).getAllByRole('link')
    expect(links.map((l) => l.textContent)).toEqual(['待審核的申請1', '社團設定', '社員2', '新增社員', '牌桌0'])
    expect(links[0]).toHaveAttribute('aria-current', 'location')
  })

  it('saves the settings with a toast, and reverts a draft', async () => {
    mocks.api.saveSettings.mockResolvedValue({ settings: { maxUsers: 80, inviteCode: 'tku' } })
    page()
    const code = await screen.findByLabelText('邀請碼')
    expect(screen.getByRole('button', { name: '還原' })).toBeDisabled()
    await userEvent.type(code, 'x')
    await userEvent.click(screen.getByRole('button', { name: '還原' }))
    expect(code).toHaveValue('tku')

    const cap = screen.getByLabelText('帳號上限')
    await userEvent.clear(cap)
    await userEvent.type(cap, '80')
    await userEvent.click(screen.getByRole('button', { name: '儲存' }))
    expect(mocks.api.saveSettings).toHaveBeenCalledWith({ maxUsers: 80, inviteCode: 'tku' })
    expect(await screen.findByRole('status')).toHaveTextContent('已儲存')
  })

  it('shows an error the server ties to a field under that field', async () => {
    const { ApiError } = await import('../../src/lib/api.ts')
    mocks.api.saveSettings.mockRejectedValue(new ApiError('bad', 400, 'badCap', { min: 2, max: 100 }))
    page()
    const cap = await screen.findByLabelText('帳號上限')
    await userEvent.clear(cap)
    await userEvent.type(cap, '50')
    await userEvent.click(screen.getByRole('button', { name: '儲存' }))
    const error = await screen.findByRole('alert')
    expect(cap).toHaveAttribute('aria-invalid', 'true')
    expect(cap).toHaveAttribute('aria-describedby', error.id)
  })

  it('puts make-admin and delete in the row menu; deleting asks first', async () => {
    mocks.api.deleteUser.mockResolvedValue({ ok: true })
    page()
    // My own row has no menu actions
    expect(await screen.findByRole('button', { name: 'boss 的其他操作' })).toBeDisabled()
    expect(screen.getAllByRole('button', { name: '重設密碼' })).toHaveLength(2)

    await userEvent.click(screen.getByRole('button', { name: 'amy 的其他操作' }))
    const menu = screen.getByRole('menu', { name: 'amy 的其他操作' })
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['設為管理員', '刪除社員…'])
    await userEvent.click(within(menu).getByRole('menuitem', { name: '刪除社員…' }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(mocks.api.deleteUser).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: '確定' }))
    expect(mocks.api.deleteUser).toHaveBeenCalledWith('amy')
  })

  it('shows times relative to today and the board counts', async () => {
    page()
    const members = await screen.findByRole('table', { name: '社員' })
    expect(within(members).getAllByText(/^今天 \d\d:\d\d$/)).toHaveLength(2)
    expect(within(members).getByText('412')).toHaveClass('num')
  })
})

describe('formatRelative', () => {
  const words = { today: '今天', yesterday: '昨天' }
  const now = new Date(2026, 9, 25, 15, 0).getTime()
  it('says today, yesterday, a date this year, or a full date', () => {
    expect(formatRelative(new Date(2026, 9, 25, 8, 12).getTime(), 'zh', words, now)).toBe('今天 08:12')
    expect(formatRelative(new Date(2026, 9, 24, 22, 31).getTime(), 'zh', words, now)).toBe('昨天 22:31')
    expect(formatRelative(new Date(2026, 9, 23, 22, 31).getTime(), 'zh', words, now)).toBe('10/23 22:31')
    expect(formatRelative(new Date(2025, 11, 30, 9, 0).getTime(), 'zh', words, now)).toBe('2025/12/30')
  })
})
