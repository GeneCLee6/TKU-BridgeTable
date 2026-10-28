import { render, renderHook, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SidePanel } from '../../src/components/SidePanel.tsx'
import { useScrollLock } from '../../src/lib/useScrollLock.ts'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'

/** Dialogs and the phone's dock sheet keep the page behind them still (社長 2026-10-27) */

vi.mock('../../src/state/ClubContext.tsx', () => ({ useClub: () => ({ lobby: null }) }))
vi.mock('../../src/state/AuthContext.tsx', () => ({ useAuth: () => ({ user: null }) }))
vi.mock('../../src/components/PeopleList.tsx', () => ({ PeopleList: () => <p>people</p> }))

const locked = () => document.body.style.position === 'fixed' && document.documentElement.style.overflow === 'hidden'

afterEach(() => {
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

describe('useScrollLock', () => {
  it('pins the page while any lock is held, and lets it go with the last', () => {
    const first = renderHook(() => useScrollLock())
    expect(locked()).toBe(true)
    const second = renderHook(() => useScrollLock())
    first.unmount()
    expect(locked()).toBe(true)
    second.unmount()
    expect(locked()).toBe(false)
    expect(document.body.getAttribute('style')).toBeNull()
  })

  it('does nothing while inactive', () => {
    const { rerender, unmount } = renderHook(({ on }) => useScrollLock(on), { initialProps: { on: false } })
    expect(locked()).toBe(false)
    rerender({ on: true })
    expect(locked()).toBe(true)
    rerender({ on: false })
    expect(locked()).toBe(false)
    unmount()
  })
})

describe('the dock on a phone', () => {
  const phone = () =>
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: query.includes('max-width: 900px'),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      })),
    )

  const dock = () =>
    render(
      <PreferencesProvider>
        <MemoryRouter>
          <SidePanel tabs={['people', 'messages', 'history']} page="lobby" initial="people" />
        </MemoryRouter>
      </PreferencesProvider>,
    )

  it('starts closed, opens a sheet over a still page, and closes from the dimmed page or its tab, with no ✕', async () => {
    phone()
    window.localStorage.setItem('tku-bridge-table:dock', JSON.stringify({ lobby: 'people' }))
    dock()
    expect(screen.queryByRole('tabpanel')).toBeNull()
    expect(locked()).toBe(false)

    await userEvent.click(screen.getByRole('tab', { name: '社員' }))
    expect(screen.getByRole('tabpanel', { name: '社員' })).toBeInTheDocument()
    expect(locked()).toBe(true)

    await userEvent.click(screen.getByTestId('dock-scrim'))
    expect(screen.queryByRole('tabpanel')).toBeNull()
    expect(locked()).toBe(false)

    await userEvent.click(screen.getByRole('tab', { name: '社員' }))
    expect(screen.queryByRole('button', { name: '關閉' })).toBeNull()
    await userEvent.click(screen.getByRole('tab', { name: '社員' }))
    expect(screen.queryByRole('tabpanel')).toBeNull()
    expect(locked()).toBe(false)
    // A phone does not remember the sheet: the stored tab is the computer's
    expect(JSON.parse(window.localStorage.getItem('tku-bridge-table:dock')!)).toEqual({ lobby: 'people' })
  })

  it('stays beside the page on a computer, with no ✕ and no lock', () => {
    dock()
    expect(screen.getByRole('tabpanel', { name: '社員' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '關閉' })).toBeNull()
    expect(locked()).toBe(false)
  })
})
