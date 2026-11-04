import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PlatformView } from '../../shared/platform.ts'
import { ClubApplyPage } from '../../src/pages/ClubApplyPage.tsx'
import { formatBytes } from '../../src/lib/format.ts'
import { PlatformPage } from '../../src/pages/PlatformPage.tsx'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'

/** Answers the API calls the page makes; records what was sent */
function stubApi(routes: Record<string, { status: number; body: unknown } | (() => { status: number; body: unknown })>) {
  const sent: { path: string; body: unknown }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      sent.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      const found = routes[path]
      const route = (typeof found === 'function' ? found() : found) ?? { status: 404, body: { error: '找不到', code: 'noSuchApi', params: {} } }
      return new Response(JSON.stringify(route.body), { status: route.status })
    }),
  )
  return sent
}

const wrap = (children: ReactNode) => render(<PreferencesProvider>{children}</PreferencesProvider>)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('申請開設社團 (e12-t06)', () => {
  it('says applications are closed when the platform has no owner', async () => {
    stubApi({ '/api/clubs/apply': { status: 200, body: { open: false, turnstileSiteKey: null } } })
    wrap(<ClubApplyPage />)
    expect(await screen.findByRole('status')).toHaveTextContent('目前不開放申請新社團')
    expect(screen.queryByRole('button', { name: '送出申請' })).toBeNull()
  })

  it('sends the application with the admin account, and says what happens next', async () => {
    const sent = stubApi({ '/api/clubs/apply': () => ({ status: 202, body: { id: 'a1', clubId: 'ntu' } }) })
    // The options and the send share a path: the first answer is the options
    vi.mocked(fetch).mockImplementationOnce(async () => new Response(JSON.stringify({ open: true, turnstileSiteKey: null })))
    wrap(<ClubApplyPage />)
    await userEvent.type(await screen.findByLabelText(/^社團代號/), 'ntu')
    await userEvent.type(screen.getByLabelText(/^社團名稱/), '臺大橋藝社')
    await userEvent.type(screen.getByLabelText(/^學校或單位/), '國立臺灣大學')
    await userEvent.type(screen.getByLabelText(/^聯絡 Email/), 'officer@example.org')
    await userEvent.type(screen.getByLabelText(/^申請理由/), '我們每週練習，想要自己的牌桌。')
    const account = screen.getByRole('group', { name: '新社團的管理員帳號' })
    await userEvent.type(within(account).getByLabelText(/^帳號/), 'ntuhead')
    await userEvent.type(within(account).getByLabelText(/^密碼/), 'river-bridge-77')
    await userEvent.click(screen.getByRole('button', { name: '送出申請' }))
    expect(await screen.findByRole('status')).toHaveTextContent('已送出「ntu」的申請')
    expect(sent.at(-1)).toEqual({
      path: '/api/clubs/apply',
      body: {
        clubId: 'ntu',
        name: '臺大橋藝社',
        organisation: '國立臺灣大學',
        contactEmail: 'officer@example.org',
        reason: '我們每週練習，想要自己的牌桌。',
        username: 'ntuhead',
        password: 'river-bridge-77',
        lang: 'zh',
      },
    })
  })

  it('stops a reserved id before sending, and shows a taken one at the field', async () => {
    const sent = stubApi({
      '/api/clubs/apply': () => ({ status: 409, body: { error: '已被使用', code: 'clubIdTaken', params: {} } }),
    })
    vi.mocked(fetch).mockImplementationOnce(async () => new Response(JSON.stringify({ open: true, turnstileSiteKey: null })))
    wrap(<ClubApplyPage />)
    const field = await screen.findByLabelText(/^社團代號/)
    await userEvent.type(field, 'platform')
    await userEvent.click(screen.getByRole('button', { name: '送出申請' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('保留給平台使用')
    // Nothing was sent (the options came from the one-off answer above)
    expect(sent).toHaveLength(0)
    await userEvent.clear(field)
    await userEvent.type(field, 'ntu')
    await userEvent.click(screen.getByRole('button', { name: '送出申請' }))
    expect(await screen.findByText(/已經有人用了或正在申請/)).toBeInTheDocument()
    expect(field).toHaveAttribute('aria-invalid', 'true')
  })
})

const VIEW: PlatformView = {
  clubs: [
    {
      id: 'tku',
      name: '淡江橋藝社',
      status: 'active',
      organisation: '淡江大學',
      contactEmail: '',
      usage: { members: 40, admins: [{ id: 'g', username: 'gene' }], tables: 2, boards: 900, storageBytes: 5 * 1024 ** 2, filesBytes: 2048, backupBytes: 10_240, historyRows: 900 },
    },
    {
      id: 'ntu',
      name: '臺大橋藝社',
      status: 'active',
      organisation: '國立臺灣大學',
      contactEmail: 'officer@example.org',
      approvedAt: 1,
      usage: { members: 1, admins: [{ id: 'h', username: 'ntuhead' }], tables: 0, boards: 0, storageBytes: 1024, filesBytes: 0, backupBytes: null, historyRows: null },
    },
  ],
  applications: [
    {
      id: 'a2',
      clubId: 'nccu',
      name: '政大橋藝社',
      organisation: '國立政治大學',
      contactEmail: 'b@example.org',
      reason: '想要開社團牌桌',
      username: 'nccuhead',
      createdAt: Date.UTC(2026, 10, 4),
      status: 'pending',
    },
  ],
  totals: { members: 41, filesBytes: 2048, backupBytes: 10_240, historyRows: 900, storageBytes: 5 * 1024 ** 2 + 1024 },
}

describe('平台後台 (e12-t05)', () => {
  it('lists the clubs with their usage and admins, and the applications', async () => {
    stubApi({ '/api/platform': { status: 200, body: VIEW } })
    wrap(<PlatformPage />)
    const clubs = await screen.findByRole('table', { name: '社團' })
    expect(within(clubs).getByText('臺大橋藝社')).toBeInTheDocument()
    expect(within(clubs).getByText('ntuhead')).toBeInTheDocument()
    expect(within(clubs).getByText(/社員 40 · 開桌 2 · 牌局 900/)).toBeInTheDocument()
    // 淡江 cannot be suspended: no button in its row
    expect(within(clubs).getAllByRole('button', { name: '暫停' })).toHaveLength(1)
    expect(screen.getByRole('heading', { name: /政大橋藝社/ })).toBeInTheDocument()
    expect(screen.getByText('管理員帳號 nccuhead · b@example.org')).toBeInTheDocument()
  })

  it('approves an application and shows the view the server answers', async () => {
    const after: PlatformView = {
      ...VIEW,
      applications: [{ ...VIEW.applications[0], status: 'approved', decidedAt: 2 }],
    }
    const sent = stubApi({
      '/api/platform': { status: 200, body: VIEW },
      '/api/platform/applications/a2/approve': { status: 200, body: after },
    })
    wrap(<PlatformPage />)
    await userEvent.click(await screen.findByRole('button', { name: '核准並開通' }))
    expect(await screen.findByText('已核准')).toBeInTheDocument()
    expect(sent.at(-1)?.path).toBe('/api/platform/applications/a2/approve')
    expect(screen.queryByRole('button', { name: '核准並開通' })).toBeNull()
  })

  it('rejects with a reason, and suspends a club after asking', async () => {
    const sent = stubApi({
      '/api/platform': { status: 200, body: VIEW },
      '/api/platform/applications/a2/reject': { status: 200, body: { ...VIEW, applications: [] } },
      '/api/platform/clubs/ntu/status': {
        status: 200,
        body: { ...VIEW, clubs: [VIEW.clubs[0], { ...VIEW.clubs[1], status: 'suspended' }] },
      },
    })
    wrap(<PlatformPage />)
    await userEvent.click(await screen.findByRole('button', { name: '退回' }))
    await userEvent.type(screen.getByLabelText('退回原因（會寄給申請人）'), '資料不完整')
    await userEvent.click(screen.getByRole('button', { name: '確定退回' }))
    expect(await screen.findByText('沒有社團申請。')).toBeInTheDocument()
    expect(sent.at(-1)).toEqual({ path: '/api/platform/applications/a2/reject', body: { note: '資料不完整' } })

    await userEvent.click(screen.getByRole('button', { name: '暫停' }))
    expect(screen.getByText(/確定要暫停「臺大橋藝社」嗎/)).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('原因（選填，記在稽核紀錄）'), '未繳費')
    await userEvent.click(screen.getByRole('button', { name: '暫停' }))
    expect(await screen.findByText('已暫停')).toBeInTheDocument()
    expect(sent.at(-1)).toEqual({ path: '/api/platform/clubs/ntu/status', body: { status: 'suspended', note: '未繳費' } })
    expect(screen.getByRole('button', { name: '恢復使用' })).toBeInTheDocument()
  })

  it('shows the server’s refusal, e.g. for an owner without two-step sign-in', async () => {
    stubApi({ '/api/platform': { status: 403, body: { error: 'x', code: 'platformNeedsTwoFactor', params: {} } } })
    wrap(<PlatformPage />)
    expect(await screen.findByRole('alert')).toHaveTextContent('兩步驟登入')
  })

  it('writes sizes as people read them', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(5 * 1024 ** 2)).toBe('5.0 MB')
    expect(formatBytes(300 * 1024 ** 3)).toBe('300 GB')
  })
})
