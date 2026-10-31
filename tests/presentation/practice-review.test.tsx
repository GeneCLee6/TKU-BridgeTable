import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { deal } from '../../shared/board.ts'
import type { BoardView, LobbyView, PracticeReview as Review, TableView } from '../../shared/protocol.ts'
import { PracticeReview } from '../../src/components/PracticeReview.tsx'
import { toAnalysis } from '../../src/lib/doubleDummy.ts'
import { ddOutcome, robotGain } from '../../src/lib/practiceReview.ts'
import type { DoubleDummyState } from '../../src/lib/useDoubleDummy.ts'
import { TablePage } from '../../src/pages/TablePage.tsx'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'

/** 檢討 of a bidding practice's board (`e10-t07`): call by call against TKB, TKB's own auction, the DD table */

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  table: null as TableView | null,
  dd: { status: 'loading' } as DoubleDummyState,
}))

const lobby: LobbyView = { online: [], members: [], tables: [], myTableId: 'p1', myTableMode: 'practice', friends: [], blocked: [] }

vi.mock('../../src/lib/useDoubleDummy.ts', () => ({ useDoubleDummy: () => mocks.dd }))
vi.mock('../../src/lib/api.ts', async (original) => ({
  ...(await original<typeof import('../../src/lib/api.ts')>()),
  api: { challenges: () => Promise.resolve({ challenges: [] }), practicePresets: () => Promise.resolve({ presets: [] }) },
}))
vi.mock('../../src/state/ClubContext.tsx', () => ({
  useClub: () => ({ lobby, send: mocks.send, notifications: null, status: 'open', table: mocks.table, error: null }),
  useLobby: () => lobby,
}))
vi.mock('../../src/state/AuthContext.tsx', () => ({
  useAuth: () => ({ user: { id: 'amy', username: 'amy', admin: false, permissions: [] } }),
}))

beforeEach(() => {
  mocks.send.mockReset()
  mocks.dd = { status: 'loading' }
})

// DDS order: strains ♠ ♥ ♦ ♣ NT, seats N E S W. North-South make 10 tricks in spades, 9 in notrump
const resTable = [
  [10, 3, 10, 3],
  [7, 6, 7, 6],
  [6, 7, 6, 7],
  [6, 7, 6, 7],
  [9, 4, 9, 4],
]
const solved: DoubleDummyState = { status: 'done', analysis: toAnalysis({ resTable, par: { score: 420, contracts: ['4S-NS'] } }) }

const hands = deal()
/** Amy (South, also bidding North) opened 1♣ and jumped to 3NT; TKB would have opened 1♠ and played 4♠ */
const board: BoardView = {
  boardNo: 1,
  dealer: 'N',
  vul: 'None',
  phase: 'finished',
  hands,
  handCounts: { N: 13, E: 13, S: 13, W: 13 },
  auction: [
    { seat: 'N', call: '1C', meaning: { hcp: [12, 21], len: { C: [3, 13] } }, inferred: 'gib' },
    { seat: 'E', call: 'P', robot: true },
    { seat: 'S', call: '3N' },
    { seat: 'W', call: 'P', robot: true },
    { seat: 'N', call: 'P' },
    { seat: 'E', call: 'P', robot: true },
  ],
  contract: { level: 3, strain: 'N', doubled: '', declarer: 'S' },
  dummy: null,
  turn: null,
  tricks: [],
  tricksWon: { NS: 0, EW: 0 },
  legalCards: [],
  legalCalls: [],
  canUndo: false,
  canClaim: false,
}
const review: Review = {
  steps: [
    { call: '1S', meaning: { hcp: [12, 21], len: { S: [5, 13] } } },
    { call: 'P' },
    { call: '3N' },
    { call: 'P' },
    { call: '4S', meaning: { len: { S: [6, 13] } } },
    { call: 'P' },
  ],
  robot: {
    auction: [
      { seat: 'N', call: '1S', robot: true },
      { seat: 'E', call: 'P', robot: true },
      { seat: 'S', call: '4S', robot: true },
      { seat: 'W', call: 'P', robot: true },
      { seat: 'N', call: 'P', robot: true },
      { seat: 'E', call: 'P', robot: true },
    ],
    contract: { level: 4, strain: 'S', doubled: '', declarer: 'S' },
  },
}

const show = (given: Review | undefined = review, note?: string) =>
  render(
    <PreferencesProvider>
      <PracticeReview board={board} review={given} note={note} onClose={() => {}} />
    </PreferencesProvider>,
  )

describe('the review of a bidding practice (e10-t07)', () => {
  it('lists every call next to TKB’s, marking where they differ', () => {
    show()
    const steps = within(screen.getByRole('region', { name: '逐步對照' })).getAllByRole('button')
    expect(steps).toHaveLength(6)
    const marked = steps.map((step) => within(step).queryByText('不同') !== null)
    // 1♣ against 1♠, and North's pass against 4♠
    expect(marked).toEqual([true, false, false, false, true, false])
    expect(within(steps[0]).getByTestId('made')).toHaveTextContent('1♣')
    expect(within(steps[0]).getByTestId('robot')).toHaveTextContent('1♠')
  })

  it('explains a call when it is picked: what the call made shows, and TKB’s call there', async () => {
    show()
    const steps = within(screen.getByRole('region', { name: '逐步對照' })).getAllByRole('button')
    await userEvent.click(steps[0])
    expect(steps[0]).toHaveAttribute('aria-pressed', 'true')
    const explained = screen.getByRole('region', { name: '北 叫的意義' })
    // The engine's reading of amy's 1♣ (points and length), then TKB's 1♠
    expect(await within(explained).findByText(/依2\/1推論.*12/)).toBeInTheDocument()
    expect(within(explained).getByText(/TKB 的叫法/)).toHaveTextContent('1♠')
    // The words stay whole; the ♠ in them takes its suit colour (W4)
    const robotWords = await within(explained).findByText((_, el) => el?.tagName === 'DD' && el.textContent === '5+ 張♠，12–21 大牌點')
    expect(within(robotWords).getByText('♠').tagName).toBe('SPAN')
    // Picked again: closed
    await userEvent.click(steps[0])
    expect(screen.queryByRole('region', { name: '北 叫的意義' })).not.toBeInTheDocument()
  })

  it('shows where four TKB get to, and what each contract scores double dummy, in IMPs', () => {
    mocks.dd = solved
    show()
    const robot = screen.getByRole('region', { name: 'TKB 會叫到哪裡' })
    expect(within(robot).getByTestId('robot-auction')).toHaveTextContent('N 1♠ – E Pass – S 4♠')
    expect(within(robot).getByText('你們').closest('li')).toHaveTextContent('3NT S = · DD 9 墩 · NS +400')
    expect(within(robot).getByText('TKB').closest('li')).toHaveTextContent('4♠ S = · DD 10 墩 · NS +420')
    expect(within(robot).getByRole('status')).toHaveTextContent('TKB 的合約多拿 1 IMP')
    // The DD table and par, as on the record page
    expect(screen.getByRole('table', { name: /DD 表/ })).toBeInTheDocument()
  })

  it('says it is still working on parts the server has not sent yet, and shows what a set’s board teaches', () => {
    show({ steps: review.steps }, '1♠ 開叫要五張')
    expect(within(screen.getByRole('region', { name: 'TKB 會叫到哪裡' })).getByRole('status')).toHaveTextContent('計算中')
    expect(screen.getByText('1♠ 開叫要五張')).toBeInTheDocument()
  })

  it('scores a passed-out board as nothing, and gives the IMPs from North-South’s side', () => {
    const { table } = (solved as Extract<DoubleDummyState, { status: 'done' }>).analysis
    const passed = ddOutcome(null, table, 'None')
    expect(passed).toEqual({ tricks: null, scoreNS: 0 })
    const fourSpades = ddOutcome({ level: 4, strain: 'S', doubled: '', declarer: 'N' }, table, 'Both')
    expect(fourSpades).toEqual({ tricks: 10, scoreNS: 620 })
    expect(robotGain(passed, fourSpades)).toBe(12)
    // East-West in 4♥ go four down: North-South +200
    expect(ddOutcome({ level: 4, strain: 'H', doubled: '', declarer: 'E' }, table, 'None').scoreNS).toBe(200)
  })
})

describe('the bidding practice table opens the review (e10-t07)', () => {
  const tableWith = (practiceReview: Review | undefined): TableView => ({
    id: 'p1',
    number: 1,
    hostId: 'amy',
    settings: { access: 'hidden', allowKibitz: true, boardMinutes: 0 },
    seats: {
      N: { id: 'robot:gib:N', username: 'Robot', robot: true, robotKind: 'gib', online: true, controlledBy: 'amy' },
      E: { id: 'robot:gib:E', username: 'Robot', robot: true, robotKind: 'gib', online: true },
      S: { id: 'amy', username: 'amy', online: true },
      W: { id: 'robot:gib:W', username: 'Robot', robot: true, robotKind: 'gib', online: true },
    },
    spectators: [],
    mySeat: 'S',
    acts: ['N', 'S'],
    board,
    boardsPlayed: 0,
    dealAt: null,
    chat: [],
    recent: [],
    practice: {
      deal: 'random',
      robotKind: 'gib',
      justDeclare: false,
      biddingOnly: true,
      seats: ['N', 'S'],
      dealt: 1,
      ...(practiceReview && { review: practiceReview }),
    },
    boardEndsAt: null,
    waiting: null,
  })

  it('from the end of the auction, and closes it again', async () => {
    mocks.table = tableWith(review)
    render(
      <PreferencesProvider>
        <MemoryRouter initialEntries={['/table/p1']}>
          <Routes>
            <Route path="/table/:tableId" element={<TablePage />} />
          </Routes>
        </MemoryRouter>
      </PreferencesProvider>,
    )
    await userEvent.click(screen.getByRole('button', { name: '檢討' }))
    const dialog = screen.getByRole('dialog', { name: /叫牌檢討/ })
    expect(within(dialog).getAllByText('不同')).toHaveLength(2)
    await userEvent.click(within(dialog).getByRole('button', { name: '關閉' }))
    expect(screen.queryByRole('dialog', { name: /叫牌檢討/ })).not.toBeInTheDocument()
  })
})
