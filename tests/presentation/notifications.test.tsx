import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import type { NotificationsView } from '../../shared/protocol.ts'
import { NotificationBell } from '../../src/components/NotificationBell.tsx'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'

const VIEW: NotificationsView = {
  unread: 1,
  items: [
    { id: 'n2', at: Date.UTC(2026, 9, 24, 8), kind: 'application', params: { username: 'amy' }, read: false },
    { id: 'n1', at: Date.UTC(2026, 9, 23, 8), kind: 'application', params: { username: 'ben' }, read: true },
  ],
}

function show(view: NotificationsView, onRead = vi.fn()) {
  render(
    <PreferencesProvider>
      <MemoryRouter initialEntries={['/']}>
        <NotificationBell notifications={view} onRead={onRead} />
        <Routes>
          <Route path="/" element={<p>大廳頁</p>} />
          <Route path="/admin" element={<p>管理頁</p>} />
        </Routes>
      </MemoryRouter>
    </PreferencesProvider>,
  )
  return onRead
}

describe('NotificationBell', () => {
  it('shows the unread count, and a notification leads to its page and is marked read', async () => {
    const onRead = show(VIEW)
    await userEvent.click(screen.getByRole('button', { name: '通知（1 則未讀）' }))
    const panel = screen.getByRole('dialog', { name: '通知' })
    expect(within(panel).getByText('amy 申請加入，等你核准')).toBeInTheDocument()
    expect(within(panel).getByText('ben 申請加入，等你核准')).toBeInTheDocument()

    await userEvent.click(within(panel).getByText('amy 申請加入，等你核准'))
    expect(onRead).toHaveBeenCalledWith(['n2'])
    expect(screen.getByText('管理頁')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('marks everything read, and says so when there is nothing', async () => {
    const onRead = show(VIEW)
    await userEvent.click(screen.getByRole('button', { name: /通知/ }))
    await userEvent.click(screen.getByRole('button', { name: '全部標為已讀' }))
    expect(onRead).toHaveBeenCalledWith()
  })

  it('has nothing to mark when nothing is unread', async () => {
    show({ items: [], unread: 0 })
    await userEvent.click(screen.getByRole('button', { name: '通知' }))
    expect(screen.getByText('目前沒有通知')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '全部標為已讀' })).toBeDisabled()
  })
})
