import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DAY_MS, taiwanDate, taiwanDayStart } from '../../shared/history-query.ts'
import type { BoardSummary } from '../../shared/protocol.ts'
import { HistoryList, TABLE_FLAT_MAX } from '../../src/components/SidePanel.tsx'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'

/** The side panel's history (e3-t48): days first, a day's boards on two lines each, and back */

const mocks = vi.hoisted(() => ({
  api: {
    historyDays: vi.fn(),
    searchHistory: vi.fn(),
    favoriteIds: vi.fn(),
  },
}))
vi.mock('../../src/lib/api.ts', () => ({ api: mocks.api }))
vi.mock('../../src/state/ClubContext.tsx', () => ({ useClub: () => ({}), useLobby: () => ({ members: [] }) }))
vi.mock('../../src/state/AuthContext.tsx', () => ({ useAuth: () => ({ user: null }) }))

const today = taiwanDate(Date.now())
const yesterday = taiwanDate(taiwanDayStart(today) - DAY_MS)
const older = taiwanDate(taiwanDayStart(today) - 5 * DAY_MS)

function summary(n: number, at: number, east = 'Cat'): BoardSummary {
  return {
    id: `b${n}`,
    tableNumber: 1,
    finishedAt: at,
    players: {
      N: { id: 'amy', username: 'Amy' },
      S: { id: 'ben', username: 'Ben' },
      E: { id: 'cat', username: east },
      W: { id: 'dan', username: 'Dan' },
    },
    boardNo: n,
    dealer: 'N',
    vul: 'None',
    contract: { level: 4, strain: 'S', declarer: 'N', doubled: '' },
    result: { declarerTricks: 10, scoreNS: 420, claimed: false },
  } as BoardSummary
}

beforeEach(() => {
  for (const fn of Object.values(mocks.api)) fn.mockReset()
  mocks.api.historyDays.mockResolvedValue({
    days: [
      { date: today, count: 2 },
      { date: yesterday, count: 30 },
      { date: older, count: 1 },
    ],
  })
})

const show = (props: Partial<Parameters<typeof HistoryList>[0]> = {}) => {
  const onBoard = vi.fn()
  render(
    <PreferencesProvider>
      <MemoryRouter>
        <HistoryList board={null} onBoard={onBoard} newTab {...props} />
      </MemoryRouter>
    </PreferencesProvider>,
  )
  return onBoard
}

describe('the side panel’s history by day (e3-t48)', () => {
  it('lists my days first, today and yesterday by name, each with its boards', async () => {
    show()
    const days = await screen.findByRole('list', { name: '依日期的牌局' })
    const rows = within(days).getAllByRole('button')
    expect(rows.map((row) => row.textContent)).toEqual(['今天2 副', '昨天30 副', expect.stringMatching(/^\d+\/\d+.*1 副$/)])
    expect(mocks.api.historyDays).toHaveBeenCalledWith({ scope: 'mine' })
    // No board is listed yet
    expect(mocks.api.searchHistory).not.toHaveBeenCalled()
  })

  it('opens a day’s boards, two lines under each title, loads more and goes back to the days', async () => {
    const user = userEvent.setup()
    const at = taiwanDayStart(yesterday) + 3600_000
    const long = 'Christopher Wellington the Third'
    mocks.api.searchHistory
      .mockResolvedValueOnce({ boards: [summary(1, at, long), summary(2, at)], total: 3, page: 1, size: 20 })
      .mockResolvedValueOnce({ boards: [summary(3, at)], total: 3, page: 2, size: 20 })
    const onBoard = show()
    await user.click(await screen.findByRole('button', { name: /昨天/ }))
    expect(mocks.api.searchHistory).toHaveBeenCalledWith({ scope: 'mine', from: yesterday, to: yesterday, size: 20 })

    const first = await screen.findByRole('button', { name: /#1/ })
    // The title on one line; NS and EW each on a line of their own, cut short with an ellipsis
    const lines = [...first.children].map((child) => child.textContent)
    expect(lines).toEqual(['#1', '4♠ N =', '+420', 'NSAmy – Ben', `EW${long} – Dan`])
    const ew = first.children[4] as HTMLElement
    expect(ew).toHaveAttribute('title', `${long} – Dan`)
    expect(getComputedStyle(ew).textOverflow).toBe('ellipsis')
    // The day is said once, above the list, not on each board
    expect(screen.queryByRole('list', { name: '依日期的牌局' })).toBeNull()
    expect(screen.getAllByText('昨天')).toHaveLength(1)

    await user.click(screen.getByRole('button', { name: '載入更多' }))
    await screen.findByRole('button', { name: /#3/ })
    expect(mocks.api.searchHistory).toHaveBeenLastCalledWith({ scope: 'mine', from: yesterday, to: yesterday, size: 20, page: 2 })
    expect(screen.queryByRole('button', { name: '載入更多' })).toBeNull()

    // A board still opens in the panel
    await user.click(first)
    expect(onBoard).toHaveBeenCalledWith('b1')

    await user.click(screen.getByRole('button', { name: '返回日期' }))
    expect(await screen.findByRole('list', { name: '依日期的牌局' })).toBeInTheDocument()
  })

  it('lists a table’s few boards straight, and by day once there are more than TABLE_FLAT_MAX', async () => {
    const user = userEvent.setup()
    const now = Date.now()
    const few = [summary(2, now), summary(1, now - 1000)]
    const { unmount } = render(
      <PreferencesProvider>
        <MemoryRouter>
          <HistoryList recent={few} board={null} onBoard={() => {}} newTab />
        </MemoryRouter>
      </PreferencesProvider>,
    )
    expect(screen.getAllByRole('button', { name: /^#\d/ })).toHaveLength(2)
    expect(screen.queryByRole('list', { name: '依日期的牌局' })).toBeNull()
    unmount()

    const yesterdayAt = taiwanDayStart(yesterday) + 3600_000
    const many = Array.from({ length: TABLE_FLAT_MAX + 1 }, (_, i) => summary(i + 1, i < 5 ? taiwanDayStart(today) + 5 - i : yesterdayAt - i * 1000))
    show({ recent: many })
    const days = screen.getByRole('list', { name: '依日期的牌局' })
    expect(within(days).getAllByRole('button').map((row) => row.textContent)).toEqual(['今天5 副', '昨天16 副'])
    await user.click(within(days).getByRole('button', { name: /今天/ }))
    expect(screen.getAllByRole('button', { name: /^#\d/ })).toHaveLength(5)
    expect(mocks.api.searchHistory).not.toHaveBeenCalled()
    // 「我的」 starts at the days again
    await user.click(screen.getByRole('button', { name: '我的' }))
    expect(await screen.findByRole('list', { name: '依日期的牌局' })).toBeInTheDocument()
  })

  it('opens 「牌局紀錄」 in a new tab from the table page', async () => {
    show()
    expect(await screen.findByRole('link', { name: '牌局紀錄' })).toHaveAttribute('target', '_blank')
  })
})
