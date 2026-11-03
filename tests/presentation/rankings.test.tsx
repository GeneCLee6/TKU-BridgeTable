import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_POINTS_RULES, taiwanMonth, type LeaderboardView } from '../../shared/points.ts'
import type { RatingView } from '../../shared/rating.ts'
import { RatingTrend } from '../../src/components/RatingTrend.tsx'
import { RankingsPage } from '../../src/pages/RankingsPage.tsx'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'

/** The rankings page and the rating on a profile (J2, e9-t06, e9-t08) */

const mocks = vi.hoisted(() => ({
  api: {
    rankings: vi.fn(),
    ledger: vi.fn(),
    savePointsRules: vi.fn(),
    adjustPoints: vi.fn(),
    rating: vi.fn(),
    setRatingHidden: vi.fn(),
  },
  admin: false,
  flag: true,
}))

vi.mock('../../src/lib/api.ts', async (original) => ({
  ...(await original<typeof import('../../src/lib/api.ts')>()),
  api: mocks.api,
}))
vi.mock('../../src/state/AuthContext.tsx', () => ({
  useAuth: () => ({ user: { id: 'amy', username: 'amy', admin: mocks.admin, permissions: [] } }),
  useFeature: () => mocks.flag,
}))

const month = taiwanMonth(Date.now())
const BOARD: LeaderboardView = {
  period: { kind: 'month', key: month, from: 0, to: 1 },
  rows: [
    { userId: 'ben', rank: 1, points: 7, events: 2, user: { id: 'ben', username: 'ben' } },
    { userId: 'amy', rank: 2, points: 3, events: 1, user: { id: 'amy', username: 'amy' } },
  ],
  rules: DEFAULT_POINTS_RULES,
}

const renderPage = () =>
  render(
    <PreferencesProvider>
      <MemoryRouter>
        <RankingsPage />
      </MemoryRouter>
    </PreferencesProvider>,
  )

beforeEach(() => {
  mocks.admin = false
  mocks.flag = true
  for (const fn of Object.values(mocks.api)) fn.mockReset()
  mocks.api.rankings.mockResolvedValue({ board: BOARD })
})

describe('RankingsPage', () => {
  it('shows this month’s board, the member’s own row marked, and steps to other months', async () => {
    renderPage()
    const table = await screen.findByRole('table')
    const rows = within(table).getAllByRole('row')
    expect(rows[1]).toHaveTextContent('ben')
    expect(rows[1]).toHaveTextContent('7')
    expect(rows[2]).toHaveAttribute('aria-current', 'true')
    expect(mocks.api.rankings).toHaveBeenCalledWith(`month=${month}`)
    await userEvent.click(screen.getByRole('button', { name: '上一期' }))
    await waitFor(() => expect(mocks.api.rankings).toHaveBeenLastCalledWith(expect.not.stringContaining(month)))
    await userEvent.click(screen.getByRole('button', { name: '年榜' }))
    await waitFor(() => expect(mocks.api.rankings).toHaveBeenLastCalledWith(`year=${month.slice(0, 4)}`))
    // Members see no rules
    expect(screen.queryByRole('heading', { name: '積分規則' })).toBeNull()
  })

  it('opens a member’s entries, each linked to its event', async () => {
    mocks.api.ledger.mockResolvedValue({
      entries: [{ eventId: 'c1', kind: 'challenge', at: Date.now(), rank: 1, field: 3, base: 2, points: 2, adjustments: [] }],
    })
    renderPage()
    const details = await screen.findAllByRole('button', { name: '看明細' })
    await userEvent.click(details[0])
    const ledger = await screen.findByRole('region', { name: 'ben 的積分明細' })
    expect(within(ledger).getByRole('link', { name: '挑戰' })).toHaveAttribute('href', '/challenges/c1')
    expect(ledger).toHaveTextContent('第 1 名／3')
    expect(within(ledger).queryByRole('button', { name: '更正' })).toBeNull()
  })

  it('marks the points re-credited after a director changed a finished event', async () => {
    mocks.api.ledger.mockResolvedValue({
      entries: [
        {
          eventId: 'c1',
          kind: 'challenge',
          at: Date.now(),
          rank: 2,
          field: 3,
          base: 2,
          points: 1,
          adjustments: [{ delta: -1, reason: '場外資訊', by: 'boss', at: 1, auto: true }],
        },
      ],
    })
    renderPage()
    await userEvent.click((await screen.findAllByRole('button', { name: '看明細' }))[0])
    const ledger = await screen.findByRole('region', { name: 'ben 的積分明細' })
    expect(within(ledger).getByText('裁判調整後重算 -1：場外資訊')).toBeInTheDocument()
  })

  it('gives admins the rules and corrections', async () => {
    mocks.admin = true
    mocks.flag = false
    mocks.api.ledger.mockResolvedValue({
      entries: [{ eventId: 'c1', kind: 'challenge', at: Date.now(), rank: 1, field: 3, base: 2, points: 2, adjustments: [] }],
    })
    mocks.api.adjustPoints.mockResolvedValue({
      entry: { eventId: 'c1', kind: 'challenge', at: Date.now(), rank: 1, field: 3, base: 2, points: 5, adjustments: [{ delta: 3, reason: '改判', by: 'amy', at: 1 }] },
    })
    mocks.api.savePointsRules.mockImplementation(async (rules) => ({ rules: { ...DEFAULT_POINTS_RULES, ...rules } }))
    renderPage()
    expect(await screen.findByRole('note')).toHaveTextContent('還沒對社員開放')
    await userEvent.click((await screen.findAllByRole('button', { name: '看明細' }))[0])
    await userEvent.click(await screen.findByRole('button', { name: '更正' }))
    const points = screen.getByLabelText('更正後的積分')
    await userEvent.clear(points)
    await userEvent.type(points, '5')
    await userEvent.type(screen.getByLabelText('原因'), '改判')
    await userEvent.click(screen.getAllByRole('button', { name: '儲存' })[0])
    expect(mocks.api.adjustPoints).toHaveBeenCalledWith('c1', 'ben', 5, '改判')
    expect(await screen.findByText('更正 +3：改判')).toBeInTheDocument()

    const daily = screen.getByLabelText('每日賽 每贏過一方')
    await userEvent.clear(daily)
    await userEvent.type(daily, '2')
    await userEvent.click(screen.getAllByRole('button', { name: '儲存' }).at(-1)!)
    expect(mocks.api.savePointsRules).toHaveBeenCalledWith(
      expect.objectContaining({ kinds: expect.objectContaining({ daily: expect.objectContaining({ perBeaten: 2 }) }) }),
    )
  })
})

describe('RatingTrend', () => {
  const RATING: RatingView = {
    userId: 'ben',
    rating: 1580,
    rd: 90,
    provisional: false,
    events: 2,
    hidden: false,
    history: [
      { at: Date.UTC(2026, 10, 1), rating: 1540, rd: 200, eventId: 'c1', kind: 'daily' },
      { at: Date.UTC(2026, 10, 2), rating: 1580, rd: 90, eventId: 'c2', kind: 'daily' },
    ],
  }
  const renderTrend = (userId: string) =>
    render(
      <PreferencesProvider>
        <RatingTrend userId={userId} />
      </PreferencesProvider>,
    )

  it('shows the rating and its trend, with a table of the same points', async () => {
    mocks.api.rating.mockResolvedValue({ rating: RATING })
    renderTrend('ben')
    expect(await screen.findByTestId('rating-value')).toHaveTextContent('1580')
    expect(screen.getByRole('img', { name: '實力評分走勢' })).toBeInTheDocument()
    expect(screen.getAllByRole('row')).toHaveLength(3)
    expect(screen.queryByRole('checkbox')).toBeNull()
  })

  it('says another member’s rating is hidden; on their own profile the member chooses', async () => {
    mocks.api.rating.mockResolvedValue({ rating: { ...RATING, rating: null, rd: null, history: [], hidden: true } })
    renderTrend('ben')
    expect(await screen.findByText('這位社員不公開實力評分。')).toBeInTheDocument()

    mocks.api.rating.mockResolvedValue({ rating: { ...RATING, userId: 'amy' } })
    mocks.api.setRatingHidden.mockResolvedValue({ rating: { ...RATING, userId: 'amy', hidden: true } })
    renderTrend('amy')
    await userEvent.click(await screen.findByRole('checkbox', { name: '不公開我的實力評分' }))
    expect(mocks.api.setRatingHidden).toHaveBeenCalledWith(true)
    expect(await screen.findByText('只有你看得到。')).toBeInTheDocument()
  })

  it('shows nothing without the flag', () => {
    mocks.flag = false
    const { container } = renderTrend('ben')
    expect(container).toBeEmptyDOMElement()
    expect(mocks.api.rating).not.toHaveBeenCalled()
  })
})
