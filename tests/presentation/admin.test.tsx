import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdminUser, Application, HealthStatus, LobbyView } from '../../shared/protocol.ts'
import type { FeatureView } from '../../shared/features.ts'
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
    approveReset: vi.fn(),
    declineReset: vi.fn(),
    setAdmin: vi.fn(),
    updateMembers: vi.fn(),
    deleteUser: vi.fn(),
    closeTable: vi.fn(),
    bookSync: vi.fn(),
    features: vi.fn(),
    setFeature: vi.fn(),
  },
  health: vi.fn(),
}))

vi.mock('../../src/lib/api.ts', async (original) => ({
  ...(await original<typeof import('../../src/lib/api.ts')>()),
  api: { admin: mocks.api, health: mocks.health },
}))

const LOBBY: LobbyView = { online: [], members: [], tables: [], myTableId: null, friends: [], blocked: [] }
vi.mock('../../src/state/ClubContext.tsx', () => ({ useClub: () => ({ lobby: LOBBY }) }))
// The same object every render, as AuthProvider's memo gives (a new `refresh` each time would reload forever)
const AUTH = { user: { id: 'boss', username: 'boss', admin: true, permissions: [] }, refresh: async () => {} }
vi.mock('../../src/state/AuthContext.tsx', () => ({ useAuth: () => AUTH }))

const NOW = Date.now()
const FRIENDS_FLAG: FeatureView = { flag: 'friends', default: 'off', state: 'off', custom: false, users: [] }
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
  passwordReset: null,
  ...extra,
})
const application: Application = { id: 'app1', username: 'lin', note: '資管二', site: 'book', createdAt: NOW }

const HEALTH: HealthStatus = {
  ok: true,
  now: NOW,
  tables: 3,
  online: 14,
  playing: 9,
  robots: 3,
  metrics: {
    minutes: 60,
    actions: 1200,
    actionP95Ms: 25,
    refused: 4,
    rejected: 0,
    crashes: 0,
    requests: 300,
    serverErrors: 0,
    errorRate: 0,
    connects: 40,
    reconnects: 12,
    reconnectRate: 0.3,
    boards: 22,
    peakOnline: 16,
    robot: { moves: 400, avgMs: 1.5, maxMs: 9 },
  },
  alerts: ['reconnectRate'],
}

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
  mocks.api.bookSync.mockResolvedValue({ sync: [] })
  mocks.health.mockResolvedValue(HEALTH)
  mocks.api.features.mockResolvedValue({ features: [FRIENDS_FLAG] })
})

describe('feature flags (e11-t26)', () => {
  it('opens a flag to the officers and named members, one flag at a time', async () => {
    mocks.api.setFeature.mockResolvedValue({ features: [{ ...FRIENDS_FLAG, state: 'officers', custom: true, users: [{ id: 'a1', username: 'amy' }] }] })
    page()
    const section = await screen.findByRole('region', { name: '功能旗標' })
    const state = await within(section).findByLabelText('功能旗標')
    expect(state).toHaveValue('default')
    expect(within(section).getByRole('option', { name: '照全站預設（關閉）' })).toBeInTheDocument()
    await userEvent.selectOptions(state, 'officers')
    await userEvent.type(within(section).getByLabelText('另外開給這些社員'), 'amy, ben')
    await userEvent.click(within(section).getByRole('button', { name: '儲存：好友' }))
    expect(mocks.api.setFeature).toHaveBeenCalledWith('friends', 'officers', ['amy', 'ben'])
    expect(await screen.findByText('功能旗標已儲存')).toBeInTheDocument()
  })
})

describe('AdminPage', () => {
  it('has a section nav, with the waiting applications counted', async () => {
    page()
    const nav = await screen.findByRole('navigation', { name: '管理頁的區塊' })
    const links = within(nav).getAllByRole('link')
    expect(links.map((l) => l.textContent)).toEqual(['待審核的申請1', '社團設定', '社員2', '新增社員', '牌桌0', '機器人與橋館同步', '功能旗標', '系統狀態'])
    expect(links[0]).toHaveAttribute('aria-current', 'location')
  })

  it('lists the 淡江橋館 articles edited online since the robot’s rules were checked (e5-t45)', async () => {
    const row = (slug: string, synced: boolean, extra = {}) => ({
      slug,
      nameZh: slug === 'new-minor-forcing' ? '新低花迫叫' : slug,
      checked: { version: 0, updated: '2026-10-21' },
      version: synced ? 0 : 2,
      hidden: false,
      synced,
      rules: 12,
      auctions: ['1C 1H 1N', ''],
      ...extra,
    })
    mocks.api.bookSync.mockResolvedValue({
      sync: [row('new-minor-forcing', false, { updatedBy: 'joey', updatedAt: NOW }), row('lebensohl', true)],
    })
    page()
    const section = await screen.findByRole('region', { name: '機器人與橋館同步' })
    const rows = await within(section).findAllByRole('row')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveTextContent('新低花迫叫')
    expect(rows[0]).toHaveTextContent('線上第 2 版（規則依第 0 版）')
    expect(rows[0]).toHaveTextContent('joey')
    expect(rows[0]).toHaveTextContent('12 條規則')
    const nav = screen.getByRole('navigation', { name: '管理頁的區塊' })
    expect(within(nav).getAllByRole('link').at(-3)).toHaveTextContent('機器人與橋館同步1')
  })

  it('says when every article is in step', async () => {
    mocks.api.bookSync.mockResolvedValue({ sync: [{ slug: 'lebensohl', nameZh: '雷本索特約', checked: { version: 0, updated: '' }, version: 0, hidden: false, synced: true, rules: 3, auctions: [] }] })
    page()
    expect(await screen.findByText('1 篇文章都和機器人的規則同步。')).toBeInTheDocument()
  })

  it('opens read-only: values as text, no inputs or checkboxes that save on their own', async () => {
    mocks.api.users.mockResolvedValue({
      users: [user('boss', { admin: true }), user('amy', { permissions: ['bookEdit'] }), user('ben')],
    })
    page()
    const settings = await screen.findByRole('region', { name: '社團設定' })
    expect(within(settings).queryByRole('textbox')).not.toBeInTheDocument()
    expect(within(settings).queryByRole('spinbutton')).not.toBeInTheDocument()
    expect(within(settings).getByLabelText('帳號上限')).toHaveTextContent('60')
    expect(within(settings).getByLabelText('邀請碼')).toHaveTextContent('tku')
    expect(within(settings).queryByRole('button', { name: '儲存' })).not.toBeInTheDocument()

    const members = screen.getByRole('region', { name: '社員' })
    expect(within(members).queryByRole('checkbox')).not.toBeInTheDocument()
    expect(within(members).queryByRole('combobox')).not.toBeInTheDocument()
    const rows = within(members).getAllByRole('row')
    expect(rows[2]).toHaveTextContent('線上編輯')
    expect(rows[3]).toHaveTextContent('無')
    // Destructive actions stay in read mode; approving stays one click
    expect(within(members).getAllByRole('button', { name: '重設密碼' })).toHaveLength(3)
    mocks.api.approve.mockResolvedValue({})
    await userEvent.click(screen.getByRole('button', { name: '核准' }))
    expect(mocks.api.approve).toHaveBeenCalledWith('app1')
  })

  it('edits the settings: nothing is sent until 儲存, which sends one request and reads them again', async () => {
    mocks.api.saveSettings.mockResolvedValue({ settings: { maxUsers: 80, inviteCode: 'tku2' } })
    page()
    await userEvent.click(await screen.findByRole('button', { name: '編輯社團設定' }))
    const settings = screen.getByRole('region', { name: '社團設定' })
    const cap = within(settings).getByLabelText('帳號上限')
    await userEvent.clear(cap)
    await userEvent.type(cap, '80')
    await userEvent.type(within(settings).getByLabelText('邀請碼'), '2')
    expect(within(settings).getByText('有尚未儲存的變更')).toBeInTheDocument()
    expect(mocks.api.saveSettings).not.toHaveBeenCalled()

    mocks.api.settings.mockResolvedValue({ settings: { maxUsers: 80, inviteCode: 'tku2' } })
    const reads = mocks.api.settings.mock.calls.length
    await userEvent.click(within(settings).getByRole('button', { name: '儲存' }))
    expect(mocks.api.saveSettings).toHaveBeenCalledTimes(1)
    expect(mocks.api.saveSettings).toHaveBeenCalledWith({ maxUsers: 80, inviteCode: 'tku2' })
    expect(await screen.findByRole('status')).toHaveTextContent('已儲存')
    // Back to read-only, showing what the server now has
    expect(mocks.api.settings.mock.calls.length).toBeGreaterThan(reads)
    expect(await within(settings).findByLabelText('邀請碼')).toHaveTextContent('tku2')
    expect(within(settings).queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('cancel discards the settings draft', async () => {
    page()
    await userEvent.click(await screen.findByRole('button', { name: '編輯社團設定' }))
    const settings = screen.getByRole('region', { name: '社團設定' })
    await userEvent.type(within(settings).getByLabelText('邀請碼'), 'xyz')
    await userEvent.click(within(settings).getByRole('button', { name: '取消' }))
    expect(within(settings).getByLabelText('邀請碼')).toHaveTextContent(/^tku$/)
    expect(mocks.api.saveSettings).not.toHaveBeenCalled()
    // Editing again starts from the server's values
    await userEvent.click(screen.getByRole('button', { name: '編輯社團設定' }))
    expect(within(settings).getByLabelText('邀請碼')).toHaveValue('tku')
  })

  it('shows an error the server ties to a field under that field, and stays editing', async () => {
    const { ApiError } = await import('../../src/lib/api.ts')
    mocks.api.saveSettings.mockRejectedValue(new ApiError('bad', 400, 'badCap', { min: 2, max: 100 }))
    page()
    await userEvent.click(await screen.findByRole('button', { name: '編輯社團設定' }))
    const cap = screen.getByLabelText('帳號上限')
    await userEvent.clear(cap)
    await userEvent.type(cap, '50')
    await userEvent.click(screen.getByRole('button', { name: '儲存' }))
    const error = await screen.findByRole('alert')
    expect(cap).toHaveAttribute('aria-invalid', 'true')
    expect(cap).toHaveAttribute('aria-describedby', error.id)
    expect(cap).toHaveValue(50)
  })

  it('edits roles and permissions, then saves every change in one request', async () => {
    mocks.api.users.mockResolvedValue({
      users: [user('boss', { admin: true }), user('amy'), user('ben', { permissions: ['bookEdit'] }), user('cat')],
    })
    mocks.api.updateMembers.mockResolvedValue({ ok: true })
    page()
    await userEvent.click(await screen.findByRole('button', { name: '編輯社員' }))
    const members = screen.getByRole('region', { name: '社員' })
    // Nobody takes away their own admin role
    expect(within(members).getByRole('combobox', { name: 'boss 的身分' })).toBeDisabled()
    await userEvent.click(within(members).getByRole('checkbox', { name: 'amy：線上編輯' }))
    await userEvent.click(within(members).getByRole('checkbox', { name: 'amy：匯入檔案' }))
    await userEvent.click(within(members).getByRole('checkbox', { name: 'ben：線上編輯' }))
    await userEvent.selectOptions(within(members).getByRole('combobox', { name: 'cat 的身分' }), '管理員')
    expect(within(members).getAllByText('已修改')).toHaveLength(3)
    expect(within(members).getByText('有尚未儲存的變更')).toBeInTheDocument()
    expect(mocks.api.setPermissions).not.toHaveBeenCalled()
    expect(mocks.api.setAdmin).not.toHaveBeenCalled()

    await userEvent.click(within(members).getByRole('button', { name: '儲存' }))
    expect(mocks.api.updateMembers).toHaveBeenCalledTimes(1)
    expect(mocks.api.updateMembers).toHaveBeenCalledWith([
      { id: 'amy', permissions: ['bookEdit', 'bookImport'] },
      { id: 'ben', permissions: [] },
      { id: 'cat', admin: true },
    ])
    expect(await screen.findByRole('status')).toHaveTextContent('已儲存')
    expect(within(members).queryByRole('checkbox')).not.toBeInTheDocument()
  })

  it('approves a forgotten password: the one-time code is shown once, to hand over (e1-t36)', async () => {
    mocks.api.users.mockResolvedValue({
      users: [user('boss', { admin: true }), user('amy', { passwordReset: { state: 'requested', at: NOW } })],
    })
    mocks.api.approveReset.mockResolvedValue({ code: 'ABCDE-FGH23', expiresAt: NOW + 3 * 86_400_000 })
    page()
    const members = await screen.findByRole('region', { name: '社員' })
    expect(await within(members).findByText(/申請重設密碼/)).toBeInTheDocument()
    expect(within(members).getByRole('button', { name: '拒絕重設' })).toBeInTheDocument()
    await userEvent.click(within(members).getByRole('button', { name: '核准重設' }))
    expect(mocks.api.approveReset).toHaveBeenCalledWith('amy')
    const shown = await within(members).findByRole('status')
    expect(shown).toHaveTextContent('交給 amy')
    expect(shown).toHaveTextContent('ABCDE-FGH23')
    await userEvent.click(within(shown).getByRole('button', { name: '關閉' }))
    expect(within(members).queryByText('ABCDE-FGH23')).not.toBeInTheDocument()
  })

  it('cancel discards member edits; undoing a change leaves nothing to save', async () => {
    page()
    await userEvent.click(await screen.findByRole('button', { name: '編輯社員' }))
    const members = screen.getByRole('region', { name: '社員' })
    const box = within(members).getByRole('checkbox', { name: 'amy：線上編輯' })
    await userEvent.click(box)
    await userEvent.click(box)
    expect(within(members).queryByText('有尚未儲存的變更')).not.toBeInTheDocument()
    await userEvent.click(box)
    await userEvent.click(within(members).getByRole('button', { name: '取消' }))
    expect(within(members).queryByRole('checkbox')).not.toBeInTheDocument()
    expect(within(members).getAllByRole('row')[2]).toHaveTextContent('無')
    expect(mocks.api.updateMembers).not.toHaveBeenCalled()
  })

  it('asks before leaving the page with unsaved edits', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    page()
    const away = document.createElement('a')
    away.href = '/history'
    document.body.append(away)
    away.addEventListener('click', (e) => e.preventDefault())
    await userEvent.click(await screen.findByRole('button', { name: '編輯社團設定' }))
    away.click()
    expect(confirm).not.toHaveBeenCalled()
    await userEvent.type(screen.getByLabelText('邀請碼'), 'x')
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
    away.dispatchEvent(click)
    expect(confirm).toHaveBeenCalledWith('管理頁有尚未儲存的變更，確定要離開嗎？')
    expect(click.defaultPrevented).toBe(true)
    away.remove()
    confirm.mockRestore()
  })

  it('puts delete in the row menu, and deleting asks first', async () => {
    mocks.api.deleteUser.mockResolvedValue({ ok: true })
    page()
    // My own row has no menu actions
    expect(await screen.findByRole('button', { name: 'boss 的其他操作' })).toBeDisabled()
    expect(screen.getAllByRole('button', { name: '重設密碼' })).toHaveLength(2)

    await userEvent.click(screen.getByRole('button', { name: 'amy 的其他操作' }))
    const menu = screen.getByRole('menu', { name: 'amy 的其他操作' })
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['刪除社員…'])
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

describe('system status (e11-t22)', () => {
  it('shows the health check’s numbers and what they warn about', async () => {
    page()
    const section = await screen.findByRole('region', { name: '系統狀態' })
    expect(await within(section).findByText('重連偏多（超過 20%）：連線不穩或伺服器重啟')).toBeInTheDocument()
    expect(within(section).getByText('30.0%')).toBeInTheDocument()
    expect(within(section).getByText('1.5 ms / 9 ms')).toBeInTheDocument()
    expect(within(section).getByText('最近 60 分鐘')).toBeInTheDocument()
  })

  it('says so when the health check cannot be read', async () => {
    mocks.health.mockRejectedValue(new Error('down'))
    page()
    expect(await screen.findByText('讀不到系統狀態')).toBeInTheDocument()
  })
})
