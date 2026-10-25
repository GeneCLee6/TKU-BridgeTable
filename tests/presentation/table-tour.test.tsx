import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TableTour } from '../../src/components/TableTour.tsx'
import { ToastProvider } from '../../src/components/Toast.tsx'
import { AccountPage } from '../../src/pages/AccountPage.tsx'
import { AuthProvider } from '../../src/state/AuthContext.tsx'
import { PreferencesProvider, usePreferences } from '../../src/state/PreferencesContext.tsx'

// e3-t34 (AC-3.10): the first visit to a table shows a five-step tour that can be skipped and
// seen again from "My account"

/** The tour as the table shows it: until it is closed, and only while it has not been seen */
function Table() {
  const { tableTourSeen, set } = usePreferences()
  return (
    <>
      <div data-tour="bidding-box">bidding box</div>
      {!tableTourSeen && <TableTour onClose={() => set({ tableTourSeen: true })} />}
    </>
  )
}

const unseen = () => window.localStorage.setItem('tku-bridge-table:prefs', JSON.stringify({ lang: 'zh', tableTourSeen: false }))
const stored = () => JSON.parse(window.localStorage.getItem('tku-bridge-table:prefs') ?? '{}') as { tableTourSeen?: boolean }

afterEach(() => vi.unstubAllGlobals())

describe('the table tour', () => {
  it('walks through the five steps, back and forth, and is not shown again', async () => {
    unseen()
    const user = userEvent.setup()
    render(
      <PreferencesProvider>
        <Table />
      </PreferencesProvider>,
    )
    const dialog = screen.getByRole('dialog', { name: '叫牌盒' })
    expect(dialog).toHaveTextContent('第 1 步，共 5 步')
    expect(screen.getByRole('button', { name: '下一步' })).toHaveFocus()

    const titles = ['Alert', '攤牌', '撤回', '側欄']
    for (const title of titles) {
      await user.click(screen.getByRole('button', { name: '下一步' }))
      expect(screen.getByRole('dialog', { name: title })).toBeInTheDocument()
    }
    await user.click(screen.getByRole('button', { name: '上一步' }))
    expect(screen.getByRole('dialog', { name: '撤回' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '下一步' }))
    await user.click(screen.getByRole('button', { name: '開始打牌' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(stored().tableTourSeen).toBe(true)
  })

  it('can be skipped with the button or Esc', async () => {
    unseen()
    const user = userEvent.setup()
    const { unmount } = render(
      <PreferencesProvider>
        <Table />
      </PreferencesProvider>,
    )
    await user.click(screen.getByRole('button', { name: '跳過導覽' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    unmount()

    unseen()
    render(
      <PreferencesProvider>
        <Table />
      </PreferencesProvider>,
    )
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('is not shown once seen, and "My account" brings it back', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ user: { id: 'amy', username: 'amy', admin: false, permissions: [] } }), { status: 200 })),
    )
    const user = userEvent.setup()
    render(
      <PreferencesProvider>
        <ToastProvider>
          <AuthProvider>
            <MemoryRouter>
              <AccountPage />
              <Table />
            </MemoryRouter>
          </AuthProvider>
        </ToastProvider>
      </PreferencesProvider>,
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '重看牌桌導覽' }))
    expect(await screen.findByText('好的，下次進入牌桌時會顯示導覽')).toBeInTheDocument()
    expect(stored().tableTourSeen).toBe(false)
    expect(screen.getByRole('dialog', { name: '叫牌盒' })).toBeInTheDocument()
  })
})
