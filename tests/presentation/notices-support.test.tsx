import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LANGS } from '../../shared/messages.ts'
import type { NoticesView } from '../../shared/notices.ts'
import type { PlatformView } from '../../shared/platform.ts'
import { notificationLink } from '../../shared/notification-link.ts'
import { SUPPORT_CATEGORIES, SUPPORT_REPORTS_ANCHOR, type AdminSupportReport, type AdminSupportView, type MySupportReport } from '../../shared/support.ts'
import { AdminBanner, AdminSupport } from '../../src/components/AdminSupport.tsx'
import { NoticeBanners } from '../../src/components/NoticeBanners.tsx'
import { PlatformNotices, PlatformSupport } from '../../src/components/PlatformNotices.tsx'
import { SupportCard, SupportDialog } from '../../src/components/SupportDialog.tsx'
import { ToastProvider } from '../../src/components/Toast.tsx'
import { notificationText } from '../../src/lib/notifications.ts'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'
import { STRINGS } from '../../src/strings.ts'

/** Announcements (e12-t15) and the support form (e12-t16) on the pages */

type Answer = { status: number; body: unknown }

function stubApi(routes: Record<string, Answer | (() => Answer)>) {
  const sent: { path: string; method: string; body: unknown }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      sent.push({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined })
      const found = routes[path]
      const route = (typeof found === 'function' ? found() : found) ?? { status: 404, body: { error: '找不到', code: 'noSuchApi', params: {} } }
      return new Response(JSON.stringify(route.body), { status: route.status })
    }),
  )
  return sent
}

const wrap = (children: ReactNode, path = '/') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <PreferencesProvider>
        <ToastProvider>{children}</ToastProvider>
      </PreferencesProvider>
    </MemoryRouter>,
  )

const ok = (body: unknown): Answer => ({ status: 200, body })

beforeEach(() => {
  localStorage.removeItem('tbt_notices_dismissed')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the banners on top of a member’s pages (e12-t15)', () => {
  const view: NoticesView = {
    platform: [{ id: 'n1', text: '週六停機維護', publishedAt: 5 }],
    club: { id: 'b1', text: '社課改到週四', setAt: 7 },
  }

  it('shows the platform’s and the club’s, each dismissed on its own and remembered', async () => {
    stubApi({ '/api/notices': ok(view) })
    const { unmount } = wrap(<NoticeBanners />)
    expect(await screen.findByText('週六停機維護')).toBeInTheDocument()
    expect(screen.getByText('社課改到週四')).toBeInTheDocument()
    expect(screen.getByText('平台公告')).toBeInTheDocument()
    expect(screen.getByText('社團公告')).toBeInTheDocument()
    await userEvent.click(screen.getAllByRole('button', { name: '關閉這則公告' })[0])
    expect(screen.queryByText('週六停機維護')).toBeNull()
    expect(screen.getByText('社課改到週四')).toBeInTheDocument()
    unmount()
    wrap(<NoticeBanners />)
    expect(await screen.findByText('社課改到週四')).toBeInTheDocument()
    expect(screen.queryByText('週六停機維護')).toBeNull()
  })

  it('shows a notice published again, or a new banner, to whoever dismissed the old one', async () => {
    localStorage.setItem('tbt_notices_dismissed', JSON.stringify(['p:n1:1', 'c:old']))
    stubApi({ '/api/notices': ok(view) })
    wrap(<NoticeBanners />)
    expect(await screen.findByText('週六停機維護')).toBeInTheDocument()
    expect(screen.getByText('社課改到週四')).toBeInTheDocument()
  })

  it('stays out of the way at a table, where a banner would push the cards down', async () => {
    const sent = stubApi({ '/api/notices': ok(view) })
    wrap(<NoticeBanners />, '/table/abc')
    await waitFor(() => expect(sent).toHaveLength(1))
    await act(async () => {})
    expect(screen.queryByText('週六停機維護')).toBeNull()
  })

  it('shows nothing and says nothing when they cannot be read', async () => {
    const sent = stubApi({ '/api/notices': { status: 401, body: { error: '', code: 'signInFirst', params: {} } } })
    const { container } = wrap(<NoticeBanners />)
    await waitFor(() => expect(sent).toHaveLength(1))
    await act(async () => {})
    expect(container.querySelector('section')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('survives an answer of the wrong shape: a banner must never blank the page', async () => {
    for (const body of [{}, { platform: 'nope' }, { platform: null, club: null }, null]) {
      const sent = stubApi({ '/api/notices': ok(body) })
      const { container, unmount } = wrap(
        <>
          <NoticeBanners />
          <p>頁面還在</p>
        </>,
      )
      await waitFor(() => expect(sent).toHaveLength(1))
      await act(async () => {})
      expect(screen.getByText('頁面還在')).toBeInTheDocument()
      expect(container.querySelector('section')).toBeNull()
      unmount()
    }
  })

  it('still shows the club’s banner when the platform’s part is missing', async () => {
    stubApi({ '/api/notices': ok({ club: { id: 'b1', text: '社課改到週四', setAt: 7 } }) })
    wrap(<NoticeBanners />)
    expect(await screen.findByText('社課改到週四')).toBeInTheDocument()
  })

  it('reads again when the tab comes back after a while, not on every return', async () => {
    const sent = stubApi({ '/api/notices': ok(view) })
    const clock = vi.spyOn(Date, 'now')
    clock.mockReturnValue(1_000)
    wrap(<NoticeBanners />)
    await screen.findByText('週六停機維護')
    clock.mockReturnValue(2_000)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(sent).toHaveLength(1)
    clock.mockReturnValue(1_000 + 10 * 60_000)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(sent).toHaveLength(2)
    clock.mockRestore()
    await act(async () => {})
  })
})

describe('回報問題 (e12-t16)', () => {
  it('sends the category, the text, the version and the table it was opened from, and says so', async () => {
    const sent = stubApi({ '/api/support': { status: 202, body: { id: 'r1' } } })
    const onClose = vi.fn()
    wrap(<SupportDialog tableId="t7" onClose={onClose} />)
    expect(screen.getByText(/瀏覽器、程式版本、社團、這一桌（t7）/)).toBeInTheDocument()
    await userEvent.selectOptions(screen.getByLabelText('類別'), 'game')
    await userEvent.type(screen.getByLabelText('發生了什麼事'), '明手的牌沒有亮出來')
    await userEvent.click(screen.getByRole('button', { name: '送出' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(sent[0]).toEqual({
      path: '/api/support',
      method: 'POST',
      body: { category: 'game', text: '明手的牌沒有亮出來', version: 'unknown', tableId: 't7' },
    })
    expect(JSON.stringify(sent[0].body)).not.toContain('boardId')
  })

  it('attaches the board from a record', async () => {
    const sent = stubApi({ '/api/support': { status: 202, body: { id: 'r1' } } })
    wrap(<SupportDialog boardId="b9" onClose={() => {}} />)
    expect(screen.getByText(/這副牌（b9）/)).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('發生了什麼事'), '分數算錯了');
    await userEvent.click(screen.getByRole('button', { name: '送出' }))
    await waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0].body).toMatchObject({ category: 'bug', boardId: 'b9' })
  })

  it('attaches neither from the account page', async () => {
    const sent = stubApi({ '/api/support': { status: 202, body: { id: 'r1' } }, '/api/support/mine': ok({ reports: [] }) })
    wrap(<SupportCard />)
    await userEvent.click(screen.getByRole('button', { name: '回報問題' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('會一起送出：瀏覽器、程式版本、社團。')).toBeInTheDocument()
    await userEvent.type(within(dialog).getByLabelText('發生了什麼事'), '收不到推播通知')
    await userEvent.click(within(dialog).getByRole('button', { name: '送出' }))
    const posted = () => sent.filter((s) => s.method === 'POST')
    await waitFor(() => expect(posted()).toHaveLength(1))
    expect(posted()[0].body).toEqual({ category: 'bug', text: '收不到推播通知', version: 'unknown' })
  })

  it('says an imported board stays private instead of naming its id, and still sends it', async () => {
    const sent = stubApi({ '/api/support': { status: 202, body: { id: 'r1' } } })
    wrap(<SupportDialog boardId="imp-0123456789abcdef" onClose={() => {}} />)
    expect(screen.getByText(STRINGS.zh.support.attachedImported)).toBeInTheDocument()
    expect(screen.queryByText(/imp-0123/)).toBeNull()
    await userEvent.type(screen.getByLabelText('發生了什麼事'), '這副的分數不對')
    await userEvent.click(screen.getByRole('button', { name: '送出' }))
    await waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0].body).toMatchObject({ boardId: 'imp-0123456789abcdef' })
  })
})

describe('我的回報 on 我的帳號', () => {
  const REPORTS: MySupportReport[] = [
    { id: 'r2', category: 'game', text: '分數算錯了', createdAt: 5, status: 'resolved', resolvedAt: 6 },
    { id: 'r1', category: 'bug', text: '叫牌框打不開', createdAt: 1, status: 'open' },
  ]

  it('lists the member’s own reports and how they stand', async () => {
    stubApi({ '/api/support/mine': ok({ reports: REPORTS }) })
    wrap(<SupportCard />)
    const list = await screen.findByRole('region', { name: '我的回報' })
    const [resolved, open] = within(list).getAllByRole('listitem')
    expect(within(resolved).getByText('分數算錯了')).toBeInTheDocument()
    expect(within(resolved).getByText('已解決')).toBeInTheDocument()
    expect(within(resolved).getByText(/^處理完成：/)).toBeInTheDocument()
    expect(within(open).getByText('待處理')).toBeInTheDocument()
    expect(within(open).queryByText(/^處理完成：/)).toBeNull()
  })

  it('says when there are none, and shows a report just sent', async () => {
    const reports: MySupportReport[] = []
    stubApi({ '/api/support/mine': () => ok({ reports }), '/api/support': () => {
      reports.push(REPORTS[1])
      return { status: 202, body: { id: 'r1' } }
    } })
    wrap(<SupportCard />)
    expect(await screen.findByText('你還沒有送出過回報。')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '回報問題' }))
    await userEvent.type(screen.getByLabelText('發生了什麼事'), '叫牌框打不開')
    await userEvent.click(screen.getByRole('button', { name: '送出' }))
    expect(await screen.findByText('待處理')).toBeInTheDocument()
  })

  it('keeps the card working when the list cannot be read', async () => {
    stubApi({ '/api/support/mine': { status: 500, body: { error: 'x', code: 'internal', params: {} } } })
    wrap(<SupportCard />)
    expect(await screen.findByRole('button', { name: '回報問題' })).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('region', { name: '我的回報' })).toBeNull())
  })

  it('opens at the list from the notification’s link', async () => {
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    stubApi({ '/api/support/mine': ok({ reports: REPORTS }) })
    wrap(<SupportCard />, `/account#${SUPPORT_REPORTS_ANCHOR}`)
    await waitFor(() => expect(scroll).toHaveBeenCalled())
    expect(notificationLink({ id: 'n', at: 0, kind: 'supportResolved', params: {}, read: false })).toBe(`/account#${SUPPORT_REPORTS_ANCHOR}`)
  })

  it('stays open and says why when the server refuses', async () => {
    stubApi({ '/api/support': { status: 429, body: { error: 'x', code: 'tooManySupportReports', params: {} } } })
    const onClose = vi.fn()
    wrap(<SupportDialog onClose={onClose} />)
    await userEvent.type(screen.getByLabelText('發生了什麼事'), '又壞了又壞了')
    await userEvent.click(screen.getByRole('button', { name: '送出' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('你送出太多回報了')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('has every category and every text in six languages, and the notifications', () => {
    for (const lang of LANGS) {
      const t = STRINGS[lang]
      for (const c of SUPPORT_CATEGORIES) expect(t.support.categories[c]).toBeTruthy()
      const note = (kind: 'supportReport' | 'supportForwarded' | 'supportResolved') =>
        notificationText(t, { id: 'n', at: 0, kind, params: { username: 'amy', name: '臺大' }, read: false })
      expect(note('supportReport')).toContain('amy')
      expect(note('supportForwarded')).toContain('臺大')
      expect(note('supportResolved')).toBeTruthy()
      for (const text of [t.support.attachedImported, t.support.boardImported, t.support.mineTitle, t.support.mineNone, t.support.mineResolvedAt('x'), t.push.groups.support]) expect(text).toBeTruthy()
      expect(t.legal.privacy.some((section) => section.p.includes('User-Agent'))).toBe(true)
    }
  })
})

const REPORT: AdminSupportReport = {
  id: 'r1',
  clubId: 'tku',
  category: 'bug',
  text: '叫牌框打不開',
  browser: 'Mozilla/5.0 Chrome/130',
  version: 'abc123',
  boardId: 'b9',
  tableId: 't7',
  createdAt: 1,
  status: 'open',
  userId: 'u1',
  username: 'amy',
}

describe('客服回報 on the admin page (e12-t16)', () => {
  const list = (reports: AdminSupportReport[], canForward = true): AdminSupportView => ({ reports, canForward })

  it('shows what came with a report, and resolves it', async () => {
    const sent = stubApi({
      '/api/admin/support': ok(list([REPORT])),
      '/api/admin/support/r1/status': ok(list([{ ...REPORT, status: 'resolved', resolvedAt: 2 }])),
    })
    wrap(<AdminSupport />)
    const item = await screen.findByRole('article', { name: '回報人：amy' })
    for (const shown of ['叫牌框打不開', '程式錯誤', '待處理', '瀏覽器：Mozilla/5.0 Chrome/130', '版本：abc123', '牌桌 t7']) expect(within(item).getByText(shown)).toBeInTheDocument()
    expect(within(item).getByRole('link', { name: '牌局 b9' })).toHaveAttribute('href', '/history/b9')
    await userEvent.click(within(item).getByRole('button', { name: '標成已解決' }))
    expect(await within(item).findByText('已解決')).toBeInTheDocument()
    expect(within(item).getByRole('button', { name: '重新打開' })).toBeInTheDocument()
    expect(sent.at(-1)).toEqual({ path: '/api/admin/support/r1/status', method: 'POST', body: { status: 'resolved' } })
  })

  it('says an imported board is private to the member, with no link that leads nowhere', async () => {
    const { boardId: _boardId, ...rest } = REPORT
    stubApi({ '/api/admin/support': ok(list([{ ...rest, boardImported: true }])) })
    wrap(<AdminSupport />)
    const item = await screen.findByRole('article', { name: '回報人：amy' })
    expect(within(item).getByText(STRINGS.zh.support.boardImported)).toBeInTheDocument()
    expect(within(item).queryByRole('link')).toBeNull()
  })

  it('forwards to the platform owner once, and only when there is one', async () => {
    stubApi({
      '/api/admin/support': ok(list([REPORT])),
      '/api/admin/support/r1/forward': ok(list([{ ...REPORT, forwardedAt: 2, forwardedBy: 'gene' }])),
    })
    const { unmount } = wrap(<AdminSupport />)
    await userEvent.click(await screen.findByRole('button', { name: '轉交平台管理員' }))
    expect(await screen.findByText(/由 gene 轉交/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '轉交平台管理員' })).toBeNull()
    unmount()
    stubApi({ '/api/admin/support': ok(list([REPORT], false)) })
    wrap(<AdminSupport />)
    await screen.findByRole('article', { name: '回報人：amy' })
    expect(screen.queryByRole('button', { name: '轉交平台管理員' })).toBeNull()
  })

  it('says so when there are none', async () => {
    stubApi({ '/api/admin/support': ok(list([])) })
    wrap(<AdminSupport />)
    expect(await screen.findByText('沒有回報。')).toBeInTheDocument()
  })
})

describe('社團橫幅 on the admin page (e12-t15)', () => {
  it('sets a banner with no end, and takes it down', async () => {
    const banner = { id: 'b1', text: '社課改到週四', setAt: 1 }
    const sent = stubApi({
      '/api/admin/banner': () =>
        sent.at(-1)?.method === 'POST'
          ? ok({ banner })
          : sent.at(-1)?.method === 'DELETE'
            ? ok({ banner: null })
            : ok({ banner: null }),
    })
    wrap(<AdminBanner />)
    await userEvent.type(await screen.findByLabelText('內容'), '社課改到週四')
    expect(screen.queryByRole('button', { name: '撤下橫幅' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '發布橫幅' }))
    await userEvent.click(await screen.findByRole('button', { name: '撤下橫幅' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: '撤下橫幅' })).toBeNull())
    expect(screen.getByLabelText('內容')).toHaveValue('')
    expect(sent.filter((s) => s.method === 'POST')[0].body).toEqual({ text: '社課改到週四', expiresAt: null })
    expect(sent.at(-1)?.method).toBe('DELETE')
  })
})

describe('the back office’s announcements and forwarded reports (e12-t15, e12-t16)', () => {
  const base: PlatformView = {
    clubs: [],
    applications: [],
    notices: [],
    support: [],
    totals: { members: 0, filesBytes: 0, backupBytes: 0, historyRows: 0, storageBytes: 0 },
  }
  const runner = () =>
    vi.fn(async (_key: string, action: () => Promise<PlatformView>) => {
      await action()
      return true
    })

  it('saves a draft with an end, and offers publishing it', async () => {
    const sent = stubApi({ '/api/platform/notices': ok(base) })
    const run = runner()
    wrap(<PlatformNotices view={base} busy={null} run={run} />)
    expect(screen.getByText('還沒有平台公告。')).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('內容'), '週六停機維護')
    await userEvent.type(screen.getByLabelText('結束時間（選填）'), '2030-01-02T03:04')
    await userEvent.click(screen.getByRole('button', { name: '存成草稿' }))
    await waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0].body).toEqual({ text: '週六停機維護', expiresAt: new Date('2030-01-02T03:04').getTime() })
    // The box is empty for the next one
    await waitFor(() => expect(screen.getByLabelText('內容')).toHaveValue(''))
  })

  it('shows each notice’s state and what can be done with it', async () => {
    const sent = stubApi({ '/api/platform/notices/n1/publish': ok(base), '/api/platform/notices/n2/withdraw': ok(base) })
    const notices: PlatformView['notices'] = [
      { id: 'n1', text: '還在寫', status: 'draft', createdAt: 1, updatedAt: 1 },
      { id: 'n2', text: '正在發布', status: 'published', createdAt: 1, updatedAt: 1, publishedAt: 2 },
      { id: 'n3', text: '已經過期', status: 'published', createdAt: 1, updatedAt: 1, publishedAt: 2, expiresAt: 3 },
      { id: 'n4', text: '收回來了', status: 'withdrawn', createdAt: 1, updatedAt: 1, publishedAt: 2 },
    ]
    wrap(<PlatformNotices view={{ ...base, notices }} busy={null} run={runner()} />)
    const item = (text: string) => screen.getByText(text).closest('article')!
    expect(within(item('還在寫')).getByText('草稿')).toBeInTheDocument()
    expect(within(item('正在發布')).getByText('發布中')).toBeInTheDocument()
    expect(within(item('已經過期')).getByText('已結束')).toBeInTheDocument()
    expect(within(item('收回來了')).getByText('已下架')).toBeInTheDocument()
    expect(within(item('正在發布')).queryByRole('button', { name: '刪除' })).toBeNull()
    await userEvent.click(within(item('還在寫')).getByRole('button', { name: '發布' }))
    await userEvent.click(within(item('正在發布')).getByRole('button', { name: '下架' }))
    expect(sent.map((s) => s.path)).toEqual(['/api/platform/notices/n1/publish', '/api/platform/notices/n2/withdraw'])
  })

  it('edits a notice in place', async () => {
    const sent = stubApi({ '/api/platform/notices': ok(base) })
    const notices: PlatformView['notices'] = [{ id: 'n1', text: '還在寫', status: 'draft', createdAt: 1, updatedAt: 1 }]
    wrap(<PlatformNotices view={{ ...base, notices }} busy={null} run={runner()} />)
    await userEvent.click(screen.getByRole('button', { name: '編輯' }))
    const form = screen.getByRole('button', { name: '儲存' }).closest('form')!
    await userEvent.type(within(form).getByLabelText('內容'), '好了')
    await userEvent.click(within(form).getByRole('button', { name: '儲存' }))
    await waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0].body).toEqual({ id: 'n1', text: '還在寫好了', expiresAt: null })
  })

  it('lists forwarded reports with their club and no member, and resolves one', async () => {
    const sent = stubApi({ '/api/platform/support/ntu/r1/status': ok(base) })
    const support: PlatformView['support'] = [
      { id: 'r1', clubId: 'ntu', category: 'bug', text: '臺大轉來的', browser: 'Chrome', version: 'v1', tableId: 't7', createdAt: 1, status: 'open', forwardedAt: 2, forwardedBy: 'ntuhead' },
    ]
    wrap(<PlatformSupport view={{ ...base, support }} busy={null} run={runner()} />)
    const item = screen.getByRole('article', { name: '來自社團 ntu' })
    expect(within(item).getByText('臺大轉來的')).toBeInTheDocument()
    expect(within(item).getByText(/由 ntuhead 轉交/)).toBeInTheDocument()
    expect(within(item).getByText('牌桌 t7')).toBeInTheDocument()
    await userEvent.click(within(item).getByRole('button', { name: '標成已解決' }))
    expect(sent[0]).toEqual({ path: '/api/platform/support/ntu/r1/status', method: 'POST', body: { status: 'resolved' } })
  })

  it('says so when nothing was forwarded', () => {
    wrap(<PlatformSupport view={base} busy={null} run={runner()} />)
    expect(screen.getByText('沒有轉交的回報。')).toBeInTheDocument()
  })
})
