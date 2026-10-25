import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fullDeck, type Hands } from '../../shared/cards.ts'
import type { FeaturedBoard } from '../../shared/featured.ts'
import { legalCards, makeCall, newBoard, playCard, turnOf, type BoardState } from '../../shared/game.ts'
import { summarize, type BoardRecord, type Me } from '../../shared/protocol.ts'
import { BoardRecordView } from '../../src/pages/BoardPage.tsx'
import { FeaturedPage } from '../../src/pages/FeaturedPage.tsx'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'

/** Featured boards (e4-t29 – e4-t31) and robot substitutes on a record (e2-t31) */

const mocks = vi.hoisted(() => ({
  api: { featured: vi.fn(), featuredBoard: vi.fn(), saveFeatured: vi.fn(), unfeature: vi.fn() },
  user: { id: 'ben', username: 'ben', admin: false, permissions: [] } as Me,
}))
vi.mock('../../src/lib/api.ts', async (original) => ({
  ...(await original<typeof import('../../src/lib/api.ts')>()),
  api: mocks.api,
}))
vi.mock('../../src/state/AuthContext.tsx', () => ({ useAuth: () => ({ user: mocks.user }) }))
vi.mock('../../src/components/DoubleDummyPanel.tsx', () => ({ DoubleDummyPanel: () => null }))

const amy = { id: 'amy', username: 'amy' }
const ben = { id: 'ben', username: 'ben' }
const robot = (seat: string) => ({ id: `robot:gib:${seat}`, username: 'TKB', robot: true })

const hands: Hands = {
  N: fullDeck().filter((c) => c[0] === 'S'),
  E: fullDeck().filter((c) => c[0] === 'H'),
  S: fullDeck().filter((c) => c[0] === 'D'),
  W: fullDeck().filter((c) => c[0] === 'C'),
}

function record(id: string): BoardRecord {
  let board: BoardState = newBoard(1, hands)
  for (const call of ['7D', 'P', 'P', 'P']) board = makeCall(board, turnOf(board)!, call)
  for (let i = 0; i < 52; i++) {
    const seat = turnOf(board)!
    board = playCard(board, seat, legalCards(board, seat)[0])
  }
  return {
    id,
    tableNumber: 3,
    finishedAt: 0,
    players: { N: robot('N'), E: robot('E'), S: amy, W: robot('W') },
    substitutes: { N: ben },
    board,
  }
}

function featured(id: string, category: FeaturedBoard['category'], title: string): FeaturedBoard {
  return {
    boardId: id,
    title,
    category,
    explanation: '大滿貫，數清楚贏墩',
    trickNotes: { 2: '第二墩先清王' },
    by: amy,
    at: 0,
    updatedAt: 0,
    board: summarize(record(id)),
  }
}

const renderIn = (ui: React.ReactNode) =>
  render(
    <PreferencesProvider>
      <MemoryRouter>{ui}</MemoryRouter>
    </PreferencesProvider>,
  )

beforeEach(() => {
  vi.clearAllMocks()
  mocks.user = { id: 'ben', username: 'ben', admin: false, permissions: [] }
})

describe('featured page', () => {
  it('lists the featured boards in tabs by category, each opening its record', async () => {
    mocks.api.featured.mockResolvedValue({ featured: [featured('b1', 'declarer', '坐莊的好例子'), featured('b2', 'bidding', '叫牌的好例子')] })
    renderIn(<FeaturedPage />)
    const link = await screen.findByRole('link', { name: /坐莊的好例子/ })
    expect(link).toHaveAttribute('href', '/history/b1')
    expect(screen.getByRole('link', { name: /叫牌的好例子/ })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: '叫牌 (1)' }))
    const panel = screen.getByRole('tabpanel')
    expect(within(panel).getByRole('link', { name: /叫牌的好例子/ })).toBeInTheDocument()
    expect(within(panel).queryByRole('link', { name: /坐莊的好例子/ })).toBeNull()
    await userEvent.click(screen.getByRole('tab', { name: '防守 (0)' }))
    expect(screen.getByText('這個分類還沒有精選牌局')).toBeInTheDocument()
  })
})

describe('a featured board on its record', () => {
  it('shows the explanation, and a trick note when the replay reaches that trick', async () => {
    mocks.api.featuredBoard.mockResolvedValue({ featured: featured('b1', 'declarer', '坐莊的好例子') })
    renderIn(<BoardRecordView record={record('b1')} />)
    expect(await screen.findByText('坐莊的好例子')).toBeInTheDocument()
    expect(screen.getByText('大滿貫，數清楚贏墩')).toBeInTheDocument()
    expect(screen.queryByText('第二墩先清王')).toBeNull()
    // No editing without the permission
    expect(screen.queryByRole('button', { name: '編輯精選' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '第 2 墩' }))
    expect(screen.getByText('第二墩先清王')).toBeInTheDocument()
  })

  it('lets a curator feature a board with notes for its tricks', async () => {
    mocks.user = { ...mocks.user, permissions: ['boardCurate'] }
    mocks.api.featuredBoard.mockResolvedValue({ featured: null })
    mocks.api.saveFeatured.mockResolvedValue({ featured: featured('b1', 'defence', '防守') })
    renderIn(<BoardRecordView record={record('b1')} />)
    await userEvent.click(await screen.findByRole('button', { name: '設為精選' }))
    await userEvent.type(screen.getByLabelText('標題'), '防守')
    await userEvent.selectOptions(screen.getByLabelText('分類'), 'defence')
    await userEvent.type(screen.getByLabelText('第 13 墩'), '最後一墩')
    await userEvent.click(screen.getByRole('button', { name: '儲存' }))
    expect(mocks.api.saveFeatured).toHaveBeenCalledWith('b1', {
      title: '防守',
      category: 'defence',
      explanation: '',
      trickNotes: { 13: '最後一墩' },
    })
    expect(await screen.findByRole('button', { name: '編輯精選' })).toBeInTheDocument()
  })

  it('offers nothing to a member who may not feature an unfeatured board', async () => {
    mocks.api.featuredBoard.mockResolvedValue({ featured: null })
    renderIn(<BoardRecordView record={record('b1')} />)
    await vi.waitFor(() => expect(mocks.api.featuredBoard).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: '設為精選' })).toBeNull()
  })
})

describe('robot substitutes on a record', () => {
  it('names the member a robot sat in for', () => {
    mocks.api.featuredBoard.mockResolvedValue({ featured: null })
    renderIn(<BoardRecordView record={record('b1')} />)
    expect(screen.getByText('代打')).toBeInTheDocument()
    expect(screen.getByText('北 · 代打 ben')).toBeInTheDocument()
  })
})
