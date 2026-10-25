import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect } from 'react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HistoryQuery } from '../../shared/history-query.ts'
import { HistoryPage } from '../../src/pages/HistoryPage.tsx'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'

const searchHistory = vi.fn(async (query: Partial<HistoryQuery>) => ({ boards: [], total: 0, page: query.page ?? 1, size: query.size ?? 20 }))

vi.mock('../../src/lib/api.ts', () => ({ api: { searchHistory: (query: Partial<HistoryQuery>) => searchHistory(query) } }))
vi.mock('../../src/state/ClubContext.tsx', () => ({
  useLobby: () => ({
    members: [
      { id: 'u-amy', username: 'amy', online: true, tableNumber: null, seat: null },
      { id: 'u-ben', username: 'ben', online: false, tableNumber: null, seat: null },
    ],
  }),
}))

/** The page's address, as the test last saw it */
const address = { search: '' }
function Address() {
  const { search } = useLocation()
  useEffect(() => {
    address.search = search
  }, [search])
  return null
}

const open = (address: string) =>
  render(
    <PreferencesProvider>
      <MemoryRouter initialEntries={[address]}>
        <Routes>
          <Route
            path="/history"
            element={
              <>
                <HistoryPage />
                <Address />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </PreferencesProvider>,
  )

const lastQuery = () => searchHistory.mock.calls.at(-1)?.[0]

describe('history filters and sorting (e4-t16…t21)', () => {
  beforeEach(() => {
    searchHistory.mockClear()
    window.localStorage.removeItem('tku-bridge-table:history-size')
  })

  it('reads the search from the address, so a shared link shows the same list', async () => {
    open('/history?scope=all&level=4&strain=S&partner=u-ben&sort=score_desc&page=2')
    await waitFor(() => expect(searchHistory).toHaveBeenCalled())
    expect(lastQuery()).toMatchObject({ scope: 'all', level: 4, strain: 'S', partner: 'u-ben', sort: 'score_desc', page: 2 })
    // Filters already set open the filter panel
    expect(screen.getByRole('combobox', { name: '我的搭檔' })).toHaveValue('u-ben')
  })

  it('drops what it does not understand instead of failing', async () => {
    open('/history?level=9&colour=red&result=made')
    await waitFor(() => expect(searchHistory).toHaveBeenCalled())
    expect(lastQuery()).toEqual({ scope: 'mine', sort: 'date_desc', page: 1, size: 20, result: 'made' })
  })

  it('writes every change into the address and starts again from the first page', async () => {
    const user = userEvent.setup()
    open('/history?page=3')
    await user.click(screen.getByRole('button', { name: '篩選' }))
    await user.click(screen.getByRole('button', { name: '成局' }))
    expect(address.search).toBe('?bracket=game')
    await user.selectOptions(screen.getByRole('combobox', { name: '誰主打' }), 'partner')
    await user.selectOptions(screen.getByRole('combobox', { name: '我和誰同桌' }), 'u-amy')
    await user.selectOptions(screen.getByRole('combobox', { name: '賭倍' }), 'XX')
    await user.selectOptions(screen.getByRole('combobox', { name: '模式' }), 'challenge')
    await user.selectOptions(screen.getByRole('combobox', { name: '排序' }), 'tricks_desc')
    await waitFor(() =>
      expect(lastQuery()).toMatchObject({
        bracket: 'game',
        declarerSide: 'partner',
        player: 'u-amy',
        doubled: 'XX',
        mode: 'challenge',
        sort: 'tricks_desc',
        page: 1,
      }),
    )
    expect(new URLSearchParams(address.search).get('sort')).toBe('tricks_desc')
    // Pressing the quick filter again takes it off
    await user.click(screen.getByRole('button', { name: '成局' }))
    expect(new URLSearchParams(address.search).has('bracket')).toBe(false)
  })

  it('offers today, this week, this month and a custom range', async () => {
    const user = userEvent.setup()
    open('/history')
    await user.click(screen.getByRole('button', { name: '篩選' }))
    await user.selectOptions(screen.getByRole('combobox', { name: '日期' }), 'today')
    const params = new URLSearchParams(address.search)
    expect(params.get('from')).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(params.get('to')).toBe(params.get('from'))
    await user.selectOptions(screen.getByRole('combobox', { name: '日期' }), 'custom')
    expect(screen.getByLabelText('從')).toHaveValue(params.get('from'))
    await user.selectOptions(screen.getByRole('combobox', { name: '日期' }), '')
    expect(address.search).toBe('')
  })

  it('filters by board and table number', async () => {
    const user = userEvent.setup()
    open('/history')
    await user.click(screen.getByRole('button', { name: '篩選' }))
    await user.type(screen.getByRole('spinbutton', { name: '牌號' }), '7')
    await user.type(screen.getByRole('spinbutton', { name: '桌號' }), '2')
    expect(address.search).toBe('?boardNo=7&table=2')
  })

  it('shows each condition as a chip that can be taken off on its own, or all at once (e4-t22)', async () => {
    const user = userEvent.setup()
    open('/history?scope=all&level=4&strain=S&partner=u-ben&vul=Both&boardNo=7&sort=score_desc&size=50')
    const chips = await screen.findByRole('list', { name: '目前的篩選條件' })
    expect(within(chips).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      '合約：4 黑桃',
      '我的搭檔：ben',
      '雙方有身價',
      '牌號：7',
      '清除全部',
    ])
    expect(screen.getByRole('button', { name: '篩選 (4)' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '移除「合約：4 黑桃」' }))
    expect(address.search).toBe('?scope=all&partner=u-ben&vul=Both&boardNo=7&sort=score_desc&size=50')
    // Clearing keeps the scope, the sorting and the page size: they are not conditions
    await user.click(screen.getByRole('button', { name: '清除全部' }))
    expect(address.search).toBe('?scope=all&sort=score_desc&size=50')
    expect(screen.queryByRole('list', { name: '目前的篩選條件' })).not.toBeInTheDocument()
    await waitFor(() => expect(lastQuery()).toEqual({ scope: 'all', sort: 'score_desc', page: 1, size: 50 }))
  })

  it('names a date range by its preset, or by its dates', async () => {
    open('/history?from=2026-01-02&to=2026-01-31')
    expect(await screen.findByText('日期：2026-01-02 – 2026-01-31')).toBeInTheDocument()
  })

  it('folds the filters into one button on a phone', async () => {
    const user = userEvent.setup()
    const matchMedia = vi.fn((query: string) => ({ matches: true, media: query, addEventListener: () => {}, removeEventListener: () => {} }))
    vi.stubGlobal('matchMedia', matchMedia)
    try {
      open('/history?bracket=game&result=down')
      // The chips show what is set; the filters themselves stay folded until asked for
      expect(await screen.findByText('成局')).toBeInTheDocument()
      expect(screen.queryByRole('combobox', { name: '結果' })).not.toBeInTheDocument()
      const toggle = screen.getByRole('button', { name: '篩選 (2)' })
      expect(toggle).toHaveAttribute('aria-expanded', 'false')
      await user.click(toggle)
      expect(screen.getByRole('combobox', { name: '結果' })).toHaveValue('down')
      await user.click(screen.getByRole('button', { name: '完成' }))
      expect(screen.queryByRole('combobox', { name: '結果' })).not.toBeInTheDocument()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
