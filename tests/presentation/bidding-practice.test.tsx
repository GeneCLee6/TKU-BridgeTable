import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { legalCalls } from '../../shared/auction.ts'
import type { BoardView, LobbyView, TableView } from '../../shared/protocol.ts'
import { PracticeBanner } from '../../src/components/PracticeBanner.tsx'
import { PracticeDialog } from '../../src/components/PracticeDialog.tsx'
import { TablePage } from '../../src/pages/TablePage.tsx'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'

/** The bidding practice in the browser (`e10-t15`): the dialog, the bidding box for another seat, the end of the auction */

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  table: null as TableView | null,
}))

const lobby: LobbyView = { online: [], members: [], tables: [], myTableId: 'p1', myTableMode: 'practice', friends: [], blocked: [] }

vi.mock('../../src/lib/api.ts', async (original) => ({
  ...(await original<typeof import('../../src/lib/api.ts')>()),
  api: { challenges: () => Promise.resolve({ challenges: [] }) },
}))
vi.mock('../../src/state/ClubContext.tsx', () => ({
  useClub: () => ({ lobby, send: mocks.send, notifications: null, status: 'open', table: mocks.table, error: null }),
}))
vi.mock('../../src/state/AuthContext.tsx', () => ({
  useAuth: () => ({ user: { id: 'amy', username: 'amy', admin: false, permissions: [] } }),
}))

beforeEach(() => {
  mocks.send.mockReset()
})

const wrap = (ui: ReactNode) => render(<PreferencesProvider>{ui}</PreferencesProvider>)

const robot = (seat: string) => ({ id: `robot:gib:${seat}`, username: 'Robot', robot: true, robotKind: 'gib' as const, online: true })

/** Amy's bidding practice: she sits South and also bids for North; board 1, North to call */
function practiceTable(board: Partial<BoardView>): TableView {
  return {
    id: 'p1',
    number: 1,
    hostId: 'amy',
    settings: { access: 'hidden', allowKibitz: true, boardMinutes: 0 },
    seats: { N: { ...robot('N'), controlledBy: 'amy' }, E: robot('E'), S: { id: 'amy', username: 'amy', online: true }, W: robot('W') },
    spectators: [],
    mySeat: 'S',
    acts: ['N', 'S'],
    board: {
      boardNo: 1,
      dealer: 'N',
      vul: 'None',
      phase: 'auction',
      hands: { N: ['SA', 'SK', 'HA'], S: ['CA', 'CK', 'DA'] },
      handCounts: { N: 13, E: 13, S: 13, W: 13 },
      auction: [],
      contract: null,
      dummy: null,
      turn: 'N',
      tricks: [],
      tricksWon: { NS: 0, EW: 0 },
      legalCards: [],
      legalCalls: [...legalCalls([], 'N')],
      canUndo: false,
      canClaim: false,
      ...board,
    } as BoardView,
    boardsPlayed: 0,
    dealAt: null,
    chat: [],
    recent: [],
    practice: { deal: 'random', robotKind: 'gib', justDeclare: false, biddingOnly: true, seats: ['N', 'S'], dealt: 1 },
    boardEndsAt: null,
    waiting: null,
  }
}

const showTable = () =>
  render(
    <PreferencesProvider>
      <MemoryRouter initialEntries={['/table/p1']}>
        <Routes>
          <Route path="/table/:tableId" element={<TablePage />} />
        </Routes>
      </MemoryRouter>
    </PreferencesProvider>,
  )

describe('PracticeDialog: the bidding practice (e10-t15)', () => {
  it('sends bidding only with the seats the member bids for; other seats only with bidding only, and not with Just Declare', async () => {
    const onSubmit = vi.fn()
    wrap(<PracticeDialog onSubmit={onSubmit} onClose={() => {}} />)
    const seats = screen.getByRole('group', { name: '你替哪幾家叫牌' })
    // South is always the member's; the others wait for bidding only
    expect(within(seats).getByRole('checkbox', { name: '南' })).toBeChecked()
    expect(within(seats).getByRole('checkbox', { name: '南' })).toBeDisabled()
    expect(within(seats).getByRole('checkbox', { name: '北' })).toBeDisabled()
    await userEvent.click(screen.getByRole('checkbox', { name: /只叫牌/ }))
    expect(screen.getByRole('checkbox', { name: /Just Declare/ })).toBeDisabled()
    await userEvent.click(within(seats).getByRole('checkbox', { name: '北' }))
    await userEvent.click(within(seats).getByRole('checkbox', { name: '西' }))
    await userEvent.click(screen.getByRole('button', { name: '開始練習' }))
    expect(onSubmit).toHaveBeenCalledWith(
      { deal: 'random', robotKind: 'gib', justDeclare: false, biddingOnly: true, seats: ['N', 'S', 'W'] },
      'hidden',
    )
  })

  it('goes back to South alone when bidding only is turned off', async () => {
    const onSubmit = vi.fn()
    wrap(<PracticeDialog onSubmit={onSubmit} onClose={() => {}} />)
    await userEvent.click(screen.getByRole('checkbox', { name: /只叫牌/ }))
    await userEvent.click(screen.getByRole('checkbox', { name: '東' }))
    await userEvent.click(screen.getByRole('checkbox', { name: /只叫牌/ }))
    expect(screen.getByRole('checkbox', { name: '東' })).not.toBeChecked()
    await userEvent.click(screen.getByRole('button', { name: '開始練習' }))
    expect(onSubmit).toHaveBeenCalledWith({ deal: 'random', robotKind: 'gib', justDeclare: false, biddingOnly: false, seats: ['S'] }, 'hidden')
  })
})

describe('PracticeBanner', () => {
  it('says the table only bids', () => {
    wrap(<PracticeBanner practice={{ deal: 'random', robotKind: 'gib', justDeclare: false, biddingOnly: true, dealt: 2 }} />)
    expect(screen.getByText('隨機 · TKB（2/1） · 只叫牌')).toBeInTheDocument()
  })
})

describe('the bidding practice table (e10-t15)', () => {
  it('shows the bidding box on North’s turn, says it bids for North, and sends the call for North', async () => {
    mocks.table = practiceTable({})
    showTable()
    expect(screen.getByText('現在替 北 叫')).toBeInTheDocument()
    // Whose calls North's are, on its plate
    expect(screen.getByText('amy 叫')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /^Pass|^不叫/ }))
    const sent = mocks.send.mock.calls.map(([message]) => message).find((m) => m.type === 'call')
    expect(sent).toMatchObject({ type: 'call', call: 'P', seat: 'N' })
  })

  it('shows the contract when the auction is over, and offers the next board or the same one again', async () => {
    mocks.table = practiceTable({
      phase: 'finished',
      turn: null,
      legalCalls: [],
      contract: { level: 3, strain: 'N', doubled: '', declarer: 'S' },
      auction: [
        { seat: 'N', call: '1C' },
        { seat: 'E', call: 'P', robot: true },
        { seat: 'S', call: '3N' },
        { seat: 'W', call: 'P', robot: true },
        { seat: 'N', call: 'P' },
        { seat: 'E', call: 'P', robot: true },
      ],
    })
    showTable()
    expect(screen.getByRole('status', { name: '叫牌結束' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '重叫這一副' }))
    expect(mocks.send).toHaveBeenCalledWith({ type: 'rebid' })
    await userEvent.click(screen.getByRole('button', { name: '下一副' }))
    expect(mocks.send).toHaveBeenCalledWith({ type: 'redeal' })
  })
})
